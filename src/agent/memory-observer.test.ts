import { describe, expect, it, vi } from 'vitest'
import { memoryObserverInput, resolveMemoryAccess } from './memory-observer'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { newMemoryState, type MemoryEvent } from '../shared/continuity'

describe('cheap background model routing', () => {
  it('uses the explicitly selected subscription and never falls through to a saved paid key', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, openaiAuthMode: 'chatgpt', apiKeys: { openai: 'inactive-paid-key' } }
    const failed = vi.fn(async () => { throw new Error('Luna subscription unavailable') })
    await expect(resolveMemoryAccess(settings, 'gpt-6-luna', failed)).rejects.toThrow('Luna subscription unavailable')
    expect(failed).toHaveBeenCalledTimes(1)
    const credentials = { accessToken: 'oauth', accountId: 'account', isFedRamp: false }
    const access = await resolveMemoryAccess(settings, 'gpt-6-luna', async () => credentials)
    expect(access.settings).toMatchObject({ provider: 'openai', modelId: 'gpt-6-luna', apiKey: 'oauth' })
  })
  it('does not use an expensive foreground provider when OpenAI has no configured access', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, provider: 'anthropic', modelId: 'claude-opus-5-5', apiKeys: { anthropic: 'claude-key' }, apiKey: 'claude-key', openaiAuthMode: 'api-key' }
    await expect(resolveMemoryAccess(settings, 'gpt-6-luna')).rejects.toThrow('Connect OpenAI')
  })
  it('honors an explicit route and model instead of silently bypassing it', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, provider: 'gateway', apiKey: 'gateway-key' }
    expect((await resolveMemoryAccess(settings, 'gpt-6-luna')).settings).toMatchObject({ provider: 'gateway', modelId: 'openai/gpt-6-luna', apiKey: 'gateway-key' })
    expect((await resolveMemoryAccess({ ...settings, provider: 'openai', openaiAuthMode: 'api-key', apiKeys: { openai: 'openai-key' } }, 'gpt-6-sol')).settings.modelId).toBe('gpt-6-sol')
  })
  it('keeps source origins, excluded subjects, and the schema explicit in the inference input', () => {
    const state = newMemoryState()
    state.suppressions = [{ subject: 'old address', sourceIds: ['old'], at: 10 }]
    const event: MemoryEvent = { id: 'event', parentId: 'parent', origin: 'automation', at: 10, label: 'Daily prompt', text: 'User always wants this', excerpt: 'User always wants this', pending: 1 }
    const input = JSON.parse(memoryObserverInput([event], [], state, 20))
    expect(input.events[0].origin).toBe('automation')
    expect(input.excludedSubjects).toEqual(['old address'])
    expect(input.schema.properties.upserts).toBeTruthy()
  })
})
