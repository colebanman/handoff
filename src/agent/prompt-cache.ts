/**
 * Prompt-cache plumbing for the agent loop.
 *
 * Anthropic models (reached through the gateway) only cache prompt prefixes at
 * explicit `cache_control` breakpoints — max 4 per request, and a breakpoint
 * covers everything before it (tools, then system blocks, then messages). We
 * spend the budget as:
 *   1. end of the static system block — caches tool definitions + base prompt,
 *      and survives changes to the dynamic system tail (standing instructions),
 *   2. the last user message — a stable read point for the whole turn, so a
 *      single step that adds many content blocks can't strand the prefix,
 *   3. the last message of the current step — the moving write point,
 *      re-applied every step via `prepareStep` so long tool loops cache
 *      incrementally instead of re-reading prior steps at full price.
 * Reverting works without special handling: every step wrote a breakpoint
 * along the old prefix, and Anthropic checks earlier positions automatically.
 *
 * Breakpoints are applied to request-time copies only. Persisted history must
 * stay clean (sanitizeModelMessages strips them) or replayed conversations
 * would accumulate markers past the 4-breakpoint limit and be rejected.
 *
 * OpenAI models cache automatically on stable prefixes. The loop pins requests
 * to a per-agent `promptCacheKey` (cache-shard routing), extends retention to
 * 24h, and runs the Responses API statelessly (`store: false` + encrypted
 * reasoning content) so gpt-5-family reasoning items survive history replay —
 * without the encrypted content the provider DROPS replayed reasoning items,
 * which diverges the prefix at the previous turn's first reasoning item and
 * costs the whole turn's cache.
 *
 * xAI (grok) also caches automatically, with no cache params at all — the docs
 * instead recommend an `x-grok-conv-id` HTTP header so one conversation's
 * requests route to the same cache shard; we send the per-agent cache key
 * there. Like OpenAI we run xAI's Responses API statelessly: `store: false`
 * makes @ai-sdk/xai auto-include `reasoning.encrypted_content`, and replay
 * carries it back via providerOptions.xai.reasoningEncryptedContent — replayed
 * reasoning parts without itemId or encrypted content are silently SKIPPED,
 * which would strand grok's reasoning between steps and turns.
 */

import type { ModelMessage, SystemModelMessage } from 'ai'
import { isRuntimeContextMessage } from '../shared/context-blocks'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import type { Settings } from '../shared/types'
import type { SystemPromptParts } from './system-prompt'

const EPHEMERAL_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } }

/** Explicit cache_control applies to Anthropic models reached through the gateway. */
export function supportsAnthropicPromptCache(provider: Settings['provider'], modelId: string): boolean {
  return provider === 'gateway' && modelId.trim().toLowerCase().startsWith('anthropic/')
}

export interface CacheRequestOptions {
  providerOptions?: ProviderOptions
  headers?: Record<string, string>
}

/**
 * Call-level provider options + headers for prompt caching. Full OpenAI
 * options only for real OpenAI endpoints; openai-compatible servers get just
 * the cache key (strict ones reject unknown params like
 * prompt_cache_retention); xAI gets `store: false` plus the conv-id routing
 * header; other gateway models get nothing.
 */
