/**
 * "Generate key" console clients for the onboarding flow.
 *
 * Instead of sending the user off to a provider console to mint an API key by
 * hand, the extension calls the console's own internal key-management API using
 * the browser session the user is already signed into. Because these calls run
 * from an extension page (the side panel) whose manifest grants `<all_urls>`
 * host permissions, cross-origin fetches are NOT subject to CORS and cookies
 * ride along with `credentials: 'include'` — exactly what a page-context fetch
 * on the console origin is blocked from doing.
 *
 * Best-effort by design: these are unversioned internal APIs and login/2FA is
 * the user's job. The onboarding UI always keeps "Paste key" as the fallback.
 *
 * Never log key values — read the secret straight into the caller's storage.
 */
import { debugLog } from '../shared/debug-log'

/** Providers that support programmatic key generation. */
export type ProvisionProvider = 'xai' | 'openai'

const KEY_NAME = 'Handoff'

export function providerLabel(provider: ProvisionProvider): string {
  return provider === 'xai' ? 'xAI' : 'OpenAI'
}

/**
 * Is the user signed into the provider console in this browser? A cheap probe
 * used to decide whether to prompt for login before attempting generation.
 */
export async function checkLogin(provider: ProvisionProvider): Promise<boolean> {
  try {
    if (provider === 'xai') return (await resolveXaiTeam()) !== undefined
    // OpenAI's dashboard token lives in an open platform.openai.com tab's
    // localStorage — logged in == we can read a token out of such a tab.
    return Boolean((await readOpenAiTabInfo()).token)
  } catch (err) {
    debugLog.error('agent', 'checkLogin', err)
    return false
  }
}

/**
 * Open the provider console in a new tab. For OpenAI this must be the dashboard
 * itself (not just a login page): loading it signs the user in AND populates the
 * localStorage token the generate step reads back.
 */
export async function openLogin(provider: ProvisionProvider): Promise<void> {
  const url =
    provider === 'xai' ? 'https://console.x.ai/login' : 'https://platform.openai.com/settings/organization/api-keys'
  await chrome.tabs.create({ url, active: true })
}

/**
 * Mint a fresh API key on the provider console and return the secret. Throws a
 * user-facing Error on any failure (not signed in, API changed, network).
 */
export async function generateKey(provider: ProvisionProvider): Promise<string> {
  if (provider === 'xai') return generateXaiKey()
  return generateOpenAiKey()
}

/* ------------------------------------------------------------------ */
/* protobuf + gRPC-web helpers (xAI Connect RPCs)                      */
/* ------------------------------------------------------------------ */

function varint(n: number): number[] {
  const b: number[] = []
  while (n > 0x7f) {
    b.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  b.push(n)
  return b
}

/** Length-delimited (wire type 2) string field. */
function strField(fieldNo: number, value: string): number[] {
  const bytes = new TextEncoder().encode(value)
  return [(fieldNo << 3) | 2, ...varint(bytes.length), ...bytes]
}

/** Wrap a protobuf message in a gRPC-web data frame: [flag=0][u32 len][msg]. */
function grpcFrame(msg: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + msg.length)
  new DataView(frame.buffer).setUint32(1, msg.length) // flag byte stays 0
  frame.set(msg, 5)
  return frame
}

interface GrpcFrame {
  flag: number
  data: Uint8Array
}

/** Split a gRPC-web response body into its frames (data frame + trailer). */
function parseGrpcFrames(buf: Uint8Array): GrpcFrame[] {
  const frames: GrpcFrame[] = []
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = 0
  while (p + 5 <= buf.length) {
    const flag = buf[p]!
    const len = view.getUint32(p + 1)
    const start = p + 5
    const end = start + len
    if (end > buf.length) break
    frames.push({ flag, data: buf.slice(start, end) })
    p = end
  }
  return frames
}

function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  let result = 0
  let shift = 0
  let p = pos
  while (p < bytes.length) {
    const b = bytes[p++]!
    result += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return [result, p]
}

/**
 * Return the bytes of the last length-delimited (wire type 2) field with the
 * given number in a protobuf message, skipping other fields/wire types.
 */
