/**
 * Unlimited rate-limit retry and bounded transport retry for model calls.
 * Transport retries apply to each model step, including after tool results,
 * and stop as soon as this request forwards content (so tools cannot replay).
 *
 * OpenAI signals rate limits two ways: an HTTP 429 (doStream throws an
 * APICallError) or — on the Responses API — a 200 stream whose first event is
 * `{type:'error', error:{code:'rate_limit_exceeded', message:'… Please try
 * again in 590ms. …'}}`, which the provider surfaces as an in-stream `error`
 * part. Both are transient admission failures: the request was refused before
 * any generation happened, so the correct behavior is to wait out the
 * advertised delay and re-send the *identical* request (same params → prompt
 * caching and context are untouched), as many times as needed, rather than
 * fail mid-workflow.
 *
 * A retry is only attempted while nothing has been forwarded downstream yet
 * (rate limits reject at admission, never mid-generation). Lifecycle parts
 * (`stream-start`, `response-metadata`, `raw`) are held back until the first
 * real part so a failed attempt can be discarded wholesale.
 *
 * `insufficient_quota` (out of credits) is deliberately NOT retried — it never
 * resolves on its own.
 */

import { wrapLanguageModel, NoOutputGeneratedError, type LanguageModel, type LanguageModelMiddleware } from 'ai'
import { debugLog } from '../shared/debug-log'
import { AgentLoopRestartError } from './model-switch'
import { throwIfAborted } from '../shared/abort'

export interface RateLimitWait {
  /** 1-based count of retries scheduled so far for this step's request. */
  attempt: number
  delayMs: number
  /** Provider error message, when one was found. */
  message?: string
}

export interface RateLimitHooks {
  /** A retry has been scheduled; the turn is paused for `delayMs`. */
  onWait?: (info: RateLimitWait) => void
  /** A retried request went through (or the attempt finished); the turn resumed. */
  onClear?: () => void
  /**
   * Awaited before EVERY send attempt (the first one and each retry). Used to
   * make subagent requests yield to the main agent while it is stuck in a
   * rate-limit wait, so the user's message gets the freed-up quota first.
   */
  beforeAttempt?: (signal?: AbortSignal) => Promise<void>
  /**
   * When true (checked before each attempt and during the wait sleep), the
   * middleware aborts the current rate-limit cycle so the outer loop can
   * rebuild the provider request after a session setting changed.
   */
  shouldRestart?: () => boolean
}

/**
 * Shared admission-priority gate: the main agent marks itself while it is
 * waiting out a provider rate limit, and subagents hold their own attempts
 * (via RateLimitHooks.beforeAttempt) until every main agent is clear. One gate
 * per agent runtime — rate limits are provider-global, so any chat's main
 * agent outranks any subagent.
 */
export class MainAgentPriority {
  private readonly waiting = new Set<string>()
  private wakers: Array<() => void> = []

  /** A main agent (keyed per run) entered a rate-limit wait. */
  markWaiting(key: string): void {
    this.waiting.add(key)
  }

  /** That main agent's request was admitted (or its run ended). */
  clearWaiting(key: string): void {
    if (!this.waiting.delete(key)) return
    if (this.waiting.size === 0) {
      for (const wake of this.wakers.splice(0)) wake()
    }
  }

  busy(): boolean {
    return this.waiting.size > 0
  }

  /** Resolves once no main agent is waiting (immediately if none are). */
  async waitForClear(signal?: AbortSignal): Promise<void> {
    while (this.busy()) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError(signal))
          return
        }
        const onAbort = (): void => reject(abortError(signal!))
        signal?.addEventListener('abort', onAbort, { once: true })
        this.wakers.push(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    }
  }
}

type WrapStream = NonNullable<LanguageModelMiddleware['wrapStream']>
type StreamResult = Awaited<ReturnType<WrapStream>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never

interface RateLimitHit {
  message?: string
  /** Server-advertised wait, when parseable from the message or headers. */
  delayMs?: number
}

/** Parts held back until the first real part, so a failed attempt can be discarded. */
const HOLD_BACK = new Set<string>(['stream-start', 'response-metadata', 'raw'])

const MIN_DELAY_MS = 250
const MAX_DELAY_MS = 5 * 60_000

