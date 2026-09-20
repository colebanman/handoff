import type { DiagnosticEvent } from '../shared/runtime-diagnostics'
import { createAgentRuntime, type AgentRuntime } from '../agent'
import { createCdpService } from '../cdp'
import { applyEvent } from '../ui/reducer'
import { isCompacting } from '../shared/compaction'
import { sanitizeModelMessages } from '../shared/model-messages'
import { uid } from '../shared/ids'
import { formatError } from '../shared/errors'
import { debugLog } from '../shared/debug-log'
import { diagnosticOperations } from '../shared/runtime-diagnostics'
import { abortable, throwIfAborted } from '../shared/abort'
import { STEP_CHECKPOINT, type AgentEvent, type CdpService, type TaskInfo } from '../shared/types'
import type { UserPromptAnswer } from '../shared/user-prompt'
import {
  AGENT_HOST_PORT,
  EXECUTION_KEY_PREFIX,
  type AgentHostClientMessage,
  type AgentHostServerMessage,
  type ExecutionInteraction,
  type ExecutionSnapshot,
  type OffscreenRuntimeMessage,
  type SerializableRunOptions,
} from '../shared/execution-protocol'
import { createBackgroundRuntimeServices } from './runtime-services'
import { createStickyHost } from './sticky-host'
import { createArtifactHost } from './artifact-host'
import { createAutomationHost } from './automation-host'
import { seedBundledSkills } from '../storage/seed-skills'

interface LiveExecution {
  snapshot: ExecutionSnapshot
  requestMessages: unknown[]
  controller: AbortController
  steering: string[]
  persistTimer?: ReturnType<typeof setTimeout>
  persistQueue?: Promise<void>
}

interface InteractionWaiter {
  runId: string
  resolve: (value: boolean | UserPromptAnswer | string) => void
}

const ownerId = uid('host')
const ports = new Set<chrome.runtime.Port>()
const runs = new Map<string, LiveExecution>()
const interactions = new Map<string, InteractionWaiter>()
const finishListeners = new Set<(snapshot: ExecutionSnapshot) => void>()
const executionEvents = new Map<string, DiagnosticEvent[]>()

export function hostedDiagnosticState(chatId?: string) {
  const run = [...runs.values()].find((run) => run.snapshot.chatId === chatId)
  return { live: !!run, ownerId, snapshot: run?.snapshot, events: chatId ? [...(executionEvents.get(chatId) ?? [])] : [] }
}

const snapshotListeners = new Set<(snapshot: ExecutionSnapshot) => void>()

/** Read-only surfaces can observe progress without owning another chat store. */
export function onExecutionSnapshot(listener: (snapshot: ExecutionSnapshot) => void): () => void {
  snapshotListeners.add(listener)
  return () => snapshotListeners.delete(listener)
}

/** Match the sidebar: a manual selection supersedes only an all-agent override. */
export function clearHostedModelOverrideForSelection(modelId: string): void {
  const override = runtime.getModelOverride()
  if (override?.scope === 'all' && override.modelId !== modelId) runtime.setModelOverride(undefined)
}

export async function controlHostedTurn(message: AgentHostClientMessage): Promise<void> {
  await handleClient(message)
}

export async function getHostedSnapshots(): Promise<ExecutionSnapshot[]> {
  await initialized
  return loadSnapshots()
}
let runtime: AgentRuntime
let initialized: Promise<void> | undefined

let ensureRuntime: () => Promise<void>
let activityQueue: Promise<unknown> = Promise.resolve()

function setActivity(runId: string, active: boolean): Promise<void> {
  const next = activityQueue.catch(() => undefined).then(async () => {
    await ensureRuntime()
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'execution.activity', runId, active } satisfies OffscreenRuntimeMessage)
  })
  activityQueue = next
  return next
}

/** Whether a turn is live on this chat (background-started runs check before piling on). */
export function isChatRunning(chatId: string): boolean {
  return [...runs.values()].some((run) => run.snapshot.chatId === chatId && run.snapshot.status === 'running')
}

