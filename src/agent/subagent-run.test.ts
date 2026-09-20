import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { DEFAULT_SETTINGS, type AgentEvent, type TranscriptItem } from '../shared/types'
import { applyEvent } from '../ui/reducer'
import { makeSpawnSubagent, createTabAssignments, type SpawnDeps } from './subagents'
import { TaskRegistry } from './tasks'
import { resolveModel, resolveModelAccess } from './models'
import { MODEL_IDLE_TIMEOUT_MS } from './model-idle-timeout'

vi.mock('./models', () => ({ resolveModel: vi.fn(), resolveModelAccess: vi.fn() }))

type Part = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never
const finish: Part = {
  type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
}
const answer = () => ({ stream: simulateReadableStream<Part>({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
  { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Completed.' },
  { type: 'text-end', id: 'answer' }, finish,
] }) })

function setup(model: MockLanguageModelV3) {
  vi.useFakeTimers()
  vi.stubGlobal('chrome', { storage: { session: { set: async () => {} } } })
  vi.mocked(resolveModel).mockReturnValue(model)
  vi.mocked(resolveModelAccess).mockImplementation(async (settings, modelId) => ({ settings: { ...settings, modelId } }))
  const tasks = new TaskRegistry()
  let transcript: TranscriptItem[] = applyEvent([], {
    type: 'tool-call', agentId: 'main', toolCallId: 'spawn', toolName: 'subagent_spawn', input: { task: 'Offline analysis' },
  })
  const events: AgentEvent[] = []
  const emit = (e: AgentEvent) => { events.push(e); transcript = applyEvent(transcript, e) }
  tasks.onChange((task) => emit({ type: 'task-update', task }))
  const controls = makeSpawnSubagent({
    parentAgentId: 'main', chatId: 'test', settings: { ...DEFAULT_SETTINGS, modelId: 'gpt-6-astra' },
    getParentCurrentTabId: () => 1, parentSignal: new AbortController().signal,
    emit, tasks, tabAssignments: createTabAssignments(),
    deps: { cdp: {}, sandbox: {}, vfs: { summary: async () => ({ entries: [], skills: [] }) } } as unknown as SpawnDeps,
  })
  return { controls, tasks, events, card: () => transcript[0] }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('background subagents through the SDK loop', () => {
  it('recovers a silent request on Sol without leaving a failed or starting card', async () => {
    let calls = 0
    const model = new MockLanguageModelV3({ doStream: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(answer()) })
    const { controls, tasks, events, card } = setup(model)
    await controls.spawn({ task: 'Offline analysis', tabIds: [], background: true, parentToolCallId: 'spawn' })
    await vi.advanceTimersByTimeAsync(MODEL_IDLE_TIMEOUT_MS + 1000)
    expect(calls).toBe(2)
    expect(model.doStreamCalls[0]!.abortSignal?.aborted).toBe(true)
    expect(resolveModelAccess).toHaveBeenCalledWith(expect.anything(), 'gpt-5.6-sol')
    expect(tasks.list()[0]).toMatchObject({ status: 'done', result: 'Completed.' })
    expect(events.some((e) => e.type === 'agent-error')).toBe(false)
    expect(card()).toMatchObject({ childStatus: 'done', childItems: [expect.objectContaining({ kind: 'text', text: 'Completed.' })] })
  })

  it('ends a repeatedly silent request as a task error instead of running forever', async () => {
    const model = new MockLanguageModelV3({ doStream: () => new Promise(() => {}) })
    const { controls, tasks, card } = setup(model)
    await controls.spawn({ task: 'Offline analysis', tabIds: [], background: true, parentToolCallId: 'spawn' })
    await vi.advanceTimersByTimeAsync(2 * MODEL_IDLE_TIMEOUT_MS + 1000)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(tasks.list()[0]).toMatchObject({ status: 'error', result: expect.stringContaining('Model request stalled') })
    expect(card()).toMatchObject({ childStatus: 'error', childItems: [expect.objectContaining({ kind: 'error', message: expect.stringContaining('Model request stalled') })] })
  })

  it('does not replay a request after partial output', async () => {
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream<Part>({ start(c) {
      c.enqueue({ type: 'text-start', id: 'partial' })
      c.enqueue({ type: 'text-delta', id: 'partial', delta: 'Partial result' })
    } }) }) })
    const { controls, tasks, card } = setup(model)
    await controls.spawn({ task: 'Offline analysis', tabIds: [], background: true, parentToolCallId: 'spawn' })
    await vi.advanceTimersByTimeAsync(MODEL_IDLE_TIMEOUT_MS + 1000)
    expect(model.doStreamCalls).toHaveLength(1)
    expect(tasks.list()[0]?.status).toBe('error')
    expect(card()).toMatchObject({ childStatus: 'error', childItems: expect.arrayContaining([
      expect.objectContaining({ kind: 'text', text: 'Partial result', streaming: false }),
      expect.objectContaining({ kind: 'error' }),
    ]) })
  })
})
