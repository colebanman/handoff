/**
 * Agent bridge, side-panel half.
 *
 * Holds a chrome.runtime port open to the service worker for as long as the
 * panel is alive. Two jobs:
 *
 *  1. Run the ops the worker forwards. Chat writes (ask/follow/cancel) go
 *     through the ordinary store actions, so an externally-started chat is
 *     indistinguishable from one the user typed; filesystem ops go straight to
 *     the runtime's VFS, which is what makes push/pull of real files — a resume
 *     to review, a report to hand back — work from a local coding agent.
 *  2. Publish per-chat running/idle transitions, which is how the daemon knows
 *     when a caller's turn has finished.
 *
 * The port doubles as the worker's liveness signal: while it is connected the
 * panel is open, and closing the panel drops it — which is exactly the
 * condition the worker needs to answer `panel_closed`.
 */

import {
  BRIDGE_FILE_MAX_BYTES,
  BRIDGE_PANEL_PORT,
  type BridgeFsList,
  type BridgeFsRead,
  type BridgePanelInbound,
  type BridgePanelOutbound,
  type BridgeRequestFrame,
} from '../shared/bridge-protocol'
import { debugLog } from '../shared/debug-log'
import { getRuntime } from '../runtime'
import type { VfsRoot } from '../shared/types'
import {
  cancelExternalChat,
  createExternalChat,
  readState,
  sendExternalMessage,
  subscribeStore,
  type BridgeActionResult,
} from './store'

const RECONNECT_MS = 2_000
/**
 * A turn does not appear in runningChatIds until its first await settles
 * (ambient context, attachments). Report an accepted chat as running for this
 * long regardless, so a caller waiting for completion cannot observe the gap
 * between "accepted" and "started" as an instant finish.
 */
const START_GRACE_MS = 20_000

let port: chrome.runtime.Port | undefined
let connecting = false
let started = false
let windowId: number | undefined
let unsubscribe: (() => void) | undefined
let graceTimer: number | undefined

/** Last running state published per chat, so only transitions go on the wire. */
const reported = new Map<string, boolean>()
/** Chats accepted from the bridge whose turn has not shown up yet. */
const pendingStart = new Map<string, number>()

function post(message: BridgePanelOutbound): void {
  try {
    port?.postMessage(message)
  } catch {
    // Worker went away mid-post; onDisconnect will reconnect us.
  }
}

/* ---- running-status feed ------------------------------------------------ */

function runningNow(): Set<string> {
  const state = readState()
  const now = Date.now()
  const running = new Set(state.runningChatIds)
  for (const [chatId, deadline] of [...pendingStart]) {
    if (running.has(chatId)) {
      pendingStart.delete(chatId)
      continue
    }
    if (now < deadline) running.add(chatId)
    else pendingStart.delete(chatId)
  }
  return running
}

function describe(chatId: string): { title: string; updatedAt: number } {
  const state = readState()
  if (state.current.id === chatId) return { title: state.current.title, updatedAt: state.current.updatedAt }
  const meta = state.chats.find((entry) => entry.id === chatId)
  return { title: meta?.title ?? 'New chat', updatedAt: meta?.updatedAt ?? Date.now() }
}

function publishStatus(): void {
  if (!port) return
  const running = runningNow()
  for (const chatId of running) {
    if (reported.get(chatId) === true) continue
    reported.set(chatId, true)
    post({ type: 'chat', chatId, running: true, ...describe(chatId) })
  }
  for (const [chatId, wasRunning] of [...reported]) {
    if (!wasRunning || running.has(chatId)) continue
    reported.set(chatId, false)
    post({ type: 'chat', chatId, running: false, ...describe(chatId) })
  }

  // A grace-period chat that never starts produces no further store emits, so
  // schedule the re-check that retires it.
  if (graceTimer !== undefined) {
    window.clearTimeout(graceTimer)
    graceTimer = undefined
  }
  if (pendingStart.size > 0) {
    const soonest = Math.min(...pendingStart.values())
    graceTimer = window.setTimeout(publishStatus, Math.max(250, soonest - Date.now() + 50))
  }
}

/* ---- filesystem ops ----------------------------------------------------- */

/**
 * Callers think in their own filesystem, so be forgiving: a bare name lands in
 * /workspace, a leading root is honoured, and `..` is stripped by the VFS.
 */
function vfsPath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) throw new Error('path is required')
  if (trimmed.startsWith('/workspace/') || trimmed.startsWith('/skills/')) return trimmed
  return `/workspace/${trimmed.replace(/^\/+/, '')}`
}

function tooBig(size: number): Error {
  return new Error(
    `file is ${size} bytes, above the ${BRIDGE_FILE_MAX_BYTES}-byte bridge transfer limit — ` +
      'ask Handoff to work on it in the browser instead of copying it out',
  )
}

