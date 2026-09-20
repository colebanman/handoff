/**
 * Background-task registry for the agent core.
 *
 * Tracks TaskInfo records for background subagents. Each task owns an
 * AbortController so `cancel(id)` can abort the detached run. State changes are
 * broadcast via a caller-supplied `onChange` callback so `runTurn` can forward
 * them to the UI as `task-update` AgentEvents.
 */

import type { ModelMessage } from 'ai'
import type { TaskInfo, TaskStatus } from '../shared/types'
import { debugLog } from '../shared/debug-log'
import { uid } from '../shared/ids'
import { sanitizeModelMessages } from '../shared/model-messages'
import {
  loadPersistedTasks,
  onPersistedTaskChange,
  removePersistedTasks,
  savePersistedTask,
  type PersistedTask,
} from '../storage/tasks'

/**
 * Everything needed to resume a cancelled subagent where it left off: the
 * conversation snapshot from its last completed step plus its original spawn
 * scope. Kept on the entry (not TaskInfo) so it never leaves the agent core.
 */
export interface TaskResumeState {
  messages: ModelMessage[]
  tabIds: number[]
  parentToolCallId?: string
  /** Tabs the subagent opened before cancellation, so a resumed run still cleans them up. */
  createdTabIds?: number[]
  /** Spawn-time opt-out of closing the subagent's created tabs when it finishes. */
  keepTabs?: boolean
}

interface TaskEntry {
  info: TaskInfo
  controller: AbortController
  /** Pending steering messages for the task's subagent, drained at its step boundaries. */
  steering: string[]
  resume?: TaskResumeState
  /** True when THIS registry instance runs the task (has the live loop +
   * working AbortController). Hydrated/foreign entries are false. */
  owned: boolean
  /** runtimeId of the registry that owns (or last owned) the live run. */
  runtimeId: string
  heartbeatAt: number
}

export type TaskChangeListener = (task: TaskInfo) => void

/** How often the owning registry stamps heartbeatAt on its running tasks. */
const HEARTBEAT_MS = 5_000
/** A persisted 'running' task with a heartbeat older than this is orphaned. */
const ORPHAN_AFTER_MS = 15_000
/** Finished tasks kept queryable in session storage (newest first). */
const MAX_FINISHED_PERSISTED = 30

export class TaskRegistry {
  private tasks = new Map<string, TaskEntry>()
  private listeners = new Set<TaskChangeListener>()
  /** Identifies this registry instance in persisted records (one per host context). */
  private readonly runtimeId = uid('reg')
  private hydrated: Promise<void> | undefined
  /** Serializes storage writes so set/remove never race out of order. */
  private writeChain: Promise<void> = Promise.resolve()
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined

  /** Subscribe to task changes. Returns an unsubscribe function. */
  onChange(listener: TaskChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitChange(info: TaskInfo): void {
    // Emit a shallow copy so downstream consumers can't mutate our stored record.
    const snapshot: TaskInfo = { ...info }
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (err) {
        debugLog.error('agent', 'task listener threw', err)
      }
    }
  }

  /** Write-through: persist a task's current entry (fire-and-forget, serialized). */
  private persist(id: string): void {
    const entry = this.tasks.get(id)
    if (!entry) return
    const record: PersistedTask = {
      info: { ...entry.info },
      resume: entry.resume,
      runtimeId: entry.runtimeId,
      heartbeatAt: Date.now(),
    }
    entry.heartbeatAt = record.heartbeatAt
    this.writeChain = this.writeChain.then(() => savePersistedTask(record)).catch(() => undefined)
  }

  /**
   * Load persisted tasks into the Map once per registry lifetime. Called
   * eagerly at runtime construction and awaited at the top of every turn
   * (TaskAccess is synchronous, so hydration cannot be lazy-per-get).
   */
  hydrate(): Promise<void> {
    if (!this.hydrated) this.hydrated = this.doHydrate()
    return this.hydrated
  }

