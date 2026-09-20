/**
 * Stream inspector — the read side of `shared/stream-tap.ts`.
 *
 * A standalone popup window (opened from Settings → Behavior) that shows, in
 * real time, exactly what went out to the provider and exactly what came back:
 * the request body, the raw SSE bytes as they arrive, and the parsed
 * `fullStream` parts the AI SDK handed the agent loop. Reading raw against
 * parsed side by side is what makes a "the stream just stops" or "tool args
 * never arrive" bug diagnosable.
 *
 * Deliberately plain DOM with no React and no imports from `src/ui/`: it has to
 * absorb thousands of entries a second without the render cost of a framework.
 * Two rules keep it fast — appends are batched into one `requestAnimationFrame`
 * and go through a DocumentFragment (the list is never rebuilt while streaming;
 * only a filter change rebuilds), and both the entry buffer and the DOM are
 * hard-capped so a long session can't grow without bound.
 *
 * Importing stream-tap here is only for the channel name, key, and types — the
 * publisher it initializes on import stays idle in this page.
 */

import {
  STREAM_TAP_CHANNEL,
  STREAM_TAP_KEY,
  type StreamTapEntry,
  type StreamTapMessage,
} from '../shared/stream-tap'

/** Ring-buffer cap, for both the buffer and the rendered rows. */
const MAX_ENTRIES = 5000
/** Payloads longer than this render collapsed (click to expand). */
const CLIP_CHARS = 500
/** How close to the bottom still counts as "pinned". */
const PIN_SLACK = 60
/** Gaps at or above this are the interesting ones — highlight them. */
const SLOW_MS = 250

type Kind = StreamTapEntry['kind']
const ALL_KINDS: Kind[] = ['request', 'raw', 'part', 'meta', 'log']

interface Row {
  entry: StreamTapEntry
  /** ms since the previous entry, in arrival order (not filtered order). */
  delta: number
}

const listEl = byId<HTMLDivElement>('list')
const armBtn = byId<HTMLButtonElement>('arm')
const pauseBtn = byId<HTMLButtonElement>('pause')
const copyBtn = byId<HTMLButtonElement>('copy')
const clearBtn = byId<HTMLButtonElement>('clear')
const findEl = byId<HTMLInputElement>('find')
const countsEl = byId<HTMLSpanElement>('counts')

const buffer: Row[] = []
let pending: Row[] = []
const kinds = new Set<Kind>(ALL_KINDS)
let find = ''
let lastAt = 0
let totalBytes = 0
let shown = 0
let paused = false
let armed = false
let flushScheduled = false
let findTimer: number | undefined

const channel = new BroadcastChannel(STREAM_TAP_CHANNEL)
channel.addEventListener('message', (e: MessageEvent<StreamTapMessage>) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object' || msg.type !== 'entry') return
  const entry = msg.entry
  const row: Row = { entry, delta: lastAt === 0 ? 0 : entry.at - lastAt }
  lastAt = entry.at
  buffer.push(row)
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
  totalBytes += entry.bytes ?? entry.text.length
  if (!paused) pending.push(row)
  schedule()
})

/** Batch DOM work: raw chunks can land dozens of times per frame. */
function schedule(): void {
  if (flushScheduled) return
  flushScheduled = true
  requestAnimationFrame(flush)
}

function flush(): void {
  flushScheduled = false
  if (pending.length > 0) {
    // Measure before mutating: auto-scroll only if the view is already at the
    // bottom, so scrolling up to read something doesn't fight the stream.
    const pinned = isPinned()
    const frag = document.createDocumentFragment()
    let added = 0
    for (const row of pending) {
      if (!matches(row.entry)) continue
      frag.appendChild(buildRow(row))
      added += 1
    }
    pending = []
    if (added > 0) {
      dropPlaceholder()
      listEl.appendChild(frag)
      shown += added
      trimDom()
      if (pinned) listEl.scrollTop = listEl.scrollHeight
    }
  }
  paintCounts()
}

function matches(entry: StreamTapEntry): boolean {
  if (!kinds.has(entry.kind)) return false
  if (find === '') return true
  return entry.label.toLowerCase().includes(find) || entry.text.toLowerCase().includes(find)
}

