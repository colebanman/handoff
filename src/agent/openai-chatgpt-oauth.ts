/**
 * ChatGPT subscription authentication for direct OpenAI models.
 *
 * The primary path uses Codex's normal browser OAuth flow and observes the
 * localhost callback navigation in the dedicated auth tab. Codex device auth
 * remains available as a manual fallback. Tokens stay outside Settings/API-key
 * storage, refresh before expiry, and go only to the ChatGPT Codex backend.
 */

import type { FetchFunction } from '@ai-sdk/provider-utils'
import type { ModelOption } from '../shared/types'
import { debugLog } from '../shared/debug-log'
import { abortable, throwIfAborted } from '../shared/abort'


const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE_URL = 'https://auth.openai.com'
const DEVICE_API_URL = `${AUTH_BASE_URL}/api/accounts`
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
const BROWSER_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const BROWSER_LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const CHATGPT_AUTH_STORAGE_KEY = 'openai_chatgpt_oauth_tokens'
const STORAGE_KEY = CHATGPT_AUTH_STORAGE_KEY
const EXPIRY_MARGIN_MS = 5 * 60 * 1000
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000
const FALLBACK_ACCESS_LIFETIME_MS = 55 * 60 * 1000
const ORIGINATOR = 'handoff'

/**
 * Codex protocol revision this client targets — NOT the extension's own
 * version. These are separate namespaces, and sending the manifest version
 * ("0.1.0") here silently broke the model catalog: every entry declares a
 * `minimal_client_version` (0.144.0 for the gpt-5.6 family, 0.124.0 for
 * gpt-5.5) and the backend filters the response by the `client_version` query
 * param, so a 0.1.0 client is told no models exist at all.
 *
 * Bump this when adopting a Codex protocol feature that needs a newer floor.
 */
const CODEX_CLIENT_VERSION = '0.144.0'

export interface StoredTokens {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
  accountId: string
  email?: string
  planType?: string
  isFedRamp?: boolean
}

export interface ChatGPTCredentials {
  accessToken: string
  accountId: string
  isFedRamp: boolean
}

export interface ChatGPTAccountStatus {
  connected: boolean
  email?: string
  planType?: string
  accountId?: string
}

export interface ChatGPTDeviceCode {
  verificationUrl: string
  userCode: string
  /** Opaque values returned by the auth service and needed by the polling leg. */
  deviceAuthId: string
  intervalMs: number
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

interface JwtClaims {
  exp?: number
  email?: string
  'https://api.openai.com/profile'?: { email?: string }
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
    chatgpt_plan_type?: string
    chatgpt_account_is_fedramp?: boolean
  }
}

let refreshInFlight: Promise<StoredTokens> | undefined
let authGeneration = 0
let modelCache: { accountId: string; at: number; models: ModelOption[] } | undefined
let storageMutation: Promise<void> = Promise.resolve()

function enqueueStorageMutation<T>(mutate: () => Promise<T>): Promise<T> {
  const run = storageMutation.then(mutate, mutate)
  storageMutation = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function decodeJwtClaims(token: string): JwtClaims | undefined {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as JwtClaims
  } catch {
    return undefined
  }
}

function responseDetail(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed) as { error_description?: unknown; error?: unknown; message?: unknown }
    const detail = parsed.error_description ?? parsed.message ?? parsed.error
    if (typeof detail === 'string') return detail.slice(0, 300)
  } catch {
    // Plain-text error response.
  }
  return trimmed.slice(0, 300)
}

async function errorDetail(res: Response): Promise<string> {
  return responseDetail(await res.text().catch(() => ''))
}

function actualExpiry(accessToken: string, expiresIn?: number): number {
  const exp = decodeJwtClaims(accessToken)?.exp
  if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
    return Date.now() + expiresIn * 1000
  }
  return Date.now() + FALLBACK_ACCESS_LIFETIME_MS
}

