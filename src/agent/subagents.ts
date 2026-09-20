/**
 * Subagent spawning.
 *
 * A subagent runs the same core loop (run.ts `runLoop`) with a restricted,
 * tab-scoped context: a fresh agentId ('sub-<uid>'), a scoped sandbox session,
 * a tool set that validates every tabId against `allowedTabIds` and omits the
 * subagent/task tools. Child AgentEvents carry the child agentId and the
 * spawning `parentToolCallId`.
 *
 * - Synchronous spawn: await the final text and return it as the tool result;
 *   aborted alongside the parent turn (shares its signal).
 * - Background spawn: register a TaskInfo (tagged with the spawning chatId so
 *   user stop can cancel it), run detached, and immediately return `Started
 *   background task <id>`. The detached run updates the task and emits
 *   `task-update` on completion (via the registry's onChange → runtime forward),
 *   and drains subagent_message steering queued on the task record at each
 *   step boundary.
 * - Resume: a cancelled background task keeps a conversation snapshot (saved at
 *   every completed step) plus its spawn scope on the registry entry, so
 *   `subagent_message` on a cancelled task reopens it and re-runs the loop from
 *   that snapshot plus the new message — stop preserves context.
 *
 * Subagents step down from Astra → Sol → Terra → Luna: delegated sub-tasks are
 * narrower than the parent's job, and the cheaper grade is a deliberate
 * cost/latency choice. Other models delegate unchanged. A session model
 * override (e.g. rate-limit banner → Grok for subagents) still wins.
 *
 * Each subagent exclusively claims its assigned browser tabs while it runs.
 * Claims are released on success, error, or cancellation. A tab held by another
 * running agent, including a main-agent soft claim, cannot be delegated.
 */

import type { ModelMessage } from 'ai'
import type { AgentEvent, Settings, CdpService, SandboxService, TaskInfo, VirtualFileSystemService } from '../shared/types'
import type { ArtifactHostService } from '../shared/artifacts'
import { uid } from '../shared/ids'
import { debugLog } from '../shared/debug-log'
import { formatError } from '../shared/errors'
import { runLoop } from './run'
import type { AgentContext, MessageSubagentFn, SpawnSubagentFn, TaskAccess } from './tools'
import {
  SurfaceAssignments,
  describeSurface,
  sharedSurfaceAssignments,
  surfaceKey,
  tabSurface,
  type AgentSurface,
} from './surfaces'
import type { TaskRegistry } from './tasks'
import type { AgentTabGroups } from './tab-groups'
import type { MainAgentPriority } from './rate-limit'
import { resolveDesiredModelId, type SessionModelOverride } from './model-switch'

export interface SpawnDeps {
  cdp: CdpService
  sandbox: SandboxService
  vfs: VirtualFileSystemService
  artifacts?: ArtifactHostService
}

export {
  SurfaceAssignments,
  createSurfaceAssignments,
  surfaceKey,
  tabSurface,
  describeSurface,
  sharedSurfaceAssignments,
  type AgentSurface,
  type SurfaceConflict,
} from './surfaces'

/**
 * Tracks which running agent (if any) currently owns each surface — a tab or a
 * browser tab. Lives for the whole runtime (not per-turn) since a
 * background subagent from an earlier turn may still be running when a later
 * turn spawns another. See ./surfaces.ts for the hard/soft claim rules.
 */
export type TabAssignments = SurfaceAssignments

/** The runtime-wide registry (shared with the tool layer's main-agent soft claims). */
export function createTabAssignments(): TabAssignments {
  return sharedSurfaceAssignments()
}

/** Chrome's blank/new-tab surfaces are not valid starting points for browser delegation. */
export function isBlankOrNewTab(tab: Pick<chrome.tabs.Tab, 'url' | 'pendingUrl' | 'title'>): boolean {
  const url = (tab.pendingUrl || tab.url || '').trim().toLowerCase()
  const title = (tab.title || '').trim().toLowerCase()
  return (
    url === '' ||
    url === 'about:blank' ||
    url.startsWith('chrome://newtab') ||
    url.startsWith('chrome://new-tab-page') ||
    title === 'new tab'
  )
}

