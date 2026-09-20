import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSandboxService } from './host'
import type { HostToSandbox, SandboxToHost } from '../shared/rpc'
import type { CdpService, VirtualFileSystemService } from '../shared/types'

class FakeWindow {
  private listeners = new Set<(event: MessageEvent) => void>()
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') this.listeners.add(listener as (event: MessageEvent) => void)
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') this.listeners.delete(listener as (event: MessageEvent) => void)
  }
  emit(source: unknown, data: SandboxToHost): void {
    for (const listener of [...this.listeners]) listener({ source, data } as MessageEvent)
  }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('sandbox cancellation authority', () => {
  it('revokes a timed-out exec before a late API reply can resume its code', async () => {
    vi.useFakeTimers()
    const fakeWindow = new FakeWindow()
    const outbound: HostToSandbox[] = []
    const contentWindow = { postMessage: (message: HostToSandbox) => outbound.push(message) }
    const frame = { contentWindow, setAttribute: vi.fn(), style: {}, src: '' }
    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('document', {
      querySelector: () => null, createElement: () => frame,
      body: { appendChild: () => queueMicrotask(() => fakeWindow.emit(contentWindow, { kind: 'ready' })) },
    })
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path } })
    let finishApi!: (value: null) => void
    const service = createSandboxService({} as CdpService, {} as VirtualFileSystemService)
    const pending = service.exec({
      code: 'await api.fetch(url)', sessionId: 'test', timeoutMs: 1000, wallTimeoutMs: 1000,
      dispatch: () => new Promise(resolve => { finishApi = resolve }),
    })
    await vi.advanceTimersByTimeAsync(0)
    const exec = outbound.find((message): message is Extract<HostToSandbox, { kind: 'exec' }> => message.kind === 'exec')!
    fakeWindow.emit(contentWindow, { kind: 'api-call', execId: exec.execId, callId: 'late', path: 'fetch', args: [] })
    await vi.advanceTimersByTimeAsync(3500)
    expect((await pending).error).toContain('wall-clock ceiling')
    expect(outbound).toContainEqual(expect.objectContaining({ kind: 'cancel', execId: exec.execId }))
    finishApi(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(outbound.some(message => message.kind === 'api-result' && message.callId === 'late' && message.ok)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('prevents a delayed second side effect and waits for the in-flight dispatch before terminal cancellation', async () => {
    const fakeWindow = new FakeWindow()
    const outbound: HostToSandbox[] = []
    const contentWindow = { postMessage: (message: HostToSandbox) => outbound.push(message) }
    const frame = {
      contentWindow,
      setAttribute: vi.fn(),
      style: {},
      src: '',
    }
    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('document', {
      querySelector: () => null,
      createElement: () => frame,
      body: {
        appendChild: () => queueMicrotask(() => fakeWindow.emit(contentWindow, { kind: 'ready' })),
      },
    })
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path } })

    const service = createSandboxService({} as CdpService, {} as VirtualFileSystemService)
    const controller = new AbortController()
    const sideEffects: string[] = []
    let releaseFirst!: () => void
    const firstSettles = new Promise<void>((resolve) => { releaseFirst = resolve })
    const resultPromise = service.exec({
      code: 'test program',
      sessionId: 'test',
      signal: controller.signal,
      dispatch: async (_path, args) => {
        sideEffects.push(String(args[0]))
        if (args[0] === 'STARTED') await firstSettles
        return null
      },
    })

    await vi.waitFor(() => expect(outbound.some((message) => message.kind === 'exec')).toBe(true))
    const execId = (outbound.find((message) => message.kind === 'exec') as Extract<HostToSandbox, { kind: 'exec' }>).execId
    fakeWindow.emit(contentWindow, {
      kind: 'api-call', execId, callId: 'first', path: 'page.eval', args: ['STARTED'],
    })
    await vi.waitFor(() => expect(sideEffects).toEqual(['STARTED']))

    controller.abort(new DOMException('user stopped', 'AbortError'))
    let terminal = false
    void resultPromise.then(() => { terminal = true })
    await Promise.resolve()
    expect(terminal).toBe(false)
    expect(outbound).toContainEqual(expect.objectContaining({ kind: 'cancel', execId }))

    // This models the original program waking after its 12-second delay. Its
    // second api.* call reaches the host, but cancellation has revoked it.
    fakeWindow.emit(contentWindow, {
      kind: 'api-call', execId, callId: 'second', path: 'page.eval', args: ['COMPLETED'],
    })
    await Promise.resolve()
    expect(sideEffects).toEqual(['STARTED'])

    releaseFirst()
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toContain('user stopped')
    expect(sideEffects).toEqual(['STARTED'])
  })
})
