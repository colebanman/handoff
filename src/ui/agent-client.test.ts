import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentClient } from './agent-client'
import { DEFAULT_SETTINGS, type ChatRecord, type TurnResult } from '../shared/types'
import type { AgentHostServerMessage, ExecutionSnapshot } from '../shared/execution-protocol'

class EventHook<T extends (...args: never[]) => void> {
  listeners: T[] = []
  addListener = (listener: T): void => { this.listeners.push(listener) }
  emit(...args: Parameters<T>): void { for (const listener of this.listeners) listener(...args) }
}

class FakePort {
  onMessage = new EventHook<(message: unknown) => void>()
  onDisconnect = new EventHook<() => void>()
  sent: unknown[] = []
  postMessage = (message: unknown): void => { this.sent.push(message) }
  receive(message: AgentHostServerMessage): void { this.onMessage.emit(message) }
  disconnect(): void { this.onDisconnect.emit() }
}

function record(): ChatRecord {
  return {
    id: 'chat-1', title: 'Test', createdAt: 1, updatedAt: 1,
    modelId: DEFAULT_SETTINGS.modelId, messages: [{ role: 'user', content: 'go' }], transcript: [], checkpoints: [], turns: [],
  }
}

function snapshot(status: ExecutionSnapshot['status'], result?: TurnResult): ExecutionSnapshot {
  return {
    runId: 'turn-1', ownerId: 'host-1', chatId: 'chat-1', status,
    record: record(), startedAt: 1, updatedAt: 2, eventSeq: 0, result,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('durable execution client reattachment', () => {
  it('cancels before ready without starting the turn later', async () => {
    const port = new FakePort()
    vi.stubGlobal('chrome', { runtime: { connect: () => port } })
    const client = createAgentClient()
    const controller = new AbortController()
    const result = client.agent.runTurn({ chatId: 'chat-1', messages: [], settings: DEFAULT_SETTINGS,
      lifecycleRecord: record(), signal: controller.signal, onEvent: vi.fn() })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    port.receive({ type: 'ready', executions: [], tasks: [] })
    await Promise.resolve()
    expect(port.sent).toEqual([])
  })

  it('resends Stop after reconnect and retains completed-step history', async () => {
    vi.useFakeTimers()
    const ports: FakePort[] = []
    vi.stubGlobal('chrome', { runtime: { connect: () => { const port = new FakePort(); ports.push(port); return port } } })
    const client = createAgentClient()
    ports[0]!.receive({ type: 'ready', executions: [], tasks: [] })
    const controller = new AbortController()
    const result = client.agent.runTurn({ chatId: 'chat-1', messages: [], settings: DEFAULT_SETTINGS,
      lifecycleRecord: record(), signal: controller.signal, onEvent: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    const start = ports[0]!.sent.find((m) => (m as { type: string }).type === 'start') as { runId: string }
    const live = { ...snapshot('running'), runId: start.runId }
    ports[0]!.receive({ type: 'snapshot', snapshot: live })
    ports[0]!.disconnect()
    controller.abort()
    await vi.advanceTimersByTimeAsync(500)
    ports[1]!.receive({ type: 'ready', executions: [live], tasks: [] })
    expect(ports[1]!.sent).toContainEqual({ type: 'cancel', runId: start.runId })
    const partial = { responseMessages: [{ role: 'assistant', content: 'Previous step' }], text: '', steps: 1 }
    ports[1]!.receive({ type: 'snapshot', snapshot: { ...live, status: 'cancelled', result: partial } })
    await expect(result).resolves.toEqual(partial)
  })
  it('finishes the initial handshake even when the worker disconnects before ready', async () => {
    vi.useFakeTimers()
    const ports: FakePort[] = []
    vi.stubGlobal('chrome', {
      runtime: { connect: () => { const port = new FakePort(); ports.push(port); return port } },
      storage: { local: { remove: vi.fn(async () => {}) } },
    })
    const client = createAgentClient()
    const ready = client.executions.ready()
    ports[0]!.disconnect()
    await vi.advanceTimersByTimeAsync(500)
    ports[1]!.receive({ type: 'ready', executions: [], tasks: [] })
    await expect(ready).resolves.toBeUndefined()
  })

  it('hydrates the same running execution into a newly opened panel client', async () => {
    const ports: FakePort[] = []
    vi.stubGlobal('chrome', {
      runtime: { connect: () => { const port = new FakePort(); ports.push(port); return port } },
      storage: { local: { remove: vi.fn(async () => {}) } },
    })

    const firstPanel = createAgentClient()
    ports[0]!.receive({ type: 'ready', executions: [snapshot('running')], tasks: [] })
    await Promise.resolve()
    expect(firstPanel.executions.list()).toHaveLength(1)
    expect(firstPanel.executions.list()[0]!.status).toBe('running')

    // A fresh client has no in-memory state from the first panel. The worker's
    // ready snapshot is sufficient to reattach it to the same run id/record.
    const reopenedPanel = createAgentClient()
    ports[1]!.receive({ type: 'ready', executions: [snapshot('running')], tasks: [] })
    await Promise.resolve()
    expect(reopenedPanel.executions.list()).toEqual([expect.objectContaining({ runId: 'turn-1', chatId: 'chat-1', status: 'running' })])
  })

  it('keeps a run pending across a port disconnect and resolves it after reconnect', async () => {
    vi.useFakeTimers()
    const ports: FakePort[] = []
    vi.stubGlobal('chrome', {
      runtime: { connect: () => { const port = new FakePort(); ports.push(port); return port } },
      storage: { local: { remove: vi.fn(async () => {}) } },
    })
    const client = createAgentClient()
    ports[0]!.receive({ type: 'ready', executions: [], tasks: [] })
    const resultPromise = client.agent.runTurn({
      chatId: 'chat-1', messages: record().messages, settings: DEFAULT_SETTINGS,
      lifecycleRecord: record(), signal: new AbortController().signal, onEvent: vi.fn(),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(ports[0]!.sent).toContainEqual(expect.objectContaining({ type: 'start' }))
    const start = ports[0]!.sent.find((message) => (message as { type?: string }).type === 'start') as { runId: string }
    const live = { ...snapshot('running'), runId: start.runId }
    ports[0]!.receive({ type: 'snapshot', snapshot: live })
    ports[0]!.disconnect()
    await vi.advanceTimersByTimeAsync(500)
    ports[1]!.receive({ type: 'ready', executions: [live], tasks: [] })
    const result: TurnResult = { responseMessages: [], text: 'finished', steps: 1 }
    ports[1]!.receive({ type: 'snapshot', snapshot: { ...live, status: 'done', result } })
    await expect(resultPromise).resolves.toEqual(result)
    // Delivery is not persistence: the UI may disappear before saving its chat.
    expect(chrome.storage.local.remove).not.toHaveBeenCalled()
    expect(client.executions.list()[0]?.status).toBe('done')
    await client.executions.acknowledge(start.runId)
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(`agent-execution:${start.runId}`)
  })

  it('ignores an older disk checkpoint arriving after the live reconnect snapshot', () => {
    const port = new FakePort()
    vi.stubGlobal('chrome', {
      runtime: { connect: () => port },
      storage: { local: { remove: vi.fn(async () => {}) } },
    })
    const client = createAgentClient()
    const latest = { ...snapshot('running'), eventSeq: 10, updatedAt: 10 }
    port.receive({ type: 'ready', executions: [latest], tasks: [] })
    const changed = vi.fn()
    client.executions.onChange(changed)
    port.receive({ type: 'snapshot', snapshot: { ...latest, eventSeq: 8, updatedAt: 8 } })
    expect(changed).not.toHaveBeenCalled()
    expect(client.executions.list()).toEqual([latest])
  })
})
