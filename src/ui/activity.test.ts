import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../shared/types'
import { blockSpan, buildUnits, isAwaitingModel, workedFor, type ActivityItem, type ToolItem } from './activity'

let n = 0
const tool = (toolName: string, status: ToolItem['status'] = 'done', extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool', id: `t${++n}`, agentId: 'main', toolName, inputText: '', status, at: 1000, ...extra,
})
const thought = (text: string, streaming = false): ActivityItem => ({ kind: 'reasoning', id: `r${++n}`, agentId: 'main', text, streaming })
const click = (name: string, status: ToolItem['status'] = 'done'): ToolItem =>
  tool('browser_click', status, { input: { __target: { role: 'button', name } } })

describe('buildUnits', () => {
  it('keeps chronological order and folds consecutive finished steps of one family', () => {
    const a = click('Courses')
    const b = click('COURSE101')
    const c = click('Syllabus')
    const units = buildUnits([a, b, c, tool('browser_snapshot')])
    expect(units.map((u) => u.kind)).toEqual(['cluster', 'step'])
    // The cluster keeps its first member's key, so the row that grew into it stays mounted.
    expect(units[0]).toMatchObject({ kind: 'cluster', key: a.id, family: 'click' })
  })

  it('never folds a running step — it joins the cluster when it finishes', () => {
    const a = click('Courses')
    const running = click('COURSE101', 'running')
    expect(buildUnits([a, running]).map((u) => u.kind)).toEqual(['step', 'step'])
    expect(buildUnits([a, { ...running, status: 'done' }]).map((u) => u.kind)).toEqual(['cluster'])
  })

  it('lets thinking break a run and merges adjacent thinking parts', () => {
    const units = buildUnits([click('A'), thought('**One**'), thought('**Two**'), click('B')])
    expect(units.map((u) => u.kind)).toEqual(['step', 'thought', 'step'])
    expect(units[1]).toMatchObject({ kind: 'thought' })
    expect(units[1]!.kind === 'thought' && units[1]!.items).toHaveLength(2)
  })

  it('keeps failed steps visible on their own', () => {
    const failed = tool('browser_click', 'error', { output: 'Error: detached' })
    expect(buildUnits([click('A'), failed, click('B')]).map((u) => u.kind)).toEqual(['step', 'step', 'step'])
  })

  it('does not fold code steps that carry their own intent', () => {
    const run = (intent: string): ToolItem => tool('sandbox_exec', 'done', { input: { intent, code: "await api.fetch('https://a.edu/x')" } })
    expect(buildUnits([run('Reading modules'), run('Reading pages')]).map((u) => u.kind)).toEqual(['step', 'step'])
    const bare = (): ToolItem => tool('sandbox_exec', 'done', { input: { code: "await api.fetch('https://a.edu/x')" } })
    expect(buildUnits([bare(), bare()]).map((u) => u.kind)).toEqual(['cluster'])
  })
})

describe('isAwaitingModel', () => {
  const user: TranscriptItem = { kind: 'user', id: 'u', text: 'hi', at: 0 }
  it('is a pause when the turn runs and nothing is progressing', () => {
    expect(isAwaitingModel([user], true)).toBe(true)
    expect(isAwaitingModel([user, tool('browser_click')], true)).toBe(true)
    expect(isAwaitingModel([user, tool('browser_click')], false)).toBe(false)
  })
  it('is not a pause while a tool runs, a thought streams, or prose is being written', () => {
    expect(isAwaitingModel([user, tool('browser_click', 'running')], true)).toBe(false)
    expect(isAwaitingModel([user, thought('', true)], true)).toBe(false)
    expect(isAwaitingModel([user, { kind: 'text', id: 'x', agentId: 'main', text: 'Here', streaming: true }], true)).toBe(false)
  })
  it('treats prose that has not produced a word yet as a pause', () => {
    expect(isAwaitingModel([user, { kind: 'text', id: 'x', agentId: 'main', text: '', streaming: true }], true)).toBe(true)
  })
})

describe('timing', () => {
  it('spans from the first step starting to the last result arriving', () => {
    const items: ActivityItem[] = [
      { kind: 'reasoning', id: 'r', agentId: 'main', text: '', streaming: false, at: 1_000, durationMs: 2_000 },
      tool('browser_click', 'done', { at: 3_500, endedAt: 4_000 }),
      tool('browser_snapshot', 'done', { at: 5_000, durationMs: 40_000 }),
    ]
    expect(blockSpan(items)).toEqual({ start: 1_000, end: 45_000 })
    expect(workedFor(blockSpan(items), 2)).toBe('Worked for 44s')
  })
  it('formats long runs and falls back to a step count without timestamps', () => {
    expect(workedFor({ start: 0, end: 125_000 }, 3)).toBe('Worked for 2m 5s')
    expect(workedFor({ start: 0, end: 400 }, 3)).toBe('Worked for under a second')
    expect(workedFor({}, 3)).toBe('Took 3 steps')
  })
})
