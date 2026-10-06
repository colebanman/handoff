import type { LanguageModelUsage } from 'ai'
import type { AgentEvent, Usage } from './types'
import { bareModelId, contextModelKey, validTokenCount, type ContextModel, type ContextWindow } from './model-context'

/** A measurement of one request's input, separate from billed turn totals. */
export interface RequestContextUsage {
  model: ContextModel
  /** Selection that produced this request, when credential fallback changed its route. */
  requestedModelKey?: string
  window?: ContextWindow
  inputTokens?: number
  cachedInputTokens?: number
}

export interface ContextUsageInfo {
  modelId: string
  usage: Usage
  context?: RequestContextUsage
  updatedAt: number
}

export function requestContextUsage(
  model: ContextModel,
  window: ContextWindow | undefined,
  usage: LanguageModelUsage,
  requestedModel: ContextModel = model,
): RequestContextUsage {
  let input = usage.inputTokens
  let cached = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens
  // AI SDK inputTokens already includes cache reads/writes for both providers.
  // Anthropic's SDK can additionally sum server-side compaction iterations for
  // billing. Its raw top-level fields describe the served request's context.
  const anthropic = model.provider === 'anthropic' ||
    (model.provider === 'gateway' && /^(?:anthropic\/)?claude-/.test(model.modelId))
  if (anthropic && validTokenCount(usage.raw?.input_tokens)) {
    const read = usage.raw?.cache_read_input_tokens ?? 0
    const write = usage.raw?.cache_creation_input_tokens ?? 0
    input = validTokenCount(read) && validTokenCount(write) ? usage.raw.input_tokens + read + write : undefined
    cached = validTokenCount(read) ? read : undefined
  }
  return {
    // Do not spread Settings here: it includes API keys.
    model: { modelId: model.modelId, provider: model.provider,
      openaiAuthMode: model.openaiAuthMode, anthropicAuthMode: model.anthropicAuthMode,
      ...(model.provider === 'openai-compatible' ? { baseURL: model.baseURL } : {}) },
    ...(contextModelKey(requestedModel) !== contextModelKey(model)
      ? { requestedModelKey: contextModelKey(requestedModel) } : {}),
    window,
    inputTokens: validTokenCount(input) ? input : undefined,
    cachedInputTokens: validTokenCount(cached) ? cached : undefined,
  }
}

export function contextInputTokens(info?: ContextUsageInfo): number | undefined {
  const count = info?.context ? info.context.inputTokens : info?.usage.inputTokens
  return validTokenCount(count) ? count : undefined
}

export function contextUsageMatches(info: ContextUsageInfo | undefined, model: ContextModel): boolean {
  if (!info || bareModelId(info.modelId) !== bareModelId(model.modelId)) return false
  const key = contextModelKey(model)
  return !info.context || contextModelKey(info.context.model) === key || info.context.requestedModelKey === key
}

/** Shared by the live panel and durable host, including background-only turns. */
export function applyContextUsage(
  previous: ContextUsageInfo | undefined,
  event: AgentEvent,
  updatedAt = Date.now(),
): ContextUsageInfo | undefined {
  if (!('agentId' in event) || event.agentId !== 'main') return previous
  if (event.type === 'model-switch') return undefined
  if (event.type !== 'usage-update') return previous
  const next = { modelId: event.modelId, usage: event.usage, context: event.context, updatedAt }
  if (contextInputTokens(next) !== undefined) return next
  // Missing/partial usage must not replace a measured context with zero. A
  // different model/transport cannot inherit the previous model's measurement.
  return previous && (event.context ? contextUsageMatches(previous, event.context.model)
    : bareModelId(previous.modelId) === bareModelId(event.modelId)) ? previous : undefined
}

export function formatContextTokens(value: number | undefined): string {
  if (!validTokenCount(value)) return '—'
  // Keep 1.05M distinct from 1M, and never round a 1,047,576-token limit to 1M.
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: value >= 1_000_000 ? 2 : 1 }).format(value)
}

export function contextMeterTitle(info: ContextUsageInfo | undefined, window?: ContextWindow): string {
  const input = contextInputTokens(info)
  const limit = window ? `${window.source === 'fallback' ? 'estimated ' : ''}${window.tokens.toLocaleString()}-token context window` : 'context limit unavailable'
  if (input === undefined) return `No input usage reported yet; ${limit}.`
  const cached = info?.context?.cachedInputTokens ?? info?.usage.cachedInputTokens
  const cacheNote = validTokenCount(cached) && cached > 0 ? ` Includes ${cached.toLocaleString()} cached input tokens.` : ''
  return `Context at last request: ${input.toLocaleString()} input tokens; ${limit}.${cacheNote} Output is excluded until carried into a later request. Context can decrease after history pruning, compaction, or discarded reasoning.`
}
