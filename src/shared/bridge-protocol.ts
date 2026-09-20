/**
 * Agent bridge: the wire contract between the local `handoff-bridge` daemon, the
 * service worker, and the side panel.
 *
 * Three hops, two protocols:
 *
 *   Claude Code / Cursor  --stdio MCP-->  handoff-bridge daemon (127.0.0.1)
 *                                              ^
 *                                              |  WebSocket (the SW dials out)
 *                                              v
 *                                       service worker
 *                                              |  chrome.runtime port
 *                                              v
 *                                        side panel (accepts bridge requests)
 *
 * The service worker holds the socket rather than the panel for two reasons:
 * WebSocket traffic resets the SW idle timer (Chrome 116+), so the connection
 * keeps itself alive; and chats live in chrome.storage.local, so every *read*
 * (list/get/tool calls) can be served with the panel closed. Only running work
 * enters through the panel. Accepted turns run in the service worker and can
 * continue after the panel closes.
 */

import type { VfsEntry, VfsRoot } from './types'

/** Loopback port the daemon listens on. Overridable in Settings. */
export const BRIDGE_DEFAULT_PORT = 8787

/** chrome.runtime port name the side panel connects to the SW with. */
export const BRIDGE_PANEL_PORT = 'handoff-bridge-panel'

/** chrome.alarms name that revives a terminated SW to redial the daemon. */
export const BRIDGE_ALARM = 'handoff-bridge-reconnect'

/* ---- chat provenance ---------------------------------------------------- */

/**
 * Who started a chat. Absent means the user did (every chat before this
 * feature existed, and every chat typed into the composer).
 */
export interface ChatOrigin {
  /** 'external' = a local coding agent over the bridge; 'automation' = a scheduled run opened it. */
  kind: 'external' | 'automation'
  /** Reported by the caller: 'claude-code', 'cursor', 'cli', … */
  client: string
  /** Short human label for the badge tooltip, e.g. the calling repo. */
  label?: string
  /** Working directory the request came from, when the client sends one. */
  cwd?: string
  at: number
}

/* ---- daemon -> extension ------------------------------------------------ */

export type BridgeOp =
  | 'status'
  | 'list'
  | 'get'
  | 'tools'
  | 'ask'
  | 'follow'
  | 'cancel'
  | 'fs_list'
  | 'fs_read'
  | 'fs_write'
  | 'fs_delete'

export interface BridgeRequestFrame {
  t: 'req'
  id: string
  op: BridgeOp
  /** ask */
  prompt?: string
  client?: string
  label?: string
  cwd?: string
  /** follow message, or the body of an fs_write text write. */
  text?: string
  /** get / tools / follow / cancel */
  chatId?: string
  include?: 'summary' | 'full'
  limit?: number
  /* ---- filesystem ops ---- */
  /** fs_read / fs_write / fs_delete: absolute VFS path (/workspace/… or /skills/…). */
  path?: string
  /** fs_list: restrict to one root. */
  root?: VfsRoot
  /** fs_read: 'text' extracts (pdf/docx too), 'base64' returns the raw bytes. */
  encoding?: 'text' | 'base64'
  /** fs_write: raw bytes as base64 (`text` carries a text write instead). */
  base64?: string
  /** fs_read: text window. */
  offset?: number
  maxChars?: number
  mediaType?: string
}

export type BridgeInboundFrame = BridgeRequestFrame | { t: 'ping' }

/* ---- extension -> daemon ------------------------------------------------ */

export type BridgeErrorCode =
  | 'panel_closed'
  | 'bad_request'
  | 'not_found'
  | 'no_credential'
  | 'disabled'
  | 'internal'

export type BridgeOutboundFrame =
  | { t: 'hello'; extensionId: string; version: string; panelOpen: boolean }
  | { t: 'res'; id: string; ok: true; result: unknown }
  | { t: 'res'; id: string; ok: false; error: string; code: BridgeErrorCode }
  | { t: 'ev'; ev: 'panel'; open: boolean }
  | { t: 'ev'; ev: 'chat'; chatId: string; running: boolean; title: string; updatedAt: number }
  | { t: 'pong' }

/* ---- op results --------------------------------------------------------- */

export interface BridgeChatListEntry {
  chatId: string
  title: string
  preview: string
  createdAt: number
  updatedAt: number
  running: boolean
  origin?: ChatOrigin
}

export interface BridgeToolCall {
  toolName: string
  agentId: string
  status: string
  durationMs?: number
  at: number
  input?: unknown
  output?: unknown
}

export interface BridgeChatSummary {
  chatId: string
  title: string
  status: 'running' | 'idle'
  createdAt: number
  updatedAt: number
  modelId: string
  origin?: ChatOrigin
  /** The agent's latest reply — what a caller almost always wants. */
  text: string
  /** True when `text` was cut to the size budget. */
  textTruncated?: boolean
  messageCount: number
  turnCount: number
  toolCallCount: number
  lastError?: string
  usage?: { input?: number; output?: number; total?: number }
  /** include: 'full' only. */
  toolCalls?: BridgeToolCall[]
  transcript?: Array<{ role: string; agentId?: string; text: string }>
}

/* ---- filesystem op results ---------------------------------------------- */

export interface BridgeFsList {
  files: VfsEntry[]
}

export interface BridgeFsRead {
  path: string
  mediaType: string
  size: number
  /** encoding: 'text' */
  text?: string
  /** encoding: 'base64' — the whole file, byte-exact. */
  base64?: string
  /** True when a text read hit `maxChars`. */
  truncated?: boolean
}

export interface BridgeStatus {
  panelOpen: boolean
  extensionVersion: string
  chatCount: number
  runningChatIds: string[]
}

/* ---- service worker <-> side panel -------------------------------------- */

export type BridgePanelInbound =
  | { type: 'op'; id: string; op: BridgeOp; req: BridgeRequestFrame }

export type BridgePanelOutbound =
  | { type: 'hello'; windowId?: number }
  | { type: 'result'; id: string; ok: true; result: unknown }
  | { type: 'result'; id: string; ok: false; error: string; code: BridgeErrorCode }
  | { type: 'chat'; chatId: string; running: boolean; title: string; updatedAt: number }
/**
 * Largest file the bridge moves in one hop, raw bytes. Base64 inflates by 4/3
 * and the extension socket caps a frame at 32 MiB, so this leaves headroom for
 * the JSON envelope. Bigger files stay in the browser; the agent works on them
 * there rather than round-tripping through the caller.
 */
export const BRIDGE_FILE_MAX_BYTES = 20 * 1024 * 1024

/** Cap on any single string that crosses the bridge (keeps caller context sane). */
export const BRIDGE_TEXT_BUDGET = 24_000
/** Cap on one tool call's serialized input/output. */
export const BRIDGE_TOOL_BUDGET = 2_000
