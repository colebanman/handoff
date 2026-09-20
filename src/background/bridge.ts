/**
 * Agent bridge, service-worker half.
 *
 * Dials the loopback `handoff-bridge` daemon over a WebSocket and answers the ops
 * local coding agents send. Chat reads (status/list/get/tools) are served
 * straight out of chrome.storage.local, so they work with the side panel
 * closed. Everything else — ask/follow/cancel and the filesystem ops — is
 * forwarded to the panel, because the agent runtime and the virtual filesystem
 * both live there. With no panel there is nothing to run the turn, and Chrome
 * will not let us open the panel without a user gesture. Those fail fast with
 * `panel_closed` and a notification rather than queueing silently.
 *
 * Why the socket lives here and not in the panel: WebSocket traffic resets the
 * service worker's idle timer (Chrome 116+), and a connected panel port keeps
 * the worker alive on top of that. When the worker is terminated anyway (no
 * panel, no traffic), a 30s alarm revives it and redials.
 */

import {
  BRIDGE_ALARM,
  BRIDGE_DEFAULT_PORT,
  BRIDGE_PANEL_PORT,
  type BridgeChatListEntry,
  type BridgeErrorCode,
  type BridgeInboundFrame,
  type BridgeOutboundFrame,
  type BridgePanelOutbound,
  type BridgeRequestFrame,
  type BridgeStatus,
} from '../shared/bridge-protocol'
import { getChat, listChats } from '../storage/chats'
import { summarizeChat, toolCallsFor } from './bridge-summary'
import type { Settings } from '../shared/types'
import { EXECUTION_KEY_PREFIX, type ExecutionSnapshot } from '../shared/execution-protocol'
import { cancelHostedChat } from './agent-host'

class BridgeError extends Error {
  constructor(readonly code: BridgeErrorCode, message: string) {
    super(message)
  }
}

const RETRY_MS = 30_000
/** Ceiling for the redial backoff: most installs never run the daemon at all. */
const MAX_RETRY_MS = 300_000
const PANEL_OP_TIMEOUT_MS = 30_000
const NOTIFY_COOLDOWN_MS = 60_000

let socket: WebSocket | undefined
let connecting = false
let nextRetryAt = 0
/** Consecutive failed dials, so an absent daemon stops costing a wake-up a minute. */
let failures = 0
let enabled = true
let port = BRIDGE_DEFAULT_PORT

let panelPort: chrome.runtime.Port | undefined
let panelWindowId: number | undefined
const runningChats = new Set<string>()
const pendingPanelOps = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: number }>()
let lastNotifyAt = 0

function log(message: string, ...rest: unknown[]): void {
  console.info(`[handoff-bridge] ${message}`, ...rest)
}

/* ---- configuration ------------------------------------------------------ */

async function readConfig(): Promise<{ enabled: boolean; port: number }> {
  try {
    const out = await chrome.storage.local.get('settings')
    const settings = out.settings as Partial<Settings> | undefined
    return {
      enabled: settings?.bridgeEnabled !== false,
      port: typeof settings?.bridgePort === 'number' ? settings.bridgePort : BRIDGE_DEFAULT_PORT,
    }
  } catch {
    return { enabled: true, port: BRIDGE_DEFAULT_PORT }
  }
}

async function applyConfig(): Promise<void> {
  const next = await readConfig()
  const changed = next.enabled !== enabled || next.port !== port
  enabled = next.enabled
  port = next.port
  if (!enabled) {
    disconnect('disabled in settings')
    return
  }
  if (changed) {
    // A port change has to drop the old socket before redialing.
    disconnect('config changed')
    failures = 0
    nextRetryAt = 0
  }
  ensureConnected()
}

/* ---- socket ------------------------------------------------------------- */

function send(frame: BridgeOutboundFrame): void {
  if (socket?.readyState !== WebSocket.OPEN) return
  try {
    socket.send(JSON.stringify(frame))
  } catch (err) {
    console.error('[handoff-bridge] send failed', err)
  }
}

function disconnect(reason: string): void {
  const open = socket
  socket = undefined
  if (!open) return
  log(`disconnecting (${reason})`)
  try {
    open.close()
  } catch {
    // Already closing; nothing to do.
  }
}

/**
 * The daemon is optional, and on most machines it is simply never running: an
 * unbacked-off 30s redial would wake the worker forever for nothing. Each
 * consecutive failure doubles the wait; opening the panel (or changing
 * settings) resets it, so a user who just started the daemon connects at once.
 */
function backoffMs(): number {
  return Math.min(RETRY_MS * 2 ** Math.min(failures, 4), MAX_RETRY_MS)
}

