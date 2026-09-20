import { afterEach, describe, expect, it, vi } from 'vitest'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { CEREBRAS_DEFAULT_MODEL_ID, DEFAULT_SETTINGS, pinnedSettingsForModel, type Settings } from '../shared/types'
import { normalizeSettings } from '../shared/normalize-settings'
import { modelPickerProviders } from '../shared/model-picker'
import { hasModelAccess, resolveModel, resolveModelAccess, resolveProviderSettings } from './models'
import { buildSystemMessages, cacheRequestOptions } from './prompt-cache'
import { inlineMediaToolResults, supportsMediaToolResults } from './tool-result-media'

const settings: Settings = {
  ...DEFAULT_SETTINGS, provider: 'cerebras', modelId: CEREBRAS_DEFAULT_MODEL_ID,
  apiKey: 'cerebras-fixture', apiKeys: { cerebras: 'cerebras-fixture', xai: 'xai-fixture' },
  baseURL: 'http://localhost:8099/v1',
}
afterEach(() => vi.unstubAllGlobals())

describe('Cerebras shared inference', () => {
  it('persists credentials, exposes the picker, and pins direct routing across provider switches', async () => {
    const stored = normalizeSettings({ ...settings, apiKey: '', modelId: `cerebras/${CEREBRAS_DEFAULT_MODEL_ID}` })
    expect(stored).toMatchObject({ provider: 'cerebras', modelId: CEREBRAS_DEFAULT_MODEL_ID, apiKey: 'cerebras-fixture' })
    expect(modelPickerProviders(stored, false)).toContain('cerebras')
    expect(modelPickerProviders({ ...stored, apiKey: '', apiKeys: {} }, false)).not.toContain('cerebras')
    for (const provider of ['openai', 'xai', 'gateway', 'openai-compatible'] as const) {
      const other = { ...stored, provider, modelId: 'gpt-5.6-sol', apiKey: 'other-key' }
      expect(modelPickerProviders(other, false)).toContain('cerebras')
      expect(resolveProviderSettings(other, CEREBRAS_DEFAULT_MODEL_ID)).toMatchObject({
        provider: 'cerebras', modelId: CEREBRAS_DEFAULT_MODEL_ID, apiKey: 'cerebras-fixture',
      })
    }
    expect(pinnedSettingsForModel('grok-4.6', stored)).toMatchObject({ provider: 'xai', apiKey: 'xai-fixture' })
    const signedOut = async (): Promise<never> => { throw new Error('signed out') }
    const helper = await resolveModelAccess(stored, 'gpt-5.6-luna', signedOut)
    expect(helper.settings).toMatchObject({ provider: 'cerebras', modelId: CEREBRAS_DEFAULT_MODEL_ID })
    const onlyCerebras = { ...DEFAULT_SETTINGS, provider: 'openai' as const, openaiAuthMode: 'chatgpt' as const, apiKey: '', apiKeys: { cerebras: 'cerebras-fixture' } }
    expect(hasModelAccess(onlyCerebras, 'gpt-5.6-luna', false)).toBe(true)
    expect((await resolveModelAccess(onlyCerebras, 'gpt-5.6-luna', signedOut)).settings).toMatchObject({ provider: 'cerebras', modelId: CEREBRAS_DEFAULT_MODEL_ID })
    expect(() => resolveModel({ ...stored, apiKey: '' })).toThrow(/No API key.*cerebras/)
  })

  it('streams reasoning and tools, replays reasoning, and delivers screenshots on the shared endpoint', async () => {
    const requests: Array<{ url: string; headers: Headers; body: any }> = []
    const capture = vi.fn<typeof fetch>(async (input, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push({ url: String(input), headers: new Headers(init?.headers), body })
      const first = requests.length === 1
      const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({
        id: 'cerebras-test', created: 1, model: CEREBRAS_DEFAULT_MODEL_ID,
        choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason ? { usage: { prompt_tokens: 123, completion_tokens: 12, total_tokens: 135 } } : {}),
      })}\n\n`
      const stream = first
        ? chunk({ role: 'assistant', reasoning: 'I will inspect the screen.' }) +
          chunk({ tool_calls: [{ index: 0, id: 'shot', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] }) + chunk({}, 'tool_calls')
        : chunk({ role: 'assistant', content: 'The screen is ready.' }) + chunk({}, 'stop')
      return new Response(stream + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', capture)
    const execute = vi.fn(async () => 'iVBORw0KGgo=')
    const result = streamText({
      model: resolveModel(settings),
      system: buildSystemMessages({ staticPrompt: 'Base instructions.', dynamicPrompt: 'Custom instructions.' }, false),
      messages: [{ role: 'user', content: 'Inspect the screen.' }],
      ...cacheRequestOptions('cerebras', settings.modelId, 'test-cache'),
      tools: { screenshot: tool({
        inputSchema: z.object({}), execute,
        toModelOutput: ({ output }) => ({ type: 'content', value: [{ type: 'media', mediaType: 'image/png', data: output }] }),
      }) },
      stopWhen: stepCountIs(3),
      prepareStep: ({ messages }) => ({ messages: inlineMediaToolResults(messages) }),
    })
    const parts = []
    for await (const part of result.fullStream) parts.push(part)
    expect(await result.text).toBe('The screen is ready.')
    expect(parts).toContainEqual(expect.objectContaining({ type: 'reasoning-delta', text: 'I will inspect the screen.' }))
    expect(execute).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.url).toBe('https://api.cerebras.ai/v1/chat/completions')
      expect(request.headers.get('authorization')).toBe('Bearer cerebras-fixture')
      expect(request.body).toMatchObject({ model: CEREBRAS_DEFAULT_MODEL_ID, stream: true })
      expect(request.body.prompt_cache_key).toBe('test-cache')
      expect(request.body.messages[0]).toEqual({ role: 'system', content: 'Base instructions.\n\nCustom instructions.' })
      expect(request.body.messages.slice(1).every((message: any) => message.role !== 'system')).toBe(true)
      for (const unsupported of ['service_tier', 'store', 'prompt_cache_retention', 'tool_stream']) {
        expect(request.body).not.toHaveProperty(unsupported)
      }
    }
    expect(supportsMediaToolResults('cerebras', settings.modelId)).toBe(false)
    const replay = requests[1]!.body.messages
    expect(replay.find((m: any) => m.role === 'assistant')).toMatchObject({ reasoning: 'I will inspect the screen.', tool_calls: [{ id: 'shot' }] })
    expect(replay.find((m: any) => m.role === 'assistant')).not.toHaveProperty('reasoning_content')
    expect(replay.at(-1)).toMatchObject({ role: 'user', content: expect.arrayContaining([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]) })
    expect(await result.usage).toMatchObject({ inputTokens: 123, outputTokens: 12 })
  })
})
