/** Shared tool result formats. */
export interface ToolResultError { code?: string; message: string }

export function toolResultError(output: unknown): ToolResultError | undefined {
  if (typeof output === 'string') {
    const match = /^Error(?:\s*\[([^\]]+)\]\s*:?|:)\s*([\s\S]*)/.exec(output)
    return match ? { ...(match[1] ? { code: match[1] } : {}), message: match[2] || 'Tool failed' } : undefined
  }
  if (!output || typeof output !== 'object') return undefined
  const result = output as Record<string, unknown>
  if (!result.error && result.ok !== false && result.isError !== true) return undefined
  const error = result.error && typeof result.error === 'object'
    ? result.error as Record<string, unknown> : result
  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    message: typeof result.error === 'string' ? result.error
      : typeof error.message === 'string' ? error.message : 'Tool failed',
  }
}

export function toolResultImage(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined
  const result = output as Record<string, unknown>
  const mediaType = result.mediaType ?? result.mimeType ?? 'image/png'
  if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) return undefined
  const data = result.base64 ?? result.data
  if (typeof data !== 'string' || !data) return undefined
  // Generic data requires an explicit image type; generic text data is not an image.
  if (!result.base64 && !result.mimeType && !result.mediaType) return undefined
  return data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`
}
