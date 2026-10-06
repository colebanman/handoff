/**
 * Native Anthropic Messages transport. Subscription requests speak the Claude
 * Code OAuth protocol directly; they never start a CLI or use an API key.
 *
 * Protocol reference (checked 2026-10-05):
 * https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/anthropic-messages.ts
 * https://platform.claude.com/docs/en/build-with-claude/thinking
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 *
 * The stable compatibility system block is prepended only for OAuth. The application's
 * own instructions, tools, images and cache markers still go through the
 * native AI SDK adapter unchanged.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from 'ai'
import { getValidClaudeCredentials } from './anthropic-oauth'
import { throwIfAborted } from '../shared/abort'
import { CLAUDE_MAX_REQUEST_BYTES, projectAnthropicImages } from './anthropic-image-limits'
import { ensureAnthropicBrowserTransport } from './anthropic-browser'

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
export const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."
const CLAUDE_CODE_VERSION = '2.1.280'
const OAUTH_BETAS = ['claude-code-20250219', 'oauth-2025-04-20']

type CredentialLoader = typeof getValidClaudeCredentials

function officialMessagesURL(input: RequestInfo | URL): URL {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (
    url.origin !== 'https://api.anthropic.com' ||
    url.pathname !== '/v1/messages' || url.username || url.password
  ) {
    throw new Error('Claude credentials can only be sent to the official Anthropic Messages endpoint.')
  }
  return url
}

function mergedHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

function addBetas(headers: Headers, betas: string[]): void {
  headers.set('anthropic-beta', [...new Set([
    ...(headers.get('anthropic-beta') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    ...betas,
  ])].join(','))
}

async function anthropicRequestBody(input: RequestInfo | URL, init?: RequestInit, oauth = false): Promise<string> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  if (typeof raw !== 'string') throw new Error('Claude Messages requests must have a JSON body.')
  const body: unknown = JSON.parse(raw)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Claude Messages requests must have a JSON object body.')
  }
  const request = projectAnthropicImages(body as Record<string, unknown>)
  if (request.system != null && typeof request.system !== 'string' && !Array.isArray(request.system)) {
    throw new Error('Claude system instructions must be text or content blocks.')
  }
  const system = typeof request.system === 'string'
    ? [{ type: 'text', text: request.system }]
    : Array.isArray(request.system) ? request.system : []
  // No new cache marker: the application's static-system breakpoint covers
  // this leading block too, leaving the four-marker limit intact.
  const first = system[0] as { type?: unknown; text?: unknown } | undefined
  if (oauth) request.system = first?.type === 'text' && first.text === CLAUDE_CODE_SYSTEM_PROMPT
    ? system
    : [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }, ...system]
  const serialized = JSON.stringify(request)
  if (new TextEncoder().encode(serialized).byteLength > CLAUDE_MAX_REQUEST_BYTES) {
    throw new Error('This Claude request exceeds 32 MB. Start a new conversation with fewer attachments or smaller files.')
  }
  return serialized
}

/**
 * A credential is loaded for each request, not captured when a conversation
 * starts. One 401 can refresh and retry the identical body; 403/quota/errors
 * remain visible and never silently switch to API billing.
 */
export function makeClaudeFetch(
  base?: typeof fetch,
  loadCredentials: CredentialLoader = getValidClaudeCredentials,
): typeof fetch {
  const send = base ?? ((input, init) => globalThis.fetch(input, init))
  return async (input, init) => {
    // Validate before reading credentials, including when called with Request.
    const url = officialMessagesURL(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method.toUpperCase() !== 'POST') throw new Error('Claude Messages requests must use POST.')
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    throwIfAborted(signal ?? undefined)
    await ensureAnthropicBrowserTransport()
    const body = await anthropicRequestBody(input, init, true)
    const headers = mergedHeaders(input, init)
    headers.delete('x-api-key')
    headers.delete('cookie')
    headers.set('accept', 'application/json')
    headers.set('content-type', 'application/json')
    headers.set('anthropic-version', '2023-06-01')
    headers.set('anthropic-dangerous-direct-browser-access', 'true')
    headers.set('x-app', 'cli')
    headers.set('user-agent', `claude-cli/${CLAUDE_CODE_VERSION}`)
    addBetas(headers, OAUTH_BETAS)
    url.searchParams.set('beta', 'true')

    const request = async (accessToken: string) => {
      throwIfAborted(signal ?? undefined)
      headers.set('authorization', `Bearer ${accessToken}`)
      return send(url.href, {
        ...init,
        method: 'POST', body, headers: new Headers(headers), signal,
        // Do not follow redirects with a subscription credential, and do not
        // attach the browser's unrelated Anthropic cookies.
        redirect: 'error', credentials: 'omit',
      })
    }
    const credentials = await loadCredentials(false, signal ?? undefined)
    const response = await request(credentials.accessToken)
    if (response.status !== 401) return response
    await response.body?.cancel().catch(() => {})
    const refreshed = await loadCredentials(true, signal ?? undefined, credentials.accessToken)
    return request(refreshed.accessToken)
  }
}

/** Native provider settings also used by gateway requests to Claude 5.5. */
export function claude55ProviderOptions(modelId: string) {
  const id = modelId.replace(/^anthropic\//, '')
  if (!/^claude-(opus|sonnet)-5-5(?:-|$)/.test(id)) return undefined
  return {
    anthropic: {
      thinking: {
        type: 'adaptive' as const,
        display: 'summarized' as const,
        // Client compaction, edited turns, instructions or tool inventories
        // can change the prefix. Keep signatures and let the server discard
        // only invalid blocks; preserve reasoning for normal appended turns.
        blockBinding: { prefixMismatchBehavior: 'drop_block' as const },
      },
      effort: id.startsWith('claude-opus-') ? 'medium' as const : 'high' as const,
    },
  }
}

export function createAnthropicModel(options: {
  modelId: string
  apiKey?: string
  oauth?: boolean
  fetch?: typeof fetch
}): LanguageModel {
  const modelId = options.modelId.trim().replace(/^anthropic\//, '')
  if (!modelId) throw new Error('No Claude model selected.')
  if (!options.oauth && !options.apiKey?.trim()) {
    throw new Error('No Anthropic API key configured. Open Settings and sign in with Claude or add an API key.')
  }
  const provider = createAnthropic({
    // Explicit fixed URL prevents environment/proxy configuration from
    // forwarding either authentication mode elsewhere.
    baseURL: 'https://api.anthropic.com/v1',
    ...(options.oauth ? { authToken: 'oauth-loaded-per-request' } : { apiKey: options.apiKey!.trim() }),
    headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    fetch: options.oauth ? makeClaudeFetch(options.fetch) : async (input, init) => {
      officialMessagesURL(input)
      await ensureAnthropicBrowserTransport()
      const send = options.fetch ?? ((request, settings) => globalThis.fetch(request, settings))
      const headers = mergedHeaders(input, init)
      headers.delete('authorization')
      headers.delete('cookie')
      headers.set('x-api-key', options.apiKey!.trim())
      const body = await anthropicRequestBody(input, init)
      return send(input, { ...init, body, headers, redirect: 'error', credentials: 'omit' })
    },
  })
  return wrapLanguageModel({
    model: provider(modelId),
    middleware: defaultSettingsMiddleware({
      settings: {
        maxOutputTokens: 16_384,
        providerOptions: claude55ProviderOptions(modelId),
      },
    }),
  })
}
