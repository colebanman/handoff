/**
 * Stickies — tiny Markdown notes the user and the agent edit together. Each
 * sticky is one `.md` file under /workspace/stickies/ whose YAML-ish
 * frontmatter carries its placement; the body is the note. The workspace file
 * is the single source of truth: the agent writes it (api.stickies.* or plain
 * api.fs.writeText), the page overlay renders it, and the user's checkbox
 * ticks and edits are written straight back into it.
 *
 *   /workspace/stickies/todo.md
 *   ---
 *   title: Today
 *   open: true            ← shown on pages (and delivered to every chat)
 *   pages: all            ← or a list of URL scopes (site-memory syntax)
 *   position: top-right
 *   ---
 *   - [ ] Reply to Handoff
 *   - [x] Book dentist
 *
 * Model-facing delivery: an OPEN sticky's full body is delivered once per chat
 * as `<sticky>`; later user edits arrive as compact `<sticky-user-edit>` diffs
 * (see src/agent/stickies-context.ts). Closed stickies stay in the workspace
 * and out of context.
 */

import { contextText } from './context-blocks'

export const STICKIES_DIR = '/workspace/stickies'
export const STICKY_PORT = 'ai-sticky-v1'
export const STICKY_REVISION_KEY_PREFIX = 'sticky-revisions:'
/** Body snapshots kept per sticky so any chat can diff from the revision it last saw. */
export const STICKY_REVISION_HISTORY = 24
/** Above this many changed lines the full body is redelivered instead of a diff. */
export const STICKY_DIFF_MAX_LINES = 24
export const STICKY_MAX_BODY_CHARS = 20_000
export const STICKY_MAX_COUNT = 40

export type StickyAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export const STICKY_ANCHORS: readonly StickyAnchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

export type StickySide = 'right' | 'left' | 'above' | 'below'
export type StickyAlign = 'start' | 'center' | 'end'
export const STICKY_SIDES: readonly StickySide[] = ['right', 'left', 'above', 'below']
export const STICKY_ALIGNS: readonly StickyAlign[] = ['start', 'center', 'end']

/**
 * Optional precise placement. Without a pin a sticky sits in its corner
 * (`position` + the user's `dx`/`dy` drag offset) — the common case. A pin
 * overrides that corner while it resolves; when an element pin finds nothing
 * on the page the card falls back to the corner, so `position` always stays
 * meaningful.
 */
export type StickyPin =
  | { kind: 'point'; x: number; y: number; origin: 'viewport' | 'page' }
  | { kind: 'element'; selector: string; side: StickySide; align: StickyAlign; label?: string }

export interface StickyMeta {
  title: string
  /** Shown on matching pages and delivered to chats. */
  open: boolean
  /** Overlay folded to its title bar (UI-only; never sent to the model). */
  collapsed: boolean
  /** 'all' or URL scopes in site-memory syntax (`mail.google.com/**`, `*.instructure.com/**`). */
  pages: 'all' | string[]
  position: StickyAnchor
  /** Drag offset, px: from the anchor corner, or from the pin when one resolves. */
  dx: number
  dy: number
  /** Precise placement that overrides the corner while it resolves. */
  pin?: StickyPin
}

export interface StickyRecord extends StickyMeta {
  /** `title` here is the raw frontmatter value (may be empty); use stickyTitle() to display. */
  /** File stem, e.g. "todo" for /workspace/stickies/todo.md. */
  id: string
  path: string
  body: string
  revision: number
  updatedAt: number
}

export type StickyEditor = 'user' | 'agent'

export interface StickyRevisionEntry {
  revision: number
  by: StickyEditor
  at: number
  /** Chat whose agent made the edit (agent edits only, when known). */
  chatId?: string
  body: string
}

export interface StickyRevisionLog {
  revision: number
  entries: StickyRevisionEntry[]
}

