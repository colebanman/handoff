import { extensionName, parseBundle, type ExtensionDraft, type ExtensionRevision, type ExtensionSummary, type ExtensionTestResult } from '../shared/extensions'
import { findSecrets } from '../shared/redact'
import { throwIfAborted } from '../shared/abort'

export const EXTENSIONS_STORE = 'extensions'
interface PackageRecord {
  key: string; id: string; active: number; enabled: boolean; nextRevision: number
  revisions: ExtensionRevision[]; config: Record<string, unknown>
}
interface DraftRecord extends ExtensionDraft { key: string }
const summary = (record: PackageRecord): ExtensionSummary => {
  const current = record.revisions.find((r) => r.revision === record.active)!
  return { id: record.id, revision: record.active, enabled: record.enabled,
    description: current.manifest.description, manifest: current.manifest, results: current.results,
    path: `/skills/${record.id}`, revisions: record.revisions.map((r) => r.revision) }
}

/** Build the small discovery index when upgrading an existing local registry. */
export function upgradeExtensions(tx: IDBTransaction): void {
  const store = tx.objectStore(EXTENSIONS_STORE)
  const cursor = store.openCursor(IDBKeyRange.bound('package:', 'package:\uffff'))
  cursor.onsuccess = () => {
    const item = cursor.result
    if (!item) return
    const record = item.value as PackageRecord
    if (record.revisions?.some((r) => r.revision === record.active)) store.put({ key: `summary:${record.id}`, value: summary(record) })
    item.continue()
  }
}

/** Transactions contain only IDB requests and synchronous mutations. */
function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode,
  run: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode)
    let value: T
    let failure: unknown
    const cancel = () => { failure = signal?.reason ?? new Error('Cancelled'); try { tx.abort() } catch { /* Completed. */ } }
    signal?.addEventListener('abort', cancel, { once: true })
    tx.oncomplete = () => { signal?.removeEventListener('abort', cancel); resolve(value) }
    tx.onabort = tx.onerror = () => { signal?.removeEventListener('abort', cancel); reject(failure ?? tx.error ?? new Error('Extension transaction failed')) }
    try { run(tx, (v) => { value = v }, (error) => { failure = error; tx.abort() }) } catch (e) { failure = e; tx.abort() }
  })
}
function read<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return transaction(db, [EXTENSIONS_STORE], 'readonly', (tx, done) => {
    const req = tx.objectStore(EXTENSIONS_STORE).get(key); req.onsuccess = () => done(req.result)
  })
}
function mutate<T>(db: IDBDatabase, key: string, update: (old: any) => { record?: unknown; result: T }, signal?: AbortSignal): Promise<T> {
  return transaction(db, [EXTENSIONS_STORE], 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore(EXTENSIONS_STORE), req = store.get(key)
    req.onsuccess = () => {
      try {
        const next = update(req.result)
        if (next.record) store.put(next.record); else store.delete(key)
        if (key.startsWith('package:')) {
          const metadataKey = `summary:${key.slice(8)}`
          if (next.record) store.put({ key: metadataKey, value: summary(next.record as PackageRecord) })
          else store.delete(metadataKey)
        }
        done(next.result)
      }
      catch (error) { fail(error) }
    }
  }, signal)
}

