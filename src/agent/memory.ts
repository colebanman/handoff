/**
 * Long-term memory: compact reusable context about the user, carried across chats.
 *
 * Storage is deliberately boring — one ordinary VFS file, `/workspace/MEMORY.md`,
 * which the user can open in the file viewer, edit, or delete like any other file.
 * There is no second storage layer and no sync.
 *
 * This module owns the FORMAT. The model never writes markdown here: it hands
 * `{ title, body }` pairs to the `memory_write` tool and we re-render the whole
 * file from parsed entries, so the layout cannot drift no matter what the model
 * emits or how the user hand-edits the file.
 *
 * Canonical shape — every entry is exactly four lines, which is what makes the
 * line numbers in the prompt index trustworthy:
 *
 *     ## [Current] Example College — school and Canvas context
 *     User attends Example College. Verified Canvas: https://school.instructure.com.
 *     <!-- 2026-08-04 -->
 *     (blank)
 *
 * The full file is never injected into the MAIN AGENT prompt. `memoryIndexLines`
 * renders titles plus line ranges; the agent reads whichever bodies it needs with
 * `api.fs.readLines(MEMORY_PATH, { startLine, count })` (1-based, matching vfs).
 * Cheap personalization calls receive a bounded, secret-redacted JSON snapshot
 * through `serializeMemoryForPrompt` instead.
 */

import type { VirtualFileSystemService } from '../shared/types'
import { debugLog } from '../shared/debug-log'
import { redactSecrets } from '../shared/redact'

export const MEMORY_PATH = '/workspace/MEMORY.md'

/** A retrieval cue — tells the model when this is useful and what reading it provides. */
export const MEMORY_TITLE_MAX = 80
/** One line of supporting detail — the part the model reads on demand. */
export const MEMORY_BODY_MAX = 240
/** Past this, memory has stopped being "the durable few" and needs consolidating. */
export const MEMORY_MAX_ENTRIES = 60

const HEADER = `# Memory

<!-- Managed by Handoff via the memory_write tool. One \`## \` heading per
     memory: a retrieval cue, one line of useful context, the date it was updated.
     Edit or delete anything here — the agent re-reads this file every turn. -->
`

export interface MemoryEntry {
  /** One-line retrieval cue, optionally prefixed `[Stable]` or `[Current]`. */
  title: string
  /** One line of useful context about the title's coherent subject. */
  body: string
  /** Local date the entry was last written, `YYYY-MM-DD`. */
  date: string
}

/** A parsed entry, with the 1-based line span it occupies in the file. */
export interface MemoryIndexEntry extends MemoryEntry {
  /** Line of the `## ` heading. */
  startLine: number
  /** Line of the body (=== startLine + 1 in canonical files). */
  endLine: number
}

export interface MemoryWriteInput {
  title: string
  body: string
}

