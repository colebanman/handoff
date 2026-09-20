/**
 * Request-time workaround for providers that cannot carry media in tool
 * results.
 *
 * xAI's Responses API only accepts strings as `function_call_output`;
 * @ai-sdk/xai converts `content`-typed tool outputs by concatenating the text
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
 */

import type { ModelMessage, ToolResultPart, UserModelMessage } from 'ai'
import type { ProviderKind } from '../shared/types'

/** Whether tool results may carry media for this provider/model. */
export function supportsMediaToolResults(provider: ProviderKind, modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  // Cerebras Chat Completions also requires screenshots in user image parts.
  return !(provider === 'cerebras' || provider === 'xai' || (provider === 'gateway' && id.startsWith('xai/')))
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

  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
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
            text: '[Image output: attached as an image in the user message that follows this tool result.]',
          }
        }
        return {
          type: 'text' as const,
          text: `[Media output of type ${item.mediaType} omitted: the current model cannot receive non-image files from tools.]`,
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
    if (images.length > 0) {
      const userMessage: UserModelMessage = {
        role: 'user',
        content: images.flatMap((img) => [
          { type: 'text', text: `Image output of tool call ${img.toolCallId}:` },
          { type: 'image', image: img.data, mediaType: img.mediaType },
        ]),
      }
      out.push(userMessage)
    }
  }

  return changed ? out : messages
}