function protoField(bytes: Uint8Array, fieldNo: number): Uint8Array | undefined {
  let p = 0
  let found: Uint8Array | undefined
  while (p < bytes.length) {
    let tag: number
    ;[tag, p] = readVarint(bytes, p)
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 2) {
      let len: number
      ;[len, p] = readVarint(bytes, p)
      const value = bytes.slice(p, p + len)
      p += len
      if (field === fieldNo) found = value
    } else if (wire === 0) {
      ;[, p] = readVarint(bytes, p)
    } else if (wire === 5) {
      p += 4
    } else if (wire === 1) {
      p += 8
    } else {
      break // unknown/group wire type — stop rather than misparse
    }
  }
  return found
}

/** Trailer frames carry ASCII `grpc-status:` / `grpc-message:` headers. */
function grpcTrailerError(frames: GrpcFrame[]): string | undefined {
  const trailer = frames.find((f) => (f.flag & 0x80) !== 0)
  if (!trailer) return undefined
  const text = new TextDecoder().decode(trailer.data)
  const status = /grpc-status:\s*(\d+)/i.exec(text)?.[1]
  if (!status || status === '0') return undefined
  const message = /grpc-message:\s*([^\r\n]+)/i.exec(text)?.[1]
  return message ? decodeURIComponent(message) : `gRPC status ${status}`
}

/* ------------------------------------------------------------------ */
/* xAI — console.x.ai                                                   */
/* ------------------------------------------------------------------ */

/** Resolve the signed-in team UUID (undefined = logged out). */
async function resolveXaiTeam(): Promise<string | undefined> {
  const res = await fetch('https://console.x.ai/', { credentials: 'include', redirect: 'follow' })
  const match = /team\/([0-9a-f-]{36})/.exec(res.url)
  return match?.[1]
}

async function generateXaiKey(): Promise<string> {
  const teamId = await resolveXaiTeam()
  if (!teamId) throw new Error('Not signed in to xAI. Open the console, sign in, then try again.')

  const msg = new Uint8Array([
    ...strField(1, KEY_NAME),
    ...strField(2, teamId),
    ...strField(3, 'api-key:model:*'),
    ...strField(3, 'api-key:endpoint:*'),
  ])
  const res = await fetch('https://console.x.ai/auth_mgmt.AuthManagement/CreateApiKey', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: grpcFrame(msg) as BodyInit,
  })
  if (!res.ok) throw new Error(`xAI create-key failed (HTTP ${res.status}).`)

  const frames = parseGrpcFrames(new Uint8Array(await res.arrayBuffer()))
  const trailerError = grpcTrailerError(frames)
  if (trailerError) throw new Error(`xAI create-key failed: ${trailerError}`)

  const dataFrame = frames.find((f) => (f.flag & 0x80) === 0)
  const secretBytes = dataFrame ? protoField(dataFrame.data, 2) : undefined
  const secret = secretBytes ? new TextDecoder().decode(secretBytes) : ''
  if (!secret.startsWith('xai-')) throw new Error('xAI create-key returned an unexpected response.')
  return secret
}

/* ------------------------------------------------------------------ */
/* OpenAI — api.openai.com dashboard                                   */
/* ------------------------------------------------------------------ */

interface OpenAiSession {
  bearer: string
  orgId: string
  projectId: string
}

/** Deep-find the first string value that passes `ok`. */
function deepFindString(value: unknown, ok: (s: string) => boolean, seen = new Set<unknown>()): string | undefined {
  if (typeof value === 'string') return ok(value) ? value : undefined
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined
  seen.add(value)
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = deepFindString(v, ok, seen)
    if (found) return found
  }
  return undefined
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: unknown[] }).data
  }
  return []
}

function pickDefault<T extends { id?: unknown; is_default?: unknown }>(items: unknown[]): T | undefined {
  const list = items as T[]
  return list.find((it) => it.is_default === true && typeof it.id === 'string') ?? list.find((it) => typeof it.id === 'string')
}

