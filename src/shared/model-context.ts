import { MODEL_OPTIONS, stripXaiPrioritySuffix, type Settings } from './types'

/** The routing fields that affect a model's context limit; never credentials. */
export type ContextModel = Pick<Settings, 'modelId' | 'provider' | 'openaiAuthMode' | 'anthropicAuthMode' | 'baseURL'>

export interface ContextWindow {
  tokens: number
  source: 'catalog' | 'model' | 'fallback'
}

export function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function bareModelId(modelId: string): string {
  return modelId.trim().replace(/^(openai|anthropic|xai|cerebras)\//, '')
}

export function contextModelKey(model: ContextModel): string {
  const auth = model.provider === 'openai' ? model.openaiAuthMode ?? 'api-key'
    : model.provider === 'anthropic' ? model.anthropicAuthMode ?? 'claude' : ''
  return JSON.stringify([model.provider, bareModelId(model.modelId), auth,
    model.provider === 'openai-compatible' ? model.baseURL ?? '' : ''])
}

function knownOpenAIContextWindow(modelId: string): number | undefined {
  const id = bareModelId(modelId).replace(/-\d{4}-\d{2}-\d{2}$/, '')
  // Official model specifications, checked 2026-10-06. Keep family boundaries
  // explicit so, for example, an unknown gpt-60 cannot inherit GPT-6's limit.
  if (/^gpt-(?:6-(?:sol|astra|luna)|6\.1-sol|5\.[45](?:-pro)?|5\.6-(?:sol|terra|luna))$/.test(id)) return 1_050_000
  if (/^gpt-4\.1(?:-mini|-nano)?$/.test(id)) return 1_047_576
  if (/^gpt-5(?:\.[123])?(?:-(?:mini|nano|pro|codex(?:-mini|-max)?))?$/.test(id) || /^gpt-5\.4-(?:mini|nano)$/.test(id)) return 400_000
  if (/^o1-(?:mini|preview)$/.test(id)) return 128_000
  if (/^o[134](?:-mini|-pro|-deep-research|-mini-deep-research)?$/.test(id)) return 200_000
  if (/^gpt-4o(?:-mini)?$|^gpt-4-turbo(?:-preview)?$/.test(id)) return 128_000
  return undefined
}

/** Fallbacks used only when a provider catalog isn't available. */
export function openAIContextWindow(modelId: string, authMode?: Settings['openaiAuthMode']): number {
  const id = bareModelId(modelId)
  if (authMode === 'chatgpt') return id.includes('spark') ? 128_000 : 272_000
  return knownOpenAIContextWindow(id) ?? 128_000
}

/** Shared by the request loop and meter. Unknown custom models stay unknown. */
export function defaultContextWindow(model: ContextModel): ContextWindow | undefined {
  const id = bareModelId(model.modelId)
  if (model.provider === 'openai' && model.openaiAuthMode === 'chatgpt') {
    // The account catalog is authoritative; this is only a conservative budget.
    return { tokens: openAIContextWindow(id, 'chatgpt'), source: 'fallback' }
  }
  const provider = model.provider === 'gateway'
    ? model.modelId.includes('/') ? model.modelId.split('/')[0]
      : id.startsWith('claude-') ? 'anthropic' : id.startsWith('grok') ? 'xai' : 'openai'
    : model.provider
  let tokens = MODEL_OPTIONS.find((option) => option.provider === provider && option.id === id)?.contextWindow
  if (provider === 'openai') tokens ??= knownOpenAIContextWindow(id)
  if (provider === 'anthropic') {
    if (/^claude-(?:opus-(?:5(?:-5)?|4-[678])|sonnet-(?:5(?:-5)?|4-6))(?:-latest|-\d{8})?$/.test(id)) tokens ??= 1_000_000
    if (/^claude-(?:haiku-4-5|opus-4(?:-[15])?|sonnet-4(?:-5)?|3(?:-[57])?-(?:sonnet|haiku|opus))(?:-latest|-\d{8})?$/.test(id)) tokens ??= 200_000
  }
  if (provider === 'xai' && stripXaiPrioritySuffix(id) === 'grok-4.6') tokens ??= 500_000
  if (provider === 'google' && id === 'google/gemini-3-pro') tokens ??= 1_000_000
  return tokens === undefined ? undefined : { tokens, source: 'model' }
}
