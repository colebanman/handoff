import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveContextWindow } from './model-context'
import { listChatGPTModels } from './openai-chatgpt-oauth'

vi.mock('./openai-chatgpt-oauth', () => ({ listChatGPTModels: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

describe('transport-specific context catalog', () => {
  it('uses account-provided ChatGPT limits instead of the conservative fallback', async () => {
    vi.mocked(listChatGPTModels).mockResolvedValue([{ id: 'gpt-6.1-sol', label: 'Sol', provider: 'openai', contextWindow: 1_050_000 }])
    expect(await resolveContextWindow({ provider: 'openai', modelId: 'openai/gpt-6.1-sol', openaiAuthMode: 'chatgpt' }))
      .toEqual({ tokens: 1_050_000, source: 'catalog' })
  })
  it('keeps a labeled fallback when the catalog fails or has an invalid limit', async () => {
    const model = { provider: 'openai' as const, modelId: 'gpt-6.1-sol', openaiAuthMode: 'chatgpt' as const }
    vi.mocked(listChatGPTModels).mockRejectedValueOnce(new Error('offline'))
    expect(await resolveContextWindow(model)).toEqual({ tokens: 272_000, source: 'fallback' })
    for (const contextWindow of [undefined, NaN, Infinity, -1, 0]) {
      vi.mocked(listChatGPTModels).mockResolvedValue([{ id: model.modelId, label: 'Sol', provider: 'openai', contextWindow }])
      expect(await resolveContextWindow(model)).toEqual({ tokens: 272_000, source: 'fallback' })
    }
  })
  it('never consults Vercel for direct OpenAI or Anthropic requests', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await resolveContextWindow({ provider: 'openai', modelId: 'gpt-6.1-sol' })).toEqual({ tokens: 1_050_000, source: 'model' })
    expect(await resolveContextWindow({ provider: 'anthropic', modelId: 'claude-opus-5-5' })).toEqual({ tokens: 1_000_000, source: 'model' })
    expect(fetch).not.toHaveBeenCalled()
    expect(listChatGPTModels).not.toHaveBeenCalled()
  })
  it('uses only active gateway endpoints and does not promise the largest route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { endpoints: [
      { status: 0, context_length: 1_050_000 }, { status: 0, context_length: 400_000 }, { status: 1, context_length: 200_000 },
    ] } })))
    expect(await resolveContextWindow({ provider: 'gateway', modelId: 'openai/gpt-6.1-sol' })).toEqual({ tokens: 400_000, source: 'catalog' })
  })
  it('preserves caller cancellation rather than starting inference with a fallback', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(resolveContextWindow({ provider: 'openai', modelId: 'gpt-6.1-sol' }, controller.signal)).rejects.toThrow()
    expect(listChatGPTModels).not.toHaveBeenCalled()
  })
})