function idOf(item: unknown): string | undefined {
  const id = (item as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

/** List the org's projects and return the default (or first) project id. */
async function fetchDefaultProjectId(orgId: string, bearer: string): Promise<string | undefined> {
  for (const url of [
    `https://api.openai.com/dashboard/organizations/${orgId}/projects?limit=50`,
    `https://api.openai.com/v1/dashboard/organizations/${orgId}/projects?limit=50`,
  ]) {
    try {
      const res = await fetch(url, { credentials: 'include', headers: { authorization: `Bearer ${bearer}` } })
      debugLog.log('agent', `openai projects ${url.includes('/v1/') ? '(v1)' : ''} -> ${res.status}`)
      if (!res.ok) continue
      const data = await res.json()
      const id = idOf(pickDefault(asList(data)))
      if (id) return id
    } catch (err) {
      debugLog.error('agent', 'openai list projects', err)
    }
  }
  return undefined
}

interface OpenAiTabInfo {
  token?: string
  orgId?: string
  projectId?: string
}

/**
 * Thrown by generateKey when the OpenAI dashboard couldn't be reached even after
 * opening it — i.e. the user isn't signed in. The onboarding UI catches this to
 * show the "sign in, then continue" step instead of a generic error.
 */
export class OpenAiLoginRequiredError extends Error {
  constructor() {
    super('Not signed in to OpenAI.')
    this.name = 'OpenAiLoginRequiredError'
  }
}

const OPENAI_DASHBOARD_URL = 'https://platform.openai.com/settings/organization/api-keys'

/**
 * Read the Auth0 access token (+ cached org/project) out of one dashboard tab.
 *
 * The platform.openai.com dashboard is a client-rendered SPA that caches its
 * access token via the Auth0 SPA SDK in localStorage (key
 * `@@auth0spajs@@::…::https://api.openai.com/v1::…`, at `body.access_token`).
 * Every `api.openai.com/dashboard/*` call authorizes with that bearer, and
 * localStorage is origin-locked, so the only way to read it is to script a real
 * tab on that origin. Returns {} when the token isn't there yet (still loading,
 * or not signed in).
 */
async function readInfoFromTab(tabId: number): Promise<OpenAiTabInfo> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const readMaybeJson = (key: string): string | undefined => {
          const raw = localStorage.getItem(key)
          if (!raw) return undefined
          try {
            const parsed = JSON.parse(raw)
            return typeof parsed === 'string' ? parsed : (parsed?.value ?? undefined)
          } catch {
            return raw
          }
        }
        const authKey = Object.keys(localStorage).find(
          (k) => k.startsWith('@@auth0spajs@@') && k.includes('api.openai.com'),
        )
        let token: string | undefined
        if (authKey) {
          try {
            token = JSON.parse(localStorage.getItem(authKey) || '{}')?.body?.access_token
          } catch {
            token = undefined
          }
        }
        return { token, orgId: readMaybeJson('oai/activeOrg'), projectId: readMaybeJson('oai/activeProj') }
      },
    })
    return (injection?.result as OpenAiTabInfo | undefined) ?? {}
  } catch (err) {
    debugLog.error('agent', 'read openai dashboard tab', err)
    return {}
  }
}

/** Read the token from any already-open dashboard tab (no new tab opened). */
async function readOpenAiTabInfo(): Promise<OpenAiTabInfo> {
  const tabs = await chrome.tabs.query({ url: 'https://platform.openai.com/*' })
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue
    const info = await readInfoFromTab(tab.id)
    if (info.token) return info
  }
  return {}
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Get a dashboard token without any manual steps when possible: reuse an open
 * dashboard tab, else open one in the background and poll until the SPA's silent
 * auth populates the token (works with no interaction when the session cookie is
 * still valid). `createdTabId` is set only when we opened a tab, so the caller
 * can close it afterward. An empty token means the user must sign in.
 */
async function acquireOpenAiToken(): Promise<{ info: OpenAiTabInfo; createdTabId?: number }> {
  const existing = await readOpenAiTabInfo()
  if (existing.token) return { info: existing }

  const tab = await chrome.tabs.create({ url: OPENAI_DASHBOARD_URL, active: false })
  const tabId = tab.id
  if (typeof tabId !== 'number') return { info: {} }

  // Poll while the SPA boots + does silent token renewal (~a few seconds).
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await sleep(600)
    const info = await readInfoFromTab(tabId)
    if (info.token) {
      debugLog.log('agent', 'openai: token acquired from background tab')
      return { info, createdTabId: tabId }
    }
  }
  debugLog.log('agent', 'openai: background tab yielded no token (likely signed out)')
  return { info: {}, createdTabId: tabId }
}

