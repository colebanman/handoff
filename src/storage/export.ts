/**
 * Chat export for offline harness analysis.
 *
 * Dumps every persisted ChatRecord (model-facing messages, UI transcript,
 * checkpoints, per-turn metadata) as one JSON file. Base64 payloads —
 * screenshots and file attachments embedded in messages/transcripts — are
 * replaced with size stubs so an export stays readable and small; everything
 * else is verbatim. Settings (and the API key) are never included.
 */

import type { ChatRecord } from '../shared/types'
import { redactSecrets } from '../shared/redact'
import { listChats, getChat } from './chats'

export interface ChatExport {
  version: 1
  exportedAt: string
  chatCount: number
  /** Base64 media replaced with "[stripped N chars, mediaType]" stubs. */
  mediaStripped: true
  chats: ChatRecord[]
}

/** Keys that carry base64 media in ModelMessages / tool outputs / transcripts. */
const MEDIA_KEYS = new Set(['base64', 'data'])
/** Real base64 media is always far larger than this; prose under a media key survives. */
const STRIP_MIN_CHARS = 2048

function stripMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripMedia(item))
  if (typeof value === 'string') return redactSecrets(value)
  if (typeof value !== 'object' || value === null) return value

  const record = value as Record<string, unknown>
  const mediaType = typeof record.mediaType === 'string' ? record.mediaType : undefined
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(record)) {
    if (MEDIA_KEYS.has(key) && typeof raw === 'string' && raw.length >= STRIP_MIN_CHARS) {
      out[key] = `[stripped ${raw.length} chars${mediaType ? `, ${mediaType}` : ''}]`
    } else {
      out[key] = stripMedia(raw)
    }
  }
  return out
}

export async function buildChatExport(): Promise<ChatExport> {
  const metas = await listChats()
  const chats: ChatRecord[] = []
  for (const meta of metas) {
    const chat = await getChat(meta.id)
    if (chat) chats.push(stripMedia(chat) as ChatRecord)
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    chatCount: chats.length,
    mediaStripped: true,
    chats,
  }
}

/** Build the export and save it as a JSON download. */
export async function downloadChatExport(): Promise<void> {
  const payload = await buildChatExport()
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `handoff-chats-${payload.exportedAt.slice(0, 10)}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
