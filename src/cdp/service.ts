import { beginDiagnosticOperation } from '../shared/runtime-diagnostics'
import { withoutStickyOverlay } from './sticky-overlay'
/**
 * CdpService implementation: owns chrome.debugger attach/detach, AX-tree
 * snapshots (per-tab ref maps), and the interaction primitives
 * (click/type/pressKey/scroll/navigate/waitForLoad/screenshot/evalInPage).
 *
 * Follows docs/research/cdp-and-interaction.md for every CDP sequence.
 */

import type {
  ActivityCursorMode,
  CdpService,
  FrameInfo,
  NetworkRequestEntry,
  PageAttachmentFile,
  PageAttachmentResult,
  PageAttachmentTarget,
  SnapshotResult,
} from '../shared/types'
import { debugLog } from '../shared/debug-log'
import { buildSnapshot, SnapshotReferences, type SendFn } from './ax-tree'
import { keyEventSequence, parseCombo } from './keys'
import { abortableDelay, throwIfAborted } from '../shared/abort'
import { ActivityCursor, estimateTabStripX } from './activity-cursor'
import { loadActivityCursorMode, subscribeActivityCursorMode } from '../storage/settings'

const CDP_VERSION = '1.3'
const ENABLE_TIMEOUT_MS = 10_000
// Every CDP command gets a deadline: if the page's renderer never services the
// command (tab discarded, never loaded, or frozen by a native dialog), the
// chrome.debugger.sendCommand callback simply never fires and the agent's tool
// call would hang forever.
const COMMAND_TIMEOUT_MS = 15_000
const DEFAULT_LOAD_TIMEOUT_MS = 15_000
const LOAD_POLL_INTERVAL_MS = 300
/** Favicon fetch for the tab-switch pulse: cosmetic, so it gets a tight leash. */
const ICON_FETCH_TIMEOUT_MS = 250
/** How long the tab-switch choreography waits for that icon before starting without it. */
const ICON_RACE_MS = 60

/* ---- Minimal local CDP result typings ---- */

interface ResolveNodeResult {
  object?: { objectId?: string }
}

interface BoxModel {
  content: number[]
  width: number
  height: number
}

interface GetBoxModelResult {
  model?: BoxModel
}

interface GetContentQuadsResult {
  quads?: number[][]
}

interface EvaluateResult {
  result?: { type?: string; subtype?: string; value?: unknown; objectId?: string; description?: string }
  exceptionDetails?: {
    text?: string
    lineNumber?: number
    columnNumber?: number
    exception?: { className?: string; description?: string; value?: unknown }
  }
}

/** True when Runtime.evaluate failed at compile time (snippet never ran). */
function isSyntaxError(ex: NonNullable<EvaluateResult['exceptionDetails']>): boolean {
  const desc = ex.exception?.description ?? ex.text ?? ''
  return ex.exception?.className === 'SyntaxError' || desc.startsWith('SyntaxError')
}

interface CaptureScreenshotResult {
  data: string
}

interface NavigateResult {
  errorText?: string
}

interface Point {
  x: number
  y: number
}

/* ---- frames.* typings ---- */

interface FrameTreeNode {
  frame: { id: string; url?: string; name?: string; parentId?: string }
  childFrames?: FrameTreeNode[]
}

interface GetFrameTreeResult {
  frameTree: FrameTreeNode
}

interface GetDocumentResult {
  root?: { nodeId?: number }
}

interface QuerySelectorAllResult {
  nodeIds?: number[]
}

interface DescribeNodeFrameResult {
  node?: { frameId?: string; attributes?: string[] }
}

interface CreateIsolatedWorldResult {
  executionContextId?: number
}

/** Errors that mean the CDP session is gone and we should reattach + retry. */
function isDetachedError(msg: string): boolean {
  return (
    msg.includes('Session with given id not found') ||
    msg.includes('Detached while handling command') ||
    msg.includes('Detached') ||
    msg.includes('No session with given id')
  )
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// CDP key events hit the OS-level editing shortcuts: select-all is cmd+a on
// macOS (ctrl+a there just moves the caret to line start, so clear would
// silently append instead of replacing).
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)
const SELECT_ALL_COMBO = IS_MAC ? 'cmd+a' : 'ctrl+a'

function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`CDP timeout after ${ms}ms: ${label}`)), ms)),
  ])
}

/** Promisified sendCommand that rejects on chrome.runtime.lastError. */
function rawSend<T>(tabId: number, method: string, params?: object): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, (params ?? {}) as { [k: string]: unknown }, (result) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message ?? `CDP error in ${method}`))
        return
      }
      resolve(result as T)
    })
  })
}

interface TabState {
  refMap: Map<string, number>
  snapshotReferences?: SnapshotReferences
  snapshotPending?: Promise<unknown>
  refDescriptions?: Map<string, { role: string; name: string }>
  /** True while a native JS dialog is open on this tab (page thread frozen). */
  dialogOpen: boolean
  /** Captured network requests keyed by requestId, insertion-ordered for eviction. */
  netLog: Map<string, NetworkRequestEntry>
  /** OOPIF debugger sessions: frameId (=== iframe targetId) → session. Empty until v2 attach lands / on Chrome < 125. */
  frameSessions: Map<string, FrameSession>
}

interface FrameSession {
  sessionId: string
  url: string
  /** Page/Runtime enabled lazily on first frames.eval against this session. */
  domainsEnabled?: boolean
}

/** Ring-buffer cap for the per-tab network log. */
const NET_LOG_MAX_ENTRIES = 250
/** Keep only a replayable prefix of inline POST bodies. */
const NET_LOG_MAX_POST_DATA = 2_000
/** Isolated-world name for frames.eval (visible in DevTools context picker). */
const FRAMES_WORLD_NAME = 'handoff-frames'
/** Cap on iframe elements scanned per frames.list call. */
const MAX_FRAME_SCAN = 40
// flatten:true exposes child targets as sessions addressable via
// chrome.debugger.sendCommand({ tabId, sessionId }) — Chrome ≥ 125 only.
// waitForDebuggerOnStart:false so no target is ever paused.
const AUTO_ATTACH_PARAMS = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } as const
// Bounds passed to Network.enable so Chrome's response-body buffering per tab
// stays capped (bodies are what net.body / Network.getResponseBody reads).
// Kept small on purpose: plenty for JSON APIs, bounded even across many
// attached tabs. Chrome frees the buffer on detach.
const NET_MAX_TOTAL_BUFFER = 10_000_000
const NET_MAX_RESOURCE_BUFFER = 2_000_000
/** Keep each debugger command comfortably below Chrome's message-size limits. */
const FILE_TRANSFER_CHUNK_CHARS = 512 * 1024

/* Minimal typings for the Network.* events we consume. */
interface RequestWillBeSentParams {
  requestId: string
  request?: { url?: string; method?: string; postData?: string; hasPostData?: boolean }
  type?: string
  redirectResponse?: object
}
interface ResponseReceivedParams {
  requestId: string
  response?: { status?: number; mimeType?: string }
  type?: string
}
interface LoadingFinishedParams {
  requestId: string
}
interface LoadingFailedParams {
  requestId: string
  errorText?: string
  canceled?: boolean
}

