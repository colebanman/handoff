import { describe, expect, it } from 'vitest'
import { modelPickerProviders } from './model-picker'
import { normalizeSettings } from './normalize-settings'
import { ANTHROPIC_DEFAULT_MODEL_ID, DEFAULT_SETTINGS, MODEL_OPTIONS, pinnedSettingsForModel, type Settings } from './types'

const subscribed: Settings = {
  ...DEFAULT_SETTINGS,
  provider: 'anthropic',
  modelId: ANTHROPIC_DEFAULT_MODEL_ID,
  apiKey: '',
  apiKeys: { anthropic: 'saved-paid-key', xai: 'saved-xai-key' },
}

describe('Claude provider settings', () => {
  it('defaults to subscription access while retaining an inactive paid API key', () => {
    expect(normalizeSettings({ ...subscribed, apiKey: 'saved-paid-key' })).toMatchObject({
      provider: 'anthropic', anthropicAuthMode: 'claude', apiKey: '',
      apiKeys: { anthropic: 'saved-paid-key', xai: 'saved-xai-key' },
    })
  })

  it('enables API-key billing only when explicitly selected and normalizes vendor prefixes', () => {
    expect(normalizeSettings({ ...subscribed, anthropicAuthMode: 'api-key', modelId: 'anthropic/claude-sonnet-5-5' })).toMatchObject({
      provider: 'anthropic', anthropicAuthMode: 'api-key', apiKey: 'saved-paid-key', modelId: 'claude-sonnet-5-5',
    })
  })

  it('keeps gateway Claude model IDs in the Anthropic namespace', () => {
    expect(normalizeSettings({ ...subscribed, provider: 'gateway', modelId: 'claude-sonnet-5-5' }).modelId)
      .toBe('anthropic/claude-sonnet-5-5')
  })

  it('retains explicitly selected gateway routing and its credential when picking Claude', () => {
    const gateway: Settings = { ...subscribed, provider: 'gateway', apiKey: 'gateway-key', apiKeys: { gateway: 'gateway-key', anthropic: 'inactive-paid-key' } }
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5']) {
      expect(pinnedSettingsForModel(id, gateway)).toMatchObject({
        provider: 'gateway', apiKey: 'gateway-key', modelId: `anthropic/${id.replace(/^anthropic\//, '')}`,
      })
    }
    // Existing non-Claude picker migration remains unchanged.
    expect(pinnedSettingsForModel('gpt-5.6-sol', gateway).provider).toBe('openai')
  })

  it('routes both requested picker models to Anthropic and leaves the paid key inactive', () => {
    const settings: Settings = { ...subscribed, provider: 'xai', modelId: 'grok-4.6', apiKey: 'saved-xai-key' }
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(MODEL_OPTIONS.find((option) => option.id === model)?.provider).toBe('anthropic')
      expect(pinnedSettingsForModel(model, settings)).toMatchObject({
        provider: 'anthropic', modelId: model, anthropicAuthMode: 'claude', apiKey: '',
      })
    }
    expect(pinnedSettingsForModel('grok-4.6', subscribed).apiKey).toBe('saved-xai-key')
  })

  it('supports custom and namespaced Claude IDs without overriding a custom proxy', () => {
    expect(pinnedSettingsForModel('anthropic/claude-future', DEFAULT_SETTINGS)).toMatchObject({
      provider: 'anthropic', modelId: 'claude-future', anthropicAuthMode: 'claude', apiKey: '',
    })
    const proxy: Settings = { ...DEFAULT_SETTINGS, provider: 'openai-compatible', apiKey: 'proxy-key', baseURL: 'https://proxy.example/v1' }
    expect(pinnedSettingsForModel('claude-future', proxy)).toMatchObject({ provider: 'openai-compatible', apiKey: 'proxy-key' })
  })

  it('restores a saved Anthropic key when API-key mode was explicitly selected', () => {
    expect(pinnedSettingsForModel('claude-sonnet-5-5', {
      ...subscribed, provider: 'xai', apiKey: 'saved-xai-key', anthropicAuthMode: 'api-key',
    })).toMatchObject({ provider: 'anthropic', anthropicAuthMode: 'api-key', apiKey: 'saved-paid-key' })
  })
})

describe('Claude model picker credentials', () => {
  it('offers subscription models only for a connected Claude session, independent of ChatGPT', () => {
    expect(modelPickerProviders(subscribed, false, true)).toContain('anthropic')
    expect(modelPickerProviders(subscribed, true, false)).not.toContain('anthropic')
    expect(modelPickerProviders(subscribed, false, false)).not.toContain('anthropic')
  })

  it('requires an API key when API-key mode is selected even if Claude is signed in', () => {
    expect(modelPickerProviders({ ...subscribed, anthropicAuthMode: 'api-key' }, false, false)).toContain('anthropic')
    expect(modelPickerProviders({ ...subscribed, anthropicAuthMode: 'api-key', apiKeys: {} }, false, true)).not.toContain('anthropic')
  })

  it('keeps Claude available while another provider is active', () => {
    for (const provider of ['openai', 'xai', 'cerebras', 'openai-compatible'] as const) {
      expect(modelPickerProviders({ ...subscribed, provider }, false, true)).toContain('anthropic')
    }
  })

  it('offers gateway-routed Claude models with the gateway credential', () => {
    expect(modelPickerProviders({ ...DEFAULT_SETTINGS, provider: 'gateway', apiKey: 'gateway-key' }, false, false))
      .toContain('anthropic')
  })
})
