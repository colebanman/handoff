/**
 * Host side of the sandbox. Lives in the side-panel page. Mounts a hidden
 * <iframe src="sandbox.html"> lazily, waits for its `ready` message, then
 * drives the RPC protocol in shared/rpc.ts:
 *
 *   exec()  → posts an `exec` message, wires a per-exec dispatcher that
 *             answers `api-call`s (via createApiDispatch), collects `console`
 *             lines, and resolves on `exec-result`.
 *
 * A host-side liveness timer resets on every sandbox message and pauses while
 * a host api.* dispatch is in flight, so a slow-but-alive exec is never cut
 * off mid-RPC. An absolute wall-clock ceiling (SANDBOX_MAX_TIMEOUT_MS + margin)
 * guarantees exec() always settles even if the sandbox truly wedges. Returns
 * a SandboxExecResult.
 */

import type { CdpService, SandboxExecResult, SandboxService, TabScope, VirtualFileSystemService } from '../shared/types'
import type { HostToSandbox, JsonValue, SandboxToHost } from '../shared/rpc'
import { SANDBOX_DEFAULT_TIMEOUT_MS, SANDBOX_MAX_TIMEOUT_MS } from '../shared/rpc'
import { debugLog } from '../shared/debug-log'
import { formatError } from '../shared/errors'
import { uid } from '../shared/ids'
import { createApiDispatch } from './api-dispatch'
import { abortable, throwIfAborted } from '../shared/abort'

const SANDBOX_HTML = 'sandbox.html'
const HOST_TIMEOUT_MARGIN_MS = 2000
const HARD_TIMER_POLL_MS = 500

interface ActiveExec {
  execId: string
  dispatch: (path: string, args: JsonValue[]) => Promise<JsonValue>
  logs: string[]
  settle: (result: SandboxExecResult) => void
  settled: boolean
  hardTimer: ReturnType<typeof setInterval>
  startedAt: number
  /** Last time the sandbox showed signs of life (message received / dispatch settled). */
  lastActivityAt: number
  /** In-flight api.* dispatches, callId -> human label like `api.fetch("https://…")`. */
  pendingApi: Map<string, string>
  cleanupAbort?: () => void
  signal?: AbortSignal
  cancelRequested: boolean
  cancelReason?: string
}

/** Compact human label for an api call, e.g. api.cdp(123, "DOM.getDocument", {"pierce":true}). */
function apiCallLabel(path: string, args: JsonValue[]): string {
  const parts = args.slice(0, 3).map((a) => {
    let s: string
    try {
      s = JSON.stringify(a) ?? String(a)
    } catch {
      s = String(a)
    }
    return s.length > 60 ? s.slice(0, 60) + '…' : s
  })
  if (args.length > 3) parts.push('…')
  return `api.${path}(${parts.join(', ')})`
}

