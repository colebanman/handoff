/**
 * Model resolution for the agent core.
 *
 * Maps a `Settings` object (provider + apiKey + modelId + optional baseURL) to
 * a concrete AI SDK v6 `LanguageModel`. Provider factories verified against
 * docs/research/ai-sdk-v6.md (@ai-sdk/gateway@2.0.108, @ai-sdk/openai@3.0.80).
 */

import type { LanguageModel } from 'ai'
import { createGateway } from '@ai-sdk/gateway'
import { createOpenAI } from '@ai-sdk/openai'
import { createXai } from '@ai-sdk/xai'
import { createCerebras } from '@ai-sdk/cerebras'
import {
  isLocalModelId,
  CEREBRAS_DEFAULT_MODEL_ID,
  isXaiPriorityModelId,
  MODEL_OPTIONS,
  pinnedSettingsForModel,
  stripXaiPrioritySuffix,
  type Settings,
} from '../shared/types'
import {
  CHATGPT_CODEX_BASE_URL,
  getValidChatGPTCredentials,
  makeChatGPTFetch,
  type ChatGPTCredentials,
} from './openai-chatgpt-oauth'
import { debugLog } from '../shared/debug-log'
import { tapFetch } from '../shared/stream-tap'

/** Keep the raw-stream tap and its wrapper out of non-developer bundles. */
function developerFetch(base?: typeof fetch): typeof fetch | undefined {
  return __DEV_BUILD__ ? tapFetch(base) : base
}

/**
 * xAI Priority Processing: inject `service_tier: 'priority'` into the outgoing
 * request body. @ai-sdk/xai validates `providerOptions.xai` against a fixed
 * schema (reasoningEffort/store/include/...) and silently drops anything else,
 * and the flag is a top-level body field rather than a header, so the only
 * seam left is the provider's `fetch`. Wraps the developer tap from the
 * outside so the raw-stream view shows the body that actually ships.
 */
export function withPriorityServiceTier(base?: typeof fetch): typeof fetch {
  const send: typeof fetch = base ?? ((input, init) => globalThis.fetch(input, init))
  return async (input, init) => {
    if (typeof init?.body !== 'string') return send(input, init)
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return send(input, init)
      // A caller-set tier wins; xAI echoes the granted tier back on the response.
      if (body.service_tier == null) body.service_tier = 'priority'
      return send(input, { ...init, body: JSON.stringify(body) })
    } catch {
      // Non-JSON body (shouldn't happen on /responses) — forward it untouched.
      return send(input, init)
    }
  }
}

/**
 * Apply a (possibly per-subagent) model override to settings. Curated models
 * pin their native provider and pull that provider's key from the vault, so
 * e.g. a grok main agent can spawn a gpt subagent (or vice versa) and the
 * whole request stack — key, cache params, media handling — follows the model
 * instead of the main agent's provider. Gateway ids get their vendor prefix
 * here so downstream provider checks (prompt-cache, tool-result-media) see the
 * same id the request will use. A custom (non-curated) id on openai-compatible
 * is left alone: a proxy may serve any model id.
 */
export function resolveProviderSettings(settings: Settings, modelId: string): Settings {
  const id = modelId.trim()
  if (settings.provider === 'gateway' && !isLocalModelId(id) && id !== CEREBRAS_DEFAULT_MODEL_ID) {
    const gatewayId = id.includes('/') ? id : id.startsWith('grok') ? `xai/${id}` : `openai/${id}`
    return { ...settings, modelId: gatewayId }
  }
  // Request-time resolution, so a locally served model materializes its pinned
  // endpoint here instead of writing it into persisted settings.
  return pinnedSettingsForModel(id, settings, { pinEndpoint: true })
}

export interface ResolvedModelAccess {
  settings: Settings
  chatgptCredentials?: ChatGPTCredentials
}

function providerKey(settings: Settings, provider: Settings['provider']): string {
  return (
    settings.apiKeys?.[provider]?.trim() ||
    (settings.provider === provider ? settings.apiKey?.trim() : '') ||
    ''
  )
}

function apiKeySettings(settings: Settings, provider: Settings['provider'], modelId: string): Settings | undefined {
  if (provider === 'openai-compatible' && isLocalModelId(modelId)) {
    return pinnedSettingsForModel(modelId, settings, { pinEndpoint: true })
  }
  const apiKey = providerKey(settings, provider)
  if (!apiKey) return undefined
  if (provider === 'openai-compatible' && !settings.baseURL?.trim()) return undefined
  return {
    ...settings,
    provider,
    modelId,
    apiKey,
    ...(provider === 'openai' ? { openaiAuthMode: 'api-key' as const } : {}),
  }
}

