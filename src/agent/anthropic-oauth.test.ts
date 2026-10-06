import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Auth = typeof import('./anthropic-oauth')
type Updated = (id: number, change: { url?: string }, tab: chrome.tabs.Tab) => void

let auth: Auth
let stored: Record<string, unknown>
let updates: Set<Updated>
let removals: Set<(id: number) => void>
let tabs: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
let request: ReturnType<typeof vi.fn<typeof fetch>>

function tokenResponse(overrides: object = {}): Response {
  return Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600, account: { email_address: 'user@example.com' }, ...overrides })
}

function seed(expiresAt = 0): void {
  stored[auth.CLAUDE_AUTH_STORAGE_KEY] = {
    revision: 'existing-session',
    tokens: { accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt, email: 'user@example.com' },
  }
}

function navigate(url: string, id = 7): void {
  for (const listener of updates) listener(id, { url }, { id, url } as chrome.tabs.Tab)
}

async function begin(options: Parameters<Auth['signInClaude']>[0] = {}): Promise<{ login: Promise<unknown>; url: URL }> {
  let authorizeUrl: string | undefined
  const login = auth.signInClaude({ ...options, onAuthUrl: (url) => { authorizeUrl = url } })
  // Attach immediately so intentionally rejected flows never create an unhandled rejection.
  void login.catch(() => {})
  await vi.waitFor(() => expect(authorizeUrl).toBeDefined())
  return { login, url: new URL(authorizeUrl!) }
}

function callback(authorize: URL, override: Record<string, string> = {}): string {
  const url = new URL(authorize.searchParams.get('redirect_uri')!)
  url.search = new URLSearchParams({ code: 'authorization-code', state: authorize.searchParams.get('state')!, ...override }).toString()
  return url.href
}

beforeEach(async () => {
  vi.resetModules()
  stored = {}
  updates = new Set()
  removals = new Set()
  let queue: Promise<unknown> = Promise.resolve()
  vi.stubGlobal('navigator', { locks: { request: vi.fn((_name: string, work: () => Promise<unknown>) => {
    const next = queue.then(work, work)
    queue = next.catch(() => {})
    return next
  }) } })
  tabs = { create: vi.fn(async () => ({ id: 7 })), update: vi.fn(async () => ({})), remove: vi.fn(async () => {}) }
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: structuredClone(stored[key]) })),
      set: vi.fn(async (value: object) => { Object.assign(stored, structuredClone(value)) }),
    } },
    tabs: { ...tabs,
      onUpdated: { addListener: (fn: Updated) => updates.add(fn), removeListener: (fn: Updated) => updates.delete(fn) },
      onRemoved: { addListener: (fn: (id: number) => void) => removals.add(fn), removeListener: (fn: (id: number) => void) => removals.delete(fn) },
    },
  })
  request = vi.fn<typeof fetch>(async () => tokenResponse())
  vi.stubGlobal('fetch', request)
  auth = await import('./anthropic-oauth')
})

afterEach(() => vi.unstubAllGlobals())

