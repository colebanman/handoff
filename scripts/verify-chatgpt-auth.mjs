import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/agent/openai-chatgpt-oauth.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  define: { __DEV_BUILD__: 'false' },
})
const source = bundled.outputFiles[0].text
const auth = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const storage = new Map()
const tabUpdatedListeners = new Set()
const tabRemovedListeners = new Set()
const removedTabs = []
let browserCodeChallenge = ''
globalThis.window = globalThis
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.1.0-test' }),
  },
  storage: {
    local: {
      get: async (key) => ({ [key]: storage.get(key) }),
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) storage.set(key, value)
      },
      remove: async (key) => storage.delete(key),
    },
  },
  tabs: {
    create: async ({ url, active }) => {
      assert.equal(url, 'about:blank')
      assert.equal(active, true)
      return { id: 42, url }
    },
    update: async (tabId, { url }) => {
      assert.equal(tabId, 42)
      const authorize = new URL(url)
      assert.equal(authorize.origin, 'https://auth.openai.com')
      assert.equal(authorize.pathname, '/oauth/authorize')
      assert.equal(authorize.searchParams.get('response_type'), 'code')
      assert.equal(authorize.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
      assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
      assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(authorize.searchParams.get('id_token_add_organizations'), 'true')
      assert.equal(authorize.searchParams.get('codex_cli_simplified_flow'), 'true')
      assert.equal(authorize.searchParams.get('originator'), 'handoff')
      assert.match(authorize.searchParams.get('scope'), /openid profile email offline_access/)
      browserCodeChallenge = authorize.searchParams.get('code_challenge')
      const state = authorize.searchParams.get('state')
      assert.ok(browserCodeChallenge)
      assert.ok(state)
      const callback = `http://localhost:1455/auth/callback?code=browser-auth-code&state=${encodeURIComponent(state)}`
      queueMicrotask(() => {
        for (const listener of tabUpdatedListeners) listener(42, { url: callback }, { id: 42, url: callback })
      })
      return { id: 42, url }
    },
    remove: async (tabId) => {
      removedTabs.push(tabId)
      for (const listener of tabRemovedListeners) listener(tabId, { windowId: 1, isWindowClosing: false })
    },
    onUpdated: {
      addListener: (listener) => tabUpdatedListeners.add(listener),
      removeListener: (listener) => tabUpdatedListeners.delete(listener),
    },
    onRemoved: {
      addListener: (listener) => tabRemovedListeners.add(listener),
      removeListener: (listener) => tabRemovedListeners.delete(listener),
    },
  },
}

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`
}

const accountId = 'acct_test'
const oldAccessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
const newAccessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 7200 })
const idToken = jwt({
  'https://api.openai.com/profile': { email: 'dev@example.com' },
  'https://api.openai.com/auth': {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: 'plus',
    chatgpt_account_is_fedramp: false,
  },
})

const calls = []
const codeVerifier = 'verifier'
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
let devicePolls = 0
let refreshes = 0
let responseAttempts = 0
let tamperPkce = false
globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input)
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  calls.push({ url, init, headers })

  if (url.endsWith('/api/accounts/deviceauth/usercode')) {
    assert.equal(init.method, 'POST')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.cache, 'no-store')
    assert.equal(headers.get('originator'), 'handoff')
    assert.equal(headers.get('Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(init.body), {
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    })
    return Response.json({
      device_auth_id: 'device-auth-id',
      user_code: 'ABCD-EFGH',
      interval: '0.001',
    })
  }

  if (url.endsWith('/api/accounts/deviceauth/token')) {
    assert.equal(init.credentials, 'omit')
    assert.equal(init.cache, 'no-store')
    assert.equal(headers.get('originator'), 'handoff')
    devicePolls += 1
    if (devicePolls === 1) return new Response('', { status: 403 })
    assert.deepEqual(JSON.parse(init.body), {
      device_auth_id: 'device-auth-id',
      user_code: 'ABCD-EFGH',
    })
    return Response.json({
      authorization_code: 'auth-code',
      code_verifier: codeVerifier,
      code_challenge: tamperPkce ? 'tampered-challenge' : codeChallenge,
    })
  }

  if (url.endsWith('/oauth/token')) {
    if (init.body instanceof URLSearchParams) {
      assert.equal(init.credentials, 'omit')
      assert.equal(init.cache, 'no-store')
      assert.equal(headers.get('originator'), 'handoff')
      assert.equal(headers.get('Content-Type'), 'application/x-www-form-urlencoded')
      assert.equal(init.body.get('grant_type'), 'authorization_code')
      assert.equal(init.body.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
      if (init.body.get('code') === 'auth-code') {
        assert.equal(init.body.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback')
        assert.equal(init.body.get('code_verifier'), codeVerifier)
      } else {
        assert.equal(init.body.get('code'), 'browser-auth-code')
        assert.equal(init.body.get('redirect_uri'), 'http://localhost:1455/auth/callback')
        assert.equal(
          createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'),
          browserCodeChallenge,
        )
      }
      return Response.json({
        access_token: oldAccessToken,
        refresh_token: 'refresh-token',
        id_token: idToken,
        expires_in: 3600,
      })
    }
    refreshes += 1
    assert.equal(init.credentials, 'omit')
    assert.equal(init.cache, 'no-store')
    assert.deepEqual(JSON.parse(init.body), {
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
    })
    return Response.json({ access_token: newAccessToken, expires_in: 7200 })
  }

  if (url === 'https://chatgpt.com/backend-api/codex/responses') {
    responseAttempts += 1
    assert.equal(init.credentials, 'omit')
    assert.equal(headers.get('ChatGPT-Account-ID'), accountId)
    assert.equal(headers.get('originator'), 'handoff')
    if (headers.get('Authorization') === `Bearer ${oldAccessToken}`) {
      return new Response('', { status: 401 })
    }
    assert.equal(headers.get('Authorization'), `Bearer ${newAccessToken}`)
    return Response.json({ ok: true })
  }

  if (url.startsWith('https://chatgpt.com/backend-api/codex/models?')) {
    assert.equal(init.credentials, 'omit')
    assert.equal(init.cache, 'no-store')
    assert.equal(headers.get('Authorization'), `Bearer ${newAccessToken}`)
    assert.equal(headers.get('ChatGPT-Account-ID'), accountId)
    assert.match(url, /client_version=0\.144\.0/)
    return Response.json({
      models: [
        { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', priority: 30 },
        { slug: 'internal-hidden', display_name: 'Hidden', visibility: 'hide', priority: 1 },
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 10 },
        { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', priority: 20 },
      ],
    })
  }

  throw new Error(`Unexpected fetch: ${url}`)
}

const device = await auth.requestChatGPTDeviceCode()
assert.equal(device.verificationUrl, 'https://auth.openai.com/codex/device')
assert.equal(device.userCode, 'ABCD-EFGH')
assert.equal(device.intervalMs, 1)

const connected = await auth.completeChatGPTDeviceLogin(device)
assert.deepEqual(connected, {
  connected: true,
  email: 'dev@example.com',
  planType: 'plus',
  accountId,
})
assert.equal(await auth.isChatGPTConnected(), true)

const response = await auth.makeChatGPTFetch()('https://chatgpt.com/backend-api/codex/responses', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
})
assert.equal(response.ok, true)
assert.equal(responseAttempts, 2)
assert.equal(refreshes, 1)

const models = await auth.listChatGPTModels(true)
assert.deepEqual(
  models.map(({ id, label, provider }) => ({ id, label, provider })),
  [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai' },
  ],
)

await auth.disconnectChatGPT()
assert.deepEqual(await auth.getChatGPTAccountStatus(), { connected: false })
assert.equal(storage.size, 0)

tamperPkce = true
await assert.rejects(auth.completeChatGPTDeviceLogin(device), /invalid PKCE proof/)
assert.deepEqual(await auth.getChatGPTAccountStatus(), { connected: false })
assert.equal(storage.size, 0)
assert.ok(calls.length >= 7)

const browserConnected = await auth.connectChatGPTInBrowser()
assert.deepEqual(browserConnected, {
  connected: true,
  email: 'dev@example.com',
  planType: 'plus',
  accountId,
})
assert.equal(await auth.isChatGPTConnected(), true)
assert.deepEqual(removedTabs, [42])
assert.equal(tabUpdatedListeners.size, 0)
assert.equal(tabRemovedListeners.size, 0)
await auth.disconnectChatGPT()

console.log('ChatGPT auth smoke test passed')