/**
 * Duck-typed rate-limit detection: walks the error object (including nested
 * `error`/`cause`/`data` and the JSON `responseBody` of an APICallError) and
 * looks for a 429 status or a rate-limit error code. Provider-agnostic on
 * purpose — gateway / openai / openai-compatible all shape errors differently.
 */
export function detectRateLimit(err: unknown): RateLimitHit | undefined {
  const nodes: Record<string, unknown>[] = []
  const stack: unknown[] = [err]
  const seen = new Set<object>()
  while (stack.length > 0 && nodes.length < 32) {
    const v = stack.pop()
    if (typeof v !== 'object' || v === null || seen.has(v)) continue
    seen.add(v)
    const o = v as Record<string, unknown>
    nodes.push(o)
    for (const key of ['error', 'data', 'cause', 'lastError', 'errors'] as const) {
      const child = o[key]
      if (Array.isArray(child)) stack.push(...child)
      else if (child) stack.push(child)
    }
    if (typeof o.responseBody === 'string') {
      try {
        stack.push(JSON.parse(o.responseBody))
      } catch {
        // Not JSON; ignore.
      }
    }
  }

  let isRateLimit = false
  let message: string | undefined
  let headers: Record<string, string> | undefined
  for (const o of nodes) {
    const code = typeof o.code === 'string' ? o.code : undefined
    const type = typeof o.type === 'string' ? o.type : undefined
    // Out of credits, not a transient limit — retrying would spin forever.
    if (code === 'insufficient_quota' || type === 'insufficient_quota') return undefined
    if (code === 'rate_limit_exceeded' || type === 'rate_limit_error' || o.statusCode === 429 || o.status === 429) {
      isRateLimit = true
    }
    if (!message && typeof o.message === 'string' && /rate.?limit/i.test(o.message)) message = o.message
    if (!headers && typeof o.responseHeaders === 'object' && o.responseHeaders !== null) {
      headers = o.responseHeaders as Record<string, string>
    }
  }
  if (!isRateLimit) return undefined
  if (!message) {
    message = nodes.map((o) => o.message).find((m): m is string => typeof m === 'string')
  }
  return { message, delayMs: parseRetryDelayMs(message, headers) }
}

/**
 * Duck-typed detection of transient transport failures worth a bounded retry
 * before a request forwards content. These
 * retries are bounded, unlike the unlimited 429 admission retry above:
 * HTTP 5xx, connection resets, and
 * aborted/terminated provider-side streams. Deliberately excludes
 * `insufficient_quota` (never resolves on its own) and 401/403/auth failures
 * (wrong or revoked key — retrying does not help). Provider-agnostic by
 * design, same as `detectRateLimit`.
 *
 * An empty stream is retried here as NoOutputGeneratedError, before the SDK
 * turns it into an empty turn. This keeps all recovery at the request boundary.
 */
export function isRetryableTransportError(err: unknown): boolean {
  if (NoOutputGeneratedError.isInstance(err)) return true

  const nodes: Record<string, unknown>[] = []
  const stack: unknown[] = [err]
  const seen = new Set<object>()
  while (stack.length > 0 && nodes.length < 32) {
    const v = stack.pop()
    if (typeof v !== 'object' || v === null || seen.has(v)) continue
    seen.add(v)
    const o = v as Record<string, unknown>
    nodes.push(o)
    for (const key of ['error', 'data', 'cause', 'lastError', 'errors'] as const) {
      const child = o[key]
      if (Array.isArray(child)) stack.push(...child)
      else if (child) stack.push(child)
    }
  }

  let retryable = false
  for (const o of nodes) {
    const code = typeof o.code === 'string' ? o.code : undefined
    const type = typeof o.type === 'string' ? o.type : undefined
    const status = typeof o.statusCode === 'number' ? o.statusCode : typeof o.status === 'number' ? o.status : undefined
    const name = typeof o.name === 'string' ? o.name : undefined
    const message = typeof o.message === 'string' ? o.message : ''
    // Never retry: out of credits or an auth failure — neither resolves on its own.
    if (code === 'insufficient_quota' || type === 'insufficient_quota') return false
    if (status === 401 || status === 403 || code === 'invalid_api_key' || type === 'authentication_error') return false
    if (status !== undefined && status >= 500 && status < 600) retryable = true
    if (name === 'AbortError' || name === 'ModelIdleTimeoutError' || /terminated|network error|fetch failed|failed to fetch|socket hang up|ECONNRESET|ETIMEDOUT/i.test(message)) {
      retryable = true
    }
  }
  return retryable
}