describe('Claude browser subscription OAuth', () => {
  it('captures only the dedicated callback tab, exchanges PKCE, and stores local account status', async () => {
    const phases: string[] = [], authTabs: number[] = []
    const { login, url } = await begin({ onPhaseChange: (phase) => phases.push(phase), onAuthTab: (id) => authTabs.push(id) })
    expect(phases).toEqual(['opening-browser', 'waiting-browser'])
    expect(authTabs).toEqual([7])
    expect(url.origin).toBe('https://claude.ai')
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    navigate(callback(url), 99)
    expect(request).not.toHaveBeenCalled()
    navigate(callback(url))
    await expect(login).resolves.toEqual({ connected: true, email: 'user@example.com' })
    const [endpoint, init] = request.mock.calls[0]!
    expect(endpoint).toBe('https://platform.claude.com/v1/oauth/token')
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(new Headers(init?.headers).get('user-agent')).toBe('axios/1.15.2')
    expect(phases).toEqual(['opening-browser', 'waiting-browser', 'exchanging-token'])
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'authorization-code', state: url.searchParams.get('state'), redirect_uri: 'http://localhost:53692/callback' })
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier)))
    const challenge = btoa(Array.from(digest, (byte) => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(challenge).toBe(url.searchParams.get('code_challenge'))
    expect(body.code_verifier).not.toBe(body.state)
    expect(tabs.remove).toHaveBeenCalledWith(7)
    expect(updates.size).toBe(0)
    expect(removals.size).toBe(0)
    expect(await auth.getValidClaudeCredentials()).toEqual({ accessToken: 'access-new' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects mismatched callback state without sending a token exchange', async () => {
    const { login, url } = await begin()
    navigate(callback(url, { state: 'foreign-flow' }))
    await expect(login).rejects.toThrow(/invalid state/)
    expect(request).not.toHaveBeenCalled()
    expect(await auth.getClaudeAccountStatus()).toEqual({ connected: false })
  })

  it('supports copy-code fallback with correctable input errors and strict state checking', async () => {
    const { login, url } = await begin({ method: 'copy-code' })
    expect(url.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback')
    navigate(url.searchParams.get('redirect_uri')!)
    expect(() => auth.submitClaudeAuthorizationCode('authorization-code')).toThrow(/invalid state/)
    expect(() => auth.submitClaudeAuthorizationCode('authorization-code#wrong-state')).toThrow(/invalid state/)
    expect(auth.submitClaudeAuthorizationCode(`authorization-code#${url.searchParams.get('state')}`)).toBe(true)
    await expect(login).resolves.toMatchObject({ connected: true })
    expect(auth.submitClaudeAuthorizationCode('stale')).toBe(false)
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body)).redirect_uri).toBe('https://platform.claude.com/oauth/code/callback')
  })

  it('cancels promptly, removes listeners, and closes the authentication tab', async () => {
    const controller = new AbortController()
    const { login } = await begin({ signal: controller.signal })
    controller.abort()
    await expect(login).rejects.toMatchObject({ name: 'AbortError' })
    expect(updates.size).toBe(0)
    expect(removals.size).toBe(0)
    expect(tabs.remove).toHaveBeenCalledWith(7)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects closed login tabs and preserves an existing connected account', async () => {
    seed(Date.now() + 3_600_000)
    const { login } = await begin()
    for (const listener of removals) listener(7)
    await expect(login).rejects.toThrow(/tab was closed/)
    expect(await auth.getValidClaudeCredentials()).toEqual({ accessToken: 'access-old' })
  })

  it('does not resurrect a signed-out account when an exchange finishes in another context', async () => {
    let resolveFetch!: (value: Response) => void
    request.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve }))
    const { login, url } = await begin()
    navigate(callback(url))
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    vi.resetModules()
    const otherContext = await import('./anthropic-oauth')
    await otherContext.signOutClaude()
    resolveFetch(tokenResponse())
    await expect(login).rejects.toThrow(/cancelled or replaced/)
    expect(await auth.getClaudeAccountStatus()).toEqual({ connected: false })
    expect(stored[auth.CLAUDE_AUTH_STORAGE_KEY]).not.toHaveProperty('tokens')
  })

  it('restores the prior session when cancellation arrives during the token commit', async () => {
    seed(Date.now() + 3_600_000)
    let releaseCommit!: () => void
    let committing = false
    vi.mocked(chrome.storage.local.set).mockImplementation(async (value) => {
      Object.assign(stored, structuredClone(value))
      const record = (value as Record<string, { tokens?: { accessToken?: string } }>)[auth.CLAUDE_AUTH_STORAGE_KEY]
      if (record?.tokens?.accessToken === 'access-new') {
        committing = true
        await new Promise<void>((resolve) => { releaseCommit = resolve })
      }
    })
    const controller = new AbortController()
    const { login, url } = await begin({ signal: controller.signal })
    navigate(callback(url))
    await vi.waitFor(() => expect(committing).toBe(true))
    controller.abort()
    releaseCommit()
    await expect(login).rejects.toMatchObject({ name: 'AbortError' })
    expect(await auth.getValidClaudeCredentials()).toEqual({ accessToken: 'access-old' })
  })
})

