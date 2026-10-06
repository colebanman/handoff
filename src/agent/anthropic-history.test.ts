import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { preserveAnthropicHistory } from './anthropic-history'
import { sanitizeModelMessages } from '../shared/model-messages'

describe('Claude signed history', () => {
  it('preserves 5.5 history and signatures across model switches and persistence', () => {
    const messages: ModelMessage[] = [{ role: 'assistant', content: [
      { type: 'reasoning', text: '', providerOptions: { anthropic: { signature: 'signature', cacheControl: { type: 'ephemeral' } } } },
      { type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: 'opaque-data' } } },
      { type: 'text', text: 'Result' },
    ] }]
    const saved = sanitizeModelMessages(messages) as ModelMessage[]
    expect(preserveAnthropicHistory('gpt-6-sol', saved)).toBe(true)
    expect(preserveAnthropicHistory('anthropic/claude-opus-5-5', [])).toBe(true)
    expect(preserveAnthropicHistory('claude-sonnet-5-5', [])).toBe(true)
    expect(preserveAnthropicHistory('gpt-6-sol', [])).toBe(false)
    expect(JSON.stringify(saved)).toContain('signature')
    expect(JSON.stringify(saved)).toContain('opaque-data')
    expect(JSON.stringify(saved)).not.toContain('cacheControl')
  })
})
