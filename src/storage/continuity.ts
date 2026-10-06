/** IndexedDB transactions couple source acknowledgement to memory publication. Only the host writes. */
import {
  MEMORY_DB_NAME, memoryContentSchema, newMemoryState, subjectKey,
  type MemoryContent, type MemoryEvent, type MemoryPatch, type MemoryRecord,
  type MemorySnapshot, type MemorySource, type MemoryState,
} from '../shared/continuity'
import { normalizeScope, normalizeGuidePath } from '../agent/site-memory'
import { redactSecrets } from '../shared/redact'
import { eventSource } from '../agent/memory-evidence'

const request = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})
export class MemoryConflict extends Error { constructor() { super('Memory changed while this update was being prepared. Please retry.') } }

export class MemoryDatabase {
  private db?: Promise<IDBDatabase>
  constructor(private readonly name = MEMORY_DB_NAME) {}

  private open(): Promise<IDBDatabase> {
    return this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 3)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('records')) req.result.createObjectStore('records', { keyPath: 'id' })
        const events = req.result.objectStoreNames.contains('events') ? req.transaction!.objectStore('events') : req.result.createObjectStore('events', { keyPath: 'id' })
        for (const [name, key] of [['pending', 'pending'], ['chat', 'chatId'], ['parent', 'parentId'], ['at', 'at']] as const) if (!events.indexNames.contains(name)) events.createIndex(name, key)
        if (!events.indexNames.contains('queue')) events.createIndex('queue', ['pending', 'at', 'id'])
        if (!events.indexNames.contains('recent-human')) events.createIndex('recent-human', ['origin', 'pending', 'at'])
        if (!req.result.objectStoreNames.contains('meta')) req.result.createObjectStore('meta', { keyPath: 'key' })
      }
      req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); this.db = undefined }; resolve(req.result) }
      req.onerror = () => { this.db = undefined; reject(req.error) }
      req.onblocked = () => { this.db = undefined; reject(new Error('Memory storage is busy in another extension page.')) }
    })
  }

  private async transaction<T>(mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.open()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(['records', 'events', 'meta'], mode)
      let result: T
      let error: unknown
      tx.oncomplete = () => resolve(result)
      tx.onabort = tx.onerror = () => reject(error ?? tx.error ?? new Error('Memory transaction failed'))
      fn(tx).then((value) => { result = value }, (err) => { error = err; try { tx.abort() } catch { reject(err) } })
    })
  }
  private async state(tx: IDBTransaction): Promise<MemoryState> {
    const saved = await request(tx.objectStore('meta').get('state')) as MemoryState | undefined
    const defaults = newMemoryState()
    return { ...defaults, ...saved, config: { ...defaults.config, ...saved?.config } }
  }
  private async suppress(tx: IDBTransaction, state: MemoryState, record: MemoryRecord, now: number): Promise<void> {
    suppress(state, record, now)
    const ids = new Set(record.sources.map((s) => s.id))
    for (const id of ids) {
      const event = await request(tx.objectStore('events').get(id)) as MemoryEvent | undefined
      // Keep an idempotency receipt, not a hidden copy of the forgotten source text.
      if (event) tx.objectStore('events').put({ ...event, text: '', excerpt: '', pending: 0 })
    }
    const others = await request(tx.objectStore('records').getAll()) as MemoryRecord[]
    for (const other of others) if (other.id !== record.id && other.sources.some((s) => ids.has(s.id))) {
      tx.objectStore('records').put({ ...other, sources: other.sources.map((s) => ids.has(s.id) ? { ...s, excerpt: '' } : s) })
    }
  }
  async snapshot(): Promise<MemorySnapshot> {
    return this.transaction('readonly', async (tx) => {
      const records = await request(tx.objectStore('records').getAll()) as MemoryRecord[]
      const state = await this.state(tx)
      const pending = await request(tx.objectStore('events').index('pending').count(1))
      return { records, state, pending }
    })
  }
  async updateState(update: (state: MemoryState) => void): Promise<void> {
    await this.transaction('readwrite', async (tx) => { const s = await this.state(tx); update(s); tx.objectStore('meta').put(s) })
  }
  async known(chatId: string): Promise<Set<string>> {
    return this.transaction('readonly', async (tx) => {
      const ids = await request(tx.objectStore('events').index('chat').getAllKeys(chatId)) as string[]
      return new Set(ids.flatMap((id) => [id.replace(/:[a-f0-9]{64}:\d+$/, ''), id.slice(0, id.lastIndexOf(':'))]))
    })
  }
  async capture(events: MemoryEvent[]): Promise<number> {
    if (!events.length) return 0
    return this.transaction('readwrite', async (tx) => {
      const state = await this.state(tx)
      if (!state.config.learning) return 0
      const store = tx.objectStore('events')
      let added = 0
      let invalidated = false
      for (const event of events) {
        if (event.at <= state.ignoredBefore || state.excludedPeriods.some((p) => event.at >= p.from && event.at < p.until) ||
          (event.chatId && state.deletedChats.includes(event.chatId)) || state.supersededEvents.includes(event.id) ||
          (event.origin !== 'tool' && state.retractedParents.includes(event.parentId))) continue
        if (await request(store.getKey(event.id)) !== undefined) continue
        if (event.origin === 'human') {
          const identity = event.id.slice(0, event.id.lastIndexOf(':'))
          const previous = await request(store.index('parent').getAll(event.parentId)) as MemoryEvent[]
          const old = new Set(previous.filter((e) => e.id.slice(0, e.id.lastIndexOf(':')) !== identity).map((e) => e.id))
          if (old.size) {
            await this.invalidateSources(tx, old)
            for (const id of old) { store.delete(id); state.supersededEvents.push(id) }
            invalidated = true
          }
        }
        store.put(event); added++
      }
      if (invalidated) { state.version++; state.privacyVersion++; tx.objectStore('meta').put(state) }
      return added
    })
  }
  async pending(maxChars = 36_000, now = Date.now()): Promise<MemoryEvent[]> {
    return this.transaction('readonly', async (tx) => {
      const selected: MemoryEvent[] = []
      let size = 0
      const visit = (range: IDBKeyRange, direction: IDBCursorDirection = 'next'): Promise<void> => new Promise((resolve, reject) => {
        const req = tx.objectStore('events').index('queue').openCursor(range, direction)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) { resolve(); return }
          const event = cursor.value as MemoryEvent
          if ((size + event.text.length > maxChars && selected.length) || selected.length >= 40) { resolve(); return }
          selected.push(event); size += event.text.length; cursor.continue()
        }
      })
      // A history backfill must never starve the current conversation.
      await visit(IDBKeyRange.bound([1, now - 30 * 60_000, ''], [1, Number.MAX_SAFE_INTEGER, '\uffff']))
      if (!selected.length) await visit(IDBKeyRange.bound([1, 0, ''], [1, Number.MAX_SAFE_INTEGER, '\uffff']), 'prev')
      return selected.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    })
  }
  async recent(now = Date.now()): Promise<MemoryEvent[]> {
    return this.transaction('readonly', (tx) => new Promise((resolve, reject) => {
      const rows: MemoryEvent[] = []
      const range = IDBKeyRange.bound(['human', 1, now - 30 * 60_000], ['human', 1, Number.MAX_SAFE_INTEGER])
      const req = tx.objectStore('events').index('recent-human').openCursor(range, 'prev')
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor || rows.length >= 6) { resolve(rows.reverse()); return }
        const event = cursor.value as MemoryEvent
        if (event.text.length < 1200) rows.push(event)
        cursor.continue()
      }
    }))
  }

  /** Sources that disappeared on rewind are not facts; completed tools still happened. */
  async reconcileChat(chatId: string, present: ReadonlySet<string> | undefined): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      const state = await this.state(tx)
      const store = tx.objectStore('events')
      const events = await request(store.index('chat').getAll(chatId)) as MemoryEvent[]
      const removed = new Set(events.filter((e) => !present || (e.origin !== 'tool' && !e.detached && !present.has(e.parentId))).map((e) => e.id))
      if (present) state.retractedParents = [...new Set([...state.retractedParents, ...events.filter((e) => removed.has(e.id)).map((e) => e.parentId)])]
      if (!present && !state.deletedChats.includes(chatId)) state.deletedChats.push(chatId)
      if (removed.size || !present) {
        for (const id of removed) store.delete(id)
        if (!present) {
          const records = await request(tx.objectStore('records').getAll()) as MemoryRecord[]
          for (const memory of records) for (const source of memory.sources) if (source.chatId === chatId) removed.add(source.id)
        }
        await this.invalidateSources(tx, removed)
        state.version++; state.privacyVersion++
        tx.objectStore('meta').put(state)
      }
    })
  }

  private async invalidateSources(tx: IDBTransaction, removed: Set<string>): Promise<void> {
    const records = await request(tx.objectStore('records').getAll()) as MemoryRecord[]
    for (const memory of records) {
      if (memory.edited || !memory.sources.some((s) => removed.has(s.id))) continue
      // A synthesized body may depend on several sources. Re-derive it from surviving evidence.
      tx.objectStore('records').delete(memory.id)
      for (const source of memory.sources.filter((s) => !removed.has(s.id))) {
        const event = await request(tx.objectStore('events').get(source.id)) as MemoryEvent | undefined
        if (event?.text) tx.objectStore('events').put({ ...event, pending: 1 })
      }
    }
  }

  async commit(patch: MemoryPatch, events: MemoryEvent[], expectedVersion: number, now: number, dream = false, reviewedLegacy: string[] = []): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      const state = await this.state(tx)
      if (state.version !== expectedVersion || !state.config.learning) throw new MemoryConflict()
      const store = tx.objectStore('records')
      const records = await request(store.getAll()) as MemoryRecord[]
      const evidence = new Map<string, MemorySource>(events.map((e) => [e.id, eventSource(e)]))
      // Existing supporting sources are available for consolidation, not new independent evidence.
      for (const record of records) for (const source of record.sources) evidence.set(source.id, source)
      for (const candidate of patch.upserts) {
        const { id, evidenceIds, quotes, replaces, ...raw } = candidate
        const sources = evidenceIds.map((key) => evidence.get(key))
        if (sources.some((s) => !s)) throw new Error('Memory update refers to unavailable evidence.')
        const support = (sources as MemorySource[]).map((source) => {
          const quote = quotes?.[source.id]
          const original = events.find((e) => e.id === source.id)?.text ?? source.excerpt
          if (quote && !containsQuote(original, quote)) throw new Error('Memory evidence quote is not present in its source.')
          return quote ? { ...source, excerpt: quote } : source
        })
        const content = normalizeContent(raw, Math.max(...support.map((s) => s.at)))
        if (state.suppressions.some((s) => s.subject === subjectKey(content.subject) || s.sourceIds.some((key) => evidenceIds.includes(key)))) continue
        if (support.some((s) => s.chatId && state.deletedChats.includes(s.chatId))) continue
        const existing = id ? records.find((r) => r.id === id) : records.find((r) => subjectKey(r.subject) === subjectKey(content.subject))
        if (id && !existing) throw new Error('Memory update refers to an unknown memory.')
        if (existing?.edited) continue
        if (content.global && !support.some((s) => s.origin === 'human' || s.origin === 'legacy')) content.global = false
        if (content.kind === 'preference' && !support.some((s) => s.origin === 'human' || s.origin === 'legacy')) continue
        // An older import cannot overwrite newer established context.
        if (existing && Math.max(...support.map((s) => s.at)) < Math.max(...existing.sources.map((s) => s.at))) continue
        const updated = makeRecord(content, support, now, existing)
        store.put(updated)
        const pos = records.findIndex((r) => r.id === updated.id)
        if (pos >= 0) records[pos] = updated; else records.push(updated)
        for (const replaced of replaces) {
          const old = records.find((r) => r.id === replaced)
          if (!old || old.id === updated.id || old.edited) continue
          store.put({ ...old, state: 'historical', revision: old.revision + 1, updatedAt: now })
        }
      }
      for (const entry of patch.forget) {
        const source = events.find((e) => e.id === entry.evidenceId)
        const record = records.find((r) => r.id === entry.id)
        if (!record || source?.origin !== 'human' || !/\b(forget|stop remembering|don['’]t remember|do not remember|remove.{0,50}memor)/i.test(source.text)) continue
        await this.suppress(tx, state, record, now); store.delete(record.id)
      }
      for (const event of events) {
        const current = await request(tx.objectStore('events').get(event.id)) as MemoryEvent | undefined
        if (current) tx.objectStore('events').put({ ...current, pending: 0 })
      }
      state.version++; state.lastRunAt = now; state.running = undefined; state.error = undefined; state.nextRunAt = undefined; state.batches++
      if (dream) state.lastDreamAt = now
      state.reviewedLegacy = [...new Set([...state.reviewedLegacy, ...reviewedLegacy])]
      tx.objectStore('meta').put(state)
    })
  }

  async seed(records: MemoryRecord[]): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      const state = await this.state(tx)
      if (state.legacyImported) return
      for (const record of records) tx.objectStore('records').put(record)
      state.legacyImported = true; state.version++
      tx.objectStore('meta').put(state)
    })
  }
  /** Reconcile the two editable legacy files without turning them into a second writer of learned accounts. */
  async syncLegacy(path: string, incoming: MemoryRecord[], now = Date.now()): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      const state = await this.state(tx)
      const store = tx.objectStore('records')
      const records = await request(store.getAll()) as MemoryRecord[]
      let changed = false
      for (const record of incoming) {
        if (state.ignoredBefore || state.suppressions.some((s) => s.subject === subjectKey(record.subject) || record.sources.some((source) => s.sourceIds.includes(source.id)))) continue
        const previous = records.find((r) => r.id === record.id)
        if (previous?.edited) continue
        if (previous && previous.sources.some((s) => s.path === path && (s.fingerprint ? s.fingerprint === record.sources[0]?.fingerprint : s.excerpt === record.sources[0]?.excerpt))) continue
        store.put(previous ? makeRecord(memoryContentSchema.parse(Object.fromEntries(Object.keys(memoryContentSchema.shape).map((k) => [k, record[k as keyof MemoryRecord]]))), record.sources, now, previous) : record)
        changed = true
      }
      for (const record of records.filter((r) => r.sources.length === 1 && r.sources[0]?.path === path && !r.edited)) {
        if (incoming.some((r) => r.id === record.id)) continue
        await this.suppress(tx, state, record, now); store.delete(record.id); changed = true
      }
      if (changed) { state.version++; tx.objectStore('meta').put(state) }
    })
  }
  async remember(content: MemoryContent, source: MemorySource, now = Date.now()): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      const records = await request(tx.objectStore('records').getAll()) as MemoryRecord[]
      const old = records.find((r) => subjectKey(r.subject) === subjectKey(content.subject) || subjectKey(r.title) === subjectKey(content.title))
      const state = await this.state(tx)
      const key = subjectKey(content.subject)
      state.suppressions = state.suppressions.filter((s) => s.subject !== key)
      tx.objectStore('records').put(makeRecord(normalizeContent(content, now), [source], now, old))
      state.version++; tx.objectStore('meta').put(state)
    })
  }
  async edit(id: string, revision: number, content: MemoryContent, now = Date.now()): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      const store = tx.objectStore('records')
      const old = await request(store.get(id)) as MemoryRecord | undefined
      if (!old || old.revision !== revision) throw new MemoryConflict()
      const source: MemorySource = { id: `edit:${crypto.randomUUID()}`, origin: 'human', at: now, label: 'Edited in Settings', excerpt: content.body.slice(0, 700) }
      store.put({ ...makeRecord(normalizeContent(content, now), [source], now, old), edited: true })
      const state = await this.state(tx); state.version++; tx.objectStore('meta').put(state)
    })
  }
  async forget(id: string, now = Date.now()): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      const record = await request(tx.objectStore('records').get(id)) as MemoryRecord | undefined
      if (!record) return
      const state = await this.state(tx)
      const all = await request(tx.objectStore('records').getAll()) as MemoryRecord[]
      const forgotten = [record]
      for (let index = 0; index < forgotten.length; index++) {
        const parent = forgotten[index]!
        const key = subjectKey(parent.subject)
        for (const candidate of all) if (!forgotten.some((r) => r.id === candidate.id) &&
          (candidate.expiresWith === parent.id || (key && ((candidate.expiresWith && subjectKey(candidate.expiresWith) === key) || subjectKey(candidate.subject).startsWith(`${key} `))))) forgotten.push(candidate)
      }
      for (const item of forgotten) { await this.suppress(tx, state, item, now); tx.objectStore('records').delete(item.id) }
      state.version++; tx.objectStore('meta').put(state)
    })
  }
  async unlock(id: string, revision: number): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      const record = await request(tx.objectStore('records').get(id)) as MemoryRecord | undefined
      if (!record || record.revision !== revision) throw new MemoryConflict()
      tx.objectStore('records').put({ ...record, edited: false })
      const state = await this.state(tx); state.version++; tx.objectStore('meta').put(state)
    })
  }
  async clear(now = Date.now()): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      const old = await this.state(tx)
      tx.objectStore('records').clear(); tx.objectStore('events').clear()
      tx.objectStore('meta').put({ ...newMemoryState(), config: old.config, version: old.version + 1, privacyVersion: old.privacyVersion + 1, ignoredBefore: now, pausedAt: old.pausedAt, legacyImported: true, backfillComplete: true, usageDay: old.usageDay, usedTokens: old.usedTokens })
    })
  }
  async close(): Promise<void> { (await this.db)?.close(); this.db = undefined }
}

