import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  isXaiPriorityModelId,
  pinnedSettingsForModel,
  stripXaiPrioritySuffix,
  type Settings,
} from '../shared/types'
import { hasModelAccess, resolveModelAccess, resolveProviderSettings, withPriorityServiceTier } from './models'

const signedOut = async (): Promise<never> => {
  throw new Error('No ChatGPT account connected.')
}

describe('model access fallback', () => {
  it('uses a saved OpenAI API key when ChatGPT is selected but signed out', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      provider: 'openai',
      openaiAuthMode: 'chatgpt',
      modelId: 'gpt-5.6-sol',
      apiKey: '',
      apiKeys: { openai: 'sk-platform' },
    }

    const access = await resolveModelAccess(settings, settings.modelId, signedOut)

    expect(access.chatgptCredentials).toBeUndefined()
    expect(access.settings).toMatchObject({
      provider: 'openai',
      openaiAuthMode: 'api-key',
      modelId: 'gpt-5.6-sol',
      apiKey: 'sk-platform',
    })
    expect(hasModelAccess(settings, settings.modelId, false)).toBe(true)
  })

  it('uses the current chat model for Luna helpers when no OpenAI credential exists', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      provider: 'xai',
      openaiAuthMode: 'chatgpt',
      modelId: 'grok-4.6',
      apiKey: 'xai-key',
      apiKeys: { xai: 'xai-key' },
    }

    const access = await resolveModelAccess(settings, 'gpt-5.6-luna', signedOut)

    expect(access.settings).toMatchObject({ provider: 'xai', modelId: 'grok-4.6', apiKey: 'xai-key' })
    expect(hasModelAccess(settings, 'gpt-5.6-luna', false)).toBe(true)
  })

  it('uses another configured provider when the current OpenAI chat is signed out', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      provider: 'openai',
      openaiAuthMode: 'chatgpt',
      modelId: 'gpt-5.6-sol',
      apiKey: '',
      apiKeys: { xai: 'xai-key' },
    }

    const access = await resolveModelAccess(settings, settings.modelId, signedOut)

    expect(access.settings).toMatchObject({ provider: 'xai', modelId: 'grok-4.6', apiKey: 'xai-key' })
    expect(hasModelAccess(settings, settings.modelId, false)).toBe(true)
  })
})

describe('xAI priority service tier', () => {
  const seen: Array<Record<string, unknown>> = []
  const capture: typeof fetch = async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response('{}')
  }

  it('reads the -fast suffix as a tier, not as part of the model id', () => {
    expect(isXaiPriorityModelId('grok-4.6-fast')).toBe(true)
    expect(isXaiPriorityModelId('xai/grok-4.6-fast')).toBe(true)
    expect(isXaiPriorityModelId('grok-4.6')).toBe(false)
    expect(isXaiPriorityModelId('gpt-5.6-sol-fast')).toBe(false)
    expect(stripXaiPrioritySuffix('grok-4.6-fast')).toBe('grok-4.6')
    expect(stripXaiPrioritySuffix('grok-4.6')).toBe('grok-4.6')
  })

  it('adds service_tier: priority to the request body', async () => {
    seen.length = 0
    await withPriorityServiceTier(capture)('https://api.x.ai/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'grok-4.6', input: 'hi' }),
    })
    expect(seen[0]).toEqual({ model: 'grok-4.6', input: 'hi', service_tier: 'priority' })
  })

  it('leaves an explicit tier and non-JSON bodies alone', async () => {
    seen.length = 0
    const send = withPriorityServiceTier(capture)
    await send('https://api.x.ai/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'grok-4.6', service_tier: 'default' }),
    })
    expect(seen[0]).toMatchObject({ service_tier: 'default' })

    const passthrough = await withPriorityServiceTier(async (_input, init) => {
      expect(init?.body).toBe('not json')
      return new Response('{}')
    })('https://api.x.ai/v1/responses', { method: 'POST', body: 'not json' })
    expect(passthrough.ok).toBe(true)
  })
})