export function createSandboxService(cdp: CdpService, vfs: VirtualFileSystemService): SandboxService {
  let iframe: HTMLIFrameElement | null = null
  let readyPromise: Promise<HTMLIFrameElement> | null = null
  const execs = new Map<string, ActiveExec>()

  /** Lazily create the hidden sandbox iframe and wait for its `ready`. */
  function ensureReady(): Promise<HTMLIFrameElement> {
    if (readyPromise) return readyPromise

    readyPromise = new Promise<HTMLIFrameElement>((resolve, reject) => {
      // Guard: reuse an existing sandbox iframe if one is already mounted.
      const existing = document.querySelector<HTMLIFrameElement>('iframe[data-ai-sandbox="1"]')
      const frame = existing ?? document.createElement('iframe')
      if (!existing) {
        frame.setAttribute('data-ai-sandbox', '1')
        // Keep evaluated code isolated from the extension origin.
        frame.setAttribute('sandbox', 'allow-scripts')
        frame.src = chrome.runtime.getURL(SANDBOX_HTML)
        frame.style.position = 'absolute'
        frame.style.width = '0'
        frame.style.height = '0'
        frame.style.border = '0'
        frame.style.visibility = 'hidden'
        frame.setAttribute('aria-hidden', 'true')
      }
      iframe = frame

      let settled = false
      const readyTimer = setTimeout(() => {
        if (settled) return
        settled = true
        window.removeEventListener('message', onMessage)
        debugLog.error('sandbox', 'iframe never signalled ready', 'timeout')
        reject(new Error('sandbox iframe never became ready'))
      }, 10000)

      const onMessage = (ev: MessageEvent) => {
        if (ev.source !== frame.contentWindow) return
        const data = ev.data as SandboxToHost | undefined
        if (!data || typeof data !== 'object' || (data as { kind?: unknown }).kind !== 'ready') return
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        window.removeEventListener('message', onMessage)
        debugLog.log('sandbox', 'iframe ready')
        resolve(frame)
      }
      window.addEventListener('message', onMessage)

      if (!existing) {
        if (!document.body) {
          settled = true
          clearTimeout(readyTimer)
          window.removeEventListener('message', onMessage)
          reject(new Error('document.body not available to mount sandbox iframe'))
          return
        }
        document.body.appendChild(frame)
      } else if (existing.contentWindow) {
        // Already-mounted frame may have signalled ready before we listened.
        // It will re-post ready on reload; if not, the 10s guard covers it.
      }
    }).catch((e) => {
      // Allow a later exec() to retry mounting.
      readyPromise = null
      iframe = null
      throw e
    })

    return readyPromise
  }

  // Single persistent message pump for exec-lifetime messages (api-call,
  // console, exec-result). Ready messages are handled inside ensureReady.
  window.addEventListener('message', (ev: MessageEvent) => {
    if (!iframe || ev.source !== iframe.contentWindow) return
    const data = ev.data as SandboxToHost | undefined
    if (!data || typeof data !== 'object' || typeof (data as { kind?: unknown }).kind !== 'string') return

    if (data.kind === 'api-call') {
      void handleApiCall(data)
      return
    }
    if (data.kind === 'console') {
      const exec = execs.get(data.execId)
      if (exec) {
        exec.lastActivityAt = Date.now()
        exec.logs.push(`[${data.level}] ${data.text}`)
      }
      return
    }
    if (data.kind === 'exec-result') {
      const exec = execs.get(data.execId)
      if (!exec) return
      finishExec(exec, {
        ok: data.ok,
        value: data.value,
        error: data.error,
        logs: data.logs.length ? data.logs : exec.logs,
        durationMs: Date.now() - exec.startedAt,
      })
    }
  })

  async function handleApiCall(msg: Extract<SandboxToHost, { kind: 'api-call' }>): Promise<void> {
    const exec = execs.get(msg.execId)
    const reply = (r: HostToSandbox): void => {
      iframe?.contentWindow?.postMessage(r, '*')
    }
    if (!exec || exec.cancelRequested) {
      // Stray call after the exec settled — reject so the sandbox await clears.
      reply({ kind: 'api-result', execId: msg.execId, callId: msg.callId, ok: false, error: 'exec cancelled or no longer active' })
      return
    }
    exec.lastActivityAt = Date.now()
    exec.pendingApi.set(msg.callId, apiCallLabel(msg.path, msg.args))
    try {
      throwIfAborted(exec.signal)
      const value = await exec.dispatch(msg.path, msg.args)
      // Never re-authorize sandbox code after a cancel raced the dispatch.
      if (!exec.cancelRequested) reply({ kind: 'api-result', execId: msg.execId, callId: msg.callId, ok: true, value })
    } catch (e) {
      const error = formatError(e)
      reply({ kind: 'api-result', execId: msg.execId, callId: msg.callId, ok: false, error })
    } finally {
      exec.pendingApi.delete(msg.callId)
      exec.lastActivityAt = Date.now()
      if (exec.cancelRequested && exec.pendingApi.size === 0) finishCancelled(exec)
    }
  }

  function finishCancelled(exec: ActiveExec): void {
    finishExec(exec, {
      ok: false,
      error: exec.cancelReason ?? 'sandbox execution cancelled',
      logs: exec.logs,
      durationMs: Date.now() - exec.startedAt,
    })
  }

  function finishExec(exec: ActiveExec, result: SandboxExecResult): void {
    if (exec.settled) return
    exec.settled = true
    clearInterval(exec.hardTimer)
    exec.cleanupAbort?.()
    execs.delete(exec.execId)
    if (result.ok) {
      debugLog.log('sandbox', `exec ${exec.execId} ok`, { durationMs: result.durationMs, logs: result.logs.length })
    } else {
      debugLog.log('sandbox', `exec ${exec.execId} failed`, { durationMs: result.durationMs, error: result.error })
    }
    exec.settle(result)
  }

  async function exec(opts: {
    code: string
    sessionId: string
    timeoutMs?: number
    scope?: TabScope
    dispatch?: (path: string, args: JsonValue[]) => Promise<JsonValue>
    wallTimeoutMs?: number
    signal?: AbortSignal
  }): Promise<SandboxExecResult> {
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? SANDBOX_DEFAULT_TIMEOUT_MS, 1000), SANDBOX_MAX_TIMEOUT_MS)
    const execId = uid('exec')
    const startedAt = Date.now()
    debugLog.log('sandbox', `exec ${execId} start`, { sessionId: opts.sessionId, timeoutMs, scoped: !!opts.scope?.allowedTabIds })

    let frame: HTMLIFrameElement
    try {
      throwIfAborted(opts.signal)
      frame = await abortable(ensureReady(), opts.signal)
      throwIfAborted(opts.signal)
    } catch (e) {
      const error = formatError(e)
      debugLog.error('sandbox', `exec ${execId} could not start`, e)
      return { ok: false, error: `sandbox unavailable: ${error}`, logs: [], durationMs: Date.now() - startedAt }
    }

    return new Promise<SandboxExecResult>((resolve) => {
      const execution = new AbortController()
      const signal = opts.signal ? AbortSignal.any([opts.signal, execution.signal]) : execution.signal
      const dispatch = opts.dispatch ?? createApiDispatch(cdp, vfs, opts.scope, signal)
      // Liveness-based hard timeout: the idle clock resets on any sandbox message
      // and never fires while a host api dispatch is in flight. An absolute
      // wall-clock ceiling guarantees exec() always settles.
      const idleLimitMs = timeoutMs + HOST_TIMEOUT_MARGIN_MS
      const wallCeilingMs = Math.max(timeoutMs, opts.wallTimeoutMs ?? SANDBOX_MAX_TIMEOUT_MS) + HOST_TIMEOUT_MARGIN_MS
      const hardTimer = setInterval(() => {
        const current = execs.get(execId)
        if (!current) return
        const now = Date.now()
        const hint = `pass timeoutMs (max ${SANDBOX_MAX_TIMEOUT_MS}) for longer runs; console output (if any) appears above`
        if (now - current.startedAt > wallCeilingMs) {
          const waiting = [...current.pendingApi.values()]
          const error = waiting.length
            ? `exec exceeded the ${wallCeilingMs}ms wall-clock ceiling while awaiting ${waiting.join(', ')} — the api call never returned; console output (if any) appears above`
            : `exec exceeded the ${wallCeilingMs}ms wall-clock ceiling — ${hint}`
          execution.abort(new Error(error))
          finishExec(current, {
            ok: false,
            error,
            logs: current.logs,
            durationMs: now - current.startedAt,
          })
          return
        }
        if (current.pendingApi.size > 0) return // host is working; not the sandbox's fault
        if (now - current.lastActivityAt > idleLimitMs) {
          const error = `sandbox did not respond for ${idleLimitMs}ms (host hard timeout — likely a synchronous busy-loop); ${hint}`
          execution.abort(new Error(error))
          finishExec(current, {
            ok: false,
            error,
            logs: current.logs,
            durationMs: now - current.startedAt,
          })
        }
      }, HARD_TIMER_POLL_MS)

      const active: ActiveExec = {
        execId,
        dispatch,
        logs: [],
        settle: resolve,
        settled: false,
        hardTimer,
        startedAt,
        lastActivityAt: startedAt,
        pendingApi: new Map(),
        signal,
        cancelRequested: false,
      }
      execs.set(execId, active)

      {
        const onAbort = (): void => {
          if (active.cancelRequested || active.settled) return
          active.cancelRequested = true
          active.cancelReason = signal.reason instanceof Error
            ? signal.reason.message
            : 'sandbox execution cancelled'
          frame.contentWindow?.postMessage({ kind: 'cancel', execId, reason: active.cancelReason } satisfies HostToSandbox, '*')
          // Terminal cancellation waits for already-dispatched host work. This
          // is what prevents the UI/task registry from saying "cancelled"
          // while a Chrome/CDP/filesystem call can still complete.
          if (active.pendingApi.size === 0) finishCancelled(active)
        }
        if (signal.aborted) onAbort()
        else {
          signal.addEventListener('abort', onAbort, { once: true })
          active.cleanupAbort = () => signal.removeEventListener('abort', onAbort)
        }
      }

      if (active.settled) return

      const message: HostToSandbox = {
        kind: 'exec',
        execId,
        sessionId: opts.sessionId,
        code: opts.code,
        timeoutMs,
      }
      const target = frame.contentWindow
      if (!target) {
        finishExec(active, { ok: false, error: 'sandbox iframe has no contentWindow', logs: [], durationMs: Date.now() - startedAt })
        return
      }
      target.postMessage(message, '*')
    })
  }

  return { exec }
}
