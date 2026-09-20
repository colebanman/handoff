/**
 * One live HTML artifact inside artifact.html: owns the sandboxed frame's
 * message channel, the API bridge the document calls into, the runtime port
 * to the background (so the agent can eval/save/reload/read logs), and the
 * `ai.invoke()` round-trip to the side panel.
 *
 * Kept free of React so the viewer component only mounts an <iframe> and
 * hands it over.
 */

import runtimeSource from './runtime.js?raw'
import kitCss from './kit.css?raw'
import kitJs from './kit.js?raw'
import {
  ARTIFACT_EVAL_DEFAULT_TIMEOUT_MS,
  ARTIFACT_EVAL_MAX_TIMEOUT_MS,
  ARTIFACT_INVOKE_DEFAULT_TIMEOUT_MS,
  ARTIFACT_LOG_LIMIT,
  ARTIFACT_STATE_KEY_PREFIX,
  ARTIFACT_VIEWER_PORT,
  artifactUrl,
  buildArtifactDocument,
  findExternalScripts,
  inlineExternalScripts,
  isArtifactAllowedApiPath,
  type ArtifactBackgroundToViewer,
  type ArtifactDocumentToHost,
  type ArtifactHostToDocument,
  type ArtifactTraceEntry,
  type ArtifactViewerToBackground,
} from '../shared/artifacts'
import type { JsonValue } from '../shared/rpc'
import type { CdpService, VfsEntry, VirtualFileSystemService } from '../shared/types'
import { createApiDispatch } from '../sandbox/api-dispatch'
import { debugLog } from '../shared/debug-log'
import { formatError } from '../shared/errors'
import { uid } from '../shared/ids'
import { loadSettings } from '../storage/settings'

const RECONNECT_MS = 1_000
const FRAME_READY_TIMEOUT_MS = 10_000
const SCRIPT_FETCH_TIMEOUT_MS = 20_000
const MAX_SCRIPT_CHARS = 6_000_000

export interface ArtifactConsoleLine {
  level: 'log' | 'warn' | 'error'
  text: string
  at: number
}

export interface ArtifactSessionEvents {
  onConsole?(lines: ArtifactConsoleLine[]): void
  onReady?(): void
  onSaved?(entry: VfsEntry): void
  onInvokeState?(active: number): void
}

const unavailableCdp = new Proxy({}, {
  get: () => () => Promise.reject(new Error('artifacts cannot drive pages — ask the agent with ai.invoke() instead')),
}) as CdpService

/** Fetched library sources, shared by every session on this page. */
const scriptCache = new Map<string, Promise<string>>()

export function fetchScriptSource(url: string): Promise<string> {
  if (!/^https:\/\//i.test(url)) return Promise.reject(new Error(`only https:// scripts can be loaded (got ${url})`))
  let cached = scriptCache.get(url)
  if (!cached) {
    cached = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), SCRIPT_FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: controller.signal })
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        const text = await res.text()
        if (text.length > MAX_SCRIPT_CHARS) throw new Error(`script is ${text.length} chars (max ${MAX_SCRIPT_CHARS})`)
        return text
      } finally {
        clearTimeout(timer)
      }
    })()
    cached.catch(() => scriptCache.delete(url))
    scriptCache.set(url, cached)
  }
  return cached
}