function tokensFromResponse(data: TokenResponse, previous?: StoredTokens): StoredTokens {
  const accessToken = data.access_token ?? previous?.accessToken
  const refreshToken = data.refresh_token ?? previous?.refreshToken
  const idToken = data.id_token ?? previous?.idToken
  if (!accessToken || !refreshToken || !idToken) {
    throw new Error('ChatGPT token response was incomplete. Start the sign-in again.')
  }

  const claims = decodeJwtClaims(idToken)
  const auth = claims?.['https://api.openai.com/auth']
  const accountId = auth?.chatgpt_account_id ?? previous?.accountId
  if (!accountId) {
    throw new Error('ChatGPT sign-in did not return a workspace. Start the sign-in again and choose a workspace.')
  }

  return {
    accessToken,
    refreshToken,
    idToken,
    expiresAt: actualExpiry(accessToken, data.expires_in),
    accountId,
    email: claims?.email ?? claims?.['https://api.openai.com/profile']?.email ?? previous?.email,
    planType: auth?.chatgpt_plan_type ?? previous?.planType,
    isFedRamp: auth?.chatgpt_account_is_fedramp ?? previous?.isFedRamp ?? false,
  }
}

async function loadTokens(): Promise<StoredTokens | undefined> {
  await storageMutation
  const out = await chrome.storage.local.get(STORAGE_KEY)
  const value = out[STORAGE_KEY] as Partial<StoredTokens> | undefined
  if (
    !value ||
    typeof value.accessToken !== 'string' ||
    typeof value.refreshToken !== 'string' ||
    typeof value.idToken !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    typeof value.accountId !== 'string'
  ) {
    return undefined
  }
  return value as StoredTokens
}

async function saveTokens(tokens: StoredTokens, generation = authGeneration): Promise<void> {
  await enqueueStorageMutation(async () => {
    if (generation !== authGeneration) throw new Error('ChatGPT sign-in was cancelled.')

    await chrome.storage.local.set({ [STORAGE_KEY]: tokens })
    if (generation !== authGeneration) throw new Error('ChatGPT sign-in was cancelled.')
  })
}

function toCredentials(tokens: StoredTokens): ChatGPTCredentials {
  return {
    accessToken: tokens.accessToken,
    accountId: tokens.accountId,
    isFedRamp: tokens.isFedRamp === true,
  }
}

function authHeaders(credentials: ChatGPTCredentials, source?: HeadersInit): Headers {
  const headers = new Headers(source)
  headers.set('Authorization', `Bearer ${credentials.accessToken}`)
  headers.set('ChatGPT-Account-ID', credentials.accountId)
  headers.set('originator', ORIGINATOR)
  if (credentials.isFedRamp) headers.set('X-OpenAI-Fedramp', 'true')
  else headers.delete('X-OpenAI-Fedramp')
  return headers
}

async function pkceChallenge(codeVerifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)),
  )
  return base64Url(digest)
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

function browserAuthorizeUrl(codeChallenge: string, state: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: BROWSER_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: ORIGINATOR,
  })
  return `${AUTH_BASE_URL}/oauth/authorize?${query}`
}

