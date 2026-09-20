/**
 * Automation records in chrome.storage.local (one array under a single key).
 * Small (≤ 50 records), read on every scheduler decision, so a whole-array
 * read-modify-write behind a lock is simpler and safer than per-record keys.
 */

import { AUTOMATIONS_STORAGE_KEY, type AutomationRecord } from '../shared/automations'

let mutation: Promise<unknown> = Promise.resolve()

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutation.then(fn, fn)
  mutation = run.catch(() => undefined)
  return run
}

export async function loadAutomations(): Promise<AutomationRecord[]> {
  const stored = await chrome.storage.local.get(AUTOMATIONS_STORAGE_KEY)
  const list = stored[AUTOMATIONS_STORAGE_KEY]
  return Array.isArray(list) ? (list as AutomationRecord[]) : []
}

/** Read-modify-write under a lock; `fn` returns the new list (or undefined to leave it). */
export function mutateAutomations(fn: (list: AutomationRecord[]) => AutomationRecord[] | undefined): Promise<AutomationRecord[]> {
  return serialize(async () => {
    const current = await loadAutomations()
    const next = fn(current.map((record) => ({ ...record })))
    if (!next) return current
    await chrome.storage.local.set({ [AUTOMATIONS_STORAGE_KEY]: next })
    return next
  })
}

export function subscribeAutomations(listener: (list: AutomationRecord[]) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !(AUTOMATIONS_STORAGE_KEY in changes)) return
    const next = changes[AUTOMATIONS_STORAGE_KEY]?.newValue
    listener(Array.isArray(next) ? (next as AutomationRecord[]) : [])
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
