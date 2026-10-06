import { describe, expect, it } from 'vitest'
import { projectAnthropicImages, CLAUDE_MAX_IMAGE_BASE64_CHARS } from './anthropic-image-limits'

const image = (data = 'AQID') => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })
const user = (content: unknown[]) => ({ role: 'user', content })
const imageCount = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((count, item) => count + imageCount(item), 0)
  if (!value || typeof value !== 'object') return 0
  const record = value as Record<string, unknown>
  if (record.type === 'image') return 1
  return Object.values(record).reduce<number>((count, item) => count + imageCount(item), 0)
}
const png = (width: number, height: number): string => {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return btoa(String.fromCharCode(...bytes))
}

describe('Claude request image limits', () => {
  it('preserves ordinary image bytes, signatures, cache markers and object identity', () => {
    const body = { system: [{ type: 'text', text: 'System' }], messages: [
      user([{ ...image(png(4000, 2400)), cache_control: { type: 'ephemeral' } }]),
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'signed' }, { type: 'text', text: 'Done' }] },
      user([{ type: 'text', text: 'Continue' }]),
    ] }
    expect(projectAnthropicImages(body)).toBe(body)
  })

  it('replaces only the oldest image over the twenty-image limit and keeps native tool ids intact', () => {
    const firstImage = { ...image('AAAB'), cache_control: { type: 'ephemeral' } }
    const body = { messages: [
      user([{ type: 'tool_result', tool_use_id: 'old-shot', content: [firstImage, { type: 'text', text: 'File /old.png' }] }]),
      ...Array.from({ length: 19 }, () => user([image()])),
      user([{ type: 'tool_result', tool_use_id: 'fresh-shot', content: [image('BAUG')] }]),
    ] }
    const before = JSON.stringify(body)
    const projected = projectAnthropicImages(body)
    expect(imageCount(projected)).toBe(20)
    expect(projected.messages).toMatchObject([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-shot', content: [
        { type: 'text', text: expect.stringContaining('Earlier image omitted'), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'File /old.png' },
      ] }] },
      ...body.messages.slice(1),
    ])
    expect(JSON.stringify(body)).toBe(before)
    expect(projectAnthropicImages(body)).toEqual(projected)
    expect(projectAnthropicImages(projected)).toBe(projected)
  })

  it('bounds encoded bytes independently of image count and keeps newest media', () => {
    const large = 'A'.repeat(9_000_000)
    const body = { messages: [user([image(large)]), user([image(large)]), user([image(large)])] }
    const projected = projectAnthropicImages(body)
    expect(imageCount(projected)).toBe(2)
    expect((projected.messages as unknown[]).slice(1)).toEqual(body.messages.slice(1))
    expect(imageCount(body)).toBe(3)
  })

  it('counts URL images, but never downloads or changes the URLs of retained images', () => {
    const body = { messages: Array.from({ length: 22 }, (_, index) => user([
      { type: 'image', source: { type: 'url', url: `https://example.com/${index}.png` } },
    ])) }
    const projected = projectAnthropicImages(body)
    expect(imageCount(projected)).toBe(20)
    expect((projected.messages as unknown[]).slice(2)).toEqual(body.messages.slice(2))
  })

  it('never silently drops an oversized current input or too many fresh images', () => {
    expect(() => projectAnthropicImages({ messages: [user([image('A'.repeat(CLAUDE_MAX_IMAGE_BASE64_CHARS + 1))])] })).toThrow(/10 MB/)
    expect(() => projectAnthropicImages({ messages: [user([image(png(8001, 800))])] })).toThrow(/8000-pixel/)
    expect(() => projectAnthropicImages({ messages: [user(Array.from({ length: 21 }, () => image()))] })).toThrow(/latest input/)
    expect(() => projectAnthropicImages({ messages: [user([{ type: 'tool_result', tool_use_id: 'new-images', content: Array.from({ length: 21 }, () => image()) }])] })).toThrow(/latest input/)
  })

  it('can omit an incompatible earlier image while keeping the fresh input', () => {
    const body = { messages: [user([image(png(9000, 1000))]), user([image(png(1000, 1000))])] }
    const projected = projectAnthropicImages(body)
    expect(imageCount(projected)).toBe(1)
    expect((projected.messages as unknown[])[1]).toBe(body.messages[1])
    expect(imageCount(body)).toBe(2)
  })

  it('reads JPEG and GIF dimensions as well as PNG before sending oversized images', () => {
    const jpegHeader = btoa(String.fromCharCode(255, 216, 255, 192, 0, 17, 8, 0, 100, 35, 40, 3, 1, 17, 0)) // 9000x100
    const gifHeader = btoa('GIF89a' + String.fromCharCode(40, 35, 100, 0)) // 9000x100
    for (const data of [jpegHeader, gifHeader]) {
      expect(() => projectAnthropicImages({ messages: [user([image(data)])] })).toThrow(/8000-pixel/)
    }
  })
})
