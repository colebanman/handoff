import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_HOST_PORT, EXECUTION_KEY_PREFIX, type ExecutionSnapshot } from '../shared/execution-protocol'
import { DEFAULT_SETTINGS, type RunTurnOptions, type TurnResult } from '../shared/types'

const fake = vi.hoisted(() => ({ runTurn: vi.fn(), cancelChatTasks: vi.fn() }))
vi.mock('../agent', () => ({ createAgentRuntime: () => ({ ...fake, onTaskUpdate: vi.fn(), listTasks: () => [] }) }))
vi.mock('../cdp', () => ({ createCdpService: () => ({}) }))
vi.mock('./runtime-services', () => ({ createBackgroundRuntimeServices: () => ({ vfs: {}, sandbox: {} }) }))
vi.mock('../storage/seed-skills', () => ({ seedBundledSkills: async () => {} }))
vi.mock('./automation-host', () => ({
  createAutomationHost: () => ({ reconcile: async () => {}, handleRuntimeMessage: () => undefined }),
}))

let connect: (port: unknown) => void
let saved: Record<string, unknown>
let ensureOffscreen: ReturnType<typeof vi.fn<() => Promise<void>>>
let resolveTurn: (result: TurnResult) => void
let host: ReturnType<typeof import('./agent-host').initAgentHost>

function panel() {
  let message: (value: unknown) => void
  let disconnect: () => void
  const posted: any[] = []
  connect({
    name: AGENT_HOST_PORT,
    postMessage: (value: unknown) => posted.push(value),
    onMessage: { addListener: (fn: typeof message) => { message = fn } },
    onDisconnect: { addListener: (fn: typeof disconnect) => { disconnect = fn } },
  })
  return { posted, send: (value: unknown) => message(value), close: () => disconnect() }
}

const start = {
  type: 'start', runId: 'run-1', options: {
    chatId: 'chat-1', messages: [], settings: DEFAULT_SETTINGS,
    record: { id: 'chat-1', title: 'Test', createdAt: 1, updatedAt: 1, modelId: DEFAULT_SETTINGS.modelId, messages: [], transcript: [], checkpoints: [] },
  },
}
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.clearAllMocks()
  saved = {}
  ensureOffscreen = vi.fn(async () => {})
  fake.runTurn.mockImplementation(() => new Promise<TurnResult>((resolve) => { resolveTurn = resolve }))
  vi.stubGlobal('chrome', {
    runtime: {
      onConnect: { addListener: (fn: typeof connect) => { connect = fn } },
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    storage: { local: {
      getKeys: vi.fn(async () => Object.keys(saved)),
      get: vi.fn(async (keys: string[] | null) => structuredClone(keys === null
        ? saved
        : Object.fromEntries(keys.filter((key) => key in saved).map((key) => [key, saved[key]])))),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(saved, structuredClone(values)) }),
    } },
  })
  const { initAgentHost } = await import('./agent-host')
  host = initAgentHost(ensureOffscreen)
  await flush()
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('exports background agent failures for the panel debug button', async () => {
  const { debugLog } = await import('../shared/debug-log')
  debugLog.error('agent', 'streamText onError', new TypeError('Failed to fetch'))
  const report = await host.handleRuntimeMessage({ target: 'background', type: 'execution.debug', chatId: 'chat-1' })
  expect(report).toContain('source: background execution host')
  expect(report).toContain('chatId: chat-1')
  expect(report).toContain('streamText onError')
  expect(report).toContain('Failed to fetch')
})

it('opens an idle panel without reading unrelated chat histories', async () => {
  saved['chat:large-archive'] = { messages: ['large archived content'] }
  const owner = panel()
  await flush()
  expect(owner.posted).toContainEqual({ type: 'ready', executions: [], tasks: [] })
  expect(chrome.storage.local.get).not.toHaveBeenCalled()
})

it('loads only pending checkpoints when attaching a panel', async () => {
  const checkpoint: ExecutionSnapshot = {
    runId: 'finished', ownerId: 'old-host', chatId: 'chat-1', status: 'done',
    record: start.options.record, startedAt: 1, updatedAt: 2, eventSeq: 1,
  }
  saved['chat:unrelated'] = { messages: ['unrelated content'] }
  saved[`${EXECUTION_KEY_PREFIX}finished`] = checkpoint
  const owner = panel()
  await flush()
  expect(chrome.storage.local.get).toHaveBeenCalledWith([`${EXECUTION_KEY_PREFIX}finished`])
  expect(chrome.storage.local.get).not.toHaveBeenCalledWith(null)
  expect(owner.posted).toContainEqual({ type: 'ready', executions: [checkpoint], tasks: [] })
})

