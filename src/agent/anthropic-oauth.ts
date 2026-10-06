/**
 * Claude subscription OAuth, using PKCE without running a Claude Code process.
 * Protocol reference: https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/anthropic.ts
 * Credentials live in extension-local storage, separate from synced settings.
 */
import { abortable, abortError, throwIfAborted } from '../shared/abort'
import { CLAUDE_OAUTH_USER_AGENT, ensureAnthropicBrowserTransport } from './anthropic-browser'
import { redactSecrets } from '../shared/redact'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const BROWSER_REDIRECT_URI = 'http://localhost:53692/callback'
const COPY_CODE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const EXPIRY_MARGIN_MS = 5 * 60 * 1000
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const LOCK_NAME = 'handoff-claude-oauth'
export const CLAUDE_AUTH_STORAGE_KEY = 'anthropic_claude_oauth_tokens'

export interface ClaudeAccountStatus {
  connected: boolean
  email?: string
}

export interface ClaudeCredentials {
  accessToken: string
}

interface ClaudeTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
}

interface AuthRecord {
  revision: string
  tokens?: ClaudeTokens
}

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  account?: { email_address?: unknown }
}

export interface ClaudeSignInOptions {
  signal?: AbortSignal
  onAuthUrl?: (url: string) => void
  method?: 'browser' | 'copy-code'
  onAuthTab?: (tabId: number) => void
  onPhaseChange?: (phase: ClaudeSignInPhase) => void
}

export type ClaudeSignInPhase = 'opening-browser' | 'waiting-browser' | 'exchanging-token'

let localMutation: Promise<unknown> = Promise.resolve()
let authGeneration = 0
let activeLogin: AbortController | undefined
let submitCode: ((input: string) => void) | undefined

/** Web Locks serialize rotating refresh tokens across side panels and offscreen hosts. */
async function withAuthLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return await navigator.locks.request(LOCK_NAME, operation)
  }
  // Also works in tests and older extension environments without Web Locks.
  const next = localMutation.then(operation, operation)
  localMutation = next.then(() => undefined, () => undefined)
  return next
}

function base64Url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomValue(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

async function readRecord(): Promise<AuthRecord | undefined> {
  const stored = (await chrome.storage.local.get(CLAUDE_AUTH_STORAGE_KEY))[CLAUDE_AUTH_STORAGE_KEY] as Partial<AuthRecord> | undefined
  if (!stored || typeof stored.revision !== 'string') return undefined
  const tokens = stored.tokens
  if (!tokens || typeof tokens.accessToken !== 'string' || !tokens.accessToken ||
      typeof tokens.refreshToken !== 'string' || !tokens.refreshToken ||
      typeof tokens.expiresAt !== 'number' || !Number.isFinite(tokens.expiresAt)) {
    return { revision: stored.revision }
  }
  return { revision: stored.revision, tokens }
}

function writeRecord(record: AuthRecord): Promise<void> {
  return chrome.storage.local.set({ [CLAUDE_AUTH_STORAGE_KEY]: record })
}

function status(tokens?: ClaudeTokens): ClaudeAccountStatus {
  return tokens ? { connected: true, ...(tokens.email ? { email: tokens.email } : {}) } : { connected: false }
}

function parseTokens(data: TokenResponse, previous?: ClaudeTokens): ClaudeTokens {
  if (!data || typeof data !== 'object') throw new Error('Claude returned an incomplete sign-in response. Sign in again from Settings.')
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : previous?.refreshToken
  if (!accessToken || !refreshToken || typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new Error('Claude returned an incomplete sign-in response. Sign in again from Settings.')
  }
  const email = typeof data.account?.email_address === 'string' ? data.account.email_address : previous?.email
  return { accessToken, refreshToken, expiresAt: Date.now() + data.expires_in * 1000, ...(email ? { email } : {}) }
}

async function postToken(body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  await abortable(ensureAnthropicBrowserTransport(), signal)
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', 'User-Agent': CLAUDE_OAUTH_USER_AGENT },
    body: JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
  })
  if (!response.ok) {
    // Report the provider's diagnosis without assuming 429 means excess usage.
    // Only extract JSON error text, then remove any echoed grant secrets.
    let detail = ''
    try {
      const data = await response.json() as { error?: string | { message?: string }; error_description?: string }
      const candidate = data?.error_description ?? (typeof data?.error === 'object' ? data.error?.message : data?.error)
      if (typeof candidate === 'string') {
        detail = candidate
        for (const key of ['code', 'code_verifier', 'refresh_token', 'state']) {
          const secret = body[key]
          if (secret) detail = detail.replaceAll(secret, '[redacted]')
        }
        detail = redactSecrets(detail).replace(/[\r\n\t]+/g, ' ').slice(0, 300)
      }
    } catch { /* HTML gateway/challenge pages are never shown as raw errors. */ }
    const requestId = response.headers.get('request-id')
    const reference = requestId && /^req_[a-zA-Z0-9_-]{1,100}$/.test(requestId) ? ` Reference: ${requestId}.` : ''
    const retry = response.status === 400 || response.status === 401
      ? ' Start a new sign-in from Settings.' : ' Start a new sign-in after resolving the error.'
    throw new Error(`Claude sign-in request failed (${response.status}).${detail ? ` ${detail}` : ''}${reference}${retry}`)
  }
  try {
    return await response.json() as TokenResponse
  } catch {
    throw new Error('Claude returned an invalid sign-in response. Please try again.')
  }
}

