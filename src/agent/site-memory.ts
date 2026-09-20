/**
 * Site-scoped memory: context that is only useful on particular pages.
 *
 * Long-term memory (`memory.ts`) holds a few durable facts about the USER that
 * apply everywhere. Site memory holds facts about a PLACE — a Canvas course's
 * syllabus rules, how a web app's accessibility tree misbehaves, an API route
 * that is easier than the UI — and each entry names the URL patterns where it
 * applies. Summaries surface for selected pages; reusable guides can also be
 * routed by explicit app/site names in the task before navigation.
 *
 * Storage mirrors MEMORY.md: one user-editable VFS file, `/workspace/SITES.md`,
 * re-rendered whole on every write so the layout cannot drift. Every entry is
 * parsed for exact line spans, including optional guide/trigger metadata:
 *
 *     ## COURSE 101 — class rules for examples and citations
 *     <!-- scope: school.instructure.com/courses/123/** -->
 *     Only use regional firms as examples. Details: /workspace/sites/course101.md
 *     <!-- 2026-09-08 -->
 *     (blank)
 *
 * Scopes are globs over `host/path`, never regexes:
 *   - `*` matches within one host label or path segment; `**` matches the rest.
 *   - Scheme, query string, fragment, and trailing slash are ignored.
 *   - A pattern with no path matches every path on that host.
 * When several entries match a URL, the more specific ones (longer literal
 * text) sort first, so course rules land above "all of Canvas" behaviors.
 */

import { contextText } from '../shared/context-blocks'
import { redactSecrets } from '../shared/redact'
import type { VirtualFileSystemService } from '../shared/types'
import { debugLog } from '../shared/debug-log'
import { describeMemoryWrite, memoryKey, toSingleLine, todayIso, type MemoryWriteResult } from './memory'

export const SITE_MEMORY_PATH = '/workspace/SITES.md'

export const SITE_MEMORY_TITLE_MAX = 80
/** Roomier than global memory: a rule set needs a sentence or two, or a file pointer. */
export const SITE_MEMORY_BODY_MAX = 600
export const SITE_MEMORY_MAX_ENTRIES = 150
export const SITE_MEMORY_MAX_SCOPES = 8
/** Inline summary budget; overflow entries retain titles and retrieval spans. */
export const SITE_MEMORY_MAX_MATCHES = 12

const HEADER = `# Site memory

<!-- Managed by Handoff via the memory_write tool (entries with \`scopes\`).
     One \`## \` heading per memory: a retrieval cue, the URL globs it applies to,
     one line of useful context, the date it was updated. Entries are shown to the
     agent on matching pages; guides may also name task triggers. Optional guide
     metadata points to a reusable Markdown procedure. Edit or delete anything here. -->
`

export interface SiteMemoryEntry {
  title: string
  /** Normalized `host/path` globs; at least one. */
  scopes: string[]
  body: string
  /** Optional reusable procedure; body is its inline summary. */
  guide?: string
  /** Explicit site/app names that can surface a guide before navigation. */
  triggers?: string[]
  date: string
}

export interface SiteMemoryIndexEntry extends SiteMemoryEntry {
  startLine: number
  endLine: number
}

export interface SiteMemoryWriteInput {
  title: string
  scopes: string[]
  body: string
  guide?: string
  triggers?: string[]
}

export function normalizeGuidePath(raw: string): string {
  const path = raw.trim()
  if (!/^\/workspace\/sites\/.+\.md$/.test(path) || /[<>\r\n\\]/.test(path)) return ''
  return path.slice(1).split('/').some((part) => part === '..' || part === '.' || !part) ? '' : path
}

function normalizeTriggers(values: string[]): string[] {
  return [...new Set(values.map((v) => toSingleLine(v, 60).text.toLowerCase()).filter((v) => v.length >= 3))].slice(0, 8)
}

export interface SiteMemoryWriteResult {
  entries: SiteMemoryIndexEntry[]
  addedTitles: string[]
  updatedTitles: string[]
  forgottenTitles: string[]
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* URL normalization and glob matching                                 */
/* ------------------------------------------------------------------ */

/**
 * Reduce a URL to lowercase `host/path` with no scheme, `www.`, port, query,
 * fragment, or trailing slash. Returns '' for anything that is not http(s) —
 * chrome://, about:blank, file: — since no site memory should fire there.
 */
export function normalizeUrlForScope(raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) return ''
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (!host) return ''
  const path = decodeSafe(url.pathname).replace(/\/+$/, '')
  return `${host}${path}`
}