export function cacheRequestOptions(
  provider: Settings['provider'],
  modelId: string,
  cacheKey: string,
  openaiAuthMode?: Settings['openaiAuthMode'],
): CacheRequestOptions {
  const id = modelId.trim().toLowerCase()
  const isOpenAI = provider === 'openai' || (provider === 'gateway' && id.startsWith('openai/'))
  if (isOpenAI) {
    return {
      providerOptions: {
        openai: {
          // This adapter's built-in model table predates Astra. Without the
          // override it drops reasoningSummary and reasoning replay settings
          // as "unsupported for non-reasoning models".
          ...(/^(?:openai\/)?gpt-6-astra(?:-|$)/.test(id) ? { forceReasoning: true, reasoningEffort: 'low' as const } : {}),
          promptCacheKey: cacheKey,
          // The ChatGPT Codex transport uses its own managed cache policy and
          // does not include the Platform API retention extension.
          ...(provider === 'openai' && openaiAuthMode === 'chatgpt'
            ? {}
            : { promptCacheRetention: '24h' as const }),
          store: false,
          include: ['reasoning.encrypted_content'],
          // Stream reasoning summaries so the UI's reasoning cards have text;
          // without this, gpt-5-family reasoning renders as an empty shimmer.
          // 'detailed' yields longer and often multiple summary parts; 'auto'
          // typically returns one terse bold headline, which made every
          // thought render as a single line regardless of duration.
          reasoningSummary: 'detailed',
        },
      },
    }
  }
  if (provider === 'openai-compatible') {
    return { providerOptions: { openai: { promptCacheKey: cacheKey } } }
  }
  if (provider === 'cerebras') {
    // Native compatible adapter forwards this snake_case body field. This is
    // a routing hint, not cache retention or discounted input billing.
    return { providerOptions: { cerebras: { prompt_cache_key: cacheKey } } }
  }
  const isXai = provider === 'xai' || (provider === 'gateway' && id.startsWith('xai/'))
  if (isXai) {
    const bareId = id.startsWith('xai/') ? id.slice('xai/'.length) : id
    // Explicitly retain high reasoning for the current and saved 4.5 models.
    const highReasoning = /^grok-4\.[56](?:-|$)/.test(bareId)
    return {
      // store: false keeps the loop stateless and turns on encrypted
      // reasoning content (see module comment). Caching itself is automatic.
      providerOptions: { xai: { store: false, ...(highReasoning ? { reasoningEffort: 'high' } : {}) } },
      // Cache-shard routing header; only meaningful against the real xAI
      // endpoint (the gateway terminates requests itself).
      headers: provider === 'xai' ? { 'x-grok-conv-id': cacheKey } : undefined,
    }
  }
  return {}
}

/**
 * Build the system messages for streamText: the static block first (with a
 * cache breakpoint when supported), then the dynamic tail as its own block so
 * settings/subagent changes never invalidate the static prefix. Other providers
 * get one leading system message: strict chat templates reject a second one.
 */
export function buildSystemMessages(prompt: SystemPromptParts, cacheable: boolean): SystemModelMessage[] {
  if (!cacheable) {
    return [{ role: 'system', content: [prompt.staticPrompt, prompt.dynamicPrompt].filter(Boolean).join('\n\n') }]
  }
  const staticBlock: SystemModelMessage = { role: 'system', content: prompt.staticPrompt, providerOptions: EPHEMERAL_CACHE }
  return prompt.dynamicPrompt
    ? [staticBlock, { role: 'system', content: prompt.dynamicPrompt }]
    : [staticBlock]
}

/**
 * Return a copy of `messages` with cache breakpoints on the last message and
 * the last user message (turn boundary), and stale breakpoints removed
 * everywhere else. Idempotent; call it per step from `prepareStep`.
 */
export function withCacheBreakpoints(messages: ModelMessage[]): ModelMessage[] {
  const lastIndex = messages.length - 1
  if (lastIndex < 0) return messages
  let lastUserIndex = -1
  for (let i = lastIndex; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'user' && !isRuntimeContextMessage(message)) {
      lastUserIndex = i
      break
    }
  }
  return messages.map((message, i) => {
    const cleaned = withoutCacheControl(message)
    return i === lastIndex || i === lastUserIndex ? withCacheControl(cleaned) : cleaned
  })
}

function withCacheControl<T extends ModelMessage>(message: T): T {
  const anthropic = isRecord(message.providerOptions?.anthropic) ? message.providerOptions.anthropic : {}
  return {
    ...message,
    providerOptions: {
      ...message.providerOptions,
      anthropic: { ...anthropic, ...EPHEMERAL_CACHE.anthropic },
    },
  }
}

function withoutCacheControl<T extends ModelMessage>(message: T): T {
  const anthropic = message.providerOptions?.anthropic
  if (!isRecord(anthropic) || !('cacheControl' in anthropic)) return message
  const cleanedAnthropic = { ...anthropic }
  delete cleanedAnthropic.cacheControl
  const providerOptions = { ...message.providerOptions }
  if (Object.keys(cleanedAnthropic).length > 0) {
    providerOptions.anthropic = cleanedAnthropic
  } else {
    delete providerOptions.anthropic
  }
  return { ...message, providerOptions }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