describe('locally served curated model', () => {
  const localId = 'handoff-qwen3.5-4b'

  it('pins its endpoint and a placeholder key at request time', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, provider: 'xai', apiKey: 'xai-key', modelId: 'grok-4.6' }
    const resolved = resolveProviderSettings(settings, localId)
    expect(resolved).toMatchObject({
      provider: 'openai-compatible',
      baseURL: 'http://127.0.0.1:8099/v1',
      modelId: localId,
    })
    // A local server authenticates nothing, but the key must be non-empty or
    // every "is this provider configured" guard rejects it.
    expect(resolved.apiKey).toBeTruthy()
    expect(hasModelAccess(settings, localId, false)).toBe(true)
  })

  it('does not write the local endpoint into persisted settings', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      provider: 'openai-compatible',
      apiKey: 'proxy-key',
      baseURL: 'https://my-proxy.example/v1',
      modelId: 'some-proxy-model',
    }
    // Persisted path: the user's own proxy URL must survive the round trip.
    expect(pinnedSettingsForModel(localId, settings).baseURL).toBe('https://my-proxy.example/v1')
    // Request path materializes the pinned one without mutating the input.
    expect(pinnedSettingsForModel(localId, settings, { pinEndpoint: true }).baseURL).toBe(
      'http://127.0.0.1:8099/v1',
    )
    expect(settings.baseURL).toBe('https://my-proxy.example/v1')
  })

  it('switches away from a local model when a remote curated model is picked', () => {
    // Regression: curated entries own their provider. Without this, picking GPT
    // while the local model is active would send the GPT id to localhost.
    const onLocal: Settings = {
      ...DEFAULT_SETTINGS,
      provider: 'openai-compatible',
      apiKey: 'local',
      baseURL: 'http://127.0.0.1:8099/v1',
      modelId: localId,
      apiKeys: { openai: 'sk-platform' },
    }
    const resolved = resolveProviderSettings(onLocal, 'gpt-5.6-sol')
    expect(resolved.provider).toBe('openai')
    expect(resolved.apiKey).toBe('sk-platform')
  })

  it('still lets a free-text id ride a user-configured proxy', () => {
    const proxy: Settings = {
      ...DEFAULT_SETTINGS,
      provider: 'openai-compatible',
      apiKey: 'proxy-key',
      baseURL: 'https://my-proxy.example/v1',
      modelId: 'anything',
    }
    const resolved = resolveProviderSettings(proxy, 'gpt-4o-mini')
    expect(resolved.provider).toBe('openai-compatible')
    expect(resolved.baseURL).toBe('https://my-proxy.example/v1')
  })

  it('routes local model overrides directly even when the parent uses a gateway', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, provider: 'gateway', apiKey: 'gateway-key' }
    expect(resolveProviderSettings(settings, localId)).toMatchObject({
      provider: 'openai-compatible', modelId: localId,
      baseURL: 'http://127.0.0.1:8099/v1', apiKey: 'local',
    })
  })

  it('does not forward a vaulted proxy credential to a local endpoint', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS, provider: 'openai-compatible', apiKey: 'private-proxy-key',
      apiKeys: { 'openai-compatible': 'vaulted-proxy-key' },
      baseURL: 'https://my-proxy.example/v1',
    }
    expect(resolveProviderSettings(settings, localId).apiKey).toBe('local')
    expect(settings.apiKey).toBe('private-proxy-key')
  })

  it('uses the local chat endpoint for helpers when OpenAI is unavailable', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS, provider: 'openai-compatible', modelId: localId,
      apiKey: '', baseURL: 'https://my-proxy.example/v1', openaiAuthMode: 'chatgpt',
      apiKeys: { 'openai-compatible': 'vaulted-proxy-key' },
    }
    const access = await resolveModelAccess(settings, 'gpt-5.6-luna', signedOut)
    expect(access.settings).toMatchObject({
      provider: 'openai-compatible', modelId: localId,
      baseURL: 'http://127.0.0.1:8099/v1', apiKey: 'local',
    })
    expect(hasModelAccess(settings, 'gpt-5.6-luna', false)).toBe(true)
  })
})