/** Delegation ladder: parent model → subagent model. */
const SUBAGENT_MODEL: Record<string, string> = {
  'gpt-6-astra': 'gpt-5.6-sol',
  'gpt-5.6-sol': 'gpt-5.6-terra',
  'gpt-5.6-terra': 'gpt-5.6-luna',
}

/**
 * The model a subagent runs on: Astra → Sol → Terra → Luna (Luna stays Luna),
 * any vendor prefix preserved; every other model id
 * passes through unchanged. Applied BEFORE the session override, so an
 * explicit "switch subagents to Grok" still wins.
 */
export function subagentModelFor(parentModelId: string): string {
  const trimmed = parentModelId.trim()
  const slash = trimmed.lastIndexOf('/')
  const prefix = slash >= 0 ? trimmed.slice(0, slash + 1) : ''
  const stepped = SUBAGENT_MODEL[(slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase()]
  return stepped ? `${prefix}${stepped}` : parentModelId
}

/**
 * Close tabs a finished subagent opened, best-effort. Tabs it was handed at
 * spawn (`scopeTabIds` — the user's or parent's) are never touched, and a
 * created tab the user is actively viewing is left open rather than yanked
 * out from under them.
 */
async function closeSubagentTabs(ctx: AgentContext, scopeTabIds: number[]): Promise<void> {
  const created = [...(ctx.createdTabIds ?? [])].filter((id) => !scopeTabIds.includes(id))
  if (created.length === 0) return
  const closed: number[] = []
  for (const tabId of created) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.active) continue
      await chrome.tabs.remove(tabId)
      closed.push(tabId)
    } catch {
      // Tab already gone (closed by the user or another path) — nothing to do.
    }
  }
  if (closed.length > 0) {
    debugLog.log('agent', 'subagent tabs cleaned up', { agentId: ctx.agentId, closed })
  }
}

export interface SpawnSubagentContext {
  parentAgentId: string
  /** Chat whose turn is spawning; recorded on background tasks so user stop can cancel them. */
  chatId: string
  /** Parent's allowed tabs (undefined for the main agent = unrestricted). */
  parentAllowedTabIds?: number[]
  /** Reads the parent's CURRENT tab at spawn time, used to default a subagent's scope. */
  getParentCurrentTabId: () => number
  settings: Settings
  emit: (e: AgentEvent) => void
  deps: SpawnDeps
  tasks: TaskRegistry
  tabGroups?: AgentTabGroups
  tabAssignments: TabAssignments
  /** The parent turn's abort signal; a sync subagent is aborted alongside the turn. */
  parentSignal: AbortSignal
  /** Shared admission gate so subagent requests yield to a rate-limited main agent. */
  priority?: MainAgentPriority
  /** Session model override (e.g. force Grok for subagents after OpenAI rate limits). */
  getModelOverride?: () => SessionModelOverride | undefined
}

export interface SubagentControls {
  spawn: SpawnSubagentFn
  /** Steer a running background subagent, or resume a cancelled one from its saved context. */
  message: MessageSubagentFn
}

/**
 * Build the subagent controls the main agent's tools call: `spawn`
 * (subagent_spawn) and `message` (subagent_message steer-or-resume).
 */
