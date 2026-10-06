import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { DEFAULT_SETTINGS, type AgentEvent, type TranscriptItem } from '../shared/types'
import { applyEvent } from '../ui/reducer'
import { makeSpawnSubagent, createTabAssignments, type SpawnDeps } from './subagents'
import { TaskRegistry } from './tasks'
import { resolveModel, resolveModelAccess } from './models'
import { MODEL_IDLE_TIMEOUT_MS } from './model-idle-timeout'
import { buildTools } from './tools'
import { resetSharedSurfaceAssignments, tabSurface } from './surfaces'

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
  vi.stubGlobal('chrome', {
    storage: { session: { set: async () => {} } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: 'https://example.test/qualify', title: 'Qualification rules' })),
      query: vi.fn(async () => []),
    },
  })
  vi.mocked(resolveModel).mockReturnValue(model)
  vi.mocked(resolveModelAccess).mockImplementation(async (settings, modelId) => ({ settings: { ...settings, modelId } }))
  const tasks = new TaskRegistry()
  let transcript: TranscriptItem[] = applyEvent([], {
    type: 'tool-call', agentId: 'main', toolCallId: 'spawn', toolName: 'subagent_spawn', input: { task: 'Offline analysis' },
  })
  const events: AgentEvent[] = []
  const emit = (e: AgentEvent) => { events.push(e); transcript = applyEvent(transcript, e) }
  tasks.onChange((task) => emit({ type: 'task-update', task }))
  const tabAssignments = createTabAssignments()
  const deps = { cdp: {}, sandbox: {}, vfs: { summary: async () => ({ entries: [], skills: [] }) } } as unknown as SpawnDeps
  const controls = makeSpawnSubagent({
    parentAgentId: 'main', chatId: 'test', settings: { ...DEFAULT_SETTINGS, modelId: 'gpt-6-astra' },
    getParentCurrentTabId: () => 1, parentSignal: new AbortController().signal,
    emit, tasks, tabAssignments, deps,
  })
  return { controls, tasks, events, emit, tabAssignments, deps, card: () => transcript[0] }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); resetSharedSurfaceAssignments() })

describe('prepared-tab delegation', () => {
  it.each([false, true])('starts a child immediately after the parent reads its tab (background: %s)', async (background) => {
    const model = new MockLanguageModelV3({ doStream: async () => answer() })
    const h = setup(model)
    h.deps.cdp.snapshot = vi.fn().mockResolvedValue({ tabId: 1, url: 'https://example.test/qualify', title: 'Qualification rules', text: 'Official rules' })
    const tools = buildTools({
      ...h.deps, ctx: { agentId: 'main', currentTabId: 1 }, emit: h.emit,
      spawnSubagent: h.controls.spawn, tasks: h.tasks,
      signal: new AbortController().signal, sandboxSessionId: 'parent',
    })
    await tools.browser_snapshot!.execute!({ tabId: 1 }, { toolCallId: 'read', messages: [] })
    expect(h.tabAssignments.ownerOf(tabSurface(1))).toBe('main')
    const result = await tools.subagent_spawn!.execute!({ task: 'Read qualification rules', tabIds: [1], background }, { toolCallId: 'spawn', messages: [] })
    expect(result).not.toMatch(/^Error:/)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.card()).toMatchObject({ childStatus: 'done', childItems: [expect.objectContaining({ kind: 'text', text: 'Completed.' })] })
    expect(model.doStreamCalls).toHaveLength(1)
    expect(h.tabAssignments.ownerOf(tabSurface(1))).toBeUndefined()
    if (background) expect(h.tasks.list()[0]).toMatchObject({ status: 'done', result: 'Completed.' })
    else expect(result).toBe('Completed.')
  })

  it('rejects another child tab without starting a model or releasing the parent tab', async () => {
    const model = new MockLanguageModelV3({ doStream: async () => answer() })
    const h = setup(model)
    h.tabAssignments.softClaim('main', [tabSurface(1)])
    h.tabAssignments.claimSurfaces('sub-other', [tabSurface(2)])
    const result = await h.controls.spawn({ task: 'Read rules', tabIds: [1, 2], background: true, parentToolCallId: 'spawn' })
    expect(result).toContain('already assigned to another running subagent (sub-other)')
    expect(h.tasks.list()).toEqual([])
    expect(h.events).toEqual([])
    expect(model.doStreamCalls).toHaveLength(0)
    expect(h.tabAssignments.ownerOf(tabSurface(1))).toBe('main')
    expect(h.tabAssignments.ownerOf(tabSurface(2))).toBe('sub-other')
  })

  it('resumes a cancelled task after the parent has inspected its tab', async () => {
    const model = new MockLanguageModelV3({ doStream: async () => answer() })
    const h = setup(model)
    h.tasks.register({ id: 'task-resume', agentId: 'sub-resume', chatId: 'test', kind: 'subagent', status: 'running', description: 'Read rules', startedAt: Date.now() })
    h.tasks.initResume('task-resume', { messages: [{ role: 'user', content: 'Read rules' }], tabIds: [1], parentToolCallId: 'spawn' })
    h.tasks.finish('task-resume', 'cancelled', 'Cancelled.')
    h.tabAssignments.softClaim('main', [tabSurface(1)])
    expect(await h.controls.message('task-resume', 'Continue reading')).toContain('Resumed')
    await vi.advanceTimersByTimeAsync(100)
    expect(h.tasks.get('task-resume')).toMatchObject({ status: 'done', result: 'Completed.' })
    expect(h.tabAssignments.ownerOf(tabSurface(1))).toBeUndefined()
  })
})

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

  it('restarts a partial text response after a stalled connection', async () => {
    let calls = 0
    const model = new MockLanguageModelV3({ doStream: async () => ++calls === 1
      ? { stream: new ReadableStream<Part>({ start(c) {
          c.enqueue({ type: 'text-start', id: 'partial' })
          c.enqueue({ type: 'text-delta', id: 'partial', delta: 'Partial result' })
        } }) }
      : answer() })
    const { controls, tasks, card } = setup(model)
    await controls.spawn({ task: 'Offline analysis', tabIds: [], background: true, parentToolCallId: 'spawn' })
    await vi.advanceTimersByTimeAsync(MODEL_IDLE_TIMEOUT_MS + 2000)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(tasks.list()[0]?.status).toBe('done')
    expect(card()).toMatchObject({ childStatus: 'done', childItems: [
      expect.objectContaining({ kind: 'text', text: 'Completed.', streaming: false }),
    ] })
  })
})