/** The side panel's theme, so kit tokens match; dark is the panel default. */
async function currentTheme(): Promise<'dark' | 'light'> {
  try {
    return (await loadSettings()).theme === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** Inline every remote <script src> so the sandbox CSP does not block it. */
export async function prepareArtifactHtml(html: string): Promise<string> {
  const refs = findExternalScripts(html)
  if (refs.length === 0) return html
  const sources = new Map<string, string | Error>()
  await Promise.all(
    [...new Set(refs.map((ref) => ref.url))].map(async (url) => {
      try {
        sources.set(url, await fetchScriptSource(url))
      } catch (err) {
        sources.set(url, err instanceof Error ? err : new Error(String(err)))
      }
    }),
  )
  return inlineExternalScripts(html, sources)
}

interface PendingInvoke {
  resolve: (value: JsonValue) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingRequest {
  resolve: (value: Extract<ArtifactDocumentToHost, { kind: 'artifact-response' }>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ArtifactSession {
  readonly path: string
  /** Attach the artifact-frame iframe; returns a disposer for its listeners. */
  attachFrame(frame: HTMLIFrameElement): () => void
  /** Render (or re-render) the artifact HTML into the frame. */
  render(html: string): Promise<void>
  /** Latest rendered source, used to skip reloads triggered by our own save. */
  lastSavedHtml(): string | undefined
  logs(): ArtifactConsoleLine[]
  clearLogs(): void
  trace(): ArtifactTraceEntry[]
  dispose(): void
}

/** Compact, secret-free summary of api-call args for the trace. */
export function summarizeApiArgs(path: string, args: JsonValue[]): string {
  const parts = args.slice(0, 3).map((arg) => {
    if (typeof arg === 'string') return arg.length > 120 ? `${arg.slice(0, 117)}…` : arg
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      const keys = Object.keys(arg)
      const method = typeof arg.method === 'string' ? arg.method : undefined
      return method ? `{${method}${keys.length > 1 ? `, …${keys.length - 1} more` : ''}}` : `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}`
    }
    if (Array.isArray(arg)) return `[${arg.length} items]`
    return String(arg)
  })
  if (args.length > 3) parts.push('…')
  void path
  return parts.join(', ')
}

export function createArtifactSession(opts: {
  path: string
  embed: boolean
  vfs: VirtualFileSystemService
  events?: ArtifactSessionEvents
}): ArtifactSession {
  const { path, embed, vfs, events } = opts
  const url = artifactUrl(path)
  const dispatch = createApiDispatch(unavailableCdp, vfs)
  const consoleLines: ArtifactConsoleLine[] = []
  const traceEntries: ArtifactTraceEntry[] = []
  const pendingInvokes = new Map<string, PendingInvoke>()
  const pendingRequests = new Map<string, PendingRequest>()

  let frame: HTMLIFrameElement | undefined
  let frameReady: Promise<void> | undefined
  let resolveFrameReady: (() => void) | undefined
  let documentReady = false
  let currentHtml: string | undefined
  let savedHtml: string | undefined
  let disposed = false
  let port: chrome.runtime.Port | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  /* ---------------- frame channel ---------------- */

  function postToDocument(message: ArtifactHostToDocument): void {
    frame?.contentWindow?.postMessage(message, '*')
  }

  function pushConsole(level: ArtifactConsoleLine['level'], text: string): void {
    consoleLines.push({ level, text, at: Date.now() })
    if (consoleLines.length > ARTIFACT_LOG_LIMIT) consoleLines.splice(0, consoleLines.length - ARTIFACT_LOG_LIMIT)
    events?.onConsole?.(consoleLines)
  }

  function onFrameMessage(event: MessageEvent<ArtifactDocumentToHost>): void {
    if (!frame || event.source !== frame.contentWindow) return
    const data = event.data
    if (!data || typeof data !== 'object' || !('kind' in data)) return
    switch (data.kind) {
      case 'artifact-frame-ready':
        resolveFrameReady?.()
        return
      case 'artifact-ready':
        documentReady = true
        events?.onReady?.()
        postToBackground({ type: 'ready', path })
        return
      case 'artifact-console':
        pushConsole(data.level, data.text)
        return
      case 'api-call':
        void handleApiCall(data)
        return
      case 'artifact-response': {
        const waiter = pendingRequests.get(data.requestId)
        if (!waiter) return
        pendingRequests.delete(data.requestId)
        clearTimeout(waiter.timer)
        waiter.resolve(data)
        return
      }
    }
  }

  function pushTrace(entry: ArtifactTraceEntry): void {
    traceEntries.push(entry)
    if (traceEntries.length > ARTIFACT_LOG_LIMIT) traceEntries.splice(0, traceEntries.length - ARTIFACT_LOG_LIMIT)
  }

  async function handleApiCall(call: Extract<ArtifactDocumentToHost, { kind: 'api-call' }>): Promise<void> {
    const started = Date.now()
    const summary = summarizeApiArgs(call.path, call.args)
    try {
      const value = await dispatchApi(call.path, call.args)
      const status =
        call.path === 'fetch' && value && typeof value === 'object' && !Array.isArray(value) && typeof value.status === 'number'
          ? value.status
          : undefined
      pushTrace({ at: started, path: call.path, args: summary, ok: true, ms: Date.now() - started, status })
      postToDocument({ kind: 'api-result', callId: call.callId, ok: true, value })
    } catch (err) {
      const error = formatError(err)
      pushTrace({ at: started, path: call.path, args: summary, ok: false, error, ms: Date.now() - started })
      debugLog.error('artifact', `ai.${call.path}`, err)
      postToDocument({ kind: 'api-result', callId: call.callId, ok: false, error })
    }
  }

  async function dispatchApi(apiPath: string, args: JsonValue[]): Promise<JsonValue> {
    switch (apiPath) {
      case 'artifact.meta':
        return { path, url, embed }
      case 'artifact.save': {
        const html = typeof args[0] === 'string' ? args[0] : ''
        if (!html.trim()) throw new Error('ai.save(): document serialized to nothing')
        savedHtml = html
        currentHtml = html
        const entry = await vfs.writeText(path, html, { mediaType: 'text/html' })
        events?.onSaved?.(entry)
        return entry as unknown as JsonValue
      }
      case 'artifact.open': {
        const target = String(args[0] ?? '')
        if (!/^https?:\/\//i.test(target) && !target.startsWith(chrome.runtime.getURL(''))) {
          throw new Error(`ai.open(url): expected an http(s) URL, got ${JSON.stringify(target)}`)
        }
        const tab = await chrome.tabs.create({ url: target, active: true })
        return { tabId: tab.id ?? null }
      }
      case 'artifact.script':
        return await fetchScriptSource(String(args[0] ?? ''))
      case 'artifact.state.get': {
        const store = await readState()
        const value = store[String(args[0])]
        return value === undefined ? null : value
      }
      case 'artifact.state.set': {
        const store = await readState()
        const key = String(args[0])
        if (args[1] === null || args[1] === undefined) delete store[key]
        else store[key] = args[1]
        await chrome.storage.local.set({ [stateKey()]: store })
        return { key, ok: true }
      }
      case 'artifact.state.all':
        return await readState()
      case 'artifact.state.clear':
        await chrome.storage.local.remove(stateKey())
        return { ok: true }
      case 'artifact.invoke':
        return await invoke(String(args[0] ?? ''), args[1])
      default:
        if (!isArtifactAllowedApiPath(apiPath)) {
          throw new Error(
            `ai.${apiPath} is not available inside an artifact (allowed: fs.*, fetch, tabs.*, history.*, bookmarks.*, downloads.*, storage.*). Use ai.invoke(prompt) to have the assistant do it.`,
          )
        }
        return await dispatch(apiPath, args)
    }
  }

  function stateKey(): string {
    return `${ARTIFACT_STATE_KEY_PREFIX}${path}`
  }

  async function readState(): Promise<Record<string, JsonValue>> {
    const stored = await chrome.storage.local.get(stateKey())
    const value = stored[stateKey()]
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, JsonValue>) } : {}
  }

  /* ---------------- invoke (document → side panel) ---------------- */

  async function invoke(prompt: string, rawOpts: JsonValue | undefined): Promise<JsonValue> {
    if (!prompt.trim()) throw new Error('ai.invoke(prompt): prompt is required')
    const options = rawOpts && typeof rawOpts === 'object' && !Array.isArray(rawOpts) ? rawOpts : {}
    const chat = typeof options.chat === 'string' && options.chat ? options.chat : 'current'
    const timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : ARTIFACT_INVOKE_DEFAULT_TIMEOUT_MS
    await openSidePanel()
    const invokeId = uid('inv')
    const result = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingInvokes.delete(invokeId)
        events?.onInvokeState?.(pendingInvokes.size)
        reject(new Error(`ai.invoke timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pendingInvokes.set(invokeId, { resolve, reject, timer })
    })
    events?.onInvokeState?.(pendingInvokes.size)
    postToBackground({ type: 'invoke', invokeId, path, prompt, chat })
    return result
  }

  async function openSidePanel(): Promise<void> {
    try {
      const tab = await chrome.tabs.getCurrent()
      if (tab?.id !== undefined) await chrome.sidePanel.open({ tabId: tab.id })
      else if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId })
    } catch (err) {
      // Needs a user gesture; the panel may already be open, and the
      // invocation is queued for it either way.
      debugLog.log('artifact', 'sidePanel.open skipped', formatError(err))
    }
  }

  /* ---------------- background port ---------------- */

  function postToBackground(message: ArtifactViewerToBackground): void {
    try {
      port?.postMessage(message)
    } catch {
      /* reconnect will re-announce */
    }
  }

  function connect(): void {
    if (disposed || port) return
    let connection: chrome.runtime.Port
    try {
      connection = chrome.runtime.connect({ name: ARTIFACT_VIEWER_PORT })
    } catch (err) {
      debugLog.error('artifact', 'viewer port connect', err)
      scheduleReconnect()
      return
    }
    port = connection
    connection.onMessage.addListener((raw) => {
      if (port === connection) void handleBackgroundMessage(raw as ArtifactBackgroundToViewer)
    })
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      if (port !== connection) return
      port = undefined
      scheduleReconnect()
    })
    postToBackground({ type: 'hello', path, embed })
    if (documentReady) postToBackground({ type: 'ready', path })
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== undefined) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, RECONNECT_MS)
  }

  async function handleBackgroundMessage(message: ArtifactBackgroundToViewer): Promise<void> {
    if (message.type === 'invoke-result') {
      const waiter = pendingInvokes.get(message.invokeId)
      if (!waiter) return
      pendingInvokes.delete(message.invokeId)
      clearTimeout(waiter.timer)
      events?.onInvokeState?.(pendingInvokes.size)
      if (message.ok) waiter.resolve({ ok: true, chatId: message.chatId ?? null, text: message.text ?? '' })
      else waiter.reject(new Error(message.error ?? 'invocation failed'))
      return
    }
    if (message.type !== 'request') return
    try {
      const value = await handleRequest(message)
      postToBackground({ type: 'response', requestId: message.requestId, ok: true, value })
    } catch (err) {
      postToBackground({ type: 'response', requestId: message.requestId, ok: false, error: formatError(err) })
    }
  }

  async function handleRequest(message: Extract<ArtifactBackgroundToViewer, { type: 'request' }>): Promise<JsonValue> {
    switch (message.op) {
      case 'ping':
        return { ready: documentReady, embed, path }
      case 'logs':
        return consoleLines.map((line) => `[${line.level}] ${line.text}`)
      case 'trace':
        return traceEntries as unknown as JsonValue
      case 'reset': {
        if (currentHtml === undefined) throw new Error('nothing rendered yet')
        await chrome.storage.local.remove(stateKey())
        consoleLines.length = 0
        traceEntries.length = 0
        events?.onConsole?.(consoleLines)
        await render(currentHtml)
        return { ok: true }
      }
      case 'reload': {
        if (currentHtml === undefined) throw new Error('nothing rendered yet')
        await render(currentHtml)
        return { ok: true }
      }
      case 'eval': {
        const timeoutMs = Math.min(
          ARTIFACT_EVAL_MAX_TIMEOUT_MS,
          Math.max(100, message.timeoutMs ?? ARTIFACT_EVAL_DEFAULT_TIMEOUT_MS),
        )
        const response = await requestDocument({ op: 'eval', code: message.code ?? '', timeoutMs }, timeoutMs + 2_000)
        if (!response.ok) {
          const logs = response.logs?.length ? `\nConsole:\n${response.logs.join('\n')}` : ''
          throw new Error(`${response.error ?? 'eval failed'}${logs}`)
        }
        return { value: response.value ?? null, logs: response.logs ?? [] }
      }
      case 'save': {
        const response = await requestDocument({ op: 'save' }, 10_000)
        if (!response.ok || typeof response.value !== 'string') throw new Error(response.error ?? 'save failed')
        return await dispatchApi('artifact.save', [response.value])
      }
      default:
        throw new Error(`unknown artifact request ${String((message as { op: string }).op)}`)
    }
  }

  function requestDocument(
    request: { op: 'eval' | 'save' | 'ping'; code?: string; timeoutMs?: number },
    timeoutMs: number,
  ): Promise<Extract<ArtifactDocumentToHost, { kind: 'artifact-response' }>> {
    if (!documentReady) return Promise.reject(new Error('the artifact document is not ready (still loading or failed to render)'))
    return new Promise((resolve, reject) => {
      const requestId = uid('req')
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId)
        reject(new Error(`the artifact did not answer within ${timeoutMs}ms (a blocking script or a broken runtime)`))
      }, timeoutMs)
      pendingRequests.set(requestId, { resolve, reject, timer })
      postToDocument({ kind: 'artifact-request', requestId, ...request })
    })
  }

  /* ---------------- rendering ---------------- */

  function cancelRequests(reason: string): void {
    for (const waiter of pendingRequests.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
    pendingRequests.clear()
  }

  async function render(html: string): Promise<void> {
    currentHtml = html
    documentReady = false
    cancelRequests('artifact reloaded before the request completed')
    if (!frameReady) throw new Error('artifact frame is not attached')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        frameReady,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('artifact frame did not become ready')), FRAME_READY_TIMEOUT_MS)
        }),
      ])
    } finally { clearTimeout(timer) }
    if (disposed) return
    const [prepared, theme] = await Promise.all([prepareArtifactHtml(html), currentTheme()])
    if (disposed || currentHtml !== html) return
    postToDocument({
      kind: 'artifact-render',
      html: buildArtifactDocument(prepared, runtimeSource, { path, url, theme }, { css: kitCss, js: kitJs }),
      path,
      url,
    })
  }

  function attachFrame(element: HTMLIFrameElement): () => void {
    frame = element
    frameReady = new Promise<void>((resolve) => {
      resolveFrameReady = resolve
    })
    window.addEventListener('message', onFrameMessage)
    // React may attach after the already-loaded frame sent its first ready.
    postToDocument({ kind: 'artifact-frame-ping' })
    connect()
    return () => {
      window.removeEventListener('message', onFrameMessage)
      if (frame === element) {
        frame = undefined
        frameReady = undefined
        resolveFrameReady = undefined
      }
    }
  }

  function dispose(): void {
    disposed = true
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
    for (const waiter of pendingInvokes.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('artifact viewer closed'))
    }
    pendingInvokes.clear()
    cancelRequests('artifact viewer closed')
    try {
      port?.disconnect()
    } catch {
      /* already gone */
    }
    port = undefined
  }

  return {
    path,
    attachFrame,
    render,
    lastSavedHtml: () => savedHtml,
    logs: () => consoleLines,
    trace: () => traceEntries,
    clearLogs: () => {
      consoleLines.length = 0
      events?.onConsole?.(consoleLines)
    },
    dispose,
  }
}