export function ensureConnected(): void {
  if (!enabled || connecting) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  if (Date.now() < nextRetryAt) return

  connecting = true
  nextRetryAt = Date.now() + backoffMs()
  let ws: WebSocket
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ext`)
  } catch (err) {
    connecting = false
    console.error('[handoff-bridge] connect threw', err)
    return
  }
  socket = ws

  ws.addEventListener('open', () => {
    connecting = false
    failures = 0
    nextRetryAt = 0
    log(`connected to daemon on port ${port}`)
    send({
      t: 'hello',
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      panelOpen: panelPort !== undefined,
    })
  })

  ws.addEventListener('message', (event) => {
    let frame: BridgeInboundFrame
    try {
      frame = JSON.parse(String(event.data)) as BridgeInboundFrame
    } catch {
      return
    }
    if (frame.t === 'ping') {
      send({ t: 'pong' })
      return
    }
    if (frame.t === 'req') {
      void handleRequest(frame)
      return
    }
  })

  ws.addEventListener('close', () => {
    connecting = false
    if (socket === ws) socket = undefined
    // The daemon is usually just not running; retry on the alarm rather than
    // hammering a refused port.
    failures += 1
    nextRetryAt = Date.now() + backoffMs()
  })

  ws.addEventListener('error', () => {
    connecting = false
    nextRetryAt = Date.now() + backoffMs()
  })
}

/* ---- ops ---------------------------------------------------------------- */

async function handleRequest(req: BridgeRequestFrame): Promise<void> {
  try {
    const result = await runOp(req)
    send({ t: 'res', id: req.id, ok: true, result })
  } catch (err) {
    const code = err instanceof BridgeError ? err.code : 'internal'
    const error = err instanceof Error ? err.message : String(err)
    send({ t: 'res', id: req.id, ok: false, error, code })
  }
}

async function runOp(req: BridgeRequestFrame): Promise<unknown> {
  const durableRunning = await durableRunningChatIds()
  switch (req.op) {
    case 'status': {
      const chats = await listChats()
      return {
        panelOpen: panelPort !== undefined,
        extensionVersion: chrome.runtime.getManifest().version,
        chatCount: chats.length,
        runningChatIds: [...durableRunning],
      } satisfies BridgeStatus
    }
    case 'list': {
      const chats = await listChats()
      const limit = Math.max(1, Math.min(req.limit ?? 20, 200))
      return {
        chats: chats.slice(0, limit).map((meta): BridgeChatListEntry => ({
          chatId: meta.id,
          title: meta.title,
          preview: meta.preview,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          running: durableRunning.has(meta.id),
          origin: meta.origin,
        })),
      }
    }
    case 'get': {
      const record = await requireChat(req.chatId)
      return summarizeChat(record, {
        running: durableRunning.has(record.id),
        include: req.include === 'full' ? 'full' : 'summary',
        toolLimit: req.limit,
      })
    }
    case 'tools': {
      const record = await requireChat(req.chatId)
      return {
        chatId: record.id,
        running: durableRunning.has(record.id),
        toolCalls: toolCallsFor(record, Math.max(1, Math.min(req.limit ?? 50, 500))),
      }
    }
    case 'ask':
    case 'follow':
    // The virtual filesystem is IndexedDB owned by the panel's runtime, and its
    // readers (pdf/docx extraction, blob URLs) need a DOM. Forwarding keeps one
    // writer, so the file panel's live preview sees every change.
    case 'fs_list':
    case 'fs_read':
    case 'fs_write':
    case 'fs_delete':
      return forwardToPanel(req)
    case 'cancel': {
      if (!req.chatId) throw new BridgeError('bad_request', 'chatId is required')
      if (cancelHostedChat(req.chatId)) return { chatId: req.chatId, cancelling: true }
      return forwardToPanel(req)
    }
    default:
      throw new BridgeError('bad_request', `unknown op: ${String(req.op)}`)
  }
}

async function durableRunningChatIds(): Promise<Set<string>> {
  const ids = new Set(runningChats)
  try {
    const stored = await chrome.storage.local.get(null)
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(EXECUTION_KEY_PREFIX)) continue
      const snapshot = value as ExecutionSnapshot
      if (snapshot?.status === 'running' || snapshot?.status === 'cancelling') ids.add(snapshot.chatId)
    }
  } catch {
    // The live feed remains a useful fallback if storage is temporarily unavailable.
  }
  return ids
}

async function requireChat(chatId: string | undefined) {
  if (!chatId) throw new BridgeError('bad_request', 'chatId is required')
  const record = await getChat(chatId)
  if (!record) throw new BridgeError('not_found', `no chat with id ${chatId}`)
  return record
}

/* ---- panel forwarding --------------------------------------------------- */

function forwardToPanel(req: BridgeRequestFrame): Promise<unknown> {
  const target = panelPort
  if (!target) {
    notifyPanelClosed(req)
    throw new BridgeError(
      'panel_closed',
      "Handoff's side panel is closed, so this bridge request cannot be accepted. Ask the user to open the Handoff side panel in Chrome, then retry.",
    )
  }
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPanelOps.delete(req.id)
      reject(new BridgeError('internal', 'the side panel did not answer in time'))
    }, PANEL_OP_TIMEOUT_MS) as unknown as number
    pendingPanelOps.set(req.id, { resolve, reject, timer })
    try {
      target.postMessage({ type: 'op', id: req.id, op: req.op, req })
    } catch (err) {
      clearTimeout(timer)
      pendingPanelOps.delete(req.id)
      reject(new BridgeError('panel_closed', `side panel went away: ${String(err)}`))
    }
  })
}

/**
 * New bridge work is accepted through the panel, so a request that lands
 * while it is closed cannot be accepted. Chrome forbids opening the side panel
 * without a user gesture, so the best we can do is ask — a notification plus a
 * badge on the toolbar icon.
 */
function notifyPanelClosed(req: BridgeRequestFrame): void {
  void chrome.action.setBadgeText({ text: '!' }).catch(() => {})
  void chrome.action.setBadgeBackgroundColor({ color: '#c2410c' }).catch(() => {})
  if (Date.now() - lastNotifyAt < NOTIFY_COOLDOWN_MS) return
  lastNotifyAt = Date.now()
  const who = req.client ? req.client : 'A local agent'
  const what = req.op.startsWith('fs_') ? 'is trying to reach Handoff\u2019s files' : 'is trying to start a chat'
  chrome.notifications?.create(
    `handoff-bridge-${Date.now()}`,
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon.svg'),
      title: 'Handoff: open the side panel',
      message: `${who} ${what}, but Handoff's panel is closed. Click the Handoff toolbar icon to let it through.`,
      priority: 2,
    },
    () => void chrome.runtime.lastError,
  )
}

