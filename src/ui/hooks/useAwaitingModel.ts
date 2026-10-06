/**
 * When the feed should show its Thinking row: the turn is running and nothing
 * on screen is progressing (see `isAwaitingModel`).
 *
 * Right after the user sends, it shows at once — that's the one pause the
 * user is watching for. Mid-turn it waits a beat first, so a step that
 * follows within a couple of frames doesn't flash a Thinking row — and a
 * longer one after finished prose, which is nearly always the answer with
 * the turn about to end (a 40ms Thinking row under every reply is flicker,
 * not information). It hides the instant anything moves.
 */
import { useEffect, useState } from 'react'
import type { TranscriptItem } from '../../shared/types'
import { isAwaitingModel } from '../activity'

const PAUSE_BEAT_MS = 160
const AFTER_PROSE_BEAT_MS = 700

/** No output yet this turn: the newest item (past undelivered steering) is the user's. */
function turnJustStarted(items: readonly TranscriptItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === 'user' && it.pending) continue
    return it.kind === 'user'
  }
  return true
}

/** The newest visible output is prose that has finished streaming. */
function afterProse(items: readonly TranscriptItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if ((it.kind === 'user' && it.pending) || (it.kind === 'text' && !it.text.trim())) continue
    return it.kind === 'text'
  }
  return false
}

export function useAwaitingModel(items: readonly TranscriptItem[], running: boolean): boolean {
  const awaiting = isAwaitingModel(items, running)
  const immediate = awaiting && turnJustStarted(items)
  const beat = awaiting && afterProse(items) ? AFTER_PROSE_BEAT_MS : PAUSE_BEAT_MS
  // Readiness belongs to the pause after one output. In particular, a tool's
  // elapsed 160ms wait must not make the next answer's 700ms pause appear at
  // once. Compare during render too, before the effect can retire the timer.
  let anchor = ''
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if ((item.kind === 'user' && item.pending) || (item.kind === 'text' && !item.text.trim())) continue
    anchor = item.id
    break
  }
  const pause = `${anchor}:${beat}`
  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    setSettled(null)
    if (!awaiting || immediate) {
      return
    }
    const timer = setTimeout(() => setSettled(pause), beat)
    return () => clearTimeout(timer)
  }, [awaiting, immediate, beat, pause])
  return awaiting && (immediate || settled === pause)
}
