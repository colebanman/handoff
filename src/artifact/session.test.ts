import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactBackgroundToViewer, ArtifactDocumentToHost, ArtifactHostToDocument } from '../shared/artifacts'
import type { VirtualFileSystemService } from '../shared/types'
import { createArtifactSession } from './session'

vi.mock('../storage/settings', () => ({ loadSettings: async () => ({ theme: 'dark' }) }))

let receive: (event: { source: unknown; data: ArtifactDocumentToHost }) => void
let request: (message: ArtifactBackgroundToViewer) => void
let posted: unknown[]
let frames: ArtifactHostToDocument[]
const contentWindow = { postMessage: (message: ArtifactHostToDocument) => {
  frames.push(message)
  if (message.kind === 'artifact-frame-ping') queueMicrotask(() => receive({ source: contentWindow, data: { kind: 'artifact-frame-ready' } }))
} }
const emit = (data: ArtifactDocumentToHost) => receive({ source: contentWindow, data })

beforeEach(() => {
  vi.useFakeTimers()
  posted = []; frames = []
  vi.stubGlobal('window', { addEventListener: (_: string, fn: typeof receive) => { receive = fn }, removeEventListener: vi.fn() })
  vi.stubGlobal('chrome', { runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    connect: () => ({
      postMessage: (message: unknown) => posted.push(message), disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof request) => { request = fn } },
      onDisconnect: { addListener: vi.fn() },
    }),
  } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('artifact session lifetime', () => {
  const create = () => {
    const session = createArtifactSession({ path: '/workspace/test.html', embed: false, vfs: {} as VirtualFileSystemService })
    session.attachFrame({ contentWindow } as HTMLIFrameElement)
    return session
  }
  it('recovers a ready message sent before attachment without leaving a timer', async () => {
    const session = create()
    await session.render('<h1>Ready</h1>')
    expect(frames).toContainEqual(expect.objectContaining({ kind: 'artifact-render' }))
    expect(vi.getTimerCount()).toBe(0)
    session.dispose()
  })
  it.each(['reload', 'dispose'] as const)('settles pending requests on %s', async (action) => {
    const session = create()
    await session.render('<h1>Ready</h1>')
    emit({ kind: 'artifact-ready' })
    request({ type: 'request', requestId: 'eval', op: 'eval', code: 'new Promise(() => {})' })
    expect(frames).toContainEqual(expect.objectContaining({ kind: 'artifact-request' }))
    if (action === 'reload') await session.render('<h1>Changed</h1>')
    else session.dispose()
    await vi.advanceTimersByTimeAsync(0)
    if (action === 'reload') expect(posted).toContainEqual(expect.objectContaining({ type: 'response', requestId: 'eval', ok: false, error: expect.stringContaining('reloaded') }))
    expect(vi.getTimerCount()).toBe(0)
    session.dispose()
  })
})
