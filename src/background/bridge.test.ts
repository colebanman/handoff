/**
 * Service-worker bridge wiring, against a fake `chrome` and a fake WebSocket.
 *
 * What this pins down is the part that cannot be checked by hand without
 * loading the extension: that reads are answered from storage with no panel
 * attached, that writes fail with `panel_closed` instead of hanging, and that
 * panel lifecycle events reach the daemon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../shared/types'

/* ---- fakes -------------------------------------------------------------- */

class FakeSocket {
  static last: FakeSocket | undefined
  static readonly OPEN = 1
  readyState = 0
  sent: string[] = []
  private listeners: Record<string, Array<(event: unknown) => void>> = {}

  constructor(readonly url: string) {
    FakeSocket.last = this
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.fire('close', {})
  }

  /** Test driver: complete the handshake. */
  open(): void {
    this.readyState = 1
    this.fire('open', {})
  }

  /** Test driver: deliver a frame from the daemon. */
  deliver(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) })
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }

  private fire(type: string, event: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
}

interface FakePort {
  name: string
  postMessage: (message: unknown) => void
  onMessage: { addListener: (fn: (message: unknown) => void) => void }
  onDisconnect: { addListener: (fn: () => void) => void }
  /** Test driver: push a message from the panel to the worker. */
  emit: (message: unknown) => void
  disconnect: () => void
  posted: unknown[]
}

function makePort(name: string): FakePort {
  const messageListeners: Array<(message: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  const posted: unknown[] = []
  return {
    name,
    posted,
    postMessage: (message) => posted.push(message),
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    emit: (message) => messageListeners.forEach((fn) => fn(message)),
    disconnect: () => disconnectListeners.forEach((fn) => fn()),
  }
}

const storage = new Map<string, unknown>()
let connectListener: ((port: unknown) => void) | undefined
const notifications: Array<Record<string, unknown>> = []
const badges: string[] = []

function installChrome(): void {
  storage.clear()
  connectListener = undefined
  notifications.length = 0
  badges.length = 0
  const chromeStub = {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '9.9.9' }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      lastError: undefined,
      onConnect: { addListener: (fn: (port: unknown) => void) => (connectListener = fn) },
    },
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key]
          const out: Record<string, unknown> = {}
          for (const k of keys) if (storage.has(k)) out[k] = storage.get(k)
          return out
        },
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) storage.set(k, v)
        },
        remove: async () => undefined,
      },
      onChanged: { addListener: () => undefined },
    },
    alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
    action: {
      setBadgeText: async ({ text }: { text: string }) => void badges.push(text),
      setBadgeBackgroundColor: async () => undefined,
    },
    notifications: {
      create: (_id: string, options: Record<string, unknown>) => void notifications.push(options),
      clear: () => undefined,
      onClicked: { addListener: () => undefined },
    },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    sidePanel: { open: async () => undefined },
  }
  vi.stubGlobal('chrome', chromeStub)
  vi.stubGlobal('WebSocket', FakeSocket)
}

function seedChat(record: ChatRecord): void {
  storage.set('chat-ids', [...((storage.get('chat-ids') as string[] | undefined) ?? []), record.id])
  storage.set(`chat:${record.id}`, record)
  storage.set(`meta:${record.id}`, {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preview: 'hi',
    origin: record.origin,
  })
}

/** Import a fresh copy of the module (its socket/panel state is module-level). */
async function loadBridge(): Promise<typeof import('./bridge')> {
  vi.resetModules()
  return import('./bridge')
}

