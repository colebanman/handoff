import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { DEFAULT_SETTINGS, type AgentEvent, type VirtualFileSystemService } from '../shared/types'
import { resolveModel, resolveModelAccess } from './models'
import { runLoop, type RunLoopOptions } from './run'
import { TaskRegistry } from './tasks'
import { createTabAssignments, makeSpawnSubagent } from './subagents'

vi.mock('./models', () => ({ resolveModel: vi.fn(), resolveModelAccess: vi.fn() }))
vi.mock('../storage/tasks', () => ({ savePersistedTask: vi.fn().mockResolvedValue(undefined) }))

type StreamPart = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }
function stream(chunks: StreamPart[], close = true, cancel = vi.fn()) {
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (close) controller.close()
    }, cancel,
  })
}
function answer(text: string): StreamPart[] {
  return [
    { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: text },
    { type: 'text-end', id: 'answer' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ]
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('does not multiply failed request retries by restarting the whole turn', async () => {
  vi.useFakeTimers()
  const model = new MockLanguageModelV3({ doStream: async () => { throw new TypeError('Failed to fetch') } })
  const settings = { ...DEFAULT_SETTINGS, provider: 'openai' as const, modelId: 'stall-test' }
  vi.mocked(resolveModelAccess).mockResolvedValue({ settings })
  vi.mocked(resolveModel).mockReturnValue(model)
  vi.stubGlobal('chrome', { tabs: { query: async () => [] } })
  const events: AgentEvent[] = []
  const run = runLoop({
    ctx: { agentId: 'main', currentTabId: 0 }, settings, modelId: settings.modelId,
    messages: [{ role: 'user', content: 'Answer.' }], signal: new AbortController().signal,
    emit: event => { events.push(event) }, tasks: new TaskRegistry(), spawnSubagent: vi.fn(), sandboxSessionId: 'parent', isSubagent: false,
    deps: { cdp: {} as RunLoopOptions['deps']['cdp'], sandbox: {} as RunLoopOptions['deps']['sandbox'],
      vfs: { summary: async () => ({ entries: [], skills: [] }) } as unknown as VirtualFileSystemService },
  })
  const failure = expect(run).rejects.toThrow('Failed to fetch')
  await vi.waitFor(() => expect(model.doStreamCalls.length).toBeGreaterThan(0))
  await vi.runAllTimersAsync()
  await failure
  expect(model.doStreamCalls).toHaveLength(3)
  expect(resolveModelAccess).toHaveBeenCalledOnce()
  expect(events.filter(event => event.type === 'agent-error')).toHaveLength(1)
})

describe('parent continuation after cancelling background subagents', () => {
  it.each([true, false])('continues after task_wait returns (provider closes socket: %s)', async (closes) => {
    const controller = new AbortController()
    const tasks = new TaskRegistry()
    const events: AgentEvent[] = []
    const settings = { ...DEFAULT_SETTINGS, provider: 'openai' as const, modelId: 'stall-test' }
    vi.mocked(resolveModelAccess).mockResolvedValue({ settings })
    vi.stubGlobal('chrome', { tabs: { query: async () => [] } })
    const deps: RunLoopOptions['deps'] = {
      cdp: {} as RunLoopOptions['deps']['cdp'], sandbox: {} as RunLoopOptions['deps']['sandbox'],
      vfs: { summary: async () => ({ entries: [], skills: [] }), readText: async () => ({ text: '' }) } as unknown as VirtualFileSystemService,
    }
    const emit = (event: AgentEvent) => { events.push(event) }
    const subagents = makeSpawnSubagent({
      parentAgentId: 'main', chatId: 'chat', getParentCurrentTabId: () => 0,
      settings, emit, deps, tasks, tabAssignments: createTabAssignments(), parentSignal: controller.signal,
    })
    let parentCalls = 0
    const upstreamCancel = vi.fn()
    const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
      const text = JSON.stringify(prompt.find((message) => message.role === 'user'))
      if (text.includes('child-hang-')) return { stream: stream([], false) }
      if (text.includes('child-done')) return { stream: stream(answer('Child result')) }
      parentCalls += 1
      return { stream: parentCalls === 1 ? stream([
        { type: 'tool-call', toolCallId: 'wait', toolName: 'task_wait', input: JSON.stringify({ taskIds: tasks.list().map((task) => task.id), mode: 'all' }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ], closes, upstreamCancel) : stream(answer('Parent continued')) }
    } })
    vi.mocked(resolveModel).mockReturnValue(model)
    for (const task of ['child-hang-1', 'child-hang-2', 'child-done']) {
      await subagents.spawn({ task, background: true, tabIds: [], parentToolCallId: task })
    }
    const run = runLoop({
      ctx: { agentId: 'main', currentTabId: 0 }, settings, modelId: settings.modelId,
      messages: [{ role: 'user', content: 'Collect all results.' }], signal: controller.signal,
      emit, deps, tasks, spawnSubagent: subagents.spawn, sandboxSessionId: 'parent', isSubagent: false,
    })
    // Observe rejection even when a failing assertion needs to stop the run.
    void run.catch(() => {})
    try {
      await vi.waitFor(() => expect(events.some((event) => event.type === 'tool-call' && event.toolCallId === 'wait')).toBe(true))
      for (const task of tasks.list().filter((task) => task.description.startsWith('child-hang-'))) tasks.cancel(task.id)
      await vi.waitFor(() => expect(events.some((event) => event.type === 'tool-result' && event.toolCallId === 'wait')).toBe(true))
      expect(tasks.list().map((task) => task.status)).toEqual(['cancelled', 'cancelled', 'done'])
      expect(controller.signal.aborted).toBe(false)
      await vi.waitFor(() => expect(parentCalls).toBe(2), { timeout: 1000 })
      expect((await run).text).toBe('Parent continued')
      if (!closes) expect(upstreamCancel).toHaveBeenCalled()
    } finally {
      controller.abort()
      await run.catch(() => {})
    }
  })
})
