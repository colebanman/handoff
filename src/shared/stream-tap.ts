/**
 * Live stream tap — the publish side of the stream inspector (stream-debug.html).
 *
 * Debugging a provider stream from the outside is guesswork: by the time a part
 * reaches the UI reducer, the SSE framing, the request body we actually sent,
 * and the timing between chunks are all gone. This module publishes all three
 * to a `BroadcastChannel`, which the inspector page (a separate extension page,
 * same origin) picks up with no service-worker hop and no storage writes.
 *
 * Two hard rules, because this sits on the request path of every turn:
 *
 * 1. Zero cost when disarmed. `tapFetch()` returns the base fetch *untouched*
 *    when off, so a normal turn has literally no wrapper in the stack; every
 *    publish is a boolean check away from being a no-op; and every call site
 *    that would have to build a payload string must gate on `tapEnabled()`
 *    first. Every entry point is wrapped in try/catch — a broken debug channel
 *    must never break a turn.
 * 2. Never publish credentials. Only the allowlist in `HEADER_ALLOWLIST` is
 *    published, and `authorization`, `cookie`, `set-cookie` plus anything
 *    matching /key|token|secret/i are dropped even if allowlisted. Request and
 *    response *bodies* are published verbatim — they are the user's own prompts
 *    on the user's own machine, and seeing them is the entire point of the tool.
 *    (`chatgpt-account-id` is allowlisted: it is an account identifier, not a
 *    credential, and it is the first thing to check on a Codex 4xx.)
 *
 * Armed by `chrome.storage.local.streamTap`, which the inspector flips on load;
 * an `arm` broadcast covers the gap before the async storage read lands.
 */

export interface StreamTapEntry {
  /** Monotonic per-publisher sequence — gaps mean the ring buffer dropped. */
  seq: number
  at: number
  /**
   * `log` mirrors `debugLog` onto the same timeline. Wire traffic alone can't
   * explain a non-streaming pass like the onboarding one, where the interesting
   * decisions (what was collected, what was parsed, what was rejected) happen
   * locally around a single request.
   */
  kind: 'request' | 'raw' | 'part' | 'meta' | 'log'
  /** Short header: a part type, `POST /v1/responses`, or a meta reason. */
  label: string
  text: string
  /** Wire bytes for `raw` chunks (text length is post-decode). */
  bytes?: number
}

export type StreamTapMessage =
  | { type: 'entry'; entry: StreamTapEntry }
  | { type: 'arm' }
  | { type: 'disarm' }

export const STREAM_TAP_CHANNEL = 'ai-ext-stream-tap'
export const STREAM_TAP_KEY = 'streamTap'

/** Request bodies are the prompt + full history; cap the copy we broadcast. */
const MAX_REQUEST_BODY = 200_000
/** Per-response tap budget. A runaway stream must not fill the inspector. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** Per-string cap inside a summarized stream part. */
const MAX_PART_FIELD = 2_000

const HEADER_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'accept-encoding',
  'openai-beta',
  'openai-organization',
  'openai-project',
  'chatgpt-account-id',
  'originator',
  'session_id',
  'user-agent',
  'x-openai-fedramp',
])
const CREDENTIAL_NAME = /key|token|secret|^authorization$|^cookie$|^set-cookie$/i

let enabled = false
/**
 * Set by `armTap()`. The init path reads the persisted flag asynchronously, so
 * without this a synchronous arm could be overwritten by an in-flight read that
 * resolves a moment later with the old `false`.
 */
let armedLocally = false
let seq = 0
let channel: BroadcastChannel | null = null
let channelFailed = false
let initialized = false

function chan(): BroadcastChannel | null {
  if (channel || channelFailed) return channel
  try {
    channel = new BroadcastChannel(STREAM_TAP_CHANNEL)
  } catch {
    channelFailed = true
  }
  return channel
}

/**
 * Read the armed flag once, then follow it — so arming from the inspector takes
 * effect on the next request without reloading the panel. Idempotent; runs on
 * import so no call site has to remember it.
 */
export function initStreamTap(): void {
  if (initialized) return
  initialized = true
  try {
    chan()?.addEventListener('message', (e: MessageEvent<StreamTapMessage>) => {
      const msg = e.data
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'arm') enabled = true
      else if (msg.type === 'disarm') enabled = false
    })
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return
    void chrome.storage.local
      .get(STREAM_TAP_KEY)
      .then((out) => {
        if (!armedLocally) enabled = out[STREAM_TAP_KEY] === true
      })
      .catch(() => {})
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      const change = changes[STREAM_TAP_KEY]
      if (change) enabled = change.newValue === true
    })
  } catch {
    // Debug plumbing: a failure here must be invisible to the app.
  }
}

export function tapEnabled(): boolean {
  return enabled
}

/**
 * Arm the tap NOW, without waiting on storage.
 *
 * `tapFetch` decides whether to wrap at `resolveModel` time, and the persisted
 * flag only lands after an async read — so a request issued early in a session
 * could slip past an inspector that is "on". The dev build calls this during
 * store init, before anything can reach the network, which is what makes the
 * onboarding pass (fired the instant ChatGPT connects) reliably capturable.
 */
export function armTap(): void {
  armedLocally = true
  enabled = true
  try {
    void chrome.storage?.local?.set({ [STREAM_TAP_KEY]: true })?.catch(() => {})
  } catch {
    // Persisting is a convenience; the in-memory arm above is what matters.
  }
}

