/** One background owner: durable capture, cheap observation, idle consolidation, and Settings commands. */
import type { ChatRecord, VirtualFileSystemService, Settings, TaskInfo } from '../shared/types'
import type { ExecutionSnapshot } from '../shared/execution-protocol'
import {
  MEMORY_ALARM, MEMORY_CHANGED_KEY, memoryCommandSchema, memoryContentSchema, memoryHash, subjectKey,
  type MemoryEvent, type MemoryRecord, type MemorySnapshot, type MemorySource,
} from '../shared/continuity'
import { MemoryDatabase, MemoryConflict, makeRecord, normalizeContent } from '../storage/continuity'
import { listChats, getChat } from '../storage/chats'
import { loadSettings } from '../storage/settings'
import { subscribeVfsChanges } from '../storage/vfs-changes'
import { MEMORY_PATH, parseMemory } from '../agent/memory'
import { SITE_MEMORY_PATH, parseSiteMemory } from '../agent/site-memory'
import { extractMemoryEvents, memoryParent } from '../agent/memory-evidence'
import { installMemoryRuntime, warmMemoryIndex, type MemoryRuntime } from '../agent/continuity-context'
import { MEMORY_OBSERVER_PROMPT, memoryObserverInput, observeMemory } from '../agent/memory-observer'
import { warmMemoryTokenizer, memoryTokens } from '../agent/memory-budget'
import { redactSecrets } from '../shared/redact'
import { HARNESS_VERSION } from '../shared/harness-version'

export interface MemoryHostDeps {
  vfs: VirtualFileSystemService
  busy(): boolean
  database?: MemoryDatabase
  infer?: typeof observeMemory
  settings?: () => Promise<Settings>
  chats?: typeof listChats
  chat?: typeof getChat
  now?: () => number
}