/** Observe finished executions (automations record their outcome from here). */
export function onExecutionFinished(listener: (snapshot: ExecutionSnapshot) => void): () => void {
  finishListeners.add(listener)
  return () => finishListeners.delete(listener)
}

/**
 * Start a turn without a panel (automations). The caller supplies the fully
 * built record and messages; the run is checkpointed like any other, so an
 * open or later-opened panel adopts it, and `onExecutionFinished` reports it.
 */
export async function startHostedTurn(options: SerializableRunOptions): Promise<{ runId: string }> {
  await initialized
  await ensureRuntime()
  if (isChatRunning(options.chatId)) throw new Error(`chat ${options.chatId} already has a turn running`)
  const runId = uid('turn')
  startExecution(runId, options)
  return { runId }
}

export function cancelHostedChat(chatId: string): boolean {
  const run = [...runs.values()].find((candidate) => candidate.snapshot.chatId === chatId)
  if (!run) return false
  requestCancel(run)
  return true
}

export function initAgentHost(ensureOffscreen: () => Promise<void>): {
  handleRuntimeMessage(message: Partial<OffscreenRuntimeMessage>): Promise<unknown> | undefined
  /** The CDP service that actually drives agent runs (browser-event listeners route here). */
  cdp: CdpService
} {
  ensureRuntime = ensureOffscreen
  const cdp = createCdpService()
  const artifacts = createArtifactHost(cdp)
  const automations = createAutomationHost({ startTurn: startHostedTurn, isChatRunning, onExecutionFinished })
  const extras = { artifacts, automations } as Parameters<typeof createBackgroundRuntimeServices>[2] & object
  const services = createBackgroundRuntimeServices(cdp, ensureOffscreen, extras)
  // Needs the VFS proxy the services expose, so it joins the dispatcher extras after construction.
  const stickies = createStickyHost(services.vfs)
  extras.stickies = stickies
  runtime = createAgentRuntime({ cdp, sandbox: services.sandbox, vfs: services.vfs, artifacts })
  runtime.onTaskUpdate((task) => handleTaskUpdate(task))
  const seeded = seedBundledSkills(services.vfs)
  initialized = hydrateExecutions()
  // Alarms survive restarts on their own; this re-arms drift, clears stale run
  // markers, and runs once whatever came due while the browser was closed.
  void Promise.all([seeded, initialized.then(() => automations.reconcile())]).catch((err) => console.error('[handoff] host startup', err))

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_HOST_PORT) return
    attach(port)
  })

  return {
    cdp,
    handleRuntimeMessage: (message) => {
      if (message.type === 'execution.debug') {
        const state = hostedDiagnosticState(message.chatId)
        return Promise.resolve(debugLog.dump({
          source: 'background execution host', chatId: message.chatId,
          ownerId, live: state.live, events: state.events,
          operations: diagnosticOperations(),
        }))
      }
      return services.handleMessage(message) ??
      artifacts.handleRuntimeMessage(message as Parameters<typeof artifacts.handleRuntimeMessage>[0]) ??
      automations.handleRuntimeMessage(message as Parameters<typeof automations.handleRuntimeMessage>[0]) ??
      stickies.handleRuntimeMessage(message as Parameters<typeof stickies.handleRuntimeMessage>[0])
    },
  }
}

async function hydrateExecutions(): Promise<void> {
  const stored = await readCheckpointStorage()
  const stale: ExecutionSnapshot[] = []
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(EXECUTION_KEY_PREFIX)) continue
    const snapshot = value as ExecutionSnapshot
    if (!snapshot?.runId || !snapshot.record) continue
    if (snapshot.status === 'running' || snapshot.status === 'cancelling') {
      snapshot.status = 'interrupted'
      snapshot.error = 'The MV3 service worker was terminated during this turn; the last durable checkpoint was preserved.'
      snapshot.updatedAt = Date.now()
      stale.push(snapshot)
    }
  }
  if (stale.length > 0) {
    await chrome.storage.local.set(Object.fromEntries(stale.map((snapshot) => [keyOf(snapshot.runId), snapshot])))
  }
}

