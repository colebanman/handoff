/**
 * Stream jitter buffer — the clock the feed reveals on.
 *
 * The transcript reducer folds every text/reasoning delta the instant it
 * arrives, and `.md-word` (see markdown-reveal.ts) deliberately has no stagger
 * because "the reveal is paced by the stream itself". That is the right design
 * for a smooth stream and the wrong one for a real one: providers deliver text
 * in clumps, so a 40-word burst fades in as a single flash and the 900ms
 * between a thought and its tool call is 900ms of nothing.
 *
 * The fix is not a fancier animation, it is a buffer. Arrival and display are
 * separated: `received` is what the stream has delivered, `revealed` is what
 * the user has seen, and a rAF ticker walks the second toward the first at a
 * rate chosen to keep a small, bounded reserve:
 *
 *     cps = clamp(pending / TARGET_LEAD, MIN_CPS, MAX_CPS)
 *
 * At steady state the display settles ~TARGET_LEAD behind arrival, and THAT
 * LAG IS THE SHOCK ABSORBER. A burst raises `pending`, so it drains faster and
 * catches up smoothly instead of flashing. A gap drains the reserve at a
 * decaying rate, so words keep appearing straight through the tool call.
 * `MIN_CPS` guarantees the reserve actually empties rather than approaching
 * zero forever.
 *
 * Three rules stop the reserve from becoming its own latency problem:
 *
 * - When a part ends the rate switches to a fixed flush so nothing is left
 *   hanging (`TEXT_TAIL_MS`). Thought headlines get a much longer tail
 *   (`REASONING_TAIL_MS`) precisely because they are the thing covering dead
 *   air — a six-word title becomes ~700ms of honest motion, not a blink.
 * - `PRESSURE_TAIL_MS`: once the model has produced something AFTER the
 *   draining part, the buffer stops savouring it and wraps up. This is what
 *   makes the generous reasoning tail safe — the hold only lasts while there
 *   is genuinely nothing else to show, and it never delays the model, only
 *   the paint. The display is at most one tail behind reality, and catches
 *   all the way up every time a part retires, so nothing accumulates.
 * - Reduced motion bypasses the whole thing.
 *
 * `applyReveal` is where the second, larger win lives: it truncates the feed at
 * the first still-draining part. A tool card that arrives while text is mid
 * reveal is held until the text lands, so the transcript reads as one
 * continuous performance instead of a stack of independently jittering
 * widgets. The hold is bounded by the tails above.
 *
 * Deliberately NOT persisted: this is a view-time effect over the real
 * transcript, so `buildRecord`/`saveChat` keep full text and a reopened chat
 * renders instantly with no entries at all.
 */
import type { TranscriptItem } from '../shared/types'
import { sliceWellFormed } from '../shared/text'

/** Steady-state display lag while a part is still streaming. The reserve. */
export const TARGET_LEAD_MS = 500
/** Floor, so a nearly-empty reserve finishes instead of decaying forever. */
export const MIN_CPS = 30
/** Ceiling, so one huge chunk can't dump a screenful in a single frame. */
export const MAX_CPS = 1000
/** Flush window once an answer's stream closes — the user wants to read it. */
export const TEXT_TAIL_MS = 260
/**
 * Flush window for a thought summary. Generous on purpose: a headline is the
 * only thing on screen during the wait it exists to cover, and stretching six
 * words across most of a second is the difference between "working" and
 * "frozen". Safe to be this long only because PRESSURE_TAIL_MS overrides it
 * the moment the model produces something real.
 */
export const REASONING_TAIL_MS = 900
/** Flush window once something is already queued behind this part. */
export const PRESSURE_TAIL_MS = 180
/** Never cut a word: how far back to hunt for whitespace before giving up. */
export const WORD_LOOKBACK = 48
/** A frame this long means the panel was hidden or the tab starved. */
const MAX_DT_MS = 100

/** Revealed character counts by transcript item id. Absent id = show it all. */
export type RevealCounts = Record<string, number>

