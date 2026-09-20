/**
 * Sticky host (service worker). Watches /workspace/stickies/*.md, keeps the
 * parsed records in memory, and:
 *
 *  - pushes the OPEN stickies that match a page's URL to that page's overlay
 *    (content script, STICKY_PORT), re-publishing on file changes and tab
 *    navigations;
 *  - writes the user's overlay actions (checkbox ticks, text edits, collapse,
 *    close, drag) back into the file and logs them as `user` revisions;
 *  - implements api.stickies.* for the agent and attributes agent writes —
 *    including plain api.fs.writeText to a sticky path — to their chat.
 *
 * The VFS is the source of truth; the revision log (storage/stickies.ts) only
 * remembers who changed what so chats get compact diffs.
 */

import type { VirtualFileSystemService } from '../shared/types'
import { subscribeVfsChanges } from '../storage/vfs-changes'
import { scopeMatches } from '../agent/site-memory'
import { debugLog } from '../shared/debug-log'
import {
  DEFAULT_STICKY_META,
  formatSticky,
  isStickyPath,
  normalizeAnchor,
  normalizeStickyPath,
  parseStickyPosition,
  parsePagesValue,
  parseSticky,
  stickyIdFromPath,
  stickyTitle,
  STICKIES_DIR,
  STICKY_MAX_BODY_CHARS,
  STICKY_MAX_COUNT,
  STICKY_PORT,
  summarizeSticky,
  toggleTaskLine,
  type StickyBackgroundToPage,
  type StickyEditor,
  type StickyInput,
  type StickyMeta,
  type StickyPageToBackground,
  type StickyPatch,
  type StickyRecord,
  type StickyRuntimeMessage,
  type StickyService,
  type StickySummary,
  type StickyView,
} from '../shared/stickies'
import { forgetStickyRevisions, loadAllStickyRevisions, recordStickyRevision } from '../storage/stickies'

/** An agent write announced but never observed is forgotten after this long. */
const PENDING_WRITE_TTL_MS = 15_000

export interface StickyHost extends StickyService {
  handleRuntimeMessage(message: Partial<StickyRuntimeMessage>): Promise<unknown> | undefined
  /** Loaded records (tests). */
  records(): Promise<StickyRecord[]>
}

export function stickyMatchesUrl(pages: StickyMeta['pages'], url: string | undefined): boolean {
  if (!url || !/^(https?|file):/i.test(url)) return false
  if (pages === 'all') return true
  return pages.some((scope) => scopeMatches(scope, url) || looseMatch(scope, url))
}

/** Plain hostnames and substrings the user may have typed ("gmail", "docs.google.com"). */
function looseMatch(scope: string, url: string): boolean {
  const needle = scope.toLowerCase().replace(/^https?:\/\//, '').replace(/\/\*\*?$/, '').replace(/^\*\./, '')
  if (!needle || /[*?]/.test(needle)) return false
  let host = ''
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return false }
  return host === needle || host.endsWith(`.${needle}`) || url.toLowerCase().includes(needle)
}