async function browserAuthorizationCode(
  authorizeUrl: string,
  expectedState: string,
  signal?: AbortSignal,
): Promise<string> {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true })
  if (typeof tab.id !== 'number') throw new Error('Could not open the ChatGPT sign-in tab.')
  const tabId = tab.id

  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const timeout = window.setTimeout(
        () => finish(new Error('ChatGPT sign-in timed out. Start the sign-in again.')),
        BROWSER_LOGIN_TIMEOUT_MS,
      )

      const cleanup = (): void => {
        window.clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(onUpdated)
        chrome.tabs.onRemoved.removeListener(onRemoved)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (error?: Error, code?: string): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve(code as string)
      }
      const onAbort = (): void => finish(new Error('ChatGPT sign-in cancelled.'))
      const onRemoved = (removedTabId: number): void => {
        if (removedTabId === tabId) finish(new Error('ChatGPT sign-in tab was closed.'))
      }
      const onUpdated = (
        updatedTabId: number,
        changeInfo: { url?: string },
        updatedTab: chrome.tabs.Tab,
      ): void => {
        if (updatedTabId !== tabId) return
        const nextUrl = changeInfo.url ?? updatedTab.url
        if (!nextUrl) return
        let callback: URL
        try {
          callback = new URL(nextUrl)
        } catch {
          return
        }
        if (callback.origin !== 'http://localhost:1455' || callback.pathname !== '/auth/callback') return

        if (callback.searchParams.get('state') !== expectedState) {
          finish(new Error('ChatGPT sign-in returned an invalid state. Start the sign-in again.'))
          return
        }
        const oauthError = callback.searchParams.get('error')
        if (oauthError) {
          const description = callback.searchParams.get('error_description')
          finish(new Error(description || `ChatGPT sign-in was denied (${oauthError}).`))
          return
        }
        const code = callback.searchParams.get('code')
        if (!code) {
          finish(new Error('ChatGPT sign-in did not return an authorization code.'))
          return
        }
        finish(undefined, code)
      }

      chrome.tabs.onUpdated.addListener(onUpdated)
      chrome.tabs.onRemoved.addListener(onRemoved)
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      void chrome.tabs.update(tabId, { url: authorizeUrl }).catch((error: unknown) => {
        finish(new Error(`Could not open ChatGPT sign-in. ${error instanceof Error ? error.message : String(error)}`))
      })
    })
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {})
  }
}

async function exchangeAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
  redirectUri: string,
  generation: number,
  flow: 'browser' | 'device',
  signal?: AbortSignal,
): Promise<ChatGPTAccountStatus> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', originator: ORIGINATOR },
    body,
    credentials: 'omit',
    cache: 'no-store',
    signal,
  })
  if (!res.ok) {
    const detail = await errorDetail(res)
    throw new Error(`ChatGPT token exchange failed (${res.status}).${detail ? ` ${detail}` : ''}`)
  }

  const tokens = tokensFromResponse((await res.json()) as TokenResponse)
  await saveTokens(tokens, generation)
  modelCache = undefined
  debugLog.log('agent', 'chatgpt oauth connected', {
    flow,
    planType: tokens.planType,
    hasEmail: Boolean(tokens.email),
  })
  return {
    connected: true,
    email: tokens.email,
    planType: tokens.planType,
    accountId: tokens.accountId,
  }
}

/** Open normal ChatGPT OAuth and capture its PKCE callback automatically. */
export async function connectChatGPTInBrowser(signal?: AbortSignal): Promise<ChatGPTAccountStatus> {
  const generation = authGeneration
  const codeVerifier = randomBase64Url(64)
  const state = randomBase64Url(32)
  const codeChallenge = await pkceChallenge(codeVerifier)
  const authorizationCode = await browserAuthorizationCode(
    browserAuthorizeUrl(codeChallenge, state),
    state,
    signal,
  )
  return exchangeAuthorizationCode(
    authorizationCode,
    codeVerifier,
    BROWSER_REDIRECT_URI,
    generation,
    'browser',
    signal,
  )
}

