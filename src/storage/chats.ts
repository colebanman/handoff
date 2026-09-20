import type { ChatRecord } from '../shared/types'
import type { ChatOrigin } from '../shared/bridge-protocol'
import { uid } from '../shared/ids'
import { debugLog } from '../shared/debug-log'
import { sanitizeModelMessages } from '../shared/model-messages'

/**
 * Chats live in chrome.storage.local:
 *   'chat-ids'    -> string[] of chat ids (existence list only, rarely mutated)
 *   'meta:<id>'   -> ChatMeta (its own key, so concurrent side-panel windows
 *                    autosaving different/same chats never clobber each
 *                    other's writes the way a single shared array would)
 *   'chat:<id>'   -> ChatRecord
 *
 * Chats can be open in more than one side panel window at once, each with its
 * own JS context, so any state that's read-modify-written as a single blob
 * (like the old 'chat-index' array) is a lost-update hazard across windows.
 * Splitting per-chat metadata into its own key sidesteps that for the hot
 * path (autosave during streaming); only the id list still needs a lock, and
 * it changes far less often (new/delete chat only).
 */

export interface ChatMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  preview: string
  /** Mirrored from the record so the chat list can badge agent-made chats without loading every record. */
  origin?: ChatOrigin
}

const IDS_KEY = 'chat-ids'
const metaKey = (id: string) => `meta:${id}`

let idsLock: Promise<unknown> = Promise.resolve()

function withIdsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = idsLock.then(fn, fn)
  idsLock = run.catch(() => undefined)
  return run
}

async function getIds(): Promise<string[]> {
  const out = await chrome.storage.local.get(IDS_KEY)
  const raw = out[IDS_KEY] as string[] | undefined
  return Array.isArray(raw) ? raw : []
}

const OLD_INDEX_KEY = 'chat-index'
let migrated = false

/**
 * One-time upgrade from the old shared 'chat-index' blob. Rebuilds from the
 * actual 'chat:<id>' records (source of truth) rather than trusting the old
 * index, so chats dropped by the previous race are recovered too.
 */
async function migrateIfNeeded(): Promise<void> {
  if (migrated) return
  migrated = true
  await withIdsLock(async () => {
    const existing = await chrome.storage.local.get(IDS_KEY)
    if (Array.isArray(existing[IDS_KEY])) return
    const all = await chrome.storage.local.get(null)
    const oldMetaById = new Map<string, Partial<ChatMeta>>()
    const oldIndex = all[OLD_INDEX_KEY] as Array<Partial<ChatMeta> & { id: string }> | undefined
    for (const m of oldIndex ?? []) if (typeof m.id === 'string') oldMetaById.set(m.id, m)

    const ids: string[] = []
    const puts: Record<string, unknown> = {}
    for (const key of Object.keys(all)) {
      if (!key.startsWith('chat:')) continue
      const record = all[key] as ChatRecord
      const id = record.id
      if (!id) continue
      ids.push(id)
      const old = oldMetaById.get(id)
      puts[metaKey(id)] = {
        id,
        title: old?.title ?? record.title,
        createdAt: old?.createdAt ?? record.createdAt,
        updatedAt: old?.updatedAt ?? record.updatedAt,
        preview: old?.preview ?? '',
        origin: record.origin,
      } satisfies ChatMeta
    }
    puts[IDS_KEY] = ids
    await chrome.storage.local.set(puts)
    await chrome.storage.local.remove(OLD_INDEX_KEY)
  })
}

export async function listChats(): Promise<ChatMeta[]> {
  await migrateIfNeeded()
  const ids = await getIds()
  if (ids.length === 0) return []
  const keys = ids.map(metaKey)
  const out = await chrome.storage.local.get(keys)
  const metas = await Promise.all(
    ids.map(async (id) => {
      const meta = out[metaKey(id)] as ChatMeta | undefined
      if (meta) return meta
      const record = await getChat(id)
      if (!record) return undefined
      return { id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, preview: '', origin: record.origin }
    }),
  )
  return metas.filter((m): m is ChatMeta => m !== undefined).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getChat(id: string): Promise<ChatRecord | undefined> {
  const key = `chat:${id}`
  const out = await chrome.storage.local.get(key)
  const chat = out[key] as ChatRecord | undefined
  if (!chat) return undefined
  return { ...chat, messages: Array.isArray(chat.messages) ? sanitizeModelMessages(chat.messages) : [] }
}

export function newChat(modelId: string): ChatRecord {
  const now = Date.now()
  return { id: uid('chat'), title: 'New chat', createdAt: now, updatedAt: now, modelId, messages: [], transcript: [], checkpoints: [] }
}

export async function saveChat(chat: ChatRecord, preview = ''): Promise<void> {
  const updatedAt = Date.now()
  chat.updatedAt = updatedAt
  const record: ChatRecord = {
    ...chat,
    updatedAt,
    messages: Array.isArray(chat.messages) ? sanitizeModelMessages(chat.messages) : [],
  }
  const meta: ChatMeta = {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preview: preview.slice(0, 80),
    origin: record.origin,
  }
  try {
    await chrome.storage.local.set({ [`chat:${record.id}`]: record, [metaKey(record.id)]: meta })
  } catch (err) {
    debugLog.error('storage', `saveChat ${chat.id}`, err)
    throw err
  }
  const ids = await getIds()
  if (!ids.includes(record.id)) {
    await withIdsLock(async () => {
      const current = await getIds()
      if (!current.includes(record.id)) await chrome.storage.local.set({ [IDS_KEY]: [...current, record.id] })
    })
  }
}

export async function deleteChat(id: string): Promise<void> {
  await withIdsLock(async () => {
    const ids = (await getIds()).filter((existingId) => existingId !== id)
    await chrome.storage.local.set({ [IDS_KEY]: ids })
  })
  await chrome.storage.local.remove([`chat:${id}`, metaKey(id)])
}