function suppress(state: MemoryState, record: MemoryRecord, at: number): void {
  state.privacyVersion++
  const subject = subjectKey(record.subject)
  const previous = state.suppressions.find((s) => s.subject === subject)
  const sourceIds = [...new Set([...(previous?.sourceIds ?? []), ...record.sources.map((s) => s.id)])]
  state.suppressions = [...state.suppressions.filter((s) => s.subject !== subject), { subject, sourceIds, at }]
}

function containsQuote(text: string, quote: string): boolean {
  if (text.includes(quote)) return true
  const contains = (value: unknown): boolean => typeof value === 'string' ? value.includes(quote)
    : !!value && typeof value === 'object' && Object.values(value).some(contains)
  try { return contains(JSON.parse(text)) } catch { return false }
}

export function normalizeContent(raw: MemoryContent, now: number): MemoryContent {
  const value = memoryContentSchema.parse(raw)
  value.body = redactSecrets(value.body)
  value.title = redactSecrets(value.title)
  value.useWhen = redactSecrets(value.useWhen)
  value.scopes = [...new Set(value.scopes.map(normalizeScope).filter(Boolean))]
  value.triggers = [...new Set(value.triggers.map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3))]
  value.entities = [...new Set(value.entities.map(subjectKey).filter(Boolean))]
  value.relatedTo = [...new Set(value.relatedTo.map(subjectKey).filter(Boolean))]
  if (value.global && !['context', 'preference'].includes(value.kind)) value.global = false
  if (value.guide && normalizeGuidePath(value.guide) !== value.guide) delete value.guide
  if (!value.global && !value.scopes.length && !value.triggers.length && !value.entities.length) value.triggers = [value.subject.toLowerCase()]
  if (!value.reviewAt && !value.expiresAt && !value.validUntil && !value.expiresWith && ['event', 'project'].includes(value.kind)) {
    value.reviewAt = new Date(now + (value.kind === 'event' ? 7 : 30) * 86_400_000).toISOString()
    value.boundaryBasis = 'review'
  }
  return value
}

export function makeRecord(content: MemoryContent, sources: MemorySource[], now: number, previous?: MemoryRecord): MemoryRecord {
  const oldContent = previous ? memoryContentSchema.parse(Object.fromEntries(Object.keys(memoryContentSchema.shape).map((key) => [key, previous[key as keyof MemoryRecord]]))) : undefined
  const supporting = [...new Map([...(previous?.sources ?? []), ...sources].map((s) => [s.id, s])).values()].sort((a, b) => b.at - a.at).slice(0, 12)
  const procedureVersion = content.kind === 'procedure' && (previous?.body === content.body || sources.some((s) => s.origin === 'tool' && !s.savedContext)) ? supporting.find((s) => s.origin === 'tool' && !s.savedContext)?.harnessVersion : undefined
  const same = oldContent && JSON.stringify(oldContent) === JSON.stringify(content) && previous?.procedureVersion === procedureVersion
  return { ...content, id: previous?.id ?? `mem-${crypto.randomUUID()}`, revision: previous ? previous.revision + (same ? 0 : 1) : 1,
    createdAt: previous?.createdAt ?? now, updatedAt: same ? previous!.updatedAt : now, edited: previous?.edited ?? false,
    sources: supporting, procedureVersion }
}
