import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostToSandbox, SandboxToHost } from '../shared/rpc'

let receive: (event: { data: HostToSandbox }) => void
let outbound: SandboxToHost[]
const send = (data: HostToSandbox) => receive({ data })
const result = (execId: string) => outbound.find(
  (message): message is Extract<SandboxToHost, { kind: 'exec-result' }> => message.kind === 'exec-result' && message.execId === execId,
)
async function exec(execId: string, code: string, sessionId = 'chat') {
  send({ kind: 'exec', execId, sessionId, code, timeoutMs: 1000 })
  await vi.advanceTimersByTimeAsync(0)
  return result(execId)
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  outbound = []
  vi.stubGlobal('window', { addEventListener: (_type: string, listener: typeof receive) => { receive = listener } })
  vi.stubGlobal('parent', { postMessage: (message: SandboxToHost) => {
    outbound.push(message)
    if (message.kind === 'api-call') queueMicrotask(() => send({
      kind: 'api-result', execId: message.execId, callId: message.callId, ok: true, value: { ok: true, text: 'saved data' },
    }))
  } })
  await import('./sandbox')
})
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(1000)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('persistent sandbox helpers', () => {
  it.each([
    ['state.getCanvas = async path => api.fetch(path);', 'await state.getCanvas("/courses")'],
    ['state.fetch = api.fetch;', 'await state.fetch("/courses")'],
    ['state.savedApi = api;', 'await state.savedApi.fetch("/courses")'],
  ])('rejects an expired API immediately instead of losing its reply: %s', async (define, call) => {
    expect((await exec('define', define))?.ok).toBe(true)
    const completed = await exec('reuse', call)
    expect(completed).toMatchObject({ ok: false, error: expect.stringContaining('completed sandbox execution') })
    expect(completed?.error).toContain('current api as an argument')
    expect(outbound.filter((message) => message.kind === 'api-call')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows a persistent helper to receive the current api explicitly', async () => {
    await exec('define', 'state.getCanvas = async (client, path) => client.fetch(path); state.count = 4;')
    const completed = await exec('reuse', 'const data = await state.getCanvas(api, "/courses"); return { data, count: ++state.count };')
    expect(completed?.ok).toBe(true)
    expect(JSON.parse(completed!.value!)).toEqual({ data: { ok: true, text: 'saved data' }, count: 5 })
    expect(outbound.filter((message) => message.kind === 'api-call')).toEqual([
      expect.objectContaining({ execId: 'reuse', path: 'fetch' }),
    ])
  })

  it('keeps API routing isolated for concurrent subagent sessions', async () => {
    send({ kind: 'exec', execId: 'a', sessionId: 'agent-a', code: 'return await api.fetch("/a")', timeoutMs: 1000 })
    send({ kind: 'exec', execId: 'b', sessionId: 'agent-b', code: 'return await api.fetch("/b")', timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(result('a')?.ok).toBe(true)
    expect(result('b')?.ok).toBe(true)
    expect(outbound.filter((message) => message.kind === 'api-call').map((message) => message.execId)).toEqual(['a', 'b'])
  })
})
