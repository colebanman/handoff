/**
 * Runs INSIDE sandbox.html — a manifest-sandboxed page (unique origin,
 * `unsafe-eval` allowed, NO chrome.* access). It receives `exec` messages
 * from the host, builds an AsyncFunction with globals `api`, `state`, and a
 * captured `console`, runs the user code under a timeout race, and posts the
 * serialized completion value + captured logs back.
 *
 * Every `api.*` call is a nested proxy that posts an `api-call` to the host
 * and awaits the matching `api-result`. Only structured-cloneable data crosses
 * the postMessage boundary.
 *
 * Protocol shapes are the ones in src/shared/rpc.ts — used verbatim.
 */

import type { HostToSandbox, JsonValue, SandboxToHost } from '../shared/rpc'
import { SANDBOX_API_PATHS, SANDBOX_MAX_TIMEOUT_MS } from '../shared/rpc'
import * as pdfLib from 'pdf-lib'
import JSZip from 'jszip'
import { createExtensionRuntime } from './extensions'

/* ------------------------------------------------------------------ */
/* Serialization / inspection helpers                                  */
/* ------------------------------------------------------------------ */

const MAX_STRING = 1000
const MAX_ARRAY = 100

/**
 * Depth-limited, size-capped inspect for console arguments. Strings are
 * clamped to ~1000 chars, arrays to ~100 items. Never throws.
 */
function inspect(value: unknown, depth = 0, seen: Set<unknown> = new Set()): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const t = typeof value
  if (t === 'string') {
    const s = value as string
    return s.length > MAX_STRING ? JSON.stringify(s.slice(0, MAX_STRING)) + `…(+${s.length - MAX_STRING})` : JSON.stringify(s)
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value)
  if (t === 'symbol') return (value as symbol).toString()
  if (t === 'function') {
    const fn = value as { name?: string }
    return `[Function${fn.name ? ': ' + fn.name : ' (anonymous)'}]`
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (depth >= 4) return Array.isArray(value) ? '[Array]' : '[Object]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY).map((v) => inspect(v, depth + 1, seen))
      if (value.length > MAX_ARRAY) items.push(`…(+${value.length - MAX_ARRAY} more)`)
      return '[ ' + items.join(', ') + ' ]'
    }
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    const shown = keys.slice(0, MAX_ARRAY)
    const parts = shown.map((k) => `${k}: ${inspect(obj[k], depth + 1, seen)}`)
    if (keys.length > MAX_ARRAY) parts.push(`…(+${keys.length - MAX_ARRAY} more)`)
    return '{ ' + parts.join(', ') + ' }'
  } catch (e) {
    return `[Unserializable: ${(e as Error).message}]`
  } finally {
    seen.delete(value)
  }
}

/** Serialize a completion value for the exec-result. Never throws. */
function serializeResult(value: unknown): string | undefined {
  if (value === undefined) return undefined
  let out: string
  try {
    out = JSON.stringify(value, replacer(), 2)
    if (out === undefined) out = inspect(value)
  } catch {
    out = inspect(value)
  }
  return out
}

/** JSON replacer that renders non-cloneable values instead of failing. */
function replacer(): (key: string, val: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, val) => {
    if (typeof val === 'bigint') return `${val}n`
    if (typeof val === 'function') return `[Function${(val as { name?: string }).name ? ': ' + (val as { name: string }).name : ''}]`
    if (val instanceof Error) return `${val.name}: ${val.message}`
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
    }
    return val
  }
}

/* ------------------------------------------------------------------ */
/* Host messaging                                                      */
/* ------------------------------------------------------------------ */

function post(msg: SandboxToHost): void {
  // The host frame is our parent. targetOrigin '*' is acceptable: the sandbox
  // page runs at a null/opaque origin and only ever talks to its embedder.
  parent.postMessage(msg, '*')
}

/* ------------------------------------------------------------------ */
/* Per-session persistent state                                        */
/* ------------------------------------------------------------------ */

const sessionState = new Map<string, Record<string, unknown>>()

function getState(sessionId: string): Record<string, unknown> {
  let s = sessionState.get(sessionId)
  if (!s) {
    s = {}
    sessionState.set(sessionId, s)
  }
  return s
}

/* ------------------------------------------------------------------ */
/* api proxy: every SANDBOX_API_PATH round-trips to the host           */
/* ------------------------------------------------------------------ */

type ApiCallFn = (path: string, args: JsonValue[]) => Promise<JsonValue>