function authorizationCode(input: string, expectedState: string): string {
  const value = input.trim()
  let code: string | null = null
  let state: string | null = null
  try {
    const url = new URL(value)
    if (url.href.startsWith('http:') || url.href.startsWith('https:')) {
      const allowed = [new URL(BROWSER_REDIRECT_URI), new URL(COPY_CODE_REDIRECT_URI)]
      if (!allowed.some((target) => target.origin === url.origin && target.pathname === url.pathname)) {
        throw new Error('Paste the Claude callback URL or the code#state shown after signing in.')
      }
      code = url.searchParams.get('code')
      state = url.searchParams.get('state')
    }
  } catch (error) {
    if (error instanceof Error && !(error instanceof TypeError)) throw error
  }
  if (!code && !state) {
    const separator = value.indexOf('#')
    if (separator >= 0) {
      code = value.slice(0, separator)
      state = value.slice(separator + 1)
    } else if (value.includes('code=')) {
      const params = new URLSearchParams(value.replace(/^\?/, ''))
      code = params.get('code')
      state = params.get('state')
    }
  }
  if (!state || state !== expectedState) throw new Error('Claude sign-in returned an invalid state. Use the code from the current sign-in tab.')
  if (!code) throw new Error('Claude sign-in did not return an authorization code.')
  return code
}

/** Paste fallback accepts the complete callback URL or provider-issued code#state. */
export function submitClaudeAuthorizationCode(input: string): boolean {
  if (!submitCode) return false
  submitCode(input)
  return true
}

async function waitForCode(authorizeUrl: string, redirectUri: string, state: string, options: ClaudeSignInOptions, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true })
  if (typeof tab.id !== 'number') throw new Error('Could not open the Claude sign-in tab.')
  const tabId = tab.id
  const redirect = new URL(redirectUri)
  try {
    options.onAuthTab?.(tabId)
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        chrome.tabs.onUpdated.removeListener(onUpdated)
        chrome.tabs.onRemoved.removeListener(onRemoved)
        signal.removeEventListener('abort', onAbort)
        if (submitCode === onManualCode) submitCode = undefined
      }
      const finish = (error?: unknown, code?: string): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve(code!)
      }
      // Validation failures from manually pasted input remain correctable in the UI.
      const onManualCode = (input: string): void => finish(undefined, authorizationCode(input, state))
      const onAbort = (): void => finish(signal.reason ?? abortError('Claude sign-in cancelled.'))
      const onRemoved = (removedId: number): void => {
        if (removedId === tabId) finish(new Error('Claude sign-in tab was closed. Start sign-in again.'))
      }
      const onUpdated = (updatedId: number, change: { url?: string }, updatedTab: chrome.tabs.Tab): void => {
        if (updatedId !== tabId) return
        const candidate = change.url ?? updatedTab.pendingUrl ?? updatedTab.url
        if (!candidate) return
        let url: URL
        try { url = new URL(candidate) } catch { return }
        if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) return
        // The copy-code landing page can show the code in its body rather than its URL.
        if (options.method === 'copy-code' && !url.searchParams.has('code') && !url.searchParams.has('error')) return
        if (url.searchParams.get('state') !== state) {
          finish(new Error('Claude sign-in returned an invalid state. Start sign-in again.'))
        } else if (url.searchParams.has('error')) {
          finish(new Error('Claude sign-in was declined. Start sign-in again to connect your subscription.'))
        } else {
          try { finish(undefined, authorizationCode(candidate, state)) } catch (error) { finish(error) }
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated)
      chrome.tabs.onRemoved.addListener(onRemoved)
      submitCode = onManualCode
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      try {
        options.onAuthUrl?.(authorizeUrl)
        options.onPhaseChange?.('waiting-browser')
      } catch (error) { finish(error); return }
      void chrome.tabs.update(tabId, { url: authorizeUrl }).catch(() => finish(new Error('Could not open Claude sign-in. Please try again.')))
    })
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {})
  }
}

