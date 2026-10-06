import { beginDiagnosticOperation } from '../shared/runtime-diagnostics'
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai'
import { abortable, throwIfAborted } from '../shared/abort'

/** A silent provider request must not leave an agent running forever. */
export const MODEL_IDLE_TIMEOUT_MS = 120_000
/** Tool arguments should arrive continuously once generation has started. */
export const MODEL_TOOL_INPUT_IDLE_TIMEOUT_MS = 30_000

export class ModelIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Model request stalled: no response progress for ${Math.round(timeoutMs / 1000)} seconds.`)
    this.name = 'ModelIdleTimeoutError'
  }
}

/**
 * Lives INSIDE rate-limit admission/retry, and outside tool execution. Each
 * actual provider attempt gets its own timer and abort signal. It covers both
 * a fetch that never returns headers and a stream that stops yielding chunks;
 * tool execution and intentional rate-limit sleeps consume none of this time.
 *
 * The request middleware owns bounded retries before output. This wrapper never replays
 * a request itself, so it cannot repeat a tool that already ran.
 */
export function withModelIdleTimeout(model: LanguageModel, timeoutMs = MODEL_IDLE_TIMEOUT_MS, context: { chatId?: string; agentId?: string } = {}): LanguageModel {
  if (typeof model === 'string' || model.specificationVersion !== 'v3') return model
  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v3',
    wrapStream: async ({ model: inner, params }) => {
      const diagnostic = beginDiagnosticOperation('model', inner.modelId, { ...context, timeoutMs, idleTimeout: true, lastProgressAt: Date.now() })
      diagnostic.update('waiting for response headers')
      const controller = new AbortController()
      const signal = params.abortSignal
        ? AbortSignal.any([params.abortSignal, controller.signal])
        : controller.signal
      let timer: ReturnType<typeof setTimeout> | undefined
      const preparingTools = new Set<string>()
      const idleLimit = (): number => preparingTools.size > 0 ? Math.min(timeoutMs, MODEL_TOOL_INPUT_IDLE_TIMEOUT_MS) : timeoutMs
      const clear = (): void => { clearTimeout(timer); timer = undefined }
      const arm = (): void => {
        clear()
        const limit = idleLimit()
        timer = setTimeout(() => controller.abort(new ModelIdleTimeoutError(limit)), limit)
      }
      arm()
      let response: Awaited<ReturnType<typeof inner.doStream>>
      try {
        throwIfAborted(signal)
        const pending = Promise.resolve(inner.doStream({ ...params, abortSignal: signal }))
        // An adapter can ignore abort and return headers after we timed out.
        // Release that late body instead of leaving its connection open.
        void pending.then((late) => {
          if (signal.aborted) void late.stream.cancel(signal.reason).catch(() => {})
        }, () => {})
        response = await abortable(pending, signal)
      } catch (error) {
        diagnostic.finish(signal.aborted ? signal.reason : error)
        clear()
        throw signal.aborted ? signal.reason : error
      }
      diagnostic.update('waiting for stream data')
      const reader = response.stream.getReader()
      return {
        ...response,
        stream: new ReadableStream({
          async pull(target) {
            try {
              throwIfAborted(signal)
              const { done, value } = await abortable(reader.read(), signal)
              if (done) {
                diagnostic.finish()
                clear()
                target.close()
                reader.releaseLock()
                return
              }
              const progress = value.type !== 'stream-start' && value.type !== 'response-metadata' && value.type !== 'raw' &&
                (!('delta' in value) || value.delta.trim().length > 0)
              if (value.type === 'tool-input-start' || value.type === 'tool-input-delta') preparingTools.add(value.id)
              else if (value.type === 'tool-call') preparingTools.delete(value.toolCallId)
              diagnostic.update(`streaming: ${value.type}`, { timeoutMs: idleLimit(), ...(progress ? { lastProgressAt: Date.now() } : {}) })
              target.enqueue(value)
              // The SDK waits for provider EOF as well as all tool results.
              // A terminal event already completes this request: close here
              // instead of disabling the timer and waiting forever for EOF.
              if (value.type === 'finish' || value.type === 'error') {
                diagnostic.finish(value.type === 'error' ? value.error : undefined)
                clear()
                target.close()
                void reader.cancel().catch(() => {})
                reader.releaseLock()
              } else if (progress) {
                // Connection metadata/heartbeats and whitespace-only deltas are not
                // generation progress. Otherwise a queued or broken stream
                // can keep an agent at "waiting for model response" forever.
                arm()
              }
            } catch (error) {
              clear()
              const reason = signal.aborted ? signal.reason : error
              diagnostic.finish(reason)
              target.error(reason)
              void reader.cancel(reason).catch(() => {})
              reader.releaseLock()
            }
          },
          cancel(reason) {
            diagnostic.finish(reason)
            clear()
            controller.abort(reason)
            // A broken provider must not hold task cancellation hostage.
            void reader.cancel(reason).catch(() => {})
          },
        }),
      }
    },
  }
  return wrapLanguageModel({ model, middleware })
}
