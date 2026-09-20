/**
 * Agent runtime composition root.
 *
 * `createAgentRuntime({ cdp, sandbox })` wires the task registry, the main-agent
 * turn loop (`runTurn`), and task list/cancel. `runTurn` runs the shared
 * `runLoop` as the main agent ('main') and returns a `TurnResult`. Task changes
 * are exposed via `onTaskUpdate` (runtime-lifetime, routed by task.chatId) —
 * NOT through `opts.onEvent` — because background subagents outlive the turn
 * that spawned them and their updates must keep reaching the UI afterwards.
 */

import type { ModelMessage } from 'ai'
import type {
  CdpService,
  SandboxService,
  VirtualFileSystemService,
  RunAgentTurn,
  RunTurnOptions,
  TurnResult,
  TaskInfo,
  AgentEvent,
} from '../shared/types'
import { debugLog } from '../shared/debug-log'
import { TaskRegistry } from './tasks'
import { runLoop, getActiveTabId } from './run'
import { makeSpawnSubagent, createTabAssignments } from './subagents'
import { makeRunWorkflow } from './workflows'
import { MainAgentPriority } from './rate-limit'
import { SessionModelSwitch, type ModelSwitchScope, type SessionModelOverride } from './model-switch'
import type { AgentContext, TaskAccess } from './tools'
import type { ArtifactHostService } from '../shared/artifacts'
import { createAgentTabGroups } from './tab-groups'

export type { ModelSwitchScope, SessionModelOverride } from './model-switch'

export interface AgentDeps {
  cdp: CdpService
  sandbox: SandboxService
  vfs: VirtualFileSystemService
  /** Live artifact viewers (service-worker host only). */
  artifacts?: ArtifactHostService
}

export interface AgentRuntime {
  runTurn: RunAgentTurn
  listTasks(): TaskInfo[]
  cancelTask(taskId: string): void
  /**
   * Queue a steering message for a running background task without costing
   * a model turn on the main agent (used by the task tray's Nudge button).
   * Returns false if the task isn't running (e.g. it just finished).
   */
  nudgeTask(taskId: string, text: string): boolean
  /** Cancel every still-running background subagent spawned by this chat (user stop). */
  cancelChatTasks(chatId: string): void
  /** Subscribe to background-task changes for the runtime's lifetime; returns unsubscribe. */
  onTaskUpdate(listener: (task: TaskInfo) => void): () => void
  /**
   * Session-wide model override (main and/or subagents → e.g. Grok after an
   * OpenAI rate limit). Applies mid-task at the next step boundary, or
   * immediately when a request is only waiting on a rate-limit retry.
   */
  setModelOverride(override: { modelId: string; scope: ModelSwitchScope } | undefined): void
  getModelOverride(): SessionModelOverride | undefined
}

export function createAgentRuntime(deps: AgentDeps): AgentRuntime {
  const tasks = new TaskRegistry()
  const compactingAgents = new Set<string>()
  // Rehydrate persisted background tasks (survivors of a context restart)
  // before any turn or tool can consult the registry.
  void tasks.hydrate()
  const tabGroups = createAgentTabGroups()
  const tabAssignments = createTabAssignments()
  // Shared across all chats: rate limits are provider-global, so any chat's
  // main agent takes admission priority over any subagent.
  const priority = new MainAgentPriority()
  // Session-scoped model override (survives turns; cleared only explicitly or
  // when the extension reloads).
  const modelSwitch = new SessionModelSwitch()

  const taskAccess: TaskAccess = {
    get: (id) => tasks.get(id),
    list: () => tasks.list(),
    cancel: (id) => tasks.cancel(id),
    signal: (id) => tasks.signal(id),
    steer: (id, text) => tasks.steer(id, text),
    canResume: (id) => tasks.canResume(id),
    markFailureReported: (id) => tasks.markFailureReported(id),
  }

  const runTurn: RunAgentTurn = async (opts: RunTurnOptions): Promise<TurnResult> => {
    await tasks.hydrate()
    const emit = (e: AgentEvent) => {
      if (e.type === 'compaction') {
        if (e.status === 'running') compactingAgents.add(e.agentId)
        else compactingAgents.delete(e.agentId)
      } else if (e.type === 'agent-finish' || e.type === 'agent-error') {
        compactingAgents.delete(e.agentId)
      }
      try {
        opts.onEvent(e)
      } catch (err) {
        debugLog.error('agent', 'onEvent threw', err)
      }
    }

    const agentId = 'main'
    const currentTabId = await getActiveTabId()
    const ctx: AgentContext = {
      agentId,
      currentTabId,
      // undefined => unrestricted main agent
      allowedTabIds: undefined,
      createdTabIds: new Set(),
    }

    const getModelOverride = (): SessionModelOverride | undefined => modelSwitch.get()

    const subagents = makeSpawnSubagent({
      parentAgentId: agentId,
      chatId: opts.chatId,
      parentAllowedTabIds: undefined,
      getParentCurrentTabId: () => ctx.currentTabId,
      settings: opts.settings,
      emit,
      deps,
      tasks,
      tabGroups,
      tabAssignments,
      parentSignal: opts.signal,
      priority,
      getModelOverride,
    })

    const runWorkflow = makeRunWorkflow({
      chatId: opts.chatId,
      emit,
      sandbox: deps.sandbox,
      vfs: deps.vfs,
      tasks,
      spawnSubagent: subagents.spawn,
      parentSignal: opts.signal,
    })

    const sandboxSessionId = `sess-${opts.chatId}-main`

    debugLog.log('agent', 'runTurn start', {
      chatId: opts.chatId,
      modelId: opts.settings.modelId,
      currentTabId,
    })

    const result = await runLoop({
      ctx,
      chatId: opts.chatId,
      settings: opts.settings,
      modelId: opts.settings.modelId,
      messages: opts.messages as ModelMessage[],
      steering: opts.steering,
      signal: opts.signal,
      emit,
      deps,
      spawnSubagent: subagents.spawn,
      messageSubagent: subagents.message,
      runWorkflow,
      tasks: taskAccess,
      sandboxSessionId,
      tabGroups,
      isSubagent: false,
      priority,
      onStepLimit: opts.onStepLimit,
      onStepMessages: opts.onStepMessages,
      askUser: opts.askUser,
      getModelOverride,
    })

    return {
      responseMessages: result.responseMessages,
      text: result.text,
      usage: result.usage,
      finishReason: result.finishReason,
      steps: result.stepCount,
      errorText: result.errorText,
    }
  }

  return {
    runTurn,
    listTasks: () => tasks.list(),
    cancelTask: (taskId: string) => tasks.cancel(taskId),
    nudgeTask: (taskId: string, text: string) => {
      const agentId = tasks.get(taskId)?.agentId
      return agentId && compactingAgents.has(agentId) ? false : tasks.steer(taskId, text)
    },
    cancelChatTasks: (chatId: string) => tasks.cancelForChat(chatId),
    onTaskUpdate: (listener) => tasks.onChange(listener),
    setModelOverride: (override) => modelSwitch.set(override),
    getModelOverride: () => modelSwitch.get(),
  }
}
