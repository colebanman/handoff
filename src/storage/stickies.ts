/**
 * Sticky revision logs in chrome.storage.local, one key per sticky. The file
 * in the VFS is the current state; the log remembers WHO changed the body
 * (user on the page vs. the agent, and from which chat) and keeps recent body
 * snapshots so any chat can be shown a compact diff from the revision it last
 * saw instead of the whole note again.
 */

import {
  STICKY_REVISION_HISTORY,
  STICKY_REVISION_KEY_PREFIX,
  type StickyEditor,
  type StickyRevisionLog,
} from '../shared/stickies'

let mutation: Promise<unknown> = Promise.resolve()

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutation.then(fn, fn)
  mutation = run.catch(() => undefined)
  return run
}

function storageArea(): chrome.storage.StorageArea | undefined {
  return typeof chrome !== 'undefined' ? chrome.storage?.local : undefined
}

function key(id: string): string {
  return `${STICKY_REVISION_KEY_PREFIX}${id}`
}

export async function loadStickyRevisions(id: string): Promise<StickyRevisionLog | undefined> {
  const area = storageArea()
  if (!area) return undefined
  const stored = (await area.get(key(id)))[key(id)] as StickyRevisionLog | undefined
  return stored && typeof stored.revision === 'number' && Array.isArray(stored.entries) ? stored : undefined
}

export async function loadAllStickyRevisions(ids: string[]): Promise<Map<string, StickyRevisionLog>> {
  const area = storageArea()
  const out = new Map<string, StickyRevisionLog>()
  if (!area || !ids.length) return out
  const stored = await area.get(ids.map(key))
  for (const id of ids) {
    const log = stored[key(id)] as StickyRevisionLog | undefined
    if (log && typeof log.revision === 'number' && Array.isArray(log.entries)) out.set(id, log)
  }
  return out
}

/**
 * Append a revision for a new body. A body identical to the latest snapshot
 * records nothing (frontmatter-only rewrites must not look like edits).
 */
export function recordStickyRevision(
  id: string, body: string, by: StickyEditor, chatId?: string,
): Promise<StickyRevisionLog> {
  return serialize(async () => {
    const current = (await loadStickyRevisions(id)) ?? { revision: 0, entries: [] }
    const latest = current.entries.at(-1)
    if (latest && latest.body === body) return current
    const revision = current.revision + 1
    const entries = [...current.entries, { revision, by, at: Date.now(), ...(chatId ? { chatId } : {}), body }]
      .slice(-STICKY_REVISION_HISTORY)
    const next: StickyRevisionLog = { revision, entries }
    await storageArea()?.set({ [key(id)]: next })
    return next
  })
}

export function forgetStickyRevisions(id: string): Promise<void> {
  return serialize(async () => { await storageArea()?.remove(key(id)) })
}