  private async doHydrate(): Promise<void> {
    try {
      const persisted = await loadPersistedTasks()
      // Cap finished tasks: keep the newest MAX_FINISHED_PERSISTED, drop the rest.
      const finished = persisted
        .filter((p) => p.info.status !== 'running' && p.info.status !== 'cancelling')
        .sort((a, b) => (b.info.endedAt ?? 0) - (a.info.endedAt ?? 0))
      const drop = new Set(finished.slice(MAX_FINISHED_PERSISTED).map((p) => p.info.id))
      if (drop.size > 0) void removePersistedTasks([...drop])

      const now = Date.now()
      for (const p of persisted) {
        if (drop.has(p.info.id) || this.tasks.has(p.info.id)) continue
        const resume = p.resume
          ? { ...p.resume, messages: sanitizeModelMessages(p.resume.messages) as ModelMessage[] }
          : undefined
        const entry: TaskEntry = {
          info: { ...p.info },
          controller: new AbortController(), // inert — no live run in this context
          steering: [],
          resume,
          owned: false,
          runtimeId: p.runtimeId,
          heartbeatAt: p.heartbeatAt,
        }
        const stale = now - p.heartbeatAt > ORPHAN_AFTER_MS
        if ((p.info.status === 'running' || p.info.status === 'cancelling') && stale) {
          // Its host context died mid-run. Report that honestly; keep the
          // resume snapshot so subagent_message can pick it back up.
          entry.info = {
            ...entry.info,
            status: 'orphaned',
            endedAt: p.heartbeatAt,
            result: 'Died with the extension context before finishing.',
          }
          this.tasks.set(p.info.id, entry)
          this.persist(p.info.id)
          debugLog.log('agent', 'task orphaned on hydrate', { id: p.info.id })
          this.emitChange(entry.info)
        } else {
          // Finished task, or a task still running in another live window.
          this.tasks.set(p.info.id, entry)
        }
      }
    } catch (err) {
      debugLog.error('agent', 'task hydrate failed', err)
    }
    this.startHousekeeping()
  }

