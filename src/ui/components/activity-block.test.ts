import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../../shared/types'
import { TranscriptList } from './items'

vi.mock('../store', () => ({ openMemoryFile: vi.fn() }))

const user: TranscriptItem = { kind: 'user', id: 'u', text: 'Check my syllabus', at: 0 }
const step = (id: string, extra: Partial<Extract<TranscriptItem, { kind: 'tool' }>>): TranscriptItem => ({
  kind: 'tool', id, agentId: 'main', toolName: 'sandbox_exec', inputText: '', status: 'done', at: 1_000, ...extra,
})

const render = (items: TranscriptItem[], props: { streaming?: boolean; pending?: boolean } = {}): string =>
  renderToStaticMarkup(createElement(TranscriptList, { items, ...props }))

it('shows a streaming intent instead of a preparing placeholder', () => {
  const html = render([user, step('a', { status: 'running', inputStreaming: true, input: { intent: 'Reading the syll' } })], { streaming: true })
  expect(html).toContain('Reading the syll')
  expect(html).not.toMatch(/Preparing|waiting for model/)
})

it('ends the newest block with a Thinking row during a pause', () => {
  const html = render([user, step('a', { input: { intent: 'Reading the syllabus' } })], { streaming: true, pending: true })
  expect(html).toContain('Read the syllabus')
  expect(html).toContain('step--pending')
  expect(html.indexOf('Read the syllabus')).toBeLessThan(html.indexOf('step--pending'))
})

it('opens a Thinking row right after the user message and after prose', () => {
  expect(render([user], { streaming: true, pending: true })).toContain('step--pending')
  const afterProse = render(
    [user, { kind: 'text', id: 'x', agentId: 'main', text: 'I’ll check the slides next.', streaming: false }],
    { streaming: true, pending: true },
  )
  expect(afterProse.indexOf('slides next')).toBeLessThan(afterProse.indexOf('step--pending'))
})

it('keeps undelivered steering after the Thinking row', () => {
  const html = render(
    [user, step('a', {}), { kind: 'user', id: 'pending-steering', text: 'also check grades', at: 2, pending: true, steered: true }],
    { streaming: true, pending: true },
  )
  expect(html.indexOf('step--pending')).toBeLessThan(html.indexOf('also check grades'))
})

it('folds a finished multi-step run into "Worked for" and leaves one-step runs open', () => {
  const run = [
    user,
    step('a', { input: { intent: 'Reading the syllabus' }, at: 1_000, endedAt: 2_000 }),
    step('b', { input: { intent: 'Checking due dates' }, at: 2_500, endedAt: 13_000 }),
    { kind: 'text', id: 'x', agentId: 'main', text: 'Done.', streaming: false } as TranscriptItem,
  ]
  const folded = render(run)
  expect(folded).toContain('Worked for 12s')
  expect(folded).not.toContain('Checked due dates')

  const single = render([user, step('a', { input: { intent: 'Reading the syllabus' } }), run[3]!])
  expect(single).toContain('Read the syllabus')
  expect(single).not.toContain('Worked for')
})

it('keeps a live run open under a ticking header', () => {
  const html = render(
    [user, step('a', { input: { intent: 'Reading the syllabus' } }), step('b', { status: 'running', input: { intent: 'Checking due dates' } })],
    { streaming: true },
  )
  expect(html).toContain('Working')
  expect(html).toContain('Checking due dates')
  expect(html).toContain('aria-label="running"')
})

it('folds a completed reasoning summary plus one tool into the activity header', () => {
  const html = render([
    user,
    { kind: 'reasoning', id: 'r', agentId: 'main', text: '**Checking the evidence**\n\nThe page contains several sections that need to be compared before answering.', streaming: false, at: 1_000, durationMs: 2_000 },
    step('a', { input: { intent: 'Reading the syllabus' }, at: 3_000, endedAt: 4_000 }),
    { kind: 'text', id: 'answer', agentId: 'main', text: 'Done.', streaming: false, at: 4_000 },
  ])
  expect(html).toContain('Worked for 3s')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('Read the syllabus')
  expect(html).not.toContain('reasoning-body')
})

it('leaves headline-style reasoning collapsed by default in both live and saved transcripts', () => {
  for (const streaming of [true, false]) {
    const html = render([
      user,
      { kind: 'reasoning', id: 'r', agentId: 'main', text: '**Comparing the sources**\n\nA long summary that remains available on demand.\n\nAdditional analysis should never open itself as tokens arrive.', streaming },
    ], { streaming })
    expect(html).toContain('Comparing the sources')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('reasoning-body')
    expect(html).not.toContain('Additional analysis')
    expect(html).not.toContain('activity__header')
  }
})

const verboseReasoning = 'I will compare the available sources and inspect their underlying assumptions before giving an answer, including the reported values and how those values were measured. The details should stay readable until the response begins.'

it('opens verbose prose while thinking and collapses it once the answer begins', () => {
  const thought: TranscriptItem = { kind: 'reasoning', id: 'r', agentId: 'main', text: verboseReasoning, streaming: false }
  const live = render([user, thought], { streaming: true })
  expect(live).toContain('step__thought--preview')
  expect(live).toContain('aria-expanded="true"')
  expect(live).toContain('reported values')

  const answering = render([
    user, thought,
    { kind: 'text', id: 'answer', agentId: 'main', text: 'The comparison is ready.', streaming: true },
  ], { streaming: true })
  expect(answering).toContain('aria-expanded="false"')
  expect(answering).not.toContain('reasoning-body')
  expect(answering).not.toContain('reported values')
})

it('keeps prose reasoning open while the following tool executes', () => {
  const html = render([
    user,
    { kind: 'reasoning', id: 'r', agentId: 'main', text: verboseReasoning, streaming: false },
    step('a', { status: 'running', input: { intent: 'Comparing the sources' } }),
  ], { streaming: true })
  expect(html).toContain('activity--reasoning-preview')
  expect(html).toContain('step__thought--preview')
  expect(html).toContain('reported values')
})

it('keeps saved verbose prose collapsed', () => {
  const html = render([
    user,
    { kind: 'reasoning', id: 'r', agentId: 'main', text: verboseReasoning, streaming: false },
  ])
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('reasoning-body')
})
