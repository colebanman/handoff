/**
 * Helpers for persisted AI SDK ModelMessage arrays.
 *
 * OpenAI Responses metadata can include provider-owned item IDs. If those IDs
 * are persisted and replayed later, @ai-sdk/openai converts them to
 * `item_reference` inputs, which can fail when OpenAI no longer has that item
 * in the current request context. Persist prompt content, not server item refs.
 *
 * xAI Responses metadata carries the same kind of server item ids
 * (providerOptions.xai.itemId); we run xAI with `store: false`, so replaying
 * ids of never-stored items is at best meaningless and at worst rejected —
 * strip them too. `xai.reasoningEncryptedContent` is deliberately KEPT: it is
 * the only way grok reasoning parts survive stateless replay (the provider
 * skips reasoning parts that have neither itemId nor encrypted content).
 *
 * Anthropic `cacheControl` markers are also stripped: prompt-cache breakpoints
 * are a request-time concern (agent/prompt-cache.ts) and Anthropic rejects
 * requests with more than 4 of them, so replayed history must never carry any.
 */

import { toWellFormed } from './text'

export function sanitizeModelMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => sanitizeMessageValue(message))
}

function sanitizeMessageValue(value: unknown): unknown {
  if (typeof value === 'string') return toWellFormed(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeMessageValue(item))
  if (!isRecord(value)) return value

  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    const next = sanitizeMessageValue(raw)
    if ((key === 'providerOptions' || key === 'providerMetadata') && isRecord(next)) {
      const cleaned = stripProviderKey(
        stripProviderKey(stripProviderKey(next, 'openai', 'itemId'), 'xai', 'itemId'),
        'anthropic',
        'cacheControl',
      )
      if (Object.keys(cleaned).length > 0) out[key] = cleaned
    } else {
      out[key] = next
    }
  }
  return out
}

function stripProviderKey(
  options: Record<string, unknown>,
  provider: string,
  key: string,
): Record<string, unknown> {
  const providerOptions = options[provider]
  if (!isRecord(providerOptions) || !(key in providerOptions)) return options

  const out: Record<string, unknown> = { ...options }
  const cleaned: Record<string, unknown> = { ...providerOptions }
  delete cleaned[key]

  if (Object.keys(cleaned).length > 0) {
    out[provider] = cleaned
  } else {
    delete out[provider]
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
