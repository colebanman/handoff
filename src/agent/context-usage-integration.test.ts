import { afterEach, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import { runLoop, type RunLoopOptions } from './run'
import { DEFAULT_SETTINGS, type AgentEvent } from '../shared/types'
import { applyContextUsage, contextInputTokens, type ContextUsageInfo } from '../shared/context-usage'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function sse(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 37) controller.enqueue(bytes.slice(offset, offset + 37))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })
}

it.each(['openai', 'anthropic'] as const)('reports cached context across %s turns through the real SDK and event pipeline', async (provider) => {
  vi.stubGlobal('chrome', { tabs: { query: async () => [] } })
  const modelId = provider === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5'
  let requests = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toContain(provider === 'openai' ? 'api.openai.com/v1/responses' : 'api.anthropic.com/v1/messages')
    const next = requests++ > 0
    const output = next ? 100 : 8_000
    if (provider === 'openai') {
      const message = { type: 'message', id: `msg_${requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }
      return sse([
        { type: 'response.created', response: { id: `resp_${requests}`, created_at: 1, model: modelId } },
        { type: 'response.output_item.added', output_index: 0, item: message },
        { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'Done.' },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: { id: `resp_${requests}`, output: [message], usage: {
          input_tokens: next ? 11_000 : 10_000, output_tokens: output,
          input_tokens_details: { cached_tokens: next ? 10_000 : 0 },
          output_tokens_details: { reasoning_tokens: next ? 0 : 7_900 },
        } } },
      ])
    }
    return sse([
      { type: 'message_start', message: { id: `msg_${requests}`, type: 'message', role: 'assistant', model: modelId,
        content: [], stop_reason: null, stop_sequence: null, usage: {
          input_tokens: 1_000, output_tokens: 0,
          cache_creation_input_tokens: next ? 0 : 9_000, cache_read_input_tokens: next ? 10_000 : 0,
        } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: output } },
      { type: 'message_stop' },
    ])
  }))
  const events: AgentEvent[] = []
  let context: ContextUsageInfo | undefined
  const settings = { ...DEFAULT_SETTINGS, provider, modelId, apiKey: 'fixture-key', openaiAuthMode: 'api-key' as const, anthropicAuthMode: 'api-key' as const }
  const options: RunLoopOptions = {
    ctx: { agentId: 'main', currentTabId: 0, offlineOnly: true }, settings, modelId,
    messages: [{ role: 'user', content: 'Hello' }], signal: new AbortController().signal,
    emit: (event) => { events.push(event); context = applyContextUsage(context, event) },
    deps: { cdp: {}, sandbox: {}, vfs: { summary: async () => ({ entries: [], skills: [] }) } } as unknown as RunLoopOptions['deps'],
    spawnSubagent: async () => '', tasks: {} as RunLoopOptions['tasks'], sandboxSessionId: 'context-reporting', isSubagent: false,
  }
  const first = await runLoop(options)
  expect(first.errorText).toBeUndefined()
  expect(contextInputTokens(context)).toBe(10_000)
  expect(first.usage?.totalTokens).toBe(18_000)
  const second = await runLoop({ ...options, messages: [...options.messages, ...first.responseMessages as ModelMessage[], { role: 'user', content: 'Continue' }] })
  expect(second.errorText).toBeUndefined()
  expect(contextInputTokens(context)).toBe(11_000)
  expect(context?.context?.cachedInputTokens).toBe(10_000)
  expect(context?.context?.window).toEqual({ tokens: provider === 'openai' ? 1_050_000 : 1_000_000, source: 'model' })
  expect(second.usage?.totalTokens).toBe(11_100)
  expect(events.filter((event) => event.type === 'usage-update')).toHaveLength(2)
  expect(requests).toBe(2)
})
