/**
 * Ambient loops that never restart.
 *
 * A CSS animation begins at its first keyframe whenever its element is
 * created. For ambient loops that is exactly wrong: the Thinking row's ring
 * hands over to the step that replaces it, a shimmering label is re-created
 * when its text changes phase, a subagent card swaps its activity line — and
 * every one of those visibly restarted its loop mid-breath. Locked to one
 * clock, a new element picks up where the old one was: the ring keeps
 * breathing across the handoff, the shimmer keeps sweeping.
 *
 * Mechanism: when a listed animation starts, shift its element's
 * animation-delay back by (now mod period), keeping any authored delay (a
 * stagger). Every instance then shares the phase "page time mod period".
 * `animationstart` is dispatched before the frame paints, so the corrected
 * phase is the first one on screen.
 */

/** Loops worth locking: ambient, infinite, and re-created as content changes. */
const LOCKED = new Set(['shine', 'step-breathe', 'caret-breathe', 'spin', 'rate-limit-pulse', 'card-breathe'])

function ms(value: string): number {
  const n = parseFloat(value)
  if (!Number.isFinite(n)) return 0
  return value.trim().endsWith('ms') ? n : n * 1000
}

/** The duration and authored delay of `name` among the element's animations. */
function timing(el: Element, name: string): { period: number; delay: number } | undefined {
  const style = getComputedStyle(el)
  const names = style.animationName.split(',').map((s) => s.trim())
  const index = Math.max(0, names.indexOf(name))
  const durations = style.animationDuration.split(',')
  const delays = style.animationDelay.split(',')
  const period = ms(durations[index % durations.length] ?? '0s')
  if (period <= 0) return undefined
  return { period, delay: ms(delays[index % delays.length] ?? '0s') }
}

export function installPhaseLock(doc: Document = document): () => void {
  const onStart = (e: AnimationEvent): void => {
    if (!LOCKED.has(e.animationName)) return
    const el = e.target
    if (!(el instanceof HTMLElement)) return
    const t = timing(el, e.animationName)
    if (!t) return
    // The authored delay is read once, before our inline delay shadows it, so
    // a loop that restarts on the same element (a class toggled back on) is
    // re-locked from the original stagger rather than compounding shifts.
    const authored = el.dataset.phaseDelay !== undefined ? Number(el.dataset.phaseDelay) : t.delay
    el.dataset.phaseDelay = String(authored)
    el.style.animationDelay = `${Math.round(authored - (performance.now() % t.period))}ms`
  }
  doc.addEventListener('animationstart', onStart, true)
  return () => doc.removeEventListener('animationstart', onStart, true)
}
