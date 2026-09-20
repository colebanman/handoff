import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { RUNTIME_CONTEXT_START } from '../shared/context-blocks'
import { buildSystemMessages, cacheRequestOptions, withCacheBreakpoints } from './prompt-cache'

describe('system message compatibility', () => {
  it('combines static and dynamic instructions for strict chat templates', () => {
    expect(buildSystemMessages({ staticPrompt: 'Base', dynamicPrompt: 'Custom' }, false)).toEqual([
      { role: 'system', content: 'Base\n\nCustom' },
    ])
    expect(buildSystemMessages({ staticPrompt: 'Base', dynamicPrompt: '' }, false)).toEqual([
      { role: 'system', content: 'Base' },
    ])
  })

  it('preserves the static cache breakpoint for Anthropic', () => {
    expect(buildSystemMessages({ staticPrompt: 'Base', dynamicPrompt: 'Custom' }, true)).toEqual([
      { role: 'system', content: 'Base', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
      { role: 'system', content: 'Custom' },
    ])
  })
})

describe('Astra reasoning requests', () => {
  it.each(['gpt-6-astra', 'openai/gpt-6-astra', 'gpt-6-astra-2026-09-10'])(
    'sends reasoning summaries through the installed adapter for %s', async (modelId) => {
      let body: Record<string, unknown> = {}
      const openai = createOpenAI({ apiKey: 'test-key', fetch: async (_url, init) => {
        body = JSON.parse(init!.body as string)
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      } })
      const options = cacheRequestOptions('openai', modelId, 'test-cache')
      const result = await openai.responses(modelId.replace(/^openai\//, '')).doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Test request serialization.' }] }],
        providerOptions: options.providerOptions,
      })
      const reader = result.stream.getReader()
      const first = await reader.read()
      await reader.cancel()
      expect(body.reasoning).toEqual({ effort: 'low', summary: 'detailed' })
      expect(body.include).toContain('reasoning.encrypted_content')
      expect(first.value?.type).toBe('stream-start')
      if (first.value?.type === 'stream-start') {
        expect(first.value.warnings).not.toContainEqual(expect.objectContaining({ feature: 'reasoningSummary' }))
      }
    },
  )

  it('does not force reasoning for an ordinary non-reasoning model', () => {
    expect(cacheRequestOptions('openai', 'gpt-4.1', 'test').providerOptions?.openai?.forceReasoning).toBeUndefined()
  })
})

describe('cache breakpoints with runtime context', () => {
  it('keeps the real user turn as the stable read point and the newest message as the write point', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Check this course.' },
      { role: 'user', content: `${RUNTIME_CONTEXT_START}<site-memory>Saved procedure</site-memory>\n</context>` },
      { role: 'assistant', content: 'Working on it.' },
    ]
    const result = withCacheBreakpoints(messages)
    expect(result[0]?.providerOptions?.anthropic).toHaveProperty('cacheControl')
    expect(result[1]?.providerOptions?.anthropic).toBeUndefined()
    expect(result[2]?.providerOptions?.anthropic).toHaveProperty('cacheControl')
    expect(messages.every((m) => !m.providerOptions)).toBe(true)
  })
})
