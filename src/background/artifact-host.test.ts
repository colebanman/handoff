import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_INVOCATION_STORAGE_KEY, ARTIFACT_VIEWER_PORT } from '../shared/artifacts'
import type { CdpService } from '../shared/types'

let connect: (port: unknown) => void
let session: Record<string, unknown>
let created: Array<{ url: string; active: boolean }>
let removed: number[]
let sent: unknown[]

interface FakePort {
  posted: any[]
  send: (value: unknown) => void
  close: () => void
}

function viewer(path: string, opts: { tabId?: number; embed?: boolean } = {}): FakePort {
  let onMessage: (value: unknown) => void = () => {}
  let onDisconnect: () => void = () => {}
  const posted: any[] = []
  connect({
    name: ARTIFACT_VIEWER_PORT,
    sender: opts.tabId === undefined ? {} : { tab: { id: opts.tabId } },
    postMessage: (value: unknown) => posted.push(value),
    onMessage: { addListener: (fn: typeof onMessage) => { onMessage = fn } },
    onDisconnect: { addListener: (fn: typeof onDisconnect) => { onDisconnect = fn } },
  })
  onMessage({ type: 'hello', path, embed: opts.embed ?? false })
  return { posted, send: (value) => onMessage(value), close: () => onDisconnect() }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  session = {}
  created = []
  removed = []
  sent = []
  vi.stubGlobal('chrome', {
    runtime: {
      onConnect: { addListener: (fn: typeof connect) => { connect = fn } },
      sendMessage: vi.fn(async (message: unknown) => { sent.push(message) }),
      getURL: (path: string) => `chrome-extension://ext/${path}`,
    },
    tabs: {
      create: vi.fn(async (opts: { url: string; active: boolean }) => {
        created.push(opts)
        return { id: 100 + created.length, windowId: 1 }
      }),
      remove: vi.fn(async (tabId: number) => { removed.push(tabId) }),
      update: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1 })),
    },
    windows: { update: vi.fn(async () => ({})), WINDOW_ID_CURRENT: -2 },
    storage: {
      session: {
        get: vi.fn(async (key: string) => (key in session ? { [key]: structuredClone(session[key]) } : {})),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(session, structuredClone(values)) }),
        remove: vi.fn(async (key: string) => { delete session[key] }),
      },
    },
  })
})

async function host(cdp: Partial<CdpService> = {}) {
  const { createArtifactHost } = await import('./artifact-host')
  return createArtifactHost(cdp as CdpService)
}