/** Let the storage promises inside an op settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  installChrome()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bridge socket', () => {
  it('dials the configured port and introduces itself on open', async () => {
    storage.set('settings', { bridgePort: 9999 })
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()

    expect(FakeSocket.last?.url).toBe('ws://127.0.0.1:9999/ext')
    FakeSocket.last?.open()
    expect(FakeSocket.last?.frames()[0]).toMatchObject({
      t: 'hello',
      extensionId: 'test-extension-id',
      version: '9.9.9',
      panelOpen: false,
    })
  })

  it('stays off the network when the user disabled the bridge', async () => {
    storage.set('settings', { bridgeEnabled: false })
    FakeSocket.last = undefined
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    expect(FakeSocket.last).toBeUndefined()
  })

  it('redials at once when the panel opens after a failed dial, and says the panel is open', async () => {
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    // Daemon refused the connection: a backoff is now armed.
    FakeSocket.last?.close()
    const failed = FakeSocket.last

    connectListener?.(makePort('handoff-bridge-panel'))
    expect(FakeSocket.last).not.toBe(failed)
    FakeSocket.last?.open()
    expect(FakeSocket.last?.frames()[0]).toMatchObject({ t: 'hello', panelOpen: true })
  })

  it('answers a ping', async () => {
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()
    FakeSocket.last?.deliver({ t: 'ping' })
    expect(FakeSocket.last?.frames().some((frame) => frame.t === 'pong')).toBe(true)
  })
})

describe('read ops (no panel required)', () => {
  it('serves a chat summary out of storage with the panel closed', async () => {
    seedChat({
      id: 'chat-a',
      title: 'Resume research',
      createdAt: 1,
      updatedAt: 2,
      modelId: 'grok-4',
      messages: [],
      transcript: [
        { kind: 'user', id: 'u1', text: 'who am I', at: 1 },
        { kind: 'text', id: 't1', agentId: 'main', text: 'You work at Acme.', streaming: false },
      ],
      origin: { kind: 'external', client: 'claude-code', at: 1 },
    })
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()

    FakeSocket.last?.deliver({ t: 'req', id: 'r1', op: 'get', chatId: 'chat-a' })
    await settle()

    const response = FakeSocket.last?.frames().find((frame) => frame.id === 'r1')
    expect(response).toMatchObject({ t: 'res', ok: true })
    expect(response?.result).toMatchObject({
      chatId: 'chat-a',
      text: 'You work at Acme.',
      status: 'idle',
      origin: { client: 'claude-code' },
    })
  })

  it('lists chats with their provenance', async () => {
    seedChat({ id: 'chat-b', title: 'B', createdAt: 1, updatedAt: 2, modelId: 'm', messages: [], transcript: [] })
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()
    FakeSocket.last?.deliver({ t: 'req', id: 'r2', op: 'list' })
    await settle()

    const response = FakeSocket.last?.frames().find((frame) => frame.id === 'r2')
    expect((response?.result as { chats: unknown[] }).chats).toHaveLength(1)
  })

  it('reports a missing chat as not_found rather than crashing', async () => {
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()
    FakeSocket.last?.deliver({ t: 'req', id: 'r3', op: 'get', chatId: 'nope' })
    await settle()

    expect(FakeSocket.last?.frames().find((frame) => frame.id === 'r3')).toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })
})

describe('write ops', () => {
  it('fails fast with panel_closed, a notification, and a badge', async () => {
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()
    FakeSocket.last?.deliver({ t: 'req', id: 'r4', op: 'ask', prompt: 'hi', client: 'claude-code' })
    await settle()

    expect(FakeSocket.last?.frames().find((frame) => frame.id === 'r4')).toMatchObject({
      ok: false,
      code: 'panel_closed',
    })
    expect(notifications).toHaveLength(1)
    expect(String(notifications[0]?.message)).toContain('claude-code')
    expect(badges).toContain('!')
  })

  it('forwards to the panel and relays its answer', async () => {
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()

    const panel = makePort('handoff-bridge-panel')
    connectListener?.(panel)
    FakeSocket.last?.deliver({ t: 'req', id: 'r5', op: 'ask', prompt: 'hi', client: 'cursor' })
    await settle()

    const forwarded = panel.posted[0] as { type: string; id: string; op: string }
    expect(forwarded).toMatchObject({ type: 'op', id: 'r5', op: 'ask' })

    panel.emit({ type: 'result', id: 'r5', ok: true, result: { chatId: 'chat-new' } })
    await settle()
    expect(FakeSocket.last?.frames().find((frame) => frame.id === 'r5')).toMatchObject({
      ok: true,
      result: { chatId: 'chat-new' },
    })
  })

  it('forwards filesystem ops to the panel and relays the file payload', async () => {
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()

    const panel = makePort('handoff-bridge-panel')
    connectListener?.(panel)
    FakeSocket.last?.deliver({
      t: 'req',
      id: 'r6',
      op: 'fs_write',
      path: '/workspace/inbox/resume.pdf',
      base64: 'JVBERg==',
      client: 'claude-code',
    })
    await settle()

    expect(panel.posted[0]).toMatchObject({ type: 'op', id: 'r6', op: 'fs_write' })
    panel.emit({ type: 'result', id: 'r6', ok: true, result: { path: '/workspace/inbox/resume.pdf', size: 5 } })
    await settle()
    expect(FakeSocket.last?.frames().find((frame) => frame.id === 'r6')).toMatchObject({
      ok: true,
      result: { path: '/workspace/inbox/resume.pdf' },
    })
  })

  it('answers a filesystem op with panel_closed when the panel is gone', async () => {
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()
    FakeSocket.last?.deliver({ t: 'req', id: 'r7', op: 'fs_list', client: 'claude-code' })
    await settle()

    expect(FakeSocket.last?.frames().find((frame) => frame.id === 'r7')).toMatchObject({
      ok: false,
      code: 'panel_closed',
    })
    expect(String(notifications[0]?.message)).toContain('files')
  })

  it('relays running/idle transitions and clears them when the panel closes', async () => {
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()

    const panel = makePort('handoff-bridge-panel')
    connectListener?.(panel)
    expect(FakeSocket.last?.frames().some((frame) => frame.ev === 'panel' && frame.open === true)).toBe(true)

    panel.emit({ type: 'chat', chatId: 'chat-c', running: true, title: 'T', updatedAt: 5 })
    expect(FakeSocket.last?.frames().at(-1)).toMatchObject({ ev: 'chat', chatId: 'chat-c', running: true })

    panel.disconnect()
    expect(FakeSocket.last?.frames().at(-1)).toMatchObject({ ev: 'panel', open: false })

    // The runtime died with the panel, so nothing is running any more.
    FakeSocket.last?.deliver({ t: 'req', id: 'r6', op: 'status' })
    await settle()
    expect(FakeSocket.last?.frames().find((frame) => frame.id === 'r6')?.result).toMatchObject({
      panelOpen: false,
      runningChatIds: [],
    })
  })

  it('rejects an in-flight forward when the panel disappears mid-op', async () => {
    const bridge = await loadBridge()
    bridge.initBridge()
    await settle()
    FakeSocket.last?.open()

    const panel = makePort('handoff-bridge-panel')
    connectListener?.(panel)
    FakeSocket.last?.deliver({ t: 'req', id: 'r7', op: 'follow', chatId: 'chat-c', text: 'more' })
    await settle()
    panel.disconnect()
    await settle()

    expect(FakeSocket.last?.frames().find((frame) => frame.id === 'r7')).toMatchObject({
      ok: false,
      code: 'panel_closed',
    })
  })
})