export class CdpServiceImpl implements CdpService {
  private readonly activityCursor = new ActivityCursor()
  private readonly attached = new Set<number>()
  private readonly tabState = new Map<number, TabState>()
  private listenersInstalled = false

  constructor() {
    this.installListeners()
    this.followCursorMode()
  }

  beginActivity(signal: AbortSignal, agentId?: string): () => void {
    return this.activityCursor.begin(signal, agentId)
  }

  beginToolActivity(signal: AbortSignal): () => void {
    return this.activityCursor.beginTool(signal)
  }

  beginModelTurn(signal: AbortSignal): () => void {
    return this.activityCursor.beginModelTurn(signal)
  }

  setCursorMode(mode: ActivityCursorMode): void {
    this.activityCursor.setMode(mode)
  }

  onNavigated(tabId: number, phase: 'committed' | 'domcontentloaded'): void {
    this.activityCursor.onNavigated(tabId, phase)
  }

  onTabActivated(tabId: number): void {
    this.activityCursor.onTabActivated(tabId)
  }

  /**
   * Tab-switch choreography around the caller's own activation call. The strip
   * x is a heuristic (the pointer leaves the viewport, so only gross errors
   * read wrong); any failure degrades to the exit-top-left default.
   */
  async switchTabs(opts: {
    fromTab?: number
    toTab: number
    signal?: AbortSignal
    activate: () => Promise<void>
  }): Promise<void> {
    const { fromTab, toTab, signal, activate } = opts
    if (!signal) {
      await activate()
      return
    }
    // Kick the icon fetch off first; the choreography waits at most 60ms for it.
    const iconPromise = this.faviconDataUrl(toTab)
    let stripX: number | undefined
    let from = fromTab
    try {
      const target = await chrome.tabs.get(toTab)
      const windowId = target.windowId
      const tabs = await chrome.tabs.query({ windowId })
      const win = await chrome.windows.get(windowId)
      if (from === undefined) {
        const [active] = await chrome.tabs.query({ windowId, active: true })
        from = active?.id
      }
      stripX = estimateTabStripX({
        windowWidth: win.width ?? 0,
        tabs: tabs.map((tab) => ({ index: tab.index, pinned: !!tab.pinned })),
        targetIndex: target.index,
      })
    } catch (err) {
      debugLog.log('cdp', 'tab strip estimate failed (exiting top-left)', errMsg(err))
      stripX = undefined
    }
    const icon = await Promise.race([
      iconPromise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ICON_RACE_MS)),
    ])
    await this.activityCursor.switchTabs({ fromTab: from, toTab, signal, stripX, ...(icon ? { icon } : {}), activate })
  }

  /**
   * The target tab's favicon as a data URL, for the tab-strip "click" pulse.
   * Best-effort: anything that is not a quick http(s) or data icon is skipped
   * and the renderer draws a neutral tile instead.
   */
  private async faviconDataUrl(tabId: number): Promise<string | undefined> {
    try {
      const url = (await chrome.tabs.get(tabId)).favIconUrl
      if (!url) return undefined
      if (url.startsWith('data:')) return url
      if (!/^https?:/i.test(url)) return undefined
      const res = await fetch(url, { signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS) })
      if (!res.ok) return undefined
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.length === 0 || bytes.length > 256_000) return undefined
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      const type = res.headers.get('content-type')?.split(';')[0] ?? 'image/png'
      return `data:${type};base64,${btoa(binary)}`
    } catch (err) {
      debugLog.log('cdp', 'favicon fetch skipped', errMsg(err))
      return undefined
    }
  }

  /** Best-effort: test environments and restricted contexts have no storage. */
  private followCursorMode(): void {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return
      void loadActivityCursorMode()
        .then((mode) => this.activityCursor.setMode(mode))
        .catch(() => {})
      subscribeActivityCursorMode((mode) => this.activityCursor.setMode(mode))
    } catch {
      /* No settings storage here: keep the default mode. */
    }
  }

  private installListeners(): void {
    if (this.listenersInstalled) return
    this.listenersInstalled = true

    chrome.debugger.onDetach.addListener((source, reason) => {
      const tabId = source.tabId
      if (reason === 'canceled_by_user') {
        this.activityCursor.hideAll()
        // Chrome kills ALL of the extension's debugger sessions.
        debugLog.log('cdp', 'debugger canceled_by_user — clearing all sessions')
        this.attached.clear()
        this.tabState.clear()
        return
      }
      if (tabId !== undefined) {
        void this.activityCursor.hide(tabId, true)
        debugLog.log('cdp', `detached tab ${tabId} (${reason})`)
        this.attached.delete(tabId)
        this.tabState.delete(tabId)
      }
    })

    chrome.debugger.onEvent.addListener((source, method, params) => {
      const tabId = source.tabId
      if (tabId === undefined) return
      if (method === 'Page.frameNavigated' && !source.sessionId && !(params as { frame?: { parentId?: string } })?.frame?.parentId) {
        const st = this.tabState.get(tabId)
        if (st) {
          st.refMap.clear()
          st.refDescriptions = undefined
          st.snapshotReferences = new SnapshotReferences()
        }
      } else if (method === 'Page.javascriptDialogOpening') {
        const st = this.stateFor(tabId)
        st.dialogOpen = true
        const p = params as { type?: string; message?: string } | undefined
        debugLog.log('cdp', `dialog opening on tab ${tabId}`, { type: p?.type, message: p?.message?.slice(0, 120) })
      } else if (method === 'Page.javascriptDialogClosed') {
        const st = this.tabState.get(tabId)
        if (st) st.dialogOpen = false
      } else if (method.startsWith('Network.')) {
        this.onNetworkEvent(tabId, method, params)
      } else if (method === 'Target.attachedToTarget') {
        const p = params as { sessionId?: string; targetInfo?: { targetId?: string; type?: string; url?: string } }
        const info = p.targetInfo
        // For iframe targets, targetId === the frameId of the frame it hosts.
        if (p.sessionId && info?.type === 'iframe' && info.targetId) {
          this.stateFor(tabId).frameSessions.set(info.targetId, { sessionId: p.sessionId, url: info.url ?? '' })
          debugLog.log('cdp', `OOPIF attached on tab ${tabId}`, { frameId: info.targetId, url: info.url?.slice(0, 80) })
          // Nested OOPIFs: auto-attach recursively (best-effort).
          void this.sendSession(tabId, p.sessionId, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS).catch(() => {})
        }
      } else if (method === 'Target.detachedFromTarget') {
        const p = params as { sessionId?: string }
        const st = this.tabState.get(tabId)
        if (st && p.sessionId) {
          for (const [fid, s] of st.frameSessions) {
            if (s.sessionId === p.sessionId) st.frameSessions.delete(fid)
          }
        }
      }
    })
  }

  /** Fold Network.* lifecycle events into the tab's ring-buffered request log. */
  private onNetworkEvent(tabId: number, method: string, params: unknown): void {
    const st = this.tabState.get(tabId)
    if (!st) return
    if (method === 'Network.requestWillBeSent') {
      const p = params as RequestWillBeSentParams
      const existing = st.netLog.get(p.requestId)
      if (existing && p.redirectResponse) {
        // Redirect reuses the requestId — track the final URL, reset the status.
        existing.url = p.request?.url ?? existing.url
        existing.status = undefined
        existing.finished = false
        return
      }
      const entry: NetworkRequestEntry = {
        requestId: p.requestId,
        url: p.request?.url ?? '',
        method: p.request?.method ?? 'GET',
        resourceType: p.type ?? 'Other',
        postData: p.request?.postData?.slice(0, NET_LOG_MAX_POST_DATA),
        hasPostData: p.request?.hasPostData || p.request?.postData !== undefined || undefined,
        finished: false,
        ts: Date.now(),
      }
      st.netLog.set(p.requestId, entry)
      if (st.netLog.size > NET_LOG_MAX_ENTRIES) {
        const oldest = st.netLog.keys().next().value
        if (oldest !== undefined) st.netLog.delete(oldest)
      }
    } else if (method === 'Network.responseReceived') {
      const p = params as ResponseReceivedParams
      const entry = st.netLog.get(p.requestId)
      if (entry) {
        entry.status = p.response?.status
        entry.mimeType = p.response?.mimeType
      }
    } else if (method === 'Network.loadingFinished') {
      const p = params as LoadingFinishedParams
      const entry = st.netLog.get(p.requestId)
      if (entry) entry.finished = true
    } else if (method === 'Network.loadingFailed') {
      const p = params as LoadingFailedParams
      const entry = st.netLog.get(p.requestId)
      if (entry) entry.failed = p.canceled ? 'canceled' : (p.errorText ?? 'failed')
    }
  }

  private stateFor(tabId: number): TabState {
    let st = this.tabState.get(tabId)
    if (!st) {
      st = { refMap: new Map(), dialogOpen: false, netLog: new Map(), frameSessions: new Map() }
      this.tabState.set(tabId, st)
    }
    return st
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return
    const diagnostic = beginDiagnosticOperation('cdp', 'Debugger.attach', { tabId })
    diagnostic.update('waiting for debugger attachment')
    try {
      try {
        await chrome.debugger.attach({ tabId }, CDP_VERSION)
      } catch (err) {
        const msg = errMsg(err)
        // If already attached (e.g. our own prior attach that we lost track of),
        // treat as success; otherwise surface a readable error.
        if (msg.includes('Another debugger is already attached')) {
          debugLog.error('cdp', `attach tab ${tabId} — another debugger attached (close DevTools?)`, err)
          throw new Error(`Cannot attach to tab ${tabId}: another debugger is already attached (is DevTools open on that tab? close it).`)
        }
        if (msg.includes('No tab with given id')) {
          debugLog.error('cdp', `attach tab ${tabId} — tab not found`, err)
          const tabList = await this.tabListSummary()
          throw new Error(`Cannot attach to tab ${tabId}: no tab with that id (it may have closed).${tabList ? `\n\n${tabList}` : ''}`)
        }
        if (msg.includes('chrome-extension://')) {
          debugLog.error('cdp', `attach tab ${tabId} — chrome-extension viewer`, err)
          throw new Error(`Cannot attach to tab ${tabId}: this is a chrome-extension:// viewer page (e.g. Chrome's built-in PDF viewer), which the debugger cannot attach to. If you need this file, use filesystem_import_url instead of interacting with this tab.`)
        }
        if (!msg.includes('already attached')) {
          debugLog.error('cdp', `attach tab ${tabId}`, err)
          throw err
        }
      }
      this.attached.add(tabId)
      this.stateFor(tabId)
      diagnostic.update('enabling CDP domains')
      await this.enableDomains(tabId)
      debugLog.log('cdp', `attached tab ${tabId}`)
    } catch (error) { diagnostic.finish(error); throw error }
    finally { diagnostic.finish() }
  }

  private async enableDomains(tabId: number): Promise<void> {
    // Fresh sessions start with all domains disabled → enable every attach.
    for (const domain of ['Page', 'DOM', 'Runtime', 'Accessibility']) {
      await timeout(rawSend<void>(tabId, `${domain}.enable`), ENABLE_TIMEOUT_MS, `${domain}.enable`)
    }
    // Network is enabled from attach (not on demand) so the log already holds
    // the requests behind whatever the agent just did in the UI by the time it
    // decides to look — the discover-then-replay flow depends on that. It is
    // OBSERVATION ONLY (never Fetch.enable interception, which sits in the
    // request path) and best-effort: a failure must not degrade the UI tools.
    try {
      await timeout(
        rawSend<void>(tabId, 'Network.enable', {
          maxTotalBufferSize: NET_MAX_TOTAL_BUFFER,
          maxResourceBufferSize: NET_MAX_RESOURCE_BUFFER,
        }),
        ENABLE_TIMEOUT_MS,
        'Network.enable',
      )
    } catch (err) {
      debugLog.log('cdp', `Network.enable failed on tab ${tabId} (net log unavailable, continuing)`, errMsg(err))
    }
    // OOPIF support: auto-attach to cross-process iframe targets so
    // frames.eval/click can reach them. Best-effort: fails on Chrome < 125
    // (no flat session routing) — frames.* then covers local frames only.
    try {
      await timeout(rawSend<void>(tabId, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS), ENABLE_TIMEOUT_MS, 'Target.setAutoAttach')
    } catch (err) {
      debugLog.log('cdp', `Target.setAutoAttach failed on tab ${tabId} (OOPIF frames unavailable, continuing)`, errMsg(err))
    }
  }

  async detach(tabId: number): Promise<void> {
    await this.activityCursor.hide(tabId, true)
    if (!this.attached.has(tabId)) return
    try {
      await chrome.debugger.detach({ tabId })
    } catch (err) {
      // Detaching an already-gone session is fine.
      debugLog.log('cdp', `detach tab ${tabId} (ignored error)`, errMsg(err))
    }
    this.attached.delete(tabId)
    this.tabState.delete(tabId)
    debugLog.log('cdp', `detached tab ${tabId}`)
  }

  async detachAll(): Promise<void> {
    const ids = [...this.attached]
    for (const id of ids) await this.detach(id)
  }

  async send<T = unknown>(tabId: number, method: string, params?: object, signal?: AbortSignal): Promise<T> {
    const diagnostic = beginDiagnosticOperation('cdp', method, { tabId })
    diagnostic.update('attaching to tab')
    try {
      throwIfAborted(signal)
      await this.attach(tabId)
      throwIfAborted(signal)
      // Soft hide: the host keeps the last position so the new document can
      // re-materialize the pointer where it was.
      if (method === 'Page.navigate' || method === 'Page.reload') this.activityCursor.hideOnNavigate(tabId)
      else if (method === 'Input.dispatchMouseEvent') {
        const input = params as { type?: string; x?: number; y?: number; deltaY?: number } | undefined
        if (input?.type !== 'mouseReleased') {
          this.activityCursor.show(tabId, {
            kind: input?.type === 'mousePressed' ? 'click' : input?.type === 'mouseWheel' ? 'scroll' : 'move',
            x: input?.x, y: input?.y,
            ...(input?.type === 'mouseWheel' ? { dy: input?.deltaY } : {}),
          }, signal)
        }
      } else if (method === 'Input.dispatchKeyEvent' || method === 'Input.insertText') {
        this.activityCursor.show(tabId, { kind: 'type' }, signal)
      }
      const execute = async (): Promise<T> => {
        diagnostic.update('waiting for Chrome reply', { timeoutMs: COMMAND_TIMEOUT_MS })
        throwIfAborted(signal)
        try {
          return await timeout(rawSend<T>(tabId, method, params), COMMAND_TIMEOUT_MS, `${method} on tab ${tabId}`)
        } catch (err) {
          const msg = errMsg(err)
          if (isDetachedError(msg)) {
            // Reattach once and retry.
            debugLog.log('cdp', `retrying ${method} on tab ${tabId} after detach`)
            this.attached.delete(tabId)
            throwIfAborted(signal)
            await this.attach(tabId)
            throwIfAborted(signal)
            return await timeout(rawSend<T>(tabId, method, params), COMMAND_TIMEOUT_MS, `${method} on tab ${tabId} (after reattach)`)
          }
          throw err
        }
      }
      const capture = method === 'Page.captureScreenshot'
      const perceive = capture || method === 'Accessibility.getFullAXTree'
      const command = capture ? () => this.activityCursor.withoutCursor(tabId, execute) : execute
      return await (perceive || method.startsWith('Input.')
        ? withoutStickyOverlay(tabId, perceive, command)
        : command())
    } catch (error) { diagnostic.finish(error); throw error }
    finally { diagnostic.finish() }
  }

  /** Bound send fn for a specific tab (used by ax-tree). */
  private sendFor(tabId: number): SendFn {
    return <T = unknown>(method: string, params?: object) => this.send<T>(tabId, method, params)
  }

  /** sendCommand routed to a flat child session (OOPIF target). No reattach retry — if the session died, the frame is gone; frames.list shows current state. */
  private sendSession<T = unknown>(tabId: number, sessionId: string, method: string, params?: object): Promise<T> {
    const p = new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId, sessionId }, method, (params ?? {}) as { [k: string]: unknown }, (result) => {
        const lastError = chrome.runtime.lastError
        if (lastError) {
          reject(new Error(lastError.message ?? `CDP error in ${method}`))
          return
        }
        resolve(result as T)
      })
    })
    return timeout(p, COMMAND_TIMEOUT_MS, `${method} on tab ${tabId} (frame session)`)
  }

  async snapshot(tabId: number, visibleTabIds?: number[]): Promise<SnapshotResult> {
    await this.attach(tabId)
    const st = this.stateFor(tabId)
    // Concurrent observers share live reference identity, but never a delivery
    // baseline. Serialize capture so an older capture cannot replace newer refs.
    const capture = (st.snapshotPending ?? Promise.resolve()).catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const references = st.snapshotReferences ??= new SnapshotReferences()
        const { url, title } = await this.pageInfo(tabId)
        const tabList = await this.tabListSummary(visibleTabIds)
        const { text, refMap, refDescriptions } = await buildSnapshot(this.sendFor(tabId), { tabId, url, title, tabList }, references)
        if (this.tabState.get(tabId) !== st) throw new Error('Browser detached during snapshot')
        if (st.snapshotReferences !== references) continue // navigation during capture
        st.refMap = refMap // removed refs expire; unchanged refs keep their target
        st.refDescriptions = refDescriptions
        debugLog.log('cdp', `snapshot tab ${tabId}`, { refs: refMap.size, chars: text.length })
        return { tabId, url, title, text }
      }
      throw new Error('Page changed during snapshot; take a fresh browser_snapshot')
    })
    st.snapshotPending = capture
    try { return await capture } finally { if (st.snapshotPending === capture) st.snapshotPending = undefined }
  }

  private async pageInfo(tabId: number): Promise<{ url: string; title: string }> {
    try {
      const info = await this.evalInPage<{ url: string; title: string }>(
        tabId,
        'return { url: location.href, title: document.title }',
        { statement: true },
      )
      return { url: info?.url ?? '', title: info?.title ?? '' }
    } catch {
      // Fall back to chrome.tabs if the page thread is unavailable.
      try {
        const tab = await chrome.tabs.get(tabId)
        return { url: tab.url ?? '', title: tab.title ?? '' }
      } catch {
        return { url: '', title: '' }
      }
    }
  }

  private async tabListSummary(visibleTabIds?: number[]): Promise<string> {
    try {
      const tabs = await chrome.tabs.query({})
      const items = tabs
        .filter((t) => t.id !== undefined && (!visibleTabIds || visibleTabIds.includes(t.id)))
        .map((t) => `  tab ${t.id}${t.active ? '*' : ''}: ${(t.title ?? '').slice(0, 50)} — ${(t.url ?? '').slice(0, 80)}`)
      if (items.length === 0) return ''
      return `Tabs:\n${items.join('\n')}`
    } catch {
      return ''
    }
  }

  describeRef(tabId: number, ref: string): { role: string; name: string } | undefined {
    const state = this.tabState.get(tabId)
    if (!state?.refMap.has(ref)) return undefined
    return state.refDescriptions?.get(ref)
  }

  /** Resolve a ref to its backendDOMNodeId for the given tab, or throw. */
  private resolveRef(tabId: number, ref: string): number {
    const st = this.tabState.get(tabId)
    const id = st?.refMap.get(ref)
    if (id === undefined) {
      throw new Error(`unknown element ref "${ref}" in tab ${tabId} — its snapshot refs are unavailable or expired; use refs from a fresh browser_snapshot`)
    }
    return id
  }

  /** Scroll into view + compute the element center in CSS px. */
  private async centerOf(tabId: number, backendNodeId: number, signal?: AbortSignal): Promise<Point> {
    throwIfAborted(signal)
    try {
      await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }, signal)
    } catch (err) {
      // Non-fatal: element may already be in view or not scrollable.
      debugLog.log('cdp', `scrollIntoViewIfNeeded failed (continuing)`, errMsg(err))
    }

    // Prefer content quads (handles inline/wrapped elements); fall back to box model.
    try {
      const quads = await this.send<GetContentQuadsResult>(tabId, 'DOM.getContentQuads', { backendNodeId }, signal)
      const quad = quads.quads?.[0]
      if (quad && quad.length >= 8) {
        const xs = [quad[0], quad[2], quad[4], quad[6]].filter((n): n is number => typeof n === 'number')
        const ys = [quad[1], quad[3], quad[5], quad[7]].filter((n): n is number => typeof n === 'number')
        const x = xs.reduce((a, b) => a + b, 0) / xs.length
        const y = ys.reduce((a, b) => a + b, 0) / ys.length
        return { x, y }
      }
    } catch {
      // Fall through to box model.
    }

    const box = await this.send<GetBoxModelResult>(tabId, 'DOM.getBoxModel', { backendNodeId }, signal)
    const content = box.model?.content
    if (content && content.length >= 8) {
      const x0 = content[0] ?? 0
      const y0 = content[1] ?? 0
      const x2 = content[4] ?? 0
      const y2 = content[5] ?? 0
      return { x: (x0 + x2) / 2, y: (y0 + y2) / 2 }
    }
    throw new Error(`could not compute coordinates for ref (no quads/box model)`)
  }

  /**
   * A durable CSS selector for a snapshot ref, so callers can remember an
   * element past the life of the ref map (stickies pin to one). Prefers a
   * unique id / test attribute, else a short structural path; throws when the
   * element cannot be named uniquely (shadow DOM, generated-looking ids).
   */
  async selectorForRef(tabId: number, ref: string, signal?: AbortSignal): Promise<{ selector: string; label: string }> {
    const backendNodeId = this.resolveRef(tabId, ref)
    const resolved = await this.send<ResolveNodeResult>(tabId, 'DOM.resolveNode', { backendNodeId }, signal)
    const objectId = resolved.object?.objectId
    if (!objectId) throw new Error(`could not resolve ref "${ref}" in tab ${tabId} to a DOM element`)
    const result = await this.send<EvaluateResult>(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SELECTOR_FN,
      returnByValue: true,
    }, signal)
    const value = result.result?.value as { selector?: string; label?: string } | undefined
    if (!value?.selector) {
      throw new Error(`no stable CSS selector for ref "${ref}" (it may live in a shadow root or an iframe) — place the sticky by corner or x/y instead`)
    }
    debugLog.log('cdp', `selector for ${ref} on tab ${tabId}`, value.selector)
    return { selector: value.selector, label: value.label ?? '' }
  }

  async click(tabId: number, ref: string, signal?: AbortSignal): Promise<void> {
    const backendNodeId = this.resolveRef(tabId, ref)
    const { x, y } = await this.centerOf(tabId, backendNodeId, signal)
    // Let the pointer reach the target before the press lands under it. Bounded
    // and cosmetic: any failure resolves immediately.
    await this.activityCursor.showAndWait(tabId, { kind: 'move', x, y }, signal)
    // Optional hover to trigger hover handlers.
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, signal)
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, signal)
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, signal)
    debugLog.log('cdp', `click ${ref} on tab ${tabId}`, { x: Math.round(x), y: Math.round(y) })
  }

  /** Focus the element behind a backendNodeId (DOM.focus, fall back to JS click-free focus). */
  private async focusNode(tabId: number, backendNodeId: number, signal?: AbortSignal): Promise<string | undefined> {
    // Resolve to a JS object for later input/change dispatch, and focus it.
    let objectId: string | undefined
    try {
      const resolved = await this.send<ResolveNodeResult>(tabId, 'DOM.resolveNode', { backendNodeId }, signal)
      objectId = resolved.object?.objectId
    } catch {
      objectId = undefined
    }
    try {
      await this.send(tabId, 'DOM.focus', { backendNodeId }, signal)
    } catch (err) {
      // Fall back to focusing via JS if DOM.focus is unsupported for the node.
      if (objectId) {
        await this.send(tabId, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){ this.focus && this.focus(); }',
          awaitPromise: false,
        }, signal)
      } else {
        debugLog.log('cdp', `focus failed (continuing)`, errMsg(err))
      }
    }
    return objectId
  }

  async type(tabId: number, ref: string, text: string, opts?: { clear?: boolean; submit?: boolean; signal?: AbortSignal }): Promise<void> {
    const signal = opts?.signal
    const backendNodeId = this.resolveRef(tabId, ref)
    const at = await this.centerOf(tabId, backendNodeId, signal) // scroll into view
    // Travel to the field before focusing it, so typing doesn't appear from nowhere.
    await this.activityCursor.showAndWait(tabId, { kind: 'move', x: at.x, y: at.y }, signal)
    const objectId = await this.focusNode(tabId, backendNodeId, signal)

    if (opts?.clear) {
      // Select-all then Backspace (framework-safe clearing); cmd+a on macOS.
      await this.dispatchKey(SELECT_ALL_COMBO, tabId, signal)
      // Native editing shortcuts can be intercepted (or mapped differently by
      // Chrome/macOS). Select standard text controls explicitly before deleting
      // so clear never silently leaves a prefix behind. Keep the keyboard path
      // for contenteditable and input types without selection support.
      if (objectId) {
        await this.send(tabId, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){ if ((this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) && this.selectionStart !== null) this.select(); }',
          awaitPromise: false,
        }, signal)
      }
      await this.dispatchKey('Backspace', tabId, signal)
    }

    // Per-character real key events so React/Vue listeners fire.
    for (const ch of [...text]) {
      await this.typeChar(tabId, ch, signal)
    }

    // Dispatch bubbling synthetic input + change so frameworks reconcile state.
    if (objectId) {
      await this.send(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration:
          'function(){ this.dispatchEvent(new Event("input", {bubbles:true})); this.dispatchEvent(new Event("change", {bubbles:true})); }',
        awaitPromise: false,
      }, signal)
    }

    if (opts?.submit) {
      await this.dispatchKey('Enter', tabId, signal)
    }
    debugLog.log('cdp', `type ${ref} on tab ${tabId}`, { len: text.length, clear: !!opts?.clear, submit: !!opts?.submit })
  }

  async attachFiles(
    tabId: number,
    target: PageAttachmentTarget,
    files: PageAttachmentFile[],
    signal?: AbortSignal,
  ): Promise<PageAttachmentResult> {
    throwIfAborted(signal)
    if (files.length === 0) throw new Error('attachFiles requires at least one file')
    if (target.ref && target.selector) throw new Error('attachFiles target accepts ref or selector, not both')

    await this.attach(tabId)
    throwIfAborted(signal)
    let objectId: string | undefined
    if (target.ref) {
      const backendNodeId = this.resolveRef(tabId, target.ref)
      const resolved = await this.send<ResolveNodeResult>(tabId, 'DOM.resolveNode', { backendNodeId }, signal)
      objectId = resolved.object?.objectId
    } else {
      const selector = target.selector
      const expression = selector
        ? `document.querySelector(${JSON.stringify(selector)})`
        : '(document.activeElement || document.body || document.documentElement)'
      const evaluated = await this.send<EvaluateResult>(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: false,
        awaitPromise: false,
      }, signal)
      if (evaluated.exceptionDetails) throw this.exceptionError(evaluated.exceptionDetails)
      objectId = evaluated.result?.objectId
      if (!objectId || evaluated.result?.subtype === 'null') {
        throw new Error(selector ? `no element matches selector ${JSON.stringify(selector)}` : 'page has no attachment target')
      }
    }
    if (!objectId) throw new Error('could not resolve attachment target to a page element')

    const stagingKey = `__aiExtensionFiles_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const metadata = files.map((file) => ({
      name: file.name,
      type: file.mediaType || 'application/octet-stream',
      size: file.size,
      lastModified: file.lastModified ?? Date.now(),
    }))
    const init = await this.send<EvaluateResult>(tabId, 'Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(stagingKey)}]={meta:${JSON.stringify(metadata)},chunks:${JSON.stringify(files.map(() => []))}}`,
      returnByValue: true,
    }, signal)
    if (init.exceptionDetails) throw this.exceptionError(init.exceptionDetails)

    try {
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        throwIfAborted(signal)
        const base64 = files[fileIndex]!.base64
        for (let offset = 0; offset < base64.length; offset += FILE_TRANSFER_CHUNK_CHARS) {
          const chunk = base64.slice(offset, offset + FILE_TRANSFER_CHUNK_CHARS)
          const pushed = await this.send<EvaluateResult>(tabId, 'Runtime.evaluate', {
            expression: `globalThis[${JSON.stringify(stagingKey)}].chunks[${fileIndex}].push(${JSON.stringify(chunk)})`,
            returnByValue: true,
          }, signal)
          if (pushed.exceptionDetails) throw this.exceptionError(pushed.exceptionDetails)
        }
      }

      // The drop/input dispatch is pure JS, so the pointer would never move:
      // put it on the target first. Best-effort, never awaited for correctness.
      await this.cueAt(tabId, objectId, 'click', signal)

      const result = await this.send<EvaluateResult>(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(stagingKey, requestedMode) {
          const staged = globalThis[stagingKey]
          if (!staged) throw new Error('file transfer staging data is missing')
          const files = staged.meta.map((meta, fileIndex) => {
            const parts = staged.chunks[fileIndex].map((chunk) => {
              const binary = atob(chunk)
              const bytes = new Uint8Array(binary.length)
              for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
              return bytes
            })
            return new File(parts, meta.name, { type: meta.type, lastModified: meta.lastModified })
          })
          const transfer = new DataTransfer()
          for (const file of files) transfer.items.add(file)

          const isFileInput = (node) => node instanceof HTMLInputElement && node.type === 'file'
          const input = isFileInput(this) ? this : this.querySelector?.('input[type="file"]')
          const mode = requestedMode === 'auto' ? (input ? 'input' : 'drop') : requestedMode
          let target = this
          if (mode === 'input') {
            if (!input) throw new Error('attachment target is not and does not contain an input[type=file]; use mode "drop" for a drop zone')
            target = input
            input.files = transfer.files
            input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
            input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
          } else {
            for (const type of ['dragenter', 'dragover', 'drop']) {
              target.dispatchEvent(new DragEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                dataTransfer: transfer,
              }))
            }
          }
          return {
            ok: true,
            mode,
            target: target.tagName?.toLowerCase() || 'unknown',
            count: files.length,
            names: files.map((file) => file.name),
          }
        }`,
        arguments: [
          { value: stagingKey },
          { value: target.mode ?? 'auto' },
        ],
        awaitPromise: false,
        returnByValue: true,
        userGesture: true,
      }, signal)
      if (result.exceptionDetails) throw this.exceptionError(result.exceptionDetails)
      const value = result.result?.value as PageAttachmentResult | undefined
      if (!value?.ok) throw new Error('page did not return an attachment result')
      debugLog.log('cdp', `attached ${files.length} file(s) on tab ${tabId}`, {
        mode: value.mode,
        target: target.ref ?? target.selector ?? 'active element',
        bytes: files.reduce((sum, file) => sum + file.size, 0),
      })
      return value
    } finally {
      await this.send(tabId, 'Runtime.evaluate', {
        expression: `delete globalThis[${JSON.stringify(stagingKey)}]`,
        returnByValue: true,
      }).catch(() => {})
      await this.send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {})
    }
  }

  /**
   * Put the pointer on a node the agent is about to act on through JS (no
   * Input.* event will do it). Cosmetic: any failure is swallowed.
   */
  private async cueAt(tabId: number, objectId: string, kind: 'click' | 'move', signal?: AbortSignal): Promise<void> {
    try {
      const described = await this.send<{ node?: { backendNodeId?: number } }>(tabId, 'DOM.describeNode', { objectId }, signal)
      const backendNodeId = described.node?.backendNodeId
      if (backendNodeId === undefined) return
      const { x, y } = await this.centerOf(tabId, backendNodeId, signal)
      await this.activityCursor.showAndWait(tabId, { kind, x, y }, signal)
    } catch (err) {
      debugLog.log('cdp', 'cursor cue skipped', errMsg(err))
    }
  }

  private exceptionError(ex: NonNullable<EvaluateResult['exceptionDetails']>): Error {
    const detail = ex.exception?.description ?? ex.exception?.value ?? ex.text ?? 'page JavaScript failed'
    return new Error(String(detail))
  }

  /** Dispatch a single printable character as keyDown+char+keyUp. */
  private async typeChar(tabId: number, ch: string, signal?: AbortSignal): Promise<void> {
    // Space uses the named table; other single chars map to themselves.
    const base = ch === ' ' ? 'space' : ch
    const events = keyEventSequence(base, 0)
    for (const ev of events) {
      const { type, ...rest } = ev
      await this.send(tabId, 'Input.dispatchKeyEvent', { type, ...rest }, signal)
    }
  }

  private async dispatchKey(combo: string, tabId: number, signal?: AbortSignal): Promise<void> {
    const { baseKey, modifiers } = parseCombo(combo)
    const events = keyEventSequence(baseKey, modifiers)
    for (const ev of events) {
      const { type, ...rest } = ev
      await this.send(tabId, 'Input.dispatchKeyEvent', { type, ...rest }, signal)
    }
  }

  async pressKey(tabId: number, key: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    await this.attach(tabId)
    throwIfAborted(signal)
    await this.dispatchKey(key, tabId, signal)
    debugLog.log('cdp', `pressKey "${key}" on tab ${tabId}`)
  }

  async scroll(tabId: number, opts: { ref?: string; dy?: number; signal?: AbortSignal }): Promise<void> {
    const signal = opts.signal
    throwIfAborted(signal)
    await this.attach(tabId)
    throwIfAborted(signal)
    const dy = opts.dy ?? 300
    let point: Point
    if (opts.ref) {
      const backendNodeId = this.resolveRef(tabId, opts.ref)
      point = await this.centerOf(tabId, backendNodeId, signal)
    } else {
      // Scroll around the viewport center.
      const vp = await this.evalInPage<{ w: number; h: number }>(
        tabId,
        'return { w: window.innerWidth, h: window.innerHeight }',
        { statement: true, signal },
      )
      point = { x: Math.floor((vp?.w ?? 800) / 2), y: Math.floor((vp?.h ?? 600) / 2) }
    }
    await this.activityCursor.showAndWait(tabId, { kind: 'move', x: point.x, y: point.y }, signal)
    await this.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: dy,
    }, signal)
    debugLog.log('cdp', `scroll on tab ${tabId}`, { dy, ref: opts.ref })
  }

  async navigate(tabId: number, url: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    await this.attach(tabId)
    throwIfAborted(signal)
    const res = await this.send<NavigateResult>(tabId, 'Page.navigate', { url }, signal)
    if (res.errorText) {
      throw new Error(`navigate to ${url} failed: ${res.errorText}`)
    }
    debugLog.log('cdp', `navigate tab ${tabId}`, url)
  }

  async waitForLoad(tabId: number, timeoutMs = DEFAULT_LOAD_TIMEOUT_MS, signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal)
    await this.attach(tabId)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      // A native dialog freezes the page thread — don't hang polling JS.
      if (this.tabState.get(tabId)?.dialogOpen) {
        debugLog.log('cdp', `waitForLoad tab ${tabId} — dialog open, aborting wait`)
        return false
      }
      try {
        const ready = await this.evalInPage<string>(tabId, 'return document.readyState', { statement: true, signal })
        if (ready === 'complete') {
          debugLog.log('cdp', `waitForLoad tab ${tabId} complete`)
          return true
        }
      } catch (err) {
        // Transient during navigation; keep polling until deadline.
        debugLog.log('cdp', `waitForLoad poll error (continuing)`, errMsg(err))
      }
      await abortableDelay(LOAD_POLL_INTERVAL_MS, signal)
    }
    debugLog.log('cdp', `waitForLoad tab ${tabId} timed out after ${timeoutMs}ms`)
    return false
  }

  async screenshot(tabId: number): Promise<{ base64: string; mediaType: string }> {
    await this.attach(tabId)
    const res = await this.send<CaptureScreenshotResult>(tabId, 'Page.captureScreenshot', { format: 'png' })
    debugLog.log('cdp', `screenshot tab ${tabId}`, { bytes: res.data.length })
    return { base64: res.data, mediaType: 'image/png' }
  }

  networkRequests(tabId: number): NetworkRequestEntry[] {
    const st = this.tabState.get(tabId)
    return st ? [...st.netLog.values()] : []
  }

  async networkResponseBody(tabId: number, requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    const st = this.tabState.get(tabId)
    if (!st || st.netLog.size === 0) {
      throw new Error(`no network log for tab ${tabId} — the log only captures requests made while the tab is attached (act on the tab first, e.g. snapshot or reload it)`)
    }
    try {
      return await this.send<{ body: string; base64Encoded: boolean }>(tabId, 'Network.getResponseBody', { requestId })
    } catch (err) {
      throw new Error(
        `could not read body for request ${requestId}: ${errMsg(err)}. Bodies are evicted on navigation or buffer pressure — re-trigger the request and read it promptly, or replay it with api.page.fetch.`,
      )
    }
  }

  async listFrames(tabId: number): Promise<FrameInfo[]> {
    await this.attach(tabId)
    const st = this.stateFor(tabId)
    const out: FrameInfo[] = []
    const seen = new Set<string>()

    // 1. Local (same-process) frames — actionable via the main session.
    //    Page.getFrameTree only reports frames hosted in this tab's process;
    //    OOPIF subtrees live in their own targets and are found in pass 2/3.
    const tree = await this.send<GetFrameTreeResult>(tabId, 'Page.getFrameTree')
    const walk = (node: FrameTreeNode, main: boolean): void => {
      const f = node.frame
      if (seen.has(f.id)) return
      seen.add(f.id)
      out.push({
        frameId: f.id,
        url: f.url ?? '',
        ...(f.name ? { name: f.name } : {}),
        ...(f.parentId ? { parentFrameId: f.parentId } : {}),
        ...(main ? { main: true } : {}),
      })
      for (const c of node.childFrames ?? []) walk(c, false)
    }
    walk(tree.frameTree, true)

    // 2. Cross-process iframes (OOPIFs): scan <iframe>/<frame> elements in
    //    the top document. DOM.describeNode reports the owner element's
    //    frameId even when the frame lives in another process. depth:0 keeps
    //    this cheap on giant DOMs (never a full-depth document walk).
    try {
      const doc = await this.send<GetDocumentResult>(tabId, 'DOM.getDocument', { depth: 0 })
      const rootId = doc.root?.nodeId
      if (rootId !== undefined) {
        const found = await this.send<QuerySelectorAllResult>(tabId, 'DOM.querySelectorAll', {
          nodeId: rootId,
          selector: 'iframe, frame',
        })
        for (const nodeId of (found.nodeIds ?? []).slice(0, MAX_FRAME_SCAN)) {
          try {
            const desc = await this.send<DescribeNodeFrameResult>(tabId, 'DOM.describeNode', { nodeId })
            const frameId = desc.node?.frameId
            if (!frameId || seen.has(frameId)) continue
            seen.add(frameId)
            const attrs = desc.node?.attributes ?? []
            const attr = (name: string): string | undefined => {
              for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i] === name) return attrs[i + 1]
              return undefined
            }
            const sess = st.frameSessions.get(frameId)
            const frameName = attr('name')
            out.push({
              frameId,
              url: sess?.url || attr('src') || '',
              ...(frameName ? { name: frameName } : {}),
              oopif: true,
              attached: sess !== undefined,
            })
          } catch {
            // Element vanished between query and describe; skip it.
          }
        }
      }
    } catch (err) {
      debugLog.log('cdp', `frame element scan failed on tab ${tabId} (continuing)`, errMsg(err))
    }

    // 3. Attached OOPIF sessions the element scan missed (iframes nested
    //    inside other frames or shadow roots).
    for (const [frameId, sess] of st.frameSessions) {
      if (seen.has(frameId)) continue
      seen.add(frameId)
      out.push({ frameId, url: sess.url, oopif: true, attached: true })
    }

    debugLog.log('cdp', `listFrames tab ${tabId}`, { frames: out.length })
    return out
  }

  async evalInFrame<T = unknown>(
    tabId: number,
    frameId: string,
    expression: string,
    opts?: { statement?: boolean; signal?: AbortSignal },
  ): Promise<T> {
    const signal = opts?.signal
    throwIfAborted(signal)
    await this.attach(tabId)
    throwIfAborted(signal)
    const st = this.stateFor(tabId)
    const sess = st.frameSessions.get(frameId)
    // OOPIF frames route to their child session; local frames to the tab session.
    const send: SendFn = sess
      ? <R = unknown>(method: string, params?: object) => this.sendSession<R>(tabId, sess.sessionId, method, params)
      : this.sendFor(tabId)

    if (sess && !sess.domainsEnabled) {
      // Child sessions start with all domains disabled. Best-effort, once.
      try {
        throwIfAborted(signal)
        await send('Page.enable')
        throwIfAborted(signal)
        await send('Runtime.enable')
      } catch (err) {
        debugLog.log('cdp', `frame session enable failed (continuing)`, errMsg(err))
      }
      sess.domainsEnabled = true
    }

    let contextId: number
    try {
      throwIfAborted(signal)
      const world = await send<CreateIsolatedWorldResult>('Page.createIsolatedWorld', {
        frameId,
        worldName: FRAMES_WORLD_NAME,
      })
      if (world.executionContextId === undefined) throw new Error('no executionContextId returned')
      contextId = world.executionContextId
    } catch (err) {
      throw new Error(
        `cannot reach frame ${frameId} on tab ${tabId}: ${errMsg(err)}. ` +
          `frameIds change when a frame navigates — re-run api.frames.list(${tabId}) for current ids. ` +
          `If the frame is listed with oopif:true and attached:false, it is cross-process and no debugger session is attached to it (needs Chrome 125+).`,
      )
    }

    const evaluate = (wrapped: string) => {
      throwIfAborted(signal)
      return send<EvaluateResult>('Runtime.evaluate', {
        expression: wrapped,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      })
    }
    // Two-pass wrapper (same contract as api.page.eval): expression form
    // first so bare expressions produce a value; statement form on
    // SyntaxError (safe to re-run — the snippet never executed).
    const asStatements = `(async () => { ${expression} })()`
    let res: EvaluateResult
    if (opts?.statement) {
      res = await evaluate(asStatements)
    } else {
      res = await evaluate(`(async () => { return (${expression}\n) })()`)
      if (res.exceptionDetails && isSyntaxError(res.exceptionDetails)) {
        throwIfAborted(signal)
        res = await evaluate(asStatements)
      }
    }
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails
      const detail =
        ex.exception?.description ??
        (typeof ex.exception?.value === 'string' ? ex.exception.value : undefined) ??
        ex.text ??
        'evaluation error'
      throw new Error(`frames.eval error in frame ${frameId}: ${detail}`)
    }
    return res.result?.value as T
  }

  async clickInFrame(tabId: number, frameId: string, selector: string, signal?: AbortSignal): Promise<{ ok: boolean; tag?: string; text?: string }> {
    // The in-frame click is synthesized JS, so nothing moves the pointer. The
    // owning <iframe>'s box in the top document is coarse but honest.
    try {
      const owner = await this.send<{ backendNodeId?: number }>(tabId, 'DOM.getFrameOwner', { frameId }, signal)
      if (owner.backendNodeId !== undefined) {
        const { x, y } = await this.centerOf(tabId, owner.backendNodeId, signal)
        await this.activityCursor.showAndWait(tabId, { kind: 'click', x, y }, signal)
      }
    } catch (err) {
      debugLog.log('cdp', 'frame cursor cue skipped', errMsg(err))
    }
    const sel = JSON.stringify(selector)
    // Synthesized in-frame click: no cross-frame coordinate math, no
    // Input.dispatchMouseEvent (the corpus's timeout class on OOPIF tabs).
    // Tradeoff: events are isTrusted:false — sites verifying trusted input
    // need coordinate dispatch via api.cdp instead (documented in prompt).
    const snippet = `
      const el = document.querySelector(${sel})
      if (!el) {
        const n = document.querySelectorAll('a, button, input, select, textarea, [role], [onclick]').length
        throw new Error('no element in this frame matches ' + ${sel} + ' — ' + n + ' interactive-ish elements present; explore with frames.eval querySelectorAll first')
      }
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
      el.dispatchEvent(new PointerEvent('pointerdown', init))
      el.dispatchEvent(new MouseEvent('mousedown', init))
      el.dispatchEvent(new PointerEvent('pointerup', init))
      el.dispatchEvent(new MouseEvent('mouseup', init))
      if (el instanceof HTMLElement) { el.focus(); el.click() } else { el.dispatchEvent(new MouseEvent('click', init)) }
      return { ok: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 120) }
    `
    const result = await this.evalInFrame<{ ok: boolean; tag?: string; text?: string }>(tabId, frameId, snippet, {
      statement: true,
      signal,
    })
    debugLog.log('cdp', `frames.click tab ${tabId} frame ${frameId.slice(0, 12)}`, { selector: selector.slice(0, 80) })
    return result
  }

  async evalInPage<T = unknown>(tabId: number, expression: string, opts?: { statement?: boolean; signal?: AbortSignal }): Promise<T> {
    const signal = opts?.signal
    throwIfAborted(signal)
    await this.attach(tabId)
    throwIfAborted(signal)
    const evaluate = (wrapped: string) => {
      throwIfAborted(signal)
      return this.send<EvaluateResult>(tabId, 'Runtime.evaluate', {
        expression: wrapped,
        returnByValue: true,
        awaitPromise: true,
      }, signal)
    }
    // Statement wrapper: an IIFE so snippets can use top-level `return`.
    const asStatements = `(async () => { ${expression} })()`
    let res: EvaluateResult
    if (opts?.statement) {
      res = await evaluate(asStatements)
    } else {
      // Pass 1: treat the snippet as a single expression so bare expressions
      // (`document.title`) produce a value instead of a silent undefined.
      // The newline guards against a trailing `//` comment eating the paren.
      res = await evaluate(`(async () => { return (${expression}\n) })()`)
      if (res.exceptionDetails && isSyntaxError(res.exceptionDetails)) {
        // Pass 2: statement form. Safe to re-run — a SyntaxError means
        // pass 1 never executed any of the snippet.
        throwIfAborted(signal)
        res = await evaluate(asStatements)
      }
    }
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails
      const detail =
        ex.exception?.description ??
        (typeof ex.exception?.value === 'string' ? ex.exception.value : undefined) ??
        ex.text ??
        'evaluation error'
      const loc =
        ex.lineNumber !== undefined ? ` (line ${ex.lineNumber}${ex.columnNumber !== undefined ? ':' + ex.columnNumber : ''})` : ''
      throw new Error(`evalInPage error${loc}: ${detail}`)
    }
    return res.result?.value as T
  }
}

