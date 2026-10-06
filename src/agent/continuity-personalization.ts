/** Suggestions must honor the same forgetting, expiry, and recall switch as normal chat. */
import type { VirtualFileSystemService } from '../shared/types'
import type { MemorySnapshot } from '../shared/continuity'
import { memoryRuntime, selectMemories } from './continuity-context'
import { readMemory, serializeMemoryForPrompt } from './memory'

export async function personalizationMemory(vfs: VirtualFileSystemService, task: string): Promise<string> {
  const local = memoryRuntime()
  let snapshot = local?.snapshot()
  if (!local && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ target: 'background', type: 'memory.command', payload: { command: 'list' } }) as Promise<{ ok?: boolean; value?: MemorySnapshot }>,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 200) }),
      ])
      if (response?.ok) snapshot = response.value
    } catch { /* Fail closed: old files could contain forgotten information. */ }
    finally { clearTimeout(timer) }
  } else if (!local) {
    // Standalone/legacy consumers without an extension host retain file compatibility.
    return serializeMemoryForPrompt(await readMemory(vfs))
  }
  if (!snapshot?.state.config.recall) return '[]'
  const urls = [...task.matchAll(/https?:\/\/[^\s"<>]+/g)].map((m) => m[0]).slice(0, 40)
  const selected = selectMemories(snapshot.records, { task, urls })
  return serializeMemoryForPrompt(selected.map((record) => ({ title: record.title, body: record.body, date: new Date(record.updatedAt).toISOString().slice(0, 10) })))
}