it('starts keepalive before execution and does not cancel when a panel disconnects', async () => {
  let ready!: () => void
  ensureOffscreen.mockImplementation(() => new Promise<void>((resolve) => { ready = resolve }))
  const owner = panel()
  owner.send(start)
  await flush()
  expect(fake.runTurn).not.toHaveBeenCalled()
  ready()
  await flush()
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'execution.activity', active: true }))
  const options = fake.runTurn.mock.calls[0]![0] as RunTurnOptions
  owner.close()
  expect(options.signal.aborted).toBe(false)
  expect(fake.cancelChatTasks).not.toHaveBeenCalled()
})

it('checkpoints a continuous stream and reattaches with the latest in-memory state', async () => {
  const owner = panel()
  owner.send(start)
  await flush()
  const options = fake.runTurn.mock.calls[0]![0] as RunTurnOptions
  for (let i = 0; i < 10; i++) {
    options.onEvent({ type: 'text-start', agentId: 'main', id: `text-${i}` })
    await vi.advanceTimersByTimeAsync(50)
  }
  const durable = saved[`${EXECUTION_KEY_PREFIX}run-1`] as ExecutionSnapshot
  expect(durable.eventSeq).toBeGreaterThanOrEqual(8)
  owner.close()
  const next = panel()
  await flush()
  expect(next.posted.find((message) => message.type === 'ready').executions[0].eventSeq).toBe(10)
  next.send(start)
  await flush()
  expect(fake.runTurn).toHaveBeenCalledTimes(1)
  resolveTurn({ responseMessages: [], text: 'done', steps: 1 })
  await flush()
  expect((saved[`${EXECUTION_KEY_PREFIX}run-1`] as ExecutionSnapshot).status).toBe('done')
  await vi.advanceTimersByTimeAsync(250)
  expect((saved[`${EXECUTION_KEY_PREFIX}run-1`] as ExecutionSnapshot).status).toBe('done')
})

it('releases a cancelled chat even when its command never settles, and ignores late events', async () => {
  const owner = panel()
  owner.send(start)
  await flush()
  const first = fake.runTurn.mock.calls[0]![0] as RunTurnOptions
  const finishOld = resolveTurn
  const completed = [{ role: 'assistant', content: 'Finished the previous step.' }]
  first.onStepMessages?.(completed)
  owner.send({ type: 'steer', chatId: 'chat-1', text: 'try something else' })
  owner.send({ type: 'cancel', runId: 'run-1' })
  await flush()
  expect(first.signal.aborted).toBe(true)
  const stopped = saved[`${EXECUTION_KEY_PREFIX}run-1`] as ExecutionSnapshot
  expect(stopped.status).toBe('cancelled')
  expect(stopped.result?.responseMessages).toEqual(completed)

  owner.send({ ...start, runId: 'run-2' })
  await flush()
  expect(fake.runTurn).toHaveBeenCalledTimes(2)
  const eventsBefore = owner.posted.length
  first.onEvent({ type: 'text-start', agentId: 'main', id: 'late' })
  finishOld({ responseMessages: [], text: 'late result', steps: 1 })
  await flush()
  expect(owner.posted).toHaveLength(eventsBefore)
  expect((saved[`${EXECUTION_KEY_PREFIX}run-1`] as ExecutionSnapshot).status).toBe('cancelled')
  expect((saved[`${EXECUTION_KEY_PREFIX}run-2`] as ExecutionSnapshot).status).toBe('running')
})

it('does not launch a cancelled turn after offscreen setup eventually finishes', async () => {
  let ready!: () => void
  ensureOffscreen.mockImplementation(() => new Promise<void>((resolve) => { ready = resolve }))
  const owner = panel()
  owner.send(start)
  await flush()
  owner.send({ type: 'cancel', runId: 'run-1' })
  await flush()
  expect((saved[`${EXECUTION_KEY_PREFIX}run-1`] as ExecutionSnapshot).status).toBe('cancelled')
  ready()
  await flush()
  expect(fake.runTurn).not.toHaveBeenCalled()
})

it.each(['sidebar', 'mini'] as const)('%s uses the shared agent runtime and interaction harness', async (surface) => {
  const options = { ...start.options, capabilities: { askUser: true } }
  if (surface === 'sidebar') {
    const client = panel()
    client.send({ ...start, options })
  } else {
    const { startHostedTurn } = await import('./agent-host')
    await startHostedTurn(options)
  }
  await flush()
  expect(fake.runTurn).toHaveBeenCalledTimes(1)
  const turn = fake.runTurn.mock.calls[0]![0] as RunTurnOptions
  expect(turn).toMatchObject({
    chatId: options.chatId,
    messages: options.messages,
    settings: options.settings,
    signal: expect.any(AbortSignal),
    onEvent: expect.any(Function),
    onStepMessages: expect.any(Function),
    onStepLimit: expect.any(Function),
    askUser: expect.any(Function),
    steering: { take: expect.any(Function), peek: expect.any(Function) },
  })
})
