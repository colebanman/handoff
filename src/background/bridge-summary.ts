/**
 * Projects a stored ChatRecord into the compact shape external agents get
 * back over the bridge.
 *
 * This lives on the extension side (not in the daemon) so the daemon never has
 * to understand TranscriptItem: it relays opaque JSON. Everything here is
 * budgeted — a caller pulling a chat into its own context should get the
 * answer and the tool trail, not a megabyte of streamed reasoning.
 */

import type { ChatRecord, TranscriptItem } from '../shared/types'
import {
  BRIDGE_TEXT_BUDGET,
  BRIDGE_TOOL_BUDGET,
  type BridgeChatSummary,
  type BridgeToolCall,
} from '../shared/bridge-protocol'

function clip(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false }
  return { text: `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`, truncated: true }
}

function clipJson(value: unknown, max: number): unknown {
  if (value === undefined || value === null) return value
  if (typeof value === 'string') return clip(value, max).text
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? ''
  } catch {
    return '[unserializable]'
  }
  if (serialized.length <= max) return value
  return `${serialized.slice(0, max)}…[truncated ${serialized.length - max} chars]`
}

/** Flatten tool cards, including subagent and workflow children, in order. */
export function collectToolCalls(items: readonly TranscriptItem[], out: BridgeToolCall[] = []): BridgeToolCall[] {
  for (const item of items) {
    if (item.kind !== 'tool') continue
    out.push({
      toolName: item.toolName,
      agentId: item.agentId,
      status: item.status,
      durationMs: item.durationMs,
      at: item.at,
      input: clipJson(item.input ?? (item.inputText || undefined), BRIDGE_TOOL_BUDGET),
      output: clipJson(item.output, BRIDGE_TOOL_BUDGET),
    })
    if (item.childItems) collectToolCalls(item.childItems, out)
  }
  return out
}

/** Index of the last user message, or -1 when the chat has none yet. */
function lastUserIndex(transcript: readonly TranscriptItem[]): number {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i]?.kind === 'user') return i
  }
  return -1
}

/**
 * The agent's answer to the most recent user message: every main-agent text
 * block after that message, joined. Subagent text is deliberately excluded —
 * it is an implementation detail of how the main agent got there, and it is
 * still available through the tool calls.
 */
export function finalText(transcript: readonly TranscriptItem[]): string {
  const start = lastUserIndex(transcript)
  const parts: string[] = []
  for (let i = start + 1; i < transcript.length; i += 1) {
    const item = transcript[i]
    if (item?.kind === 'text' && item.agentId === 'main' && item.text.trim()) parts.push(item.text.trim())
  }
  if (parts.length > 0) return parts.join('\n\n')
  // Nothing after the last user turn (interrupted, or the caller polled early):
  // fall back to the most recent main text anywhere in the chat.
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const item = transcript[i]
    if (item?.kind === 'text' && item.agentId === 'main' && item.text.trim()) return item.text.trim()
  }
  return ''
}

function lastErrorText(transcript: readonly TranscriptItem[]): string | undefined {
  const start = lastUserIndex(transcript)
  for (let i = transcript.length - 1; i > start; i -= 1) {
    const item = transcript[i]
    if (item?.kind === 'error') return item.message
  }
  return undefined
}

function transcriptDigest(transcript: readonly TranscriptItem[]): Array<{ role: string; agentId?: string; text: string }> {
  const rows: Array<{ role: string; agentId?: string; text: string }> = []
  for (const item of transcript) {
    if (item.kind === 'user') {
      rows.push({ role: 'user', text: clip(item.text, 4_000).text })
    } else if (item.kind === 'text') {
      rows.push({ role: 'assistant', agentId: item.agentId, text: clip(item.text, 8_000).text })
    } else if (item.kind === 'tool') {
      const label = typeof item.input === 'object' && item.input !== null ? JSON.stringify(item.input) : item.inputText
      rows.push({ role: 'tool', agentId: item.agentId, text: `${item.toolName}(${clip(label ?? '', 300).text}) → ${item.status}` })
    } else if (item.kind === 'error') {
      rows.push({ role: 'error', agentId: item.agentId, text: clip(item.message, 2_000).text })
    }
  }
  return rows
}

export function summarizeChat(
  record: ChatRecord,
  opts: { running: boolean; include?: 'summary' | 'full'; toolLimit?: number },
): BridgeChatSummary {
  const transcript = record.transcript ?? []
  const answer = clip(finalText(transcript), BRIDGE_TEXT_BUDGET)
  const toolCalls = collectToolCalls(transcript)
  const lastTurn = record.turns?.[record.turns.length - 1]
  const usage = lastTurn?.usage

  const summary: BridgeChatSummary = {
    chatId: record.id,
    title: record.title,
    status: opts.running ? 'running' : 'idle',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    modelId: record.modelId,
    origin: record.origin,
    text: answer.text,
    textTruncated: answer.truncated || undefined,
    messageCount: Array.isArray(record.messages) ? record.messages.length : 0,
    turnCount: record.turns?.length ?? 0,
    toolCallCount: toolCalls.length,
    lastError: lastErrorText(transcript),
    usage: usage
      ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens }
      : undefined,
  }

  if (opts.include === 'full') {
    summary.toolCalls = toolCalls.slice(-(opts.toolLimit ?? 50))
    summary.transcript = transcriptDigest(transcript)
  }
  return summary
}

/** Tool calls only — the cheap way to inspect what the agent actually did. */
export function toolCallsFor(record: ChatRecord, limit: number): BridgeToolCall[] {
  return collectToolCalls(record.transcript ?? []).slice(-limit)
}