/* ------------------------------------------------------------------ */
/* Module cache: api.require(url) — source fetched host-side (cached), */
/* evaluated here once (unsafe-eval), reused for the iframe lifetime.  */
/* ------------------------------------------------------------------ */

const moduleCache = new Map<string, Promise<unknown>>()

function requireModule(url: string, callFn: ApiCallFn): Promise<unknown> {
  const cached = moduleCache.get(url)
  if (cached) return cached
  const load = (async (): Promise<unknown> => {
    const source = await callFn('require.source', [url])
    if (typeof source !== 'string') throw new Error(`api.require: host returned no source for ${url}`)
    const module = { exports: {} as Record<string, unknown> }
    const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis))
    try {
      // CommonJS/UMD shim — the fetch + new Function pattern done once.
      // `this` = exports for UMD factories that attach to `this`.
      new Function('module', 'exports', 'require', 'define', source).call(
        module.exports,
        module,
        module.exports,
        undefined,
        undefined,
      )
    } catch (e) {
      throw new Error(
        `api.require: could not evaluate ${url}: ${(e as Error).message}. ` +
          `Only classic-script/UMD/IIFE builds work here (ESM import/export cannot be evaluated) — ` +
          `use a UMD build, e.g. https://unpkg.com/<pkg>/dist/<name>.min.js`,
      )
    }
    if (Object.keys(module.exports).length > 0) return module.exports
    // IIFE builds attach a global instead of using module.exports.
    const added = Object.getOwnPropertyNames(globalThis).filter((k) => !globalsBefore.has(k))
    const lastAdded = added[added.length - 1]
    if (lastAdded !== undefined) return (globalThis as unknown as Record<string, unknown>)[lastAdded]
    return module.exports
  })()
  load.catch(() => moduleCache.delete(url)) // never cache failures
  moduleCache.set(url, load)
  return load
}

const KNOWN_PATHS = new Set<string>(SANDBOX_API_PATHS)

/* ------------------------------------------------------------------ */
/* Local (in-realm) api namespaces — never round-trip to the host.     */
/* pdf-lib / JSZip objects are not structured-cloneable, so they MUST  */
/* live here rather than behind the RPC proxy.                         */
/* ------------------------------------------------------------------ */

const bytesApi = {
  /** base64 (optionally a data: URL) → Uint8Array */
  fromBase64(b64: string): Uint8Array {
    const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
    const bin = atob(clean)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  },
  /** Uint8Array | ArrayBuffer → base64 (chunked; safe for large files) */
  toBase64(bytes: Uint8Array | ArrayBuffer): string {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    let bin = ''
    const CHUNK = 0x8000
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode(...u8.subarray(i, i + CHUNK))
    }
    return btoa(bin)
  },
  /** UTF-8 string → Uint8Array */
  fromText: (text: string): Uint8Array => new TextEncoder().encode(text),
  /** Uint8Array | ArrayBuffer → UTF-8 string */
  toText: (bytes: Uint8Array | ArrayBuffer): string => new TextDecoder().decode(bytes),
}

/** Namespaces served locally from the sandbox realm via the api proxy root. */
const LOCAL_APIS: Record<string, unknown> = {
  pdf: pdfLib,
  zip: JSZip,
  bytes: bytesApi,
}

/**
 * Build the `api` object for one exec. Any dotted path in SANDBOX_API_PATHS is
 * callable (e.g. api.history.search(...), api.page.click(...), api.cdp(...),
 * api.fetch(...)). Calling it posts an api-call and resolves when the matching
 * api-result arrives.
 */
function buildApi(callFn: ApiCallFn, extensions?: unknown): unknown {
  const makeNode = (prefix: string): unknown => {
    // A callable function target lets both `api.cdp(...)` (leaf call) and
    // `api.history.search(...)` (nested) work through the same proxy.
    const target = function () {} as unknown as Record<string, unknown>
    return new Proxy(target, {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined
        // Avoid confusing thenable detection when a proxy is awaited directly.
        if (prop === 'then') return undefined
        if (prefix === '' && prop === 'extensions' && extensions) return extensions
        if (prefix === '' && prop in LOCAL_APIS) return LOCAL_APIS[prop]
        const path = prefix ? `${prefix}.${prop}` : prop
        return makeNode(path)
      },
      apply(_t, _thisArg, argArray) {
        if (prefix === 'require') {
          const url = argArray[0]
          if (typeof url !== 'string' || !url) {
            return Promise.reject(new Error('api.require(url): url must be a non-empty string'))
          }
          return requireModule(url, callFn)
        }
        if (!KNOWN_PATHS.has(prefix)) {
          return Promise.reject(new Error(`unknown api path "${prefix}"`))
        }
        return callFn(prefix, argArray as JsonValue[])
      },
    })
  }
  return makeNode('')
}

