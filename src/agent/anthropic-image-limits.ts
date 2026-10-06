/**
 * Request-only projection for Anthropic's image limits. Keep normal replay
 * byte-identical, but do not let accumulated screenshots break later turns.
 * https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
 */
export const CLAUDE_MAX_REQUEST_IMAGES = 20
export const CLAUDE_MAX_IMAGE_BASE64_CHARS = 10_000_000
export const CLAUDE_IMAGE_BUDGET_CHARS = 20_000_000
export const CLAUDE_MAX_REQUEST_BYTES = 32_000_000
const MAX_IMAGE_DIMENSION = 8000
const OMITTED_IMAGE = '[Earlier image omitted to fit Claude image limits. The original remains in conversation history; view the source again if needed.]'

type Block = Record<string, unknown>
function isRecord(value: unknown): value is Block {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read dimensions without recompressing or changing any image bytes. */
function imageDimensions(data: string): { width: number; height: number } | undefined {
  let bytes: string
  try { bytes = atob(data) } catch { return undefined }
  const byte = (at: number): number => bytes.charCodeAt(at)
  const be16 = (at: number): number => byte(at) * 256 + byte(at + 1)
  const le16 = (at: number): number => byte(at) + byte(at + 1) * 256
  const be32 = (at: number): number => be16(at) * 65536 + be16(at + 2)
  const le24 = (at: number): number => le16(at) + byte(at + 2) * 65536
  if (bytes.length >= 24 && bytes.slice(0, 8) === '\x89PNG\r\n\x1a\n') {
    return { width: be32(16), height: be32(20) }
  }
  if (bytes.length >= 10 && /^GIF8[79]a/.test(bytes)) {
    return { width: le16(6), height: le16(8) }
  }
  if (bytes.length >= 30 && bytes.slice(0, 4) === 'RIFF' && bytes.slice(8, 12) === 'WEBP') {
    if (bytes.slice(12, 16) === 'VP8X') return { width: le24(24) + 1, height: le24(27) + 1 }
    if (bytes.slice(12, 16) === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff }
  }
  if (bytes.length >= 25 && bytes.slice(0, 4) === 'RIFF' && bytes.slice(8, 16) === 'WEBPVP8L') {
    return {
      width: (le16(21) & 0x3fff) + 1,
      height: ((byte(22) >> 6 | byte(23) << 2 | byte(24) << 10) & 0x3fff) + 1,
    }
  }
  if (byte(0) === 0xff && byte(1) === 0xd8) {
    let at = 2
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
    while (at + 3 < bytes.length) {
      if (byte(at++) !== 0xff) break
      while (byte(at) === 0xff) at++
      const marker = byte(at++)
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      const length = be16(at)
      if (length < 2) break
      if (startOfFrame.has(marker) && at + 6 < bytes.length) {
        return { width: be16(at + 5), height: be16(at + 3) }
      }
      at += length
    }
  }
  return undefined
}

interface ImageCandidate {
  index: number
  messageIndex: number
  data?: string
  size: number
}

/**
 * Keep the newest images, replacing only old images under pressure. Images in
 * the final input message are never silently removed. Its native tool_result
 * wrappers and every tool_use id are retained. No stored messages are mutated.
 *
 * Capping at 20 also avoids the stricter dimension limit for many-image
 * requests. Twenty MB of encoded images leaves twelve MB for tools/history.
 * Claude 5.5's drop_block policy handles any signed prefix changed here.
 */
export function projectAnthropicImages(body: Block): Block {
  if (!Array.isArray(body.messages)) return body
  const messages = body.messages
  const images: ImageCandidate[] = []
  const walk = (content: unknown, messageIndex: number): void => {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'image') {
        const source = isRecord(block.source) ? block.source : undefined
        const data = source?.type === 'base64' && typeof source.data === 'string' ? source.data : undefined
        images.push({ index: images.length, messageIndex, data, size: data?.length ?? 0 })
      } else if (block.type === 'tool_result') walk(block.content, messageIndex)
    }
  }
  messages.forEach((message, index) => { if (isRecord(message)) walk(message.content, index) })
  if (!images.length) return body

  const omitted = new Set<number>()
  let imageCount = images.length
  let imageChars = images.reduce((sum, image) => sum + image.size, 0)
  const fresh = (image: ImageCandidate): boolean => image.messageIndex === messages.length - 1
  const omit = (image: ImageCandidate): void => {
    if (omitted.has(image.index)) return
    omitted.add(image.index)
    imageCount--
    imageChars -= image.size
  }
  for (const image of images) {
    if (image.size > CLAUDE_MAX_IMAGE_BASE64_CHARS) {
      if (fresh(image)) throw new Error('This image exceeds Claude’s 10 MB encoded-image limit. Resize or compress it before sending it again.')
      omit(image)
    }
  }
  for (const image of images) {
    if (imageCount <= CLAUDE_MAX_REQUEST_IMAGES && imageChars <= CLAUDE_IMAGE_BUDGET_CHARS) break
    if (!fresh(image)) omit(image)
  }
  if (imageCount > CLAUDE_MAX_REQUEST_IMAGES || imageChars > CLAUDE_IMAGE_BUDGET_CHARS) {
    throw new Error('The latest input has too many or too-large images for Claude. Send at most 20 images totaling under 20 MB encoded, or resize them first.')
  }
  // Inspect only retained images, after bounding their aggregate decode size.
  for (const image of images) {
    if (omitted.has(image.index) || !image.data) continue
    const dimensions = imageDimensions(image.data)
    if (dimensions && Math.max(dimensions.width, dimensions.height) > MAX_IMAGE_DIMENSION) {
      if (fresh(image)) throw new Error('This image exceeds Claude’s 8000-pixel dimension limit. Resize it before sending it again.')
      omit(image)
    }
  }
  if (!omitted.size) return body

  let imageIndex = 0
  const rewrite = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content
    let changed = false
    const result = content.map((block) => {
      if (!isRecord(block)) return block
      if (block.type === 'image') {
        if (!omitted.has(imageIndex++)) return block
        changed = true
        return { type: 'text', text: OMITTED_IMAGE, ...(block.cache_control ? { cache_control: block.cache_control } : {}) }
      }
      if (block.type === 'tool_result') {
        const nested = rewrite(block.content)
        if (nested !== block.content) { changed = true; return { ...block, content: nested } }
      }
      return block
    })
    return changed ? result : content
  }
  return { ...body, messages: messages.map((message) => {
    if (!isRecord(message)) return message
    const content = rewrite(message.content)
    return content === message.content ? message : { ...message, content }
  }) }
}
