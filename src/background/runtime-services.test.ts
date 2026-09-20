import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBackgroundRuntimeServices } from './runtime-services'
import type { CdpService } from '../shared/types'
import type { OffscreenRuntimeMessage } from '../shared/execution-protocol'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(() => new Promise(() => {})) } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('bounds a VFS read when the offscreen document never replies', async () => {
  const services = createBackgroundRuntimeServices({} as CdpService, async () => {})
  const pending = services.vfs.readText('/workspace/a.txt')
  const rejected = expect(pending).rejects.toThrow('VFS readText: offscreen runtime did not respond')
  await vi.advanceTimersByTimeAsync(35_000)
  await rejected
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'vfs.cancel' }))
  expect(vi.getTimerCount()).toBe(0)
})

it('enforces the sandbox wall limit outside the frozen document and revokes its dispatch', async () => {
  const dispatch = vi.fn(async () => null)
  const services = createBackgroundRuntimeServices({} as CdpService, async () => {})
  const pending = services.sandbox.exec({ code: 'while(true){}', sessionId: 'test', dispatch, timeoutMs: 1000, wallTimeoutMs: 1000 })
  const rejected = expect(pending).rejects.toThrow('Code execution: offscreen runtime did not respond')
  await vi.advanceTimersByTimeAsync(3000)
  await rejected
  const messages = vi.mocked(chrome.runtime.sendMessage).mock.calls.map(c => c[0]) as unknown as OffscreenRuntimeMessage[]
  const exec = messages.find((m): m is Extract<OffscreenRuntimeMessage, { type: 'sandbox.exec' }> => m.type === 'sandbox.exec')!
  await expect(services.handleMessage({ target: 'background', type: 'sandbox.api', execId: exec.execId, path: 'fs.writeText', args: [] })).rejects.toThrow('no longer active')
  expect(dispatch).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds offscreen startup before a request is dispatched', async () => {
  const services = createBackgroundRuntimeServices({} as CdpService, () => new Promise(() => {}))
  const rejected = expect(services.vfs.list()).rejects.toThrow('Starting file service: offscreen runtime did not respond')
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

function lastExec(): Extract<OffscreenRuntimeMessage, { type: 'sandbox.exec' }> {
  const messages = vi.mocked(chrome.runtime.sendMessage).mock.calls.map(c => c[0]) as unknown as OffscreenRuntimeMessage[]
  return messages.find((message): message is Extract<OffscreenRuntimeMessage, { type: 'sandbox.exec' }> => message.type === 'sandbox.exec')!
}

it('stops frozen code immediately and clears the host deadline', async () => {
  const controller = new AbortController()
  const services = createBackgroundRuntimeServices({} as CdpService, async () => {})
  const pending = services.sandbox.exec({ code: 'while(true){}', sessionId: 'test', signal: controller.signal })
  const stopped = expect(pending).rejects.toThrow('Stopped')
  await vi.advanceTimersByTimeAsync(0)
  const execId = lastExec().execId
  controller.abort(new Error('Stopped'))
  await stopped
  await expect(services.handleMessage({ target: 'background', type: 'sandbox.api', execId, path: 'fs.writeText', args: [] })).rejects.toThrow('no longer active')
  expect(vi.getTimerCount()).toBe(0)
})

it('joins an already dispatched mutation after Stop without waiting for the frozen document', async () => {
  const controller = new AbortController()
  let finishWrite!: (value: null) => void
  const dispatch = vi.fn(() => new Promise<null>(resolve => { finishWrite = resolve }))
  const services = createBackgroundRuntimeServices({} as CdpService, async () => {})
  const pending = services.sandbox.exec({ code: 'await api.fs.writeText(path, text)', sessionId: 'test', signal: controller.signal, dispatch })
  const stopped = expect(pending).rejects.toThrow('Stopped')
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await vi.advanceTimersByTimeAsync(0)
  const execId = lastExec().execId
  const write = services.handleMessage({ target: 'background', type: 'sandbox.api', execId, path: 'fs.writeText', args: [] })
  const writeStopped = expect(write).rejects.toThrow('Stopped')
  controller.abort(new Error('Stopped'))
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  await expect(services.handleMessage({ target: 'background', type: 'sandbox.api', execId, path: 'fs.writeText', args: [] })).rejects.toThrow('no longer active')
  expect(dispatch).toHaveBeenCalledOnce()
  finishWrite(null)
  await writeStopped
  await stopped
  expect(vi.getTimerCount()).toBe(0)
})

it('does not join a stalled filesystem read after Stop', async () => {
  const controller = new AbortController()
  const services = createBackgroundRuntimeServices({} as CdpService, async () => {})
  const pending = services.sandbox.exec({ code: 'await api.fs.readText(path)', sessionId: 'test', signal: controller.signal, dispatch: () => new Promise(() => {}) })
  const stopped = expect(pending).rejects.toThrow('Stopped')
  await vi.advanceTimersByTimeAsync(0)
  const read = services.handleMessage({ target: 'background', type: 'sandbox.api', execId: lastExec().execId, path: 'fs.readText', args: [] })
  const readStopped = expect(read).rejects.toThrow('Stopped')
  controller.abort(new Error('Stopped'))
  await readStopped
  await stopped
  expect(vi.getTimerCount()).toBe(0)
})

it('clears the startup deadline on Stop', async () => {
  const controller = new AbortController()
  const services = createBackgroundRuntimeServices({} as CdpService, () => new Promise(() => {}))
  const pending = services.sandbox.exec({ code: '1', sessionId: 'test', signal: controller.signal })
  const stopped = expect(pending).rejects.toThrow('Stopped')
  controller.abort(new Error('Stopped'))
  await stopped
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['fs.readText', 'fetch', 'fs.writeText'])('does not let a stalled %s defeat the sandbox wall limit during cleanup', async (path) => {
  const services = createBackgroundRuntimeServices({} as CdpService, async () => {})
  let executionError: unknown
  const pending = services.sandbox.exec({
    code: 'await api.call()', sessionId: 'test', timeoutMs: 1000, wallTimeoutMs: 1000,
    dispatch: () => new Promise(() => {}),
  }).catch(error => { executionError = error })
  await vi.advanceTimersByTimeAsync(0)
  const execId = lastExec().execId
  let apiError: unknown
  const api = services.handleMessage({ target: 'background', type: 'sandbox.api', execId, path, args: [] })!
    .catch(error => { apiError = error })
  await vi.advanceTimersByTimeAsync(3000)
  expect(executionError).toBeInstanceOf(Error)
  expect(apiError).toBeInstanceOf(Error)
  await Promise.all([pending, api])
  await expect(services.handleMessage({ target: 'background', type: 'sandbox.api', execId, path, args: [] })).rejects.toThrow('no longer active')
  expect(vi.getTimerCount()).toBe(0)
})

it('aborts the real API dispatcher on timeout even when fetch ignores cancellation', async () => {
  const fetch = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetch)
  const services = createBackgroundRuntimeServices({} as CdpService, async () => {})
  const pending = services.sandbox.exec({ code: 'await api.fetch(url)', sessionId: 'test', timeoutMs: 1000, wallTimeoutMs: 1000 })
  const rejected = expect(pending).rejects.toThrow('including pending API calls')
  await vi.advanceTimersByTimeAsync(0)
  const api = services.handleMessage({ target: 'background', type: 'sandbox.api', execId: lastExec().execId, path: 'fetch', args: ['https://example.test/stall'] })!
  const apiRejected = expect(api).rejects.toThrow('including pending API calls')
  await vi.advanceTimersByTimeAsync(3000)
  await Promise.all([rejected, apiRejected])
  expect(fetch).toHaveBeenCalledOnce()
  expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the deadline armed after an iframe returns with an unawaited API call', async () => {
  let finishExec!: (value: unknown) => void
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(resolve => { finishExec = resolve }))
  const services = createBackgroundRuntimeServices({} as CdpService, async () => {})
  const pending = services.sandbox.exec({ code: 'void api.fetch(url)', sessionId: 'test', timeoutMs: 1000, wallTimeoutMs: 1000, dispatch: () => new Promise(() => {}) })
  const rejected = expect(pending).rejects.toThrow('including pending API calls')
  await vi.advanceTimersByTimeAsync(0)
  const api = services.handleMessage({ target: 'background', type: 'sandbox.api', execId: lastExec().execId, path: 'fetch', args: [] })!
  const apiRejected = expect(api).rejects.toThrow('including pending API calls')
  finishExec({ ok: true, logs: [], durationMs: 1 })
  await vi.advanceTimersByTimeAsync(3000)
  await Promise.all([rejected, apiRejected])
  expect(vi.getTimerCount()).toBe(0)
})
