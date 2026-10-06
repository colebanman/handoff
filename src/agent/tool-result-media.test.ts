import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText, type ModelMessage } from 'ai'
import { DEFAULT_SETTINGS } from '../shared/types'
import { resolveModel } from './models'
import { inlineMediaToolResults, supportsMediaToolResults } from './tool-result-media'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jUAAAAABJRU5ErkJggg=='
const jpeg = '/9j/fixture'
const history = (): ModelMessage[] => [
  { role: 'user', content: 'Compare the two screenshots.' },
  { role: 'assistant', content: ['first', 'second'].map(toolCallId => ({
    type: 'tool-call', toolCallId, toolName: 'browser_screenshot', input: {},
  })) },
  { role: 'tool', content: [png, jpeg].map((data, index) => ({
    type: 'tool-result', toolCallId: index ? 'second' : 'first', toolName: 'browser_screenshot',
    output: { type: 'content', value: [{ type: 'text', text: `Screenshot ${index + 1}` },
      { type: 'media', data, mediaType: index ? 'image/jpeg' : 'image/png' }] },
  })) },
]

afterEach(() => vi.unstubAllGlobals())

describe('provider-specific image delivery on the actual SDK wire', () => {
  it('keeps parallel tool replies contiguous before inserting their images', () => {
    const messages = history()
    const tools = messages.pop()!
    if (tools.role !== 'tool') throw new Error('fixture')
    messages.push(...tools.content.map(part => ({ role: 'tool' as const, content: [part] })))
    const projected = inlineMediaToolResults(messages)
    expect(projected.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    const images = projected.at(-1)!.content
    expect(Array.isArray(images) && images.filter(part => part.type === 'image')).toHaveLength(2)
    expect(JSON.stringify(projected.at(-1))).toContain('tool call first')
    expect(JSON.stringify(projected.at(-1))).toContain('tool call second')
    expect(inlineMediaToolResults(projected)).toBe(projected)
  })
  it.each([
    ['openai', 'gpt-5.6-sol', 'responses'],
    ['openai', 'gpt-5.6-sol', 'chatgpt'],
    ['openai-compatible', 'vision-model', 'chat'],
    ['cerebras', 'qwen-3.8-27b', 'chat'],
    ['xai', 'grok-4.6', 'xai'],
    ['anthropic', 'claude-opus-5-5', 'anthropic'],
    ['anthropic', 'claude-sonnet-5-5', 'anthropic'],
    ['gateway', 'openai/gpt-5.6-sol', 'gateway-responses'],
    ['gateway', 'anthropic/claude-sonnet-4.6', 'gateway'],
    ['gateway', 'google/gemini-2.5-pro', 'gateway'],
    ['gateway', 'xai/grok-4.6', 'gateway-xai'],
  ] as const)('%s/%s via %s preserves images and tool-call association', async (provider, modelId, route) => {
    let body: any
    const capture: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body))
      throw new Error('request captured without sending')
    }
    vi.stubGlobal('fetch', capture)
    const messages = history(), original = structuredClone(messages)
    const model = resolveModel({ ...DEFAULT_SETTINGS, provider, modelId,
      apiKey: 'test-only', baseURL: 'https://mock.invalid/v1',
      anthropicAuthMode: 'api-key',
      openaiAuthMode: route === 'chatgpt' ? 'chatgpt' : 'api-key',
    }, route === 'chatgpt' ? { accessToken: 'test-only', accountId: 'test', isFedRamp: false } : undefined,
    route === 'chatgpt' || route === 'gateway-responses' ? () => capture : undefined)
    await generateText({ model, maxRetries: 0, messages:
      supportsMediaToolResults(provider, modelId) ? messages : inlineMediaToolResults(messages),
    }).catch(() => {}) // Capture the real request, with no provider charge or credentials.
    expect(body).toBeDefined()
    expect(messages).toEqual(original)

    if (route === 'responses' || route === 'chatgpt' || route === 'gateway-responses') {
      const outputs = body.input.filter((item: any) => item.type === 'function_call_output')
      expect(outputs).toHaveLength(2)
      expect(outputs[0]).toMatchObject({ call_id: 'first', output: [
        { type: 'input_text', text: 'Screenshot 1' }, { type: 'input_image', image_url: `data:image/png;base64,${png}` },
      ] })
      expect(outputs[1].output[1]).toMatchObject({ type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg}` })
    } else if (route === 'chat') {
      const tools = body.messages.filter((message: any) => message.role === 'tool')
      expect(tools.map((message: any) => message.tool_call_id)).toEqual(['first', 'second'])
      expect(JSON.stringify(tools)).not.toContain(png)
      const images = body.messages.at(-1)
      expect(images.role).toBe('user')
      expect(images.content).toEqual([
        { type: 'text', text: 'Image output of tool call first:' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
        { type: 'text', text: 'Image output of tool call second:' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg}` } },
      ])
    } else if (route === 'xai') {
      const outputs = body.input.filter((item: any) => item.type === 'function_call_output')
      expect(outputs.map((item: any) => item.call_id)).toEqual(['first', 'second'])
      expect(outputs.every((item: any) => typeof item.output === 'string' && !item.output.includes(png))).toBe(true)
      expect(body.input.at(-1)).toMatchObject({ role: 'user', content: expect.arrayContaining([
        { type: 'input_image', image_url: `data:image/png;base64,${png}` },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg}` },
      ]) })
    } else if (route === 'anthropic') {
      const results = body.messages.flatMap((message: any) => Array.isArray(message.content)
        ? message.content.filter((part: any) => part.type === 'tool_result') : [])
      expect(results.map((part: any) => part.tool_use_id)).toEqual(['first', 'second'])
      expect(results[0].content).toEqual([
        { type: 'text', text: 'Screenshot 1' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      ])
      expect(results[1].content[1].source).toMatchObject({ media_type: 'image/jpeg', data: jpeg })
    } else {
      // Gateway carries AI SDK's structured prompt to the selected provider.
      const toolMessage = body.prompt.find((message: any) => message.role === 'tool')
      expect(toolMessage.content.map((part: any) => part.toolCallId)).toEqual(['first', 'second'])
      if (route === 'gateway-xai') {
        expect(JSON.stringify(toolMessage)).not.toContain(png)
        expect(JSON.stringify(body.prompt.at(-1))).toContain(png)
      } else {
        expect(typeof toolMessage.content[0].output).toBe('object')
        expect(JSON.stringify(toolMessage.content[0].output)).toContain(png)
      }
    }
  })

  it('is idempotent, preserves text/errors, and gives PDF recovery instead of pretending to see it', () => {
    const messages = history()
    messages.push({ role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'pdf', toolName: 'filesystem_view', output: {
        type: 'content', value: [{ type: 'text', text: 'Saved report.pdf' }, { type: 'media', mediaType: 'application/pdf', data: 'JVBERi0=' }],
      } },
      { type: 'tool-result', toolCallId: 'error', toolName: 'browser_screenshot', output: { type: 'error-text', value: 'Error: closed tab' } },
    ] })
    const projected = inlineMediaToolResults(messages)
    expect(inlineMediaToolResults(projected)).toBe(projected)
    expect(JSON.stringify(projected)).toContain('mode:\\"pdf-page\\"')
    expect(JSON.stringify(projected)).toContain('Saved report.pdf')
    expect(JSON.stringify(projected)).toContain('Error: closed tab')
    expect(JSON.stringify(projected)).not.toContain('JVBERi0=')
    expect(JSON.stringify(messages)).toContain('JVBERi0=')
  })
})
