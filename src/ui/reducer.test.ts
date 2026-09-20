import { describe, expect, it } from 'vitest'
import type { AgentEvent, TranscriptItem, WorkflowRunSnapshot, TaskInfo } from '../shared/types'
import { applyEvent } from './reducer'

function fold(events: AgentEvent[]): TranscriptItem[] {
  return events.reduce<TranscriptItem[]>((items, event) => applyEvent(items, event), [])
}

describe('subagent terminal state', () => {
  const task: TaskInfo = {
    id: 'task-1', agentId: 'sub-1', chatId: 'chat-1', kind: 'subagent',
    description: 'Inspect syllabus', status: 'error', startedAt: 1, endedAt: 20,
    result: 'Failed to fetch',
  }
  function started() {
    return fold([
      { type: 'tool-call', agentId: 'main', toolCallId: 'spawn', toolName: 'subagent_spawn', input: {} },
      { type: 'agent-start', agentId: 'sub-1', parentToolCallId: 'spawn', modelId: 'test' },
      { type: 'reasoning-start', agentId: 'main', id: 'parent-thought' },
      { type: 'reasoning-start', agentId: 'sub-1', id: 'child-thought' },
      { type: 'reasoning-delta', agentId: 'sub-1', id: 'child-thought', delta: 'Inspecting syllabus files' },
      { type: 'tool-call', agentId: 'sub-1', toolCallId: 'read', toolName: 'sandbox_exec', input: {} },
    ])
  }
  function child(items: TranscriptItem[]) {
    const card = items[0]!
    if (card.kind !== 'tool') throw new Error('missing subagent card')
    return card
  }

  it('settles the failed child and shows its reason even when only the task update arrives', () => {
    const result = applyEvent(started(), { type: 'task-update', task })
    expect(child(result).childStatus).toBe('error')
    expect(child(result).childItems).toEqual([
      expect.objectContaining({ kind: 'reasoning', streaming: false }),
      expect.objectContaining({ kind: 'tool', status: 'error', output: 'Failed to fetch' }),
      expect.objectContaining({ kind: 'error', message: 'Failed to fetch' }),
    ])
    expect(result[1]).toMatchObject({ kind: 'reasoning', streaming: true })
  })

  it.each([true, false])('does not duplicate the error when task and agent events both arrive (task first: %s)', (taskFirst) => {
    const events: AgentEvent[] = [
      { type: 'task-update', task },
      { type: 'agent-error', agentId: 'sub-1', error: 'Failed to fetch' },
    ]
    if (!taskFirst) events.reverse()
    const result = [...events, { type: 'task-update', task } as const].reduce(applyEvent, started())
    expect(child(result).childItems?.filter((item) => item.kind === 'error')).toHaveLength(1)
    expect(child(result).childItems?.find((item) => item.kind === 'reasoning')).toMatchObject({ streaming: false })
  })

  it.each(['done', 'cancelled', 'orphaned'] as const)('settles child activity on %s without manufacturing a failure message', (status) => {
    const result = applyEvent(started(), { type: 'task-update', task: { ...task, status, result: undefined } })
    expect(child(result).childItems?.find((item) => item.kind === 'reasoning')).toMatchObject({ streaming: false })
    expect(child(result).childItems?.some((item) => item.kind === 'error')).toBe(false)
  })

  it('keeps child activity live while cancellation is still pending', () => {
    const result = applyEvent(started(), { type: 'task-update', task: { ...task, status: 'cancelling' } })
    expect(child(result)).toMatchObject({ childStatus: 'running' })
    expect(child(result).childItems?.find((item) => item.kind === 'reasoning')).toMatchObject({ streaming: true })
  })
})

