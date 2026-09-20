/**
 * What the model sees of stickies, delivered inside the harness context
 * message (see runtime-context.ts). Per chat, each OPEN sticky's whole body is
 * delivered once; afterwards only what changed is sent:
 *
 *   <sticky id="todo" revision="3" …>…body…</sticky>       first sight / big change
 *   <sticky-user-edit sticky="todo" from="3" revision="4"> tiny line diff of a user tick/edit
 *   <sticky-update sticky="todo" … by="agent">             an edit made from another chat
 *   <sticky id="todo" revision="4" state="closed" />       it left the screen
 *
 * Edits the agent made from this very chat are already in its tool results and
 * are folded in silently. Revisions are reconstructed from earlier context
 * messages when a chat is reopened (scanDeliveredStickies).
 */

import type { VfsEntry, VirtualFileSystemService } from '../shared/types'
import {
  diffStickyBodies,
  isStickyPath,
  parseSticky,
  renderStickyBlock,
  renderStickyClosed,
  renderStickyEdit,
  stickyIdFromPath,
  STICKY_MAX_BODY_CHARS,
  type StickyEditor,
  type StickyRecord,
  type StickyRevisionLog,
} from '../shared/stickies'
import { loadAllStickyRevisions } from '../storage/stickies'

export type DeliveredSticky = number | 'closed'

export interface StickySnapshot {
  record: StickyRecord
  log?: StickyRevisionLog
}

/** Read every sticky file (open or closed) with its revision log. */
export async function readStickies(vfs: VirtualFileSystemService, entries: VfsEntry[]): Promise<StickySnapshot[]> {
  const files = entries.filter((entry) => isStickyPath(entry.path)).sort((a, b) => a.path.localeCompare(b.path))
  if (!files.length) return []
  const logs = await loadAllStickyRevisions(files.map((entry) => stickyIdFromPath(entry.path))).catch(() => new Map<string, StickyRevisionLog>())
  const out: StickySnapshot[] = []
  for (const entry of files) {
    const id = stickyIdFromPath(entry.path)
    let text = ''
    try { text = (await vfs.readText(entry.path, { maxChars: STICKY_MAX_BODY_CHARS })).text } catch { continue }
    const { meta, body } = parseSticky(text)
    const log = logs.get(id)
    out.push({
      log,
      record: {
        ...meta, id, path: entry.path, body, updatedAt: entry.updatedAt,
        // A file written outside the host (imports, dev tools) has no log yet: treat it as revision 1.
        revision: log?.revision ?? 1,
      },
    })
  }
  return out
}

export interface StickyContextResult {
  /** XML fragments, in delivery order; empty when nothing changed. */
  fragments: string[]
  /** Revision (or 'closed') now known to the model for each sticky touched. */
  delivered: Map<string, DeliveredSticky>
}

export function stickyContext(
  snapshots: StickySnapshot[], known: Map<string, DeliveredSticky>, chatId?: string,
): StickyContextResult {
  const fragments: string[] = []
  const delivered = new Map<string, DeliveredSticky>()
  const present = new Set<string>()
  for (const { record, log } of snapshots) {
    present.add(record.id)
    const seen = known.get(record.id)
    if (!record.open) {
      if (seen !== undefined && seen !== 'closed') {
        fragments.push(renderStickyClosed(record.id, record.revision))
        delivered.set(record.id, 'closed')
      }
      continue
    }
    if (seen === undefined || seen === 'closed') {
      fragments.push(renderStickyBlock(record))
      delivered.set(record.id, record.revision)
      continue
    }
    if (seen >= record.revision) continue
    const since = (log?.entries ?? []).filter((entry) => entry.revision > seen && entry.revision <= record.revision)
    const base = log?.entries.find((entry) => entry.revision === seen)?.body
    const editors = new Set<StickyEditor>(since.map((entry) => entry.by))
    const ownEdit = since.length > 0 && editors.size === 1 && editors.has('agent') &&
      since.every((entry) => entry.chatId !== undefined && entry.chatId === chatId)
    if (ownEdit) { delivered.set(record.id, record.revision); continue }
    const by: StickyEditor | 'mixed' = editors.size === 1 ? [...editors][0]! : editors.size ? 'mixed' : 'agent'
    const diff = base !== undefined && since.length === record.revision - seen ? diffStickyBodies(base, record.body) : null
    fragments.push(diff && diff.length ? renderStickyEdit(record, seen, by, diff) : renderStickyBlock(record))
    delivered.set(record.id, record.revision)
  }
  // A deleted sticky reads as closed.
  for (const [id, seen] of known) {
    if (present.has(id) || seen === 'closed') continue
    fragments.push(renderStickyClosed(id, typeof seen === 'number' ? seen : 0))
    delivered.set(id, 'closed')
  }
  return { fragments, delivered }
}

export function renderStickiesSection(fragments: string[]): string {
  return `<stickies>\n${fragments.join('\n')}\n</stickies>`
}
