import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { abortable, throwIfAborted } from '../shared/abort'
import type { VfsRenderedPage } from '../shared/types'

// Static imports keep the module and worker version matched across rebuilds.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
const PDF_TIMEOUT_MS = 30_000

async function withPdf<T>(
  blob: Blob,
  signal: AbortSignal | undefined,
  use: (doc: pdfjs.PDFDocumentProxy, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController()
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  throwIfAborted(combined)
  const timer = setTimeout(() => deadline.abort(new Error('PDF processing timed out after 30 seconds. Try another page or view the file directly.')), PDF_TIMEOUT_MS)
  let task: ReturnType<typeof pdfjs.getDocument> | undefined
  try {
    const bytes = new Uint8Array(await abortable(blob.arrayBuffer(), combined))
    throwIfAborted(combined)
    task = pdfjs.getDocument({ data: bytes })
    const doc = await abortable(task.promise, combined)
    return await abortable(use(doc, combined), combined)
  } finally {
    clearTimeout(timer)
    // Loading can fail or stall too. Always destroy its worker, and never
    // block cancellation on another response from the same stalled worker.
    void task?.destroy().catch(() => {})
  }
}

export function extractPdfText(blob: Blob, signal?: AbortSignal): Promise<string> {
  return withPdf(blob, signal, async (doc, activeSignal) => {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i += 1) {
      throwIfAborted(activeSignal)
      const page = await abortable(doc.getPage(i), activeSignal)
      const content = await abortable(page.getTextContent(), activeSignal)
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim()
      pages.push(`Page ${i}\n${text}`)
    }
    return pages.join('\n\n')
  })
}

export function renderPdfPage(blob: Blob, pageNumber: number, scale: number, signal?: AbortSignal): Promise<Omit<VfsRenderedPage, 'path'>> {
  return withPdf(blob, signal, async (doc, activeSignal) => {
    const page = await abortable(doc.getPage(pageNumber), activeSignal)
    throwIfAborted(activeSignal)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    // Display intent waits on requestAnimationFrame, which is suspended in
    // Chrome's hidden offscreen document. Print intent renders immediately.
    const render = page.render({ canvasContext: ctx, canvas, viewport, intent: 'print' })
    try {
      await abortable(render.promise, activeSignal)
      const [, base64 = ''] = canvas.toDataURL('image/png').split(',', 2)
      return { page: pageNumber, mediaType: 'image/png', base64, width: canvas.width, height: canvas.height }
    } finally {
      render.cancel()
      canvas.width = canvas.height = 0
    }
  })
}
