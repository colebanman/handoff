/**
 * The activity timeline: how the feed shows the agent working.
 *
 * One block per run of tool calls and thinking between two pieces of prose:
 *
 *   Working for 12s ›                          header for multiple tools or mixed thinking/tools
 *   ◌  Reading the syllabus    syllabus.pdf    one row per step, icon on a faint rail
 *   ↖  Clicked 3 elements      “Courses”, …    similar finished steps fold together
 *   ◇  Checking the due dates                  thinking, by its headline
 *   ○  Thinking                                any pause: the model is between steps
 *
 * Live, a block shows its newest rows in a bottom-anchored window; finished,
 * it folds to "Worked for 42s". A lone tool call stays open —
 * that one row is the most informative line of the turn.
 *
 * Motion (motion/react with the domAnimation bundle only):
 * - rows enter by growing from zero height with a trailing fade, so arrivals
 *   ease the rows above upward instead of shoving them a line at a time;
 * - a label that changes PHASE ("Reading" → "Read", "Thinking" → the intent,
 *   "Clicked 2" → "Clicked 3") crossfades in place; streamed deltas never
 *   animate, they only grow text where it stands;
 * - the step that ends a pause takes over the Thinking row's slot and fades
 *   its label in over "Thinking" — no second row, and no height change beyond
 *   finishing the Thinking row's own grow if it was still easing in;
 * - one busy indicator for "writing" and "running", so a step changes its
 *   icon exactly once, when it finishes; ambient loops are phase-locked
 *   (phase-lock.ts), so the ring keeps breathing through the handoff;
 * - reduced motion: every transition resolves instantly.
 *
 * Bodies (tool input/output, a thought's full text) come from `renderers`, so
 * this module never imports items.tsx.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, LazyMotion, domAnimation, m, type Transition } from 'motion/react'
import { useReducedMotion } from '../hooks/useReducedMotion'
import {
  blockSpan,
  buildUnits,
  failedCount,
  formatElapsed,
  toolCount,
  workedFor,
  type ActivityItem,
  type ActivityUnit,
  type ReasoningItem,
  type ToolItem,
} from '../activity'
import {
  clusterDetail,
  clusterLabel,
  describeStep,
  isVerboseReasoning,
  stepState,
  thoughtLabel,
  thoughtLabelKey,
  THINKING,
  type StepIconName,
  type StepState,
  type StepView,
} from '../tool-labels'
import { fmtDuration } from '../format-duration'
import { StepChevron, StepIcon } from './StepIcons'
import { activityDisclosure, thoughtDisclosure } from './activity-disclosure'

export interface ActivityRenderers {
  /** Expanded input/output of one tool call. */
  ToolBody: React.ComponentType<{ item: ToolItem; onOpenFile?: (path: string) => void }>
  /** A thought's full text. */
  Markdown: React.ComponentType<{ text: string }>
}

/* ---- motion ----------------------------------------------------------- */

const EASE_SMOOTH: [number, number, number, number] = [0.2, 0.7, 0.2, 1]
const EASE_OUT_QUINT: [number, number, number, number] = [0.16, 1, 0.3, 1]
const INSTANT: Transition = { duration: 0 }

/** Height leads, opacity trails, so text never flashes over a half-open row. */
const GROW: Transition = {
  height: { duration: 0.2, ease: EASE_SMOOTH },
  opacity: { duration: 0.16, ease: 'linear', delay: 0.03 },
}
/** Same height curve as GROW: a row folding away while another grows in
 * (a cluster absorbing a step as the Thinking row arrives) sums to a
 * constant height, so the rows around them hold still. */
const SHRINK: Transition = {
  height: { duration: 0.2, ease: EASE_SMOOTH },
  opacity: { duration: 0.1, ease: 'linear' },
}
const FADE_OUT: Transition = { duration: 0.1, ease: 'linear' }
/**
 * A text swap is a brief dip, not a blend: the old text is gone in 90ms and
 * the new one starts rising at 50ms, so two different sentences never sit
 * superimposed at half opacity for long (that reads as smudge, not motion).
 */
