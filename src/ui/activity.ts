/**
 * The activity timeline's structure, as pure functions over transcript items.
 *
 * A run of tool calls and thinking between two pieces of prose is one
 * activity block. Inside it, order is chronological first; secondarily,
 * consecutive FINISHED steps of one family ("Clicked", "Clicked", "Clicked")
 * fold into a cluster row. A running step never folds — its own label is the
 * live progress — and joins the cluster behind it the moment it finishes.
 *
 * Pauses: whenever the turn is running but nothing on screen is progressing
 * (between a tool result and the model's next step, before the first token),
 * the feed shows a "Thinking" row. `isAwaitingModel` is that condition.
 */
import type { TranscriptItem } from '../shared/types'
import { describeStep, stepState } from './tool-labels'

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
export type ReasoningItem = Extract<TranscriptItem, { kind: 'reasoning' }>
export type ActivityItem = ToolItem | ReasoningItem

export type ActivityUnit =
  | { kind: 'thought'; key: string; items: ReasoningItem[] }
  | { kind: 'step'; key: string; item: ToolItem }
  | { kind: 'cluster'; key: string; family: string; items: ToolItem[] }

/** A plain tool call that joins activity blocks: delegations render as their own cards. */
export function isActivityTool(it: TranscriptItem): it is ToolItem {
  return (
    it.kind === 'tool' &&
    it.toolName !== 'subagent_spawn' &&
    it.toolName !== 'workflow_run' &&
    it.workflow === undefined &&
    it.childItems === undefined &&
    it.childAgentId === undefined
  )
}

/**
 * Render units for a block. Keys are stable across the whole life of a unit:
 * a cluster takes its FIRST member's id, which is the key that member had as
 * a lone step — so the row that becomes a cluster is the same row, and only
 * its label changes.
 *
 * `foldTail: false` keeps a just-finished LAST step out of the cluster above
 * it. Folding removes a row; doing it the instant the step finishes slid the
 * live window down a row, and the Thinking row arriving a beat later slid it
 * back up. Held until something follows (the Thinking row, the next step),
 * the fold and the arrival happen together and the window holds still.
 */
export function buildUnits(items: readonly ActivityItem[], { foldTail = true }: { foldTail?: boolean } = {}): ActivityUnit[] {
  const units: ActivityUnit[] = []
  let familyOfLast: string | undefined
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    const last = units[units.length - 1]
    if (it.kind === 'reasoning') {
      if (last?.kind === 'thought') last.items.push(it)
      else units.push({ kind: 'thought', key: it.id, items: [it] })
      familyOfLast = undefined
      continue
    }
    const family = stepState(it) === 'done' ? describeStep(it, 'done').family : undefined
    const held = !foldTail && i === items.length - 1
    if (family && family === familyOfLast && last && last.kind !== 'thought' && !held) {
      if (last.kind === 'cluster') last.items.push(it)
      else units[units.length - 1] = { kind: 'cluster', key: last.key, family, items: [last.item, it] }
      continue
    }
    units.push({ kind: 'step', key: it.id, item: it })
    familyOfLast = family
  }
  return units
}

export function toolCount(items: readonly ActivityItem[]): number {
  let n = 0
  for (const it of items) if (it.kind === 'tool') n++
  return n
}

export function failedCount(items: readonly ActivityItem[]): number {
  let n = 0
  for (const it of items) if (it.kind === 'tool' && stepState(it) === 'error') n++
  return n
}

/** Something on screen is visibly progressing: a running tool, streaming thought or prose. */
export function isActiveItem(it: TranscriptItem): boolean {
  switch (it.kind) {
    case 'tool':
      return it.status === 'running'
    case 'reasoning':
      return it.streaming
    case 'text':
      return it.streaming && it.text.trim().length > 0
    case 'compaction':
      return it.status === 'running'
    default:
      return false
  }
}

/**
 * The turn is running and nothing is progressing: the model is between steps
 * (or hasn't produced its first token). This is when the Thinking row shows.
 */
export function isAwaitingModel(items: readonly TranscriptItem[], running: boolean): boolean {
  if (!running) return false
  for (const it of items) if (isActiveItem(it)) return false
  return true
}

/**
 * When the block's work began and ended, from item timestamps. `until` is
 * when whatever followed the block began (the answer's first word): the
 * model's last think before answering is work too, and the live header was
 * counting it — without it "Working for 27s" settled as "Worked for 25s".
 */
export function blockSpan(items: readonly ActivityItem[], until?: number): { start?: number; end?: number } {
  let start: number | undefined
  let end: number | undefined
  const see = (from: number | undefined, to: number | undefined): void => {
    if (from !== undefined && (start === undefined || from < start)) start = from
    const last = to ?? from
    if (last !== undefined && (end === undefined || last > end)) end = last
  }
  for (const it of items) {
    if (it.kind === 'tool') see(it.at, it.endedAt ?? (it.durationMs !== undefined ? it.at + it.durationMs : undefined))
    else if (it.at !== undefined) see(it.at, it.durationMs !== undefined ? it.at + it.durationMs : undefined)
  }
  if (until !== undefined && end !== undefined && until > end) end = until
  return { start, end }
}

/** "12s", "2m 5s", "1h 4m": elapsed time at the block header's precision. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

/** The finished block's one-line summary. */
export function workedFor(span: { start?: number; end?: number }, steps: number): string {
  if (span.start === undefined || span.end === undefined) return `Took ${steps} steps`
  const ms = span.end - span.start
  return ms < 1000 ? 'Worked for under a second' : `Worked for ${formatElapsed(ms)}`
}
