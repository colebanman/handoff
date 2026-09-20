import { MODEL_OPTIONS, type CuratedModelProvider, type Settings } from './types'

/** Credential-filtered groups shared by both composer form factors. */
export function modelPickerProviders(s: Settings, chatgptConnected: boolean): CuratedModelProvider[] {
  const local: CuratedModelProvider[] = MODEL_OPTIONS.some((m) => m.baseURL) ? ['openai-compatible'] : []
  const cerebras: CuratedModelProvider[] = s.apiKeys?.cerebras?.trim() || (s.provider === 'cerebras' && s.apiKey.trim()) ? ['cerebras'] : []
  if (s.provider === 'gateway' || s.provider === 'openai-compatible') return ['openai', 'xai', ...cerebras, ...local]
  const out: CuratedModelProvider[] = []
  const openaiReady = (s.openaiAuthMode ?? 'api-key') === 'chatgpt'
    ? chatgptConnected || Boolean(s.apiKeys?.openai?.trim())
    : Boolean(s.apiKeys?.openai?.trim() || (s.provider === 'openai' && s.apiKey.trim()))
  if (openaiReady) out.push('openai')
  if (s.apiKeys?.xai?.trim() || (s.provider === 'xai' && s.apiKey.trim())) out.push('xai')
  return [...out, ...cerebras, ...local]
}
