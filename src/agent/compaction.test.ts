import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamText, type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { OpenAICompaction, withoutCompaction } from './compaction'
import { runLoop, type RunLoopOptions } from './run'
import { DEFAULT_SETTINGS, type AgentEvent, type TranscriptItem } from '../shared/types'
import { applyEvent } from '../ui/reducer'
import { isCompacting } from '../shared/compaction'
import { sanitizeModelMessages } from '../shared/model-messages'

const compactItem = { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-state' }
const retained = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Retained detail' }] }
const output = [retained, compactItem]
const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'orchard-731', annotations: [] }] }
const events = (compacted = false) => [
  { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-4o' } },
  ...(compacted ? [
    { type: 'response.output_item.added', output_index: 0, item: compactItem },
    { type: 'response.output_item.done', output_index: 0, item: compactItem },
  ] : []),
  { type: 'response.output_item.added', output_index: 1, item: message },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'orchard-731' },
  { type: 'response.output_item.done', output_index: 1, item: message },
  { type: 'response.completed', response: { id: 'resp_1', output: [message], usage: { input_tokens: 50, output_tokens: 10 } } },
]
function sse(parts: unknown[]) {
  const bytes = new TextEncoder().encode(parts.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
  // Deliberately split event boundaries, JSON, and the final delimiter.
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('OpenAI compaction through real SDK and agent loop', () => {
  it('compacts at 40%, preserves the full canonical window across turns and leaves history intact', async () => {
    vi.stubGlobal('__DEV_BUILD__', false)
    vi.stubGlobal('chrome', { tabs: { query: async () => [] } })
    const requests: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string) })
      return url.endsWith('/compact')
        ? Response.json({ output, usage: { output_tokens: 20 } }) : sse(events())
    })
    const history: ModelMessage[] = [{ role: 'user', content: 'Remember orchard-731. ' + 'history '.repeat(23_000) }]
    const original = structuredClone(history)
    const emitted: AgentEvent[] = []
    const options: RunLoopOptions = {
      ctx: { agentId: 'main', currentTabId: 0, offlineOnly: true },
      settings: { ...DEFAULT_SETTINGS, provider: 'openai', openaiAuthMode: 'api-key', apiKey: 'test', modelId: 'gpt-4o', customInstructions: 'Always preserve the custom instruction sentinel.' },
      modelId: 'gpt-4o', messages: history, signal: new AbortController().signal,
      emit: (event) => emitted.push(event),
      deps: { cdp: {}, sandbox: {}, vfs: { summary: async () => ({ entries: [], skills: [] }) } } as unknown as RunLoopOptions['deps'],
      spawnSubagent: async () => '', tasks: {} as RunLoopOptions['tasks'], sandboxSessionId: 'test', isSubagent: false,
    }
    const first = await runLoop(options)
    expect(first.text).toBe('orchard-731')
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/responses/compact')
    const sent = requests[1]!.body.input.filter((item: any) => !['system', 'developer'].includes(item.role))
    expect(sent.slice(0, output.length)).toEqual(output)
    expect(sent.at(-1).content).toContain('<user-memory>')
    expect(sent.at(-1).content).toContain('<active-task>')
    expect(sent.at(-1).content).toContain('Remember orchard-731')
    expect(JSON.stringify(sent).length).toBeLessThan(10000)
    expect(JSON.stringify(requests[1]!.body.input.filter((item: any) => ['system', 'developer'].includes(item.role)))).toContain('custom instruction sentinel')
    expect(history).toEqual(original)
    expect(emitted.filter((event) => event.type === 'compaction').map((event) => event.status)).toEqual(['running', 'done'])
    const persisted = sanitizeModelMessages([...history, ...first.responseMessages]) as ModelMessage[]
    const second = await runLoop({ ...options, settings: { ...options.settings, customInstructions: 'Updated custom instruction sentinel.' }, messages: [...persisted, { role: 'user', content: 'What is the code?' }] })
    expect(second.text).toBe('orchard-731')
    expect(requests.filter((request) => request.url.endsWith('/compact'))).toHaveLength(1)
    expect(requests[2]!.body.input).toEqual(expect.arrayContaining(output))
    const system = JSON.stringify(requests[2]!.body.input.filter((item: any) => ['system', 'developer'].includes(item.role)))
    expect(system).toContain('Updated custom instruction sentinel.')
    expect(system).not.toContain('Always preserve the custom instruction sentinel.')
    expect(JSON.stringify(requests[2]!.body.input.filter((item: any) => !['system', 'developer'].includes(item.role))).length).toBeLessThan(10000)
    expect(requests[2]!.body.input.filter((item: any) => item.role === 'user' && JSON.stringify(item.content ?? '').includes('<active-task>'))).toHaveLength(1)
    expect(withoutCompaction(persisted)).toEqual([...history, ...first.responseMessages.filter((m: any) => !m.providerOptions?.compaction)])
  })

  it('consumes streamed compaction items without SDK errors and replays output after the latest item', async () => {
    const emitted: AgentEvent[] = []
    const compaction = new OpenAICompaction({ modelId: 'gpt-4o', contextWindow: 1000, agentId: 'main', signal: new AbortController().signal, emit: (e) => emitted.push(e), serverSide: true,
      browserContext: () => '<browser-observations>Exact current page refs</browser-observations>',
    })
    let request: any
    const send: typeof fetch = async (_url, init) => { request = JSON.parse(init!.body as string); return sse(events(true)) }
    const model = createOpenAI({ apiKey: 'test', fetch: compaction.wrapFetch(send) }).responses('gpt-4o')
    const messages = compaction.prepare([{ role: 'user', content: 'history '.repeat(200) }], () => {})
    const result = streamText({ model, messages, providerOptions: { openai: { store: false } } })
    expect(await result.text).toBe('orchard-731')
    expect(request.context_management).toEqual([{ type: 'compaction', compact_threshold: 400 }])
    const saved = compaction.takeCheckpoint()!
    expect(saved).toBeDefined()
    const next = compaction.prepare([...messages, saved, { role: 'user', content: 'Continue' }], () => {})
    expect(next).toEqual([{ role: 'user', content: 'Continue' }])
    await compaction.wrapFetch(send)('https://example.com/responses', { body: JSON.stringify({ model: 'gpt-4o', input: next }) })
    expect(request.input).toEqual([compactItem,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<browser-observations>Exact current page refs</browser-observations>' }] },
      message, { role: 'user', content: 'Continue' }])
    let transcript: TranscriptItem[] = []
    for (const event of emitted) {
      transcript = applyEvent(transcript, event)
      if (event.type === 'compaction') expect(isCompacting(transcript)).toBe(event.status === 'running')
    }
  })

  it('does not lock the composer or report cancelled compactions when the server returns ordinary responses', async () => {
    const emitted: AgentEvent[] = []
    const compaction = new OpenAICompaction({
      modelId: 'gpt-4o', contextWindow: 1000, agentId: 'main',
      signal: new AbortController().signal, emit: (event) => emitted.push(event), serverSide: true,
    })
    const pendingStatuses: AgentEvent[][] = []
    const requests: any[] = []
    const model = createOpenAI({ apiKey: 'test', fetch: compaction.wrapFetch(async (_url, init) => {
      requests.push(JSON.parse(init!.body as string))
      pendingStatuses.push([...emitted])
      return sse(events())
    }) }).responses('gpt-4o')
    // The local estimate exceeds 40%, but the server's rendered token count
    // does not. Enabling context_management is not a compaction-start event.
    const history: ModelMessage[] = [{ role: 'user', content: 'history '.repeat(200) }]
    for (let step = 0; step < 3; step++) {
      const result = streamText({ model, messages: compaction.prepare(history, () => {}) })
      expect(await result.text).toBe('orchard-731')
      compaction.observeUsage({ inputTokens: 350, outputTokens: 10 })
      history.push(...(await result.response).messages, { role: 'user', content: 'Continue' })
    }
    expect(requests).toHaveLength(3)
    expect(requests.every((request) => request.context_management[0].compact_threshold === 400)).toBe(true)
    expect(pendingStatuses).toEqual([[], [], []])
    expect(emitted).toEqual([])
    expect(compaction.takeCheckpoint()).toBeUndefined()
    expect(isCompacting(emitted.reduce(applyEvent, [] as TranscriptItem[]))).toBe(false)
  })

  it('reports a real streamed compaction even when the local estimate is below the threshold', async () => {
    const emitted: AgentEvent[] = []
    const compaction = new OpenAICompaction({
      modelId: 'gpt-4o', contextWindow: 1_000_000, agentId: 'main',
      signal: new AbortController().signal, emit: (event) => emitted.push(event), serverSide: true,
    })
    const model = createOpenAI({ apiKey: 'test', fetch: compaction.wrapFetch(async () => sse(events(true))) }).responses('gpt-4o')
    const result = streamText({ model, messages: compaction.prepare([{ role: 'user', content: 'Continue' }], () => {}) })
    expect(await result.text).toBe('orchard-731')
    expect(emitted.filter((event) => event.type === 'compaction').map((event) => event.status)).toEqual(['running', 'done'])
    expect(compaction.takeCheckpoint()).toBeDefined()
  })

  it('unlocks on failure and cancellation without saving a partial checkpoint', async () => {
    const controller = new AbortController()
    const emit = vi.fn()
    const commit = vi.fn()
    const compaction = new OpenAICompaction({ modelId: 'gpt-4o', contextWindow: 1000, agentId: 'main', signal: controller.signal, emit })
    compaction.prepare([], commit)
    const init = { body: JSON.stringify({ model: 'gpt-4o', input: [{ role: 'user', content: 'x'.repeat(2000) }] }) }
    await expect(compaction.wrapFetch(async () => Response.json({}, { status: 500 }))('https://api.openai.com/v1/responses', init)).rejects.toThrow('compaction failed')
    expect(emit.mock.calls.at(-1)?.[0].status).toBe('error')
    expect(commit).not.toHaveBeenCalled()
    const pending = compaction.wrapFetch(async () => new Promise(() => {}))('https://api.openai.com/v1/responses', init)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(emit.mock.calls.at(-1)?.[0].status).toBe('cancelled')
    expect(commit).not.toHaveBeenCalled()
  })

  it('keeps local tool results paired with calls after a streamed compaction, through resume', async () => {
    vi.stubGlobal('__DEV_BUILD__', false)
    vi.stubGlobal('chrome', {
      tabs: { query: async () => [] },
      storage: { local: {
        get: async () => ({ openai_chatgpt_oauth_tokens: {
          accessToken: 'test', refreshToken: 'test', idToken: 'test', accountId: 'compaction-tool-test', expiresAt: Date.now() + 3_600_000,
        } }),
      } },
    })
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'browser_tabs', arguments: '{"action":"list"}', status: 'completed' }
    const requests: any[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.includes('/models?')) return Response.json({ models: [{ slug: 'gpt-5.6-luna', context_window: 1000 }] })
      requests.push(JSON.parse(init.body as string))
      if (requests.length > 1) return sse(events())
      return sse([
        events()[0],
        { type: 'response.output_item.added', output_index: 0, item: compactItem },
        { type: 'response.output_item.done', output_index: 0, item: compactItem },
        { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 1, delta: call.arguments },
        { type: 'response.output_item.done', output_index: 1, item: call },
        { type: 'response.completed', response: { usage: { input_tokens: 2000, output_tokens: 10 } } },
      ])
    })
    const options: RunLoopOptions = {
      ctx: { agentId: 'main', currentTabId: 0 },
      settings: { ...DEFAULT_SETTINGS, provider: 'openai', openaiAuthMode: 'chatgpt', modelId: 'gpt-5.6-luna' },
      modelId: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'List tabs' }],
      signal: new AbortController().signal, emit: vi.fn(),
      deps: { cdp: {}, sandbox: {}, vfs: { summary: async () => ({ entries: [], skills: [] }) } } as unknown as RunLoopOptions['deps'],
      spawnSubagent: async () => '', tasks: {} as RunLoopOptions['tasks'], sandboxSessionId: 'tool-test', isSubagent: false,
    }
    const result = await runLoop(options)
    expect(result.errorText).toBeUndefined()
    expect(result.stepCount).toBe(2)
    const input = requests[1].input
    expect(input.filter((item: any) => item.role === 'user' && JSON.stringify(item.content ?? '').includes('<user-memory>'))).toHaveLength(1)
    expect(JSON.stringify(input)).toContain('Context restored after compaction')
    expect(input).toEqual(expect.arrayContaining([compactItem, call, expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' })]))
    expect(input.filter((item: any) => item.type === 'function_call')).toHaveLength(1)
    expect(input.findIndex((item: any) => item.type === 'function_call')).toBeLessThan(input.findIndex((item: any) => item.type === 'function_call_output'))
    const resumed = await runLoop({ ...options, messages: [...options.messages, ...result.responseMessages as ModelMessage[], { role: 'user', content: 'Continue' }] })
    expect(resumed.errorText).toBeUndefined()
    expect(requests[2].input.filter((item: any) => item.type === 'function_call')).toHaveLength(1)
    expect(requests[2].input.filter((item: any) => item.type === 'function_call_output')).toHaveLength(1)
    expect(requests[2].input.filter((item: any) => item.role === 'user' && JSON.stringify(item.content ?? '').includes('<user-memory>'))).toHaveLength(1)
  })
})
