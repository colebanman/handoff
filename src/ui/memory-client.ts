import { MEMORY_CHANGED_KEY, type MemoryCommand, type MemorySnapshot } from '../shared/continuity'

export async function memoryCommand<T = MemorySnapshot>(payload: MemoryCommand): Promise<T> {
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'memory.command', payload }) as { ok?: boolean; value?: T; error?: string } | undefined
  if (!response?.ok) throw new Error(response?.error ?? 'Memory is not available. Reopen Settings to try again.')
  return response.value as T
}

export function watchMemories(listener: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const changed = (updates: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(MEMORY_CHANGED_KEY in updates) || timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; listener() }, 100)
  }
  chrome.storage.onChanged.addListener(changed)
  return () => { if (timer !== undefined) clearTimeout(timer); chrome.storage.onChanged.removeListener(changed) }
}