function attach(port: chrome.runtime.Port): void {
  ports.add(port)
  port.onMessage.addListener((raw) => void handleClient(raw as AgentHostClientMessage))
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    ports.delete(port)
    // Deliberately no cancellation: the panel is an observer, not the owner.
  })
  void (initialized ?? Promise.resolve()).then(async () => {
    post(port, { type: 'ready', executions: await loadSnapshots(), tasks: runtime.listTasks() })
  })
}

async function handleClient(message: AgentHostClientMessage): Promise<void> {
  await initialized
  if (message.type === 'start') {
    if ([...runs.values()].some((run) => run.snapshot.chatId === message.options.chatId)) return
    startExecution(message.runId, message.options)
    return
  }
  if (message.type === 'cancel') {
    const targets = [...runs.values()].filter((run) =>
      message.runId ? run.snapshot.runId === message.runId : run.snapshot.chatId === message.chatId,
    )
    for (const run of targets) requestCancel(run)
    return
  }
  if (message.type === 'steer') {
    const run = [...runs.values()].find((candidate) => candidate.snapshot.chatId === message.chatId)
    if (run && run.snapshot.status === 'running' && !isCompacting(run.snapshot.record.transcript) && message.text.trim()) run.steering.push(message.text.trim())
    return
  }
  if (message.type === 'interaction-result') {
    const waiter = interactions.get(message.requestId)
    if (!waiter || waiter.runId !== message.runId) return
    interactions.delete(message.requestId)
    const run = runs.get(message.runId)
    if (run?.snapshot.interaction?.requestId === message.requestId) {
      run.snapshot.interaction = undefined
      checkpoint(run, true)
    }
    waiter.resolve(message.value)
    return
  }
  if (message.type === 'task-cancel') runtime.cancelTask(message.taskId)
  else if (message.type === 'task-nudge') runtime.nudgeTask(message.taskId, message.text)
  else if (message.type === 'model-override') runtime.setModelOverride(message.value)
  else if (message.type === 'list') broadcast({ type: 'ready', executions: await loadSnapshots(), tasks: runtime.listTasks() })
}