/**
 * Runs in the page on the target element: walks up from the element building
 * the shortest selector that still matches it and nothing else.
 */
const SELECTOR_FN = `function () {
  var el = this
  if (!el || el.nodeType !== 1 || !el.ownerDocument || el.getRootNode() !== el.ownerDocument) return {}
  var doc = el.ownerDocument
  var unique = function (sel) { try { return doc.querySelectorAll(sel).length === 1 && doc.querySelector(sel) === el } catch (e) { return false } }
  var stable = function (value) { return /^[A-Za-z][\\w-]{0,40}$/.test(value) && !/^(ember|react|radix|mui|css)-/i.test(value) && !/\\d{4}/.test(value) }
  var esc = function (value) { return window.CSS && CSS.escape ? CSS.escape(value) : value }
  var label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
  if (el.id && stable(el.id) && unique('#' + esc(el.id))) return { selector: '#' + esc(el.id), label: label }
  var attrs = ['data-testid', 'data-test-id', 'data-test', 'name', 'aria-label']
  for (var i = 0; i < attrs.length; i++) {
    var v = el.getAttribute(attrs[i])
    if (v && v.length < 80) {
      var sel = el.tagName.toLowerCase() + '[' + attrs[i] + '=' + JSON.stringify(v) + ']'
      if (unique(sel)) return { selector: sel, label: label }
    }
  }
  var parts = []
  for (var node = el; node && node.nodeType === 1 && node !== doc.documentElement; node = node.parentElement) {
    var part = node.tagName.toLowerCase()
    if (node.id && stable(node.id)) { parts.unshift('#' + esc(node.id)); break }
    var parent = node.parentElement
    if (parent) {
      var same = 0, index = 0
      for (var c = 0; c < parent.children.length; c++) {
        if (parent.children[c].tagName === node.tagName) { same++; if (parent.children[c] === node) index = same }
      }
      if (same > 1) part += ':nth-of-type(' + index + ')'
    }
    parts.unshift(part)
    var candidate = parts.join(' > ')
    if (unique(candidate)) return { selector: candidate, label: label }
    if (parts.length > 8) break
  }
  var full = parts.join(' > ')
  return unique(full) ? { selector: full, label: label } : {}
}`
