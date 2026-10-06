import { describe, expect, it } from 'vitest'
import { contextModelKey, defaultContextWindow, openAIContextWindow, type ContextModel } from './model-context'

describe('context limits for the selected model and transport', () => {
  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5', 'claude-opus-5-5-20260922'])('reports the full %s window', (modelId) => {
    for (const anthropicAuthMode of ['claude', 'api-key'] as const) {
      expect(defaultContextWindow({ provider: 'anthropic', modelId, anthropicAuthMode })).toEqual({ tokens: 1_000_000, source: 'model' })
    }
  })

  it.each([
    ['gpt-6.1-sol', 1_050_000], ['openai/gpt-6-astra', 1_050_000], ['gpt-5.6-sol', 1_050_000],
    ['gpt-4.1-mini-2025-04-14', 1_047_576], ['gpt-5', 400_000], ['gpt-4o', 128_000], ['o3', 200_000],
    ['gpt-5.4-mini', 400_000], ['gpt-5.4-nano-2026-03-17', 400_000], ['o1-mini', 128_000],
  ])('shares the documented %s API limit with compaction', (modelId, tokens) => {
    expect(defaultContextWindow({ provider: 'openai', modelId })).toEqual({ tokens, source: 'model' })
    expect(openAIContextWindow(modelId)).toBe(tokens)
  })

  it('labels the ChatGPT budget as a fallback instead of borrowing the Platform limit', () => {
    expect(defaultContextWindow({ provider: 'openai', modelId: 'gpt-6.1-sol', openaiAuthMode: 'chatgpt' }))
      .toEqual({ tokens: 272_000, source: 'fallback' })
  })

  it.each([
    { provider: 'openai', modelId: 'gpt-60-unknown' },
    { provider: 'openai', modelId: 'gpt-5-custom' },
    { provider: 'anthropic', modelId: 'claude-custom' },
    { provider: 'openai-compatible', modelId: 'gpt-6.1-sol', baseURL: 'http://localhost:8000/v1' },
  ] satisfies ContextModel[])('does not invent limits for $provider/$modelId', (model) => {
    expect(defaultContextWindow(model)).toBeUndefined()
  })

  it('normalizes provider prefixes but separates authentication and endpoints', () => {
    const model: ContextModel = { provider: 'openai', modelId: 'gpt-6.1-sol' }
    expect(contextModelKey(model)).toBe(contextModelKey({ ...model, modelId: 'openai/gpt-6.1-sol', openaiAuthMode: 'api-key' }))
    expect(contextModelKey(model)).not.toBe(contextModelKey({ ...model, openaiAuthMode: 'chatgpt' }))
    expect(contextModelKey({ ...model, provider: 'openai-compatible', baseURL: 'a' }))
      .not.toBe(contextModelKey({ ...model, provider: 'openai-compatible', baseURL: 'b' }))
  })
})