function startExecution(runId: string, options: SerializableRunOptions): void {
  const controller = new AbortController()
  const run: LiveExecution = {
    snapshot: {
      runId,
      ownerId,
      chatId: options.chatId,
      status: 'running',
      record: options.record,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      eventSeq: 0,
    },
    controller,
    requestMessages: options.messages,
    steering: [],
  }
  runs.set(runId, run)
  executionEvents.set(options.chatId, [{ type: 'run-start', at: Date.now() }])
  if (executionEvents.size > 20) executionEvents.delete(executionEvents.keys().next().value!)
  checkpoint(run, true)

  const onEvent = (event: AgentEvent): void => {
    if (run.controller.signal.aborted || run.snapshot.status !== 'running') return
    const events = executionEvents.get(options.chatId) ?? []
    executionEvents.set(options.chatId, events)
    const agentId = 'agentId' in event ? event.agentId : undefined
    const toolId = 'toolCallId' in event ? event.toolCallId : undefined
    const previous = events.at(-1)
    const chars = 'delta' in event ? event.delta.length : undefined
    if (chars !== undefined && previous?.type === event.type && previous.agentId === agentId && previous.toolId === toolId) {
      previous.at = Date.now(); previous.chars = (previous.chars ?? 0) + chars
    } else {
      events.push({ type: event.type, at: Date.now(), agentId, toolId, chars,
        detail: event.type === 'rate-limit' ? `attempt=${event.attempt} retryIn=${event.retryInMs}ms ${event.message ?? ''}`
          : event.type === 'agent-error' ? event.error : 'toolName' in event ? event.toolName : undefined })
      if (events.length > 24) events.shift()
    }
    run.snapshot.eventSeq += 1
    run.snapshot.updatedAt = Date.now()
    run.snapshot.record = { ...run.snapshot.record, transcript: applyEvent(run.snapshot.record.transcript, event), updatedAt: Date.now() }
    if (event.type === 'model-switch' && event.agentId === 'main') {
      run.snapshot.record.modelId = event.modelId
    }
    broadcast({ type: 'event', runId, seq: run.snapshot.eventSeq, event })
    checkpoint(run)
  }

  // Revoking the signal blocks subsequent tool dispatch. Do not make the
  // chat wait for an unresponsive renderer/RPC (or the tool cleanup joining
  // it) before releasing the turn for the user's queued correction.
  const execution = setActivity(runId, true).then(() => {
    throwIfAborted(controller.signal)
    return runtime.runTurn({
    chatId: options.chatId,
    messages: options.messages,
    settings: options.settings,
    signal: controller.signal,
    onEvent,
    onStepMessages: (messages) => {
      if (controller.signal.aborted) return
      run.snapshot.record = { ...run.snapshot.record, messages: sanitizeModelMessages(messages) }
      checkpoint(run)
    },
    steering: { take: () => run.steering.splice(0), peek: () => run.steering.length > 0 },
    onStepLimit: (steps) => {
      const limit = options.capabilities?.autoContinueSteps
      if (limit !== undefined) return Promise.resolve(steps < limit * STEP_CHECKPOINT)
      return waitForInteraction(run, { kind: 'step', steps }) as Promise<boolean>
    },
    askUser: options.capabilities?.askUser
      ? (prompt) => waitForInteraction(run, { kind: 'user-prompt', prompt: { ...prompt, id: uid('prompt') } }) as Promise<UserPromptAnswer>
      : undefined,
    })
  })
  void abortable(execution, controller.signal).then(
    (result) => finishExecution(run, controller.signal.aborted ? 'cancelled' : 'done', result),
    (error) => finishExecution(run, controller.signal.aborted ? 'cancelled' : 'error',
      controller.signal.aborted ? {
        responseMessages: run.snapshot.record.messages.slice(options.messages.length), text: '', steps: 0,
      } : undefined, formatError(error)),
  )
}

function requestCancel(run: LiveExecution): void {
  if (run.snapshot.status !== 'running') return
  run.snapshot.status = 'cancelling'
  run.snapshot.updatedAt = Date.now()
  checkpoint(run, true)
  runtime.cancelChatTasks(run.snapshot.chatId)
  run.controller.abort(new DOMException('Cancelled by user', 'AbortError'))
  for (const [requestId, waiter] of interactions) {
    if (waiter.runId !== run.snapshot.runId) continue
    interactions.delete(requestId)
    const kind = run.snapshot.interaction?.kind
    waiter.resolve(kind === 'step' ? false : { status: 'cancelled', reason: 'stopped' })
  }
}

function waitForInteraction(
  run: LiveExecution,
  value: Omit<ExecutionInteraction, 'requestId'>,
): Promise<boolean | UserPromptAnswer | string> {
  if (run.controller.signal.aborted) {
    if (value.kind === 'step') return Promise.resolve(false)
    return Promise.resolve({ status: 'cancelled', reason: 'stopped' })
  }
  const interaction: ExecutionInteraction = { ...value, requestId: uid('interaction') }
  run.snapshot.interaction = interaction
  checkpoint(run, true)
  broadcast({ type: 'interaction', runId: run.snapshot.runId, interaction })
  return new Promise((resolve) => interactions.set(interaction.requestId, { runId: run.snapshot.runId, resolve }))
}

