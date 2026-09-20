import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ ...fake, GlobalWorkerOptions: {} }))
import { extractPdfText, renderPdfPage } from './pdf'

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('renders when animation frames are unavailable in the hidden document', async () => {
  const cancel = vi.fn()
  const destroy = vi.fn(async () => {})
  const render = vi.fn(({ intent }) => ({
    promise: intent === 'print' ? Promise.resolve() : new Promise<void>(() => {}), cancel,
  }))
  fake.getDocument.mockReturnValue({ destroy, promise: Promise.resolve({
    getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }), render }),
  }) })
  const canvas = { width: 0, height: 0, getContext: () => ({}), toDataURL: () => 'data:image/png;base64,pixels' }
  vi.stubGlobal('document', { createElement: () => canvas })
  const result = await renderPdfPage(new Blob(['pdf']), 1, 1.5)
  expect(result).toEqual({ page: 1, mediaType: 'image/png', base64: 'pixels', width: 600, height: 800 })
  expect(destroy).toHaveBeenCalledOnce()
  expect(canvas.width).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds a stalled PDF load and destroys its worker', async () => {
  const destroy = vi.fn(async () => {})
  fake.getDocument.mockReturnValue({ destroy, promise: new Promise(() => {}) })
  const result = extractPdfText(new Blob(['pdf']))
  const rejected = expect(result).rejects.toThrow('PDF processing timed out')
  await vi.advanceTimersByTimeAsync(30_000)
  await rejected
  expect(destroy).toHaveBeenCalledOnce()
})

it('cancels a stalled render promptly and allows a subsequent PDF to load', async () => {
  const destroy = vi.fn(async () => {})
  const cancel = vi.fn()
  const render = vi.fn(() => ({ promise: new Promise<void>(() => {}), cancel }))
  fake.getDocument.mockReturnValue({ destroy, promise: Promise.resolve({
    getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }), render }),
  }) })
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({}), width: 0, height: 0 }) })
  const controller = new AbortController()
  const result = renderPdfPage(new Blob(['pdf']), 1, 1, controller.signal)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  expect(render).toHaveBeenCalledOnce()
  controller.abort()
  await rejected
  expect(cancel).toHaveBeenCalledOnce()
  expect(destroy).toHaveBeenCalledOnce()
  fake.getDocument.mockReturnValue({ destroy, promise: Promise.resolve({ numPages: 0 }) })
  await expect(extractPdfText(new Blob(['next']))).resolves.toBe('')
})