/** Broadcast one entry. No-op unless armed; never throws. */
export function publishTap(entry: Omit<StreamTapEntry, 'seq' | 'at'>): void {
  if (!enabled) return
  try {
    const c = chan()
    if (!c) return
    seq += 1
    const message: StreamTapMessage = { type: 'entry', entry: { ...entry, seq, at: Date.now() } }
    c.postMessage(message)
  } catch {
    // A closed channel (inspector window gone) must not surface in a turn.
  }
}

/**
 * Wrap a fetch so requests and raw response bytes land in the inspector.
 *
 * Returns `base ?? globalThis.fetch` unchanged when disarmed. When armed, the
 * response is tapped through `response.clone()` drained in the background and
 * the ORIGINAL response is handed back — reconstructing a `new Response(...)`
 * would drop `response.url`/`type`/`redirected`, which the SDK may read.
 */
export function tapFetch(base?: typeof fetch): typeof fetch {
  if (!enabled) return base ?? globalThis.fetch
  const send: typeof fetch = base ?? ((input, init) => globalThis.fetch(input, init))
  return async (input, init) => {
    const url = requestUrl(input)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const label = `${method} ${shortPath(url)}`
    try {
      const body = await requestBodyText(input, init)
      publishTap({
        kind: 'request',
        label,
        text: `${method} ${url}\n${headerLines(requestHeaders(input, init))}\n\n${body}`,
      })
    } catch (err) {
      publishTap({ kind: 'meta', label: `${label} request tap failed`, text: String(err) })
    }

    const res = await send(input, init)
    try {
      const clone = res.clone()
      publishTap({
        kind: 'meta',
        label: `${label} → ${res.status}`,
        text: `${res.status} ${res.statusText}\n${headerLines(headerEntries(res.headers))}`,
      })
      // Deliberately not awaited: the SDK gets the original body immediately.
      void drainRaw(clone, label)
    } catch (err) {
      publishTap({ kind: 'meta', label: `${label} tap skipped`, text: `response.clone() failed: ${String(err)}` })
    }
    return res
  }
}

/** Read a cloned body to completion, publishing decoded chunks as they land. */
async function drainRaw(clone: Response, label: string): Promise<void> {
  const body = clone.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      // Disarmed mid-stream: stop paying for the clone.
      if (!enabled) {
        await reader.cancel().catch(() => {})
        return
      }
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        publishTap({
          kind: 'meta',
          label: `${label} raw truncated`,
          text: `stopped tapping after ${total} bytes (cap ${MAX_RESPONSE_BYTES})`,
        })
        await reader.cancel().catch(() => {})
        return
      }
      const text = decoder.decode(value, { stream: true })
      if (text) publishTap({ kind: 'raw', label, text, bytes: value.byteLength })
    }
    const tail = decoder.decode()
    if (tail) publishTap({ kind: 'raw', label, text: tail })
  } catch (err) {
    publishTap({ kind: 'meta', label: `${label} raw read failed`, text: String(err) })
  }
}

/**
 * Compact JSON for one `fullStream` part, long strings clipped. Callers must
 * gate on `tapEnabled()` — this one *does* cost something per part.
 */
export function summarizeTapPart(part: unknown): string {
  try {
    const json = JSON.stringify(part, (_key: string, value: unknown): unknown => {
      if (value instanceof Error) return `${value.name}: ${value.message}`
      if (typeof value === 'string' && value.length > MAX_PART_FIELD) {
        return `${value.slice(0, MAX_PART_FIELD)}…(+${value.length - MAX_PART_FIELD})`
      }
      return value
    })
    return json ?? String(part)
  } catch (err) {
    return `[unserializable part: ${String(err)}]`
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function shortPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): [string, string][] {
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined)
  if (!source) return []
  if (source instanceof Headers) return headerEntries(source)
  if (Array.isArray(source)) return source.map(([k, v]) => [String(k), String(v)])
  return Object.entries(source).map(([k, v]) => [k, String(v)])
}

function headerEntries(headers: Headers): [string, string][] {
  const out: [string, string][] = []
  headers.forEach((value, key) => out.push([key, value]))
  return out
}

/** Allowlist first, credential-shaped names dropped second. */
function headerLines(entries: [string, string][]): string {
  const lines: string[] = []
  for (const [name, value] of entries) {
    const key = name.toLowerCase()
    if (!HEADER_ALLOWLIST.has(key)) continue
    if (CREDENTIAL_NAME.test(key)) continue
    lines.push(`${key}: ${value}`)
  }
  return lines.join('\n')
}

async function requestBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  const body = init?.body
  if (body === undefined || body === null) {
    // Body-carrying Request with no init override: clone so the original is
    // still unread when it goes to the network.
    if (input instanceof Request && input.body) return clip(await input.clone().text())
    return ''
  }
  if (typeof body === 'string') return clip(body)
  if (body instanceof URLSearchParams) return clip(body.toString())
  if (body instanceof ArrayBuffer) return clip(new TextDecoder().decode(body))
  if (ArrayBuffer.isView(body)) return clip(new TextDecoder().decode(body))
  return `[body not tapped: ${body.constructor?.name ?? typeof body}]`
}

function clip(text: string): string {
  return text.length > MAX_REQUEST_BODY
    ? `${text.slice(0, MAX_REQUEST_BODY)}…(+${text.length - MAX_REQUEST_BODY} chars)`
    : text
}

// A compile-time guard keeps this module side-effect-free in product builds,
// allowing Rollup to remove the entire capture implementation.
if (__DEV_BUILD__) initStreamTap()