describe('workflow transcript reducer', () => {
  it('keeps workflow children inside one card and preserves drill-down events and totals', () => {
    const startedAt = 100
    const workflow: WorkflowRunSnapshot = {
      runId: 'wf-1',
      meta: {
        title: 'Three-way review',
        description: 'Compare independent reviews.',
        phases: [{ id: 'review', title: 'Review' }],
      },
      sourcePath: '/workspace/workflows/three-way-review.js',
      status: 'running',
      startedAt,
      logs: [],
      agents: [],
      usage: {},
    }
    const items = fold([
      { type: 'tool-call', agentId: 'main', toolCallId: 'tool-1', toolName: 'workflow_run', input: {} },
      { type: 'workflow-start', toolCallId: 'tool-1', workflow },
      { type: 'workflow-phase', toolCallId: 'tool-1', runId: 'wf-1', phaseId: 'review' },
      {
        type: 'workflow-agent-register',
        toolCallId: 'tool-1',
        runId: 'wf-1',
        agent: {
          callId: 'call-1',
          label: 'Accessibility reviewer',
          prompt: 'Review accessibility',
          phaseId: 'review',
          status: 'running',
          startedAt,
          items: [],
        },
      },
      {
        type: 'agent-start',
        agentId: 'sub-1',
        parentAgentId: 'main',
        parentToolCallId: 'tool-1',
        modelId: 'test-model',
        workflowRunId: 'wf-1',
        workflowCallId: 'call-1',
      },
      { type: 'text-start', agentId: 'sub-1', id: 'text-1' },
      { type: 'text-delta', agentId: 'sub-1', id: 'text-1', delta: 'Child finding' },
      { type: 'text-end', agentId: 'sub-1', id: 'text-1' },
      { type: 'usage-update', agentId: 'sub-1', modelId: 'test-model', usage: { totalTokens: 42 } },
      { type: 'agent-finish', agentId: 'sub-1', text: 'Child finding', usage: { totalTokens: 42 } },
      {
        type: 'workflow-finish',
        toolCallId: 'tool-1',
        runId: 'wf-1',
        status: 'done',
        result: 'Combined answer',
        endedAt: 200,
      },
    ])

    expect(items).toHaveLength(1)
    const card = items[0]
    expect(card?.kind).toBe('tool')
    if (!card || card.kind !== 'tool') throw new Error('missing workflow card')
    expect(card.workflow?.status).toBe('done')
    expect(card.workflow?.currentPhaseId).toBe('review')
    expect(card.workflow?.usage.totalTokens).toBe(42)
    expect(card.workflow?.agents).toHaveLength(1)
    expect(card.workflow?.agents[0]).toMatchObject({
      agentId: 'sub-1',
      status: 'done',
      result: 'Child finding',
    })
    expect(card.workflow?.agents[0]?.items).toEqual([
      { kind: 'text', id: 'text-1', agentId: 'sub-1', text: 'Child finding', streaming: false },
    ])
  })
})

describe('memory-saved', () => {
  it('appends one chip item after the answer, carrying titles and forgotten titles', () => {
    const items = fold([
      { type: 'text-start', agentId: 'main', id: 'text-1' },
      { type: 'text-delta', agentId: 'main', id: 'text-1', delta: 'Two assignments are due.' },
      { type: 'text-end', agentId: 'main', id: 'text-1' },
      {
        type: 'memory-saved',
        agentId: 'main',
        titles: ['Attends Example College'],
        forgotten: ['Uses Gmail for school mail'],
      },
    ])

    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({
      kind: 'memory',
      agentId: 'main',
      titles: ['Attends Example College'],
      forgotten: ['Uses Gmail for school mail'],
    })
  })
})

describe('reused text part ids', () => {
  it('merges deltas that genuinely share an id within one part', () => {
    const items = fold([
      { type: 'text-start', agentId: 'main', id: 'a1b2:0' },
      { type: 'text-delta', agentId: 'main', id: 'a1b2:0', delta: 'Hello ' },
      { type: 'text-delta', agentId: 'main', id: 'a1b2:0', delta: 'world.' },
      { type: 'text-end', agentId: 'main', id: 'a1b2:0' },
    ])
    expect(items).toEqual([
      { kind: 'text', id: 'a1b2:0', agentId: 'main', text: 'Hello world.', streaming: false },
    ])
  })

  it('keeps separately-scoped answers apart', () => {
    // The OpenAI chat-completions transport hardcodes text part id "0", so
    // without a per-step scope the second answer would append to the first —
    // run.ts prefixes a per-step scope to prevent exactly this.
    const items = fold([
      { type: 'text-start', agentId: 'main', id: 'turn1:0' },
      { type: 'text-delta', agentId: 'main', id: 'turn1:0', delta: "I'm handoff." },
      { type: 'text-end', agentId: 'main', id: 'turn1:0' },
      { type: 'text-start', agentId: 'main', id: 'turn2:0' },
      { type: 'text-delta', agentId: 'main', id: 'turn2:0', delta: 'You have 8 tabs open.' },
      { type: 'text-end', agentId: 'main', id: 'turn2:0' },
    ])
    expect(items.filter((i) => i.kind === 'text')).toHaveLength(2)
    expect(items).toEqual([
      { kind: 'text', id: 'turn1:0', agentId: 'main', text: "I'm handoff.", streaming: false },
      { kind: 'text', id: 'turn2:0', agentId: 'main', text: 'You have 8 tabs open.', streaming: false },
    ])
  })

  it('appends into the earlier answer when the id is NOT scoped (the bug)', () => {
    // Documents the failure mode the scope fixes: an unscoped, provider-reused
    // id makes the reducer treat two answers as one item.
    const items = fold([
      { type: 'text-start', agentId: 'main', id: '0' },
      { type: 'text-delta', agentId: 'main', id: '0', delta: "I'm handoff." },
      { type: 'text-end', agentId: 'main', id: '0' },
      { type: 'text-start', agentId: 'main', id: '0' },
      { type: 'text-delta', agentId: 'main', id: '0', delta: 'You have 8 tabs open.' },
      { type: 'text-end', agentId: 'main', id: '0' },
    ])
    expect(items.filter((i) => i.kind === 'text')).toHaveLength(1)
    expect((items[0] as { text: string }).text).toBe("I'm handoff.You have 8 tabs open.")
  })
})