/** Resolve the dashboard bearer + default org/project (undefined = couldn't). */
async function openaiBootstrap(tabInfo: OpenAiTabInfo): Promise<OpenAiSession | undefined> {
  if (!tabInfo.token) {
    debugLog.log('agent', 'openai: no dashboard token')
    return undefined
  }

  // onboarding/login (with the bearer) is the authoritative source of the
  // default org+project; the tab's cached ids are a fallback if its shape drifts.
  let orgId: string | undefined
  let projectId: string | undefined
  let bearer = tabInfo.token
  try {
    const res = await fetch('https://api.openai.com/dashboard/onboarding/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tabInfo.token}` },
      body: '{}',
    })
    debugLog.log('agent', `openai onboarding/login -> ${res.status}`)
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>
      // Later calls prefer the short-lived session key (`sess-…`) when present.
      bearer = deepFindString(data, (s) => s.startsWith('sess-')) ?? tabInfo.token
      const org = pickDefault<Record<string, unknown>>(asList(data.orgs))
      orgId = typeof org?.id === 'string' ? org.id : undefined
      // Diagnostic (key names only — no secrets) so we can see the real shape.
      debugLog.log('agent', `openai login shape: data=[${Object.keys(data).join(',')}] org=[${org ? Object.keys(org).join(',') : ''}]`)
      // Projects may be nested under the org (array or {data:[]}) or top-level.
      projectId =
        idOf(pickDefault(asList(org?.projects))) ??
        idOf(pickDefault(asList((data as { projects?: unknown }).projects))) ??
        (typeof org?.default_project_id === 'string' ? org.default_project_id : undefined)
    }
  } catch (err) {
    debugLog.error('agent', 'openai onboarding/login', err)
  }

  orgId = orgId ?? tabInfo.orgId
  // Fallback: ask the dashboard for the org's projects directly.
  if (orgId && !projectId) projectId = await fetchDefaultProjectId(orgId, bearer)
  projectId = projectId ?? tabInfo.projectId

  if (!orgId || !projectId) {
    debugLog.log('agent', `openai: could not resolve org/project (org=${Boolean(orgId)}, project=${Boolean(projectId)})`)
    return undefined
  }
  debugLog.log('agent', 'openai: resolved org + project')
  return { bearer, orgId, projectId }
}

async function generateOpenAiKey(): Promise<string> {
  const { info, createdTabId } = await acquireOpenAiToken()
  try {
    // No token even after opening the dashboard → the user must sign in.
    if (!info.token) throw new OpenAiLoginRequiredError()

    const session = await openaiBootstrap(info)
    if (!session) {
      throw new Error('Signed in, but could not resolve your OpenAI org/project. See debug log.')
    }

    const url = `https://api.openai.com/dashboard/organizations/${session.orgId}/projects/${session.projectId}/api_keys`
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.bearer}` },
      body: JSON.stringify({ action: 'create', name: KEY_NAME, scopes: [], admin_key: false }),
    })
    debugLog.log('agent', `openai create-key -> ${res.status}`)
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`OpenAI create-key failed (HTTP ${res.status}). ${detail.slice(0, 200)}`.trim())
    }

    return await readCreatedKey(res)
  } finally {
    // Close only a tab we opened here; a pre-existing dashboard tab is the
    // user's and is left alone. On login-required the visible sign-in flow
    // (openLogin) opens its own tab, so this background one is disposable.
    if (typeof createdTabId === 'number') {
      chrome.tabs.remove(createdTabId).catch(() => {})
    }
  }
}

async function readCreatedKey(res: Response): Promise<string> {
  const data = (await res.json()) as { key?: unknown }
  const raw = data.key
  const secret =
    typeof raw === 'string'
      ? raw
      : ((raw as { sensitive_id?: string; secret?: string } | undefined)?.sensitive_id ??
        (raw as { secret?: string } | undefined)?.secret ??
        '')
  if (!secret.startsWith('sk-')) throw new Error('OpenAI create-key returned an unexpected response.')
  return secret
}