interface Entry {
  received: number
  /** Fractional so sub-character-per-frame rates still make progress. */
  revealed: number
  /** The stream closed this part; drain on a fixed flush rate. */
  ended: boolean
  /** Something has arrived after this part — stop holding the feed up. */
  pressured: boolean
  /** Flush window for this kind of part. */
  tailMs: number
  /** Latched at flush time so the tail is linear, not another decay. */
  flushCps?: number
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * Characters per second for one entry. Exported for the tests — the whole
 * feel of the feature is this function.
 */
export function revealCps(entry: Pick<Entry, 'received' | 'revealed' | 'ended' | 'pressured' | 'tailMs' | 'flushCps'>): number {
  const pending = entry.received - entry.revealed
  if (pending <= 0) return 0
  if (entry.flushCps !== undefined) return entry.flushCps
  const lead = entry.pressured ? PRESSURE_TAIL_MS : TARGET_LEAD_MS
  return clamp((pending * 1000) / lead, MIN_CPS, MAX_CPS)
}

/** The fixed rate that empties `pending` inside the entry's flush window. */
function flushRate(pending: number, tailMs: number): number {
  return Math.max(MIN_CPS, (pending * 1000) / tailMs)
}

/**
 * Largest cut index at or before `limit` that lands on a word boundary, so a
 * half-written word never paints. Gives up after WORD_LOOKBACK characters:
 * an unbroken run that long is a URL or a code token, and stalling the whole
 * feed on one of those is worse than cutting it.
 */
export function wordBoundary(text: string, limit: number): number {
  const end = Math.min(Math.floor(limit), text.length)
  if (end <= 0) return 0
  if (end >= text.length) return text.length
  const floor = Math.max(0, end - WORD_LOOKBACK)
  for (let i = end; i > floor; i--) {
    const ch = text.charCodeAt(i - 1)
    // \n \r \t space — the breaks markdown and the line breaker both respect.
    if (ch === 32 || ch === 10 || ch === 13 || ch === 9) return i
  }
  return end
}

/**
 * Rewrites the feed for display: the first part that still has text in the
 * buffer is sliced back to what has been revealed, and everything the model
 * produced after it is withheld until it lands.
 *
 * Item identity is preserved for everything left untouched, and the input
 * array is returned as-is when nothing is draining — TranscriptList compares
 * its items by reference (`sameItems`), so allocating a fresh array per frame
 * would re-render the entire transcript on every tick.
 */
export function applyReveal(items: TranscriptItem[], counts: RevealCounts): TranscriptItem[] {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.kind !== 'text' && it.kind !== 'reasoning') continue
    const revealed = counts[it.id]
    if (revealed === undefined || revealed >= it.text.length) continue
    const cut = wordBoundary(it.text, revealed)
    const out = items.slice(0, i + 1)
    // `streaming: true` keeps the caret blinking and the thought shimmering
    // through the tail, after the stream itself has already closed.
    out[i] = { ...it, text: sliceWellFormed(it.text, cut), streaming: true }
    return out
  }
  return items
}

let reduceMotionQuery: MediaQueryList | null | undefined

function prefersReducedMotion(): boolean {
  if (reduceMotionQuery === undefined) {
    reduceMotionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
  }
  return reduceMotionQuery?.matches === true
}

/**
 * The buffer itself. One instance per panel, scoped to whichever chat is on
 * screen — switching chats drops every entry, because text the user was never
 * watching has no reveal to finish.
 */
export class RevealBuffer {
  private entries = new Map<string, Entry>()
  private scope = ''
  private lastTick = 0
  private snapshot: RevealCounts = {}
  private snapshotStale = true
  /** Item count at the last observe: a drop means a rewind pruned the branch. */
  private lastCount = 0