/**
 * Resolve a requested model without making ChatGPT login a hard dependency.
 * Order: ChatGPT session, saved OpenAI Platform key, current-chat provider,
 * then any other provider with a configured key.
 */
export async function resolveModelAccess(
  settings: Settings,
  requestedModelId: string,
  loadChatGPTCredentials: () => Promise<ChatGPTCredentials> = getValidChatGPTCredentials,
): Promise<ResolvedModelAccess> {
  const requested = resolveProviderSettings(settings, requestedModelId)
  let chatgptError: unknown

  if (requested.provider === 'openai' && requested.openaiAuthMode === 'chatgpt') {
    try {
      const chatgptCredentials = await loadChatGPTCredentials()
      return {
        settings: { ...requested, apiKey: chatgptCredentials.accessToken },
        chatgptCredentials,
      }
    } catch (err) {
      chatgptError = err
      const withPlatformKey = apiKeySettings(settings, 'openai', requested.modelId)
      if (withPlatformKey) {
        debugLog.log('agent', 'ChatGPT unavailable; using OpenAI API key', { modelId: requested.modelId })
        return { settings: withPlatformKey }
      }
    }
  } else if (requested.apiKey?.trim() && (requested.provider !== 'openai-compatible' || requested.baseURL?.trim())) {
    return { settings: requested }
  }

  // Pinned helper models (Luna) should use the model the current chat already
  // runs when their preferred OpenAI credential is unavailable.
  const currentSettings = resolveProviderSettings(settings, settings.modelId)
  const current = apiKeySettings(currentSettings, currentSettings.provider, currentSettings.modelId)
  if (current) {
    debugLog.log('agent', 'requested model unavailable; using current model', {
      requestedModelId,
      modelId: current.modelId,
      provider: current.provider,
    })
    return { settings: current }
  }

  const fallbackModels: Array<[Settings['provider'], string]> = [
    ['openai', requested.modelId],
    ['xai', MODEL_OPTIONS.find((model) => model.provider === 'xai')?.id ?? 'grok-4.6'],
    ['cerebras', CEREBRAS_DEFAULT_MODEL_ID],
    ['gateway', settings.modelId],
    ['openai-compatible', settings.modelId],
  ]
  for (const [provider, modelId] of fallbackModels) {
    const fallback = apiKeySettings(settings, provider, modelId)
    if (fallback) {
      debugLog.log('agent', 'requested model unavailable; using configured provider', {
        requestedModelId,
        modelId: fallback.modelId,
        provider,
      })
      return { settings: fallback }
    }
  }

  if (chatgptError) throw chatgptError
  return { settings: requested }
}

/** Synchronous mirror for UI gates; actual OAuth validation stays in the resolver. */
export function hasModelAccess(settings: Settings, requestedModelId: string, chatgptConnected: boolean): boolean {
  const requested = resolveProviderSettings(settings, requestedModelId)
  if (requested.provider === 'openai' && requested.openaiAuthMode === 'chatgpt') {
    if (chatgptConnected || providerKey(settings, 'openai')) return true
  } else if (requested.apiKey?.trim() && (requested.provider !== 'openai-compatible' || requested.baseURL?.trim())) {
    return true
  }
  const current = resolveProviderSettings(settings, settings.modelId)
  if (apiKeySettings(current, current.provider, current.modelId)) return true
  return (['openai', 'xai', 'cerebras', 'gateway', 'openai-compatible'] as const).some((provider) =>
    Boolean(apiKeySettings(settings, provider, settings.modelId)),
  )
}

/**
 * Resolve a `LanguageModel` from settings.
 *
 * - gateway            → createGateway({ apiKey })(modelId)   e.g. 'google/gemini-3-pro'
 * - openai             → Platform API key or ChatGPT subscription Responses transport
 * - openai-compatible  → createOpenAI({ apiKey, baseURL }).chat(modelId)
 * - xai                → createXai({ apiKey }).responses(modelId)  e.g. 'grok-4.3'
 * - cerebras           → shared inference Chat Completions, with reasoning replay
 *
 * Throws a clear Error if the API key (or, for openai-compatible, the baseURL) is missing.
 */