/** Request a one-time code that the user enters on the ChatGPT device page. */
export async function requestChatGPTDeviceCode(): Promise<ChatGPTDeviceCode> {
  const res = await fetch(`${DEVICE_API_URL}/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', originator: ORIGINATOR },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    credentials: 'omit',
    cache: 'no-store',
  })
  if (!res.ok) {
    const detail = await errorDetail(res)
    throw new Error(
      `Could not start ChatGPT sign-in (${res.status}).${detail ? ` ${detail}` : ''} ` +
        'Make sure device-code login is enabled in ChatGPT security settings.',
    )
  }

  const data = (await res.json()) as {
    device_auth_id?: unknown
    user_code?: unknown
    usercode?: unknown
    interval?: unknown
  }
  const deviceAuthId = typeof data.device_auth_id === 'string' ? data.device_auth_id : ''
  const userCode =
    typeof data.user_code === 'string'
      ? data.user_code
      : typeof data.usercode === 'string'
        ? data.usercode
        : ''
  const intervalSeconds = Number(data.interval)
  if (!deviceAuthId || !userCode) throw new Error('ChatGPT device-code response was incomplete.')

  return {
    verificationUrl: `${AUTH_BASE_URL}/codex/device`,
    userCode,
    deviceAuthId,
    intervalMs: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds * 1000 : 5_000,
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ChatGPT sign-in cancelled.'))
      return
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      window.clearTimeout(timer)
      reject(new Error('ChatGPT sign-in cancelled.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Poll until the user approves the code, exchange it, and persist the session. */
export async function completeChatGPTDeviceLogin(
  device: ChatGPTDeviceCode,
  signal?: AbortSignal,
): Promise<ChatGPTAccountStatus> {
  const generation = authGeneration
  const startedAt = Date.now()
  let codeResponse:
    | { authorization_code?: unknown; code_verifier?: unknown; code_challenge?: unknown }
    | undefined

  while (Date.now() - startedAt < DEVICE_TIMEOUT_MS) {
    if (signal?.aborted) throw new Error('ChatGPT sign-in cancelled.')
    const res = await fetch(`${DEVICE_API_URL}/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', originator: ORIGINATOR },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      credentials: 'omit',
      cache: 'no-store',
      signal,
    })
    if (res.ok) {
      codeResponse = (await res.json()) as typeof codeResponse
      break
    }
    if (res.status !== 403 && res.status !== 404) {
      const detail = await errorDetail(res)
      throw new Error(`ChatGPT sign-in failed (${res.status}).${detail ? ` ${detail}` : ''}`)
    }
    await wait(device.intervalMs, signal)
  }

  const authorizationCode =
    typeof codeResponse?.authorization_code === 'string' ? codeResponse.authorization_code : ''
  const codeVerifier = typeof codeResponse?.code_verifier === 'string' ? codeResponse.code_verifier : ''
  const codeChallenge = typeof codeResponse?.code_challenge === 'string' ? codeResponse.code_challenge : ''
  if (!authorizationCode || !codeVerifier || !codeChallenge) {
    throw new Error('ChatGPT sign-in timed out. Start the sign-in again.')
  }
  if ((await pkceChallenge(codeVerifier)) !== codeChallenge) {
    throw new Error('ChatGPT sign-in returned an invalid PKCE proof. Start the sign-in again.')
  }

  return exchangeAuthorizationCode(
    authorizationCode,
    codeVerifier,
    DEVICE_REDIRECT_URI,
    generation,
    'device',
    signal,
  )
}

async function refreshTokens(rejectedAccessToken?: string): Promise<StoredTokens> {
  const current = await loadTokens()
  if (!current) throw new Error('No ChatGPT account connected. Open Settings and sign in with ChatGPT.')
  // Another request already rotated the token that received the 401.
  if (rejectedAccessToken && current.accessToken !== rejectedAccessToken) return current
  if (refreshInFlight) return refreshInFlight

  const generation = authGeneration
  const task = (async (): Promise<StoredTokens> => {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', originator: ORIGINATOR },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      }),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const detail = await errorDetail(res)
      throw new Error(
        `ChatGPT session refresh failed (${res.status}). Reconnect your ChatGPT account in Settings.` +
          (detail ? ` ${detail}` : ''),
      )
    }
    const next = tokensFromResponse((await res.json()) as TokenResponse, current)
    await saveTokens(next, generation)
    return next
  })()
  refreshInFlight = task
  try {
    return await task
  } finally {
    if (refreshInFlight === task) refreshInFlight = undefined
  }
}

export async function getValidChatGPTCredentials(force = false, signal?: AbortSignal): Promise<ChatGPTCredentials> {
  signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
  const tokens = await abortable(loadTokens(), signal)
  if (!tokens) throw new Error('No ChatGPT account connected. Open Settings and sign in with ChatGPT.')
  if (force || Date.now() + EXPIRY_MARGIN_MS >= tokens.expiresAt) {
    return toCredentials(await abortable(refreshTokens(force ? tokens.accessToken : undefined), signal))
  }
  return toCredentials(tokens)
}