function handlePanelMessage(raw: unknown): void {
  const message = raw as BridgePanelOutbound
  if (message.type === 'hello') {
    panelWindowId = message.windowId
    return
  }
  if (message.type === 'chat') {
    if (message.running) runningChats.add(message.chatId)
    else runningChats.delete(message.chatId)
    send({
      t: 'ev',
      ev: 'chat',
      chatId: message.chatId,
      running: message.running,
      title: message.title,
      updatedAt: message.updatedAt,
    })
    return
  }
  if (message.type === 'result') {
    const pending = pendingPanelOps.get(message.id)
    if (!pending) return
    pendingPanelOps.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new BridgeError(message.code, message.error))
  }
}

function attachPanel(connection: chrome.runtime.Port): void {
  // One panel owns the bridge at a time; a second window's panel replaces the
  // first (its port disconnect below is ignored because it is no longer ours).
  panelPort = connection
  void chrome.action.setBadgeText({ text: '' }).catch(() => {})
  // The user is here and the daemon may have just been started: retry now
  // rather than sitting out the rest of a long backoff.
  failures = 0
  nextRetryAt = 0
  send({ t: 'ev', ev: 'panel', open: true })
  ensureConnected()

  connection.onMessage.addListener(handlePanelMessage)
  connection.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    if (panelPort !== connection) return
    panelPort = undefined
    panelWindowId = undefined
    // The runtime died with the panel: nothing is running any more.
    runningChats.clear()
    for (const [id, pending] of pendingPanelOps) {
      clearTimeout(pending.timer)
      pending.reject(new BridgeError('panel_closed', 'the side panel closed before answering'))
      pendingPanelOps.delete(id)
    }
    send({ t: 'ev', ev: 'panel', open: false })
  })
}

/* ---- wiring ------------------------------------------------------------- */

export function initBridge(): void {
  chrome.runtime.onConnect.addListener((connection) => {
    if (connection.name !== BRIDGE_PANEL_PORT) return
    attachPanel(connection)
  })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return
    void applyConfig()
  })

  chrome.alarms.create(BRIDGE_ALARM, { periodInMinutes: 0.5 })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== BRIDGE_ALARM) return
    // Also the revive hook: a terminated worker is restarted for this alarm,
    // which is what gets the socket back after an idle shutdown.
    ensureConnected()
  })

  chrome.notifications?.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith('handoff-bridge-')) return
    chrome.notifications.clear(notificationId)
    // Best effort. chrome.sidePanel.open() is documented as requiring a user
    // gesture and a notification click may not qualify, so this is a bonus
    // path — the badge on the toolbar icon is the reliable one.
    void (async () => {
      try {
        const target = panelWindowId ?? (await chrome.windows.getLastFocused()).id
        if (target !== undefined) await chrome.sidePanel.open({ windowId: target })
      } catch {
        // Gesture-less open refused; the user still has the badged icon.
      }
    })()
  })

  void applyConfig()
}
