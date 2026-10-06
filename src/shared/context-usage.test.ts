import { describe, expect, it } from 'vitest'
import type { LanguageModelUsage } from 'ai'
import type { AgentEvent } from './types'
import { applyContextUsage, contextInputTokens, contextMeterTitle, contextUsageMatches, formatContextTokens, requestContextUsage } from './context-usage'
import { defaultContextWindow, type ContextModel } from './model-context'

const openai: ContextModel = { provider: 'openai', modelId: 'gpt-6.1-sol' }
const anthropic: ContextModel = { provider: 'anthropic', modelId: 'claude-sonnet-5-5' }
function sdkUsage(input: number, output: number, cached = 0): LanguageModelUsage {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output,
    inputTokenDetails: { noCacheTokens: input - cached, cacheReadTokens: cached, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: output, reasoningTokens: 0 } }
}
function event(model: ContextModel, input: number, output: number, cached = 0): AgentEvent {
  const usage = sdkUsage(input, output, cached)
  return { type: 'usage-update', agentId: 'main', modelId: model.modelId, usage,
    context: requestContextUsage(model, defaultContextWindow(model), usage) }
}

describe('provider-measured input context', () => {
  it.each([openai, anthropic])('does not shrink when $provider produces a shorter answer or more cache hits', (model) => {
    const first = applyContextUsage(undefined, event(model, 10_000, 8_000, 0))
    const second = applyContextUsage(first, event(model, 11_000, 100, 10_000))
    expect(contextInputTokens(first)).toBe(10_000)
    expect(contextInputTokens(second)).toBe(11_000)
    expect(second?.usage.totalTokens).toBe(11_100)
    expect(contextMeterTitle(second, second?.context?.window)).toContain('10,000 cached input tokens')
  })

  it('includes Anthropic cache reads and writes once, excluding billed compaction iterations', () => {
    const usage = { ...sdkUsage(250_000, 10_000), raw: {
      input_tokens: 500, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 2_000,
      iterations: [{ type: 'compaction', input_tokens: 167_500, output_tokens: 9_000 }],
    } }
    const context = requestContextUsage(anthropic, defaultContextWindow(anthropic), usage)
    expect(context.inputTokens).toBe(82_500)
    expect(context.cachedInputTokens).toBe(80_000)
  })

  it('does not add OpenAI cached tokens to its already inclusive input total', () => {
    const context = requestContextUsage(openai, undefined, { ...sdkUsage(10_000, 3_000, 9_000),
      raw: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 9_000 } } })
    expect(context.inputTokens).toBe(10_000)
  })

  it('retains the last known reading for missing, partial, or malformed usage', () => {
    const first = applyContextUsage(undefined, event(openai, 10_000, 2_000))
    for (const inputTokens of [undefined, NaN, Infinity, -1]) {
      expect(applyContextUsage(first, { type: 'usage-update', agentId: 'main', modelId: openai.modelId,
        usage: { inputTokens, outputTokens: 500, totalTokens: 500 } })).toBe(first)
    }
    expect(contextInputTokens(applyContextUsage(first, event(openai, 0, 0)))).toBe(0)
  })

  it('allows real reductions and never accumulates requests or clamps to a high-water mark', () => {
    const first = applyContextUsage(undefined, event(openai, 100_000, 2_000))
    const second = applyContextUsage(first, event(openai, 10_000, 500))
    expect(contextInputTokens(second)).toBe(10_000)
    expect(contextMeterTitle(second)).toContain('pruning, compaction, or discarded reasoning')
  })

  it('ignores subagents and clears measurements on main-model switches', () => {
    const first = applyContextUsage(undefined, event(openai, 10_000, 100))
    expect(applyContextUsage(first, { ...event(anthropic, 1_000, 10), agentId: 'sub-1' } as AgentEvent)).toBe(first)
    expect(applyContextUsage(first, { type: 'agent-finish', agentId: 'main', text: 'Done', usage: { totalTokens: 1_000_000 } })).toBe(first)
    expect(applyContextUsage(first, { type: 'model-switch', agentId: 'main', modelId: anthropic.modelId, previousModelId: openai.modelId })).toBeUndefined()
    expect(contextUsageMatches(first, { ...openai, modelId: 'openai/gpt-6.1-sol' })).toBe(true)
    expect(contextUsageMatches(first, { ...openai, openaiAuthMode: 'chatgpt' })).toBe(false)
  })

  it('does not persist credentials in context metadata', () => {
    const model = { ...openai, apiKey: 'secret-key', apiKeys: { anthropic: 'another-secret' } }
    const context = requestContextUsage(model, undefined, sdkUsage(10, 1))
    expect(JSON.stringify(context)).not.toContain('secret')
  })

  it('shows the actual API limit when the selected ChatGPT route falls back to an API key', () => {
    const requested = { ...openai, openaiAuthMode: 'chatgpt' as const }
    const usage = sdkUsage(10_000, 100)
    const context = requestContextUsage(openai, defaultContextWindow(openai), usage, requested)
    const info = { modelId: openai.modelId, usage, context, updatedAt: 1 }
    expect(contextUsageMatches(info, requested)).toBe(true)
    expect(context.window).toEqual({ tokens: 1_050_000, source: 'model' })
  })

  it('preserves meaningful precision for million-token windows', () => {
    expect(formatContextTokens(1_050_000)).toBe('1.05M')
    expect(formatContextTokens(1_000_000)).toBe('1M')
    expect(formatContextTokens(0)).toBe('0')
    expect(formatContextTokens(undefined)).toBe('—')
  })
})
