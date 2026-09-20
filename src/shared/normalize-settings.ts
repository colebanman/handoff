import { DEFAULT_SETTINGS, type ActivityCursorMode, type ProviderKind, type Settings } from './types'
import { BRIDGE_DEFAULT_PORT } from './bridge-protocol'

const PROVIDERS = new Set<ProviderKind>(['gateway', 'openai', 'openai-compatible', 'xai', 'cerebras'])
const ACTIVITY_CURSOR_MODES = new Set<ActivityCursorMode>(['off', 'actions', 'ambient'])
export const DEFAULT_ACTIVITY_CURSOR: ActivityCursorMode = 'ambient'

export function normalizeSettings(settings: Settings): Settings {
  const modelId = settings.modelId.trim() || DEFAULT_SETTINGS.modelId
  const openaiAuthMode = settings.openaiAuthMode === 'chatgpt' ? 'chatgpt' : 'api-key'
  const storedProvider = String(settings.provider)
  const providerWasRemoved = !PROVIDERS.has(storedProvider as ProviderKind)
  let provider: ProviderKind = providerWasRemoved ? DEFAULT_SETTINGS.provider : (storedProvider as ProviderKind)
  let nextModelId = providerWasRemoved ? DEFAULT_SETTINGS.modelId : modelId
  if (provider === 'gateway') {
    // Native-provider ids migrate off the gateway (mirrors the original
    // openai/ migration); bare ids get a vendor prefix for the gateway.
    if (modelId.startsWith('openai/')) {
      provider = 'openai'
      nextModelId = modelId.slice('openai/'.length)
    } else if (modelId.startsWith('xai/')) {
      provider = 'xai'
      nextModelId = modelId.slice('xai/'.length)
    } else if (!modelId.includes('/')) {
      nextModelId = modelId.startsWith('grok') ? `xai/${modelId}` : `openai/${modelId}`
    }
  } else if (provider === 'openai' || provider === 'openai-compatible') {
    nextModelId = modelId.startsWith('openai/') ? modelId.slice('openai/'.length) : modelId
  } else if (provider === 'xai') {
    nextModelId = modelId.startsWith('xai/') ? modelId.slice('xai/'.length) : modelId
  } else if (provider === 'cerebras') {
    nextModelId = modelId.replace(/^cerebras\//, '')
  }

  // Key vault: `apiKeys` is the per-provider source of truth once present;
  // the flat `apiKey` is derived for whichever provider ends up active.
  // Legacy records (no vault) seed it from the flat key under the provider
  // the key was originally entered for.
  const apiKeys: Partial<Record<ProviderKind, string>> = {}
  for (const providerKey of PROVIDERS) {
    const value = settings.apiKeys?.[providerKey]?.trim()
    if (value) apiKeys[providerKey] = value
  }
  const flat = settings.apiKey?.trim() ?? ''
  if (settings.apiKeys === undefined && flat && !providerWasRemoved) apiKeys[provider] = flat
  const vaultedApiKey = apiKeys[provider] ?? (provider === settings.provider ? flat : '')
  if (vaultedApiKey && apiKeys[provider] === undefined) apiKeys[provider] = vaultedApiKey
  // ChatGPT subscription requests use OAuth tokens from their dedicated store;
  // keep any existing OpenAI API key vaulted, but never expose it as the active
  // request credential while ChatGPT auth is selected.
  const apiKey = provider === 'openai' && openaiAuthMode === 'chatgpt' ? '' : vaultedApiKey

  const customInstructions = settings.customInstructions?.trim() || undefined

  // Bridge: opt-out toggle (absent = on). The port is only stored when it is a
  // real, non-default port, so the default can move without rewriting records.
  const rawPort = Number(settings.bridgePort)
  const bridgePort =
    Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65_536 && rawPort !== BRIDGE_DEFAULT_PORT
      ? rawPort
      : undefined
  const bridgeEnabled = settings.bridgeEnabled === false ? false : undefined

  // Enum with a non-absent default: unlike the opt-out booleans this stores a
  // concrete mode, so missing/unknown keys migrate to the default on load.
  const activityCursor = activityCursorMode(settings)

  return {
    ...settings,
    provider,
    openaiAuthMode,
    modelId: nextModelId,
    apiKey,
    apiKeys,
    customInstructions,
    bridgeEnabled,
    bridgePort,
    activityCursor,
    typeSafeEnabled: settings.typeSafeEnabled === true,
    typeSafeApiKey: typeof settings.typeSafeApiKey === 'string' ? settings.typeSafeApiKey.trim() || undefined : undefined,
  }
}

/** Typed read of one record's pointer mode; absent/unknown → the default. */
export function activityCursorMode(settings: Pick<Settings, 'activityCursor'>): ActivityCursorMode {
  const mode = settings.activityCursor
  return mode && ACTIVITY_CURSOR_MODES.has(mode) ? mode : DEFAULT_ACTIVITY_CURSOR
}