function buildRow({ entry, delta }: Row): HTMLDivElement {
  const row = document.createElement('div')
  row.className = `row row--${entry.kind}`
  const head = document.createElement('div')
  head.className = 'head'
  head.append(
    span('seq', `#${entry.seq}`),
    span('ts', stamp(entry.at)),
    span(delta >= SLOW_MS ? 'delta slow' : 'delta', `+${delta}ms`),
    span('kind', entry.kind),
    span('label', entry.label),
  )
  if (entry.bytes !== undefined) head.append(span('bytes', `${entry.bytes} B`))
  const body = document.createElement('pre')
  body.className = entry.text.length > CLIP_CHARS ? 'body clip' : 'body'
  body.textContent = entry.text
  row.append(head, body)
  return row
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

/** Full rebuild — only on filter change, clear, or resume. */
function rerender(): void {
  listEl.textContent = ''
  const frag = document.createDocumentFragment()
  shown = 0
  for (const row of buffer) {
    if (!matches(row.entry)) continue
    frag.appendChild(buildRow(row))
    shown += 1
  }
  if (shown === 0) {
    const note = document.createElement('div')
    note.className = 'empty'
    note.textContent =
      buffer.length === 0
        ? 'Waiting for traffic. Send a message in the side panel.'
        : `No entries match the filter (${buffer.length} buffered).`
    frag.appendChild(note)
  }
  listEl.appendChild(frag)
  listEl.scrollTop = listEl.scrollHeight
  paintCounts()
}

function trimDom(): void {
  while (listEl.childElementCount > MAX_ENTRIES) {
    listEl.firstElementChild?.remove()
    shown -= 1
  }
}

function dropPlaceholder(): void {
  const first = listEl.firstElementChild
  if (first?.classList.contains('empty')) first.remove()
}

function isPinned(): boolean {
  return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < PIN_SLACK
}

function paintCounts(): void {
  const parts = [`${buffer.length} entries`, formatBytes(totalBytes), `${Math.max(shown, 0)} shown`]
  if (paused) parts.push('paused')
  countsEl.textContent = parts.join(' · ')
}

function paintArm(): void {
  armBtn.textContent = armed ? 'Armed' : 'Disarmed'
  armBtn.className = armed ? 'on' : 'off'
  armBtn.title = armed ? 'Tap is publishing — click to disarm' : 'Tap is off — click to arm'
}

/**
 * Arming is both a storage flag (survives a panel reload) and a broadcast (takes
 * effect immediately, before the panel's async storage read lands).
 */
function setArmed(next: boolean): void {
  armed = next
  paintArm()
  const msg: StreamTapMessage = { type: next ? 'arm' : 'disarm' }
  channel.postMessage(msg)
  void chrome.storage.local.set({ [STREAM_TAP_KEY]: next }).catch(() => {})
}

armBtn.addEventListener('click', () => setArmed(!armed))

pauseBtn.addEventListener('click', () => {
  paused = !paused
  pauseBtn.textContent = paused ? 'Resume' : 'Pause'
  pauseBtn.className = paused ? 'off' : ''
  // Entries keep buffering while paused; resuming replays them through the
  // normal filter path rather than dropping the gap.
  if (!paused) rerender()
  else paintCounts()
})

copyBtn.addEventListener('click', () => {
  const jsonl = buffer.map((row) => JSON.stringify(row.entry)).join('\n')
  void navigator.clipboard.writeText(jsonl).then(
    () => flashButton(copyBtn, 'Copied', 'Copy all'),
    () => flashButton(copyBtn, 'Copy failed', 'Copy all'),
  )
})

clearBtn.addEventListener('click', () => {
  buffer.length = 0
  pending = []
  totalBytes = 0
  lastAt = 0
  rerender()
})

for (const box of document.querySelectorAll<HTMLInputElement>('.filters input[type="checkbox"]')) {
  box.addEventListener('change', () => {
    const kind = ALL_KINDS.find((k) => k === box.dataset.kind)
    if (!kind) return
    if (box.checked) kinds.add(kind)
    else kinds.delete(kind)
    rerender()
  })
}

findEl.addEventListener('input', () => {
  window.clearTimeout(findTimer)
  findTimer = window.setTimeout(() => {
    find = findEl.value.trim().toLowerCase()
    rerender()
  }, 120)
})

// One delegated listener instead of one per row.
listEl.addEventListener('click', (e) => {
  const target = e.target
  if (target instanceof HTMLElement && target.classList.contains('body')) target.classList.toggle('clip')
})

// Another inspector window (or the panel) flipping the flag keeps the button honest.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  const change = changes[STREAM_TAP_KEY]
  if (!change) return
  const next = change.newValue === true
  if (next === armed) return
  armed = next
  paintArm()
})

// Best-effort: leaving the tap armed after the window closes would cost the
// panel a fetch wrapper on every turn for no observer. The broadcast lands
// synchronously in a live panel even if the storage write doesn't flush.
window.addEventListener('pagehide', () => {
  const msg: StreamTapMessage = { type: 'disarm' }
  channel.postMessage(msg)
  void chrome.storage.local.set({ [STREAM_TAP_KEY]: false }).catch(() => {})
})

function flashButton(button: HTMLButtonElement, text: string, restore: string): void {
  button.textContent = text
  window.setTimeout(() => {
    button.textContent = restore
  }, 1200)
}

function stamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`stream inspector: #${id} not found`)
  return el as T
}

setArmed(true)
paintCounts()