export async function signInClaude(options: ClaudeSignInOptions = {}): Promise<ClaudeAccountStatus> {
  throwIfAborted(options.signal)
  activeLogin?.abort(abortError('A newer Claude sign-in was started.'))
  const controller = new AbortController()
  activeLogin = controller
  const generation = authGeneration
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])])
  const timer = setTimeout(() => controller.abort(new Error('Claude sign-in timed out. Start sign-in again.')), LOGIN_TIMEOUT_MS)
  try {
    options.onPhaseChange?.('opening-browser')
    const revision = randomValue()
    await withAuthLock(async () => {
      throwIfAborted(signal)
      const current = await readRecord()
      await writeRecord({ revision, ...(current?.tokens ? { tokens: current.tokens } : {}) })
    })
    const verifier = randomValue()
    const state = randomValue()
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const redirectUri = options.method === 'copy-code' ? COPY_CODE_REDIRECT_URI : BROWSER_REDIRECT_URI
    const query = new URLSearchParams({
      code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri,
      scope: SCOPES, code_challenge: challenge, code_challenge_method: 'S256', state,
    })
    const code = await waitForCode(`${AUTHORIZE_URL}?${query}`, redirectUri, state, options, signal)
    throwIfAborted(signal)
    options.onPhaseChange?.('exchanging-token')
    const tokens = parseTokens(await postToken({
      grant_type: 'authorization_code', client_id: CLIENT_ID, code, state,
      redirect_uri: redirectUri, code_verifier: verifier,
    }, signal))
    await withAuthLock(async () => {
      const current = await readRecord()
      throwIfAborted(signal)
      if (generation !== authGeneration || current?.revision !== revision) {
        throw abortError('Claude sign-in was cancelled or replaced.')
      }
      await writeRecord({ revision, tokens })
      // A cancellation can arrive while the storage commit is pending. Restore
      // the prior session under the same lock before a queued login/sign-out runs.
      if (signal.aborted || generation !== authGeneration) {
        await writeRecord(current)
        throwIfAborted(signal)
        throw abortError('Claude sign-in was cancelled.')
      }
    })
    return status(tokens)
  } finally {
    clearTimeout(timer)
    if (activeLogin === controller) activeLogin = undefined
  }
}

export async function getClaudeAccountStatus(): Promise<ClaudeAccountStatus> {
  return status((await readRecord())?.tokens)
}

export async function signOutClaude(): Promise<void> {
  ++authGeneration
  activeLogin?.abort(abortError('Claude sign-in cancelled.'))
  activeLogin = undefined
  // Keep a revision tombstone so another context cannot finish an earlier login.
  await withAuthLock(() => writeRecord({ revision: randomValue() }))
}

export async function getValidClaudeCredentials(forceRefresh = false, signal?: AbortSignal, rejectedAccessToken?: string): Promise<ClaudeCredentials> {
  throwIfAborted(signal)
  const initial = await abortable(readRecord(), signal)
  if (!initial?.tokens) throw new Error('No Claude account connected. Open Settings and sign in with Claude.')
  if (!forceRefresh && initial.tokens.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return { accessToken: initial.tokens.accessToken }
  const originalToken = rejectedAccessToken ?? initial.tokens.accessToken
  // Refresh is shared work. A caller cancelling its request should not cancel a
  // rotating token exchange needed by another running agent or extension page.
  const operation = withAuthLock(async () => {
    const current = await readRecord()
    if (!current?.tokens) throw new Error('Claude was signed out. Sign in again from Settings.')
    if (current.tokens.accessToken !== originalToken || (!forceRefresh && current.tokens.expiresAt > Date.now() + EXPIRY_MARGIN_MS)) {
      return { accessToken: current.tokens.accessToken }
    }
    const generation = authGeneration
    const tokens = parseTokens(await postToken({
      grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: current.tokens.refreshToken,
    }), current.tokens)
    if (generation !== authGeneration) throw abortError('Claude was signed out while refreshing.')
    await writeRecord({ revision: current.revision, tokens })
    return { accessToken: tokens.accessToken }
  })
  return abortable(operation, signal)
}