function decodeSafe(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/**
 * Normalize a user/model-supplied scope into the canonical glob form. Accepts
 * full URLs, bare hosts, and `host/path` globs. Returns '' when unusable.
 */
export function normalizeScope(raw: string): string {
  let text = (raw ?? '').trim()
  if (!text) return ''
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  // Strip query/fragment, which are never matched against.
  text = text.replace(/[?#].*$/, '')
  const slash = text.indexOf('/')
  let host = (slash === -1 ? text : text.slice(0, slash)).toLowerCase()
  let path = slash === -1 ? '' : text.slice(slash)
  host = host.replace(/:\d+$/, '').replace(/^www\./, '')
  if (!host || /[\s]/.test(host)) return ''
  path = path.replace(/\/+/g, '/').replace(/\/+$/, '')
  if (!path) path = '/**'
  return `${host}${path}`
}

/**
 * Compile one canonical scope into a RegExp over `normalizeUrlForScope` output.
 * `**` → anything (including `/`); `*` → anything except `/` and `.`-crossing in
 * the host, or except `/` in the path. Only these two tokens are special.
 */
export function scopeToRegExp(scope: string): RegExp {
  const slash = scope.indexOf('/')
  const host = slash === -1 ? scope : scope.slice(0, slash)
  const path = slash === -1 ? '/**' : scope.slice(slash)

  const hostRe = host
    .split('*')
    .map(escapeRegExp)
    .join('[^./]*')
  // A trailing `/**` also matches the bare path (no trailing slash after normalization).
  const pathRe = path
    .replace(/\/\*\*$/, '\u0000TAIL')
    .split('**')
    .map((chunk) => chunk.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*')
    .replace('\u0000TAIL', '(?:/.*)?')
  return new RegExp(`^${hostRe}${pathRe}$`, 'i')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const compiled = new Map<string, RegExp>()

export function scopeMatches(scope: string, url: string): boolean {
  const normalized = normalizeUrlForScope(url)
  if (!normalized) return false
  let re = compiled.get(scope)
  if (!re) {
    try {
      re = scopeToRegExp(scope)
    } catch {
      return false
    }
    compiled.set(scope, re)
  }
  return re.test(normalized)
}

/** Literal characters in a scope: the crude but stable specificity measure. */
export function scopeSpecificity(scope: string): number {
  return scope.replace(/\*/g, '').length
}

/**
 * Entries applying to `url`, most specific first (ties keep file order). The
 * specificity of an entry is that of its best-matching scope.
 */
export function matchSiteMemories<T extends SiteMemoryEntry>(entries: T[], url: string): T[] {
  const normalized = normalizeUrlForScope(url)
  if (!normalized) return []
  const scored: Array<{ entry: T; score: number; order: number }> = []
  entries.forEach((entry, order) => {
    let best = -1
    for (const scope of entry.scopes) {
      if (scopeMatches(scope, normalized)) best = Math.max(best, scopeSpecificity(scope))
    }
    if (best >= 0) scored.push({ entry, score: best, order })
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.map((s) => s.entry)
}

/* ------------------------------------------------------------------ */
/* Parse / format                                                      */
/* ------------------------------------------------------------------ */

const SCOPE_LINE = /^<!--\s*scopes?\s*:\s*(.*?)\s*-->$/i

function parseScopeList(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/\s*\|\s*|\s+/)) {
    const scope = normalizeScope(part)
    if (scope && !out.includes(scope)) out.push(scope)
  }
  return out.slice(0, SITE_MEMORY_MAX_SCOPES)
}

/**
 * Tolerant of hand edits, like `parseMemory`. Entries with no usable scope are
 * kept in the file (the user wrote them) but never match anything until fixed.
 */
export function parseSiteMemory(text: string): SiteMemoryIndexEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: SiteMemoryIndexEntry[] = []

  for (let i = 0; i < lines.length; i++) {
    const heading = /^##\s+(.*\S)\s*$/.exec(lines[i] ?? '')
    if (!heading) continue
    const title = toSingleLine(heading[1] ?? '', SITE_MEMORY_TITLE_MAX).text
    if (!title) continue

    const bodyParts: string[] = []
    let scopes: string[] = []
    let date = ''
    let guide: string | undefined
    let triggers: string[] | undefined
    let endLine = i + 1
    for (let j = i + 1; j < lines.length; j++) {
      const line = (lines[j] ?? '').trim()
      if (/^##?\s/.test(line)) break
      const scopeMatch = SCOPE_LINE.exec(line)
      if (scopeMatch) {
        scopes = parseScopeList(scopeMatch[1] ?? '')
        endLine = Math.max(endLine, j + 1)
        continue
      }
      const guideMatch = /^<!--\s*guide:\s*(.*?)\s*-->$/.exec(line)
      if (guideMatch) {
        guide = normalizeGuidePath(guideMatch[1] ?? '') || undefined
        endLine = j + 1
        continue
      }
      const triggerMatch = /^<!--\s*triggers:\s*(.*?)\s*-->$/.exec(line)
      if (triggerMatch) {
        try {
          const values: unknown = JSON.parse(triggerMatch[1] ?? '')
          if (Array.isArray(values) && values.every((v) => typeof v === 'string')) triggers = normalizeTriggers(values)
        } catch { /* Keep hand-edited bodies readable even with malformed metadata. */ }
        endLine = j + 1
        continue
      }
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
      scopes,
      ...(guide ? { guide } : {}),
      ...(triggers?.length ? { triggers } : {}),
      body: toSingleLine(bodyParts.join(' '), SITE_MEMORY_BODY_MAX).text,
      date,
      startLine: i + 1,
      endLine,
    })
  }
  return entries
}

export function formatSiteMemory(entries: SiteMemoryEntry[]): string {
  if (entries.length === 0) return `${HEADER}\n_No site memories yet._\n`
  const blocks = entries.map((entry) => {
    const title = toSingleLine(entry.title, SITE_MEMORY_TITLE_MAX).text
    const body = toSingleLine(entry.body, SITE_MEMORY_BODY_MAX).text
    const date = /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : todayIso()
    const scopes = entry.scopes.length > 0 ? entry.scopes.join(' | ') : '(none — add a host/path glob)'
    const metadata = [entry.guide ? `<!-- guide: ${entry.guide} -->` : '', entry.triggers?.length ? `<!-- triggers: ${JSON.stringify(entry.triggers)} -->` : ''].filter(Boolean)
    return `## ${title}\n<!-- scope: ${scopes} -->\n${metadata.length ? metadata.join('\n') + '\n' : ''}${body || '—'}\n<!-- ${date} -->\n`
  })
  return `${HEADER}\n${blocks.join('\n')}`
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

export function upsertSiteMemories(
  existing: SiteMemoryEntry[],
  incoming: SiteMemoryWriteInput[],
  now = new Date(),
): { entries: SiteMemoryEntry[]; addedTitles: string[]; updatedTitles: string[]; warnings: string[] } {
  const entries = existing.map((entry) => ({ ...entry, scopes: [...entry.scopes] }))
  const index = new Map<string, number>()
  entries.forEach((entry, i) => index.set(memoryKey(entry.title), i))

  const addedTitles: string[] = []
  const updatedTitles: string[] = []
  const warnings: string[] = []
  const date = todayIso(now)

  for (const candidate of incoming) {
    const title = toSingleLine(candidate.title ?? '', SITE_MEMORY_TITLE_MAX)
    const body = toSingleLine(candidate.body ?? '', SITE_MEMORY_BODY_MAX)
    if (!title.text) {
      warnings.push('skipped a site memory with an empty title')
      continue
    }
    const scopes: string[] = []
    for (const raw of candidate.scopes ?? []) {
      const scope = normalizeScope(raw)
      if (!scope) warnings.push(`ignored unusable scope "${raw}" on "${title.text}"`)
      else if (!scopes.includes(scope)) scopes.push(scope)
    }
    if (scopes.length === 0) {
      warnings.push(`skipped "${title.text}": a site memory needs at least one host/path scope`)
      continue
    }
    if (scopes.length > SITE_MEMORY_MAX_SCOPES) {
      warnings.push(`kept only the first ${SITE_MEMORY_MAX_SCOPES} scopes of "${title.text}"`)
      scopes.length = SITE_MEMORY_MAX_SCOPES
    }
    if (title.clamped) warnings.push(`clamped title to ${SITE_MEMORY_TITLE_MAX} chars: "${title.text}"`)
    if (body.clamped) {
      warnings.push(
        `clamped body of "${title.text}" to ${SITE_MEMORY_BODY_MAX} chars — put longer detail in a /workspace/sites/ file and link it from the body`,
      )
    }

    const key = memoryKey(title.text)
    const at = index.get(key)
    const previous = at === undefined ? undefined : entries[at]
    const guide = candidate.guide === undefined ? previous?.guide : normalizeGuidePath(candidate.guide) || undefined
    if (candidate.guide?.trim() && !guide) {
      warnings.push(`skipped "${title.text}": guide must be a Markdown file under /workspace/sites/`)
      continue
    }
    const triggers = candidate.triggers === undefined ? previous?.triggers : normalizeTriggers(candidate.triggers)
    const metadata = { ...(guide ? { guide } : {}), ...(triggers?.length ? { triggers } : {}) }
    if (at === undefined) {
      index.set(key, entries.length)
      entries.push({ title: title.text, scopes, body: body.text, ...metadata, date })
      addedTitles.push(title.text)
    } else {
      const previous = entries[at]!
      const unchanged =
        previous.title === title.text && previous.body === body.text && sameList(previous.scopes, scopes) &&
        previous.guide === guide && sameList(previous.triggers ?? [], triggers ?? [])
      entries[at] = { title: title.text, scopes, body: body.text, ...metadata, date: unchanged ? previous.date : date }
      if (!unchanged) updatedTitles.push(title.text)
    }
  }
  return { entries, addedTitles, updatedTitles, warnings }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

export function removeSiteMemories(
  existing: SiteMemoryEntry[],
  titles: string[],
): { entries: SiteMemoryEntry[]; forgottenTitles: string[]; missing: string[] } {
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
/* Injection                                                           */
/* ------------------------------------------------------------------ */

/** Concise bodies are immediately usable; detailed guides remain on demand. */
export function renderSiteMemories(matches: SiteMemoryIndexEntry[]): string {
  const shown = matches.slice(0, SITE_MEMORY_MAX_MATCHES)
  const lines = shown.map((entry) => {
    const attrs = `title="${contextText(entry.title)}" scopes="${contextText(entry.scopes.join(' | '))}" updated="${contextText(entry.date)}" lines="${entry.startLine}-${entry.endLine}"`
    const guide = entry.guide ? `\n<guide path="${contextText(entry.guide)}">Read with api.fs.readText when this procedure is needed.</guide>` : ''
    return `<memory ${attrs}>\n${contextText(redactSecrets(entry.body))}${guide}\n</memory>`
  })
  if (matches.length > shown.length) {
    lines.push(`<more count="${matches.length - shown.length}" path="${SITE_MEMORY_PATH}">Additional matching entries; use api.fs.readLines if needed:\n${matches.slice(shown.length).map((e) => `${contextText(e.title)} (lines ${e.startLine}-${e.endLine})`).join('\n')}\n</more>`)
  }
  return lines.join('\n')
}

export function siteMemoryBlock(entries: SiteMemoryIndexEntry[], url: string): string {
  const matches = matchSiteMemories(entries, url)
  if (matches.length === 0) return ''
  return `<site-memory url="${contextText(normalizeUrlForScope(url))}">\n${renderSiteMemories(matches)}\n</site-memory>`
}

/** Include bodies, scopes, dates, and metadata: a same-title correction is new context. */
export function siteMemoryMatchKey(entries: SiteMemoryEntry[], url: string): string {
  return JSON.stringify(matchSiteMemories(entries, url))
}

/** Explicit site names route reusable guides; task words never broaden a fact's URL scope. */
export function siteGuideMatchesTask(entry: SiteMemoryEntry, task: string): boolean {
  if (!entry.guide) return false
  const normalized = task.toLowerCase()
  return (entry.triggers ?? []).some((trigger) => {
    const escaped = escapeRegExp(trigger)
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(normalized)
  })
}

/* ------------------------------------------------------------------ */
/* VFS access                                                          */
/* ------------------------------------------------------------------ */

export async function readSiteMemory(vfs: VirtualFileSystemService): Promise<SiteMemoryIndexEntry[]> {
  try {
    const entry = await vfs.getEntry(SITE_MEMORY_PATH)
    if (!entry) return []
    const result = await vfs.readText(SITE_MEMORY_PATH, { maxChars: 1_000_000 })
    return parseSiteMemory(result.text)
  } catch (err) {
    debugLog.error('agent', 'readSiteMemory', err)
    return []
  }
}

export async function applySiteMemoryWrite(
  vfs: VirtualFileSystemService,
  input: { memories?: SiteMemoryWriteInput[]; forget?: string[] },
  now = new Date(),
): Promise<SiteMemoryWriteResult> {
  const memories = input.memories ?? []
  const forget = input.forget ?? []
  if (memories.length === 0 && forget.length === 0) {
    throw new Error('nothing to write: pass scoped `memories`, `forget`, or both')
  }

  const current = await readSiteMemory(vfs)
  const removed = removeSiteMemories(current, forget)
  const merged = upsertSiteMemories(removed.entries, memories, now)

  if (merged.entries.length > SITE_MEMORY_MAX_ENTRIES) {
    throw new Error(
      `${SITE_MEMORY_PATH} is full (${SITE_MEMORY_MAX_ENTRIES} entries). Consolidate entries that share a scope, or drop stale ones with \`forget\`, then write again.`,
    )
  }

  // Only the `forget` path may run against a file that does not exist yet; do
  // not materialize an empty SITES.md just because a forget matched nothing.
  if (current.length === 0 && merged.entries.length === 0) {
    return {
      entries: [],
      addedTitles: [],
      updatedTitles: [],
      forgottenTitles: [],
      warnings: [...merged.warnings, ...removed.missing.map((m) => `no site memory matched "${m}"`)],
    }
  }

  const text = formatSiteMemory(merged.entries)
  await vfs.writeText(SITE_MEMORY_PATH, text, { mediaType: 'text/markdown' })

  const warnings = [...merged.warnings]
  for (const missing of removed.missing) warnings.push(`no site memory matched "${missing}"`)

  return {
    entries: parseSiteMemory(text),
    addedTitles: merged.addedTitles,
    updatedTitles: merged.updatedTitles,
    forgottenTitles: removed.forgottenTitles,
    warnings,
  }
}

/* ------------------------------------------------------------------ */
/* Tool-result text                                                    */
/* ------------------------------------------------------------------ */

function quote(title: string): string {
  return `"${title}"`
}

export function describeSiteMemoryWrite(result: SiteMemoryWriteResult): string {
  const parts: string[] = []
  if (result.addedTitles.length > 0) parts.push(`remembered ${result.addedTitles.map(quote).join(', ')}`)
  if (result.updatedTitles.length > 0) parts.push(`updated ${result.updatedTitles.map(quote).join(', ')}`)
  if (result.forgottenTitles.length > 0) parts.push(`forgot ${result.forgottenTitles.map(quote).join(', ')}`)
  if (parts.length === 0) parts.push('no change')
  const n = result.entries.length
  const head = `Site memory: ${parts.join('; ')}. ${SITE_MEMORY_PATH} now holds ${n} ${n === 1 ? 'entry' : 'entries'}.`
  return result.warnings.length > 0 ? `${head}\nNote: ${result.warnings.join('; ')}.` : head
}

/**
 * One tool result for a `memory_write` that may have touched both files. A title
 * in `forget` that lives in one file is reported "missing" by the other; that
 * noise is dropped whenever the forget did land somewhere.
 */
export function describeCombinedMemoryWrite(
  userResult: MemoryWriteResult | undefined,
  siteResult: SiteMemoryWriteResult | undefined,
  forgotten: string[],
  wroteSiteMemories: boolean,
): string {
  const forgottenKeys = new Set(forgotten.map(memoryKey))
  const dropMatchedMissing = (warnings: string[]) =>
    warnings.filter((w) => {
      const m = /^no (?:site )?memory matched "(.*)"$/.exec(w)
      return !m || !forgottenKeys.has(memoryKey(m[1] ?? ''))
    })

  const parts: string[] = []
  if (userResult) {
    const changed =
      userResult.addedTitles.length + userResult.updatedTitles.length + userResult.forgottenTitles.length > 0
    const warnings = dropMatchedMissing(userResult.warnings)
    // A forget-only call that landed in SITES.md should not also print a
    // "no change" line for MEMORY.md.
    if (changed || !siteResult || siteResult.forgottenTitles.length === 0 || warnings.length > 0) {
      parts.push(describeMemoryWrite({ ...userResult, warnings }))
    }
  }
  if (siteResult) {
    const changed =
      siteResult.addedTitles.length + siteResult.updatedTitles.length + siteResult.forgottenTitles.length > 0
    const warnings = dropMatchedMissing(siteResult.warnings)
    if (changed || wroteSiteMemories) parts.push(describeSiteMemoryWrite({ ...siteResult, warnings }))
    else if (warnings.length > 0) parts.push(`Note: ${warnings.join('; ')}.`)
  }
  return parts.join('\n') || 'no change'
}
