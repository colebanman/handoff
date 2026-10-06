/**
 * Request-time workaround for providers that cannot carry media in tool
 * results.
 *
 * The installed xAI Responses adapter emits string `function_call_output`;
 * it converts `content`-typed tool outputs by concatenating the text
 * items and mapping media items to '' — so a screenshot tool result would
 * silently reach grok as an empty string. `inlineMediaToolResults` rewrites
 * request copies: each image media item in a tool result becomes a text
 * pointer, and the image itself is re-delivered as a user message inserted
 * right after the tool message (xAI supports images in user messages as
 * data-URL `input_image`). Non-image media (e.g. raw PDF bytes) has no inline
 * path at all on xAI and is replaced with an explanatory text stub.
 *
 * Applied per step via `prepareStep`, on request copies only — persisted
 * history keeps the original media outputs, so switching the chat back to a
 * media-capable provider restores native delivery.
 * Provider contracts: https://developers.openai.com/api/docs/guides/function-calling
 * https://docs.x.ai/developers/model-capabilities/images/understanding
 * https://inference-docs.cerebras.ai/capabilities/image-inputs
 */

import type { ModelMessage, ToolResultPart, UserModelMessage } from 'ai'
import type { ProviderKind } from '../shared/types'

/** Transport capability, not whether the model has vision. Keep OpenAI
 * Responses' native image/file tool outputs and Gateway's structured outputs;
 * Chat Completions tool messages cannot carry image content parts. */
export function supportsMediaToolResults(provider: ProviderKind, modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  switch (provider) {
    case 'anthropic': return true // Messages supports native image/document tool_result blocks.
    case 'openai': return true // Platform and ChatGPT both use Responses.
    case 'openai-compatible': // @ai-sdk/openai.chat serializes tool media as JSON text.
    case 'cerebras': // Chat Completions: images belong in user content.
    case 'xai': return false // Responses adapter otherwise drops tool images.
    case 'gateway': return !id.startsWith('xai/')
  }
}

interface InlinedImage {
  toolCallId: string
  data: string
  mediaType: string
}

/**
 * Returns `messages` unchanged (same reference) when no tool result contains
 * media; otherwise a rewritten copy as described in the module comment.
 */
export function inlineMediaToolResults(messages: ModelMessage[]): ModelMessage[] {
  let changed = false
  const out: ModelMessage[] = []
  const pendingImages: InlinedImage[] = []
  const flushImages = () => {
    if (!pendingImages.length) return
    out.push({
      role: 'user',
      content: pendingImages.flatMap((img) => [
        { type: 'text' as const, text: `Image output of tool call ${img.toolCallId}:` },
        { type: 'image' as const, image: img.data, mediaType: img.mediaType },
      ]),
    } satisfies UserModelMessage)
    pendingImages.length = 0
  }

  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      // Parallel calls can have separate adjacent tool messages. Chat
      // Completions needs ALL their replies before the next user message.
      flushImages()
      out.push(message)
      continue
    }

    const images: InlinedImage[] = []
    let messageChanged = false
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result' || part.output.type !== 'content') return part
      if (!part.output.value.some((item) => item.type === 'media')) return part
      messageChanged = true
      const value = part.output.value.map((item) => {
        if (item.type !== 'media') return item
        if (item.mediaType.startsWith('image/')) {
          images.push({ toolCallId: part.toolCallId, data: item.data, mediaType: item.mediaType })
          return {
            type: 'text' as const,
            text: '[Image output: attached as an image in the user message after these tool results.]',
          }
        }
        return {
          type: 'text' as const,
          text: `[Media output of type ${item.mediaType} omitted: this transport cannot deliver native non-image tool files. Use filesystem_view with mode:"text" or, for PDFs, mode:"pdf-page" to inspect the content.]`,
        }
      })
      return { ...part, output: { ...part.output, value } } satisfies ToolResultPart
    })

    if (!messageChanged) {
      out.push(message)
      continue
    }

    changed = true
    out.push({ ...message, content })
    pendingImages.push(...images)
  }
  flushImages()

  return changed ? out : messages
}
