/**
 * Background half of Artifacts. Tracks every live viewer (artifact.html tabs
 * and in-chat embeds) over a runtime port, and gives the agent a way to reach
 * into them: evaluate code in the document, serialize it back to the file,
 * read its console, screenshot it. Also relays `ai.invoke()` prompts from a
 * document to the side panel and the panel's final text back.
 *
 * Tabs this host opens on the agent's behalf (for eval/screenshot) are
 * "owned": they close on their own after a quiet period so verification does
 * not leave clutter behind. A tab the model opens explicitly via
 * `api.artifacts.open` is for the user and is never auto-closed.
 */

import type { CdpService, VfsEntry } from '../shared/types'
import type { JsonValue } from '../shared/rpc'
import {
  ARTIFACT_EVAL_DEFAULT_TIMEOUT_MS,
  ARTIFACT_EVAL_MAX_TIMEOUT_MS,
  ARTIFACT_INVOCATION_STORAGE_KEY,
  ARTIFACT_OPEN_TIMEOUT_MS,
  ARTIFACT_VIEWER_PORT,
  artifactUrl,
  type ArtifactBackgroundToViewer,
  type ArtifactEvalResult,
  type ArtifactHostService,
  type ArtifactInvocation,
  type ArtifactRuntimeMessage,
  type ArtifactTraceEntry,
  type ArtifactViewerInfo,
  type ArtifactViewerToBackground,
} from '../shared/artifacts'
import { abortError, throwIfAborted } from '../shared/abort'
import { formatError } from '../shared/errors'
import { uid } from '../shared/ids'

const OWNED_TAB_IDLE_MS = 90_000
const READY_RETRY_MS = 700
const READY_RETRIES = 4
const MAX_QUEUED_INVOCATIONS = 20

interface Viewer {
  id: string
  port: chrome.runtime.Port
  path: string
  tabId?: number
  embed: boolean
  ready: boolean
  /** Opened by this host for the agent; auto-closes when idle. */
  owned: boolean
  idleTimer?: ReturnType<typeof setTimeout>
}