/**
 * Parse the wait OpenAI advertises: "Please try again in 590ms" / "in 1.898s"
 * / "in 7m12s", falling back to `retry-after-ms` / `retry-after` headers.
 */
function parseRetryDelayMs(message?: string, headers?: Record<string, string>): number | undefined {
  if (message) {
    const m = /try again in\s+((?:[0-9.]+(?:ms|[hms]))+)/i.exec(message)
    if (m?.[1]) {
      let total = 0
      for (const [, num, unit] of m[1].matchAll(/([0-9.]+)(ms|[hms])/g)) {
        const n = Number(num)
        if (!Number.isFinite(n)) continue
        total += unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000
      }
      if (total > 0) return Math.ceil(total)
    }
  }
  if (headers) {
    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
    const afterMs = Number(lower['retry-after-ms'])
    if (Number.isFinite(afterMs) && afterMs > 0) return afterMs
    const after = lower['retry-after']
    if (after) {
      const secs = Number(after)
      if (Number.isFinite(secs) && secs > 0) return secs * 1000
      const at = Date.parse(after)
      if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
    }
  }
  return undefined
}

/** Server-advertised delay plus a little headroom, or exponential backoff. */
function resolveDelayMs(hit: RateLimitHit, attempt: number): number {
  const jitter = 50 + Math.random() * 200
  const base = hit.delayMs ?? Math.min(1000 * 2 ** (attempt - 1), 30_000)
  return Math.min(Math.max(Math.ceil(base + jitter), MIN_DELAY_MS), MAX_DELAY_MS)
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Rate-limit wait aborted', 'AbortError')
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Sleep up to `ms`, but return early when `shouldWake` becomes true (polled
 * every 100ms). Used so a mid-wait model switch doesn't sit out the full
 * rate-limit delay before restarting on Grok.
 */
async function sleepUnless(
  ms: number,
  signal: AbortSignal | undefined,
  shouldWake?: () => boolean,
): Promise<'done' | 'woke'> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (shouldWake?.()) return 'woke'
    const chunk = Math.min(100, Math.max(0, end - Date.now()))
    if (chunk <= 0) break
    await sleep(chunk, signal)
  }
  return shouldWake?.() ? 'woke' : 'done'
}

function isErrorPart(part: StreamPart): part is Extract<StreamPart, { type: 'error' }> {
  return part.type === 'error'
}