function finishExecution(
  run: LiveExecution,
  status: 'done' | 'cancelled' | 'error',
  result?: import('../shared/types').TurnResult,
  error?: string,
): void {
  run.snapshot.status = status
  run.snapshot.result = result
  run.snapshot.error = error
  run.snapshot.interaction = undefined
  run.snapshot.updatedAt = Date.now()
  if (result && status === 'done') {
    run.snapshot.record = {
      ...run.snapshot.record,
      // Completed-step checkpoints already include part of the response.
      messages: sanitizeModelMessages([...run.requestMessages, ...result.responseMessages]),
      updatedAt: Date.now(),
    }
  }
  checkpoint(run, true)
  runs.delete(run.snapshot.runId)
  void setActivity(run.snapshot.runId, false).catch(console.error)
  const finished = structuredClone(run.snapshot)
  for (const listener of finishListeners) {
    try {
      listener(finished)
    } catch (err) {
      console.error('[handoff] execution finish listener', err)
    }
  }
}

function handleTaskUpdate(task: TaskInfo): void {
  broadcast({ type: 'task', task })
  const active = task.status === 'running' || task.status === 'cancelling'
  void setActivity(`task:${task.id}`, active).catch(console.error)
  if (!task.chatId) return
  for (const run of runs.values()) {
    if (run.snapshot.chatId !== task.chatId) continue
    run.snapshot.record = {
      ...run.snapshot.record,
      transcript: applyEvent(run.snapshot.record.transcript, { type: 'task-update', task }),
      updatedAt: Date.now(),
    }
    checkpoint(run)
  }
}

function checkpoint(run: LiveExecution, immediate = false): void {
  if (!immediate && run.persistTimer !== undefined) return
  if (run.persistTimer !== undefined) clearTimeout(run.persistTimer)
  const flush = (): void => {
    run.persistTimer = undefined
    const snapshot = structuredClone(run.snapshot)
    for (const listener of snapshotListeners) {
      try { listener(snapshot) } catch (error) { console.error('[handoff] snapshot listener', error) }
    }
    run.persistQueue = (run.persistQueue ?? Promise.resolve()).then(async () => {
      await chrome.storage.local.set({ [keyOf(snapshot.runId)]: snapshot })
      broadcast({ type: 'snapshot', snapshot })
    }).catch(console.error)
  }
  if (immediate) flush()
  else run.persistTimer = setTimeout(flush, 200)
}

function post(port: chrome.runtime.Port, message: AgentHostServerMessage): void {
  try { port.postMessage(message) } catch { /* disconnected observer */ }
}

function broadcast(message: AgentHostServerMessage): void {
  for (const port of ports) post(port, message)
}

function keyOf(runId: string): string {
  return `${EXECUTION_KEY_PREFIX}${runId}`
}

async function loadSnapshots(): Promise<ExecutionSnapshot[]> {
  const stored = await readCheckpointStorage()
  const snapshots = new Map(Object.entries(stored)
    .filter(([key]) => key.startsWith(EXECUTION_KEY_PREFIX))
    .map(([, value]) => value as ExecutionSnapshot)
    .filter((snapshot) => snapshot?.runId && snapshot.record)
    .map((snapshot) => [snapshot.runId, snapshot]))
  // A new panel must see the current stream even before its next disk flush.
  for (const run of runs.values()) snapshots.set(run.snapshot.runId, structuredClone(run.snapshot))
  return [...snapshots.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

async function readCheckpointStorage(): Promise<Record<string, unknown>> {
  // Reading every value deserializes the entire chat archive (including media)
  // on worker startup and again on every panel open. Only checkpoints are needed.
  if (typeof chrome.storage.local.getKeys === 'function') {
    const keys = (await chrome.storage.local.getKeys()).filter((key) =>
      key.startsWith(EXECUTION_KEY_PREFIX) && !runs.has(key.slice(EXECUTION_KEY_PREFIX.length)),
    )
    return keys.length > 0 ? chrome.storage.local.get(keys) : {}
  }
  // getKeys arrived after our minimum supported Chrome version.
  return chrome.storage.local.get(null)
}