/* ------------------------------------------------------------------ */
/* Exec engine                                                         */
/* ------------------------------------------------------------------ */

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as {
  new (...args: string[]): (...a: unknown[]) => Promise<unknown>
}

/**
 * Decide whether `code` is a bare expression we should auto-return. Heuristic
 * (per the research doc): no newline, no semicolon, and no leading `return`.
 */
function isBareExpression(code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length === 0) return false
  if (/[\n;]/.test(trimmed)) return false
  if (/^return\b/.test(trimmed)) return false
  // Statements that can't be returned as an expression.
  if (/^(?:const|let|var|function|class|if|for|while|switch|throw|try|import|export)\b/.test(trimmed)) return false
  return true
}

function wrapCode(code: string): string {
  // Bare expressions are auto-returned. Everything else runs inside a nested
  // block so top-level `const`/`let` (including `state`, `api`, `console`)
  // legally shadows the injected parameters instead of throwing
  // "Identifier 'x' has already been declared". `return`, `var` hoisting, and
  // sloppy-mode function declarations all still work inside the block.
  return isBareExpression(code) ? `return await (${code});` : `{\n${code}\n}`
}

/** Append a recovery hint to known error shapes so the model self-corrects
 *  in one turn instead of regenerating whole snippets blind. */
function appendErrorHints(error: string): string {
  if (/WinAnsi cannot encode/.test(error)) {
    return (
      error +
      '\nHint: pdf-lib standard fonts only encode Latin-1 (WinAnsi). Replace unsupported characters before drawing text (e.g. ≥ -> >=, — -> -, curly quotes -> straight quotes). Embedding a Unicode font requires fontkit, which is not bundled.'
    )
  }
  if (/Buffer is not defined/.test(error)) {
    return (
      error +
      '\nHint: this sandbox has no Node Buffer. Use api.bytes: fromBase64(b64) -> Uint8Array, toBase64(u8) -> b64, fromText(str), toText(u8). Round-trip files with api.fs.readBytes / api.fs.writeBase64.'
    )
  }
  return error
}

/** Per-exec pending api-call promises, keyed by callId. */
interface PendingCall {
  resolve: (v: JsonValue) => void
  reject: (e: Error) => void
}

interface ActiveExec {
  execId: string
  pending: Map<string, PendingCall>
  cancelled: boolean
  ended: boolean
  cancelReason?: string
}

// Execs in flight, keyed by execId. The host runs execs concurrently (parallel
// tool calls, background subagents sharing this one iframe), so a single
// "current exec" pointer would let a later exec steal an earlier one's
// api-result routing — leaving its await unresolved until the host's 62s idle
// timeout. Keying by execId lets every concurrent exec receive its own results.
const execsById = new Map<string, ActiveExec>()

/** Timeout raised by the exec deadline — serialized without name prefix or stack. */
class ExecTimeoutError extends Error {}