export function resolveModel(settings: Settings, chatgptCredentials?: ChatGPTCredentials, wrapFetch?: (base: typeof fetch) => typeof fetch): LanguageModel {
  const apiKey = settings.apiKey?.trim()
  if (!apiKey) {
    if (settings.provider === 'openai' && settings.openaiAuthMode === 'chatgpt') {
      throw new Error('No ChatGPT account connected. Open Settings and sign in with ChatGPT.')
    }
    throw new Error(
      `No API key configured for provider "${settings.provider}". Open Settings and paste your API key.`,
    )
  }

  const modelId = settings.modelId?.trim()
  if (!modelId) {
    throw new Error('No model id configured. Choose a model in the model picker or Settings.')
  }

  debugLog.log('agent', 'resolveModel', { provider: settings.provider, modelId })

  switch (settings.provider) {
    case 'gateway': {
      if (wrapFetch && normalizeGatewayModelId(modelId).startsWith('openai/')) {
        return createOpenAI({ apiKey, baseURL: 'https://ai-gateway.vercel.sh/v1',
          fetch: developerFetch(wrapFetch((input, init) => globalThis.fetch(input, init))),
        }).responses(normalizeGatewayModelId(modelId))
      }
      const gateway = createGateway({ apiKey, fetch: developerFetch() })
      return gateway(normalizeGatewayModelId(modelId))
    }
    case 'openai': {
      if (settings.openaiAuthMode === 'chatgpt') {
        if (!chatgptCredentials) {
          throw new Error('No ChatGPT account connected. Open Settings and sign in with ChatGPT.')
        }
        const openai = createOpenAI({
          apiKey,
          baseURL: CHATGPT_CODEX_BASE_URL,
          headers: {
            'ChatGPT-Account-ID': chatgptCredentials.accountId,
            originator: 'handoff',
            ...(chatgptCredentials.isFedRamp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
          },
          fetch: developerFetch(wrapFetch ? wrapFetch(makeChatGPTFetch()) : makeChatGPTFetch()),
        })
        // ChatGPT subscription access is a Responses-only Codex transport. It
        // does not exchange the login for, or bill through, a Platform API key.
        return openai.responses(normalizeOpenAIModelId(modelId))
      }
      const openai = createOpenAI({ apiKey, fetch: developerFetch(wrapFetch?.((input, init) => globalThis.fetch(input, init))) })
      return openai(normalizeOpenAIModelId(modelId))
    }
    case 'openai-compatible': {
      const baseURL = settings.baseURL?.trim()
      if (!baseURL) {
        throw new Error(
          'Provider "openai-compatible" requires a baseURL. Set it in Settings (e.g. https://api.example.com/v1).',
        )
      }
      const openai = createOpenAI({ apiKey, baseURL, fetch: developerFetch() })
      // `openai(id)` defaults to the Responses API, which almost no
      // OpenAI-compatible server implements — vLLM, SGLang, llama.cpp, LM Studio
      // and Ollama all expose /chat/completions, and hitting /responses on them
      // 404s. "OpenAI-compatible" means chat completions, so ask for it.
      return openai.chat(normalizeOpenAIModelId(modelId))
    }
    case 'cerebras': {
      // Shared inference has no service_tier parameter. Use the native adapter
      // so streamed reasoning and assistant reasoning history survive tool steps.
      return createCerebras({ apiKey, fetch: developerFetch() }).chat(modelId.replace(/^cerebras\//, ''))
    }
    case 'xai': {
      // `grok-4.6-fast` is not an xAI model id — it is grok-4.6 on the
      // priority service tier, so the suffix moves from the id to the body.
      const priority = isXaiPriorityModelId(modelId)
      const xai = createXai({
        apiKey,
        fetch: priority ? withPriorityServiceTier(developerFetch()) : developerFetch(),
      })
      // Responses API, NOT the default chat-completions model: only the
      // Responses API supports stateless replay with encrypted reasoning
      // content (`store: false`, see prompt-cache.ts), which keeps grok
      // reasoning items intact across our multi-step tool loop.
      return xai.responses(stripXaiPrioritySuffix(normalizeXaiModelId(modelId)))
    }
    default: {
      // Exhaustiveness guard — settings.provider is a closed union.
      const never: never = settings.provider
      throw new Error(`Unknown provider: ${String(never)}`)
    }
  }
}

function normalizeOpenAIModelId(modelId: string): string {
  return modelId.startsWith('openai/') ? modelId.slice('openai/'.length) : modelId
}

function normalizeXaiModelId(modelId: string): string {
  return modelId.startsWith('xai/') ? modelId.slice('xai/'.length) : modelId
}

function normalizeGatewayModelId(modelId: string): string {
  // The gateway has no `-fast` id and terminates requests itself, so a
  // priority pick degrades to the standard tier rather than 400-ing.
  const id = stripXaiPrioritySuffix(modelId)
  if (id.includes('/')) return id
  return id.startsWith('grok') ? `xai/${id}` : `openai/${id}`
}