export function createStickyHost(vfs: VirtualFileSystemService): StickyHost {
  const records = new Map<string, StickyRecord>()
  const ports = new Map<chrome.runtime.Port, { tabId?: number; url?: string }>()
  /** Writes this host is about to make (or an agent announced) so the change watcher attributes them. */
  const pending = new Map<string, { by: StickyEditor; chatId?: string; at: number }>()
  let serial: Promise<unknown> = Promise.resolve()

  const ready: Promise<void> = (async () => {
    try {
      const entries = (await vfs.list('workspace')).filter((entry) => isStickyPath(entry.path))
      const logs = await loadAllStickyRevisions(entries.map((entry) => stickyIdFromPath(entry.path)))
      for (const entry of entries) {
        const record = await load(entry.path, entry.updatedAt)
        if (record && !logs.has(record.id)) {
          const log = await recordStickyRevision(record.id, record.body, 'agent')
          records.set(record.id, { ...record, revision: log.revision })
        }
      }
    } catch (err) {
      debugLog.error('storage', 'sticky host load', err)
    }
  })()

  subscribeVfsChanges((change) => {
    if (!isStickyPath(change.path)) return
    queue(async () => {
      const id = stickyIdFromPath(change.path)
      if (change.action === 'delete') {
        if (records.delete(id)) { await forgetStickyRevisions(id); publish() }
        return
      }
      const previous = records.get(id)
      const record = await load(change.path, change.at)
      if (!record) return
      const marker = pending.get(change.path)
      pending.delete(change.path)
      const by: StickyEditor = marker && Date.now() - marker.at < PENDING_WRITE_TTL_MS ? marker.by : 'agent'
      // Identical bodies (frontmatter-only rewrites, our own echo) record nothing.
      const log = await recordStickyRevision(id, record.body, by, by === 'agent' ? marker?.chatId : undefined)
      record.revision = log.revision
      if (previous && previous.body === record.body && previous.revision !== log.revision) debugLog.log('storage', 'sticky revision resync', { id })
      records.set(id, record)
      publish()
    })
  })

  chrome.runtime?.onConnect?.addListener((port) => {
    if (port.name !== STICKY_PORT) return
    const sender = port.sender
    // A page's overlay only ever sees stickies for the URL Chrome reports for its tab.
    ports.set(port, { tabId: sender?.tab?.id, url: sender?.tab?.url ?? sender?.url })
    port.onMessage.addListener((message: StickyPageToBackground) => {
      void ready.then(() => handlePage(port, message)).catch((err) => {
        post(port, { type: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    })
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; ports.delete(port) })
  })

  chrome.tabs?.onUpdated?.addListener((tabId, info) => {
    if (!info.url) return
    let touched = false
    for (const [port, meta] of ports) {
      if (meta.tabId === tabId) { meta.url = info.url; touched = true; void ready.then(() => publishTo(port)) }
    }
    if (touched) debugLog.log('storage', 'sticky overlay url changed', { tabId })
  })

  /* ---------------- records ---------------- */

  function queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = serial.then(fn, fn)
    serial = run.catch((err) => debugLog.error('storage', 'sticky host', err))
    return run
  }

  async function load(path: string, updatedAt: number): Promise<StickyRecord | undefined> {
    let text: string
    try { text = (await vfs.readText(path, { maxChars: STICKY_MAX_BODY_CHARS })).text } catch { return undefined }
    const id = stickyIdFromPath(path)
    const { meta, body } = parseSticky(text)
    const record: StickyRecord = {
      ...meta, id, path, body, updatedAt,
      revision: records.get(id)?.revision ?? 1,
    }
    records.set(id, record)
    return record
  }

  async function resolve(name: string): Promise<StickyRecord> {
    await ready
    const path = normalizeStickyPath(name)
    const record = records.get(stickyIdFromPath(path))
    if (!record) throw new Error(`no sticky at ${path} — api.stickies.list() shows what exists`)
    return record
  }

  /** Rewrite the file. Body changes are logged under `by`; frontmatter-only changes are not revisions. */
  async function write(record: StickyRecord, next: { meta?: Partial<StickyMeta>; body?: string }, by: StickyEditor, chatId?: string): Promise<StickyRecord> {
    const meta: StickyMeta = {
      title: record.title, open: record.open, collapsed: record.collapsed, pages: record.pages,
      position: record.position, dx: record.dx, dy: record.dy, pin: record.pin, ...next.meta,
    }
    const body = next.body ?? record.body
    if (body.length > STICKY_MAX_BODY_CHARS) throw new Error(`sticky body exceeds ${STICKY_MAX_BODY_CHARS} characters — stickies are meant to be small`)
    pending.set(record.path, { by, chatId, at: Date.now() })
    const entry = await vfs.writeText(record.path, formatSticky(meta, body), { mediaType: 'text/markdown' })
    const updated: StickyRecord = { ...record, ...meta, body, updatedAt: entry.updatedAt }
    if (body !== record.body) {
      const log = await recordStickyRevision(record.id, body, by, by === 'agent' ? chatId : undefined)
      updated.revision = log.revision
      pending.delete(record.path)
    }
    records.set(record.id, updated)
    publish()
    return updated
  }

  /* ---------------- overlays ---------------- */

  function post(port: chrome.runtime.Port, message: StickyBackgroundToPage): void {
    try { port.postMessage(message) } catch { ports.delete(port) }
  }

  function viewsFor(url: string | undefined): StickyView[] {
    return [...records.values()]
      .filter((record) => record.open && stickyMatchesUrl(record.pages, url))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, path, collapsed, position, dx, dy, pin, body, revision }) => ({ id, path, collapsed, position, dx, dy, pin, body, revision, title: stickyTitle(records.get(id)!, body, id) }))
  }

  function publishTo(port: chrome.runtime.Port): void {
    const meta = ports.get(port)
    if (!meta) return
    post(port, { type: 'stickies', items: viewsFor(meta.url) })
  }

  function publish(): void {
    for (const port of ports.keys()) publishTo(port)
  }

  async function handlePage(port: chrome.runtime.Port, message: StickyPageToBackground): Promise<void> {
    if (message.type === 'hello') { publishTo(port); return }
    const record = records.get(message.id)
    if (!record) { publishTo(port); return }
    switch (message.type) {
      case 'toggle-task': {
        const body = toggleTaskLine(record.body, message.line, message.checked)
        if (body === null) throw new Error('that line is no longer a checklist item')
        await queue(() => write(record, { body }, 'user'))
        return
      }
      case 'edit': {
        if (message.revision !== record.revision) {
          // The note changed under the editor; keep the user's text but say so.
          post(port, { type: 'error', message: 'This sticky changed while you were editing; your version was saved on top.' })
        }
        await queue(() => write(record, { body: message.body }, 'user'))
        return
      }
      case 'set': {
        const meta: Partial<StickyMeta> = {}
        if (typeof message.collapsed === 'boolean') meta.collapsed = message.collapsed
        if (typeof message.open === 'boolean') meta.open = message.open
        if (message.position) meta.position = normalizeAnchor(message.position) ?? record.position
        if (typeof message.dx === 'number') meta.dx = Math.round(message.dx)
        if (typeof message.dy === 'number') meta.dy = Math.round(message.dy)
        await queue(() => write(record, { meta }, 'user'))
        return
      }
    }
  }

  /* ---------------- api.stickies.* ---------------- */

  function metaFromInput(input: StickyInput | StickyPatch, base: StickyMeta): Partial<StickyMeta> {
    const meta: Partial<StickyMeta> = {}
    if (typeof input.title === 'string') meta.title = input.title.trim().slice(0, 80)
    if (input.pages !== undefined) meta.pages = parsePagesValue(input.pages)
    if (input.position !== undefined) {
      const placement = parseStickyPosition(input.position)
      if (placement.position) meta.position = placement.position
      if (placement.pin !== undefined) meta.pin = placement.pin ?? undefined
      // A new corner or pin means the user's old drag offset no longer applies.
      const moved = (placement.position && placement.position !== base.position)
        || (placement.pin !== undefined && JSON.stringify(placement.pin ?? null) !== JSON.stringify(base.pin ?? null))
      if (moved) { meta.dx = 0; meta.dy = 0 }
    }
    if (typeof input.open === 'boolean') meta.open = input.open
    if ('collapsed' in input && typeof input.collapsed === 'boolean') meta.collapsed = input.collapsed
    return meta
  }

  const service: StickyHost = {
    async records() { await ready; return [...records.values()] },
    async list(): Promise<StickySummary[]> {
      await ready
      return [...records.values()].sort((a, b) => Number(b.open) - Number(a.open) || a.id.localeCompare(b.id)).map(summarizeSticky)
    },
    async get(name) {
      await ready
      const record = records.get(stickyIdFromPath(normalizeStickyPath(name)))
      return record ? summarizeSticky(record) : undefined
    },
    async create(input, chatId) {
      await ready
      const name = input.name ?? input.title
      if (!name) throw new Error('a sticky needs a name or title')
      const path = normalizeStickyPath(name)
      const id = stickyIdFromPath(path)
      const existing = records.get(id)
      if (existing) return service.update(id, { ...input, content: input.content }, chatId)
      if (records.size >= STICKY_MAX_COUNT) throw new Error(`too many stickies (${STICKY_MAX_COUNT}); delete or reuse one`)
      const body = typeof input.content === 'string' ? input.content : ''
      const seed: StickyRecord = {
        ...DEFAULT_STICKY_META, id, path, body: '', revision: 0, updatedAt: 0,
        title: typeof input.title === 'string' ? input.title : '',
      }
      const meta = metaFromInput(input, seed)
      const created = await queue(() => write({ ...seed, ...meta, title: seed.title }, { meta, body }, 'agent', chatId))
      return summarizeSticky(created)
    },
    async update(name, patch, chatId) {
      const record = await resolve(name)
      const meta = metaFromInput(patch, record)
      const body = typeof patch.content === 'string' ? patch.content : undefined
      const updated = await queue(() => write(record, { meta, body }, 'agent', chatId))
      return summarizeSticky(updated)
    },
    async remove(name) {
      await ready
      const path = normalizeStickyPath(name)
      const id = stickyIdFromPath(path)
      if (!records.has(id)) return false
      await vfs.delete(path)
      records.delete(id)
      await forgetStickyRevisions(id)
      publish()
      return true
    },
    noteAgentWrite(path, chatId) {
      if (isStickyPath(path)) pending.set(path, { by: 'agent', chatId, at: Date.now() })
    },
    handleRuntimeMessage(message) {
      if (message.target !== 'background') return undefined
      if (message.type === 'stickies.list') return service.list()
      if (message.type === 'stickies.set' && typeof message.path === 'string') {
        const open = message.open
        return (async () => {
          const record = await resolve(message.path!)
          return summarizeSticky(await queue(() => write(record, { meta: { open: open ?? !record.open } }, 'user')))
        })()
      }
      return undefined
    },
  }
  return service
}

export { STICKIES_DIR }