export async function extensionRequest(db: IDBDatabase, operation: string, raw: unknown = {}, signal?: AbortSignal): Promise<unknown> {
  const input = (raw ?? {}) as Record<string, any>
  throwIfAborted(signal)
  if (operation === 'list') {
    const records = await transaction<any[]>(db, [EXTENSIONS_STORE], 'readonly', (tx, done) => {
      const req = tx.objectStore(EXTENSIONS_STORE).getAll(IDBKeyRange.bound('summary:', 'summary:\uffff')); req.onsuccess = () => done(req.result)
    })
    return records.map((r) => r.value as ExtensionSummary).filter((r) => !input.query || `${r.id} ${r.description}`.toLowerCase().includes(String(input.query).toLowerCase()))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  if (operation === 'settings') {
    if (typeof input.learningEnabled === 'boolean') return mutate(db, 'settings', (old) => ({
      record: { ...old, key: 'settings', learningEnabled: input.learningEnabled }, result: { learningEnabled: input.learningEnabled },
    }), signal)
    return { learningEnabled: (await read<any>(db, 'settings'))?.learningEnabled !== false }
  }
  if (operation === 'stage') {
    if ((await read<any>(db, 'settings'))?.learningEnabled === false) throw new Error('Extension learning is disabled. Existing functions remain available.')
    let candidate: unknown = input.bundle
    if (!candidate && typeof input.path === 'string') {
      if (!/^\/skills\/[a-z][a-zA-Z0-9_-]*$/.test(input.path)) throw new Error('Stage a package directory under /skills')
      const files = await transaction<any[]>(db, ['files'], 'readonly', (tx, done) => {
        const req = tx.objectStore('files').getAll(); req.onsuccess = () => done(req.result.filter((f: any) => f.path.startsWith(`${input.path}/`)))
      })
      const text = async (name: string) => {
        const file = files.find((f) => f.path === `${input.path}/${name}`)
        if (!file) throw new Error(`Missing ${input.path}/${name}`)
        return file.blob.text()
      }
      candidate = { manifest: JSON.parse(await text('extension.json')), source: await text('index.js'), tests: JSON.parse(await text('tests.json')) }
    }
    const bundle = parseBundle(candidate)
    if (findSecrets(JSON.stringify(bundle)).length) throw new Error('Remove secret-like values from extension source, tests, and metadata; use the live session instead.')
    const id = bundle.manifest.id
    if (input.path && input.path !== `/skills/${id}`) throw new Error(`Package path must be /skills/${id}`)
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('expectedRevision is required (0 for a new package)')
    const record = await read<PackageRecord>(db, `package:${id}`)
    if ((record?.active ?? 0) !== input.expectedRevision) throw new Error(`RevisionConflict: ${id} is at revision ${record?.active ?? 0}`)
    const draft: DraftRecord = { ...bundle, key: `draft:${crypto.randomUUID()}`, id, draftId: '', baseRevision: input.expectedRevision, results: [] }
    draft.draftId = draft.key.slice(6)
    await transaction(db, [EXTENSIONS_STORE, 'files'], 'readwrite', (tx, done) => {
      tx.objectStore(EXTENSIONS_STORE).put(draft)
      // Inline authoring also creates inspectable/editable working files.
      if (input.bundle) {
        const at = Date.now(), root = `/skills/${id}`
        for (const [name, text, mediaType] of [
          ['extension.json', JSON.stringify(bundle.manifest, null, 2), 'application/json'],
          ['index.js', bundle.source, 'text/javascript'], ['tests.json', JSON.stringify(bundle.tests, null, 2), 'application/json'],
        ]) {
          const blob = new Blob([text!], { type: mediaType }), path = `${root}/${name}`
          tx.objectStore('files').put({ path, root: 'skills', name, blob, size: blob.size, mediaType, createdAt: at, updatedAt: at })
        }
      }
      done(undefined)
    }, signal)
    return { draftId: draft.draftId, id, baseRevision: draft.baseRevision, actions: Object.keys(bundle.manifest.actions) }
  }
  if (['draft', 'recordTest', 'publish'].includes(operation)) {
    const draft = await read<DraftRecord>(db, `draft:${String(input.draftId)}`)
    if (!draft) throw new Error('Draft not found; stage the current working files again')
    if (operation === 'draft') return draft
    if (operation === 'recordTest') {
      const results = input.results as ExtensionTestResult[]
      if (!Array.isArray(results) || results.length !== draft.tests.length || !results.every((r, i) =>
        r.name === draft.tests[i]!.name && r.action === draft.tests[i]!.action && r.mode === draft.tests[i]!.mode && typeof r.ok === 'boolean')) throw new Error('Invalid test results')
      return mutate(db, draft.key, (old: DraftRecord) => ({ record: { ...old, results }, result: { results, ok: results.every((r) => r.ok) } }), signal)
    }
    if ((await read<any>(db, 'settings'))?.learningEnabled === false) throw new Error('Extension learning is disabled')
    if (input.expectedRevision !== draft.baseRevision) throw new Error('expectedRevision must equal the draft baseRevision')
    if (!draft.results.length || draft.results.some((r) => !r.ok) || Object.keys(draft.manifest.actions).some((a) => !draft.results.some((r) => r.action === a && r.ok))) {
      throw new Error('Test this exact draft successfully, covering every public action, before publishing')
    }
    return mutate(db, `package:${draft.id}`, (old?: PackageRecord) => {
      if ((old?.active ?? 0) !== draft.baseRevision) throw new Error(`RevisionConflict: ${draft.id} is at revision ${old?.active ?? 0}`)
      const revision = old?.nextRevision ?? 1
      const saved: ExtensionRevision = { manifest: draft.manifest, source: draft.source, tests: draft.tests, results: draft.results, revision, at: Date.now() }
      const record: PackageRecord = { key: `package:${draft.id}`, id: draft.id, active: revision, enabled: old?.enabled ?? true,
        nextRevision: revision + 1, revisions: [...(old?.revisions ?? []), saved], config: old?.config ?? {} }
      return { record, result: summary(record) }
    }, signal)
  }
  const id = extensionName.parse(input.id), key = `package:${id}`
  if (operation === 'get' || operation === 'resolve') {
    const record = await read<PackageRecord>(db, key)
    if (!record) throw new Error(`Unknown extension ${id}; inspect api.extensions.list()`)
    if (operation === 'resolve' && !record.enabled) throw new Error(`Extension ${id} is disabled`)
    const revision = record.revisions.find((r) => r.revision === (input.revision ?? record.active))
    if (!revision) throw new Error(`Missing revision for ${id}; refresh its documentation`)
    return { ...summary(record), ...revision, config: record.config }
  }
  return mutate<unknown>(db, key, (record?: PackageRecord) => {
    if (!record) throw new Error(`Unknown extension ${id}`)
    if (operation === 'remove') return { result: { removed: id } }
    if (operation === 'configure') {
      const origin = new URL(String(input.origin)).origin
      const configKey = `${origin}|${String(input.accountId ?? '')}`
      if (!['http:', 'https:'].includes(new URL(String(input.origin)).protocol)) throw new Error('Configuration origin must be HTTP(S)')
      if (input.value === undefined || JSON.stringify(input.value).length > 8000 || findSecrets(JSON.stringify(input.value)).length) throw new Error('Configuration must be small and contain no credentials')
      record.config[configKey] = input.value
    } else if (operation === 'disable') record.enabled = input.disabled === false
    else if (operation === 'rollback') {
      if (record.active !== input.expectedRevision) throw new Error(`RevisionConflict: ${id} is at revision ${record.active}`)
      if (!record.revisions.some((r) => r.revision === input.revision)) throw new Error('Unknown rollback revision')
      record.active = input.revision
    } else throw new Error(`Unknown extension operation ${operation}`)
    return { record, result: summary(record) }
  }, signal)
}