async function runFsOp(req: BridgeRequestFrame): Promise<unknown> {
  const { vfs } = getRuntime()
  switch (req.op) {
    case 'fs_list': {
      const root = req.root === 'skills' || req.root === 'workspace' ? (req.root as VfsRoot) : undefined
      return { files: await vfs.list(root) } satisfies BridgeFsList
    }
    case 'fs_read': {
      const path = vfsPath(req.path)
      const entry = await vfs.getEntry(path)
      if (!entry) throw new Error(`no file at ${path}`)
      if (req.encoding === 'base64') {
        if (entry.size > BRIDGE_FILE_MAX_BYTES) throw tooBig(entry.size)
        // Length is pinned to the size so the caller gets the whole file:
        // readBytes() otherwise stops at its own 1 MB default.
        const bytes = await vfs.readBytes(path, { offset: 0, length: Math.max(entry.size, 1) })
        return {
          path,
          mediaType: bytes.mediaType,
          size: entry.size,
          base64: bytes.base64,
          truncated: bytes.truncated,
        } satisfies BridgeFsRead
      }
      // Text mode runs the VFS extractors, so a PDF or .docx comes back as
      // readable text rather than bytes the caller would have to parse.
      const text = await vfs.readText(path, { offset: req.offset, maxChars: req.maxChars })
      return {
        path,
        mediaType: entry.mediaType,
        size: entry.size,
        text: text.text,
        truncated: text.truncated,
      } satisfies BridgeFsRead
    }
    case 'fs_write': {
      const path = vfsPath(req.path)
      if (typeof req.base64 === 'string') {
        return await vfs.writeBase64(path, req.base64, { mediaType: req.mediaType })
      }
      if (typeof req.text === 'string') {
        return await vfs.writeText(path, req.text, { mediaType: req.mediaType })
      }
      throw new Error('fs_write needs either "text" or "base64"')
    }
    case 'fs_delete': {
      const path = vfsPath(req.path)
      const entry = await vfs.getEntry(path)
      if (!entry) throw new Error(`no file at ${path}`)
      await vfs.delete(path)
      return { ok: true, path }
    }
    default:
      throw new Error(`unsupported filesystem op: ${String(req.op)}`)
  }
}

/* ---- ops ---------------------------------------------------------------- */

/** Either a chat action's result or an opaque filesystem payload. */
type BridgeOpOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: BridgeActionFailure['code']; error: string }

type BridgeActionFailure = Extract<BridgeActionResult, { ok: false }>

async function runOp(message: Extract<BridgePanelInbound, { type: 'op' }>): Promise<BridgeOpOutcome> {
  const { req } = message
  if (req.op.startsWith('fs_')) {
    try {
      return { ok: true, result: await runFsOp(req) }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // A bad path or a missing file is the caller's mistake, not ours.
      const missing = /^no file at /.test(error)
      return { ok: false, code: missing ? 'not_found' : 'bad_request', error }
    }
  }
  const chatResult = await runChatOp(message)
  if (!chatResult.ok) return chatResult
  return { ok: true, result: { chatId: chatResult.chatId, queued: chatResult.queued } }
}

async function runChatOp(message: Extract<BridgePanelInbound, { type: 'op' }>): Promise<BridgeActionResult> {
  const { req } = message
  if (req.op === 'ask') {
    const result = await createExternalChat({
      prompt: req.prompt ?? '',
      client: req.client ?? 'external agent',
      label: req.label,
      cwd: req.cwd,
    })
    if (result.ok) {
      pendingStart.set(result.chatId, Date.now() + START_GRACE_MS)
      publishStatus()
    }
    return result
  }
  if (req.op === 'follow') {
    if (!req.chatId) return { ok: false, code: 'bad_request', error: 'chatId is required' }
    const result = await sendExternalMessage(req.chatId, req.text ?? '')
    if (result.ok) {
      pendingStart.set(result.chatId, Date.now() + START_GRACE_MS)
      publishStatus()
    }
    return result
  }
  if (req.op === 'cancel') {
    if (!req.chatId) return { ok: false, code: 'bad_request', error: 'chatId is required' }
    const result = cancelExternalChat(req.chatId)
    publishStatus()
    return result
  }
  return { ok: false, code: 'bad_request', error: `unsupported op: ${String(req.op)}` }
}

function handleMessage(raw: unknown): void {
  const message = raw as BridgePanelInbound
  if (message?.type !== 'op') return
  void runOp(message)
    .then((result) => {
      if (result.ok) {
        post({ type: 'result', id: message.id, ok: true, result: result.result })
      } else {
        post({ type: 'result', id: message.id, ok: false, error: result.error, code: result.code })
      }
    })
    .catch((err) => {
      debugLog.error('ui', 'bridge op failed', err)
      post({ type: 'result', id: message.id, ok: false, error: String(err), code: 'internal' })
    })
}

/* ---- connection --------------------------------------------------------- */

function connect(): void {
  if (connecting || port) return
  connecting = true
  let connection: chrome.runtime.Port
  try {
    connection = chrome.runtime.connect({ name: BRIDGE_PANEL_PORT })
  } catch (err) {
    connecting = false
    debugLog.error('ui', 'bridge port connect', err)
    window.setTimeout(connect, RECONNECT_MS)
    return
  }
  connecting = false
  port = connection
  connection.onMessage.addListener(handleMessage)
  connection.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    if (port !== connection) return
    port = undefined
    // The worker was shut down (or reloaded). Reconnecting revives it, which
    // also gets its socket to the daemon back up.
    window.setTimeout(connect, RECONNECT_MS)
  })
  post({ type: 'hello', windowId })
  // The worker forgot everything it knew when it slept; re-announce from zero.
  reported.clear()
  publishStatus()
}

/**
 * Start the panel side of the bridge. Safe to call more than once; only the
 * first call wires anything up.
 */
export function initBridgePanel(): void {
  if (started) return
  started = true
  void chrome.windows
    .getCurrent()
    .then((win) => {
      windowId = win.id
      if (port) post({ type: 'hello', windowId })
    })
    .catch(() => undefined)
  unsubscribe = subscribeStore(publishStatus)
  connect()
}

/** Test/teardown hook — the panel itself never tears the bridge down. */
export function stopBridgePanel(): void {
  unsubscribe?.()
  unsubscribe = undefined
  port?.disconnect()
  port = undefined
  started = false
  reported.clear()
  pendingStart.clear()
}
