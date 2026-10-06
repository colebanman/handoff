import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { DEFAULT_SETTINGS, type AgentEvent, type VirtualFileSystemService } from '../shared/types'
import { resolveModel, resolveModelAccess } from './models'
import { runLoop, type RunLoopOptions } from './run'
import { TaskRegistry } from './tasks'
import { createTabAssignments, makeSpawnSubagent } from './subagents'
import { applyEvent } from '../ui/reducer'
import { MODEL_IDLE_TIMEOUT_MS, MODEL_TOOL_INPUT_IDLE_TIMEOUT_MS } from './model-idle-timeout'

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

it('recovers stalled tool arguments before execution and removes the abandoned draft', async () => {
  vi.useFakeTimers()
  let calls = 0
  const cancel = vi.fn()
  const input = { intent: 'Reading workspace file', code: "return await api.fs.readText('/workspace/data.txt')" }
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: ++calls === 1
    ? stream([
        { type: 'tool-input-start', id: 'abandoned', toolName: 'sandbox_exec' },
        { type: 'tool-input-delta', id: 'abandoned', delta: JSON.stringify(input) },
      ], false, cancel)
    : stream(calls === 2 ? [
        { type: 'tool-call', toolCallId: 'read', toolName: 'sandbox_exec', input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ] : answer('Recovered after preparing code')),
  }) })
  const settings = { ...DEFAULT_SETTINGS, provider: 'openai' as const, modelId: 'stall-test' }
  vi.mocked(resolveModelAccess).mockResolvedValue({ settings })
  vi.mocked(resolveModel).mockReturnValue(model)
  vi.stubGlobal('chrome', { tabs: { query: async () => [] } })
  const events: AgentEvent[] = []
  const execute = vi.fn(async () => ({ ok: true, value: 'File text', logs: [], durationMs: 1 }))
  const run = runLoop({
    ctx: { agentId: 'main', currentTabId: 0 }, settings, modelId: settings.modelId,
    messages: [{ role: 'user', content: 'Read the file' }], signal: new AbortController().signal,
    emit: event => { events.push(event) }, tasks: new TaskRegistry(), spawnSubagent: vi.fn(), sandboxSessionId: 'parent', isSubagent: false,
    deps: { cdp: {} as RunLoopOptions['deps']['cdp'], sandbox: { exec: execute },
      vfs: { summary: async () => ({ entries: [], skills: [] }) } as unknown as VirtualFileSystemService },
  })
  await vi.waitFor(() => expect(events.some(event => event.type === 'tool-input-delta')).toBe(true))
  await vi.advanceTimersByTimeAsync(MODEL_TOOL_INPUT_IDLE_TIMEOUT_MS + 2000)
  expect((await run).text).toBe('Recovered after preparing code')
  expect(model.doStreamCalls).toHaveLength(3)
  expect(execute).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledOnce()
  expect(events).toContainEqual({ type: 'connection-restart', agentId: 'main', partIds: [], toolCallIds: ['abandoned'] })
  const transcript = events.reduce(applyEvent, [] as import('../shared/types').TranscriptItem[])
  expect(transcript.some(item => item.id === 'abandoned')).toBe(false)
  expect(transcript.find(item => item.id === 'read')).toMatchObject({ status: 'done', inputStreaming: false })
  expect(events.some(event => event.type === 'agent-error')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('ends repeatedly stalled tool preparation after one recovery attempt without executing it', async () => {
  vi.useFakeTimers()
  let calls = 0
  const model = new MockLanguageModelV3({ doStream: async () => {
    const id = `draft-${++calls}`
    return { stream: stream([
      { type: 'tool-input-start', id, toolName: 'sandbox_exec' },
      { type: 'tool-input-delta', id, delta: '{"intent":"Reading file","code":"return 1"}' },
    ], false) }
  } })
  const settings = { ...DEFAULT_SETTINGS, provider: 'openai' as const, modelId: 'stall-test' }
  vi.mocked(resolveModelAccess).mockResolvedValue({ settings })
  vi.mocked(resolveModel).mockReturnValue(model)
  vi.stubGlobal('chrome', { tabs: { query: async () => [] } })
  const events: AgentEvent[] = []
  const execute = vi.fn()
  const run = runLoop({
    ctx: { agentId: 'main', currentTabId: 0 }, settings, modelId: settings.modelId,
    messages: [{ role: 'user', content: 'Read file' }], signal: new AbortController().signal,
    emit: event => { events.push(event) }, tasks: new TaskRegistry(), spawnSubagent: vi.fn(), sandboxSessionId: 'parent', isSubagent: false,
    deps: { cdp: {} as RunLoopOptions['deps']['cdp'], sandbox: { exec: execute },
      vfs: { summary: async () => ({ entries: [], skills: [] }) } as unknown as VirtualFileSystemService },
  })
  const rejected = expect(run).rejects.toThrow('Model request stalled')
  await vi.waitFor(() => expect(events.some(event => event.type === 'tool-input-delta')).toBe(true))
  await vi.advanceTimersByTimeAsync(MODEL_TOOL_INPUT_IDLE_TIMEOUT_MS + 2000)
  await vi.waitFor(() => expect(events.filter(event => event.type === 'tool-input-delta')).toHaveLength(2))
  await vi.advanceTimersByTimeAsync(MODEL_TOOL_INPUT_IDLE_TIMEOUT_MS + 1)
  await rejected
  expect(model.doStreamCalls).toHaveLength(2)
  expect(execute).not.toHaveBeenCalled()
  const transcript = events.reduce(applyEvent, [] as import('../shared/types').TranscriptItem[])
  expect(transcript.filter(item => item.kind === 'tool')).toEqual([expect.objectContaining({ status: 'error', inputStreaming: false })])
  expect(vi.getTimerCount()).toBe(0)
})

it('does not replay a submitted tool after a model stream stalls', async () => {
  vi.useFakeTimers()
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: stream([
    { type: 'tool-call', toolCallId: 'write', toolName: 'sandbox_exec', input: JSON.stringify({ intent: 'Saving a file', code: 'await api.fs.writeText(path, text)' }) },
  ], false) }) })
  const settings = { ...DEFAULT_SETTINGS, provider: 'openai' as const, modelId: 'stall-test' }
  vi.mocked(resolveModelAccess).mockResolvedValue({ settings })
  vi.mocked(resolveModel).mockReturnValue(model)
  vi.stubGlobal('chrome', { tabs: { query: async () => [] } })
  const events: AgentEvent[] = []
  const execute = vi.fn(async () => ({ ok: true, value: 'Saved', logs: [], durationMs: 1 }))
  const run = runLoop({
    ctx: { agentId: 'main', currentTabId: 0 }, settings, modelId: settings.modelId,
    messages: [{ role: 'user', content: 'Save the file' }], signal: new AbortController().signal,
    emit: event => { events.push(event) }, tasks: new TaskRegistry(), spawnSubagent: vi.fn(), sandboxSessionId: 'parent', isSubagent: false,
    deps: { cdp: {} as RunLoopOptions['deps']['cdp'], sandbox: { exec: execute },
      vfs: { summary: async () => ({ entries: [], skills: [] }) } as unknown as VirtualFileSystemService },
  })
  const rejected = expect(run).rejects.toThrow('Model request stalled')
  await vi.waitFor(() => expect(events.some(event => event.type === 'tool-result')).toBe(true))
  await vi.advanceTimersByTimeAsync(MODEL_IDLE_TIMEOUT_MS)
  await rejected
  expect(model.doStreamCalls).toHaveLength(1)
  expect(execute).toHaveBeenCalledOnce()
  expect(events.some(event => event.type === 'connection-restart')).toBe(false)
  expect(events.reduce(applyEvent, [] as import('../shared/types').TranscriptItem[]).find(item => item.id === 'write')).toMatchObject({ status: 'done' })
})

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
  expect(model.doStreamCalls).toHaveLength(7)
  expect(resolveModelAccess).toHaveBeenCalledOnce()
  expect(events.filter(event => event.type === 'agent-error')).toHaveLength(1)
})

it('restarts a broken text stream from the last completed step without duplicating text', async () => {
  let calls = 0
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: stream(++calls === 1 ? [
    { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: 'Partial answer' },
    { type: 'error', error: new TypeError('Failed to fetch') },
  ] : answer('Recovered answer')) }) })
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
  expect((await run).text).toBe('Recovered answer')
  const transcript = events.reduce(applyEvent, [] as import('../shared/types').TranscriptItem[])
  expect(transcript.filter((item) => item.kind === 'text').map((item) => item.text)).toEqual(['Recovered answer'])
  expect(events.some((event) => event.type === 'connection-restart')).toBe(true)
  expect(events.some((event) => event.type === 'agent-error')).toBe(false)
  expect(model.doStreamCalls).toHaveLength(2)
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
