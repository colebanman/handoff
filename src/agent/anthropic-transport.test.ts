import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText, stepCountIs, streamText, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import {
  ANTHROPIC_MESSAGES_URL, CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicModel, makeClaudeFetch,
} from './anthropic-transport'
import { getValidClaudeCredentials } from './anthropic-oauth'

vi.mock('./anthropic-oauth', () => ({ getValidClaudeCredentials: vi.fn() }))
vi.mock('./anthropic-browser', () => ({ ensureAnthropicBrowserTransport: vi.fn(async () => {}) }))
const credentials = vi.mocked(getValidClaudeCredentials)
const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } }
const jsonBody = JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Hello' }] })

beforeEach(() => {
  credentials.mockReset()
  credentials.mockResolvedValue({ accessToken: 'test-subscription-token' })
})

describe('Claude OAuth transport', () => {
  it('refreshes a rejected token once, keeping the exact prompt and cache blocks', async () => {
    credentials.mockResolvedValueOnce({ accessToken: 'expired' }).mockResolvedValueOnce({ accessToken: 'refreshed' })
    const requests: RequestInit[] = []
    const fetcher = makeClaudeFetch(async (input, init) => {
      expect(String(input)).toBe(`${ANTHROPIC_MESSAGES_URL}?beta=true`)
      requests.push(init!)
      return new Response('{}', { status: requests.length === 1 ? 401 : 200 })
    })
    const system = [
      { type: 'text', text: 'Follow my application instructions.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Follow the current user preferences.' },
    ]
    await fetcher(ANTHROPIC_MESSAGES_URL, {
      method: 'POST', body: JSON.stringify({ ...JSON.parse(jsonBody), system }),
      headers: { 'x-api-key': 'must-not-bill', cookie: 'must-not-send', 'anthropic-beta': 'thinking-binding-controls-2026-08-01' },
    })
    expect(requests).toHaveLength(2)
    expect(credentials.mock.calls).toEqual([[false, undefined], [true, undefined, 'expired']])
    expect(requests[0]!.body).toBe(requests[1]!.body)
    expect(JSON.parse(String(requests[0]!.body)).system).toEqual([
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }, ...system,
    ])
    requests.forEach((request, index) => {
      const headers = new Headers(request.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${index === 0 ? 'expired' : 'refreshed'}`)
      expect(headers.has('x-api-key')).toBe(false)
      expect(headers.has('cookie')).toBe(false)
      expect(headers.get('anthropic-beta')!.split(',')).toEqual([
        'thinking-binding-controls-2026-08-01', 'claude-code-20250219', 'oauth-2025-04-20',
      ])
      expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
      expect(headers.get('x-app')).toBe('cli')
      expect(request.redirect).toBe('error')
      expect(request.credentials).toBe('omit')
    })
  })

  it('reads fresh credentials on later calls and supports Request input without duplicating compatibility text', async () => {
    credentials.mockResolvedValueOnce({ accessToken: 'first' }).mockResolvedValueOnce({ accessToken: 'second' })
    const tokens: string[] = []
    const fetcher = makeClaudeFetch(async (_input, init) => {
      tokens.push(new Headers(init?.headers).get('authorization')!)
      expect(JSON.parse(String(init?.body)).system).toEqual([{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }])
      return new Response('{}')
    })
    for (let i = 0; i < 2; i++) {
      await fetcher(new Request(ANTHROPIC_MESSAGES_URL, {
        method: 'POST', body: JSON.stringify({ ...JSON.parse(jsonBody), system: CLAUDE_CODE_SYSTEM_PROMPT }),
      }))
    }
    expect(tokens).toEqual(['Bearer first', 'Bearer second'])
  })

  it.each([
    'https://evil.example/v1/messages', 'https://api.anthropic.com.evil.example/v1/messages',
    'http://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/other',
    'https://' + 'user@' + 'api.anthropic.com/v1/messages',
  ])('never loads or forwards credentials to %s', async (url) => {
    const send = vi.fn<typeof fetch>()
    await expect(makeClaudeFetch(send)(url, { method: 'POST', body: jsonBody })).rejects.toThrow(/official Anthropic/)
    expect(send).not.toHaveBeenCalled()
    expect(credentials).not.toHaveBeenCalled()
  })

  it('returns a second 401 or a quota error without a billing fallback or retry loop', async () => {
    const rejected = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status: 401 }))
    expect((await makeClaudeFetch(rejected)(ANTHROPIC_MESSAGES_URL, { method: 'POST', body: jsonBody })).status).toBe(401)
    expect(rejected).toHaveBeenCalledTimes(2)
    credentials.mockClear()
    const quota = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status: 429 }))
    expect((await makeClaudeFetch(quota)(ANTHROPIC_MESSAGES_URL, { method: 'POST', body: jsonBody })).status).toBe(429)
    expect(quota).toHaveBeenCalledOnce()
    expect(credentials).toHaveBeenCalledOnce()
  })

  it('does not fetch or refresh an aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    const send = vi.fn<typeof fetch>()
    await expect(makeClaudeFetch(send)(ANTHROPIC_MESSAGES_URL, {
      method: 'POST', body: jsonBody, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(send).not.toHaveBeenCalled()
    expect(credentials).not.toHaveBeenCalled()
  })

  it('rejects a request above the overall byte limit before loading credentials or sending it', async () => {
    const send = vi.fn<typeof fetch>()
    await expect(makeClaudeFetch(send)(ANTHROPIC_MESSAGES_URL, {
      method: 'POST', body: JSON.stringify({ ...JSON.parse(jsonBody), system: 'x'.repeat(32_000_000) }),
    })).rejects.toThrow(/exceeds 32 MB/)
    expect(send).not.toHaveBeenCalled()
    expect(credentials).not.toHaveBeenCalled()
  })
})

function sse(events: object[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function startMessage() {
  return { type: 'message_start', message: {
    id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [],
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 20, cache_read_input_tokens: 300 },
  } }
}

describe('native Claude Messages model', () => {
  it.each([false, true])('projects accumulated images in native requests (OAuth: %s) without mutating history', async (oauth) => {
    const messages: ModelMessage[] = []
    for (let index = 0; index < 21; index++) messages.push(
      { role: 'user', content: [{ type: 'image', image: 'AQID', mediaType: 'image/png' }] },
      { role: 'assistant', content: 'Earlier observation.' },
    )
    messages.push({ role: 'user', content: [{ type: 'image', image: 'BAUG', mediaType: 'image/png' }] })
    const original = JSON.stringify(messages)
    let body: any
    await generateText({
      model: createAnthropicModel({ modelId: 'claude-sonnet-5-5', oauth, apiKey: 'test-key', fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return Response.json({
          id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      } }), messages, maxRetries: 0,
    })
    expect(JSON.stringify(body).match(/"type":"image"/g)).toHaveLength(20)
    expect(body.messages[0].content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Earlier image omitted') })
    expect(body.messages.at(-1).content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BAUG' } })
    expect(body.thinking.block_binding.prefix_mismatch_behavior).toBe('drop_block')
    expect(JSON.stringify(messages)).toBe(original)
  })

  it('streams thinking and tools, retains signatures, and sends images inside native tool results', async () => {
    const requests: Array<{ body: any; headers: Headers }> = []
    const capture: typeof fetch = async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) })
      if (requests.length === 1) return sse([
        startMessage(),
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I will inspect the screen.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_shot', name: 'screenshot', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } },
        { type: 'message_stop' },
      ])
      const secondMessage = startMessage()
      return sse([
        { ...secondMessage, message: { ...secondMessage.message, input_transformations: [
          { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
        ] } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The screen is ready.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ])
    }
    const result = streamText({
      model: createAnthropicModel({ modelId: 'claude-opus-5-5', oauth: true, fetch: capture }),
      system: [
        { role: 'system', content: 'Static instructions.', providerOptions: EPHEMERAL },
        { role: 'system', content: 'Dynamic instructions.' },
      ],
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Inspect this screenshot.' },
        { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
      ], providerOptions: EPHEMERAL }],
      tools: { screenshot: tool({
        inputSchema: z.object({}), execute: async () => 'AQID',
        toModelOutput: ({ output }) => ({ type: 'content', value: [{ type: 'media', mediaType: 'image/png', data: output }] }),
      }) },
      stopWhen: stepCountIs(3),
    })
    const parts = []
    for await (const part of result.fullStream) parts.push(part)
    expect(await result.text).toBe('The screen is ready.')
    expect(parts).toContainEqual(expect.objectContaining({ type: 'reasoning-delta', text: 'I will inspect the screen.' }))
    expect(requests).toHaveLength(2)
    for (const { body, headers } of requests) {
      expect(body).toMatchObject({
        model: 'claude-opus-5-5', max_tokens: 16384, stream: true,
        thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        output_config: { effort: 'medium' },
        system: [
          { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
          { type: 'text', text: 'Static instructions.', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Dynamic instructions.' },
        ],
      })
      expect(headers.get('anthropic-beta')).toContain('thinking-binding-controls-2026-08-01')
      expect(body.tools[0].name).toBe('screenshot')
    }
    expect(requests[0]!.body.messages[0].content).toContainEqual({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' }, cache_control: { type: 'ephemeral' },
    })
    expect(requests[1]!.body.messages[1].content[0]).toEqual({
      type: 'thinking', thinking: 'I will inspect the screen.', signature: 'opaque-signature',
    })
    expect(requests[1]!.body.messages[2].content[0]).toMatchObject({
      type: 'tool_result', tool_use_id: 'toolu_shot',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }],
    })
    expect(await result.usage).toMatchObject({ inputTokens: 420, outputTokens: 10, cachedInputTokens: 300 })
    expect((await result.providerMetadata)?.anthropic?.inputTransformations).toEqual([
      { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
    ])
    const history = (await result.response).messages as ModelMessage[]
    expect(history[0]).toMatchObject({ content: expect.arrayContaining([{ type: 'reasoning', text: 'I will inspect the screen.', providerOptions: { anthropic: { signature: 'opaque-signature' } } }]) })
  })

  it('keeps signed empty and redacted thinking when replaying, with API-key authentication isolated from OAuth', async () => {
    let body: any
    const model = createAnthropicModel({
      modelId: 'anthropic/claude-sonnet-5-5', apiKey: 'api-key-fixture',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        const headers = new Headers(init?.headers)
        expect(headers.get('x-api-key')).toBe('api-key-fixture')
        expect(headers.has('authorization')).toBe(false)
        expect(headers.has('x-app')).toBe(false)
        expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
        expect(init?.redirect).toBe('error')
        return Response.json({
          id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
    })
    const result = await generateText({
      model, system: 'Application prompt.', maxOutputTokens: 20000,
      headers: { authorization: 'Bearer stale-token', cookie: 'unrelated-session' },
      messages: [
        { role: 'user', content: 'Earlier request.' },
        { role: 'assistant', content: [
          { type: 'reasoning', text: '', providerOptions: { anthropic: { signature: 'empty-signature' } } },
          { type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: 'redacted-data' } } },
          { type: 'text', text: 'Earlier answer.' },
        ] },
        { role: 'user', content: 'Continue.' },
      ],
    })
    expect(result.text).toBe('Done.')
    expect(body.max_tokens).toBe(20000)
    expect(body.output_config.effort).toBe('high')
    expect(body.system).toEqual([{ type: 'text', text: 'Application prompt.' }])
    expect(body.messages[1].content.slice(0, 2)).toEqual([
      { type: 'thinking', thinking: '', signature: 'empty-signature' },
      { type: 'redacted_thinking', data: 'redacted-data' },
    ])
    expect(credentials).not.toHaveBeenCalled()
  })
})
