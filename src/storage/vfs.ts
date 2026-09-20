import type {
  VfsBytesResult,
  VfsEntry,
  VfsHtmlResult,
  VfsLineResult,
  VfsRenderedPage,
  VfsRoot,
  VfsSkillMetadata,
  VfsSummary,
  VfsTextResult,
  VirtualFileSystemService,
} from '../shared/types'
import { debugLog } from '../shared/debug-log'
import { findSecrets, redactSecrets } from '../shared/redact'
import { extractPdfText, renderPdfPage } from './pdf'
import * as mammothRaw from 'mammoth'
import { throwIfAborted } from '../shared/abort'
import { EXTENSIONS_STORE, extensionRequest, upgradeExtensions } from './extensions'
import { emitVfsChange } from './vfs-changes'

const DB_NAME = 'handoff-vfs'
const DB_VERSION = 3
const STORE = 'files'
const DEFAULT_TEXT_CHARS = 100_000
const DEFAULT_LINE_COUNT = 120
const DEFAULT_BYTE_LENGTH = 1_000_000
const DEFAULT_IMPORT_MAX_BYTES = 50_000_000
const IMPORT_TIMEOUT_MS = 60_000

interface StoredFile extends VfsEntry {
  blob: Blob
}

interface MammothModule {
  extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>
  convertToHtml(input: { arrayBuffer: ArrayBuffer }, opts?: { includeDefaultStyleMap?: boolean }): Promise<{
    value: string
    messages: Array<{ type?: string; message?: string }>
  }>
}

const mammothMod = mammothRaw as unknown as MammothModule | { default: MammothModule }
const mammoth = 'default' in mammothMod ? mammothMod.default : mammothMod

export { subscribeVfsChanges, type VfsChange } from './vfs-changes'

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(EXTENSIONS_STORE)) db.createObjectStore(EXTENSIONS_STORE, { keyPath: 'key' })
      else upgradeExtensions(req.transaction!)
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'path' })
      }
    }
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = undefined }
      resolve(req.result)
    }
    req.onerror = () => reject(req.error ?? new Error('failed to open virtual filesystem database'))
  })
  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<IDBRequest<T>>,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const store = tx.objectStore(STORE)
    let req: IDBRequest<T> | undefined
    tx.oncomplete = () => {
      if (req) resolve(req.result)
      else resolve(undefined as T)
    }
    tx.onerror = () => reject(tx.error ?? new Error('virtual filesystem transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('virtual filesystem transaction aborted'))
    void Promise.resolve(fn(store))
      .then((r) => {
        req = r
      })
      .catch((err) => {
        tx.abort()
        reject(err)
      })
  })
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('virtual filesystem request failed'))
  })
}

function normalizeRoot(root: VfsRoot): VfsRoot {
  if (root !== 'skills' && root !== 'workspace') throw new Error(`unknown filesystem root "${root}"`)
  return root
}

function sanitizeSegment(segment: string): string {
  return segment
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
}

function normalizePath(root: VfsRoot, relativePath: string): string {
  const rel = sanitizeSegment(relativePath)
  if (!rel) throw new Error('file path is empty')
  return `/${normalizeRoot(root)}/${rel}`
}

function rootFromPath(path: string): VfsRoot {
  if (path.startsWith('/skills/')) return 'skills'
  if (path.startsWith('/workspace/')) return 'workspace'
  throw new Error(`path must start with /skills/ or /workspace/: ${path}`)
}