const SWAP_IN: Transition = { duration: 0.16, ease: 'linear', delay: 0.05 }
const SWAP_OUT: Transition = { duration: 0.09, ease: [0.215, 0.61, 0.355, 1] }

/** Enter/exit for anything that joins or leaves the flow of rows. */
function presence(reduce: boolean) {
  return {
    initial: { height: 0, opacity: 0 },
    animate: { height: 'auto', opacity: 1, transition: reduce ? INSTANT : GROW },
    exit: { height: 0, opacity: 0, transition: reduce ? INSTANT : SHRINK },
  }
}

/* ---- small pieces ----------------------------------------------------- */

/** Wall clock that ticks every `intervalMs` while non-null (for live elapsed times). */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (intervalMs === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/**
 * Content that crossfades when `swapKey` changes and holds still otherwise,
 * so a phase change animates and a streamed delta doesn't. A step row swaps
 * its whole line (label + detail) as one piece: the outgoing line pops out of
 * flow exactly where it stood, so nothing inside it shifts mid-fade. `ghost`
 * is a label to fade out over the line as it mounts — the "Thinking" of the
 * pause row this one took over.
 */
function Swap({
  swapKey,
  className,
  shine,
  ghost,
  children,
}: {
  swapKey: string
  className: string
  shine?: boolean
  ghost?: string
  children: React.ReactNode
}): React.ReactElement {
  const reduce = !!useReducedMotion()
  const [fadeFrom, setFadeFrom] = useState(ghost)
  const [fadeIn] = useState(ghost !== undefined)
  return (
    <span className={`swap ${className}`}>
      <AnimatePresence mode="popLayout" initial={fadeIn}>
        <m.span
          key={swapKey}
          className={`swap__item${shine ? ' shine' : ''}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: reduce ? INSTANT : SWAP_IN }}
          exit={{ opacity: 0, transition: reduce ? INSTANT : SWAP_OUT }}
        >
          {children}
        </m.span>
      </AnimatePresence>
      {fadeFrom !== undefined ? (
        <m.span
          className="swap__ghost"
          aria-hidden="true"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0, transition: reduce ? INSTANT : SWAP_OUT }}
          onAnimationComplete={() => setFadeFrom(undefined)}
        >
          <span className="step__label shine">{fadeFrom}</span>
        </m.span>
      ) : null}
    </span>
  )
}

type IconState = StepState | 'pending'

/**
 * The status slot: a breathing ring while anything is in progress (a pause,
 * streamed arguments, thinking, a running tool), the step's own glyph once
 * it's done. Writing and executing share the ring on purpose: a fast tool
 * would otherwise flash a spinner for 100ms between the two, and every
 * swap reads as a reset.
 */
function StatusIcon({ state, icon }: { state: IconState; icon: StepIconName }): React.ReactElement {
  const reduce = !!useReducedMotion()
  const key = state === 'pending' || state === 'drafting' || state === 'running' ? 'busy' : icon
  return (
    <span className="step__icon">
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span
          key={key}
          className="step__glyph"
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1, transition: reduce ? INSTANT : { duration: 0.2, ease: EASE_OUT_QUINT } }}
          exit={{ opacity: 0, transition: reduce ? INSTANT : FADE_OUT }}
        >
          {key === 'busy' ? (
            <span className="step__pulse" {...(state === 'running' ? { role: 'status', 'aria-label': 'running' } : {})} />
          ) : (
            <StepIcon name={icon} />
          )}
        </m.span>
      </AnimatePresence>
    </span>
  )
}

/**
 * A row's header line. Always a <button> — disabled while there is nothing
 * behind it — never a <div> that becomes a button: swapping the element type
 * when a row turns expandable (a thought's body starts after its headline, a
 * step's intent arrives) remounted everything inside it, replaying the
 * label's fade mid-stream.
 */
function Head({
  expandable,
  open,
  title,
  onToggle,
  children,
}: {
  expandable: boolean
  open: boolean
  title?: string
  onToggle: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      className="step__head"
      disabled={!expandable}
      onClick={expandable ? onToggle : undefined}
      aria-expanded={expandable ? open : undefined}
      title={title}
    >
      {children}
    </button>
  )
}

function Body({ children }: { children: React.ReactNode }): React.ReactElement {
  const reduce = !!useReducedMotion()
  return (
    <m.div key="body" className="step__body" {...presence(reduce)}>
      {children}
    </m.div>
  )
}

/** Seconds a busy step has been going, once that's worth saying (2s+). */
function useBusyElapsed(since: number | undefined): string {
  const now = useNow(since === undefined ? null : 1000)
  if (since === undefined) return ''
  const ms = now - since
  return ms >= 2000 ? formatElapsed(ms) : ''
}

/* ---- rows ------------------------------------------------------------- */

type StepUnit = Extract<ActivityUnit, { kind: 'step' | 'cluster' }>

function clusterView(unit: Extract<ActivityUnit, { kind: 'cluster' }>): StepView {
  const views = unit.items.map((it) => describeStep(it, 'done'))
  return {
    icon: views[0]!.icon,
    label: clusterLabel(unit.family, unit.items),
    detail: clusterDetail(views),
    mono: views.every((v) => v.mono),
    title: views.map((v) => [v.label, v.detail].filter(Boolean).join(' ')).join('\n'),
  }
}

function sameStepUnit(a: StepUnit, b: StepUnit): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false
  if (a.kind === 'step' && b.kind === 'step') return a.item === b.item
  if (a.kind === 'cluster' && b.kind === 'cluster') return sameList(a.items, b.items)
  return false
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

interface StepRowProps {
  unit: StepUnit
  /** This row ends a pause: the Thinking row's height at that moment (px). */
  takeover?: number
  nested?: boolean
  renderers: ActivityRenderers
  onOpenFile?: (path: string) => void
  /** Opening a body keeps its parent expanded, including after completion. */
  onExpand?: () => void
}

const StepRow = memo(
  function StepRow({ unit, takeover, nested, renderers, onOpenFile, onExpand }: StepRowProps): React.ReactElement {
    const reduce = !!useReducedMotion()
    const [takeoverFrom] = useState(takeover)
    const fromThinking = takeoverFrom !== undefined
    const [open, setOpen] = useState(false)
    const cluster = unit.kind === 'cluster'
    const item = cluster ? unit.items[unit.items.length - 1]! : unit.item
    const state: StepState = cluster ? 'done' : stepState(unit.item)
    const view = cluster ? clusterView(unit) : describeStep(unit.item, state)
    const busy = state === 'drafting' || state === 'running'
    const swapKey = view.placeholder
      ? 'thinking'
      : cluster
        ? `cluster:${unit.items.length}`
        : busy
          ? view.fromIntent ? 'intent' : `live:${view.label}`
          : state
    const [detailAtMount] = useState(!!view.detail)
    const elapsed = useBusyElapsed(busy ? item.at : undefined)
    const expandable = !view.placeholder
    const motionProps = presence(reduce)

    return (
      <m.div
        className={`step step--${state}${cluster ? ' step--cluster' : ''}${nested ? ' step--nested' : ''}${open ? ' step--open' : ''}`}
        initial={fromThinking ? { height: takeoverFrom, opacity: 1 } : motionProps.initial}
        animate={motionProps.animate}
        exit={motionProps.exit}
      >
        <Head
          expandable={expandable}
          open={open}
          title={view.title ?? [view.label, view.detail].filter(Boolean).join(' · ')}
          onToggle={() => {
            if (!open) onExpand?.()
            setOpen((o) => !o)
          }}
        >
          <StatusIcon state={state} icon={view.icon} />
          <span className="step__text">
            <Swap swapKey={swapKey} className="step__line" ghost={fromThinking && swapKey !== 'thinking' ? THINKING : undefined}>
              <span className={`step__label${busy ? ' shine' : ''}`}>{view.placeholder ? THINKING : view.label}</span>
              {view.detail ? (
                // Targets streaming in within a phase just appear (a short
                // fade if the row was already there); a phase change
                // crossfades them with the label.
                <span
                  className={`step__detail${view.mono ? ' step__detail--mono' : ''}${state === 'error' ? ' step__detail--error' : ''}${detailAtMount ? '' : ' step__detail--late'}`}
                >
                  {view.detail}
                </span>
              ) : null}
            </Swap>
          </span>
          {elapsed ? <span className="step__elapsed">{elapsed}</span> : null}
          {expandable ? (
            <span className="step__meta" aria-hidden="true">
              {!busy && !cluster && item.durationMs !== undefined ? (
                <span className="step__time">{fmtDuration(item.durationMs)}</span>
              ) : null}
              <StepChevron />
            </span>
          ) : null}
        </Head>
        <AnimatePresence initial={false}>
          {open ? (
            <Body key="body">
              {cluster ? (
                <div className="step__children">
                  {unit.items.map((child) => (
                    <StepRow
                      key={child.id}
                      unit={{ kind: 'step', key: child.id, item: child }}
                      nested
                      renderers={renderers}
                      onOpenFile={onOpenFile}
                    />
                  ))}
                </div>
              ) : (
                <renderers.ToolBody item={unit.item} onOpenFile={onOpenFile} />
              )}
            </Body>
          ) : null}
        </AnimatePresence>
      </m.div>
    )
  },
  (prev, next) =>
    prev.takeover === next.takeover &&
    prev.nested === next.nested &&
    prev.renderers === next.renderers &&
    prev.onOpenFile === next.onOpenFile &&
    prev.onExpand === next.onExpand &&
    sameStepUnit(prev.unit, next.unit),
)

interface ThoughtRowProps {
  items: ReasoningItem[]
  /** Keep prose summaries visible through tool work, until the answer begins. */
  live: boolean
  /** This row ends a pause: the Thinking row's height at that moment (px). */
  takeover?: number
  renderers: ActivityRenderers
  onExpand?: () => void
}

const ThoughtRow = memo(
  function ThoughtRow({ items, live, takeover, renderers, onExpand }: ThoughtRowProps): React.ReactElement {
    const reduce = !!useReducedMotion()
    const [takeoverFrom] = useState(takeover)
    const fromThinking = takeoverFrom !== undefined
    // null follows the block's lifecycle. A click persists across streaming,
    // tool execution, and completion; loading saved history starts collapsed.
    const [manual, setManual] = useState<boolean | null>(null)
    // Adjacent summary parts are one thought: texts joined, durations summed.
    const text = items.map((r) => r.text.trim()).filter(Boolean).join('\n\n')
    const { open, automatic } = thoughtDisclosure(isVerboseReasoning(text), live, manual)
    const streaming = items[items.length - 1]!.streaming
    const durations = items.map((r) => r.durationMs).filter((d): d is number => d !== undefined)
    const durationMs = durations.length ? durations.reduce((a, b) => a + b, 0) : undefined
    const { label, placeholder, more } = thoughtLabel(text, streaming, durationMs)
    // Each new headline / sentence is new context: it crossfades in.
    const swapKey = placeholder ? 'thinking' : thoughtLabelKey(text, label)
    const motionProps = presence(reduce)
    return (
      <m.div
        className={`step step--thought step--${streaming ? 'drafting' : 'done'}${open ? ' step--open' : ''}`}
        initial={fromThinking ? { height: takeoverFrom, opacity: 1 } : motionProps.initial}
        animate={motionProps.animate}
        exit={motionProps.exit}
      >
        <Head expandable={more} open={open} title={placeholder ? undefined : label} onToggle={() => {
          if (!open) onExpand?.()
          setManual(!open)
        }}>
          <StatusIcon state={streaming ? 'drafting' : 'done'} icon="thought" />
          <span className="step__text">
            <Swap swapKey={swapKey} className="step__line" ghost={fromThinking && !placeholder ? THINKING : undefined}>
              <span className={`step__label${streaming ? ' shine' : ''}`}>{label}</span>
            </Swap>
          </span>
          {more ? (
            <span className="step__meta" aria-hidden="true">
              {!streaming && durationMs ? <span className="step__time">{fmtDuration(durationMs)}</span> : null}
              <StepChevron />
            </span>
          ) : null}
        </Head>
        <AnimatePresence initial={false}>
          {open && more ? (
            <Body key="body">
              <div
                className={`step__thought reasoning-body reasoning-body--md${automatic ? ' step__thought--preview' : ''}`}
                tabIndex={automatic ? 0 : undefined}
                role={automatic ? 'region' : undefined}
                aria-label={automatic ? 'Reasoning summary' : undefined}
              >
                <renderers.Markdown text={text} />
              </div>
            </Body>
          ) : null}
        </AnimatePresence>
      </m.div>
    )
  },
  (prev, next) => prev.live === next.live && prev.takeover === next.takeover && prev.renderers === next.renderers && prev.onExpand === next.onExpand && sameList(prev.items, next.items),
)

/**
 * The pause row. Leaves by growing out of the flow — unless a step took over
 * its slot (AnimatePresence `custom` = true), in which case it vanishes in the
 * same frame the step appears where it was.
 */
function PendingRow({ rowRef }: { rowRef: React.Ref<HTMLDivElement> }): React.ReactElement {
  const reduce = !!useReducedMotion()
  const motionProps = presence(reduce)
  return (
    <m.div
      ref={rowRef}
      className="step step--pending"
      role="status"
      aria-live="polite"
      initial={motionProps.initial}
      animate={motionProps.animate}
      exit="gone"
      variants={{
        gone: (takenOver: boolean) =>
          takenOver ? { opacity: 0, height: 0, transition: INSTANT } : motionProps.exit,
      }}
    >
      <button type="button" className="step__head" disabled>
        <StatusIcon state="pending" icon="thought" />
        <span className="step__text">
          <span className="swap step__line">
            <span className="swap__item">
              <span className="step__label shine">{THINKING}</span>
            </span>
          </span>
        </span>
      </button>
    </m.div>
  )
}

/* ---- header ----------------------------------------------------------- */

function ActivityHeader({
  live,
  open,
  span,
  steps,
  failed,
  onToggle,
}: {
  live: boolean
  open: boolean
  span: { start?: number; end?: number }
  steps: number
  failed: number
  onToggle: () => void
}): React.ReactElement {
  const now = useNow(live ? 1000 : null)
  const elapsed = span.start !== undefined ? now - span.start : 0
  const label = live ? (elapsed >= 1000 ? `Working for ${formatElapsed(elapsed)}` : 'Working') : workedFor(span, steps)
  return (
    <button
      type="button"
      className={`activity__header${open ? ' activity__header--open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
      title={open ? 'Hide activity' : 'Show activity'}
    >
      <Swap swapKey={live ? 'live' : 'done'} className="activity__summary" shine={live}>
        {label}
      </Swap>
      <StepChevron />
      {failed > 0 ? <span className="activity__failed">{failed} failed</span> : null}
    </button>
  )
}

/* ---- block ------------------------------------------------------------ */

export interface ActivityBlockProps {
  items: ActivityItem[]
  /** When what followed this block began (the answer's first word), if known. */
  until?: number
  /** The turn is still working in this block (it's the newest one). */
  live: boolean
  /** The model is between steps right here: show the Thinking row. */
  pending: boolean
  renderers: ActivityRenderers
  onOpenFile?: (path: string) => void
}

export const ActivityBlock = memo(
  function ActivityBlock({ items, until, live, pending, renderers, onOpenFile }: ActivityBlockProps): React.ReactElement {
    const reduce = !!useReducedMotion()
    const units = buildUnits(items, { foldTail: !live || pending })
    const tools = toolCount(items)
    // null = automatic (open while live, folded once done); a click decides after that.
    const [manual, setManual] = useState<boolean | null>(null)
    const { hasHeader, open, capped } = activityDisclosure(items, live, manual)
    const previewingReasoning = capped && units.some((unit) =>
      unit.kind === 'thought' && isVerboseReasoning(unit.items.map((item) => item.text).join('\n\n')))
    // The bottom-anchored window only applies while automatic: a person who
    // opened the block asked to see all of it.
    const expand = useCallback(() => setManual(true), [])

    // Ending a pause: the first unit that wasn't on screen when the Thinking
    // row was takes over its slot, starting from however far that row had
    // grown in (it may still have been easing open).
    const pendingShown = useRef(false)
    const pendingRef = useRef<HTMLDivElement>(null)
    const knownKeys = useRef<Set<string> | null>(null)
    const known = knownKeys.current
    const takeoverKey = pendingShown.current && !pending && known ? units.find((u) => !known.has(u.key))?.key : undefined
    const takeoverFrom = takeoverKey !== undefined ? (pendingRef.current?.getBoundingClientRect().height ?? 0) : undefined
    useLayoutEffect(() => {
      pendingShown.current = pending && open
      knownKeys.current = new Set(units.map((u) => u.key))
    })

    // Fade the window's top edge only once rows actually scroll under it.
    const viewportRef = useRef<HTMLDivElement>(null)
    const [masked, setMasked] = useState(false)
    useLayoutEffect(() => {
      const el = viewportRef.current
      if (!capped || !el) {
        setMasked(false)
        return
      }
      const measure = (): void => setMasked(el.scrollHeight - el.clientHeight > 2)
      measure()
      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(measure)
      observer.observe(el)
      if (el.firstElementChild) observer.observe(el.firstElementChild)
      return () => observer.disconnect()
    }, [capped, open])

    const span = blockSpan(items, until)
    const motionProps = presence(reduce)
    return (
      <LazyMotion features={domAnimation}>
        <m.div
          className={`activity${live ? ' activity--live' : ''}${previewingReasoning ? ' activity--reasoning-preview' : ''}`}
          // A block born mid-turn grows in; history (and a block that simply
          // re-renders) appears as-is.
          initial={live ? motionProps.initial : false}
          animate={motionProps.animate}
        >
          <AnimatePresence initial={false}>
            {hasHeader ? (
              <m.div key="header" className="activity__head" {...motionProps}>
                <ActivityHeader
                  live={live}
                  open={open}
                  span={span}
                  steps={tools}
                  failed={failedCount(items)}
                  onToggle={() => setManual(!open)}
                />
              </m.div>
            ) : null}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {open ? (
              <m.div key="body" className="activity__body" {...motionProps}>
                <div
                  ref={viewportRef}
                  className={`activity__viewport${capped ? ' activity__viewport--capped' : ''}${masked ? ' activity__viewport--masked' : ''}`}
                >
                  <div className="activity__track">
                    <AnimatePresence initial={false} custom={takeoverKey !== undefined}>
                      {units.map((u) =>
                        u.kind === 'thought' ? (
                          <ThoughtRow key={u.key} items={u.items} live={live} takeover={u.key === takeoverKey ? takeoverFrom : undefined} renderers={renderers} onExpand={expand} />
                        ) : (
                          <StepRow
                            key={u.key}
                            unit={u}
                            takeover={u.key === takeoverKey ? takeoverFrom : undefined}
                            renderers={renderers}
                            onOpenFile={onOpenFile}
                            onExpand={expand}
                          />
                        ),
                      )}
                      {pending ? <PendingRow key="pending" rowRef={pendingRef} /> : null}
                    </AnimatePresence>
                  </div>
                </div>
              </m.div>
            ) : null}
          </AnimatePresence>
        </m.div>
      </LazyMotion>
    )
  },
  (prev, next) =>
    prev.live === next.live &&
    prev.pending === next.pending &&
    prev.until === next.until &&
    prev.renderers === next.renderers &&
    prev.onOpenFile === next.onOpenFile &&
    sameList(prev.items, next.items),
)
