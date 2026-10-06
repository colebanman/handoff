import { MODEL_OPTIONS, type CuratedModelProvider, type Settings } from './types'

/** Credential-filtered groups shared by both composer form factors. */
export function modelPickerProviders(s: Settings, chatgptConnected: boolean, claudeConnected = false): CuratedModelProvider[] {
  const local: CuratedModelProvider[] = MODEL_OPTIONS.some((m) => m.baseURL) ? ['openai-compatible'] : []
  const cerebras: CuratedModelProvider[] = s.apiKeys?.cerebras?.trim() || (s.provider === 'cerebras' && s.apiKey.trim()) ? ['cerebras'] : []
  const anthropicReady = (s.anthropicAuthMode ?? 'claude') === 'claude'
    ? claudeConnected
    : Boolean(s.apiKeys?.anthropic?.trim() || (s.provider === 'anthropic' && s.apiKey.trim()))
  const anthropic: CuratedModelProvider[] = anthropicReady ? ['anthropic'] : []
  if (s.provider === 'gateway') return ['openai', 'xai', 'anthropic', ...cerebras, ...local]
  if (s.provider === 'openai-compatible') return ['openai', 'xai', ...anthropic, ...cerebras, ...local]
  const out: CuratedModelProvider[] = []
  const openaiReady = (s.openaiAuthMode ?? 'api-key') === 'chatgpt'
    ? chatgptConnected || Boolean(s.apiKeys?.openai?.trim())
    : Boolean(s.apiKeys?.openai?.trim() || (s.provider === 'openai' && s.apiKey.trim()))
  if (openaiReady) out.push('openai')
  if (s.apiKeys?.xai?.trim() || (s.provider === 'xai' && s.apiKey.trim())) out.push('xai')
  return [...out, ...anthropic, ...cerebras, ...local]
}
