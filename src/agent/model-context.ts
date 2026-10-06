import { throwIfAborted } from '../shared/abort'
import { defaultContextWindow, bareModelId, validTokenCount, type ContextModel, type ContextWindow } from '../shared/model-context'
import { listChatGPTModels } from './openai-chatgpt-oauth'

/** Resolve limits for the actual transport, never a different provider's catalog. */
export async function resolveContextWindow(model: ContextModel, signal?: AbortSignal): Promise<ContextWindow | undefined> {
  const fallback = defaultContextWindow(model)
  try {
    throwIfAborted(signal)
    if (model.provider === 'openai' && model.openaiAuthMode === 'chatgpt') {
      const entry = (await listChatGPTModels(false, signal)).find((entry) => entry.id === bareModelId(model.modelId))
      if (validTokenCount(entry?.contextWindow) && entry.contextWindow > 0) {
        return { tokens: entry.contextWindow, source: 'catalog' }
      }
    } else if (model.provider === 'gateway') {
      const id = model.modelId.trim()
      const qualified = id.includes('/') ? id : `${id.startsWith('claude-') ? 'anthropic' : id.startsWith('grok') ? 'xai' : 'openai'}/${id}`
      const [creator, ...parts] = qualified.split('/')
      const response = await fetch(`https://ai-gateway.vercel.sh/v1/models/${encodeURIComponent(creator!)}/${encodeURIComponent(parts.join('/'))}/endpoints`, {
        signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]),
      })
      if (response.ok) {
        const body = await response.json() as { data?: { endpoints?: Array<{ context_length?: number; status?: number }> } }
        const endpoints = body.data?.endpoints ?? []
        const active = endpoints.filter((endpoint) => endpoint.status === 0)
        const lengths = (active.length ? active : endpoints).map((entry) => entry.context_length)
          .filter((value): value is number => validTokenCount(value) && value > 0)
        // The gateway may route to any active endpoint. Only promise a window
        // every candidate supports, not the largest window advertised by one.
        if (lengths.length) return { tokens: Math.min(...lengths), source: 'catalog' }
      }
    }
  } catch {
    throwIfAborted(signal)
    // Catalog outages must not prevent inference or blank a known model limit.
  }
  return fallback
}