async function runExec(msg: Extract<HostToSandbox, { kind: 'exec' }>): Promise<void> {
  const { execId, sessionId, code, timeoutMs } = msg
  const logs: string[] = []
  const pending = new Map<string, PendingCall>()
  const active: ActiveExec = { execId, pending, cancelled: false, ended: false }
  execsById.set(execId, active)

  let callSeq = 0
  const callFn: ApiCallFn = (path, args) =>
    new Promise<JsonValue>((resolve, reject) => {
      if (active.cancelled) {
        reject(new DOMException(active.cancelReason ?? 'Sandbox execution cancelled', 'AbortError'))
        return
      }
      if (active.ended) {
        // A function saved in state/globalThis can retain this execution's
        // lexical api. Its reply would target an execId already removed from
        // execsById, so posting it would silently strand the caller until its
        // script timeout. Never rebind it to another execution's authority.
        reject(new Error(
          'This api handle belongs to a completed sandbox execution. Recreate helpers that capture api inside this call, ' +
          'or pass the current api as an argument to a saved helper (for example: state.getCanvas = async (client, path) => client.fetch(path); await state.getCanvas(api, path)). ' +
          'Persistent data and pure functions in state are still usable.',
        ))
        return
      }
      callSeq += 1
      const callId = `${execId}-c${callSeq}`
      pending.set(callId, { resolve, reject })
      const call: SandboxToHost = { kind: 'api-call', execId, callId, path, args }
      try {
        post(call)
      } catch (e) {
        pending.delete(callId)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })

  const capturedConsole = {
    log: (...a: unknown[]) => emit('log', a),
    warn: (...a: unknown[]) => emit('warn', a),
    error: (...a: unknown[]) => emit('error', a),
    info: (...a: unknown[]) => emit('log', a),
    debug: (...a: unknown[]) => emit('log', a),
  }
  function emit(level: 'log' | 'warn' | 'error', args: unknown[]): void {
    const text = args.map((a) => inspect(a)).join(' ')
    logs.push(`[${level}] ${text}`)
    post({ kind: 'console', execId, level, text })
  }

  const extensions = createExtensionRuntime(callFn, () => api, capturedConsole)
  const api = buildApi(callFn, extensions.management)
  const state = getState(sessionId)

  // Deadline counts SCRIPT execution only: while an api.* call is pending the
  // host is doing the work, so the deadline is pushed forward. The host
  // enforces an absolute wall-clock ceiling, so this cannot run unbounded.
  let timer: ReturnType<typeof setInterval> | undefined
  const timeout = new Promise<never>((_, reject) => {
    let deadline = Date.now() + timeoutMs
    timer = setInterval(() => {
      if (pending.size > 0) {
        deadline = Date.now() + timeoutMs
        return
      }
      if (Date.now() >= deadline) {
        reject(
          new ExecTimeoutError(
            `exec timed out after ${timeoutMs}ms of script execution — pass timeoutMs (max ${SANDBOX_MAX_TIMEOUT_MS}) for longer runs; console output logged before the timeout (if any) appears above`,
          ),
        )
      }
    }, 250)
  })

  let ok = true
  let value: string | undefined
  let error: string | undefined
  try {
    let fn: (...a: unknown[]) => Promise<unknown>
    try {
      fn = new AsyncFunction('api', 'state', 'console', 'apps', wrapCode(code))
    } catch (syntaxErr) {
      throw new Error(`SyntaxError: ${(syntaxErr as Error).message}`)
    }
    const run = fn(api, state, capturedConsole, extensions.apps)
    const result = await Promise.race([run, timeout])
    value = serializeResult(result)
  } catch (e) {
    ok = false
    if (e instanceof ExecTimeoutError) {
      error = e.message // no stack — it would only point at sandbox internals
    } else if (e instanceof Error) {
      const name = e.name && e.name !== 'Error' ? `${e.name}: ` : ''
      error = `${name}${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''}`
    } else {
      error = String(e)
    }
  } finally {
    active.ended = true
    if (timer !== undefined) clearInterval(timer)
    // Reject any still-pending api calls so their awaits settle.
    for (const [, p] of pending) p.reject(new Error('exec ended before api-result arrived'))
    pending.clear()
    execsById.delete(execId)
  }

  if (error !== undefined) error = appendErrorHints(error)

  post({ kind: 'exec-result', execId, ok, value, error, logs })
}

/* ------------------------------------------------------------------ */
/* Message pump                                                        */
/* ------------------------------------------------------------------ */

window.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data as HostToSandbox | undefined
  if (!data || typeof data !== 'object' || typeof (data as { kind?: unknown }).kind !== 'string') return

  if (data.kind === 'exec') {
    // Fire-and-forget; runExec posts its own result/error.
    void runExec(data)
    return
  }

  if (data.kind === 'cancel') {
    const exec = execsById.get(data.execId)
    if (!exec || exec.cancelled) return
    exec.cancelled = true
    exec.cancelReason = data.reason
    // JavaScript cannot be forcibly interrupted safely, but cancellation
    // revokes its only side-effect capability immediately. Existing api calls
    // finish host-side; every pending/future await in this realm rejects.
    for (const [, pending] of exec.pending) {
      pending.reject(new DOMException(data.reason ?? 'Sandbox execution cancelled', 'AbortError'))
    }
    exec.pending.clear()
    return
  }

  if (data.kind === 'api-result') {
    const { execId, callId, ok, value, error } = data
    const exec = execsById.get(execId)
    if (!exec) return
    const pend = exec.pending.get(callId)
    if (!pend) return
    exec.pending.delete(callId)
    if (ok) pend.resolve(value === undefined ? null : value)
    else pend.reject(new Error(error ?? 'api call failed'))
  }
})

// Announce readiness so the host can resolve its "wait for ready" gate.
post({ kind: 'ready' })
