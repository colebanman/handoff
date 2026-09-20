import type { Settings } from './types'

/** Fallbacks used only when a provider catalog isn't available. */
export function openAIContextWindow(modelId: string, authMode?: Settings['openaiAuthMode']): number {
  const id = modelId.replace(/^openai\//, '')
  if (authMode === 'chatgpt') return id.includes('spark') ? 128_000 : 272_000
  if (/^gpt-(6|5\.[456])/.test(id) || /^gpt-4\.1/.test(id)) return 1_050_000
  if (/^gpt-5/.test(id)) return 400_000
  if (/^o[134]/.test(id)) return 200_000
  return 128_000
}
