import { afterEach, describe, expect, it, vi } from 'vitest'
import { stepCountIs, streamText, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import { ModelIdleTimeoutError, withModelIdleTimeout } from './model-idle-timeout'
import { withRateLimitRetry } from './rate-limit'

type StreamPart = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
const finish: StreamPart = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
function wrap(model: MockLanguageModelV3) {
  const result = withModelIdleTimeout(model, 100)
  if (typeof result === 'string' || result.specificationVersion !== 'v3') throw new Error('Expected v3 model')
  return result
}
function chunks(parts: StreamPart[]) {
  return new ReadableStream<StreamPart>({ start(c) { parts.forEach((part) => c.enqueue(part)); c.close() } })
}
afterEach(() => vi.useRealTimers())

describe('model stream lifecycle', () => {
  it('retries a metadata-only stream once, then fails instead of waiting forever', async () => {
    vi.useFakeTimers()
    const model = new MockLanguageModelV3({ doStream: async () => {
      let timer: ReturnType<typeof setInterval>
      return { stream: new ReadableStream<StreamPart>({
        start(c) { timer = setInterval(() => c.enqueue({ type: 'response-metadata', id: 'queued' }), 20) },
        cancel() { clearInterval(timer) },
      }) }
    } })
    const guarded = withRateLimitRetry(wrap(model)) as MockLanguageModelV3
    const reader = (await guarded.doStream({ prompt: [] })).stream.getReader()
    const rejected = expect(reader.read()).rejects.toBeInstanceOf(ModelIdleTimeoutError)
    await vi.advanceTimersByTimeAsync(700)
    await rejected
    expect(model.doStreamCalls).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out stalled headers and cancels a late response body', async () => {
    vi.useFakeTimers()
    let deliver!: (result: { stream: ReadableStream<StreamPart> }) => void
    const model = new MockLanguageModelV3({ doStream: () => new Promise((resolve) => { deliver = resolve }) })
    const request = wrap(model).doStream({ prompt: [] })
    const rejected = expect(request).rejects.toBeInstanceOf(ModelIdleTimeoutError)
    await vi.advanceTimersByTimeAsync(101)
    await rejected
    expect(model.doStreamCalls[0]!.abortSignal!.aborted).toBe(true)
    const cancel = vi.fn()
    deliver({ stream: new ReadableStream({ cancel }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a silent stream and releases its reader on timeout', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ cancel }) }) })
    const response = await wrap(model).doStream({ prompt: [] })
    const reader = response.stream.getReader()
    const rejected = expect(reader.read()).rejects.toBeInstanceOf(ModelIdleTimeoutError)
    await vi.advanceTimersByTimeAsync(101)
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['finish', 'error'] as const)('closes at %s even if provider cancellation never resolves', async (type) => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const part: StreamPart = type === 'finish' ? finish : { type: 'error', error: new Error('Rejected') }
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({
      start(c) { c.enqueue(part) }, cancel,
    }) }) })
    const response = await wrap(model).doStream({ prompt: [] })
    const reader = response.stream.getReader()
    expect((await reader.read()).value).toEqual(part)
    expect((await reader.read()).done).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors user cancellation while the provider ignores its abort signal', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const cancel = vi.fn()
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ cancel }) }) })
    const response = await wrap(model).doStream({ prompt: [], abortSignal: controller.signal })
    const reader = response.stream.getReader()
    const rejected = expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not time out a local tool that runs longer than the provider timeout', async () => {
    vi.useFakeTimers()
    let finishTool!: (value: string) => void
    const execute = vi.fn(() => new Promise<string>((resolve) => { finishTool = resolve }))
    let calls = 0
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: chunks(++calls === 1 ? [
      { type: 'tool-call', toolCallId: 'long-tool', toolName: 'wait', input: '{}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
    ] : [finish]) }) })
    const result = streamText({ model: wrap(model), prompt: 'Wait for work.',
      tools: { wait: tool({ inputSchema: z.object({}), execute }) }, stopWhen: stepCountIs(2),
    })
    const consumed = result.consumeStream()
    await vi.advanceTimersByTimeAsync(0)
    expect(execute).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(model.doStreamCalls[0]!.abortSignal!.aborted).toBe(false)
    finishTool('Completed')
    await consumed
    expect((await result.steps).length).toBe(2)
    expect(execute).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not time out intentional rate-limit backoff', async () => {
    vi.useFakeTimers()
    let calls = 0
    const onWait = vi.fn()
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: chunks(++calls === 1 ? [
      { type: 'error', error: { code: 'rate_limit_exceeded', message: 'Please try again in 1s.' } },
    ] : [finish]) }) })
    const result = streamText({ model: withRateLimitRetry(wrap(model), { onWait }), prompt: 'Reply.' })
    const consumed = result.consumeStream()
    await vi.advanceTimersByTimeAsync(0)
    expect(onWait).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2000)
    await consumed
    expect(await result.finishReason).toBe('stop')
    expect(calls).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