export async function getChatGPTAccountStatus(): Promise<ChatGPTAccountStatus> {
  const tokens = await loadTokens()
  return tokens
    ? {
        connected: true,
        email: tokens.email,
        planType: tokens.planType,
        accountId: tokens.accountId,
      }
    : { connected: false }
}

export async function isChatGPTConnected(): Promise<boolean> {
  return (await loadTokens()) !== undefined
}

export async function disconnectChatGPT(): Promise<void> {
  authGeneration += 1
  refreshInFlight = undefined
  modelCache = undefined

  await enqueueStorageMutation(() => chrome.storage.local.remove(STORAGE_KEY))
  debugLog.log('agent', 'chatgpt oauth disconnected')
}

/**
 * OpenAI SDK fetch wrapper for ChatGPT-backed Responses calls. It always reads
 * the latest token, adds the selected workspace, and retries one 401 after a
 * serialized refresh so parallel agents cannot race refresh-token rotation.
 */
export function makeChatGPTFetch(): FetchFunction {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const credentials = await getValidChatGPTCredentials(false, signal ?? undefined)
    const sourceHeaders =
      init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
    const send = (next: ChatGPTCredentials): Promise<Response> =>
      fetch(input as Parameters<typeof fetch>[0], {
        ...(init as RequestInit),
        headers: authHeaders(next, sourceHeaders as HeadersInit | undefined),
        credentials: 'omit',
      })

    const res = await send(credentials)
    if (res.status !== 401) return res
    let next: ChatGPTCredentials
    try {
      next = toCredentials(await abortable(refreshTokens(credentials.accessToken), signal ?? undefined))
    } catch {
      throwIfAborted(signal ?? undefined)
      return res
    }
    void res.body?.cancel().catch(() => {})
    return send(next)
  }
}

interface RemoteModel {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  priority?: unknown
  context_window?: unknown
}

/** Fetch the account-entitled model picker catalog from the ChatGPT backend. */
export async function listChatGPTModels(force = false, signal?: AbortSignal): Promise<ModelOption[]> {
  signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])
  const credentials = await getValidChatGPTCredentials(false, signal)
  if (!force && modelCache?.accountId === credentials.accountId && Date.now() - modelCache.at < 5 * 60 * 1000) {
    return modelCache.models
  }

  const url = `${CHATGPT_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`
  const send = (next: ChatGPTCredentials): Promise<Response> =>
    abortable(fetch(url, {
      headers: authHeaders(next, { Accept: 'application/json' }),
      credentials: 'omit',
      cache: 'no-store',
      signal,
    }), signal)
  let res = await send(credentials)
  if (res.status === 401) {
    const next = toCredentials(await abortable(refreshTokens(credentials.accessToken), signal))
    void res.body?.cancel().catch(() => {})
    res = await send(next)
  }
  if (!res.ok) {
    const detail = await errorDetail(res)
    throw new Error(`Could not load ChatGPT models (${res.status}).${detail ? ` ${detail}` : ''}`)
  }

  const data = (await abortable(res.json(), signal)) as { models?: unknown }
  const remote = Array.isArray(data.models) ? (data.models as RemoteModel[]) : []
  const models = remote
    .filter(
      (model) =>
        typeof model.slug === 'string' &&
        (model.visibility === undefined || model.visibility === 'list'),
    )
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
    .map((model) => ({
      id: model.slug as string,
      label: typeof model.display_name === 'string' ? model.display_name : (model.slug as string),
      provider: 'openai' as const,
      ...(typeof model.context_window === 'number' && model.context_window > 0 ? { contextWindow: model.context_window } : {}),
    }))
  modelCache = { accountId: credentials.accountId, at: Date.now(), models }
  // The catalog silently came back empty for a long time (see
  // CODEX_CLIENT_VERSION); log what the backend actually returned so a
  // regression is visible instead of just producing an empty picker.
  debugLog.log('agent', 'chatgpt model catalog', { models: models.map((m) => m.id) })
  return models
}