  /**
   * Fold the on-screen transcript in. New parts start at zero if they are
   * still streaming and fully revealed if they are not, so history loads and
   * interrupted turns paint instantly.
   *
   * Returns true when a redraw is warranted.
   */
  observe(chatId: string, items: TranscriptItem[]): boolean {
    let changed = false
    if (chatId !== this.scope) {
      this.scope = chatId
      changed = this.entries.size > 0
      this.entries.clear()
      this.snapshotStale = true
      this.lastCount = 0
    }
    const shrank = items.length < this.lastCount
    this.lastCount = items.length

    if (prefersReducedMotion()) {
      if (this.entries.size === 0) return changed
      this.entries.clear()
      this.snapshotStale = true
      return true
    }

    let draining = -1
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!
      if (it.kind !== 'text' && it.kind !== 'reasoning') continue
      let entry = this.entries.get(it.id)
      if (!entry) {
        // A part first seen already closed (history, a rewind, a turn that
        // ended while the panel was hidden) has nothing to reveal.
        if (!it.streaming) continue
        entry = {
          received: it.text.length,
          revealed: 0,
          ended: false,
          pressured: false,
          tailMs: it.kind === 'reasoning' ? REASONING_TAIL_MS : TEXT_TAIL_MS,
        }
        this.entries.set(it.id, entry)
        this.snapshotStale = true
        changed = true
      } else {
        entry.received = it.text.length
        if (!it.streaming && !entry.ended) {
          entry.ended = true
          entry.flushCps = flushRate(entry.received - entry.revealed, entry.tailMs)
        }
      }
      if (draining === -1 && entry.revealed < entry.received) draining = i
    }

    // Anything after the draining part is queued behind it: shorten the tail
    // so a long multi-step turn doesn't accumulate half a second per step.
    if (draining !== -1 && draining < items.length - 1) {
      const it = items[draining]!
      const entry = this.entries.get(it.id)
      if (entry && !entry.pressured) {
        entry.pressured = true
        entry.tailMs = Math.min(entry.tailMs, PRESSURE_TAIL_MS)
        if (entry.ended) entry.flushCps = flushRate(entry.received - entry.revealed, entry.tailMs)
        changed = true
      }
    }

    // Entries whose item is gone (rewind, delete, branch switch) would gate
    // the feed on text that no longer exists. Only a shrinking transcript can
    // orphan one, and checking costs a set of every id — so check only then.
    if (shrank && this.entries.size > 0) {
      const live = new Set<string>()
      for (const it of items) if (it.kind === 'text' || it.kind === 'reasoning') live.add(it.id)
      for (const id of this.entries.keys()) {
        if (!live.has(id)) {
          this.entries.delete(id)
          this.snapshotStale = true
          changed = true
        }
      }
    }
    return changed
  }

  /** True while some part still owes the user characters. */
  draining(): boolean {
    for (const entry of this.entries.values()) if (entry.revealed < entry.received) return true
    return false
  }

  /** Advance every entry to `now`. Returns true when a redraw is warranted. */
  tick(now: number): boolean {
    const dt = Math.min(now - this.lastTick, MAX_DT_MS) / 1000
    this.lastTick = now
    if (dt <= 0) return false
    let changed = false
    for (const [id, entry] of this.entries) {
      if (entry.revealed >= entry.received) {
        // Finished AND closed: forget it, so the map stays two entries deep
        // and `applyReveal` stops paying attention to it.
        if (entry.ended) {
          this.entries.delete(id)
          changed = true
        }
        continue
      }
      const before = Math.floor(entry.revealed)
      entry.revealed = Math.min(entry.received, entry.revealed + revealCps(entry) * dt)
      if (Math.floor(entry.revealed) !== before) changed = true
    }
    if (changed) this.snapshotStale = true
    return changed
  }

  /** Give up the reserve and show everything now (Stop, chat switch, hidden panel). */
  snapAll(): boolean {
    if (this.entries.size === 0) return false
    this.entries.clear()
    this.snapshotStale = true
    return true
  }

  /** Immutable counts for the store. Reused between ticks that changed nothing. */
  counts(): RevealCounts {
    if (!this.snapshotStale) return this.snapshot
    const out: RevealCounts = {}
    for (const [id, entry] of this.entries) out[id] = Math.floor(entry.revealed)
    this.snapshot = out
    this.snapshotStale = false
    return out
  }

  /** Reset the frame clock so a resumed panel doesn't bill one giant delta. */
  resync(now: number): void {
    this.lastTick = now
  }
}