export function makeSpawnSubagent(sctx: SpawnSubagentContext): SubagentControls {
  // Subagents cannot spawn further subagents or manage tasks: no-op fallbacks.
  const noSpawn: SpawnSubagentFn = async () => 'Error: subagents cannot spawn further subagents.'
  const noTasks: TaskAccess = {
    get: () => undefined,
    list: () => [],
    cancel: () => {},
    signal: () => undefined,
    steer: () => false,
    canResume: () => false,
    markFailureReported: () => {},
  }

  /**
   * Detached background run shared by spawn and resume: runs the loop with the
   * task's registry-owned abort signal, saves a resumable conversation snapshot
   * at each completed step, folds the outcome into the task record, and always
   * releases the tab claims.
   */
  const runDetached = (args: {
    taskId: string
    childCtx: AgentContext
    messages: ModelMessage[]
    task: string
    parentToolCallId?: string
    signal: AbortSignal
    /** Spawn-time tab scope — these are never closed by cleanup. */
    scopeTabIds: number[]
    keepTabs?: boolean
  }): void => {
    const { taskId, childCtx, messages, task, parentToolCallId, signal, scopeTabIds, keepTabs } = args
    void runLoop({
      ctx: childCtx,
      settings: sctx.settings,
      modelId: resolveDesiredModelId(subagentModelFor(sctx.settings.modelId), true, sctx.getModelOverride?.()),
      messages,
      signal,
      emit: sctx.emit,
      deps: sctx.deps,
      spawnSubagent: noSpawn,
      tasks: noTasks,
      sandboxSessionId: `sess-${childCtx.agentId}`,
      tabGroups: sctx.tabGroups,
      isSubagent: true,
      parentToolCallId,
      parentAgentId: sctx.parentAgentId,
      task,
      steering: { take: () => sctx.tasks.takeSteering(taskId) },
      priority: sctx.priority,
      getModelOverride: sctx.getModelOverride,
      onStepMessages: (snapshot) => sctx.tasks.updateResumeMessages(taskId, snapshot),
    })
      .then((res) => {
        if (signal.aborted) {
          sctx.tasks.finish(taskId, 'cancelled', 'Cancelled.')
        } else if (res.errorText) {
          sctx.tasks.finish(taskId, 'error', res.text ? `${res.errorText}\n\nPartial output:\n${res.text}` : res.errorText)
        } else {
          sctx.tasks.finish(taskId, 'done', res.text)
        }
      })
      .catch((err) => {
        const message = formatError(err)
        // Cancellation is terminal only now, after runLoop/tool dispatches
        // settled. Before this point TaskRegistry exposes `cancelling`.
        const cur = sctx.tasks.get(taskId)
        if (signal.aborted) {
          sctx.tasks.finish(taskId, 'cancelled', 'Cancelled.')
        } else if (cur?.status === 'cancelled') {
          return
        } else {
          sctx.tasks.finish(taskId, 'error', message)
        }
      })
      .finally(() => {
        sctx.tabAssignments.release(childCtx.agentId)
        // Tab hygiene: a cancelled task keeps its tabs (a resume continues in
        // them; their ids are saved so the resumed run still owns cleanup).
        // Otherwise close what the subagent opened unless the spawn opted out.
        if (sctx.tasks.get(taskId)?.status === 'cancelled' || signal.aborted) {
          sctx.tasks.updateResumeCreatedTabs(taskId, [...(childCtx.createdTabIds ?? [])])
        } else if (!keepTabs) {
          void closeSubagentTabs(childCtx, scopeTabIds)
        }
      })
  }

  /**
   * Failures of earlier background tasks the model hasn't seen yet, appended
   * to this spawn's result — a detached run's error is otherwise invisible
   * until the model happens to poll task_status/task_wait.
   */
  const pendingFailureNotices = (): string => {
    const failed = sctx.tasks.takeFailureNotices(sctx.chatId)
    if (failed.length === 0) return ''
    const lines = failed.map((t) => `- Task ${t.id} (subagent ${t.agentId}) FAILED: ${t.result ?? 'unknown error'}`)
    return `\n\nNote — earlier background task(s) failed since you last checked:\n${lines.join('\n')}`
  }

  /**
   * One wording for every tab conflict. The main agent's soft
   * claim reads as "currently being used by the main agent" so the model
   * finishes its own work on that surface (or hands it over) instead of
   * waiting on a task that does not exist.
   */
  const conflictError = (conflict: { surface: AgentSurface; ownerAgentId: string; soft: boolean }): string => {
    const what = describeSurface(conflict.surface)
    if (conflict.soft) {
      return `Error: ${what} is currently being used by the ${conflict.ownerAgentId} agent. Finish or hand off your own work on it before delegating it, or assign the subagent a different surface.`
    }
    return `Error: ${what} is already assigned to another running subagent (${conflict.ownerAgentId}). Use a different prepared tab, or wait for the other subagent to finish (task_wait).`
  }

  const spawn: SpawnSubagentFn = async ({
    task,
    tabIds,
    background,
    keepTabs,
    parentToolCallId,
    workflowRunId,
    workflowCallId,
    onEvent,
    signal: childSignal,
  }) => {
    // Determine the child's tab scope. Explicit [] means offline-only. Blank
    // or New Tab pages are also stripped from the scope, so browser delegation
    // requires the main agent to prepare a real initial URL first. All
    // validation happens HERE before anything is registered or started, so
    // invalid params fail the spawn tool call
    // immediately — including background spawns, which must never return
    // "Started" for a subagent that cannot actually run.
    const parentTabId = sctx.getParentCurrentTabId()
    let allowedTabIds: number[]
    let offlineOnly = false
    if (tabIds && tabIds.length > 0) {
      const preparedTabIds: number[] = []
      for (const tabId of tabIds) {
        try {
          const tab = await chrome.tabs.get(tabId)
          if (!isBlankOrNewTab(tab)) preparedTabIds.push(tabId)
        } catch {
          return `Error: tab ${tabId} does not exist (it may have been closed). Pass an id for a currently open tab.`
        }
      }
      allowedTabIds = preparedTabIds
      offlineOnly = preparedTabIds.length === 0
    } else if (tabIds) {
      allowedTabIds = []
      offlineOnly = true
    } else {
      const candidates = sctx.parentAllowedTabIds ? [...sctx.parentAllowedTabIds] : [parentTabId]
      const preparedTabIds: number[] = []
      for (const tabId of candidates) {
        try {
          const tab = await chrome.tabs.get(tabId)
          if (!isBlankOrNewTab(tab)) preparedTabIds.push(tabId)
        } catch {
          return `Error: tab ${tabId} does not exist (it may have been closed). Pass an id for a currently open tab.`
        }
      }
      allowedTabIds = preparedTabIds
      offlineOnly = preparedTabIds.length === 0
    }

    const childAgentId = `sub-${uid('a')}`

    const surfaces = allowedTabIds.map(tabSurface)
    const conflict = sctx.tabAssignments.claimSurfaces(childAgentId, surfaces)
    if (conflict) {
      return conflictError(conflict)
    }

    const currentTabId = allowedTabIds[0] ?? parentTabId
    // Snapshot the handed-in scope; cleanup must never close these tabs.
    const scopeTabIds = [...allowedTabIds]
    const childCtx: AgentContext = {
      agentId: childAgentId,
      currentTabId,
      allowedTabIds,
      offlineOnly,
      createdTabIds: new Set(),
    }
    const sandboxSessionId = `sess-${childAgentId}`
    // Step down from the parent (see subagentModelFor), unless a
    // session override routes subagents elsewhere (e.g. Grok after a limit).
    const childModelId = resolveDesiredModelId(subagentModelFor(sctx.settings.modelId), true, sctx.getModelOverride?.())

    // The shared run loop delivers scoped field guides before the first step.
    const messages: ModelMessage[] = [{ role: 'user', content: task }]

    if (background) {
      // Same tail as the subagent, so "task-…-8emu" and "sub-…-8emu" read as one thing to the user.
      const taskId = `task-${childAgentId.slice('sub-'.length)}`
      const info: TaskInfo = {
        id: taskId,
        kind: 'subagent',
        description: task,
        status: 'running',
        agentId: childAgentId,
        chatId: sctx.chatId,
        startedAt: Date.now(),
        // Tab keys the task control UI renders as chips ("Tab · GitHub").
        surfaces: surfaces.map(surfaceKey),
      }
      const controller = sctx.tasks.register(info)
      sctx.tasks.initResume(taskId, { messages: [...messages], tabIds: [...allowedTabIds], parentToolCallId, keepTabs })

      // Detached run. We deliberately do NOT await; failures are captured into
      // the task record. The abortSignal comes from the registry so task_cancel
      // aborts this run. The steering feed drains subagent_message texts queued
      // on the task record at each step boundary.
      runDetached({ taskId, childCtx, messages, task, parentToolCallId, signal: controller.signal, scopeTabIds, keepTabs })

      debugLog.log('agent', 'subagent background started', { taskId, childAgentId, task })
      return `Started background task ${taskId} (subagent ${childAgentId}). Poll it with task_wait or task_status.${pendingFailureNotices()}`
    }

    // Synchronous spawn: use the parent turn's abort signal so cancelling the
    // turn also stops the subagent. (A subagent failure surfaces as an error
    // string tool result and never aborts the parent — see catch below.)
    debugLog.log('agent', 'subagent sync start', { childAgentId, task, tabIds: allowedTabIds })
    try {
      const res = await runLoop({
        ctx: childCtx,
        settings: sctx.settings,
        modelId: childModelId,
        messages,
        signal: childSignal ?? sctx.parentSignal,
        emit: onEvent ?? sctx.emit,
        deps: sctx.deps,
        spawnSubagent: noSpawn,
        tasks: noTasks,
        sandboxSessionId,
        tabGroups: sctx.tabGroups,
        isSubagent: true,
        parentToolCallId,
        parentAgentId: sctx.parentAgentId,
        workflowRunId,
        workflowCallId,
        task,
        priority: sctx.priority,
        getModelOverride: sctx.getModelOverride,
      })
      if (res.errorText) {
        return `Error: subagent failed — ${res.errorText}${res.text ? `\n\nPartial output:\n${res.text}` : ''}`
      }
      return res.text || '(subagent produced no text output)'
    } catch (err) {
      const message = formatError(err)
      return `Error: subagent failed — ${message}`
    } finally {
      sctx.tabAssignments.release(childAgentId)
      // Tab hygiene: close what the subagent opened, unless the spawn opted
      // out or the turn was aborted (the user interrupted — don't yank pages
      // out from under them while they take over).
      if (!keepTabs && !(childSignal ?? sctx.parentSignal).aborted) {
        void closeSubagentTabs(childCtx, scopeTabIds)
      }
    }
  }

  const message: MessageSubagentFn = async (taskId, text) => {
    const info = sctx.tasks.get(taskId)
    if (!info) return `Error: no task with id ${taskId}.`
    if (info.kind !== 'subagent') return `Error: task ${taskId} is a workflow; workflow messaging is not supported.`

    if (info.status === 'running') {
      if (!sctx.tasks.steer(taskId, text)) {
        return `Error: could not deliver the message to task ${taskId} (it may have just finished).`
      }
      return `Message sent to subagent ${info.agentId} (task ${taskId}). It will see it after its current tool call.`
    }

    if (info.status !== 'cancelled' && info.status !== 'orphaned') {
      return `Error: task ${taskId} is ${info.status} — message a running subagent, or a cancelled/orphaned one to resume it.`
    }

    // Resume: re-run the loop from the saved conversation snapshot plus this
    // message, in the same card (same agentId), tabs, and sandbox session.
    const saved = sctx.tasks.getResume(taskId)
    if (!saved) return `Error: task ${taskId} has no saved context to resume from. Spawn a new subagent instead.`
    const resumeTabIds: number[] = []
    for (const tabId of saved.tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId)
        if (!isBlankOrNewTab(tab)) resumeTabIds.push(tabId)
      } catch {
        return `Error: cannot resume task ${taskId} — tab ${tabId} no longer exists.`
      }
    }
    const resumeSurfaces = resumeTabIds.map(tabSurface)
    const conflict = sctx.tabAssignments.claimSurfaces(info.agentId, resumeSurfaces)
    if (conflict) {
      return `Error: cannot resume task ${taskId} — ${describeSurface(conflict.surface)} is now held by ${conflict.ownerAgentId}.`
    }
    const controller = sctx.tasks.reopen(taskId)
    if (!controller) {
      sctx.tabAssignments.releaseAll(info.agentId)
      return `Error: could not reopen task ${taskId} (it may have changed state).`
    }
    const messages: ModelMessage[] = [...saved.messages, { role: 'user', content: text }]
    sctx.tasks.updateResumeMessages(taskId, messages)
    const childCtx: AgentContext = {
      agentId: info.agentId,
      currentTabId: resumeTabIds[0] ?? sctx.getParentCurrentTabId(),
      allowedTabIds: resumeTabIds,
      offlineOnly: resumeTabIds.length === 0,
      // Carry over tabs opened before the cancel so the resumed run still
      // cleans them up when it finishes.
      createdTabIds: new Set(saved.createdTabIds ?? []),
    }
    runDetached({
      taskId,
      childCtx,
      messages,
      task: info.description,
      parentToolCallId: saved.parentToolCallId,
      signal: controller.signal,
      scopeTabIds: [...resumeTabIds],
      keepTabs: saved.keepTabs,
    })
    debugLog.log('agent', 'subagent resumed', { taskId, agentId: info.agentId })
    return `Resumed subagent ${info.agentId} (task ${taskId}) from its saved context with your message attached. Poll it with task_wait or task_status.`
  }

  return { spawn, message }
}