  /** Heartbeat for owned running tasks + cross-window sync via onChanged. */
  private startHousekeeping(): void {
    if (this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
      for (const [id, entry] of this.tasks) {
        if (entry.owned && (entry.info.status === 'running' || entry.info.status === 'cancelling')) this.persist(id)
        else if (
          !entry.owned &&
          (entry.info.status === 'running' || entry.info.status === 'cancelling') &&
          Date.now() - entry.heartbeatAt > ORPHAN_AFTER_MS
        ) {
          entry.info = {
            ...entry.info,
            status: 'orphaned',
            endedAt: entry.heartbeatAt,
            result: 'Died with the extension context before finishing.',
          }
          this.persist(id)
          this.emitChange(entry.info)
        }
      }
    }, HEARTBEAT_MS)
    onPersistedTaskChange((id, next) => {
      if (!next?.info?.id) return
      const entry = this.tasks.get(id)
      if (!entry) {
        // A task registered by another window: mirror it (read-only here).
        this.tasks.set(id, {
          info: { ...next.info },
          controller: new AbortController(),
          steering: [],
          resume: next.resume,
          owned: false,
          runtimeId: next.runtimeId,
          heartbeatAt: next.heartbeatAt,
        })
        this.emitChange(next.info)
        return
      }
      if (entry.owned) {
        // Another window cancelled our live run (its cancel() wrote status
        // 'cancelled'); abort it here. Everything else — including this
        // registry's OWN writes, since onChanged fires in the writer's
        // context too — is a no-op echo because entry.info is already equal.
        if (
          (next.info.status === 'cancelling' || next.info.status === 'cancelled') &&
          entry.info.status === 'running'
        ) this.cancel(id)
        return
      }
      const changed =
        entry.info.status !== next.info.status ||
        entry.info.result !== next.info.result ||
        entry.info.endedAt !== next.info.endedAt ||
        JSON.stringify(entry.info.workflowProgress) !== JSON.stringify(next.info.workflowProgress)
      entry.info = { ...next.info }
      entry.resume = next.resume ?? entry.resume
      entry.runtimeId = next.runtimeId
      entry.heartbeatAt = next.heartbeatAt
      if (changed) this.emitChange(entry.info)
    })
  }

  /**
   * Register a new task. Returns its AbortController so the caller can wire the
   * detached run's abortSignal to `cancel`.
   */
  register(info: TaskInfo): AbortController {
    const controller = new AbortController()
    this.tasks.set(info.id, {
      info: { ...info }, controller, steering: [], owned: true, runtimeId: this.runtimeId, heartbeatAt: Date.now(),
    })
    this.persist(info.id)
    debugLog.log('agent', 'task registered', { id: info.id, description: info.description })
    this.emitChange(info)
    return controller
  }

  get(id: string): TaskInfo | undefined {
    const entry = this.tasks.get(id)
    return entry ? { ...entry.info } : undefined
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((e) => ({ ...e.info }))
  }

  /** The AbortSignal for a task, if it exists. */
  signal(id: string): AbortSignal | undefined {
    return this.tasks.get(id)?.controller.signal
  }

  /**
   * Queue a steering message for a running task's subagent. It is delivered
   * (as a user message) at the subagent's next step boundary. Returns false if
   * the task is unknown or no longer running.
   */
  steer(id: string, text: string): boolean {
    const entry = this.tasks.get(id)
    if (!entry || entry.info.kind !== 'subagent' || entry.info.status !== 'running' || !entry.owned) return false
    entry.steering.push(text)
    debugLog.log('agent', 'task steering queued', { id })
    return true
  }

  /** Drain a task's pending steering messages (called by the subagent's loop). */
  takeSteering(id: string): string[] {
    const entry = this.tasks.get(id)
    if (!entry || entry.steering.length === 0) return []
    return entry.steering.splice(0)
  }

  /** Seed the resume state at spawn time (scope + initial task message). */
  initResume(id: string, state: TaskResumeState): void {
    const entry = this.tasks.get(id)
    if (entry) {
      entry.resume = state
      this.persist(id)
    }
  }

  /** Refresh the resumable conversation snapshot (called at each completed step). */
  updateResumeMessages(id: string, messages: ModelMessage[]): void {
    const entry = this.tasks.get(id)
    if (entry?.resume) {
      entry.resume.messages = messages
      this.persist(id)
    }
  }

  /** Record tabs the subagent opened, kept on cancel so a later resume still owns their cleanup. */
  updateResumeCreatedTabs(id: string, createdTabIds: number[]): void {
    const entry = this.tasks.get(id)
    if (entry?.resume) {
      entry.resume.createdTabIds = createdTabIds
      this.persist(id)
    }
  }

  getResume(id: string): TaskResumeState | undefined {
    return this.tasks.get(id)?.resume
  }

  /** Whether a task has saved context to resume from (for honest tool output). */
  canResume(id: string): boolean {
    return this.tasks.get(id)?.resume !== undefined
  }

  /**
   * Reopen a cancelled or orphaned task for a resumed run: fresh
   * AbortController, ownership adopted by THIS registry (an orphan's old
   * context is dead; a cancelled task has no live run anywhere), status back
   * to running, result/endedAt cleared. Returns the new controller, or
   * undefined if the task isn't resumable.
   */
  reopen(id: string): AbortController | undefined {
    const entry = this.tasks.get(id)
    if (!entry || (entry.info.status !== 'cancelled' && entry.info.status !== 'orphaned')) return undefined
    entry.controller = new AbortController()
    entry.owned = true
    entry.runtimeId = this.runtimeId
    entry.heartbeatAt = Date.now()
    this.update(id, { status: 'running', result: undefined, endedAt: undefined })
    debugLog.log('agent', 'task reopened', { id })
    return entry.controller
  }

  /**
   * Apply a partial update to a task and broadcast the change. No-op if the
   * task is unknown. Returns the updated info (or undefined).
   */
  update(
    id: string,
    patch: Partial<Pick<TaskInfo, 'status' | 'result' | 'endedAt' | 'workflowProgress'>>,
  ): TaskInfo | undefined {
    const entry = this.tasks.get(id)
    if (!entry) return undefined
    entry.info = { ...entry.info, ...patch }
    this.persist(id)
    debugLog.log('agent', 'task update', { id, status: entry.info.status })
    this.emitChange(entry.info)
    return { ...entry.info }
  }

  /** Convenience: mark a task finished with a status + result text. */
  finish(id: string, status: TaskStatus, result?: string): TaskInfo | undefined {
    // A detached run's failure is invisible until some tool result mentions
    // it; queue it so the next subagent_spawn appends a notice (or a
    // task_status/task_wait that reports it marks it seen).
    if (status === 'error') this.unreportedFailures.add(id)
    return this.update(id, { status, result, endedAt: Date.now() })
  }

  /** Task ids that finished with an error and haven't appeared in any tool result yet. */
  private readonly unreportedFailures = new Set<string>()

  /**
   * Drain pending failure notices for tasks spawned by chatId, so the next
   * spawn's tool result can surface them without the model polling.
   */
  takeFailureNotices(chatId: string): TaskInfo[] {
    const out: TaskInfo[] = []
    for (const id of [...this.unreportedFailures]) {
      const entry = this.tasks.get(id)
      if (!entry) {
        this.unreportedFailures.delete(id)
        continue
      }
      if (entry.info.chatId !== chatId) continue
      this.unreportedFailures.delete(id)
      out.push({ ...entry.info })
    }
    return out
  }

  /** Mark a task's failure as surfaced (task_status/task_wait reported it). */
  markFailureReported(id: string): void {
    this.unreportedFailures.delete(id)
  }

  /**
   * Request task cancellation. `cancelling` remains non-terminal until the
   * detached loop confirms every in-flight tool/API dispatch has settled.
   */
  cancel(id: string): void {
    const entry = this.tasks.get(id)
    if (!entry) return
    if (!entry.controller.signal.aborted) {
      entry.controller.abort()
    }
    if (entry.info.status === 'running') {
      this.update(id, { status: 'cancelling', result: 'Cancellation requested…' })
    }
    debugLog.log('agent', 'task cancellation requested', { id })
  }

  /** Cancel every still-running task spawned by the given chat (user stop). */
  cancelForChat(chatId: string): void {
    for (const [id, entry] of this.tasks) {
      if (entry.info.chatId === chatId && (entry.info.status === 'running' || entry.info.status === 'cancelling')) this.cancel(id)
    }
  }
}
