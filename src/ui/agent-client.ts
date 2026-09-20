import type { AgentRuntime, ModelSwitchScope, SessionModelOverride } from '../agent'
import type { AgentEvent, RunTurnOptions, TaskInfo, TurnResult } from '../shared/types'
import type { UserPromptAnswer } from '../shared/user-prompt'
import { uid } from '../shared/ids'
import { abortable, throwIfAborted } from '../shared/abort'
import {
  AGENT_HOST_PORT,
  EXECUTION_KEY_PREFIX,
  type AgentHostClientMessage,
  type AgentHostServerMessage,
  type ExecutionInteraction,
  type ExecutionSnapshot,
} from '../shared/execution-protocol'

interface PendingRun {
  options: RunTurnOptions
  resolve: (result: TurnResult) => void
  reject: (error: Error) => void
  handledInteraction?: string
}

export interface ExecutionClient {
  ready(): Promise<void>
  list(): ExecutionSnapshot[]
  onChange(listener: (snapshot: ExecutionSnapshot) => void): () => void
  steer(chatId: string, text: string): void
  cancelChat(chatId: string): void
  answerInteraction(runId: string, requestId: string, value: boolean | UserPromptAnswer | string): void
  acknowledge(runId: string): Promise<void>
}

export function createAgentClient(): { agent: AgentRuntime; executions: ExecutionClient } {
  let port: chrome.runtime.Port | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let readyPromise: Promise<void> | undefined
  let readyResolve: (() => void) | undefined
  const pending = new Map<string, PendingRun>()
  const snapshots = new Map<string, ExecutionSnapshot>()
  const tasks = new Map<string, TaskInfo>()
  const taskListeners = new Set<(task: TaskInfo) => void>()
  const snapshotListeners = new Set<(snapshot: ExecutionSnapshot) => void>()
  let modelOverride: SessionModelOverride | undefined
  let modelOverrideGeneration = 0

  const connect = (): Promise<void> => {
    if (port && readyPromise) return readyPromise
    if (!readyPromise) readyPromise = new Promise<void>((resolve) => { readyResolve = resolve })
    const connection = chrome.runtime.connect({ name: AGENT_HOST_PORT })
    port = connection
    connection.onMessage.addListener((raw) => {
      if (port === connection) handle(raw as AgentHostServerMessage)
    })
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      if (port !== connection) return
      port = undefined
      // Preserve callers awaiting an unfinished handshake across reconnects.
      if (!readyResolve) readyPromise = undefined
      if (reconnectTimer === undefined) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined
          void connect()
        }, 500)
      }
    })
    return readyPromise
  }

  const post = (message: AgentHostClientMessage): void => {
    try { port?.postMessage(message) } catch { /* reconnect will reattach */ }
  }

  const handle = (message: AgentHostServerMessage): void => {
    if (message.type === 'ready') {
      for (const snapshot of message.executions) acceptSnapshot(snapshot)
      for (const task of message.tasks) acceptTask(task)
      readyResolve?.()
      readyResolve = undefined
      // A port may have dropped after start but before the frame reached the
      // worker. Re-send only runs the host does not already know.
      for (const [runId, run] of pending) {
        if (run.options.signal.aborted) {
          if (message.executions.some((snapshot) => snapshot.runId === runId)) {
            post({ type: 'cancel', runId })
          } else {
            pending.delete(runId)
            run.reject(new DOMException('Cancelled by user', 'AbortError'))
          }
          continue
        }
        if (snapshots.has(runId)) continue
        startRemote(runId, run.options)
      }
      for (const snapshot of message.executions) void resumeInteraction(snapshot)
      return
    }
    if (message.type === 'event') {
      pending.get(message.runId)?.options.onEvent(message.event)
      return
    }
    if (message.type === 'task') {
      acceptTask(message.task)
      return
    }
    if (message.type === 'interaction') {
      const snapshot = snapshots.get(message.runId)
      if (snapshot) snapshot.interaction = message.interaction
      void handleInteraction(message.runId, message.interaction)
      return
    }
    if (message.type === 'snapshot') acceptSnapshot(message.snapshot)
  }

  const acceptTask = (task: TaskInfo): void => {
    tasks.set(task.id, task)
    for (const listener of taskListeners) listener(task)
  }

  const acceptSnapshot = (snapshot: ExecutionSnapshot): void => {
    const previous = snapshots.get(snapshot.runId)
    if (previous && (snapshot.eventSeq < previous.eventSeq ||
      (snapshot.eventSeq === previous.eventSeq && snapshot.updatedAt < previous.updatedAt))) return
    snapshots.set(snapshot.runId, snapshot)
    for (const listener of snapshotListeners) listener(snapshot)
    const run = pending.get(snapshot.runId)
    if (snapshot.interaction) void handleInteraction(snapshot.runId, snapshot.interaction)
    if (!run) return
    if ((snapshot.status === 'done' || snapshot.status === 'cancelled') && snapshot.result) {
      pending.delete(snapshot.runId)
      run.resolve(snapshot.result)
    } else if (snapshot.status === 'cancelled' || snapshot.status === 'error' || snapshot.status === 'interrupted') {
      pending.delete(snapshot.runId)
      run.reject(snapshot.status === 'cancelled'
        ? new DOMException(snapshot.error ?? 'Cancelled', 'AbortError')
        : new Error(snapshot.error ?? `Execution ${snapshot.status}`))
    }
  }

  const handleInteraction = async (runId: string, interaction: ExecutionInteraction): Promise<void> => {
    const run = pending.get(runId)
    if (!run || run.handledInteraction === interaction.requestId) return
    run.handledInteraction = interaction.requestId
    let value: boolean | UserPromptAnswer | string
    try {
      if (interaction.kind === 'step') {
        value = run.options.onStepLimit ? await run.options.onStepLimit(interaction.steps ?? 0) : false
      } else {
        value = run.options.askUser && interaction.prompt
          ? await run.options.askUser(interaction.prompt)
          : { status: 'cancelled', reason: 'error' }
      }
    } catch {
      value = interaction.kind === 'step'
        ? false
        : { status: 'cancelled', reason: 'error' }
    }
    post({ type: 'interaction-result', runId, requestId: interaction.requestId, value })
  }

  const resumeInteraction = async (snapshot: ExecutionSnapshot): Promise<void> => {
    if (snapshot.interaction) await handleInteraction(snapshot.runId, snapshot.interaction)
  }

  const startRemote = (runId: string, options: RunTurnOptions): void => {
    if (!options.lifecycleRecord) throw new Error('durable runTurn requires lifecycleRecord')
    post({
      type: 'start',
      runId,
      options: {
        chatId: options.chatId,
        messages: options.messages,
        settings: options.settings,
        record: options.lifecycleRecord,
        capabilities: { askUser: !!options.askUser },
      },
    })
  }

  const agent: AgentRuntime = {
    runTurn: async (options) => {
      await abortable(connect(), options.signal)
      throwIfAborted(options.signal)
      const runId = uid('turn')
      return new Promise<TurnResult>((resolve, reject) => {
        const onAbort = (): void => post({ type: 'cancel', runId })
        const cleanup = (): void => options.signal.removeEventListener('abort', onAbort)
        pending.set(runId, {
          options,
          resolve: (result) => { cleanup(); resolve(result) },
          reject: (error) => { cleanup(); reject(error) },
        })
        options.signal.addEventListener('abort', onAbort, { once: true })
        startRemote(runId, options)
      })
    },
    listTasks: () => [...tasks.values()],
    cancelTask: (taskId) => post({ type: 'task-cancel', taskId }),
    nudgeTask: (taskId, text) => {
      const task = tasks.get(taskId)
      if (!task || task.status !== 'running') return false
      post({ type: 'task-nudge', taskId, text })
      return true
    },
    cancelChatTasks: (chatId) => post({ type: 'cancel', chatId }),
    onTaskUpdate: (listener) => {
      taskListeners.add(listener)
      return () => taskListeners.delete(listener)
    },
    setModelOverride: (value) => {
      modelOverrideGeneration += 1
      modelOverride = value ? { ...value, generation: modelOverrideGeneration } : undefined
      post({ type: 'model-override', value })
    },
    getModelOverride: () => modelOverride,
  }

  const executions: ExecutionClient = {
    ready: connect,
    list: () => [...snapshots.values()],
    onChange: (listener) => {
      snapshotListeners.add(listener)
      return () => snapshotListeners.delete(listener)
    },
    steer: (chatId, text) => post({ type: 'steer', chatId, text }),
    cancelChat: (chatId) => post({ type: 'cancel', chatId }),
    answerInteraction: (runId, requestId, value) => post({ type: 'interaction-result', runId, requestId, value }),
    acknowledge: async (runId) => {
      snapshots.delete(runId)
      await chrome.storage.local.remove(`${EXECUTION_KEY_PREFIX}${runId}`)
    },
  }

  void connect()
  return { agent, executions }
}