describe('artifact host viewer registry', () => {
  it('rejects a pending eval immediately when its viewer closes', async () => {
    const artifacts = await host()
    const tab = viewer('/workspace/artifacts/a.html', { tabId: 7 })
    tab.send({ type: 'ready', path: '/workspace/artifacts/a.html' })
    const pending = artifacts.eval('/workspace/artifacts/a.html', 'new Promise(() => {})')
    const rejected = expect(pending).rejects.toThrow('closed before the request completed')
    await flush()
    tab.close()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('routes eval to a ready tab viewer and returns its answer', async () => {
    const artifacts = await host()
    const tab = viewer('/workspace/artifacts/a.html', { tabId: 7 })
    tab.send({ type: 'ready', path: '/workspace/artifacts/a.html' })

    const pending = artifacts.eval('/workspace/artifacts/a.html', 'document.title')
    await flush()
    const request = tab.posted.find((m) => m.type === 'request')
    expect(request).toMatchObject({ op: 'eval', code: 'document.title' })
    tab.send({ type: 'response', requestId: request.requestId, ok: true, value: { value: 'Week', logs: ['[log] hi'] } })
    await expect(pending).resolves.toEqual({ value: 'Week', logs: ['[log] hi'] })
    expect(created).toHaveLength(0)
    expect(artifacts.list()).toEqual([
      { path: '/workspace/artifacts/a.html', url: 'chrome-extension://ext/artifact.html?path=%2Fworkspace%2Fartifacts%2Fa.html', tabId: 7, embed: false, ready: true },
    ])
  })

  it('serves trace from an open viewer without opening tabs, and reset through a tab viewer', async () => {
    const artifacts = await host()
    await expect(artifacts.trace('/workspace/artifacts/none.html')).resolves.toEqual([])
    const tab = viewer('/workspace/artifacts/a.html', { tabId: 7 })
    tab.send({ type: 'ready', path: '/workspace/artifacts/a.html' })
    const trace = artifacts.trace('/workspace/artifacts/a.html')
    await flush()
    const request = tab.posted.find((m) => m.type === 'request' && m.op === 'trace')
    tab.send({ type: 'response', requestId: request.requestId, ok: true, value: [{ at: 1, path: 'fetch', args: 'u', ok: false, ms: 3, error: '403' }] })
    await expect(trace).resolves.toEqual([{ at: 1, path: 'fetch', args: 'u', ok: false, ms: 3, error: '403' }])

    const reset = artifacts.reset('/workspace/artifacts/a.html')
    await flush()
    const resetRequest = tab.posted.find((m) => m.type === 'request' && m.op === 'reset')
    tab.send({ type: 'response', requestId: resetRequest.requestId, ok: true, value: { ok: true } })
    await expect(reset).resolves.toBeUndefined()
    expect(created).toHaveLength(0)
  })

  it('opens a background tab when only an embed is showing the artifact, and auto-closes it when idle', async () => {
    const artifacts = await host()
    const embed = viewer('/workspace/artifacts/a.html', { embed: true })
    embed.send({ type: 'ready', path: '/workspace/artifacts/a.html' })

    const pending = artifacts.eval('/workspace/artifacts/a.html', '1 + 1')
    await flush()
    expect(created).toEqual([{ url: 'chrome-extension://ext/artifact.html?path=%2Fworkspace%2Fartifacts%2Fa.html', active: false }])

    const tab = viewer('/workspace/artifacts/a.html', { tabId: 101 })
    tab.send({ type: 'ready', path: '/workspace/artifacts/a.html' })
    await flush()
    const request = tab.posted.find((m) => m.type === 'request')
    tab.send({ type: 'response', requestId: request.requestId, ok: true, value: { value: 2, logs: [] } })
    await expect(pending).resolves.toEqual({ value: 2, logs: [] })
    expect(embed.posted.some((m) => m.type === 'request')).toBe(false)

    await vi.advanceTimersByTimeAsync(95_000)
    expect(removed).toEqual([101])
  })

  it('keeps tabs opened for the user and focuses them', async () => {
    const artifacts = await host()
    const opening = artifacts.open('/workspace/artifacts/b.html')
    await flush()
    const tab = viewer('/workspace/artifacts/b.html', { tabId: 101 })
    tab.send({ type: 'ready', path: '/workspace/artifacts/b.html' })
    await expect(opening).resolves.toEqual({
      tabId: 101,
      url: 'chrome-extension://ext/artifact.html?path=%2Fworkspace%2Fartifacts%2Fb.html',
      created: true,
    })
    expect(created[0]?.active).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(removed).toEqual([])
  })

  it('fails clearly when the viewer never becomes ready and removes the tab it opened', async () => {
    const artifacts = await host()
    const pending = artifacts.eval('/workspace/artifacts/missing.html', '1')
    pending.catch(() => {})
    await flush()
    await vi.advanceTimersByTimeAsync(13_000)
    await expect(pending).rejects.toThrow(/did not become ready/)
    expect(removed).toEqual([101])
  })

  it('falls back to a visible capture when the debugger refuses the tab', async () => {
    const captureVisibleTab = vi.fn(async () => 'data:image/png;base64,QUJD')
    ;(globalThis as any).chrome.tabs.captureVisibleTab = captureVisibleTab
    const artifacts = await host({ screenshot: vi.fn(async () => { throw new Error('Cannot attach') }) })
    const tab = viewer('/workspace/artifacts/a.html', { tabId: 7 })
    tab.send({ type: 'ready', path: '/workspace/artifacts/a.html' })
    const pending = artifacts.screenshot('/workspace/artifacts/a.html')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toEqual({ base64: 'QUJD', mediaType: 'image/png', tabId: 7 })
    expect(captureVisibleTab).toHaveBeenCalled()
  })
})

describe('artifact invocations', () => {
  it('queues an ai.invoke prompt for the panel and relays the answer back to the asking viewer', async () => {
    const artifacts = await host()
    const tab = viewer('/workspace/artifacts/news.html', { tabId: 7 })
    tab.send({ type: 'invoke', invokeId: 'inv-1', path: '/workspace/artifacts/news.html', prompt: 'Refresh headlines', chat: 'current' })
    await flush()
    expect(sent).toContainEqual({ target: 'ui', type: 'artifact.invoke.available' })

    const claimed = await artifacts.handleRuntimeMessage({ target: 'background', type: 'artifact.invoke.claim' })
    expect(claimed).toEqual({
      invocations: [expect.objectContaining({ id: 'inv-1', path: '/workspace/artifacts/news.html', prompt: 'Refresh headlines', chat: 'current' })],
    })
    expect(session[ARTIFACT_INVOCATION_STORAGE_KEY]).toBeUndefined()

    await artifacts.handleRuntimeMessage({
      target: 'background',
      type: 'artifact.invoke.result',
      invokeId: 'inv-1',
      ok: true,
      chatId: 'chat-9',
      text: 'Updated.',
    })
    expect(tab.posted).toContainEqual({
      type: 'invoke-result',
      invokeId: 'inv-1',
      ok: true,
      chatId: 'chat-9',
      text: 'Updated.',
      error: undefined,
    })
    expect(artifacts.handleRuntimeMessage({ target: 'ui', type: 'artifact.invoke.available' })).toBeUndefined()
  })
})