interface ResponseWaiter {
  viewerId: string
  resolve: (value: JsonValue) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ReadyWaiter {
  path: string
  tabOnly: boolean
  resolve: (viewer: Viewer) => void
}

export interface ArtifactHost extends ArtifactHostService {
  /** Route `artifact.*` runtime messages from the side panel; undefined = not ours. */
  handleRuntimeMessage(message: Partial<ArtifactRuntimeMessage>): Promise<unknown> | undefined
}

export function createArtifactHost(cdp: CdpService): ArtifactHost {
  const viewers = new Map<string, Viewer>()
  const responses = new Map<string, ResponseWaiter>()
  const readyWaiters: ReadyWaiter[] = []
  /** invokeId → viewer id that asked, so the panel's answer finds its way back. */
  const invocations = new Map<string, string>()
  let invocationMutation: Promise<unknown> = Promise.resolve()

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== ARTIFACT_VIEWER_PORT) return
    attach(port)
  })

  /* ---------------- viewer registry ---------------- */

  function attach(port: chrome.runtime.Port): void {
    const id = uid('viewer')
    const tabId = port.sender?.tab?.id
    let viewer: Viewer | undefined
    port.onMessage.addListener((raw) => {
      const message = raw as ArtifactViewerToBackground
      if (message.type === 'hello') {
        viewer = {
          id,
          port,
          path: message.path,
          tabId,
          embed: message.embed || tabId === undefined,
          ready: false,
          owned: false,
        }
        viewers.set(id, viewer)
        return
      }
      if (!viewer) return
      if (message.type === 'ready') {
        viewer.ready = true
        notifyReady(viewer)
        return
      }
      if (message.type === 'response') {
        const waiter = responses.get(message.requestId)
        if (!waiter || waiter.viewerId !== viewer.id) return
        responses.delete(message.requestId)
        clearTimeout(waiter.timer)
        if (message.ok) waiter.resolve(message.value ?? null)
        else waiter.reject(new Error(message.error ?? 'artifact request failed'))
        return
      }
      if (message.type === 'invoke') void enqueueInvocation(viewer, message)
    })
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      if (!viewer) return
      if (viewer.idleTimer) clearTimeout(viewer.idleTimer)
      viewers.delete(viewer.id)
      for (const waiter of responses.values()) {
        if (waiter.viewerId !== viewer.id) continue
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`artifact viewer for ${viewer.path} closed before the request completed`))
      }
      for (const [invokeId, viewerId] of [...invocations]) if (viewerId === viewer.id) invocations.delete(invokeId)
    })
  }

  function notifyReady(viewer: Viewer): void {
    for (let i = readyWaiters.length - 1; i >= 0; i--) {
      const waiter = readyWaiters[i]!
      if (waiter.path !== viewer.path) continue
      if (waiter.tabOnly && viewer.tabId === undefined) continue
      readyWaiters.splice(i, 1)
      waiter.resolve(viewer)
    }
  }

  function viewersFor(path: string): Viewer[] {
    return [...viewers.values()].filter((viewer) => viewer.path === path)
  }

  /** Prefer a ready tab viewer, then any tab, then an embed. */
  function pickViewer(path: string, tabOnly: boolean): Viewer | undefined {
    const candidates = viewersFor(path).filter((viewer) => !tabOnly || viewer.tabId !== undefined)
    return (
      candidates.find((viewer) => viewer.tabId !== undefined && viewer.ready) ??
      candidates.find((viewer) => viewer.tabId !== undefined) ??
      candidates.find((viewer) => viewer.ready) ??
      candidates[0]
    )
  }

  function waitReady(path: string, tabOnly: boolean, timeoutMs: number, signal?: AbortSignal): Promise<Viewer> {
    const existing = viewersFor(path).find((viewer) => viewer.ready && (!tabOnly || viewer.tabId !== undefined))
    if (existing) return Promise.resolve(existing)
    return new Promise<Viewer>((resolve, reject) => {
      const waiter: ReadyWaiter = { path, tabOnly, resolve: (viewer) => { cleanup(); resolve(viewer) } }
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `the artifact viewer for ${path} did not become ready within ${Math.round(timeoutMs / 1000)}s — check that the file exists and is HTML (api.fs.stat), then look at api.artifacts.logs(path)`,
          ),
        )
      }, timeoutMs)
      const onAbort = (): void => {
        cleanup()
        reject(signal?.reason instanceof Error ? signal.reason : abortError())
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const index = readyWaiters.indexOf(waiter)
        if (index >= 0) readyWaiters.splice(index, 1)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      readyWaiters.push(waiter)
    })
  }

  function touch(viewer: Viewer): void {
    if (!viewer.owned || viewer.tabId === undefined) return
    if (viewer.idleTimer) clearTimeout(viewer.idleTimer)
    const tabId = viewer.tabId
    viewer.idleTimer = setTimeout(() => {
      if (!viewers.has(viewer.id) || !viewer.owned) return
      chrome.tabs.remove(tabId).catch(() => {})
    }, OWNED_TAB_IDLE_MS)
  }

  /**
   * Resolve a ready tab viewer, opening a background tab if none is open.
   * `created` tells callers whether they spent a tab on this.
   */
  async function ensureViewer(
    path: string,
    opts: { active?: boolean; forUser?: boolean; signal?: AbortSignal },
  ): Promise<{ viewer: Viewer; created: boolean }> {
    throwIfAborted(opts.signal)
    const existing = pickViewer(path, true)
    if (existing) {
      const viewer = existing.ready ? existing : await waitReady(path, true, ARTIFACT_OPEN_TIMEOUT_MS, opts.signal)
      if (opts.forUser) {
        viewer.owned = false
        if (viewer.idleTimer) clearTimeout(viewer.idleTimer)
      }
      touch(viewer)
      return { viewer, created: false }
    }
    const readyPromise = waitReady(path, true, ARTIFACT_OPEN_TIMEOUT_MS, opts.signal)
    readyPromise.catch(() => {})
    const tab = await chrome.tabs.create({ url: artifactUrl(path), active: opts.active === true })
    let viewer: Viewer
    try {
      viewer = await readyPromise
    } catch (err) {
      if (tab.id !== undefined && !opts.forUser) chrome.tabs.remove(tab.id).catch(() => {})
      throw err
    }
    viewer.owned = !opts.forUser
    touch(viewer)
    return { viewer, created: true }
  }

  function request(viewer: Viewer, body: Omit<Extract<ArtifactBackgroundToViewer, { type: 'request' }>, 'type' | 'requestId'>, timeoutMs: number, signal?: AbortSignal): Promise<JsonValue> {
    throwIfAborted(signal)
    touch(viewer)
    return new Promise<JsonValue>((resolve, reject) => {
      const requestId = uid('areq')
      const cleanup = (): void => {
        responses.delete(requestId)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        const waiter = responses.get(requestId)
        if (waiter) clearTimeout(waiter.timer)
        cleanup()
        reject(signal?.reason instanceof Error ? signal.reason : abortError())
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`the artifact viewer for ${viewer.path} did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      responses.set(requestId, {
        viewerId: viewer.id,
        resolve: (value) => { cleanup(); resolve(value) },
        reject: (error) => { cleanup(); reject(error) },
        timer,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        viewer.port.postMessage({ type: 'request', requestId, ...body } satisfies ArtifactBackgroundToViewer)
      } catch (err) {
        clearTimeout(timer)
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** A document mid-reload answers "not ready" — give it a moment and retry. */
  async function requestWithRetry(
    path: string,
    body: Omit<Extract<ArtifactBackgroundToViewer, { type: 'request' }>, 'type' | 'requestId'>,
    timeoutMs: number,
    opts: { signal?: AbortSignal },
  ): Promise<JsonValue> {
    let attempt = 0
    for (;;) {
      const { viewer } = await ensureViewer(path, { signal: opts.signal })
      try {
        return await request(viewer, body, timeoutMs, opts.signal)
      } catch (err) {
        const message = formatError(err)
        if (attempt < READY_RETRIES && /not ready/i.test(message)) {
          attempt += 1
          await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS))
          throwIfAborted(opts.signal)
          continue
        }
        throw err
      }
    }
  }

  /* ---------------- invocations (document → side panel) ---------------- */

  function serializeInvocationMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = invocationMutation.then(fn, fn)
    invocationMutation = run.catch(() => undefined)
    return run
  }

  async function readQueue(): Promise<ArtifactInvocation[]> {
    const stored = await chrome.storage.session.get(ARTIFACT_INVOCATION_STORAGE_KEY)
    const queue = stored[ARTIFACT_INVOCATION_STORAGE_KEY]
    return Array.isArray(queue) ? (queue as ArtifactInvocation[]) : []
  }

  async function enqueueInvocation(viewer: Viewer, message: Extract<ArtifactViewerToBackground, { type: 'invoke' }>): Promise<void> {
    const invocation: ArtifactInvocation = {
      id: message.invokeId,
      path: message.path,
      prompt: message.prompt,
      chat: message.chat || 'current',
      createdAt: Date.now(),
    }
    invocations.set(invocation.id, viewer.id)
    await serializeInvocationMutation(async () => {
      const queue = await readQueue()
      await chrome.storage.session.set({ [ARTIFACT_INVOCATION_STORAGE_KEY]: [...queue, invocation].slice(-MAX_QUEUED_INVOCATIONS) })
    })
    chrome.runtime.sendMessage({ target: 'ui', type: 'artifact.invoke.available' } satisfies ArtifactRuntimeMessage).catch(() => {})
  }

  async function claimInvocations(): Promise<ArtifactInvocation[]> {
    return serializeInvocationMutation(async () => {
      const queue = await readQueue()
      if (queue.length > 0) await chrome.storage.session.remove(ARTIFACT_INVOCATION_STORAGE_KEY)
      return queue
    })
  }

  function deliverInvocationResult(message: Extract<ArtifactRuntimeMessage, { type: 'artifact.invoke.result' }>): void {
    const viewerId = invocations.get(message.invokeId)
    invocations.delete(message.invokeId)
    const viewer = viewerId ? viewers.get(viewerId) : undefined
    if (!viewer) return
    try {
      viewer.port.postMessage({
        type: 'invoke-result',
        invokeId: message.invokeId,
        ok: message.ok,
        chatId: message.chatId,
        text: message.text,
        error: message.error,
      } satisfies ArtifactBackgroundToViewer)
    } catch {
      /* viewer went away */
    }
  }

  /* ---------------- service ---------------- */

  const info = (viewer: Viewer): ArtifactViewerInfo => ({
    path: viewer.path,
    url: artifactUrl(viewer.path),
    tabId: viewer.tabId,
    embed: viewer.embed,
    ready: viewer.ready,
  })

  const host: ArtifactHost = {
    list: () => [...viewers.values()].map(info),

    async open(path, opts) {
      const { viewer, created } = await ensureViewer(path, { active: opts?.active !== false, forUser: true, signal: opts?.signal })
      if (viewer.tabId === undefined) throw new Error(`no tab is showing ${path}`)
      if (opts?.active !== false) {
        try {
          const tab = await chrome.tabs.update(viewer.tabId, { active: true })
          if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
        } catch {
          /* tab may have closed between ready and focus */
        }
      }
      return { tabId: viewer.tabId, url: artifactUrl(path), created }
    },

    async eval(path, code, opts) {
      const timeoutMs = Math.min(ARTIFACT_EVAL_MAX_TIMEOUT_MS, Math.max(100, opts?.timeoutMs ?? ARTIFACT_EVAL_DEFAULT_TIMEOUT_MS))
      const result = await requestWithRetry(path, { op: 'eval', code, timeoutMs }, timeoutMs + 5_000, { signal: opts?.signal })
      const record = result && typeof result === 'object' && !Array.isArray(result) ? result : {}
      return {
        value: record.value ?? null,
        logs: Array.isArray(record.logs) ? record.logs.map((line) => String(line)) : [],
      } satisfies ArtifactEvalResult
    },

    async save(path, opts) {
      const result = await requestWithRetry(path, { op: 'save' }, 15_000, { signal: opts?.signal })
      return result && typeof result === 'object' && !Array.isArray(result) ? (result as unknown as VfsEntry) : null
    },

    async reload(path, opts) {
      const viewer = pickViewer(path, false)
      if (!viewer) return
      await request(viewer, { op: 'reload' }, 15_000, opts?.signal)
    },

    async logs(path, opts) {
      const viewer = pickViewer(path, false)
      if (!viewer) return []
      const result = await request(viewer, { op: 'logs' }, 5_000, opts?.signal)
      return Array.isArray(result) ? result.map((line) => String(line)) : []
    },

    async trace(path, opts) {
      const viewer = pickViewer(path, false)
      if (!viewer) return []
      const result = await request(viewer, { op: 'trace' }, 5_000, opts?.signal)
      return Array.isArray(result) ? (result as unknown as ArtifactTraceEntry[]) : []
    },

    async reset(path, opts) {
      const { viewer } = await ensureViewer(path, { signal: opts?.signal })
      await request(viewer, { op: 'reset' }, 20_000, opts?.signal)
    },

    async screenshot(path, opts) {
      const { viewer } = await ensureViewer(path, { signal: opts?.signal })
      const tabId = viewer.tabId
      if (tabId === undefined) throw new Error(`no tab is showing ${path}`)
      // Let a freshly rendered document paint before capturing.
      await new Promise((resolve) => setTimeout(resolve, 350))
      throwIfAborted(opts?.signal)
      try {
        const shot = await cdp.screenshot(tabId)
        return { ...shot, tabId }
      } catch (err) {
        // Extension pages can refuse the debugger; fall back to a visible capture.
        const tab = await chrome.tabs.update(tabId, { active: true })
        await new Promise((resolve) => setTimeout(resolve, 250))
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' })
          const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
          return { base64, mediaType: 'image/png', tabId }
        } catch (fallbackErr) {
          throw new Error(`could not screenshot ${path}: ${formatError(err)}; fallback: ${formatError(fallbackErr)}`)
        }
      }
    },

    async close(path) {
      const tabIds = [...new Set(viewersFor(path).map((viewer) => viewer.tabId).filter((id): id is number => id !== undefined))]
      let closed = 0
      for (const tabId of tabIds) {
        try {
          await chrome.tabs.remove(tabId)
          closed += 1
        } catch {
          /* already closed */
        }
      }
      return closed
    },

    handleRuntimeMessage(message) {
      if (message.target !== 'background') return undefined
      if (message.type === 'artifact.invoke.claim') {
        return claimInvocations().then((list) => ({ invocations: list }))
      }
      if (message.type === 'artifact.invoke.result') {
        deliverInvocationResult(message as Extract<ArtifactRuntimeMessage, { type: 'artifact.invoke.result' }>)
        return Promise.resolve({ ok: true })
      }
      return undefined
    },
  }

  return host
}