describe('Claude token refresh', () => {
  it('serializes token rotation across extension contexts and rereads the winning token', async () => {
    seed()
    vi.resetModules()
    const otherContext = await import('./anthropic-oauth')
    const results = await Promise.all([auth.getValidClaudeCredentials(), otherContext.getValidClaudeCredentials(), auth.getValidClaudeCredentials()])
    expect(results).toEqual(Array.from({ length: 3 }, () => ({ accessToken: 'access-new' })))
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' })
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-old' })
  })

  it('does not rotate again when another request already replaced a rejected token', async () => {
    seed()
    await auth.getValidClaudeCredentials()
    expect(await auth.getValidClaudeCredentials(true, undefined, 'access-old')).toEqual({ accessToken: 'access-new' })
    expect(request).toHaveBeenCalledOnce()
  })

  it('retains a previous refresh token when the response only rotates the access token', async () => {
    seed()
    request.mockResolvedValueOnce(tokenResponse({ refresh_token: undefined }))
    await auth.getValidClaudeCredentials()
    expect(stored[auth.CLAUDE_AUTH_STORAGE_KEY]).toMatchObject({ tokens: { refreshToken: 'refresh-old', accessToken: 'access-new' } })
  })

  it('does not restore credentials after sign-out races a refresh', async () => {
    seed()
    let resolveFetch!: (value: Response) => void
    request.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve }))
    const refreshing = auth.getValidClaudeCredentials()
    void refreshing.catch(() => {})
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const signOut = auth.signOutClaude()
    resolveFetch(tokenResponse())
    await expect(refreshing).rejects.toThrow(/signed out/)
    await signOut
    expect(await auth.getClaudeAccountStatus()).toEqual({ connected: false })
    await expect(auth.getValidClaudeCredentials()).rejects.toThrow(/No Claude account/)
  })

  it('does not expose provider bodies or overwrite credentials on rejected refresh', async () => {
    seed()
    request.mockResolvedValueOnce(new Response('provider echoed secret refresh-old access-old', { status: 401 }))
    await expect(auth.getValidClaudeCredentials()).rejects.toThrow(/^Claude sign-in request failed \(401\)\. Start a new sign-in from Settings\.$/)
    expect(stored[auth.CLAUDE_AUTH_STORAGE_KEY]).toMatchObject({ tokens: { accessToken: 'access-old' } })
  })

  it('rejects incomplete token responses without replacing the previous session', async () => {
    seed()
    request.mockResolvedValueOnce(tokenResponse({ expires_in: -1 }))
    await expect(auth.getValidClaudeCredentials()).rejects.toThrow(/incomplete/)
    expect(stored[auth.CLAUDE_AUTH_STORAGE_KEY]).toMatchObject({ tokens: { accessToken: 'access-old' } })
  })

  it('reports useful provider errors and request IDs while redacting echoed grant secrets', async () => {
    seed()
    request.mockResolvedValueOnce(Response.json({ error: { message: `Client rejected refresh-old and Bearer ${'sk-ant-' + 'secret'.repeat(4)}` } }, {
      status: 429, headers: { 'request-id': 'req_support123' },
    }))
    await expect(auth.getValidClaudeCredentials()).rejects.toThrow(/Client rejected \[redacted\].*Reference: req_support123/)
    expect(new Headers(request.mock.calls[0]![1]?.headers).get('user-agent')).toBe('axios/1.15.2')
    expect(stored[auth.CLAUDE_AUTH_STORAGE_KEY]).toMatchObject({ tokens: { accessToken: 'access-old' } })
  })
})