export function createMemoryHost(deps: MemoryHostDeps) {
  const db = deps.database ?? new MemoryDatabase()
  const now = deps.now ?? Date.now
  const infer = deps.infer ?? observeMemory
  let cache: MemorySnapshot | undefined
  let recent: MemoryEvent[] = []
  let controller: AbortController | undefined
  let running: Promise<void> | undefined
  let mutation: Promise<unknown> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const captures = new Map<string, { record: ChatRecord; reconcile: boolean }>()
  const committedKeys = new Map<string, string>()

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = mutation.then(fn, fn); mutation = next.catch(() => undefined); return next
  }
  async function refresh(): Promise<void> {
    const next = await db.snapshot()
    warmMemoryIndex(next.records)
    cache = next
    recent = await db.recent(now())
    await chrome.storage.local.set({ [MEMORY_CHANGED_KEY]: { version: cache.state.version, at: now(), nonce: Math.random() } })
  }
  async function arm(delay = 30_000): Promise<void> {
    if (disposed || !cache?.state.config.learning) return
    await chrome.alarms.create(MEMORY_ALARM, { when: now() + delay })
  }
  async function legacy(path: string): Promise<MemoryRecord[]> {
    const entry = await deps.vfs.getEntry(path)
    if (!entry) return []
    const { text } = await deps.vfs.readText(path, { maxChars: 300_000 })
    const entries = path === MEMORY_PATH ? parseMemory(text) : parseSiteMemory(text)
    return Promise.all(entries.map(async (item) => {
      const key = `${path}:${subjectKey(item.title)}`
      const id = `legacy-${(await memoryHash(key)).slice(0, 32)}`
      const source: MemorySource = { id, path, at: Date.parse(item.date) || entry.updatedAt,
        origin: 'legacy', label: path, excerpt: item.body }
      const content = normalizeContent(memoryContentSchema.parse({
        subject: item.title.replace(/^\[(Stable|Current)\]\s*/i, ''), title: item.title, body: item.body || 'Saved context',
        kind: 'guide' in item && item.guide ? 'procedure' : 'context', useWhen: `When working on ${item.title.replace(/^\[.*?\]\s*/, '')}`,
        global: path === MEMORY_PATH && /^\[Stable\]/i.test(item.title),
        scopes: 'scopes' in item ? item.scopes : [], triggers: 'triggers' in item ? item.triggers ?? [] : [item.title.replace(/^\[.*?\]\s*/, '')],
        guide: 'guide' in item ? item.guide : undefined,
      }), now())
      return { ...makeRecord(content, [source], source.at), id }
    }))
  }

  const ready = (async () => {
    await warmMemoryTokenizer()
    cache = await db.snapshot()
    if (!cache.state.legacyImported) await db.seed([...(await legacy(MEMORY_PATH)), ...(await legacy(SITE_MEMORY_PATH))])
    await db.updateState((s) => { s.running = undefined })
    await refresh()
    await arm(5_000)
  })().catch(async (error) => {
    console.error('[handoff] memory startup', error)
    await db.updateState((s) => { s.error = safeError(error) }).catch(() => {})
    await refresh().catch(() => {})
  })

  async function capture(record: ChatRecord, reconcile = false): Promise<void> {
    await ready
    if (!cache?.state.config.learning && !reconcile) return
    const known = await db.known(record.id)
    if (reconcile && (record.transcript.length || !record.messages.length)) {
      const ids = new Set<string>()
      const collect = (items: ChatRecord['transcript']) => { for (const item of items) {
        ids.add(memoryParent(record.id, item))
        if (item.kind === 'tool' && item.childItems) collect(item.childItems)
      } }
      collect(record.transcript)
      await db.reconcileChat(record.id, ids)
    }
    const events = await extractMemoryEvents(record, known)
    const added = await db.capture(events)
    if (added || reconcile) { await refresh(); await arm() }
  }
  function queueCapture(record: ChatRecord, reconcile = false): void {
    captures.set(record.id, { record, reconcile: reconcile || captures.get(record.id)?.reconcile === true })
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      const pending = [...captures.values()]; captures.clear()
      void serialize(async () => { for (const item of pending) await capture(item.record, item.reconcile) }).catch(report)
    }, 25)
  }
  function committed(snapshot: ExecutionSnapshot): void {
    const terminal = !['running', 'cancelling'].includes(snapshot.status)
    const count = terminal ? snapshot.record.transcript.length : snapshot.committedTranscriptLength ?? 0
    const key = `${count}:${snapshot.record.messages.length}:${snapshot.status}`
    if (committedKeys.get(snapshot.runId) === key) return
    if (committedKeys.size > 256) committedKeys.delete(committedKeys.keys().next().value!)
    committedKeys.set(snapshot.runId, key)
    queueCapture({ ...snapshot.record, transcript: snapshot.record.transcript.slice(0, count) })
  }

  async function backfill(): Promise<void> {
    if (cache?.state.backfillComplete || !cache?.state.config.learning) return
    const after = cache.state.backfillAfter
    const chats = (await (deps.chats ?? listChats)()).filter((c) => !after || c.createdAt > after.at || (c.createdAt === after.at && c.id > after.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    for (const meta of chats) {
      if (disposed || deps.busy() || !cache?.state.config.learning) return
      const chat = await (deps.chat ?? getChat)(meta.id)
      if (chat) await serialize(() => capture(chat))
      await db.updateState((s) => { s.backfillAfter = { at: meta.createdAt, id: meta.id } })
    }
    await db.updateState((s) => { s.backfillComplete = true })
    await refresh()
  }

  async function work(): Promise<void> {
    await ready
    await mutation
    if (disposed || deps.busy() || !cache?.state.config.learning) { await arm(); return }
    await refresh()
    if (cache.state.nextRunAt && cache.state.nextRunAt > now()) { await arm(cache.state.nextRunAt - now()); return }
    await backfill()
    if (deps.busy() || !cache?.state.config.learning) { await arm(); return }
    const events = await db.pending(36_000, now())
    const dream = !events.length && cache.records.length > 1 && (cache.state.lastRunAt ?? 0) > (cache.state.lastDreamAt ?? 0) && now() - (cache.state.lastRunAt ?? 0) >= 10 * 60_000
    if (!events.length && !dream) { await arm(10 * 60_000); return }
    const state = cache.state
    const input = memoryObserverInput(events, cache.records, state, now(), dream)
    // Reservation includes bounded output; failed/aborted calls keep their reservation because they may have been billed.
    const reserve = memoryTokens(input + MEMORY_OBSERVER_PROMPT, state.config.model) + 8_000
    const day = new Date(now()).toISOString().slice(0, 10)
    let allowed = false
    await db.updateState((s) => {
      if (s.usageDay !== day) { s.usageDay = day; s.usedTokens = 0 }
      allowed = s.usedTokens + reserve <= s.config.dailyTokenBudget
      if (allowed) { s.usedTokens += reserve; s.running = dream ? 'consolidating' : 'observing'; s.error = undefined }
      else { s.error = 'Daily memory budget reached. Learning resumes after the budget resets.'; s.nextRunAt = Date.parse(`${day}T00:00:00Z`) + 86_400_000 }
    })
    await refresh()
    if (!allowed) { await arm(Math.max(30_000, (cache!.state.nextRunAt ?? now()) - now())); return }
    controller = new AbortController()
    try {
      const settings = await (deps.settings ?? loadSettings)()
      const result = await infer(settings, state, input, AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]))
      if (controller.signal.aborted) throw controller.signal.reason
      await serialize(() => db.commit(result.patch, events, state.version, now(), dream))
      await db.updateState((s) => { s.usedTokens = Math.max(0, s.usedTokens - reserve + Math.max(0, result.tokens || reserve)) })
    } catch (error) {
      const interrupted = controller.signal.aborted || error instanceof MemoryConflict
      await db.updateState((s) => {
        s.running = undefined
        if (!interrupted) s.error = safeError(error)
        s.nextRunAt = now() + (interrupted ? 30_000 : 5 * 60_000)
      })
    } finally {
      controller = undefined
      await refresh()
      await arm(cache?.pending ? 30_000 : 10 * 60_000)
    }
  }
  function run(): Promise<void> {
    if (running) return running
    running = work().catch(report).finally(() => { running = undefined })
    return running
  }
  async function report(error: unknown): Promise<void> {
    console.error('[handoff] memory', error)
    await db.updateState((s) => { s.error = safeError(error); s.running = undefined }).catch(() => {})
    await refresh().catch(() => {})
    await arm(5 * 60_000).catch(() => {})
  }

  const adapter: MemoryRuntime = {
    snapshot: () => cache,
    recent: () => recent,
    captureTool: async (chatId, value) => {
      await ready
      if (!cache?.state.config.learning) return
      const at = now()
      const record: ChatRecord = { id: chatId, title: value.toolName, createdAt: at, updatedAt: at, modelId: '', messages: [], transcript: [{
        kind: 'tool', ...value, inputText: '', status: value.failed ? 'error' : 'done', at, harnessVersion: HARNESS_VERSION,
      }] }
      await db.capture(await extractMemoryEvents(record))
      await arm()
    },
    captureSpill: async (chatId, toolName, path, text) => {
      await ready
      if (!cache?.state.config.learning) return
      const at = now()
      const record: ChatRecord = { id: chatId, title: `Full ${toolName} result`, createdAt: at, updatedAt: at, modelId: '', messages: [], transcript: [{
        kind: 'tool', id: `spill:${path}`, agentId: 'main', toolName, inputText: '', output: text, status: 'done', at, harnessVersion: HARNESS_VERSION,
      }] }
      const events = (await extractMemoryEvents(record)).map((e) => ({ ...e, path, outcome: 'unknown' as const }))
      await db.capture(events)
      await arm()
    },
    write: async (input, chatId) => {
      await ready
      return serialize(async () => {
        controller?.abort()
        if (input.clearAll) { cache = undefined; recent = []; await db.clear(now()) }
        for (const title of input.forget ?? []) {
          for (const record of cache?.records ?? []) if (subjectKey(record.title) === subjectKey(title) || subjectKey(record.subject) === subjectKey(title)) await db.forget(record.id, now())
        }
        for (const memory of input.memories ?? []) {
          const content = memoryContentSchema.parse({ ...memory, subject: memory.title, kind: memory.guide ? 'procedure' : 'context', useWhen: `When ${memory.title} is relevant`, global: false, triggers: memory.triggers ?? [memory.title] })
          await db.remember(content, { id: `explicit:${crypto.randomUUID()}`, chatId, origin: 'assistant', at: now(), label: 'Explicit memory update', excerpt: memory.body }, now())
        }
        await refresh()
        return input.clearAll ? 'All saved memory cleared. Original chats and files remain; earlier chats will not be relearned automatically.' : `Memory updated: ${input.memories?.length ?? 0} saved, ${input.forget?.length ?? 0} forgetting requests applied. Manage memories in Settings → Memory.`
      })
    },
  }
  installMemoryRuntime(adapter)

  const alarm = (value: chrome.alarms.Alarm) => { if (value.name === MEMORY_ALARM) void run() }
  chrome.alarms.onAlarm.addListener(alarm)
  const storage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith('chat:')) continue
      if (!change.newValue) {
        // Invalidate synchronously; no stale cache during the deletion transaction.
        controller?.abort(); cache = undefined
        void serialize(async () => { await db.reconcileChat(key.slice(5), undefined); await refresh() }).catch(report)
      } else if (!deps.busy()) queueCapture(change.newValue as ChatRecord, true)
    }
    if ('settings' in changes || 'openai_chatgpt_oauth_tokens' in changes) {
      void db.updateState((s) => { s.nextRunAt = undefined }).then(() => arm()).catch(report)
    }
  }
  chrome.storage.onChanged.addListener(storage)
  const unwatch = subscribeVfsChanges((change) => {
    if (![MEMORY_PATH, SITE_MEMORY_PATH].includes(change.path)) return
    void serialize(async () => { await ready; await db.syncLegacy(change.path, await legacy(change.path), now()); await refresh() }).catch(report)
  })

  return {
    ready, committed, run,
    taskFinished: (task: TaskInfo) => {
      if (task.status !== 'done' || !task.chatId || !task.result) return
      const record: ChatRecord = { id: task.chatId, title: task.description, createdAt: task.startedAt, updatedAt: task.endedAt ?? now(), modelId: '', messages: [], transcript: [{
        kind: 'text', id: `task-result:${task.id}`, agentId: task.agentId, text: task.result, streaming: false, at: task.endedAt ?? now(),
      }] }
      void serialize(async () => {
        await ready
        const events = await extractMemoryEvents(record, await db.known(record.id))
        await db.capture(events.map((event) => ({ ...event, detached: true })))
        await refresh(); await arm()
      }).catch(report)
    },
    activity: () => { if (deps.busy()) controller?.abort(new DOMException('Foreground work has priority', 'AbortError')) },
    handleRuntimeMessage(message: { target?: string; type?: string; [key: string]: unknown }): Promise<unknown> | undefined {
      if (message.target !== 'background' || message.type !== 'memory.command') return undefined
      return (async () => {
        await ready
        const cmd = memoryCommandSchema.parse(message.payload)
        if (cmd.command === 'run') { await db.updateState((s) => { s.nextRunAt = undefined }); await refresh(); void run(); return { scheduled: true } }
        if (cmd.command === 'list') return db.snapshot()
        if (cmd.command === 'export') return { version: 1, exportedAt: new Date(now()).toISOString(), ...(await db.snapshot()) }
        controller?.abort()
        return serialize(async () => {
          if (cmd.command === 'clear') { cache = undefined; recent = []; await db.clear(now()) }
          else if (cmd.command === 'forget') { cache = undefined; await db.forget(cmd.id, now()) }
          else if (cmd.command === 'delete-chat') { cache = undefined; await db.reconcileChat(cmd.chatId, undefined) }
          else if (cmd.command === 'edit') await db.edit(cmd.id, cmd.revision, cmd.content, now())
          else if (cmd.command === 'unlock') await db.unlock(cmd.id, cmd.revision)
          else if (cmd.command === 'configure') await db.updateState((s) => {
            if (s.config.recall && !cmd.config.recall) s.privacyVersion++
            if (s.config.learning && !cmd.config.learning) s.pausedAt = now()
            if (!s.config.learning && cmd.config.learning && s.pausedAt !== undefined) { s.excludedPeriods.push({ from: s.pausedAt, until: now() }); s.pausedAt = undefined }
            s.config = cmd.config; s.version++; s.nextRunAt = undefined
          })
          await refresh(); await arm()
          return cache
        })
      })()
    },
    async dispose() {
      disposed = true; controller?.abort(); if (timer !== undefined) clearTimeout(timer)
      chrome.alarms.onAlarm.removeListener(alarm); chrome.storage.onChanged.removeListener(storage); unwatch()
      installMemoryRuntime(undefined)
      await ready; await running; await mutation; await db.close()
    },
  }
}

function safeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 400)
}