export const DEFAULT_STICKY_META: StickyMeta = {
  title: '', open: true, collapsed: false, pages: 'all', position: 'top-right', dx: 0, dy: 0,
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export function isStickyPath(path: string): boolean {
  return path.startsWith(`${STICKIES_DIR}/`) && /\.md$/i.test(path) && !path.slice(STICKIES_DIR.length + 1).includes('/')
}

export function stickyIdFromPath(path: string): string {
  return path.slice(STICKIES_DIR.length + 1).replace(/\.md$/i, '')
}

/** "Todo list", "todo.md", "stickies/todo", "/workspace/stickies/todo.md" → "/workspace/stickies/todo-list.md". */
export function normalizeStickyPath(raw: string): string {
  let value = raw.trim().replace(/\\/g, '/')
  if (!value) throw new Error('sticky name is required')
  if (value.startsWith('/')) {
    if (!isStickyPath(value.replace(/\.md$/i, '') + '.md')) throw new Error(`stickies live under ${STICKIES_DIR}/ (got ${JSON.stringify(raw)})`)
    value = stickyIdFromPath(value.replace(/\.md$/i, '') + '.md')
  } else {
    value = value.replace(/^(workspace\/|stickies\/)+/, '').replace(/\.md$/i, '')
  }
  const id = slugify(value)
  if (!id) throw new Error(`sticky name ${JSON.stringify(raw)} has no usable characters`)
  return `${STICKIES_DIR}/${id}.md`
}

export function slugify(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/* ------------------------------------------------------------------ */
/* File format                                                         */
/* ------------------------------------------------------------------ */

export function parseSticky(text: string): { meta: StickyMeta; body: string } {
  const meta: StickyMeta = { ...DEFAULT_STICKY_META }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { meta, body: text.replace(/^\s*\n/, '') }
  const pages: string[] = []
  const pin: Record<string, unknown> = {}
  let inPages = false
  for (const rawLine of match[1]!.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (inPages && /^\s+-\s+/.test(line)) { pages.push(unquote(line.replace(/^\s+-\s+/, ''))); continue }
    inPages = false
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!.toLowerCase(), value = kv[2]!.trim()
    switch (key) {
      case 'title': meta.title = unquote(value); break
      case 'open': meta.open = value !== 'false' && value !== 'no'; break
      case 'collapsed': meta.collapsed = value === 'true' || value === 'yes'; break
      case 'position': if (STICKY_ANCHORS.includes(value as StickyAnchor)) meta.position = value as StickyAnchor; break
      case 'dx': meta.dx = clampOffset(Number(value)); break
      case 'dy': meta.dy = clampOffset(Number(value)); break
      case 'pin': pin.kind = value.toLowerCase(); break
      case 'selector': pin.selector = unquote(value); break
      case 'side': pin.side = value.toLowerCase(); break
      case 'align': pin.align = value.toLowerCase(); break
      case 'origin': pin.origin = value.toLowerCase(); break
      case 'label': pin.label = unquote(value); break
      case 'x': pin.x = Number(value); break
      case 'y': pin.y = Number(value); break
      case 'pages': {
        if (!value) { inPages = true; break }
        const parsed = parsePagesValue(value)
        if (parsed === 'all') meta.pages = 'all'
        else pages.push(...parsed)
        break
      }
    }
  }
  if (pages.length) meta.pages = pages
  if (pin.kind) { const parsed = normalizePin(pin); if (parsed) meta.pin = parsed }
  return { meta, body: text.slice(match[0].length) }
}

export function formatSticky(meta: StickyMeta, body: string): string {
  const lines = ['---', `title: ${quote(meta.title)}`, `open: ${meta.open}`]
  if (meta.collapsed) lines.push('collapsed: true')
  lines.push(meta.pages === 'all' ? 'pages: all' : `pages: [${meta.pages.map(quote).join(', ')}]`)
  lines.push(`position: ${meta.position}`)
  if (meta.pin?.kind === 'element') {
    lines.push('pin: element', `selector: ${quote(meta.pin.selector)}`, `side: ${meta.pin.side}`, `align: ${meta.pin.align}`)
    if (meta.pin.label) lines.push(`label: ${quote(meta.pin.label)}`)
  } else if (meta.pin?.kind === 'point') {
    lines.push('pin: point', `x: ${Math.round(meta.pin.x)}`, `y: ${Math.round(meta.pin.y)}`, `origin: ${meta.pin.origin}`)
  }
  if (meta.dx) lines.push(`dx: ${Math.round(meta.dx)}`)
  if (meta.dy) lines.push(`dy: ${Math.round(meta.dy)}`)
  lines.push('---')
  const trimmed = body.replace(/^\n+/, '').replace(/\s+$/, '')
  return `${lines.join('\n')}\n${trimmed}${trimmed ? '\n' : ''}`
}

/** Accepts 'all', '*', a JSON/inline array, or a comma-separated list. */
export function parsePagesValue(value: unknown): 'all' | string[] {
  if (value === undefined || value === null || value === '' || value === 'all' || value === '*' || value === true) return 'all'
  const list = Array.isArray(value) ? value.map(String)
    : typeof value === 'string' ? value.trim().replace(/^\[|\]$/g, '').split(',') : []
  const scopes = list.map((item) => unquote(item.trim())).filter(Boolean)
  if (!scopes.length || scopes.includes('all') || scopes.includes('*')) return 'all'
  return [...new Set(scopes)]
}

export function normalizeAnchor(value: unknown): StickyAnchor | undefined {
  if (typeof value !== 'string') return undefined
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-')
  const aliases: Record<string, StickyAnchor> = {
    'top-right': 'top-right', 'right-top': 'top-right', tr: 'top-right', 'upper-right': 'top-right',
    'top-left': 'top-left', 'left-top': 'top-left', tl: 'top-left', 'upper-left': 'top-left',
    'bottom-right': 'bottom-right', 'right-bottom': 'bottom-right', br: 'bottom-right', 'lower-right': 'bottom-right',
    'bottom-left': 'bottom-left', 'left-bottom': 'bottom-left', bl: 'bottom-left', 'lower-left': 'bottom-left',
    right: 'top-right', left: 'top-left', top: 'top-right', bottom: 'bottom-right',
  }
  return aliases[key]
}

/** Coerce a loose pin shape (frontmatter strings or model JSON) into a StickyPin. */
export function normalizePin(raw: unknown): StickyPin | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const spec = raw as Record<string, unknown>
  const kind = typeof spec.kind === 'string' ? spec.kind.toLowerCase() : spec.selector !== undefined ? 'element' : spec.x !== undefined ? 'point' : ''
  if (kind === 'element') {
    const selector = typeof spec.selector === 'string' ? spec.selector.trim() : ''
    if (!selector) return undefined
    const side = STICKY_SIDES.includes(spec.side as StickySide) ? spec.side as StickySide : 'right'
    const align = STICKY_ALIGNS.includes(spec.align as StickyAlign) ? spec.align as StickyAlign : 'start'
    const label = typeof spec.label === 'string' && spec.label.trim() ? spec.label.trim().slice(0, 60) : undefined
    return { kind: 'element', selector: selector.slice(0, 400), side, align, ...(label ? { label } : {}) }
  }
  if (kind === 'point') {
    const x = Number(spec.x), y = Number(spec.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    return { kind: 'point', x: clampCoord(x), y: clampCoord(y), origin: spec.origin === 'page' ? 'page' : 'viewport' }
  }
  return undefined
}

export interface StickyPlacementPatch {
  position?: StickyAnchor
  /** undefined = leave alone, null = clear back to the corner. */
  pin?: StickyPin | null
}

/**
 * Parse the `position` a caller supplied. Accepts the plain corner name (the
 * common case), `{ corner }`, `{ x, y, origin? }` for a fixed point, or
 * `{ selector, side?, align? }` for an element pin. `null`/'corner' clears a
 * pin. Throws with the accepted shapes when it cannot tell what was meant.
 */
export function parseStickyPosition(value: unknown): StickyPlacementPatch {
  if (value === null || value === 'corner' || value === 'default' || value === 'none') return { pin: null }
  if (typeof value === 'string') {
    const anchor = normalizeAnchor(value)
    if (!anchor) throw new Error(`position ${JSON.stringify(value)} is not a corner — use top-left, top-right, bottom-left, bottom-right, or an object ({ x, y } or { selector, side }).`)
    return { position: anchor, pin: null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`position must be a corner name, { corner }, { x, y, origin? }, or { selector, side?, align? } (got ${JSON.stringify(value)})`)
  }
  const spec = value as Record<string, unknown>
  const cornerRaw = spec.corner ?? spec.anchor ?? spec.fallback ?? spec.position
  const position = cornerRaw === undefined ? undefined : normalizeAnchor(cornerRaw)
  if (cornerRaw !== undefined && !position) throw new Error(`corner ${JSON.stringify(cornerRaw)} is not one of top-left, top-right, bottom-left, bottom-right`)
  if (spec.selector !== undefined || spec.x !== undefined || spec.y !== undefined || spec.kind !== undefined) {
    const pin = normalizePin(spec)
    if (!pin) {
      throw new Error(
        spec.selector !== undefined
          ? 'an element pin needs a non-empty CSS selector — pass { ref } instead and the selector is resolved for you'
          : 'a point pin needs numeric x and y (CSS px)',
      )
    }
    return { position, pin }
  }
  return { position, pin: null }
}

/**
 * How the placement reads in the model-facing `<sticky position="…">`
 * attribute. Pinned cards report where they actually sit, the user's own drag
 * nudge included.
 */
export function describePlacement(meta: Pick<StickyMeta, 'position' | 'pin' | 'dx' | 'dy'>): string {
  const nudge = meta.dx || meta.dy ? ` ${meta.dx >= 0 ? '+' : ''}${Math.round(meta.dx)},${meta.dy >= 0 ? '+' : ''}${Math.round(meta.dy)}` : ''
  if (meta.pin?.kind === 'element') return `${meta.pin.side}-of ${meta.pin.label ?? meta.pin.selector}${nudge}`
  if (meta.pin?.kind === 'point') return `${meta.pin.origin} ${Math.round(meta.pin.x + meta.dx)},${Math.round(meta.pin.y + meta.dy)}`
  return meta.position
}

function clampCoord(value: number): number {
  return Math.max(-20_000, Math.min(20_000, Math.round(value)))
}

function clampOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(-4000, Math.min(4000, Math.round(value))) : 0
}

function quote(value: string): string {
  return /^[\w][\w .:/*?!#&()-]*$/.test(value) && !/^(true|false|yes|no|null|all)$/i.test(value) ? value : JSON.stringify(value)
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (/^".*"$/.test(trimmed)) { try { return JSON.parse(trimmed) as string } catch { return trimmed.slice(1, -1) } }
  if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1)
  return trimmed
}

/** Title fallback: first heading, else first non-empty line, else the id. */
export function stickyTitle(meta: Pick<StickyMeta, 'title'>, body: string, id: string): string {
  if (meta.title.trim()) return meta.title.trim()
  const heading = /^#{1,6}\s+(.+)$/m.exec(body)?.[1]
  if (heading) return heading.trim()
  const line = body.split(/\r?\n/).map((l) => l.replace(/^[-*+]\s+(\[[ xX]\]\s*)?/, '').trim()).find(Boolean)
  return (line ?? id).slice(0, 60)
}

/* ------------------------------------------------------------------ */
/* Body edits                                                          */
/* ------------------------------------------------------------------ */

export const TASK_LINE_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s.*|$)/

/** Flip the checkbox on 1-based `line` of `body`; returns null when that line is not a task. */
export function toggleTaskLine(body: string, line: number, checked: boolean): string | null {
  const lines = body.split('\n')
  const index = line - 1
  const current = lines[index]
  if (current === undefined) return null
  const match = TASK_LINE_RE.exec(current)
  if (!match) return null
  lines[index] = `${match[1]}[${checked ? 'x' : ' '}]${match[3] ?? ''}`
  return lines.join('\n')
}

export interface StickyTask { line: number; checked: boolean; text: string }

export function stickyTasks(body: string): StickyTask[] {
  return body.split('\n').flatMap((text, index) => {
    const match = TASK_LINE_RE.exec(text)
    return match ? [{ line: index + 1, checked: match[2] !== ' ', text: (match[3] ?? '').trim() }] : []
  })
}

/**
 * Compact line diff (LCS on lines; bounded). Returns unified-style lines
 * (`-`/`+` prefixed, line numbers for context) or null when the change is
 * too big to be worth a diff — callers then resend the whole body.
 */
export function diffStickyBodies(before: string, after: string): string[] | null {
  const a = before.replace(/\s+$/, '').split('\n'), b = after.replace(/\s+$/, '').split('\n')
  if (a.length * b.length > 250_000) return null
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: string[] = []
  let i = 0, j = 0, changed = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue }
    // Removed lines first, then their replacements: reads like a before/after pair.
    if (i < a.length && (j >= b.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) { out.push(`-${i + 1}: ${a[i]}`); i++; changed++ }
    else { out.push(`+${j + 1}: ${b[j]}`); j++; changed++ }
    if (changed > STICKY_DIFF_MAX_LINES) return null
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Model-facing XML                                                    */
/* ------------------------------------------------------------------ */

export function renderStickyBlock(record: StickyRecord): string {
  const pages = record.pages === 'all' ? 'all' : record.pages.join(', ')
  return `<sticky id="${contextText(record.id)}" path="${contextText(record.path)}" revision="${record.revision}" title="${contextText(stickyTitle(record, record.body, record.id))}" pages="${contextText(pages)}" position="${contextText(describePlacement(record))}">\n${contextText(record.body.replace(/\s+$/, ''))}\n</sticky>`
}

export function renderStickyClosed(id: string, revision: number): string {
  return `<sticky id="${contextText(id)}" revision="${revision}" state="closed" />`
}

export function renderStickyEdit(record: StickyRecord, fromRevision: number, by: StickyEditor | 'mixed', diff: string[]): string {
  const tag = by === 'user' ? 'sticky-user-edit' : 'sticky-update'
  const byAttr = by === 'user' ? '' : ` by="${by}"`
  return `<${tag} sticky="${contextText(record.id)}" from="${fromRevision}" revision="${record.revision}"${byAttr}>\n${diff.map(contextText).join('\n')}\n</${tag}>`
}

/** Delivered revision per sticky, reconstructed from earlier context messages after a compaction boundary. */
export function scanDeliveredStickies(text: string): Map<string, number | 'closed'> {
  const seen = new Map<string, number | 'closed'>()
  const re = /<(sticky|sticky-user-edit|sticky-update)\b([^>]*?)\/?>/g
  for (const match of text.matchAll(re)) {
    const attrs = match[2] ?? ''
    const id = /\b(?:id|sticky)="([^"]*)"/.exec(attrs)?.[1]
    const revision = Number(/\brevision="(\d+)"/.exec(attrs)?.[1])
    if (!id || !Number.isFinite(revision)) continue
    seen.set(id, /\bstate="closed"/.test(attrs) ? 'closed' : revision)
  }
  return seen
}

/* ------------------------------------------------------------------ */
/* Content script ⟷ background (chrome.runtime port STICKY_PORT)      */
/* ------------------------------------------------------------------ */

/** What a page overlay needs; `body` is the Markdown to render. */
export type StickyView = Pick<StickyRecord, 'id' | 'path' | 'title' | 'collapsed' | 'position' | 'dx' | 'dy' | 'pin' | 'body' | 'revision'>

export type StickyPageToBackground =
  | { type: 'hello' }
  | { type: 'toggle-task'; id: string; line: number; checked: boolean }
  | { type: 'edit'; id: string; body: string; revision: number }
  | { type: 'set'; id: string; collapsed?: boolean; open?: boolean; position?: StickyAnchor; dx?: number; dy?: number }

export type StickyBackgroundToPage =
  | { type: 'stickies'; items: StickyView[] }
  | { type: 'error'; message: string }

/* ------------------------------------------------------------------ */
/* Service the agent consumes (implemented in src/background)          */
/* ------------------------------------------------------------------ */

export interface StickyInput {
  name?: string
  title?: string
  content?: string
  pages?: unknown
  position?: unknown
  open?: boolean
}

export interface StickyPatch {
  title?: string
  content?: string
  pages?: unknown
  position?: unknown
  open?: boolean
  collapsed?: boolean
}

export interface StickySummary extends Omit<StickyRecord, 'dx' | 'dy'> {
  tasks: { total: number; done: number }
}

export interface StickyService {
  list(): Promise<StickySummary[]>
  get(name: string): Promise<StickySummary | undefined>
  create(input: StickyInput, chatId?: string): Promise<StickySummary>
  update(name: string, patch: StickyPatch, chatId?: string): Promise<StickySummary>
  remove(name: string): Promise<boolean>
  /** Called before an agent writes a sticky file through the generic filesystem so the revision is attributed. */
  noteAgentWrite(path: string, chatId?: string): void
}

export function summarizeSticky(record: StickyRecord): StickySummary {
  const { dx: _dx, dy: _dy, ...rest } = record
  const tasks = stickyTasks(record.body)
  return { ...rest, title: stickyTitle(record, record.body, record.id), tasks: { total: tasks.length, done: tasks.filter((task) => task.checked).length } }
}

/** Runtime messages between the side panel and the sticky host. */
export type StickyRuntimeMessage =
  | { target: 'background'; type: 'stickies.set'; path: string; open?: boolean }
  | { target: 'background'; type: 'stickies.list' }