export function rateLimitRetryMiddleware(hooks: RateLimitHooks = {}): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapStream: async ({ model, params }) => {
      const cancellation = new AbortController()
      const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, cancellation.signal]) : cancellation.signal
      const doStream = () => model.doStream({ ...params, abortSignal: signal })
      let attempt = 0
      let transportAttempts = 0
      let waiting = false

      type Retry = { kind: 'rate-limit'; hit: RateLimitHit } | { kind: 'transport'; error: unknown }
      const retryFor = (error: unknown): Retry | undefined => {
        if (signal?.aborted || error instanceof AgentLoopRestartError) return undefined
        const hit = detectRateLimit(error)
        if (hit) return { kind: 'rate-limit', hit }
        // One recovery attempt for a silent provider; two for immediate network
        // failures. The run loop never multiplies these by replaying a turn.
        if (error instanceof Error && error.name === 'ModelIdleTimeoutError' && transportAttempts >= 1) return undefined
        if (transportAttempts < 2 && isRetryableTransportError(error)) return { kind: 'transport', error }
        return undefined
      }

      const throwIfRestart = (): void => {
        if (hooks.shouldRestart?.()) throw new AgentLoopRestartError()
      }

      const clear = (): void => {
        if (!waiting) return
        waiting = false
        hooks.onClear?.()
      }

      const wait = async (hit: RateLimitHit): Promise<void> => {
        attempt += 1
        const delayMs = resolveDelayMs(hit, attempt)
        waiting = true
        hooks.onWait?.({ attempt, delayMs, message: hit.message })
        debugLog.log('agent', 'rate limited; retrying', { attempt, delayMs })
        const outcome = await sleepUnless(delayMs, signal, hooks.shouldRestart)
        if (outcome === 'woke') {
          // Drop the wait state before restarting so the banner clears and
          // subagents are no longer gated on this main-agent wait.
          clear()
          throw new AgentLoopRestartError()
        }
      }

      const waitForRetry = async (retry: Retry): Promise<void> => {
        if (retry.kind === 'rate-limit') return wait(retry.hit)
        transportAttempts += 1
        const delayMs = 500 * 2 ** (transportAttempts - 1)
        debugLog.error('agent', `model connection failed; retrying (${transportAttempts}/2)`, retry.error)
        const outcome = await sleepUnless(delayMs, signal, hooks.shouldRestart)
        if (outcome === 'woke') {
          clear()
          throw new AgentLoopRestartError()
        }
      }

      // Retry admission failures and transport errors before response headers.
      const nextAttempt = async (): Promise<StreamResult> => {
        while (true) {
          try {
            throwIfAborted(signal)
            throwIfRestart()
            await hooks.beforeAttempt?.(signal)
            throwIfRestart()
            return await doStream()
          } catch (err) {
            if (err instanceof AgentLoopRestartError) throw err
            const retry = retryFor(err)
            if (!retry) throw err
            await waitForRetry(retry)
          }
        }
      }

      let first: StreamResult
      try { first = await nextAttempt() }
      catch (error) { clear(); throw error }
      let current = first
      let activeReader: ReadableStreamDefaultReader<StreamPart> | undefined

      // Retry rejections that arrive as in-stream error events (Responses API).
      const stream = new ReadableStream<StreamPart>({
        start: async (controller) => {
          try {
            let held: StreamPart[] = []
            let forwarded = false
            attempts: while (true) {
              const reader = activeReader = current.stream.getReader()
              let retryHit: Retry | undefined
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) {
                    if (!forwarded) {
                      const error = new NoOutputGeneratedError()
                      retryHit = retryFor(error)
                      if (!retryHit) throw error
                    }
                    break
                  }
                  if (!forwarded) {
                    if (value.type === 'finish' && (value.usage.outputTokens.total ?? 0) === 0 &&
                      (value.finishReason.unified === 'other' || value.finishReason.unified === 'error')) {
                      const error = new NoOutputGeneratedError()
                      retryHit = retryFor(error)
                      if (!retryHit) throw error
                      break
                    }
                    const hit = isErrorPart(value) ? retryFor(value.error) : undefined
                    if (hit) {
                      retryHit = hit
                      break
                    }
                    if (HOLD_BACK.has(value.type)) {
                      held.push(value)
                      continue
                    }
                    for (const p of held) controller.enqueue(p)
                    held = []
                    forwarded = true
                    clear()
                  }
                  controller.enqueue(value)
                }
              } catch (error) {
                retryHit = !forwarded ? retryFor(error) : undefined
                if (!retryHit) throw error
              } finally {
                activeReader = undefined
                reader.releaseLock()
              }

              if (!retryHit) {
                for (const p of held) controller.enqueue(p)
                clear()
                break attempts
              }

              // A broken provider's cleanup must not hold recovery hostage.
              void current.stream.cancel().catch(() => {})
              await waitForRetry(retryHit)
              held = []
              current = await nextAttempt()
            }
            controller.close()
          } catch (err) {
            controller.error(err)
          } finally {
            clear()
          }
        },
        cancel: (reason) => {
          cancellation.abort(reason)
          clear()
          // The pumping loop owns the lock; cancel through its reader.
          void (activeReader ? activeReader.cancel(reason) : current.stream.cancel(reason)).catch(() => {})
        },
      })

      return { ...first, stream }
    },
  }
}

/**
 * Wrap a resolved model with unlimited rate-limit retries and at most two
 * transport retries per request, before any content is forwarded.
 * String ids and v2-spec models pass through unwrapped (middleware is v3-only).
 */
export function withRateLimitRetry(model: LanguageModel, hooks: RateLimitHooks = {}): LanguageModel {
  if (typeof model === 'string' || model.specificationVersion !== 'v3') return model
  return wrapLanguageModel({ model, middleware: rateLimitRetryMiddleware(hooks) })
}
