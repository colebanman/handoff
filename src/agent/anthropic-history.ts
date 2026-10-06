import type { ModelMessage } from 'ai'

/** Claude 5.5 signs the complete prefix, including old tool results/images.
 * Keep canonical history append-only even after switching away and back. */
export function preserveAnthropicHistory(modelId: string, messages: ModelMessage[]): boolean {
  if (/^(?:anthropic\/)?claude-(?:opus|sonnet)-5-5(?:-|$)/.test(modelId)) return true
  return messages.some((message) => message.role === 'assistant' && Array.isArray(message.content) &&
    message.content.some((part) => part.type === 'reasoning' && Boolean(
      part.providerOptions?.anthropic?.signature || part.providerOptions?.anthropic?.redactedData,
    )))
}
