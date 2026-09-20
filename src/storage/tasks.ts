/**
 * chrome.storage.session persistence for the background-task registry.
 *
 * Why session storage: background subagents must survive a host-context
 * restart (extension/service-worker/side-panel reload) so their ids stay
 * answerable and finished results stay deliverable — but they must NOT
 * survive a browser restart, because the tabs and debugger sessions they
 * depend on are gone by then. chrome.storage.session has exactly that
 * lifetime.
 *
 * Layout (mirrors chats.ts conventions — one key per task, so per-task
 * writes from different side-panel windows never clobber each other):
 *   'bgtask:<id>' -> PersistedTask
 */
import type { TaskInfo } from '../shared/types'
import type { TaskResumeState } from '../agent/tasks'
import { debugLog } from '../shared/debug-log'

export interface PersistedTask {
  info: TaskInfo
  resume?: TaskResumeState
  /** Registry instance that owns the live run (one registry per host context). */
  runtimeId: string
  /** Stamped by the owning registry while its context is alive; a stale value
   * after a restart is how a new context knows a 'running' task is orphaned. */
  heartbeatAt: number
}

export const TASK_KEY_PREFIX = 'bgtask:'
const keyOf = (id: string) => `${TASK_KEY_PREFIX}${id}`

export async function loadPersistedTasks(): Promise<PersistedTask[]> {
  const all = await chrome.storage.session.get(null)
  const out: PersistedTask[] = []
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(TASK_KEY_PREFIX)) continue
    const t = value as PersistedTask
    if (t && t.info && typeof t.info.id === 'string') out.push(t)
  }
  return out
}

export async function savePersistedTask(task: PersistedTask): Promise<void> {
  try {
    await chrome.storage.session.set({ [keyOf(task.info.id)]: task })
  } catch (err) {
    // Most likely the 10MB session quota, blown by a large resume snapshot
    // (screenshots in the conversation). Degrade: persist without the resume
    // state so at least the id/status/result stay queryable after a restart.
    debugLog.error('storage', `saveTask ${task.info.id} (retrying without resume)`, err)
    try {
      await chrome.storage.session.set({ [keyOf(task.info.id)]: { ...task, resume: undefined } })
    } catch (err2) {
      debugLog.error('storage', `saveTask ${task.info.id} failed`, err2)
    }
  }
}

export async function removePersistedTasks(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await chrome.storage.session.remove(ids.map(keyOf))
}

/**
 * Subscribe to persisted-task writes from ANY context (this one's own writes
 * included — chrome.storage.onChanged fires in the writer's context too).
 * Keeps every direct chrome.storage.session touch inside this module; callers
 * only ever see PersistedTask values. Returns an unsubscribe function.
 */
export function onPersistedTaskChange(cb: (id: string, next: PersistedTask | undefined) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(TASK_KEY_PREFIX)) continue
      cb(key.slice(TASK_KEY_PREFIX.length), change.newValue as PersistedTask | undefined)
    }
  }
  chrome.storage.session.onChanged.addListener(listener)
  return () => chrome.storage.session.onChanged.removeListener(listener)
}