export interface MemoryWriteResult {
  entries: MemoryIndexEntry[]
  addedTitles: string[]
  updatedTitles: string[]
  forgottenTitles: string[]
  /** Titles in `forget` that matched nothing, and any clamped-length notices. */
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* Normalizing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Identity of a memory. Titles are matched loosely (case and punctuation
 * insensitive) so re-stating a title updates the existing entry. A leading
 * durability cue is deliberately ignored: reclassifying `[Current] Foo` as
 * `[Stable] Foo` must update in place, including on an upgraded profile whose
 * older title was simply `Foo`.
 */
export function memoryKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*\[\s*(?:stable|current)\s*\]\s*/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Collapse to a single safe line: no newlines, no heading markers, no comment delimiters. */
export function toSingleLine(value: string, max: number): { text: string; clamped: boolean } {
  const flattened = value
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[#>\-*\s]+/, '')
    .trim()
  if (flattened.length <= max) return { text: flattened, clamped: false }
  // Clamp on a word boundary rather than rejecting: the content is still
  // meaningful, and the caller surfaces the clamp so the model can rephrase.
  const cut = flattened.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return { text: `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`, clamped: true }
}

export function todayIso(now = new Date()): string {
  // Local date, not UTC: which day it is for the user is the useful fact.
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/* ------------------------------------------------------------------ */
/* Parse / format                                                      */
/* ------------------------------------------------------------------ */

/**
 * Read entries out of a MEMORY.md. Tolerant of hand edits — extra blank lines,
 * a missing date comment, a body split across lines — because the user owns this
 * file. Anything irregular is normalized on the next write.
 */
export function parseMemory(text: string): MemoryIndexEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: MemoryIndexEntry[] = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const heading = /^##\s+(.*\S)\s*$/.exec(raw)
    if (!heading) continue

    const title = toSingleLine(heading[1] ?? '', MEMORY_TITLE_MAX).text
    if (!title) continue

    const bodyParts: string[] = []
    let date = ''
    let endLine = i + 1
    for (let j = i + 1; j < lines.length; j++) {
      const line = (lines[j] ?? '').trim()
      if (/^##\s/.test(line) || /^#\s/.test(line)) break
      const dateMatch = /^<!--\s*(\d{4}-\d{2}-\d{2})\s*-->$/.exec(line)
      if (dateMatch) {
        date = dateMatch[1] ?? ''
        continue
      }
      if (line.startsWith('<!--')) continue
      if (!line) continue
      bodyParts.push(line)
      endLine = j + 1
    }

    entries.push({
      title,
      body: toSingleLine(bodyParts.join(' '), MEMORY_BODY_MAX).text,
      date,
      startLine: i + 1,
      endLine,
    })
  }

  return entries
}

/**
 * Render the canonical file. This is the only writer — `applyMemoryWrite` parses,
 * merges, and re-renders, so a file that was hand-edited into an odd shape comes
 * back normalized.
 */
export function formatMemory(entries: MemoryEntry[]): string {
  if (entries.length === 0) return `${HEADER}\n_No memories yet._\n`
  const blocks = entries.map((entry) => {
    const title = toSingleLine(entry.title, MEMORY_TITLE_MAX).text
    const body = toSingleLine(entry.body, MEMORY_BODY_MAX).text
    const date = /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : todayIso()
    return `## ${title}\n${body || '—'}\n<!-- ${date} -->\n`
  })
  return `${HEADER}\n${blocks.join('\n')}`
}

/** Re-derive line spans for freshly formatted entries, so callers never guess. */
export function withLineSpans(entries: MemoryEntry[]): MemoryIndexEntry[] {
  return parseMemory(formatMemory(entries))
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Upsert by normalized title, preserving position: updating a fact keeps its
 * place in the file (and its line numbers) rather than shuffling it to the end.
 */
export function upsertMemories(
  existing: MemoryEntry[],
  incoming: MemoryWriteInput[],
  now = new Date(),
): { entries: MemoryEntry[]; addedTitles: string[]; updatedTitles: string[]; warnings: string[] } {
  const entries = existing.map((entry) => ({ ...entry }))
  const index = new Map<string, number>()
  entries.forEach((entry, i) => index.set(memoryKey(entry.title), i))

  const addedTitles: string[] = []
  const updatedTitles: string[] = []
  const warnings: string[] = []
  const date = todayIso(now)

  for (const candidate of incoming) {
    const title = toSingleLine(candidate.title ?? '', MEMORY_TITLE_MAX)
    const body = toSingleLine(candidate.body ?? '', MEMORY_BODY_MAX)
    if (!title.text) {
      warnings.push('skipped a memory with an empty title')
      continue
    }
    if (title.clamped) warnings.push(`clamped title to ${MEMORY_TITLE_MAX} chars: "${title.text}"`)
    if (body.clamped) warnings.push(`clamped body of "${title.text}" to ${MEMORY_BODY_MAX} chars`)

    const key = memoryKey(title.text)
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, entries.length)
      entries.push({ title: title.text, body: body.text, date })
      addedTitles.push(title.text)
    } else {
      const previous = entries[at]!
      const unchanged = previous.title === title.text && previous.body === body.text
      entries[at] = { title: title.text, body: body.text, date: unchanged ? previous.date : date }
      if (!unchanged) updatedTitles.push(title.text)
    }
  }

  return { entries, addedTitles, updatedTitles, warnings }
}

/** Drop entries whose titles loosely match any of `titles`. */
export function removeMemories(
  existing: MemoryEntry[],
  titles: string[],
): { entries: MemoryEntry[]; forgottenTitles: string[]; missing: string[] } {
  const wanted = new Map(titles.map((title) => [memoryKey(title), title]))
  const forgottenTitles: string[] = []
  const entries = existing.filter((entry) => {
    const key = memoryKey(entry.title)
    if (!wanted.has(key)) return true
    forgottenTitles.push(entry.title)
    wanted.delete(key)
    return false
  })
  return { entries, forgottenTitles, missing: [...wanted.values()] }
}

/* ------------------------------------------------------------------ */
/* Prompt index                                                        */
/* ------------------------------------------------------------------ */

/**
 * The lines injected into the DYNAMIC system block: titles and where to find the
 * detail. Never the bodies — that is the whole point of the line spans.
 */
export function memoryIndexLines(entries: MemoryIndexEntry[]): string[] {
  return entries.map((entry) => {
    const span =
      entry.endLine > entry.startLine ? `lines ${entry.startLine}-${entry.endLine}` : `line ${entry.startLine}`
    return `- ${entry.title} (${span})`
  })
}

/**
 * Complete memory context for cheap personalization calls.
 *
 * JSON keeps user-editable bodies unambiguously data rather than prompt prose;
 * high-confidence credential shapes are redacted before anything leaves the
 * extension. Canonical files cannot exceed the storage ceiling, but the user
 * can hand-edit the file, so the same ceiling is applied defensively here. Every
 * memory in a normally managed file is included without a ranking system.
 */
export function serializeMemoryForPrompt(entries: MemoryEntry[]): string {
  const snapshot = entries.slice(0, MEMORY_MAX_ENTRIES).map((entry) => ({
    title: entry.title,
    body: entry.body,
    updated: entry.date || undefined,
  }))
  return redactSecrets(JSON.stringify(snapshot))
}

/* ------------------------------------------------------------------ */
/* VFS access                                                          */
/* ------------------------------------------------------------------ */

/** Parsed memory, or `[]` when the file does not exist yet (the common case). */
export async function readMemory(vfs: VirtualFileSystemService): Promise<MemoryIndexEntry[]> {
  try {
    const entry = await vfs.getEntry(MEMORY_PATH)
    if (!entry) return []
    // Generous maxChars: readText truncates by default, and a truncated read here
    // would silently drop memories on the next write.
    const result = await vfs.readText(MEMORY_PATH, { maxChars: 500_000 })
    return parseMemory(result.text)
  } catch (err) {
    debugLog.error('agent', 'readMemory', err)
    return []
  }
}

/**
 * Materialize the memory file without inventing a fact.
 *
 * Used by versioned storage migrations so an upgraded profile gets the same
 * visible, editable MEMORY.md as a fresh onboarding run. Existing files are
 * never rewritten: the user may have hand-edited theirs, and a migration must
 * not normalize or replace user-owned content merely because the app updated.
 *
 * Returns true only when this call created the file.
 */
export async function ensureMemoryFile(vfs: VirtualFileSystemService): Promise<boolean> {
  if (await vfs.getEntry(MEMORY_PATH)) return false
  await vfs.writeText(MEMORY_PATH, formatMemory([]), { mediaType: 'text/markdown' })
  return true
}

/**
 * The single write path: parse what is on disk, merge, re-render, save.
 *
 * Throws when the merge would push past `MEMORY_MAX_ENTRIES` — silently dropping
 * one of the user's facts would be worse than making the model consolidate.
 */
export async function applyMemoryWrite(
  vfs: VirtualFileSystemService,
  input: { memories?: MemoryWriteInput[]; forget?: string[] },
  now = new Date(),
): Promise<MemoryWriteResult> {
  const memories = input.memories ?? []
  const forget = input.forget ?? []
  if (memories.length === 0 && forget.length === 0) {
    throw new Error('nothing to write: pass `memories`, `forget`, or both')
  }

  const current = await readMemory(vfs)
  const removed = removeMemories(current, forget)
  const merged = upsertMemories(removed.entries, memories, now)

  if (merged.entries.length > MEMORY_MAX_ENTRIES) {
    throw new Error(
      `MEMORY.md is full (${MEMORY_MAX_ENTRIES} entries). Consolidate related memories, or drop stale ones with \`forget\`, then write again.`,
    )
  }

  const text = formatMemory(merged.entries)
  await vfs.writeText(MEMORY_PATH, text, { mediaType: 'text/markdown' })

  const warnings = [...merged.warnings]
  for (const missing of removed.missing) warnings.push(`no memory matched "${missing}"`)

  return {
    entries: parseMemory(text),
    addedTitles: merged.addedTitles,
    updatedTitles: merged.updatedTitles,
    forgottenTitles: removed.forgottenTitles,
    warnings,
  }
}

/** One-line confirmation for the tool result — the model's only feedback channel. */
export function describeMemoryWrite(result: MemoryWriteResult): string {
  const parts: string[] = []
  if (result.addedTitles.length > 0) parts.push(`remembered ${result.addedTitles.map(quote).join(', ')}`)
  if (result.updatedTitles.length > 0) parts.push(`updated ${result.updatedTitles.map(quote).join(', ')}`)
  if (result.forgottenTitles.length > 0) parts.push(`forgot ${result.forgottenTitles.map(quote).join(', ')}`)
  if (parts.length === 0) parts.push('no change')
  const count = result.entries.length
  const head = `${parts.join('; ')}. ${MEMORY_PATH} now holds ${count} ${count === 1 ? 'memory' : 'memories'}.`
  return result.warnings.length > 0 ? `${head}\nNote: ${result.warnings.join('; ')}.` : head
}

function quote(title: string): string {
  return `"${title}"`
}