function nameFromPath(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function inferMediaTypeFromPath(path: string, provided?: string): string {
  if (provided) return provided
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.html')) return 'text/html'
  if (lower.endsWith('.css')) return 'text/css'
  if (lower.endsWith('.js') || lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'text/plain'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

function inferMediaType(file: File, path: string): string {
  return inferMediaTypeFromPath(path, file.type)
}

function normalizeAbsolutePath(path: string): { root: VfsRoot; relativePath: string; path: string } {
  const root = rootFromPath(path)
  const prefix = `/${root}/`
  const relativePath = sanitizeSegment(path.slice(prefix.length))
  if (!relativePath) throw new Error('file path is empty')
  return { root, relativePath, path: normalizePath(root, relativePath) }
}

function normalizeSkillName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
  if (!normalized) throw new Error('skill name must contain at least one letter or digit')
  return normalized
}

function fallbackSkillNameFromPath(path: string): string {
  if (/\/SKILL\.md$/i.test(path)) return path.split('/').at(-2) || 'skill'
  return nameFromPath(path).replace(/\.[^.]+$/i, '') || 'skill'
}

function isMarkdownPath(path: string): boolean {
  return /\.md(?:own)?$/i.test(path) || /\.markdown$/i.test(path)
}

function isSkillMarkdownEntry(entry: VfsEntry): boolean {
  if (entry.root !== 'skills') return false
  if (/^\/skills\/[^/]+\/SKILL\.md$/i.test(entry.path)) return true
  return /^\/skills\/[^/]+\.md(?:own)?$/i.test(entry.path) || /^\/skills\/[^/]+\.markdown$/i.test(entry.path)
}

function shouldNormalizeSkillUpload(relativePath: string): boolean {
  const rel = sanitizeSegment(relativePath)
  return Boolean(rel && !rel.includes('/') && isMarkdownPath(rel))
}

function base64ToBytes(value: string): Uint8Array {
  const base64 = value.startsWith('data:') ? value.split(',', 2)[1] ?? '' : value
  const clean = base64.replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Filename for a downloaded URL: Content-Disposition beats the URL path. */
function filenameFromImport(res: Response, url: URL): string {
  const disposition = res.headers.get('content-disposition') ?? ''
  const star = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(disposition)
  if (star) {
    try {
      const name = sanitizeSegment(decodeURIComponent((star[1] ?? '').trim().replace(/^"|"$/g, '')))
      if (name) return nameFromPath(name)
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)
  if (plain) {
    const name = sanitizeSegment((plain[1] ?? '').trim())
    if (name) return nameFromPath(name)
  }
  const last = url.pathname.split('/').filter(Boolean).at(-1)
  if (last) {
    try {
      const name = sanitizeSegment(decodeURIComponent(last))
      if (name) return nameFromPath(name)
    } catch {
      const name = sanitizeSegment(last)
      if (name) return nameFromPath(name)
    }
  }
  return 'download'
}

function skillMarkdown(name: string, description: string, body?: string): string {
  const trimmed = body?.trim()
  if (trimmed?.startsWith('---')) return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
  const heading = body?.trim() ? `\n${body.trim()}\n` : `\n# ${name}\n\nUse this skill when it is relevant to the user request.\n`
  return `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ').trim()}\n---\n${heading}`
}

function isPlainText(entry: VfsEntry): boolean {
  if (entry.mediaType.startsWith('text/')) return true
  return [
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'image/svg+xml',
  ].includes(entry.mediaType)
}

function isPdf(entry: VfsEntry): boolean {
  return entry.mediaType === 'application/pdf' || entry.path.toLowerCase().endsWith('.pdf')
}

function isDocx(entry: VfsEntry): boolean {
  return (
    entry.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    entry.path.toLowerCase().endsWith('.docx')
  )
}

function isHtml(entry: VfsEntry): boolean {
  const lower = entry.path.toLowerCase()
  return entry.mediaType === 'text/html' || lower.endsWith('.html') || lower.endsWith('.htm')
}

function truncateText(path: string, text: string, offset = 0, maxChars = DEFAULT_TEXT_CHARS): VfsTextResult {
  const safeOffset = Math.max(0, Math.min(offset, text.length))
  const safeMax = Math.max(1, maxChars)
  const sliced = text.slice(safeOffset, safeOffset + safeMax)
  return {
    path,
    text: sliced,
    truncated: safeOffset + safeMax < text.length,
    totalChars: text.length,
  }
}

function parseYamlString(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseSkillMarkdown(path: string, markdown: string, updatedAt: number): VfsSkillMetadata {
  const fallbackName = fallbackSkillNameFromPath(path)
  let name = fallbackName
  let description = ''
  let shortDescription: string | undefined

  if (markdown.startsWith('---')) {
    const end = markdown.indexOf('\n---', 3)
    if (end !== -1) {
      const frontmatter = markdown.slice(3, end).split(/\r?\n/)
      let inMetadata = false
      for (const raw of frontmatter) {
        const line = raw.replace(/\r$/, '')
        if (!line.trim()) continue
        const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
        if (top) {
          inMetadata = top[1] === 'metadata'
          if (top[1] === 'name') name = parseYamlString(top[2] ?? '') || name
          if (top[1] === 'description') description = parseYamlString(top[2] ?? '')
          continue
        }
        if (inMetadata) {
          const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
          if (nested && nested[1] === 'short-description') {
            shortDescription = parseYamlString(nested[2] ?? '') || undefined
          }
        }
      }
    }
  }

  if (!description) {
    const firstParagraph = markdown
      .replace(/^---[\s\S]*?\n---/, '')
      .split(/\n\s*\n/)
      .map((s) => s.replace(/^#+\s*/, '').trim())
      .find(Boolean)
    description = firstParagraph?.slice(0, 240) || 'No description provided.'
  }

  const rootPath = path.replace(/\/[^/]+$/, '')
  return { name, description, shortDescription, path, rootPath, updatedAt }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await blobToDataUrl(blob)
  const [, base64 = ''] = dataUrl.split(',', 2)
  return base64
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'))
    reader.readAsDataURL(blob)
  })
}

async function extractDocxText(blob: Blob): Promise<string> {
  const result = await mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() })
  return result.value
}

async function extractDocxHtml(blob: Blob): Promise<{ html: string; messages: string[] }> {
  const result = await mammoth.convertToHtml(
    { arrayBuffer: await blob.arrayBuffer() },
    { includeDefaultStyleMap: true },
  )
  return {
    html: result.value,
    messages: result.messages.map((message) => message.message || message.type || '').filter(Boolean),
  }
}

class IndexedDbVirtualFileSystem implements VirtualFileSystemService {
  async extensions(operation: string, input?: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> {
    const result = await extensionRequest(await openDb(), operation, input, opts?.signal)
    if (!['list', 'get', 'resolve', 'draft'].includes(operation) && (operation !== 'settings' || typeof (input as { learningEnabled?: unknown } | undefined)?.learningEnabled === 'boolean')) emitVfsChange({ path: '/skills', action: 'write', at: Date.now() })
    return result
  }

  async list(root?: VfsRoot): Promise<VfsEntry[]> {
    const files = await this.allFiles()
    return files
      .filter((entry) => !root || entry.root === root)
      .map(stripBlob)
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  async summary(): Promise<VfsSummary> {
    const [entries, skills] = await Promise.all([this.list(), this.skills()])
    return { entries, skills }
  }

  async skills(): Promise<VfsSkillMetadata[]> {
    const files = await this.allFiles()
    const skillFiles = files.filter(isSkillMarkdownEntry)
    const skills = await Promise.all(
      skillFiles.map(async (entry) => parseSkillMarkdown(entry.path, await entry.blob.text(), entry.updatedAt)),
    )
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  async putFile(root: VfsRoot, file: File, relativePath?: string): Promise<VfsEntry> {
    let rel = relativePath || (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    if (root === 'skills' && shouldNormalizeSkillUpload(rel)) {
      const text = await file.text()
      const metadata = parseSkillMarkdown(`/skills/${sanitizeSegment(rel)}`, text, Date.now())
      rel = `${normalizeSkillName(metadata.name || fallbackSkillNameFromPath(rel))}/SKILL.md`
    }

    const path = normalizePath(root, rel)
    const record = await this.putBlob(path, file, inferMediaType(file, path))
    debugLog.log('storage', 'vfs put file', { path, size: file.size, mediaType: record.mediaType })
    return record
  }

  async writeText(path: string, text: string, opts?: { mediaType?: string; signal?: AbortSignal }): Promise<VfsEntry> {
    throwIfAborted(opts?.signal)
    const normalized = normalizeAbsolutePath(path)
    const mediaType = inferMediaTypeFromPath(normalized.path, opts?.mediaType)
    let body = text
    let redactionWarning: string | undefined
    if (normalized.root === 'skills') {
      const matches = findSecrets(text)
      if (matches.length > 0) {
        body = redactSecrets(text)
        const kinds = [...new Set(matches.map((m) => m.kind))].join(', ')
        redactionWarning = `Blocked ${matches.length} secret-like string(s) (${kinds}) from being saved to ${normalized.path} — replaced with [redacted:...] placeholders. Skill files persist across chats; if this skill genuinely needs a credential, have the user store it via Settings instead of hardcoding it here.`
        debugLog.log('storage', 'vfs redacted skill write', { path: normalized.path, kinds, count: matches.length })
      }
    }
    const blob = new Blob([body], { type: mediaType })
    const entry = await this.putBlob(normalized.path, blob, mediaType, opts?.signal)
    debugLog.log('storage', 'vfs write text', { path: entry.path, size: entry.size, mediaType: entry.mediaType })
    return redactionWarning ? { ...entry, redactionWarning } : entry
  }

  async writeBase64(path: string, base64: string, opts?: { mediaType?: string; signal?: AbortSignal }): Promise<VfsEntry> {
    throwIfAborted(opts?.signal)
    const normalized = normalizeAbsolutePath(path)
    const mediaType = inferMediaTypeFromPath(normalized.path, opts?.mediaType)
    const bytes = base64ToBytes(base64)
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    const blob = new Blob([buffer], { type: mediaType })
    const entry = await this.putBlob(normalized.path, blob, mediaType, opts?.signal)
    debugLog.log('storage', 'vfs write base64', { path: entry.path, size: entry.size, mediaType: entry.mediaType })
    return entry
  }

  async importUrl(url: string, opts?: { path?: string; maxBytes?: number; signal?: AbortSignal }): Promise<VfsEntry> {
    throwIfAborted(opts?.signal)
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`importUrl only supports http(s) URLs, got "${parsed.protocol}"`)
    }
    const maxBytes = Math.max(1, opts?.maxBytes ?? DEFAULT_IMPORT_MAX_BYTES)
    // credentials:'include' sends the browser's session cookies, so files that
    // are login-gated (the common case for documents linked from a page the
    // user is on) resolve the same way a click in the page would.
    const timeoutSignal = AbortSignal.timeout(IMPORT_TIMEOUT_MS)
    const res = await fetch(parsed.href, {
      credentials: 'include',
      signal: opts?.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal,
    })
    throwIfAborted(opts?.signal)
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${parsed.href}`)
    }
    const declared = Number(res.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`file is ${declared} bytes, above the ${maxBytes}-byte import limit`)
    }
    const raw = await res.blob()
    throwIfAborted(opts?.signal)
    if (raw.size > maxBytes) {
      throw new Error(`file is ${raw.size} bytes, above the ${maxBytes}-byte import limit`)
    }
    const path = opts?.path
      ? normalizeAbsolutePath(opts.path).path
      : normalizePath('workspace', `imports/${filenameFromImport(res, parsed)}`)
    const headerType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    const mediaType =
      headerType && headerType !== 'application/octet-stream' ? headerType : inferMediaTypeFromPath(path)
    const entry = await this.putBlob(path, raw.slice(0, raw.size, mediaType), mediaType, opts?.signal)
    debugLog.log('storage', 'vfs import url', { url: parsed.href, path: entry.path, size: entry.size, mediaType })
    return entry
  }

  async createSkill(opts: {
    name: string
    description: string
    body?: string
    files?: Array<{ path: string; text?: string; base64?: string; mediaType?: string }>
    signal?: AbortSignal
  }): Promise<VfsEntry[]> {
    throwIfAborted(opts.signal)
    const name = normalizeSkillName(opts.name)
    const entries: VfsEntry[] = []
    entries.push(
      await this.writeText(`/skills/${name}/SKILL.md`, skillMarkdown(name, opts.description, opts.body), {
        mediaType: 'text/markdown',
        signal: opts.signal,
      }),
    )

    for (const file of opts.files ?? []) {
      throwIfAborted(opts.signal)
      const rel = sanitizeSegment(file.path)
      if (!rel || rel.toLowerCase() === 'skill.md') continue
      const path = `/skills/${name}/${rel}`
      if (file.base64 !== undefined) {
        entries.push(await this.writeBase64(path, file.base64, { mediaType: file.mediaType, signal: opts.signal }))
      } else {
        entries.push(await this.writeText(path, file.text ?? '', { mediaType: file.mediaType, signal: opts.signal }))
      }
    }

    return entries
  }

  async delete(path: string, opts?: { signal?: AbortSignal }): Promise<void> {
    rootFromPath(path)
    throwIfAborted(opts?.signal)
    await withStore('readwrite', (store) => store.delete(path))
    emitVfsChange({ path, action: 'delete', at: Date.now() })
    debugLog.log('storage', 'vfs delete file', { path })
  }

  async getEntry(path: string): Promise<VfsEntry | undefined> {
    const file = await this.getStored(path)
    return file ? stripBlob(file) : undefined
  }

  async readText(path: string, opts?: { offset?: number; maxChars?: number }): Promise<VfsTextResult> {
    const file = await this.requireStored(path)
    const text = await this.fullText(file)
    return truncateText(path, text, opts?.offset, opts?.maxChars)
  }

  async readHtml(path: string): Promise<VfsHtmlResult> {
    const file = await this.requireStored(path)
    if (isDocx(file)) {
      const result = await extractDocxHtml(file.blob)
      return { path, html: result.html, messages: result.messages }
    }
    if (isHtml(file)) {
      return { path, html: await file.blob.text(), messages: [] }
    }
    throw new Error(`HTML preview is not available for ${path}`)
  }

  async readLines(path: string, opts?: { startLine?: number; count?: number }): Promise<VfsLineResult> {
    const file = await this.requireStored(path)
    const text = await this.fullText(file)
    const all = text.split(/\r?\n/)
    const startLine = Math.max(1, opts?.startLine ?? 1)
    const count = Math.max(1, opts?.count ?? DEFAULT_LINE_COUNT)
    return {
      path,
      startLine,
      lines: all.slice(startLine - 1, startLine - 1 + count),
      totalLines: all.length,
    }
  }

  async readBytes(path: string, opts?: { offset?: number; length?: number }): Promise<VfsBytesResult> {
    const file = await this.requireStored(path)
    const offset = Math.max(0, opts?.offset ?? 0)
    const length = Math.max(1, opts?.length ?? DEFAULT_BYTE_LENGTH)
    const blob = file.blob.slice(offset, offset + length, file.mediaType)
    return {
      path,
      base64: await blobToBase64(blob),
      mediaType: file.mediaType,
      size: file.size,
      truncated: offset + length < file.size,
    }
  }

  async blob(path: string): Promise<Blob> {
    const file = await this.requireStored(path)
    return file.blob
  }

  async dataUrl(path: string): Promise<string> {
    const file = await this.requireStored(path)
    return blobToDataUrl(file.blob)
  }

  async renderPdfPage(path: string, opts?: { page?: number; scale?: number; signal?: AbortSignal }): Promise<VfsRenderedPage> {
    const file = await this.requireStored(path)
    if (!isPdf(file)) throw new Error(`${path} is not a PDF`)
    const page = Math.max(1, opts?.page ?? 1)
    const scale = Math.min(3, Math.max(0.25, opts?.scale ?? 1.5))
    return { path, ...(await renderPdfPage(file.blob, page, scale, opts?.signal)) }
  }

  async search(
    query: string,
    opts?: { root?: VfsRoot; maxResults?: number },
  ): Promise<Array<{ path: string; lines: VfsLineResult['lines'] }>> {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const maxResults = Math.max(1, opts?.maxResults ?? 20)
    const files = (await this.allFiles()).filter((entry) => !opts?.root || entry.root === opts.root)
    const out: Array<{ path: string; lines: string[] }> = []
    for (const file of files) {
      if (out.length >= maxResults) break
      let text: string
      try {
        text = await this.fullText(file)
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      const matches = lines
        .map((line, index) => ({ line, index }))
        .filter((hit) => hit.line.toLowerCase().includes(needle))
        .slice(0, 5)
        .map((hit) => `${hit.index + 1}: ${hit.line}`)
      if (matches.length > 0) out.push({ path: file.path, lines: matches })
    }
    return out
  }

  private async fullText(file: StoredFile): Promise<string> {
    if (isPlainText(file)) return file.blob.text()
    if (isPdf(file)) return extractPdfText(file.blob)
    if (isDocx(file)) return extractDocxText(file.blob)
    throw new Error(`${file.path} is not a text, PDF, or DOCX file. Use readBytes/dataUrl or filesystem_view for binary media.`)
  }

  private async allFiles(): Promise<StoredFile[]> {
    return withStore('readonly', (store) => store.getAll()) as Promise<StoredFile[]>
  }

  private async getStored(path: string): Promise<StoredFile | undefined> {
    rootFromPath(path)
    const value = await request<StoredFile | undefined>((await openDb()).transaction(STORE, 'readonly').objectStore(STORE).get(path))
    return value
  }

  private async requireStored(path: string): Promise<StoredFile> {
    const file = await this.getStored(path)
    if (!file) throw new Error(`no file at ${path}`)
    return file
  }

  private async putBlob(path: string, blob: Blob, mediaType: string, signal?: AbortSignal): Promise<VfsEntry> {
    const { root } = normalizeAbsolutePath(path)
    const existing = await this.getStored(path)
    const now = Date.now()
    const record: StoredFile = {
      path,
      root,
      name: nameFromPath(path),
      mediaType,
      size: blob.size,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      blob,
    }
    // Last possible check before opening the read/write transaction.
    throwIfAborted(signal)
    await withStore('readwrite', (store) => store.put(record))
    emitVfsChange({ path, action: 'write', created: existing === undefined, at: now })
    return stripBlob(record)
  }
}

function stripBlob(file: StoredFile): VfsEntry {
  const { blob: _blob, ...entry } = file
  return entry
}

export function createVirtualFileSystemService(): VirtualFileSystemService {
  return new IndexedDbVirtualFileSystem()
}
