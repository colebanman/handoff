import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamText, stepCountIs, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import { isRetryableTransportError, withRateLimitRetry } from './rate-limit'

type Part = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
const finish: Part = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
const answer: Part[] = [{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'Recovered' }, { type: 'text-end', id: 'a' }, finish]
function response(parts: Part[]) {
  return { stream: new ReadableStream<Part>({ start(c) { for (const part of parts) c.enqueue(part); c.close() } }) }
}
async function collect(model: MockLanguageModelV3, signal?: AbortSignal) {
  const result = await (withRateLimitRetry(model) as MockLanguageModelV3).doStream({ prompt: [], abortSignal: signal })
  return readParts(result.stream)
}
async function readParts(stream: ReadableStream<Part>) {
  const parts: Part[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return parts
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}
afterEach(() => vi.useRealTimers())

describe('model request transport recovery', () => {
  it('recognizes Chrome fetch errors nested in provider errors', () => {
    expect(isRetryableTransportError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isRetryableTransportError({ cause: new TypeError('Failed to fetch') })).toBe(true)
    expect(isRetryableTransportError({ statusCode: 401, cause: new TypeError('Failed to fetch') })).toBe(false)
  })

  it.each(['headers', 'reader', 'error-part'])('recovers a failure at %s before content', async (mode) => {
    vi.useFakeTimers()
    let calls = 0
    const model = new MockLanguageModelV3({ doStream: async () => {
      if (++calls > 1) return response(answer)
      const error = new TypeError('Failed to fetch')
      if (mode === 'headers') throw error
      if (mode === 'error-part') return response([{ type: 'stream-start', warnings: [] }, { type: 'error', error }])
      return { stream: new ReadableStream<Part>({ start(c) { c.error(error) } }) }
    } })
    const result = collect(model)
    await vi.runAllTimersAsync()
    expect(await result).toEqual(answer)
    expect(calls).toBe(2)
  })

  it('retries the next model step without repeating a completed tool', async () => {
    vi.useFakeTimers()
    let calls = 0
    const execute = vi.fn(async () => 'saved notes')
    const model = new MockLanguageModelV3({ doStream: async () => {
      calls += 1
      if (calls === 1) return response([
        { type: 'tool-call', toolCallId: 'save-1', toolName: 'save', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ])
      if (calls === 2) throw new TypeError('Failed to fetch')
      return response(answer)
    } })
    const result = streamText({
      model: withRateLimitRetry(model), prompt: 'Save notes then answer', maxRetries: 0,
      tools: { save: tool({ inputSchema: z.object({}), execute }) }, stopWhen: stepCountIs(3),
    })
    const text = result.text
    await vi.runAllTimersAsync()
    expect(await text).toBe('Recovered')
    expect(execute).toHaveBeenCalledOnce()
    expect(model.doStreamCalls).toHaveLength(3)
    expect(model.doStreamCalls[2]!.prompt).toEqual(model.doStreamCalls[1]!.prompt)
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain('saved notes')
  })

  it('stops after two transport retries', async () => {
    vi.useFakeTimers()
    const model = new MockLanguageModelV3({ doStream: async () => { throw new TypeError('Failed to fetch') } })
    const rejected = expect(collect(model)).rejects.toThrow('Failed to fetch')
    await vi.runAllTimersAsync()
    await rejected
    expect(model.doStreamCalls).toHaveLength(3)
  })

  it('recovers a connection that closes after metadata without producing output', async () => {
    vi.useFakeTimers()
    let calls = 0
    const model = new MockLanguageModelV3({ doStream: async () => response(++calls === 1 ? [{ type: 'stream-start', warnings: [] }] : answer) })
    const result = collect(model)
    await vi.runAllTimersAsync()
    expect(await result).toEqual(answer)
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('cancels the active reader instead of trying to cancel its locked stream', async () => {
    const cancel = vi.fn()
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ cancel }) }) })
    const response = await (withRateLimitRetry(model) as MockLanguageModelV3).doStream({ prompt: [] })
    await response.stream.cancel()
    expect(cancel).toHaveBeenCalledOnce()
    expect(model.doStreamCalls[0]!.abortSignal!.aborted).toBe(true)
  })

  it('retries an empty abnormal finish but accepts an intentionally empty stop', async () => {
    vi.useFakeTimers()
    let calls = 0
    const emptyUsage = { ...usage, outputTokens: { total: 0, text: 0, reasoning: 0 } }
    const model = new MockLanguageModelV3({ doStream: async () => response([
      { ...finish, usage: emptyUsage, finishReason: ++calls === 1 ? { unified: 'other', raw: undefined } : finish.finishReason },
    ]) })
    const result = collect(model)
    await vi.runAllTimersAsync()
    expect(await result).toEqual([{ ...finish, usage: emptyUsage }])
    expect(calls).toBe(2)
  })

  it.each<Part>([
    { type: 'text-start', id: 'a' },
    { type: 'reasoning-start', id: 'r' },
    { type: 'tool-call', toolCallId: 'save-1', toolName: 'save', input: '{}' },
  ])('never replays after forwarding $type', async (part) => {
    const error: Part = { type: 'error', error: new TypeError('Failed to fetch') }
    const model = new MockLanguageModelV3({ doStream: async () => response([part, error]) })
    expect(await collect(model)).toEqual([part, error])
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('cancels during backoff without sending another request', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const model = new MockLanguageModelV3({ doStream: async () => { throw new TypeError('Failed to fetch') } })
    const rejected = expect(collect(model, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.runAllTimersAsync()
    await rejected
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('still honors rate limits independently of the transport retry budget', async () => {
    vi.useFakeTimers()
    let calls = 0
    const onWait = vi.fn()
    const onClear = vi.fn()
    const model = new MockLanguageModelV3({ doStream: async () => {
      calls += 1
      if (calls <= 3) throw { statusCode: 429, message: 'Rate limit. Please try again in 250ms.' }
      return response(answer)
    } })
    const wrapped = withRateLimitRetry(model, { onWait, onClear }) as MockLanguageModelV3
    const result = wrapped.doStream({ prompt: [] }).then(({ stream }) => readParts(stream))
    await vi.runAllTimersAsync()
    expect(await result).toEqual(answer)
    expect(onWait).toHaveBeenCalledTimes(3)
    expect(onClear).toHaveBeenCalledOnce()
  })
})
