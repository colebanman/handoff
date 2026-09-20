import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { withModelIdleTimeout, ModelIdleTimeoutError } from './model-idle-timeout'

type Part = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never

const params = { prompt: [] }
const finish: Part = {
  type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
}

afterEach(() => vi.useRealTimers())

describe('model inactivity timeout', () => {
  it('aborts a provider that never returns headers, even if it ignores abort', async () => {
    vi.useFakeTimers()
    const model = new MockLanguageModelV3({ doStream: () => new Promise(() => {}) })
    const guarded = withModelIdleTimeout(model, 100) as MockLanguageModelV3
    const result = guarded.doStream(params)
    const rejected = expect(result).rejects.toBeInstanceOf(ModelIdleTimeoutError)
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(model.doStreamCalls[0]!.abortSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts an open but silent stream and releases its reader', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream<Part>({ cancel }) }) })
    const guarded = withModelIdleTimeout(model, 100) as MockLanguageModelV3
    const reader = (await guarded.doStream(params)).stream.getReader()
    const rejected = expect(reader.read()).rejects.toBeInstanceOf(ModelIdleTimeoutError)
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(model.doStreamCalls[0]!.abortSignal?.aborted).toBe(true)
  })

  it.each(['text-delta', 'reasoning-delta', 'tool-input-delta'] as const)('resets on %s progress and stops timing after provider finish', async (type) => {
    vi.useFakeTimers()
    let source!: ReadableStreamDefaultController<Part>
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream<Part>({ start(c) { source = c } }) }) })
    const guarded = withModelIdleTimeout(model, 100) as MockLanguageModelV3
    const reader = (await guarded.doStream(params)).stream.getReader()
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(90)
      source.enqueue({ type, id: 'text', delta: 'progress' })
      expect((await reader.read()).value?.type).toBe(type)
    }
    source.enqueue(finish)
    await reader.read()
    // Tools may still be executing long after the provider has finished.
    await vi.advanceTimersByTimeAsync(1000)
    expect(model.doStreamCalls[0]!.abortSignal?.aborted).toBe(false)
    // The wrapper closes on the terminal event; it must not depend on EOF.
    expect((await reader.read()).done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels immediately and cleans its timer on user stop', async () => {
    vi.useFakeTimers()
    const user = new AbortController()
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream<Part>() }) })
    const guarded = withModelIdleTimeout(model, 100) as MockLanguageModelV3
    const reader = (await guarded.doStream({ ...params, abortSignal: user.signal })).stream.getReader()
    const rejected = expect(reader.read()).rejects.toThrow('User stopped')
    user.abort(new Error('User stopped'))
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each<Part>([
    { type: 'response-metadata', id: 'queued-response' },
    { type: 'raw', rawValue: { type: 'ping' } },
    { type: 'text-delta', id: 'text', delta: '' },
  ])('does not let $type without output postpone the deadline', async (part) => {
    vi.useFakeTimers()
    let source!: ReadableStreamDefaultController<Part>
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream<Part>({ start(c) { source = c } }) }) })
    const guarded = withModelIdleTimeout(model, 100) as MockLanguageModelV3
    const reader = (await guarded.doStream(params)).stream.getReader()
    await vi.advanceTimersByTimeAsync(90)
    source.enqueue(part)
    await reader.read()
    let error: unknown
    const next = reader.read().catch(reason => { error = reason })
    await vi.advanceTimersByTimeAsync(10)
    expect(error).toBeInstanceOf(ModelIdleTimeoutError)
    await next
    expect(vi.getTimerCount()).toBe(0)
  })
})
