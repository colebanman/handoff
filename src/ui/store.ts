import { modelPickerProviders } from '../shared/model-picker'
/**
 * Small external store (useSyncExternalStore) that owns all UI state:
 *   - chat list (ChatMeta[])
 *   - current ChatRecord (messages + transcript)
 *   - settings
 *   - runningChatIds (chats with a live turn — parallel turns are supported)
 *
 * Actions: newChat, selectChat, deleteChat, sendMessage, stop, saveSettings.
 * Turns call runtime.agent.runTurn and fold events into the transcript via the
 * pure reducer, then persist the ChatRecord.
 *
 * Multi-chat model: each chat may have at most one active turn, but any number
 * of chats can run turns concurrently. Every AgentEvent for a chat — from its
 * running turn AND from background subagents that outlive that turn — routes
 * through the chat's newest fold (`chatEventSinks`), never into a stale
 * turn's working copy, so late subagent output and follow-up messages always
 * land in the same history. Switching chats never aborts a turn — it just
 * swaps which chat's record is on screen. Per-chat state (drafts, steering,
 * context usage, rate limits) is keyed by chat id so it survives navigation.
 *
 * State is immutable snapshots so useSyncExternalStore's getSnapshot stays
 * referentially stable between notifications.
 */
import { isRuntimeContextMessage } from '../shared/context-blocks'
import { isCompacting } from '../shared/compaction'
import { useSyncExternalStore } from 'react'
import type { AgentId, ChatCheckpoint, ChatRecord, ChatTurnMeta, CuratedModelProvider, OnboardingSetupRecord, ProviderKind, Settings, TaskInfo, TranscriptItem, Usage, UserAttachment, VirtualFileSystemService, VfsEntry, UserMessageSource } from '../shared/types'
import { DEFAULT_SETTINGS, FALLBACK_STARTER_PROMPTS, isOpenAIModelId, MODEL_OPTIONS, ONBOARDING_SETUP_TIMEOUT_MS, OPENAI_DEFAULT_MODEL_ID, pinnedSettingsForModel } from '../shared/types'
import { GROK_SWITCH_MODEL_ID, type ModelSwitchScope } from '../agent/model-switch'
import { applyMemoryWrite, ensureMemoryFile, MEMORY_PATH } from '../agent/memory'
import { LUNA_MODEL_ID, runOnboardingSetup } from '../agent/onboarding-luna'
import { padStarterPrompts, refreshStarterPrompts } from '../agent/starter-prompts'
import { MAX_FEEDBACK_SAMPLES, NEXT_PROMPT_MODEL_ID, predictNextPrompt } from '../agent/next-prompt'
import { hasModelAccess } from '../agent/models'
import { loadSettings, normalizeSettings, saveSettings as persistSettings, subscribeSettings } from '../storage/settings'
import {
  defaultOnboardingSetup,
  loadOnboardingSetup,
  normalizeOnboardingSetup,
  saveOnboardingSetup,
} from '../storage/onboarding'
import {
  CURRENT_MEMORY_BOOTSTRAP_VERSION,
  loadMemoryBootstrapVersion,
  markMemoryBootstrapComplete,
} from '../storage/memory-bootstrap'
import {
  listChats,
  getChat,
  newChat as makeChat,
  saveChat,
  deleteChat as removeChat,
  type ChatMeta,
} from '../storage/chats'
import { DEV_BUILD } from '../shared/dev-reset'
import { armTap } from '../shared/stream-tap'
import { openStreamInspector } from '../shared/stream-inspector'
import { uid } from '../shared/ids'
import { createUserPromptChannel, type UserPromptAnswer, type UserPromptRequest } from '../shared/user-prompt'
import { debugLog } from '../shared/debug-log'
import { formatError } from '../shared/errors'
import { sanitizeModelMessages } from '../shared/model-messages'
import { sliceWellFormed } from '../shared/text'
import { applyEvent, appendTranscriptItem } from './reducer'
import { RevealBuffer, type RevealCounts } from './reveal'
import { getRuntime, peekRuntime } from '../runtime'
import { captureTabShot } from './tabshot'
import { isChatGPTConnected } from '../agent/openai-chatgpt-oauth'
import type { BridgeErrorCode, ChatOrigin } from '../shared/bridge-protocol'
import { artifactNameFromPath, type ArtifactInvocation, type ArtifactRuntimeMessage } from '../shared/artifacts'
import type { ExecutionSnapshot } from '../shared/execution-protocol'
import {
  claimBrowserHandoffs,
  ensureOffscreenRuntime,
  type BrowserContextAttachment,
  type BrowserHandoff,
  type BrowserRuntimeMessage,
} from '../shared/browser-events'

/**
 * Provider-reported context usage for a chat, mirrored from `usage-update`
 * events. Deliberately never estimated locally: a character-count guess is off
 * by orders of magnitude once images/attachments are in the history, so the
 * meter shows nothing rather than a wrong number until the provider reports.
 */
export interface ContextUsageInfo {
  modelId: string
  usage: Usage
  updatedAt: number
}

/**
 * Set while the chat's turn is paused at a step checkpoint, waiting for the
 * user to say whether the agent should keep going (answerStepPrompt).
 */
export interface StepPrompt {
  /** Steps the turn has run so far. */
  steps: number
  at: number
}

/**
 * Wall-clock start of a chat's running turn. Written once when the turn starts
 * and removed when it ends — never on stream events — so the composer's elapsed
 * timer costs zero store writes per token (it ticks locally).
 */
export interface RunTimerState {
  startedAt: number
}

/**
 * Set on a chat when its last turn ended with zero visible output (no text,
 * reasoning, or tool activity reached the transcript) and wasn't a user
 * abort. Drives the inline `DeadTurnChip`. Cleared the moment that turn's
 * `finish()` re-evaluates it (a subsequent turn — retry or a fresh message —
 * always recomputes this from scratch, never accumulates).
 */
export interface DeadTurnInfo {
  at: number
}

/** Set while an agent's request is paused on a provider rate limit (retried indefinitely). */
export interface ChatRateLimit {
  agentId: AgentId
  attempt: number
  /** Timestamp (ms) when the next retry fires. */
  retryAt: number
  message?: string
  /** Subagent holding its attempt until the main agent's reply goes through. */
  waitingForMain?: boolean
}

/**
 * A UserAttachment staged in the composer, plus send-time extras that never
 * reach the persisted transcript: the composer-chip preview (a data URL, so
 * chips render without an async VFS read) and, for appshots, the AX-tree
 * snapshot text captured alongside the screenshot (delivered to the model
 * inside the message's <appshot> block) plus the VFS path the full snapshot was
 * written to (so a truncated block can point the model at the whole thing).
 */
export interface PendingAttachment extends UserAttachment {
  previewUrl: string
  snapshotText?: string
  snapshotPath?: string
}

export interface UiState {
  loaded: boolean
  startupPhase: 'loading' | 'connecting' | 'restoring'
  chats: ChatMeta[]
  current: ChatRecord
  settings: Settings
  /** OAuth tokens live in their own store; this mirrors only connection state for render-time gating. */
  chatgptConnected: boolean
  /** Chats with a live turn, in start order. Parallel turns are supported. */
  runningChatIds: string[]
  /** Composer draft per chat id (preserved across chat switches). */
  drafts: Record<string, string>
  /**
   * Predicted next user message per chat id, offered in the composer as an
   * accept-on-Tab suggestion. Only ever set for a chat that is idle with an
   * empty draft; anything the user types (or any new turn) drops it.
   */
  nextPrompt: Record<string, string>
  queuedMessages: QueuedChatMessage[]
  /** Pending mid-turn steering text per chat id. */
  steering: Record<string, string>
  /** Compact page/selection/link cards staged by Chrome's context menu. */
  browserContexts: Record<string, BrowserContextAttachment[]>
  /** Attachments staged in the composer per chat id (sent with the next message). */
  attachments: Record<string, PendingAttachment[]>
  /** Transient attachment errors per chat id (failed capture/upload), dismissable. */
  attachmentNotices: Record<string, string>
  /** Chats with an Appshot capture in flight. */
  appshotBusy: Record<string, boolean>
  contextUsage: Record<string, ContextUsageInfo>
  /** Live rate-limit waits per chat, keyed by agent id ('main' or 'sub-…'). */
  rateLimits: Record<string, Record<AgentId, ChatRateLimit>>
  /** Live background-task registry snapshot, keyed by task id (all chats). */
  tasks: Record<string, TaskInfo>
  /** Chats whose last turn ended with zero visible output and wasn't aborted. */
  deadTurns: Record<string, DeadTurnInfo>
  /** Turns paused at a step checkpoint ("keep going?"), per chat id. */
  stepPrompts: Record<string, StepPrompt>
  /**
   * Turns blocked on a user-prompt card (ask_user, approvals), per chat id.
   * The render copy only — the promise the turn is awaiting lives in
   * `userPromptChannel`, outside state, so snapshots stay serializable.
   */
  userPrompts: Record<string, UserPromptRequest>
  /** Start time of the running turn (composer elapsed timer), per chat id. */
  runTimer: Record<string, RunTimerState>
  /**
   * Session model override (rate-limit → Grok). Mirrored from the agent
   * runtime so the UI can show immediate, sticky confirmation of who switched.
   */
  modelOverride?: { modelId: string; scope: ModelSwitchScope }
  /** First-run onboarding walkthrough overlay is showing. */
  showOnboarding: boolean
  /**
   * State of the first-run Luna pass (seeds MEMORY.md + starter prompts).
   * `running` is what gates the composer with "still configuring…"; the record
   * is persisted so the generated prompts outlive a panel close.
   */
  setup: OnboardingSetupRecord
  /** True only for the first-run pass that is intentionally covered by onboarding. */
  setupBlocksComposer: boolean
  /**
   * A refresh is in flight. The empty chat shows four skeleton slots and fills
   * them from starterPromptsDraft instead of showing stale saved suggestions.
   * Always cleared when the refresh settles, success or not.
   */
  starterPromptsPending: boolean
  /** Partial prompts for the current refresh; never persisted. */
  starterPromptsDraft: string[]
  /**
   * Stream jitter buffer: revealed character counts for the on-screen chat's
   * still-arriving text/reasoning parts (see reveal.ts). View-time only — the
   * persisted transcript always holds the full text. An id absent from here
   * renders in full, so an idle or reopened chat is an empty object.
   */
  reveal: RevealCounts
}

export interface QueuedChatMessage {
  id: string
  chatId: string
  text: string
  at: number
  attachments?: PendingAttachment[]
  browserContexts?: BrowserContextAttachment[]
}

const QUEUED_MESSAGES_KEY = 'durable-queued-chat-messages-v1'

function persistQueuedMessages(messages: QueuedChatMessage[]): void {
  void chrome.storage.session.set({ [QUEUED_MESSAGES_KEY]: messages }).catch((err) =>
    debugLog.error('storage', 'persist queued messages', err),
  )
}

function setQueuedMessages(messages: QueuedChatMessage[]): void {
  setState({ queuedMessages: messages })
  persistQueuedMessages(messages)
}

function initialChat(modelId: string): ChatRecord {
  return makeChat(modelId)
}

let state: UiState = {
  loaded: false,
  startupPhase: 'loading',
  chats: [],
  current: initialChat(DEFAULT_SETTINGS.modelId),
  settings: { ...DEFAULT_SETTINGS },
  chatgptConnected: false,
  runningChatIds: [],
  drafts: {},
  nextPrompt: {},
  queuedMessages: [],
  steering: {},
  browserContexts: {},
  attachments: {},
  attachmentNotices: {},
  appshotBusy: {},
  contextUsage: {},
  rateLimits: {},
  tasks: {},
  deadTurns: {},
  stepPrompts: {},
  userPrompts: {},
  runTimer: {},
  showOnboarding: false,
  setup: defaultOnboardingSetup(),
  setupBlocksComposer: false,
  starterPromptsPending: false,
  starterPromptsDraft: [],
  reveal: {},
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/**
 * Coalesced notify for high-frequency streaming updates: state mutates
 * synchronously (getSnapshot is always current) but listeners fire at most
 * once per animation frame, so a burst of deltas costs one React render
 * instead of hundreds per second. The timeout is a fallback for hidden panels
 * where rAF is paused.
 */
let emitScheduled = false
function scheduleEmit(): void {
  if (emitScheduled) return
  emitScheduled = true
  const flush = (): void => {
    if (!emitScheduled) return
    emitScheduled = false
    emit()
  }
  requestAnimationFrame(flush)
  window.setTimeout(flush, 50)
}

/* ---- stream jitter buffer ------------------------------------------------
 * Display is decoupled from arrival so bursty deltas reveal at a steady pace
 * and the gap before a tool call is covered by text still landing. The buffer
 * is fed from every `current` we publish and drained by a rAF ticker; see
 * reveal.ts for the rate law and why this is view-time only. */

const revealBuffer = new RevealBuffer()
let revealRunning = false
/** Bumped by whichever of the rAF/timeout twins fires first, retiring the other. */
let revealGen = 0

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function startRevealTicker(): void {
  if (revealRunning || !revealBuffer.draining()) return
  revealRunning = true
  // Only on the idle → running edge: resyncing every step would zero out dt.
  revealBuffer.resync(nowMs())
  scheduleRevealStep()
}

function scheduleRevealStep(): void {
  const gen = ++revealGen
  const step = (): void => {
    if (gen !== revealGen) return
    revealGen++
    if (revealBuffer.tick(nowMs())) setState({ reveal: revealBuffer.counts() })
    if (revealBuffer.draining()) scheduleRevealStep()
    else revealRunning = false
  }
  // Same dual driver as scheduleEmit: rAF is paused while the side panel is
  // hidden, and a buffer that stops advancing would gate the feed forever.
  requestAnimationFrame(step)
  window.setTimeout(step, 50)
}

/** Abandon the reserve and paint everything now (Stop, or a resumed panel). */
function snapReveal(): void {
  if (revealBuffer.snapAll()) setState({ reveal: revealBuffer.counts() })
}

if (typeof document !== 'undefined') {
  // Nothing was watched while the panel was hidden, so there is no reveal to
  // finish — resuming into a several-second catch-up animation would be worse
  // than the burst it exists to smooth.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') snapReveal()
  })
}

function setState(patch: Partial<UiState>, opts?: { coalesce?: boolean }): void {
  if (patch.current && revealBuffer.observe(patch.current.id, patch.current.transcript)) {
    patch = { ...patch, reveal: revealBuffer.counts() }
  }
  state = { ...state, ...patch }
  if (opts?.coalesce) scheduleEmit()
  else emit()
  if (patch.current) startRevealTicker()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): UiState {
  return state
}

/** React hook returning the whole UI state. */
export function useStore(): UiState {
  return useSyncExternalStore(subscribe, getSnapshot)
}

function withKey<T>(map: Record<string, T>, key: string, value: T): Record<string, T> {
  return { ...map, [key]: value }
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

/* ---- turn control ------------------------------------------------------- */

/**
 * One live turn per chat. `snapshot()` returns the turn's current working
 * record so navigating back to a running chat shows its live transcript
 * instead of the last persisted one.
 */
interface ActiveTurn {
  controller: AbortController
  version: number
  snapshot: () => ChatRecord
}

const activeTurns = new Map<string, ActiveTurn>()

function chatIsRunning(chatId: string): boolean {
  return activeTurns.has(chatId) || state.runningChatIds.includes(chatId)
}

/**
 * Pending step-checkpoint decisions, keyed by chat id. The resolver completes
 * the promise the agent loop is awaiting in stopWhen; state.stepPrompts holds
 * the render-facing copy. Kept outside state so snapshots stay serializable.
 */
const stepPromptResolvers = new Map<string, (keepGoing: boolean) => void>()

function resolveStepPrompt(chatId: string, keepGoing: boolean): void {
  const resolve = stepPromptResolvers.get(chatId)
  if (!resolve) return
  stepPromptResolvers.delete(chatId)
  setState({ stepPrompts: withoutKey(state.stepPrompts, chatId) })
  resolve(keepGoing)
}

/** Answer the current chat's "keep going?" checkpoint prompt. */
export function answerStepPrompt(keepGoing: boolean): void {
  const chatId = state.current.id
  if (stepPromptResolvers.has(chatId)) {
    resolveStepPrompt(chatId, keepGoing)
    return
  }
  const runtime = peekRuntime()
  const recovered = runtime?.executions.list().find(
    (snapshot) => snapshot.chatId === chatId && snapshot.interaction?.kind === 'step',
  )
  if (recovered?.interaction) {
    runtime?.executions.answerInteraction(recovered.runId, recovered.interaction.requestId, keepGoing)
    setState({ stepPrompts: withoutKey(state.stepPrompts, chatId) })
  }
}

/**
 * Blocking user prompts (ask_user, approval cards). Same split as the step
 * checkpoint above: the promises live outside state, `state.userPrompts` is
 * the render mirror. Keyed by chat id, so switching chats hides the card
 * without settling the prompt — the turn stays parked until the user comes
 * back, answers in another way, or stops.
 */
const userPromptChannel = createUserPromptChannel()

/**
 * Raise a prompt on a chat and block until the user settles it. This is the
 * entry point for anything that needs a decision from the user mid-turn; the
 * agent layer reaches it through the `askUser` injected into runTurn.
 */
export function requestUserPrompt(
  chatId: string,
  req: Omit<UserPromptRequest, 'id'>,
): Promise<UserPromptAnswer> {
  const { request, answer } = userPromptChannel.raise(chatId, req)
  setState({ userPrompts: withKey(state.userPrompts, chatId, request) })
  debugLog.log('ui', `user prompt raised (${request.kind}: ${request.title})`)
  return answer
}

function resolveUserPrompt(chatId: string, answer: UserPromptAnswer): boolean {
  if (!userPromptChannel.resolve(chatId, answer)) return false
  setState({ userPrompts: withoutKey(state.userPrompts, chatId) })
  return true
}

/** Settle a chat's prompt card from the card's own buttons. */
export function answerUserPrompt(
  chatId: string,
  payload: { actionId: string; fields: Record<string, string>; notes?: string; always?: boolean },
): void {
  const answer: UserPromptAnswer = { status: 'answered', ...payload }
  if (resolveUserPrompt(chatId, answer)) return
  const runtime = peekRuntime()
  const recovered = runtime?.executions.list().find(
    (snapshot) => snapshot.chatId === chatId && snapshot.interaction?.kind === 'user-prompt',
  )
  if (recovered?.interaction) {
    runtime?.executions.answerInteraction(recovered.runId, recovered.interaction.requestId, answer)
    setState({ userPrompts: withoutKey(state.userPrompts, chatId) })
  }
}

/**
 * Newest event-fold function per chat. A background subagent emits through the
 * turn that spawned it for its whole life, so once a newer turn takes over an
 * older turn's onEvent forwards here — post-turn subagent progress lands in
 * the transcript that is actually current instead of a stale working copy.
 */
const chatEventSinks = new Map<string, (e: Parameters<typeof applyEvent>[1]) => void>()

/**
 * Per-chat immediate stop settle. Clicking Stop aborts the turn and its
 * subagents, but the abort fallout is async (and deliberately emits no
 * events) — this settles the visible transcript synchronously so shimmers,
 * running tool rows, and subagent activity stop the moment the user clicks.
 */
const chatStopSettles = new Map<string, () => void>()

/** Per-chat history versions guard against folding events after a rewind/delete. */
const historyVersions = new Map<string, number>()

function getHistoryVersion(chatId: string): number {
  return historyVersions.get(chatId) ?? 0
}

function bumpHistoryVersion(chatId: string): void {
  historyVersions.set(chatId, getHistoryVersion(chatId) + 1)
  // The abandoned branch's fold must not receive anything further; the next
  // turn on the new branch installs a fresh sink.
  chatEventSinks.delete(chatId)
  chatStopSettles.delete(chatId)
}

/**
 * Background tasks outlive the turn that spawned them, so task updates are
 * subscribed once for the runtime's lifetime and routed to each task's owning
 * chat — not forwarded through a single turn's onEvent, which would go silent
 * the moment that turn finished.
 */
let taskUpdatesWired = false

function ensureTaskUpdatesWired(): void {
  if (taskUpdatesWired) return
  taskUpdatesWired = true
  const runtime = getRuntime()
  // Seed with whatever tasks already exist (e.g. a second chat's turn
  // wired this before the tray for this chat ever rendered).
  const seeded: Record<string, TaskInfo> = {}
  for (const t of runtime.agent.listTasks()) seeded[t.id] = t
  setState({ tasks: seeded })
  runtime.agent.onTaskUpdate((task) => {
    setState({ tasks: withKey(state.tasks, task.id, task) })
    if (!task.chatId) return
    chatEventSinks.get(task.chatId)?.({ type: 'task-update', task })
  })
}

let executionUpdatesWired = false
let executionAdoption: Promise<void> = Promise.resolve()
const acknowledgedRemoteSteering = new Set<string>()

function queueExecutionSnapshot(snapshot: ExecutionSnapshot): void {
  // Test this at receipt as well: resolving a local turn happens in the same
  // tick, before the queued adoption would run and see activeTurns cleared.
  if (activeTurns.has(snapshot.chatId)) return
  for (const item of snapshot.record.transcript) {
    if (item.kind !== 'user' || !item.steered) continue
    const key = `${snapshot.runId}:${item.id}`
    if (acknowledgedRemoteSteering.has(key)) continue
    acknowledgedRemoteSteering.add(key)
    acknowledgeSteering(snapshot.chatId, item.text)
  }
  executionAdoption = executionAdoption.then(() => adoptExecutionSnapshot(snapshot)).catch((error) => {
    debugLog.error('storage', 'adopt execution snapshot', error)
  })
}

/** Reattach the observer UI to service-worker-owned turns after panel reload. */
function ensureExecutionUpdatesWired(): void {
  if (executionUpdatesWired) return
  executionUpdatesWired = true
  const runtime = getRuntime()
  runtime.executions.onChange(queueExecutionSnapshot)
  for (const snapshot of runtime.executions.list()) queueExecutionSnapshot(snapshot)
}

async function adoptExecutionSnapshot(snapshot: ExecutionSnapshot): Promise<void> {
  // The panel that started this turn already has a richer local harness
  // (turn timing, queue drain, notifications). Snapshots are its crash copy,
  // not a second writer while that harness is alive.
  if (activeTurns.has(snapshot.chatId)) return
  const active = snapshot.status === 'running' || snapshot.status === 'cancelling'
  const adoptedRecord = active ? snapshot.record : normalizeChat(snapshot.record)
  const runningChatIds = active
    ? state.runningChatIds.includes(snapshot.chatId)
      ? state.runningChatIds
      : [...state.runningChatIds, snapshot.chatId]
    : state.runningChatIds.filter((id) => id !== snapshot.chatId)
  const patch: Partial<UiState> = { runningChatIds }
  // The host is authoritative for a reattached turn. Local autosave timestamps
  // can be newer than its last event, especially while a tool is waiting.
  if (state.current.id === snapshot.chatId) {
    patch.current = adoptedRecord
  }
  if (snapshot.interaction?.kind === 'step') {
    patch.stepPrompts = withKey(state.stepPrompts, snapshot.chatId, {
      steps: snapshot.interaction.steps ?? 0,
      at: snapshot.updatedAt,
    })
  } else {
    patch.stepPrompts = withoutKey(state.stepPrompts, snapshot.chatId)
  }
  if (snapshot.interaction?.kind === 'user-prompt' && snapshot.interaction.prompt) {
    patch.userPrompts = withKey(state.userPrompts, snapshot.chatId, snapshot.interaction.prompt)
  } else {
    patch.userPrompts = withoutKey(state.userPrompts, snapshot.chatId)
  }
  if (active) patch.runTimer = withKey(state.runTimer, snapshot.chatId, { startedAt: snapshot.startedAt })
  else patch.runTimer = withoutKey(state.runTimer, snapshot.chatId)
  setState(patch)

  // Checkpoint storage is authoritative only for a panel gap. Once adopted,
  // mirror it into the ordinary chat store so all existing views/bridge reads
  // see the same progress.
  try {
    await saveChat(adoptedRecord, derivePreview(adoptedRecord))
    if (!active) {
      setState({ chats: await listChats() })
      await getRuntime().executions.acknowledge(snapshot.runId)
      if (snapshot.status === 'done' || snapshot.status === 'cancelled') {
        const steering = state.steering[snapshot.chatId]?.trim()
        if (steering) setState({ steering: withoutKey(state.steering, snapshot.chatId) })
        void (steering ? runTurn(adoptedRecord, steering, true) : runNextQueuedMessage(snapshot.chatId, adoptedRecord))
          .catch((error) => debugLog.error('ui', 'resume queued turn', error))
      }
    }
  } catch (err) {
    debugLog.error('storage', 'adopt execution checkpoint', err)
  }
}

/** Minimum wall time before a finished turn is worth notifying about. */
const LONG_TURN_NOTIFY_MS = 30_000

/** Windows to focus when a fired notification is clicked, keyed by notification id. */
const notificationClickWindows = new Map<string, number>()

let notificationClickWired = false

/** Wire the (extension-permission-gated) notification click -> focus window handler once. */
function ensureNotificationClickWired(): void {
  if (notificationClickWired) return
  if (!chrome.notifications?.onClicked) return
  notificationClickWired = true
  chrome.notifications.onClicked.addListener((notificationId) => {
    const windowId = notificationClickWindows.get(notificationId)
    notificationClickWindows.delete(notificationId)
    chrome.notifications.clear(notificationId).catch(() => {})
    if (windowId === undefined) return
    chrome.windows.update(windowId, { focused: true }).catch((err) => {
      debugLog.error('ui', 'focus window from notification click', err)
    })
  })
}

/**
 * Fire a "turn finished" notification (only called when the panel is hidden and
 * the turn ran long enough — see the call site in runTurn's finally block).
 * Best-effort: chrome.notifications may be unavailable (permission not yet
 * granted in an existing install until the next update) — never throws.
 */
async function notifyTurnComplete(text: string): Promise<void> {
  if (!chrome.notifications?.create) return
  ensureNotificationClickWired()
  try {
    const current = await chrome.windows.getCurrent()
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 60)
    const notificationId = await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon.svg'),
      title: 'Done',
      message: snippet || 'Turn finished.',
    })
    if (current.id !== undefined) notificationClickWindows.set(notificationId, current.id)
  } catch (err) {
    debugLog.error('ui', 'notify turn complete', err)
  }
}

/** First line of the newest user message, used as a chat title/preview seed. */
function derivePreview(chat: ChatRecord): string {
  for (let i = chat.transcript.length - 1; i >= 0; i--) {
    const it = chat.transcript[i]!
    if (it.kind === 'user') return it.text
    if (it.kind === 'text' && !it.streaming) return it.text
  }
  return ''
}

function deriveTitle(chat: ChatRecord): string {
  const firstUser = chat.transcript.find((it) => it.kind === 'user')
  if (firstUser && firstUser.kind === 'user') {
    const t = firstUser.text.replace(/\s+/g, ' ').trim()
    if (t) return t.length > 48 ? t.slice(0, 48) + '…' : t
    // Attachment-only message: title from the appshot's page title or filename.
    const att = firstUser.attachments?.[0]
    if (att) return (att.title || att.name).slice(0, 48)
    const context = firstUser.contexts?.[0]
    if (context) {
      const seed = context.text || context.title || context.targetUrl || context.pageUrl || 'Browser context'
      return seed.replace(/\s+/g, ' ').trim().slice(0, 48)
    }
    return 'New chat'
  }
  return chat.title || 'New chat'
}

function isImageEntry(entry: VfsEntry): boolean {
  return entry.root === 'workspace' && entry.mediaType.startsWith('image/')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function textMentionsFile(text: string, entry: VfsEntry): boolean {
  const lowered = text.toLowerCase()
  if (lowered.includes(entry.path.toLowerCase())) return true
  if (lowered.includes(entry.name.toLowerCase())) return true

  const stem = entry.name.replace(/\.[^.]+$/, '')
  if (stem.length < 8) return false
  return new RegExp(`\\b${escapeRegex(stem)}\\b`, 'i').test(text)
}

const MAX_CONTEXT_TABS = 40

function compactTabLine(tab: chrome.tabs.Tab, groupTitles: Map<number, string>): string {
  const title = (tab.title ?? '(untitled)').replace(/\s+/g, ' ').trim().slice(0, 60)
  const url = (tab.url ?? '').slice(0, 100)
  const group = tab.groupId !== undefined && tab.groupId !== -1 ? groupTitles.get(tab.groupId) : undefined
  return `- [${tab.id}]${tab.active ? '*' : ''} ${title} — ${url}${group ? ` (group "${group}")` : ''}`
}

/**
 * Ambient context auto-attached to outgoing user messages (model-facing only —
 * the visible transcript shows just what the user typed): local time and the
 * active tab on every message, plus the full tab list (with group names) on a
 * chat's first message so "see/check tab X" resolves to already-open tabs.
 * Appended to the NEW user message (prompt tail), so it never invalidates the
 * cached prompt prefix the way a per-turn system block would.
 */
async function buildAmbientContext(firstTurn: boolean): Promise<string> {
  try {
    const now = new Date()
    const lines: string[] = [
      `Local time: ${now.toLocaleString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })} (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'})`,
    ]
    const groupTitles = new Map<number, string>()
    if (firstTurn && chrome.tabGroups?.query) {
      try {
        for (const group of await chrome.tabGroups.query({})) {
          groupTitles.set(group.id, group.title || group.color)
        }
      } catch (err) {
        debugLog.error('ui', 'ambient context tab groups', err)
      }
    }
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (active) {
      const title = (active.title ?? '(untitled)').replace(/\s+/g, ' ').trim().slice(0, 60)
      lines.push(`Active tab: [${active.id}] ${title} — ${(active.url ?? '').slice(0, 100)}`)
    }
    if (firstTurn) {
      const tabs = await chrome.tabs.query({})
      lines.push(`Open tabs (${tabs.length}):`)
      for (const tab of tabs.slice(0, MAX_CONTEXT_TABS)) lines.push(compactTabLine(tab, groupTitles))
      if (tabs.length > MAX_CONTEXT_TABS) {
        lines.push(`- …and ${tabs.length - MAX_CONTEXT_TABS} more — api.tabs.list() for all`)
      }
    }
    return `<context>\n${lines.join('\n')}\n</context>`
  } catch (err) {
    debugLog.error('ui', 'ambient context', err)
    return ''
  }
}

/**
 * Cap the AX snapshot embedded in an <appshot> block. Generous on purpose: the
 * point of an appshot is that the model does NOT have to re-snapshot the tab,
 * and a truncated block sends it straight back to a tool call.
 */
const APPSHOT_SNAPSHOT_MAX_CHARS = 40_000

/**
 * Model-facing context for an Appshot: basic tab metadata plus the AX-tree
 * snapshot when that best-effort capture succeeded. The screenshot itself
 * rides along as a file part.
 */
function appshotContextBlock(att: PendingAttachment): string {
  const meta = [
    `screenshot: attached as ${att.name} (saved at ${att.path})`,
    att.title ? `title: ${att.title}` : undefined,
    att.url ? `url: ${att.url}` : undefined,
    att.tabId !== undefined ? `tabId: ${att.tabId}` : undefined,
    att.capturedAt ? `captured: ${new Date(att.capturedAt).toISOString()}` : undefined,
  ].filter(Boolean)
  let snapshot = ''
  if (att.snapshotText) {
    const overflow = att.snapshotText.length - APPSHOT_SNAPSHOT_MAX_CHARS
    const rest = att.snapshotPath
      ? `full snapshot saved to ${att.snapshotPath} — read it with api.fs.readText`
      : 'call browser_snapshot if the omitted content is needed'
    const body =
      overflow > 0
        ? `${sliceWellFormed(att.snapshotText, APPSHOT_SNAPSHOT_MAX_CHARS)}\n[Truncated ${overflow} chars — ${rest}.]`
        : att.snapshotText
    snapshot = `\nThis IS the page content at capture time — treat it as the page, not as a preview. You have already read this tree. Use its refs directly with the tabId above; no initial browser_snapshot is needed. If the page has since changed or a newer snapshot replaced these refs, use fresh refs instead:\n${body}`
  }
  return `<appshot>\nThe user captured their active tab while composing this message.\n${meta.join('\n')}${snapshot}\n</appshot>`
}

function browserContextBlock(context: BrowserContextAttachment): string {
  const source =
    context.kind === 'selection'
      ? 'selected text'
      : context.kind === 'link'
        ? 'link'
        : context.kind === 'image'
          ? 'image'
          : context.kind === 'media'
            ? 'media'
            : 'page'
  const lines = [
    `source: ${source}`,
    context.tabId !== undefined ? `tabId: ${context.tabId}` : undefined,
    context.title ? `page title: ${context.title}` : undefined,
    context.pageUrl ? `page URL: ${context.pageUrl}` : undefined,
    context.frameUrl ? `frame URL: ${context.frameUrl}` : undefined,
    context.targetUrl ? `target URL: ${context.targetUrl}` : undefined,
    context.text ? `selection: ${JSON.stringify(context.text)}` : undefined,
  ].filter(Boolean)
  return `<browser_context>\nThe user explicitly attached this compact browser context from Chrome's context menu. Use the tabId for fresh interaction only when needed; do not re-open a duplicate tab.\n${lines.join('\n')}\n</browser_context>`
}

function base64FromDataUrl(dataUrl: string): string | undefined {
  if (!dataUrl.startsWith('data:')) return undefined
  return dataUrl.split(',', 2)[1]
}

type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'file'; data: string; mediaType: string; filename: string }

async function buildUserModelMessage(
  text: string,
  vfs: VirtualFileSystemService,
  firstTurn: boolean,
  attachments: PendingAttachment[],
  browserContexts: BrowserContextAttachment[],
): Promise<unknown> {
  const context = await buildAmbientContext(firstTurn)
  const appshotBlocks = attachments.filter((att) => att.kind === 'appshot').map(appshotContextBlock)
  const browserContextBlocks = browserContexts.map(browserContextBlock)
  const modelText = [text, ...browserContextBlocks, ...appshotBlocks, context].filter(Boolean).join('\n\n')

  // Auto-attach workspace images the text refers to, skipping ones already
  // attached explicitly.
  const attachedPaths = new Set(attachments.map((att) => att.path.toLowerCase()))
  const entries = await vfs.list('workspace')
  const mentionedImages = entries
    .filter(
      (entry) =>
        isImageEntry(entry) &&
        entry.size <= 20_000_000 &&
        !attachedPaths.has(entry.path.toLowerCase()) &&
        textMentionsFile(text, entry),
    )
    .sort((a, b) => b.path.length - a.path.length)
    .slice(0, 4)

  const content: UserContentPart[] = [{ type: 'text', text: modelText }]
  for (const att of attachments) {
    try {
      const base64 = base64FromDataUrl(att.previewUrl) ?? base64FromDataUrl(await vfs.dataUrl(att.path))
      if (!base64) throw new Error(`no data for ${att.path}`)
      content.push({ type: 'file', data: base64, mediaType: att.mediaType, filename: att.name })
    } catch (err) {
      debugLog.error('ui', 'attach composer image', err)
    }
  }
  for (const entry of mentionedImages) {
    try {
      const bytes = await vfs.readBytes(entry.path, { length: entry.size })
      content.push({
        type: 'file',
        data: bytes.base64,
        mediaType: entry.mediaType,
        filename: entry.name,
      })
    } catch (err) {
      debugLog.error('ui', 'attach referenced workspace image', err)
    }
  }

  return content.length > 1 ? { role: 'user', content } : { role: 'user', content: modelText }
}

const NO_LIVE_AGENTS: ReadonlySet<string> = new Set()

/**
 * Agent ids of background subagent tasks that are still genuinely running.
 * Background tasks outlive the turn that spawned them, so their transcript rows
 * must not be finalized as interrupted between turns.
 */
function liveChildAgentIds(): ReadonlySet<string> {
  const runtime = peekRuntime()
  if (!runtime) return NO_LIVE_AGENTS
  const ids = new Set<string>()
  for (const task of runtime.agent.listTasks()) {
    if (task.status === 'running' || task.status === 'cancelling') ids.add(task.agentId)
  }
  return ids.size > 0 ? ids : NO_LIVE_AGENTS
}

/**
 * Settle transcript items left mid-flight by an interrupted turn (abort, crash,
 * panel close between autosaves): stop streaming shimmers and mark tools that
 * never resolved as errors so recovered chats don't show perpetual activity.
 * Rows whose child agent is a still-running background task are left untouched
 * — that work is live, not interrupted, and its events keep folding in.
 */
function finalizeInterrupted(
  items: TranscriptItem[],
  liveAgents: ReadonlySet<string>,
  outputText = 'Interrupted before completion.',
): TranscriptItem[] {
  return items.map((it) => {
    if (it.kind === 'compaction' && it.status === 'running' && !liveAgents.has(it.agentId)) return { ...it, status: 'cancelled' }
    if ((it.kind === 'reasoning' || it.kind === 'text') && it.streaming) return { ...it, streaming: false }
    if (it.kind === 'tool') {
      if (it.childAgentId && liveAgents.has(it.childAgentId)) return it
      const childItems = it.childItems ? finalizeInterrupted(it.childItems, liveAgents, outputText) : it.childItems
      const interrupted = it.status === 'running'
      const childStatus = it.childStatus === 'running' ? ('error' as const) : it.childStatus
      const workflow =
        it.workflow?.status === 'running' && !liveAgents.has(`workflow-${it.workflow.runId}`)
          ? {
              ...it.workflow,
              status: 'error' as const,
              error: outputText,
              endedAt: Date.now(),
              agents: it.workflow.agents.map((agent) =>
                agent.status === 'running'
                  ? { ...agent, status: 'error' as const, error: outputText, endedAt: Date.now() }
                  : agent,
              ),
            }
          : it.workflow
      if (interrupted || childStatus !== it.childStatus || childItems !== it.childItems || workflow !== it.workflow) {
        return {
          ...it,
          status: interrupted ? ('error' as const) : it.status,
          output: interrupted && it.output === undefined ? outputText : it.output,
          childStatus,
          childItems,
          workflow,
        }
      }
    }
    return it
  })
}

function normalizeChat(chat: ChatRecord): ChatRecord {
  return {
    ...chat,
    messages: Array.isArray(chat.messages) ? sanitizeModelMessages(chat.messages) : [],
    transcript: finalizeInterrupted(chat.transcript, liveChildAgentIds()),
    checkpoints: chat.checkpoints ?? [],
  }
}

function isUserModelMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'role' in message &&
    (message as { role?: unknown }).role === 'user' &&
    !isRuntimeContextMessage(message)
  )
}

function fallbackMessageCountBefore(chat: ChatRecord, transcriptIndexBefore: number): number {
  const usersBefore = chat.transcript
    .slice(0, Math.max(0, transcriptIndexBefore))
    .filter((item) => item.kind === 'user').length
  let seenUsers = 0
  for (let i = 0; i < chat.messages.length; i += 1) {
    if (isUserModelMessage(chat.messages[i])) {
      if (seenUsers === usersBefore) return i
      seenUsers += 1
    }
  }
  return chat.messages.length
}

function latestCheckpointBeforeIndex(chat: ChatRecord, transcriptIndex: number): ChatCheckpoint | undefined {
  const checkpoints = chat.checkpoints ?? []
  let best: ChatCheckpoint | undefined
  for (const checkpoint of checkpoints) {
    if (checkpoint.transcriptIndexBefore <= transcriptIndex && (!best || checkpoint.at > best.at)) best = checkpoint
  }
  return best
}

interface RevertResult {
  chat: ChatRecord
  draft: string
  /** Attachments of the reverted-away user message, for composer re-staging. */
  attachments?: UserAttachment[]
  contexts?: BrowserContextAttachment[]
}

function resolveRevert(chatInput: ChatRecord, itemId: string): RevertResult | undefined {
  const chat = normalizeChat(chatInput)
  const itemIndex = chat.transcript.findIndex((item) => item.id === itemId)
  if (itemIndex === -1) return undefined

  const item = chat.transcript[itemIndex]!
  let checkpoint: ChatCheckpoint | undefined

  if (item.kind === 'user') {
    checkpoint = chat.checkpoints?.find((cp) => cp.userItemId === item.id)
    if (!checkpoint) {
      checkpoint = {
        id: uid('cp'),
        userItemId: item.id,
        userText: item.text,
        at: item.at,
        transcriptIndexBefore: itemIndex,
        messageCountBefore: fallbackMessageCountBefore(chat, itemIndex),
      }
    }
  } else {
    checkpoint = latestCheckpointBeforeIndex(chat, itemIndex)
  }

  if (!checkpoint) return undefined

  // The reverted-away user message's attachments ride along so the composer
  // can restore the full draft — reverting a TabShot must bring back its
  // embed, not just the typed text.
  const revertedUser = chat.transcript.find((it) => it.id === checkpoint.userItemId)
  const attachments = revertedUser?.kind === 'user' ? revertedUser.attachments : undefined
  const contexts = revertedUser?.kind === 'user' ? revertedUser.contexts : undefined

  const nextTranscriptLength = Math.max(0, Math.min(checkpoint.transcriptIndexBefore, chat.transcript.length))
  const nextMessageLength = Math.max(0, Math.min(checkpoint.messageCountBefore, chat.messages.length))
  const transcript = chat.transcript.slice(0, nextTranscriptLength)
  const messages = chat.messages.slice(0, nextMessageLength)
  const checkpoints = (chat.checkpoints ?? []).filter((cp) => cp.transcriptIndexBefore < nextTranscriptLength)
  const draft = checkpoint.userText
  const next: ChatRecord = {
    ...chat,
    title: transcript.some((it) => it.kind === 'user') ? deriveTitle({ ...chat, transcript }) : 'New chat',
    updatedAt: Date.now(),
    messages,
    transcript,
    checkpoints,
  }

  return { chat: next, draft, attachments, contexts }
}

/* ---- init --------------------------------------------------------------- */

let initPromise: Promise<void> | undefined
let browserHandoffListenerWired = false
let browserHandoffDrain: Promise<void> | undefined

function ensureBrowserHandoffListener(): void {
  if (browserHandoffListenerWired) return
  browserHandoffListenerWired = true
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const message = raw as Partial<BrowserRuntimeMessage>
    if (message.target === 'ui' && message.type === 'handoff.available') void drainBrowserHandoffs()
    return false
  })
}

function researchPromptFor(context: BrowserContextAttachment): string {
  if (context.kind === 'selection') {
    return 'Research the attached selection. Explain what it means, verify the important claims, and include useful source links.'
  }
  if (context.kind === 'link') {
    return 'Research the attached link. Summarize the most important findings, verify key claims with additional sources, and include source links.'
  }
  if (context.kind === 'image' || context.kind === 'media') {
    return 'Research the attached media context and its source. Explain what it is, find the most relevant supporting information, and include source links.'
  }
  return 'Research the attached page. Summarize the most important findings, verify key claims, and include source links.'
}

async function applyBrowserHandoff(handoff: BrowserHandoff): Promise<void> {
  if (handoff.action === 'add-to-chat') {
    stageBrowserContext(state.current.id, handoff.context)
    debugLog.log('ui', `context added to chat (${handoff.context.kind})`)
    return
  }

  const current = initialChat(state.settings.modelId)
  setState({ current })
  stageBrowserContext(current.id, handoff.context)
  const prompt = researchPromptFor(handoff.context)
  if (hasActiveCredential()) {
    void sendMessage(prompt)
  } else {
    setComposerDraft(prompt)
  }
  debugLog.log('ui', `research handoff started (${handoff.context.kind})`)
}

function drainBrowserHandoffs(): Promise<void> {
  if (!state.loaded) return Promise.resolve()
  if (browserHandoffDrain) return browserHandoffDrain
  browserHandoffDrain = (async () => {
    try {
      const handoffs = await claimBrowserHandoffs()
      for (const handoff of handoffs) await applyBrowserHandoff(handoff)
    } catch (err) {
      debugLog.error('ui', 'claim context-menu handoff', err)
    } finally {
      browserHandoffDrain = undefined
    }
  })()
  return browserHandoffDrain
}

/** Pure gate kept exported so the production-upgrade behavior is regression tested. */
export function shouldBootstrapExistingUserMemory(showOnboarding: boolean, storedVersion: number): boolean {
  return !showOnboarding && storedVersion < CURRENT_MEMORY_BOOTSTRAP_VERSION
}

/** Whether the browser-derived setup pass can actually run with this profile. */
export function hasOnboardingSetupCredential(settings: Settings, chatgptConnected: boolean): boolean {
  return hasModelAccess(settings, LUNA_MODEL_ID, chatgptConnected)
}

/**
 * One-time production migration for profiles that predate MEMORY.md.
 *
 * The separate version marker matters: MEMORY.md remains user-owned, so after
 * this migration has run, deleting the file must not make a later panel open
 * recreate it. The empty canonical file lands first; an eligible idle profile
 * then gets the same Luna seeding pass as a new user, but in the background.
 */
async function bootstrapExistingUserMemory(args: {
  settings: Settings
  setup: OnboardingSetupRecord
  showOnboarding: boolean
  chatgptConnected: boolean
}): Promise<void> {
  const storedVersion = await loadMemoryBootstrapVersion()
  if (!shouldBootstrapExistingUserMemory(args.showOnboarding, storedVersion)) return

  const created = await ensureMemoryFile(getRuntime().vfs)
  await markMemoryBootstrapComplete()
  debugLog.log('storage', `existing-user memory bootstrap (${created ? 'created MEMORY.md' : 'file already present'})`)

  if (
    args.setup.status === 'idle' &&
    state.setup.status === 'idle' &&
    hasOnboardingSetupCredential(args.settings, args.chatgptConnected)
  ) {
    void runLunaPass({ blockComposer: false })
  }
}

/** Load settings + chat list once; open the most recent chat if any. */
export function initStore(): Promise<void> {
  if (initPromise) return initPromise
  // Other panels and account flows write the same settings record.
  // Subscribe before loading so a startup read cannot replace a newer change.
  let observedSettings: Settings | undefined
  subscribeSettings((settings) => { observedSettings = settings; setState({ settings }) })
  // Dev build only: arm the stream tap BEFORE anything can reach the network,
  // then surface the inspector. Arming is synchronous on purpose — tapFetch
  // decides whether to wrap at resolveModel time, so the onboarding pass (which
  // fires the moment ChatGPT connects) would otherwise be able to outrun the
  // async storage read. The window opens unfocused: the user is about to type in
  // the panel, not in the inspector.
  if (DEV_BUILD) {
    armTap()
    void openStreamInspector({ focus: false })
  }
  ensureBrowserHandoffListener()
  ensureArtifactInvocationListener()
  void ensureOffscreenRuntime().catch((err) => debugLog.error('ui', 'ensure offscreen runtime', err))
  initPromise = (async () => {
    try {
      // Connect while loading the saved UI, instead of starting another serial
      // round of worker/storage startup after the chat archive has loaded.
      const runtime = getRuntime()
      const [loadedSettings, chats, chatgptConnected, setup, queuedStorage] = await Promise.all([
        loadSettings(),
        listChats(),
        isChatGPTConnected().catch(() => false),
        loadOnboardingSetup(),
        chrome.storage.session.get(QUEUED_MESSAGES_KEY),
      ])
      const settings = observedSettings ?? loadedSettings
      let current: ChatRecord
      let openedRecord: ChatRecord | undefined
      const first = chats[0]
      if (first) {
        const rec = await getChat(first.id)
        openedRecord = rec
        current = rec ? normalizeChat(rec) : initialChat(settings.modelId)
      } else {
        current = initialChat(settings.modelId)
      }
      // First run: show onboarding when it was never completed and no key has
      // been configured yet (so an upgrade with existing keys skips it).
      const hasAnyKey =
        Boolean(settings.apiKey?.trim()) ||
        Object.values(settings.apiKeys ?? {}).some((k) => k?.trim())
      const hasChatGPT = settings.openaiAuthMode === 'chatgpt' && chatgptConnected
      let showOnboarding = !settings.onboardingComplete && !hasAnyKey && !hasChatGPT
      // The dev fresh-start reset deliberately KEEPS credentials (redoing OAuth
      // on every reload is too slow to retest onboarding with), so the two
      // credential clauses would suppress the very overlay the reset exists to
      // bring back. Written as a statement rather than a ternary because Rollup
      // folds `if (false)` bodies away completely, leaving production identical.
      if (DEV_BUILD) showOnboarding = !settings.onboardingComplete
      const queuedMessages = Array.isArray(queuedStorage[QUEUED_MESSAGES_KEY])
        ? queuedStorage[QUEUED_MESSAGES_KEY] as QueuedChatMessage[]
        : []
      setState({ settings: observedSettings ?? settings, chats, current, showOnboarding, chatgptConnected, setup, queuedMessages, startupPhase: 'connecting' })
      ensureTaskUpdatesWired()
      ensureExecutionUpdatesWired()
      await runtime.executions.ready()
      if (runtime.executions.list().length > 0) setState({ startupPhase: 'restoring' })
      await executionAdoption
      setState({ loaded: true })
      debugLog.log('ui', `store loaded (${chats.length} chats)`)
      // Use the raw persisted record here: normalizeChat intentionally settles
      // interrupted streaming rows for display, while suggestion recovery must
      // still be able to recognize that they never completed.
      if (openedRecord) startNextPromptPredictionOnOpen(openedRecord)
      void bootstrapExistingUserMemory({ settings, setup, showOnboarding, chatgptConnected }).catch((err) =>
        debugLog.error('storage', 'bootstrap existing-user memory', err),
      )
      void drainBrowserHandoffs()
      void drainArtifactInvocations()
    } catch (err) {
      debugLog.error('ui', 'initStore', err)
      setState({ loaded: true })
    }
  })()
  return initPromise
}

/** Refresh imported durable data without replacing the current chat or its draft. */
export async function refreshImportedData(): Promise<void> {
  await initStore()
  const [settings, chats, chatgptConnected] = await Promise.all([loadSettings(), listChats(), isChatGPTConnected().catch(() => false)])
  const current = state.current.messages.length === 0 && state.current.transcript.length === 0 && state.current.modelId === state.settings.modelId
    ? { ...state.current, modelId: settings.modelId } : state.current
  setState({ settings, chats, chatgptConnected, current })
}

/* ---- actions ------------------------------------------------------------ */

/** Start a fresh chat. Running turns in other chats keep going. */
export function newChat(): void {
  const current = initialChat(state.settings.modelId)
  const refreshStarters = state.settings.suggestNextPrompt !== false
  setState({
    current,
    starterPromptsPending: refreshStarters,
    starterPromptsDraft: [],
  })
  debugLog.log('ui', 'new chat')
  if (refreshStarters) refreshStarterPromptsInBackground()
}

/**
 * Regenerate the empty-chat suggestions for the chat the user just opened, from
 * their currently-open tabs plus their longer-term browsing.
 *
 * The screen gets four empty card skeletons first (`starterPromptsPending`)
 * rather than showing the previous chat's suggestions. Partial model output
 * then fills those slots token by token through `starterPromptsDraft`.
 *
 * Gated on the same toggle as composer suggestions — both are the same bargain
 * (a cheap extra model call in exchange for a guess about what you want next),
 * and a user who turned that off does not want this either.
 *
 * Only one refresh runs at a time: clicking "new chat" repeatedly aborts the
 * previous call instead of stacking requests.
 */
let starterPromptRun: AbortController | undefined
function refreshStarterPromptsInBackground(): void {
  starterPromptRun?.abort()
  const controller = new AbortController()
  starterPromptRun = controller
  void refreshStarterPrompts({
    vfs: getRuntime().vfs,
    settings: state.settings,
    signal: controller.signal,
    onUpdate: (prompts) => {
      if (controller.signal.aborted || starterPromptRun !== controller) return
      setState({ starterPromptsDraft: prompts }, { coalesce: true })
    },
  })
    .then((prompts) => {
      if (controller.signal.aborted) return
      // Empty means the call failed or produced nothing — fall back to whatever
      // was already stored rather than leaving the screen bare.
      if (prompts.length > 0) {
        commitSetup({
          ...state.setup,
          starterPrompts: padStarterPrompts(prompts, FALLBACK_STARTER_PROMPTS),
        })
      }
      setState({
        starterPromptsPending: false,
        starterPromptsDraft: [],
      })
    })
    .catch((err) => debugLog.error('ui', 'refresh starter prompts', err))
    .finally(() => {
      if (starterPromptRun === controller) starterPromptRun = undefined
      // Unconditional un-blank. An abort (a second "new chat") leaves the newer
      // run to clear this, but a throw must never strand the screen empty.
      if (state.starterPromptsPending && starterPromptRun === undefined) {
        setState({ starterPromptsPending: false, starterPromptsDraft: [] })
      }
    })
}

/**
 * Switch the view to another chat. Never aborts running turns: a chat with a
 * live turn shows its in-progress transcript via the turn's snapshot.
 */
export async function selectChat(id: string): Promise<void> {
  if (id === state.current.id) return
  const live = activeTurns.get(id)
  if (live) {
    setState({ current: live.snapshot() })
    debugLog.log('ui', `selected running chat ${id}`)
    return
  }
  const rec = await getChat(id)
  if (rec) {
    const current = normalizeChat(rec)
    setState({ current })
    debugLog.log('ui', `selected chat ${id}`)
    startNextPromptPredictionOnOpen(rec)
  }
}

export async function deleteChat(id: string): Promise<void> {
  stopChat(id)
  bumpHistoryVersion(id)
  chatEventSinks.delete(id)
  cancelNextPromptRun(id)
  offeredNextPrompts.delete(id)
  await removeChat(id)
  const chats = await listChats()
  const patch: Partial<UiState> = {
    chats,
    queuedMessages: state.queuedMessages.filter((message) => message.chatId !== id),
    drafts: withoutKey(state.drafts, id),
    nextPrompt: withoutKey(state.nextPrompt, id),
    steering: withoutKey(state.steering, id),
    browserContexts: withoutKey(state.browserContexts, id),
    attachments: withoutKey(state.attachments, id),
    attachmentNotices: withoutKey(state.attachmentNotices, id),
    appshotBusy: withoutKey(state.appshotBusy, id),
    contextUsage: withoutKey(state.contextUsage, id),
    rateLimits: withoutKey(state.rateLimits, id),
    deadTurns: withoutKey(state.deadTurns, id),
  }
  if (id === state.current.id) {
    const first = chats[0]
    const live = first ? activeTurns.get(first.id) : undefined
    if (live) {
      patch.current = live.snapshot()
    } else {
      const rec = first ? await getChat(first.id) : undefined
      patch.current = rec ? normalizeChat(rec) : initialChat(state.settings.modelId)
    }
  }
  setState(patch)
  persistQueuedMessages(patch.queuedMessages ?? state.queuedMessages)
  debugLog.log('ui', `deleted chat ${id}`)
}

export async function saveSettings(next: Settings): Promise<void> {
  // Normalize before setState so in-memory state matches what's persisted
  // (provider/vendor-prefix migration, per-provider key resolution).
  const normalized = normalizeSettings(next)
  await persistSettings(normalized)
  setState({ settings: normalized })
}

/* ---- onboarding --------------------------------------------------------- */

/** Curated default model to activate when a provider's key is first connected. */
function defaultModelForProvider(provider: ProviderKind): string {
  if (provider === 'cerebras') return MODEL_OPTIONS.find((model) => model.provider === 'cerebras')!.id
  if (provider === 'xai') return 'grok-4.6'
  return OPENAI_DEFAULT_MODEL_ID
}

/**
 * Save a provider's API key into the per-provider vault (pasted or generated).
 * If the currently active provider has no key yet, switch to the newly
 * connected one and its default model so the user can chat immediately;
 * otherwise the key is stored without disturbing the active selection.
 */
export async function connectProviderKey(provider: ProviderKind, key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) return
  const settings = state.settings
  const apiKeys = { ...(settings.apiKeys ?? {}), [provider]: trimmed }
  const activeHasKey = Boolean(apiKeys[settings.provider]?.trim()) && settings.provider !== provider
  const authMode = provider === 'openai' ? { openaiAuthMode: 'api-key' as const } : {}
  const next: Settings = activeHasKey
    ? { ...settings, ...authMode, apiKeys }
    : {
        ...settings,
        ...authMode,
        provider,
        apiKeys,
        apiKey: trimmed,
        modelId: defaultModelForProvider(provider),
      }
  await saveSettings(next)
  // Keep the on-screen (typically empty first-run) chat on the active model.
  if (!activeHasKey && !activeTurns.has(state.current.id)) {
    setState({ current: { ...state.current, modelId: next.modelId } })
  }
  debugLog.log('ui', `connected key for ${provider}`)
}

/** Activate the already-persisted ChatGPT OAuth session as the OpenAI credential. */
export async function connectChatGPTAccount(): Promise<void> {
  const next: Settings = {
    ...state.settings,
    provider: 'openai',
    openaiAuthMode: 'chatgpt',
    apiKey: '',
    modelId: OPENAI_DEFAULT_MODEL_ID,
  }
  setState({ chatgptConnected: true })
  await saveSettings(next)
  if (!activeTurns.has(state.current.id)) {
    setState({ current: { ...state.current, modelId: next.modelId } })
  }
  debugLog.log('ui', 'ChatGPT account activated')
}

/** Mirror OAuth storage changes into render-time credential gating. */
export function setChatGPTConnectionStatus(connected: boolean): void {
  setState({ chatgptConnected: connected })
}

/** What we keep of the answer to "what should we call you?" — a greeting, not a legal name. */
export const USER_NAME_MAX = 40

/**
 * Trim, collapse runs of whitespace, cap the length. Deliberately does NOT
 * title-case or otherwise "correct" the input: how someone writes their own
 * name (bell hooks, d'Angelo, XI) is not ours to fix.
 */
function sanitizeUserName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, USER_NAME_MAX).trim()
}

/**
 * The onboarding name step. Two writes, deliberately unequal in weight:
 *
 * - `settings.userName` is the source of truth for the empty-chat greeting; it
 *   has to be readable synchronously on first paint, which rules out MEMORY.md.
 * - The memory entry is how the *agent* comes to know it, through the same
 *   `applyMemoryWrite` path the memory tool and the Luna pass use — so it
 *   upserts by title and a re-typed name refreshes the entry instead of adding
 *   a second one.
 *
 * The memory write is best-effort. A VFS failure here would otherwise strand
 * the user on the last onboarding screen over a detail the agent can relearn.
 */
export async function saveUserName(name: string): Promise<void> {
  const clean = sanitizeUserName(name)
  if (!clean) return
  const previous = sanitizeUserName(state.settings.userName ?? '')
  await saveSettings({ ...state.settings, userName: clean })
  try {
    // The runtime's VFS, like the Luna pass: its writes emit the in-page change
    // the Files panel live-follows, so MEMORY.md appears without a re-list.
    await applyMemoryWrite(getRuntime().vfs, {
      memories: [{ title: '[Stable] Preferred name — how to address the user', body: `Address the user as ${clean}.` }],
      // Pre-category builds stored the value in the title. Remove either the
      // previous or re-entered legacy form in the same write; missing matches
      // are harmless and the user's file is never migrated just by opening it.
      forget: [...new Set([previous, clean].filter(Boolean).map((value) => `Goes by ${value}`))],
    })
  } catch (err) {
    debugLog.error('ui', 'saveUserName memory write', err)
  }
  // Value withheld: the debug log is exported wholesale from the header.
  debugLog.log('ui', 'saved user name')
}

/** Mark onboarding finished (or skipped) and dismiss the overlay. */
export async function completeOnboarding(): Promise<void> {
  setState({ showOnboarding: false })
  await saveSettings({ ...state.settings, onboardingComplete: true })
}

/* ---- the Luna pass (first-run setup) ------------------------------------- */

/**
 * Single writer for the setup record. Normalized before setState (as in
 * saveSettings) so the prompts on screen are exactly the clamped, trimmed set
 * that lands on disk, and persistence is fire-and-forget — a storage failure
 * must not hold up the pass or the UI.
 */
function commitSetup(record: OnboardingSetupRecord): void {
  const next = normalizeOnboardingSetup(record)
  setState({ setup: next })
  void saveOnboardingSetup(next).catch((err) => debugLog.error('storage', 'persist onboarding setup', err))
}

/**
 * Kick off the one-off background pass that seeds /workspace/MEMORY.md and the
 * starter prompts, the moment ChatGPT OAuth succeeds. Fire-and-forget: the
 * walkthrough screens are what covers its latency, and nothing about it is
 * allowed to block or fail onboarding.
 *
 * Idempotent by status — `running` means this panel already has one in flight,
 * `done` means the answer is already on disk. A `failed` record (including one
 * downgraded from an interrupted `running` at load) may be retried.
 */
export function startOnboardingSetup(): void {
  const { status } = state.setup
  if (status === 'running' || status === 'done') return
  void runLunaPass({ blockComposer: true })
}

/**
 * Replay the first-run walkthrough from Settings without touching credentials.
 * The persisted `onboardingComplete` flag is left alone — finishing the replay
 * sets it again — so closing the panel mid-replay costs nothing.
 */
export function replayOnboarding(): void {
  setState({ showOnboarding: true })
}

/**
 * Explicit re-run, from Settings. `startOnboardingSetup` is idempotent on `done`
 * — correct for the onboarding path, where ChatGPT's connect callback can fire
 * again on remount — but that also means the pass could otherwise only ever run
 * once per profile. Existing memories are left alone: the pass upserts by title,
 * so a re-run refreshes what it recognizes instead of duplicating it.
 */
export function rerunOnboardingSetup(): void {
  if (state.setup.status === 'running') return
  void runLunaPass({ blockComposer: false })
}

async function runLunaPass({ blockComposer }: { blockComposer: boolean }): Promise<void> {
  const startedAt = Date.now()
  // setState is synchronous, so this closes the idempotency window before any
  // await: a second caller in the same tick already sees `running`.
  setState({ setupBlocksComposer: blockComposer })
  commitSetup({ status: 'running', starterPrompts: [], startedAt })

  // Belt-and-braces timeout. runOnboardingSetup owns the same budget, but a
  // foreground first-run pass gates the composer, so the UI must never depend
  // on another module's timer to unlock it. Background passes share the bound.
  const controller = new AbortController()
  let timer: number | undefined
  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = window.setTimeout(() => {
      controller.abort()
      resolve({ ok: false, error: `timed out after ${Math.round(ONBOARDING_SETUP_TIMEOUT_MS / 1000)}s` })
    }, ONBOARDING_SETUP_TIMEOUT_MS)
  })

  try {
    // The runtime's VFS (not a fresh service) is what makes the write visible:
    // its putBlob emits the in-page change the Files panel live-follows, so the
    // new MEMORY.md appears without anyone re-listing entries here.
    const pass = runOnboardingSetup({
      vfs: getRuntime().vfs,
      settings: state.settings,
      signal: controller.signal,
    })
      .then((result) => ({ ok: true as const, ...result }))
      .catch((err) => {
        // Contractually it never throws; if it does, that is still not fatal.
        debugLog.error('ui', 'onboarding setup pass', err)
        return { ok: false as const, error: formatError(err) }
      })

    const outcome = await Promise.race([pass, timeout])
    if (!outcome.ok) {
      commitSetup({ status: 'failed', starterPrompts: [], startedAt, finishedAt: Date.now(), error: outcome.error })
      debugLog.log('ui', `onboarding setup failed (${outcome.error})`)
      return
    }
    // Producing NOTHING at all is recorded as a failure, not a success. The pass
    // swallows its own errors and returns empty, so a blanket `done` here both
    // misreports what happened and permanently blocks the automatic retry
    // (startOnboardingSetup short-circuits on `done`). Some prompts but no
    // memories is still a success — resolveStarterPrompts just falls back.
    const producedNothing = outcome.memories.length === 0 && outcome.prompts.length === 0
    const ms = Date.now() - startedAt
    if (producedNothing) {
      commitSetup({
        status: 'failed',
        starterPrompts: [],
        startedAt,
        finishedAt: Date.now(),
        error: 'setup produced no memories or prompts',
      })
      debugLog.log('ui', `onboarding setup produced nothing (${ms}ms)`)
      return
    }
    commitSetup({ status: 'done', starterPrompts: outcome.prompts, startedAt, finishedAt: Date.now() })
    debugLog.log(
      'ui',
      `onboarding setup done (${outcome.memories.length} memories, ${outcome.prompts.length} prompts, ${ms}ms)`,
    )
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
    setState({ setupBlocksComposer: false })
  }
}

/**
 * Chips for the empty chat: Luna's prompts when it produced any, otherwise the
 * static fallbacks (skipped, failed, or an xAI-only user). Pure — the UI calls
 * this during render.
 */
export function resolveStarterPrompts(setup: OnboardingSetupRecord): string[] {
  return setup.starterPrompts.length > 0 ? setup.starterPrompts : [...FALLBACK_STARTER_PROMPTS]
}

/**
 * The file sheet's open/focus state belongs to App (focusPath/focusNonce), and
 * transcript `/workspace/…` links reach it through the onOpenFile prop chain.
 * Store actions that want that same viewer register through here rather than
 * growing a second path into the panel.
 */
let fileViewerOpener: ((path?: string) => void) | undefined

export function registerFileViewer(open: (path?: string) => void): () => void {
  fileViewerOpener = open
  return () => {
    if (fileViewerOpener === open) fileViewerOpener = undefined
  }
}

/** "See all memories" — opens MEMORY.md in the same sheet a file link would. */
export function openMemoryFile(path: string = MEMORY_PATH): void {
  if (!fileViewerOpener) {
    debugLog.log('ui', 'openMemoryFile: no file viewer registered')
    return
  }
  fileViewerOpener(path)
}

/**
 * Given a chat's own modelId, resolve the Settings to run it with. Curated
 * models belong to a specific provider (GPT → openai, Grok → xai), so if the
 * chat's model belongs to a different provider than the global settings, the
 * provider (and its vaulted key) is swapped in just for this resolution.
 * A custom (non-curated) id on openai-compatible is left alone — a proxy may
 * serve any model id — and a curated local model materializes its endpoint.
 */
function settingsForModel(modelId: string, settings: Settings): Settings {
  const trimmed = modelId?.trim()
  if (!trimmed || trimmed === settings.modelId) return settings
  return pinnedSettingsForModel(trimmed, settings, { pinEndpoint: true })
}

/**
 * Update the model id (from the model picker). Sticks to the CURRENT chat —
 * persisted on its ChatRecord so it survives reload/chat-switch — and also
 * updates the global default settings so the next new chat starts on it too.
 */
export async function setModelId(modelId: string): Promise<void> {
  const settings = state.settings
  // Persisted, so the local endpoint is NOT pinned here: a user's own
  // openai-compatible baseURL must survive selecting a local model.
  const next: Settings = pinnedSettingsForModel(modelId, settings)
  const chatId = state.current.id
  setState({
    contextUsage: withoutKey(state.contextUsage, chatId),
    current: { ...state.current, modelId },
  })
  await saveSettings(next)

  // Manual picker change to a different model clears a session "switch all
  // agents" override so the explicit selection wins; same-model updates (e.g.
  // rate-limit banner → Grok) keep the override so mid-task switch still fires.
  const runtime = peekRuntime()
  const override = runtime?.agent.getModelOverride()
  if (runtime && override?.scope === 'all' && override.modelId !== modelId) {
    runtime.agent.setModelOverride(undefined)
    setState({ modelOverride: undefined })
  }

  // Only persist onto the chat record directly if it has no turn in flight —
  // a running turn's own autosave/finish already captured the model it
  // started with and will keep writing that until it completes.
  if (!chatIsRunning(chatId)) {
    const updatedChat: ChatRecord = { ...state.current, modelId, updatedAt: Date.now() }
    try {
      await saveChat(updatedChat, derivePreview(updatedChat))
      setState({ chats: await listChats() })
    } catch (err) {
      debugLog.error('storage', 'setModelId save chat', err)
    }
  }
}

/**
 * Mid-task / session model switch from the rate-limit banner: route main and
 * subagents (or just subagents) to Grok. Applied as soon as the next tool
 * result or model output completes — or immediately if a request is only
 * waiting on a rate-limit retry. Context is preserved (same as stop + switch
 * model + continue).
 *
 * UI state updates synchronously so the banner can confirm the choice on
 * the same frame as the press (before the agent loop restarts).
 */
export async function switchToGrok(scope: ModelSwitchScope): Promise<void> {
  const runtime = getRuntime()
  const xaiKey =
    state.settings.apiKeys?.xai?.trim() ||
    (state.settings.provider === 'xai' ? state.settings.apiKey.trim() : '')
  if (!xaiKey) {
    debugLog.log('ui', 'switchToGrok blocked: no xAI API key')
    return
  }

  // Optimistic: mirror into UI first so press feedback is never latent.
  setState({ modelOverride: { modelId: GROK_SWITCH_MODEL_ID, scope } })
  runtime.agent.setModelOverride({ modelId: GROK_SWITCH_MODEL_ID, scope })
  debugLog.log('ui', `model override set (${scope} → ${GROK_SWITCH_MODEL_ID})`)

  // "All agents" also updates the chat + picker so the UI matches what main
  // will run; subagents-only leaves the sticky chat model alone.
  if (scope === 'all') {
    await setModelId(GROK_SWITCH_MODEL_ID)
  }
}

/** True when settings have an xAI key available for a Grok fallback switch. */
export function hasXaiKey(): boolean {
  const s = state.settings
  return Boolean(s.apiKeys?.xai?.trim() || (s.provider === 'xai' && s.apiKey.trim()))
}

/**
 * Curated picker groups the user can actually run right now: a group shows
 * only when its provider has a live credential. Gateway/compatible routing
 * serves any vendor-prefixed id through one key, so both remote groups stay
 * visible there.
 *
 * Locally served models need no credential, so their group is always offered —
 * whether the server is actually up is a runtime question the request answers,
 * not something the picker can know.
 */
export function availableModelProviders(): CuratedModelProvider[] {
  return modelPickerProviders(state.settings, state.chatgptConnected)
}

/** True when the active provider has the credential type it is configured to use. */
export function hasActiveCredential(): boolean {
  return hasModelAccess(state.settings, state.current.modelId, state.chatgptConnected)
}

/** True when the given model id (or the current chat's model) is an OpenAI model. */
export function isOpenAIModel(modelId?: string): boolean {
  const id = (modelId ?? state.current.modelId).trim()
  if (!id) return state.settings.provider === 'openai'
  if (id.startsWith('openai/')) return true
  if (isOpenAIModelId(id)) return true
  const option = MODEL_OPTIONS.find((m) => m.id === id)
  if (option) return option.provider === 'openai'
  // Free-text custom id on the OpenAI provider.
  return state.settings.provider === 'openai'
}

export function setComposerDraft(text: string): void {
  const chatId = state.current.id
  // Typing retires the suggestion (and any prediction still in flight): it was
  // a guess about an empty composer, and must never sit under written text.
  if (text) clearNextPrompt(chatId)
  setState({ drafts: text ? withKey(state.drafts, chatId, text) : withoutKey(state.drafts, chatId) })
}

/**
 * Append a file/folder mention to the current draft (deduped, spaced). Lives
 * here rather than in App so the callback handed to the file panel stays
 * identity-stable — it reads the draft at call time instead of closing over it.
 */
export function appendDraftMention(mention: string): void {
  const draft = state.drafts[state.current.id] ?? ''
  if (draft.includes(mention)) return
  setComposerDraft(draft.trim() ? `${draft.replace(/\s+$/, '')} ${mention} ` : `${mention} `)
}

/* ---- next-prompt suggestion --------------------------------------------- */

/**
 * Predictions in flight, per chat. Deliberately NOT in UiState: an
 * AbortController is not render state, and keeping it out means aborting one
 * costs no snapshot churn. At most one per chat — a second turn supersedes the
 * first guess rather than racing it.
 */
const nextPromptRuns = new Map<string, AbortController>()

/**
 * The last suggestion actually shown in each chat. It survives the ghost text
 * being cleared by typing so the next send can classify acceptance vs rewrite.
 */
const offeredNextPrompts = new Map<string, string>()

function cancelNextPromptRun(chatId: string): void {
  const controller = nextPromptRuns.get(chatId)
  if (!controller) return
  nextPromptRuns.delete(chatId)
  controller.abort()
}

/**
 * Retire a chat's suggestion and abandon any prediction still running for it.
 * Every invalidating event routes here: a new turn, the user typing, accepting,
 * dismissing, reverting, deleting the chat.
 */
function clearNextPrompt(chatId: string): void {
  cancelNextPromptRun(chatId)
  if (!(chatId in state.nextPrompt)) return
  setState({ nextPrompt: withoutKey(state.nextPrompt, chatId) })
}

/**
 * Tab in the composer: the suggestion becomes the draft, exactly as if it had
 * been typed — nothing is sent, and the user can edit or delete it. Goes
 * through `setComposerDraft`, which is also what retires the suggestion, so
 * there is a single owner of both writes.
 *
 * Current chat only (the store convention for composer actions), which is also
 * the only chat the suggestion can be showing for.
 */
export function acceptNextPrompt(): void {
  const suggestion = state.nextPrompt[state.current.id]
  if (!suggestion) return
  setComposerDraft(suggestion)
  debugLog.log('ui', 'next-prompt suggestion accepted')
}

/**
 * Append one rejected suggestion/rewrite pair, keeping the persisted context
 * bounded. Exported to make the classification rule directly testable.
 */
export function appendNextPromptFeedback(
  existing: NonNullable<ChatRecord['nextPromptFeedback']>,
  suggested: string,
  sentInstead: string,
): NonNullable<ChatRecord['nextPromptFeedback']> {
  const suggestion = suggested.trim()
  const actual = sentInstead.trim()
  if (!suggestion || !actual || suggestion === actual) return existing
  return [...existing, { suggested: suggestion, sentInstead: actual }].slice(-MAX_FEEDBACK_SAMPLES)
}

/** Escape in the composer, or any other explicit "not that". */
export function dismissNextPrompt(): void {
  clearNextPrompt(state.current.id)
}

/**
 * Whether a just-finished turn has earned a suggestion. Pure, and exported for
 * tests: the skip conditions ARE the feature's correctness. A guess offered
 * after an error, an abort, or a dead turn reads as the harness papering over a
 * failure, and the toggle is an opt-out — so `undefined` has to mean ON.
 */
export function shouldOfferNextPrompt(input: {
  settings: Pick<Settings, 'suggestNextPrompt'>
  hadError: boolean
  aborted: boolean
  deadTurn: boolean
  /** The main agent's final text. Nothing to continue from without it. */
  finalText: string
  /** A queued message or leftover steering is about to start another turn. */
  followUpPending: boolean
  /** An OpenAI credential the cheap model can actually run on. */
  credentialReady: boolean
}): boolean {
  if (input.settings.suggestNextPrompt === false) return false
  if (input.hadError || input.aborted || input.deadTurn) return false
  if (!input.finalText.trim()) return false
  if (input.followUpPending) return false
  return input.credentialReady
}

/**
 * Mirror of `predictNextPrompt`'s own credential gate, cheap enough to run
 * before firing. It self-gates too, but "would return undefined immediately"
 * is worth knowing here so an xAI-only (or gateway/proxy) user never pays for a
 * request that cannot be served.
 */
function nextPromptCredentialReady(settings: Settings): boolean {
  return hasModelAccess(settings, NEXT_PROMPT_MODEL_ID, state.chatgptConnected)
}

/**
 * Recover the same final main-agent reply used by the after-turn predictor from
 * a persisted transcript. Only text after the latest user message counts; this
 * prevents reopening a chat whose newest turn never produced a reply from
 * falling back to an older answer.
 */
export function latestCompletedMainResponse(
  record: Pick<ChatRecord, 'transcript' | 'checkpoints' | 'turns'>,
): string | undefined {
  // A current-format autosave can contain the user's checkpoint and partial UI
  // text before the turn's completion metadata was appended. `normalizeChat`
  // settles that text visually after a restart, so use timestamps to avoid
  // mistaking an interrupted stream for a completed answer. Legacy chats that
  // predate turn metadata still fall through to their persisted transcript.
  const lastCheckpoint = record.checkpoints?.at(-1)
  const lastTurn = record.turns?.at(-1)
  if (record.turns !== undefined && lastCheckpoint && (!lastTurn || lastTurn.at < lastCheckpoint.at)) {
    return undefined
  }
  for (let index = record.transcript.length - 1; index >= 0; index -= 1) {
    const item = record.transcript[index]!
    if (item.kind === 'user') return undefined
    if (item.kind === 'text' && item.agentId === 'main' && !item.streaming && item.text.trim()) {
      return item.text
    }
  }
  return undefined
}

/** Regenerate composer ghost text whenever an idle persisted chat is opened. */
function startNextPromptPredictionOnOpen(record: ChatRecord): void {
  const finalText = latestCompletedMainResponse(record)
  if (!finalText) return
  const predictionSettings = settingsForModel(record.modelId, state.settings)
  const lastTurn = record.turns?.at(-1)
  const followUpPending = state.queuedMessages.some((message) => message.chatId === record.id)
  if (
    !shouldOfferNextPrompt({
      settings: state.settings,
      hadError: Boolean(lastTurn?.errorText),
      aborted: Boolean(lastTurn?.aborted),
      deadTurn: Boolean(lastTurn?.deadTurn),
      finalText,
      followUpPending,
      credentialReady: nextPromptCredentialReady(predictionSettings),
    })
  ) return
  startNextPromptPrediction(record.id, record, finalText)
}

/**
 * Fire the after-turn prediction for a chat. Fire-and-forget on purpose: the
 * call takes seconds, and those seconds are hidden behind the user reading the
 * answer they just got. Nothing about it can fail loudly — `predictNextPrompt`
 * never throws, never outlives its own 20s budget, and returns `undefined` for
 * "offer nothing".
 *
 * The result is dropped on arrival if the world moved while we waited (the user
 * typed, a new turn started, the guess was superseded) — a stale suggestion
 * appearing under someone's cursor is worse than no suggestion at all.
 */
function startNextPromptPrediction(chatId: string, record: ChatRecord, finalText: string): void {
  // Already writing (or a turn already running) — there is nothing to suggest into.
  if (activeTurns.has(chatId) || state.drafts[chatId]) return
  cancelNextPromptRun(chatId)
  const controller = new AbortController()
  nextPromptRuns.set(chatId, controller)
  // Style exemplars: what this person actually typed, oldest → newest. Tool
  // calls and assistant text are deliberately not included (see next-prompt.ts).
  const userMessages = record.transcript
    .filter((item): item is Extract<TranscriptItem, { kind: 'user' }> => item.kind === 'user')
    .map((item) => item.text)
  const predictionSettings = settingsForModel(record.modelId, state.settings)
  void predictNextPrompt({
    settings: predictionSettings,
    vfs: getRuntime().vfs,
    input: { userMessages, feedback: record.nextPromptFeedback, finalText },
    signal: controller.signal,
  }).then((suggestion) => {
    // Superseded by a newer prediction for this chat, or already abandoned.
    if (nextPromptRuns.get(chatId) !== controller) return
    nextPromptRuns.delete(chatId)
    if (controller.signal.aborted || !suggestion) return
    if (state.drafts[chatId] || activeTurns.has(chatId)) return
    setState({ nextPrompt: withKey(state.nextPrompt, chatId, suggestion) })
    offeredNextPrompts.set(chatId, suggestion)
    debugLog.log('ui', 'next-prompt suggestion offered')
  })
}

/* ---- compact browser context (Chrome context menu) ---------------------- */

const MAX_BROWSER_CONTEXTS = 4

function stageBrowserContext(chatId: string, context: BrowserContextAttachment): void {
  const existing = (state.browserContexts[chatId] ?? []).filter((item) => item.id !== context.id)
  setState({
    browserContexts: withKey(state.browserContexts, chatId, [...existing, context].slice(-MAX_BROWSER_CONTEXTS)),
  })
}

export function removeBrowserContext(id: string): void {
  const chatId = state.current.id
  const pending = (state.browserContexts[chatId] ?? []).filter((context) => context.id !== id)
  setState({
    browserContexts: pending.length > 0
      ? withKey(state.browserContexts, chatId, pending)
      : withoutKey(state.browserContexts, chatId),
  })
}

/* ---- attachments (drag-drop images + Appshot) ---------------------------- */

const MAX_PENDING_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 20_000_000

function setAttachmentNotice(chatId: string, notice: string | undefined): void {
  setState({
    attachmentNotices: notice
      ? withKey(state.attachmentNotices, chatId, notice)
      : withoutKey(state.attachmentNotices, chatId),
  })
}

export function clearAttachmentNotice(): void {
  setAttachmentNotice(state.current.id, undefined)
}

/** Stage an attachment on its chat, replacing any pending one for the same path. */
function stagePendingAttachment(chatId: string, attachment: PendingAttachment): void {
  const pending = (state.attachments[chatId] ?? []).filter((att) => att.path !== attachment.path)
  setState({ attachments: withKey(state.attachments, chatId, [...pending, attachment]) })
}

export function removeAttachment(id: string): void {
  const chatId = state.current.id
  const pending = (state.attachments[chatId] ?? []).filter((att) => att.id !== id)
  setState({
    attachments: pending.length > 0 ? withKey(state.attachments, chatId, pending) : withoutKey(state.attachments, chatId),
  })
}

/**
 * Stage dropped/pasted images: each is saved into /workspace/attachments (so
 * the agent can read it by path later and it shows in the file panel) and added
 * as a composer chip. Non-images and oversized files are skipped with a notice.
 */
export async function attachImageFiles(files: File[]): Promise<void> {
  const chatId = state.current.id
  setAttachmentNotice(chatId, undefined)
  const skipped: string[] = []
  let accepted = 0

  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      skipped.push(`${file.name || 'file'} (not an image)`)
      continue
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${file.name} (over ${Math.round(MAX_ATTACHMENT_BYTES / 1_000_000)} MB)`)
      continue
    }
    if ((state.attachments[chatId]?.length ?? 0) >= MAX_PENDING_ATTACHMENTS) {
      skipped.push(`${file.name} (limit ${MAX_PENDING_ATTACHMENTS} per message)`)
      continue
    }
    try {
      const vfs = getRuntime().vfs
      const entry = await vfs.putFile('workspace', file, `attachments/${file.name || `image-${Date.now()}.png`}`)
      stagePendingAttachment(chatId, {
        id: uid('att'),
        kind: 'image',
        path: entry.path,
        name: entry.name,
        mediaType: entry.mediaType,
        previewUrl: await vfs.dataUrl(entry.path),
      })
      accepted += 1
    } catch (err) {
      debugLog.error('ui', 'attach dropped image', err)
      skipped.push(`${file.name} (${formatError(err)})`)
    }
  }

  if (skipped.length > 0) {
    setAttachmentNotice(chatId, `Skipped ${skipped.join(', ')}`)
  }
  if (accepted > 0) debugLog.log('ui', `attached ${accepted} image(s)`)
}

/**
 * Appshot: capture the active tab screenshot plus basic metadata and, when
 * available, a best-effort AX-tree snapshot. Stage it as a composer attachment;
 * the PNG is saved under /workspace/appshots.
 */
export async function captureAppshot(): Promise<void> {
  const chatId = state.current.id
  if (state.appshotBusy[chatId]) return
  setState({
    appshotBusy: withKey(state.appshotBusy, chatId, true),
    attachmentNotices: withoutKey(state.attachmentNotices, chatId),
  })
  try {
    if ((state.attachments[chatId]?.length ?? 0) >= MAX_PENDING_ATTACHMENTS) {
      throw new Error(`attachment limit is ${MAX_PENDING_ATTACHMENTS} per message`)
    }
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!active || typeof active.id !== 'number') throw new Error('no active tab to capture')
    if (/^(chrome|edge|devtools|about|chrome-extension):/i.test(active.url ?? '')) {
      throw new Error('browser-internal pages cannot be captured')
    }
    const runtime = getRuntime()
    const tabId = active.id
    const { shot, snapshot } = await captureTabShot(tabId)
    const capturedAt = Date.now()
    const name = `appshot-${new Date(capturedAt).toISOString().replace(/[:.]/g, '-')}.png`
    const path = `/workspace/appshots/${name}`
    await runtime.vfs.writeBase64(path, shot.base64, { mediaType: shot.mediaType })
    // The full snapshot also lands next to the PNG so a truncated <appshot>
    // block can point at a file instead of sending the model back to
    // browser_snapshot. Best-effort: a failed write only costs the deep link.
    let snapshotPath: string | undefined
    if (snapshot?.text) {
      snapshotPath = `${path.replace(/\.png$/, '')}.snapshot.txt`
      try {
        await runtime.vfs.writeText(snapshotPath, snapshot.text, { mediaType: 'text/plain' })
      } catch (err) {
        snapshotPath = undefined
        debugLog.error('ui', 'appshot snapshot file', err)
      }
    }
    stagePendingAttachment(chatId, {
      id: uid('att'),
      kind: 'appshot',
      path,
      name,
      mediaType: shot.mediaType,
      tabId,
      title: snapshot?.title || active.title || '',
      url: snapshot?.url || active.url || '',
      capturedAt,
      snapshotText: snapshot?.text,
      snapshotPath,
      previewUrl: `data:${shot.mediaType};base64,${shot.base64}`,
    })
    debugLog.log('ui', `appshot captured (tab ${tabId})`)
  } catch (err) {
    debugLog.error('ui', 'appshot capture', err)
    setAttachmentNotice(chatId, `TabShot failed: ${formatError(err)}`)
  } finally {
    setState({ appshotBusy: withoutKey(state.appshotBusy, chatId) })
  }
}

/**
 * Steer the current chat's running turn: the text attaches as a user message
 * at the next step boundary (after the next tool call finishes) while the
 * model keeps working. If this chat has no running turn it sends normally.
 */
export function addSteering(text: string): void {
  if (chatIsRunning(state.current.id) && isCompacting(state.current.transcript)) return
  const trimmed = text.trim()
  if (!trimmed) return
  const chatId = state.current.id
  if (!chatIsRunning(chatId)) {
    void sendMessage(trimmed)
    return
  }
  const prev = state.steering[chatId]
  setState({
    steering: withKey(state.steering, chatId, prev ? `${prev}\n\n${trimmed}` : trimmed),
    drafts: withoutKey(state.drafts, chatId),
  })
  getRuntime().executions.steer(chatId, trimmed)
  // A turn paused at a step checkpoint has no upcoming step boundary to attach
  // steering at — talking to the agent counts as "keep going".
  resolveStepPrompt(chatId, true)
  // Escape hatch for a blocking prompt card: answering in the composer instead
  // of on the card is a legitimate answer. The prompt resolves as 'steered'
  // (its tool result only says so — the text itself arrives once, through the
  // normal steering path above, so the model never sees it twice).
  if (resolveUserPrompt(chatId, { status: 'steered', text: trimmed })) {
    debugLog.log('ui', 'user prompt steered past via the composer')
  }
  debugLog.log('ui', 'steering queued for running turn')
}

export function clearSteering(): void {
  setState({ steering: withoutKey(state.steering, state.current.id) })
}

/** Acknowledging an earlier steer must not erase a newer correction. */
function acknowledgeSteering(chatId: string, text: string): void {
  const pending = state.steering[chatId]
  const delivered = text.trim()
  if (!pending || !delivered) return
  if (pending === delivered) setState({ steering: withoutKey(state.steering, chatId) })
  else if (pending.startsWith(`${delivered}\n\n`)) {
    setState({ steering: withKey(state.steering, chatId, pending.slice(delivered.length + 2)) })
  }
}

export function clearQueuedMessages(): void {
  const chatId = state.current.id
  setQueuedMessages(state.queuedMessages.filter((message) => message.chatId !== chatId))
}

/** Abort the current chat's turn (other chats keep running). */
export function stop(): void {
  stopChat(state.current.id)
}

/**
 * Abort a specific chat's turn AND its background subagents. Cancelling the
 * tasks first lets their task-update events reach the transcript while the
 * turn is still subscribed; detached subagents have their own controllers, so
 * aborting the turn alone would leave them running.
 */
export function stopChat(chatId: string): void {
  try {
    getRuntime().agent.cancelChatTasks(chatId)
  } catch (err) {
    debugLog.error('agent', 'cancel chat tasks', err)
  }
  // A turn paused at a step checkpoint resolves to "stop" (the abort below
  // would settle it too, but this also clears the prompt from the UI).
  resolveStepPrompt(chatId, false)
  resolveUserPrompt(chatId, { status: 'cancelled', reason: 'stopped' })
  const turn = activeTurns.get(chatId)
  if (turn) {
    turn.controller.abort()
    debugLog.log('ui', `turn aborted by user (${chatId})`)
  }
  // Settle the visible transcript NOW: the aborted runs emit no further
  // events, so lingering shimmers/running rows would never resolve otherwise.
  chatStopSettles.get(chatId)?.()
  // Stop means stop. Draining the reveal reserve politely would keep painting
  // words for another beat after the user asked for silence.
  snapReveal()
}

/**
 * Cancel a single background task directly (task tray's Cancel button).
 * Unlike `stopChat`, this does not abort the chat's turn — it only stops
 * the one background subagent, and costs no model turn.
 */
export function cancelTask(taskId: string): void {
  try {
    getRuntime().agent.cancelTask(taskId)
  } catch (err) {
    debugLog.error('agent', 'cancel task', err)
  }
}

/**
 * Nudge a running background task directly (task tray's Nudge button).
 * Delivered the same way `subagent_message` delivers a steer — the
 * subagent sees it at its next step boundary — but this never goes
 * through the model, so it costs no turn on the main agent.
 */
export function nudgeTask(taskId: string, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  try {
    getRuntime().agent.nudgeTask(taskId, trimmed)
  } catch (err) {
    debugLog.error('agent', 'nudge task', err)
  }
}

/**
 * Retry the current chat's dead turn: re-sends the exact same conversation
 * (the failed turn's user message is already the last item in
 * messages/transcript — see `runTurn`'s `retry` mode) instead of asking the
 * user to retype. No-op if there is no dead-turn flag, or a turn is already
 * running for this chat.
 */
export async function retryDeadTurn(): Promise<void> {
  const chatId = state.current.id
  if (!state.deadTurns[chatId] || activeTurns.has(chatId)) return
  await runTurn(normalizeChat(state.current), '', true, [], [], { retry: true })
}

async function persistCurrentChat(chat: ChatRecord): Promise<void> {
  try {
    await saveChat(chat, derivePreview(chat))
    const chats = await listChats()
    setState({ chats })
  } catch (err) {
    debugLog.error('storage', 'persist current chat', err)
  }
}

export async function revertToMessage(itemId: string): Promise<void> {
  const chatId = state.current.id
  stopChat(chatId)
  const result = resolveRevert(state.current, itemId)
  if (!result) return
  bumpHistoryVersion(chatId)
  // The suggestion was predicted from a turn that no longer exists, and the
  // revert is about to fill the composer itself.
  cancelNextPromptRun(chatId)
  offeredNextPrompts.delete(chatId)
  setState({
    current: result.chat,
    nextPrompt: withoutKey(state.nextPrompt, chatId),
    drafts: withKey(state.drafts, chatId, result.draft),
    browserContexts: result.contexts && result.contexts.length > 0
      ? withKey(state.browserContexts, chatId, result.contexts)
      : withoutKey(state.browserContexts, chatId),
    queuedMessages: state.queuedMessages.filter((message) => message.chatId !== chatId),
    // Provider-reported usage describes the history that was just cut away, so
    // it is stale: drop it and wait for the next turn's usage-update.
    contextUsage: withoutKey(state.contextUsage, chatId),
  })
  persistQueuedMessages(state.queuedMessages)
  if (result.attachments && result.attachments.length > 0) void restageAttachments(chatId, result.attachments)
  await persistCurrentChat(result.chat)
  debugLog.log('ui', `reverted to ${itemId}`)
}

/**
 * Re-stage a reverted message's attachments as pending composer chips, so a
 * revert restores the whole draft — not just its text. Rebuilt from the VFS:
 * the preview from the stored image, and for TabShots the page snapshot from
 * the .snapshot.txt written at capture time. Attachments whose files were
 * deleted are skipped; older TabShots without a snapshot file restage with
 * the screenshot alone.
 */
async function restageAttachments(chatId: string, attachments: UserAttachment[]): Promise<void> {
  const vfs = getRuntime().vfs
  let staged = 0
  for (const att of attachments) {
    try {
      const previewUrl = await vfs.dataUrl(att.path)
      let snapshotText: string | undefined
      let snapshotPath: string | undefined
      if (att.kind === 'appshot') {
        const candidate = `${att.path.replace(/\.png$/i, '')}.snapshot.txt`
        if (await vfs.getEntry(candidate)) {
          snapshotPath = candidate
          // Read the whole snapshot (bounded well above any real page), so the
          // <appshot> block computes an honest truncation count — reading just
          // past the inline cap would report "[Truncated 1 chars]" for a page
          // that overflowed by hundreds of thousands.
          snapshotText = (await vfs.readText(candidate, { maxChars: 1_000_000 })).text
        }
      }
      // Bail if the user navigated away or already started the next turn —
      // staging then would ride a stale chip onto the wrong message.
      if (state.current.id !== chatId || activeTurns.has(chatId)) return
      if ((state.attachments[chatId]?.length ?? 0) >= MAX_PENDING_ATTACHMENTS) {
        setAttachmentNotice(
          chatId,
          `Restored ${staged} of ${attachments.length} attachments (limit ${MAX_PENDING_ATTACHMENTS} per message).`,
        )
        return
      }
      stagePendingAttachment(chatId, { ...att, previewUrl, snapshotText, snapshotPath })
      staged += 1
    } catch (err) {
      debugLog.error('ui', 'restage attachment after revert', err)
    }
  }
}

function enqueueMessage(
  text: string,
  attachments: PendingAttachment[],
  browserContexts: BrowserContextAttachment[],
): void {
  const trimmed = text.trim()
  if (!trimmed && attachments.length === 0 && browserContexts.length === 0) return
  setState({
    drafts: withoutKey(state.drafts, state.current.id),
    attachments: withoutKey(state.attachments, state.current.id),
    browserContexts: withoutKey(state.browserContexts, state.current.id),
    queuedMessages: [
      ...state.queuedMessages,
      {
        id: uid('q'),
        chatId: state.current.id,
        text: trimmed,
        at: Date.now(),
        attachments: attachments.length > 0 ? attachments : undefined,
        browserContexts: browserContexts.length > 0 ? browserContexts : undefined,
      },
    ],
  })
  persistQueuedMessages(state.queuedMessages)
  debugLog.log('ui', 'queued message')
}

async function runNextQueuedMessage(chatId: string, record: ChatRecord): Promise<void> {
  if (chatIsRunning(chatId)) return
  const index = state.queuedMessages.findIndex((message) => message.chatId === chatId)
  if (index === -1) return
  const next = state.queuedMessages[index]!
  const queuedMessages = [...state.queuedMessages.slice(0, index), ...state.queuedMessages.slice(index + 1)]
  setQueuedMessages(queuedMessages)
  const base = state.current.id === chatId ? normalizeChat(state.current) : record
  await runTurn(base, next.text, true, next.attachments ?? [], next.browserContexts ?? [])
}

/**
 * Send a user message in the current chat: append the user item immediately
 * (ack < 100ms), build ModelMessages, run the turn, fold events into the
 * transcript live, and persist the ChatRecord when done. If this chat already
 * has a running turn, enqueue the message; other chats' turns are unaffected
 * and run in parallel. Pending composer attachments ride along with the message.
 */
export async function sendMessage(text: string, opts?: { source?: UserMessageSource }): Promise<void> {
  if (chatIsRunning(state.current.id) && isCompacting(state.current.transcript)) return
  const trimmed = text.trim()
  const chatId = state.current.id
  const attachments = state.attachments[chatId] ?? []
  const browserContexts = state.browserContexts[chatId] ?? []
  if (!trimmed && attachments.length === 0 && browserContexts.length === 0) return
  if (chatIsRunning(chatId)) {
    enqueueMessage(trimmed, attachments, browserContexts)
    return
  }
  setState({
    drafts: withoutKey(state.drafts, chatId),
    attachments: withoutKey(state.attachments, chatId),
    browserContexts: withoutKey(state.browserContexts, chatId),
  })
  await runTurn(normalizeChat(state.current), trimmed, true, attachments, browserContexts, { source: opts?.source })
}

async function runTurn(
  startingChat: ChatRecord,
  text: string,
  drainQueue: boolean,
  attachments: PendingAttachment[] = [],
  browserContexts: BrowserContextAttachment[] = [],
  opts?: { retry?: boolean; source?: UserMessageSource },
): Promise<void> {
  const isRetry = opts?.retry === true
  const trimmed = text.trim()
  const chatId = startingChat.id
  if ((!isRetry && !trimmed && attachments.length === 0 && browserContexts.length === 0) || activeTurns.has(chatId)) return

  // The conversation has moved on: the last turn's guess (and any prediction
  // still in flight for it) is void the moment a new turn starts.
  clearNextPrompt(chatId)

  // Chats run with their own remembered modelId (sticky per chat) rather than
  // whatever the global picker currently shows, so switching model for one
  // chat/reloading never changes another chat's model underneath it.
  const settings = settingsForModel(startingChat.modelId, state.settings)
  const turnVersion = getHistoryVersion(chatId)
  const runtime = getRuntime()
  ensureTaskUpdatesWired()

  // Retry: the failed turn's user message is already the last entry in
  // messages/transcript (appended when that turn started, exactly like any
  // other turn) — resend the exact same conversation instead of appending a
  // duplicate user bubble or a new checkpoint (retrying isn't a new user turn).
  let messages: unknown[]
  let transcript: TranscriptItem[]
  let checkpoints: ChatCheckpoint[]
  let base: ChatRecord

  if (isRetry) {
    base = state.current.id === chatId ? normalizeChat(state.current) : startingChat
    messages = [...base.messages]
    transcript = base.transcript
    checkpoints = base.checkpoints ?? []
  } else {
    const userModelMessage = await buildUserModelMessage(
      opts?.source ? withSourceNote(trimmed, opts.source) : trimmed,
      runtime.vfs,
      startingChat.messages.length === 0,
      attachments,
      browserContexts,
    )
    // Re-snapshot after the await: a background subagent may have folded more
    // events into this chat's published record while ambient context was being
    // gathered, and this turn's branch must not drop them.
    base = state.current.id === chatId ? normalizeChat(state.current) : startingChat
    const userItem: Extract<TranscriptItem, { kind: 'user' }> = {
      kind: 'user',
      id: uid('u'),
      text: trimmed,
      at: Date.now(),
      // Persist only render metadata; previews and snapshots are send-time only.
      attachments:
        attachments.length > 0
          ? attachments.map(
              ({ previewUrl: _preview, snapshotText: _snap, snapshotPath: _snapPath, ...meta }) => meta,
            )
          : undefined,
      contexts: browserContexts.length > 0 ? browserContexts : undefined,
      source: opts?.source,
    }
    const checkpoint: ChatCheckpoint = {
      id: uid('cp'),
      userItemId: userItem.id,
      userText: trimmed,
      at: userItem.at,
      transcriptIndexBefore: base.transcript.length,
      messageCountBefore: base.messages.length,
    }
    messages = [...base.messages, userModelMessage]
    transcript = appendTranscriptItem(base.transcript, userItem)
    checkpoints = [...(base.checkpoints ?? []), checkpoint]
  }

  // The suggestion may already be invisible because the user's first keystroke
  // retired it. Keep the offered value until send time, then persist only a
  // genuine rewrite. Exact acceptance adds no useful correction signal.
  let nextPromptFeedback = [...(base.nextPromptFeedback ?? [])]
  if (!isRetry) {
    const offered = offeredNextPrompts.get(chatId)
    offeredNextPrompts.delete(chatId)
    if (offered) nextPromptFeedback = appendNextPromptFeedback(nextPromptFeedback, offered, trimmed)
  }

  // Working copies for this turn. `transcript` and `messages` accumulate locally
  // so folding is unambiguous even if the user navigates chats mid-turn.
  let turns: ChatTurnMeta[] = [...(base.turns ?? [])]
  let title = base.title
  const createdAt = base.createdAt
  let turnHadError = false
  let turnProducedContent = false
  /** Main agent's finished text, captured for the completion notification's snippet. */
  let finalAgentText = ''

  // Per-turn harness metadata, appended to `turns` when the turn ends.
  // `turnModelId` tracks mid-task switches (e.g. OpenAI rate-limit → Grok) so
  // the chat's sticky model and turn meta match what the agent actually ran.
  const turnStartedAt = Date.now()
  let turnModelId = settings.modelId
  let turnProvider: ProviderKind = settings.provider
  let steeringCount = 0
  let rateLimitWaits = 0
  let turnMeta: ChatTurnMeta | undefined
  const makeTurnMeta = (extra: Partial<ChatTurnMeta>): ChatTurnMeta => ({
    at: turnStartedAt,
    wallMs: Date.now() - turnStartedAt,
    modelId: turnModelId,
    provider: turnProvider,
    steeringCount: steeringCount || undefined,
    rateLimitWaits: rateLimitWaits || undefined,
    ...extra,
  })

  const buildRecord = (): ChatRecord => ({
    id: chatId,
    title,
    createdAt,
    updatedAt: Date.now(),
    modelId: turnModelId,
    messages,
    transcript,
    checkpoints,
    turns,
    nextPromptFeedback,
  })

  if (title === 'New chat') title = deriveTitle(buildRecord())

  const versionCurrent = (): boolean => getHistoryVersion(chatId) === turnVersion

  // Publish the record only when this chat is the one on screen and the user has
  // not rewound/deleted this history branch.
  const publish = (): void => {
    if (state.current.id === chatId && versionCurrent()) setState({ current: buildRecord() }, { coalesce: true })
  }

  const controller = new AbortController()
  activeTurns.set(chatId, { controller, version: turnVersion, snapshot: buildRecord })

  // contextUsage is deliberately left as-is: the meter only ever shows what the
  // provider reported, and the first usage-update of this turn will replace it.
  setState({
    current: state.current.id === chatId ? buildRecord() : state.current,
    runningChatIds: [...state.runningChatIds, chatId],
    runTimer: withKey(state.runTimer, chatId, { startedAt: turnStartedAt }),
  })

  // Persist right away so the chat is in the switcher (and survives a crash)
  // while its first turn is still streaming.
  void persistCurrentChat(buildRecord())

  // Throttled autosave: the in-flight transcript is persisted every few
  // seconds so a crash or panel close mid-turn loses only the last moments.
  const AUTOSAVE_MS = 2500
  let lastSaveAt = Date.now()
  let saveTimer: number | undefined
  let turnDone = false
  const autosave = (): void => {
    // Runs after turnDone too: a live background subagent keeps folding into
    // this record between turns, and that progress must survive a reload.
    if (!versionCurrent()) return
    const due = lastSaveAt + AUTOSAVE_MS - Date.now()
    if (due <= 0) {
      lastSaveAt = Date.now()
      const record = buildRecord()
      saveChat(record, derivePreview(record)).catch((err) => debugLog.error('storage', 'autosave chat', err))
    } else if (saveTimer === undefined) {
      saveTimer = window.setTimeout(() => {
        saveTimer = undefined
        autosave()
      }, due)
    }
  }

  // Live steering feed: the agent drains this at each step boundary and
  // attaches the text as a user message (echoed back via a 'steering' event).
  // `peek` lets blocking tools (task_wait) return early when a message arrives.
  const takeSteering = (): string[] => {
    if (!versionCurrent()) return []
    const pending = state.steering[chatId]?.trim()
    if (!pending) return []
    setState({ steering: withoutKey(state.steering, chatId) })
    return [pending]
  }
  const peekSteering = (): boolean => versionCurrent() && Boolean(state.steering[chatId]?.trim())

  // Per-agent rate-limit bookkeeping: main's wait feeds the banner, subagent
  // waits show under their delegation cards.
  const setAgentRateLimit = (agentId: AgentId, limit: ChatRateLimit): void => {
    setState({
      rateLimits: withKey(state.rateLimits, chatId, { ...state.rateLimits[chatId], [agentId]: limit }),
    })
  }
  const clearAgentRateLimit = (agentId: AgentId): void => {
    const chatLimits = state.rateLimits[chatId]
    if (!chatLimits?.[agentId]) return
    const next = { ...chatLimits }
    delete next[agentId]
    setState({
      rateLimits:
        Object.keys(next).length > 0 ? withKey(state.rateLimits, chatId, next) : withoutKey(state.rateLimits, chatId),
    })
  }

  const foldEvent = (e: Parameters<typeof applyEvent>[1]): void => {
    if (!versionCurrent()) return
    if (
      (e.type === 'text-start' || e.type === 'reasoning-start' || e.type === 'tool-input-start' || e.type === 'tool-call') &&
      e.agentId === 'main'
    ) {
      turnProducedContent = true
    }
    if (e.type === 'steering' && e.agentId === 'main') steeringCount += 1
    if (e.type === 'steering' && e.agentId === 'main') {
      acknowledgeSteering(chatId, e.text)
    }
    if (e.type === 'rate-limit') {
      if (e.agentId === 'main') rateLimitWaits += 1
      setAgentRateLimit(e.agentId, {
        agentId: e.agentId,
        attempt: e.attempt,
        retryAt: Date.now() + e.retryInMs,
        message: e.message,
        waitingForMain: e.waitingForMain,
      })
      return
    }
    if (e.type === 'rate-limit-clear') {
      clearAgentRateLimit(e.agentId)
      return
    }
    if (e.type === 'model-switch') {
      // Main agent mid-task switch: keep the header meter + chat sticky model
      // on the new id. Subagent-only switches leave main's chat model alone.
      if (e.agentId === 'main') {
        turnModelId = e.modelId
        const option = MODEL_OPTIONS.find((m) => m.id === e.modelId)
        if (option) turnProvider = option.provider
        const prev = state.contextUsage[chatId]
        setState({
          contextUsage: withKey(state.contextUsage, chatId, {
            modelId: e.modelId,
            usage: prev?.usage ?? {},
            updatedAt: Date.now(),
          }),
        })
        publish()
        autosave()
      }
      return
    }
    if (e.type === 'agent-finish' || e.type === 'agent-error') {
      clearAgentRateLimit(e.agentId)
    }
    if (e.type === 'agent-error') turnHadError = true
    if (e.type === 'agent-finish' && e.agentId === 'main') finalAgentText = e.text
    if (e.type === 'usage-update' && e.agentId === 'main') {
      setState({
        contextUsage: withKey(state.contextUsage, chatId, {
          modelId: e.modelId,
          usage: e.usage,
          updatedAt: Date.now(),
        }),
      })
    }
    transcript = applyEvent(transcript, e)
    publish()
    autosave()
  }

  // This turn is now the chat's event sink. Background subagents spawned by
  // earlier turns emit through those turns' onEvent, which routes here so
  // their progress folds into the current transcript instead of a stale copy.
  chatEventSinks.set(chatId, foldEvent)
  chatStopSettles.set(chatId, () => {
    // Runs synchronously from stopChat, after the chat's tasks were cancelled
    // (so liveChildAgentIds no longer spares them).
    transcript = finalizeInterrupted(transcript, liveChildAgentIds(), 'Stopped by user.')
    publish()
    autosave()
  })
  const onEvent = (e: Parameters<typeof applyEvent>[1]): void => {
    // Everything emitting through this turn (including its detached background
    // subagents) is stamped with the turn's history version: after a
    // rewind/delete, their late events must not leak into the new branch.
    if (getHistoryVersion(chatId) !== turnVersion) return
    if ('agentId' in e && e.agentId === 'main' && (turnDone || (controller.signal.aborted && e.type !== 'steering'))) return
    ;(chatEventSinks.get(chatId) ?? foldEvent)(e)
  }

  // Step-checkpoint prompt: the agent loop pauses here every STEP_CHECKPOINT
  // steps and the banner asks the user whether to keep going. Resolution comes
  // from answerStepPrompt (banner buttons), addSteering (talking = continue),
  // or stopChat/abort (= stop). A stale-history turn continues unprompted-
  // stopping is what the rewind's abort already arranged.
  const onStepLimit = (steps: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (!versionCurrent() || controller.signal.aborted) {
        resolve(false)
        return
      }
      // Opt-out of step-count checkpoints: keep going without ever prompting.
      if (settings.pauseAtStepCheckpoints === false) {
        resolve(true)
        return
      }
      stepPromptResolvers.set(chatId, resolve)
      setState({ stepPrompts: withKey(state.stepPrompts, chatId, { steps, at: Date.now() }) })
      debugLog.log('ui', `step checkpoint prompt shown (${steps} steps)`)
    })

  try {
    const result = await runtime.agent.runTurn({
      chatId,
      messages,
      steering: { take: takeSteering, peek: peekSteering },
      settings,
      onEvent,
      signal: controller.signal,
      onStepLimit,
      askUser: (req) => requestUserPrompt(chatId, req),
      lifecycleRecord: buildRecord(),
    })
    messages = sanitizeModelMessages([...messages, ...result.responseMessages])
    turnMeta = makeTurnMeta({
      usage: result.usage,
      finishReason: result.finishReason,
      steps: result.steps,
      errorText: result.errorText,
      aborted: controller.signal.aborted || undefined,
    })
  } catch (err) {
    turnMeta = makeTurnMeta({
      errorText: controller.signal.aborted ? undefined : formatError(err),
      aborted: controller.signal.aborted || undefined,
    })
    if (controller.signal.aborted) {
      debugLog.log('agent', 'turn aborted')
    } else if (!versionCurrent()) {
      debugLog.log('agent', 'turn failed after history moved')
    } else {
      debugLog.error('agent', 'runTurn failed', err)
      if (!turnHadError) {
        const message = formatError(err)
        transcript = applyEvent(transcript, { type: 'agent-error', agentId: 'main', error: message })
        turnHadError = true
      }
    }
  } finally {
    activeTurns.delete(chatId)
    turnDone = true
    // Belt-and-braces: a prompt that somehow outlived its turn must not leave
    // a dangling banner or an unresolvable promise.
    resolveStepPrompt(chatId, false)
    resolveUserPrompt(chatId, { status: 'cancelled', reason: 'error' })
    if (saveTimer !== undefined) {
      window.clearTimeout(saveTimer)
      // Reset so post-turn autosaves (live subagent progress) can reschedule.
      saveTimer = undefined
    }
    const turnAborted = controller.signal.aborted
    // Dead turn: not a user abort, and nothing visible (no text/reasoning/tool
    // activity) reached the transcript this turn — a harness-level failure the
    // user has no recourse for besides retyping. Drives the retry chip below.
    const isDeadTurn = !turnAborted && !turnProducedContent
    if (turnMeta) turns = [...turns, { ...turnMeta, deadTurn: isDeadTurn || undefined }]
    // Catch any items a late in-flight event re-opened between the Stop
    // settle and the stream fully closing, so the persisted record is quiet.
    if (turnAborted) transcript = finalizeInterrupted(transcript, liveChildAgentIds(), 'Stopped by user.')
    const record = buildRecord()

    // Long-turn completion notification: only when the panel is hidden/unfocused
    // (not fully closed — the agent runtime lives in the panel and dies with it,
    // see src/background/index.ts), the turn ran long enough to be worth a ping,
    // it wasn't a user-initiated Stop, and the toggle (default ON) isn't off.
    if (
      !turnAborted &&
      state.settings.notifyOnLongTurn !== false &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden' &&
      Date.now() - turnStartedAt >= LONG_TURN_NOTIFY_MS
    ) {
      void notifyTurnComplete(finalAgentText || (turnHadError ? 'Turn ended with an error.' : 'Turn finished.'))
    }

    // Reads fresh state at call time: other turns may have finished during awaits.
    const finish = (extra: Partial<UiState> = {}): void => {
      setState({
        runningChatIds: state.runningChatIds.filter((id) => id !== chatId),
        rateLimits: withoutKey(state.rateLimits, chatId),
        runTimer: withoutKey(state.runTimer, chatId),
        deadTurns: isDeadTurn ? withKey(state.deadTurns, chatId, { at: Date.now() }) : withoutKey(state.deadTurns, chatId),
        ...extra,
      })
    }

    // Stop interrupts this turn, but a correction already submitted by the
    // user still runs next. Errors/rewinds preserve unsent text as a draft.
    const strandedSteering = state.steering[chatId]?.trim()
    const canContinue = drainQueue && versionCurrent() && (turnAborted || (!turnHadError && !isDeadTurn))
    if (strandedSteering && !canContinue) {
      const draft = state.drafts[chatId]
      setState({
        steering: withoutKey(state.steering, chatId),
        drafts: withKey(state.drafts, chatId, draft ? `${draft}\n\n${strandedSteering}` : strandedSteering),
      })
    }

    if (!versionCurrent()) {
      finish()
      return
    }

    const extra: Partial<UiState> = {}
    try {
      await saveChat(record, derivePreview(record))
      // Keep the host's terminal checkpoint until this richer local record is
      // durable. Closing the panel between delivery and save must be recoverable.
      for (const execution of runtime.executions.list()) {
        if (execution.chatId === chatId && execution.status !== 'running' && execution.status !== 'cancelling') {
          await runtime.executions.acknowledge(execution.runId)
        }
      }
      extra.chats = await listChats()
    } catch (err) {
      debugLog.error('storage', 'persist chat after turn', err)
    }
    if (state.current.id === chatId) extra.current = record
    finish(extra)

    // Steering that never found a step boundary (the turn produced its final
    // output first) still has to reach the model: send it as a follow-up
    // message, ahead of the queue. Its own finally block drains the queue.
    const leftoverSteering = drainQueue ? state.steering[chatId]?.trim() : undefined
    const followUpPending =
      Boolean(leftoverSteering) || state.queuedMessages.some((message) => message.chatId === chatId)

    // Offer a next message only when this turn is genuinely the end of the
    // exchange — nothing queued behind it, and a clean finish. The user is
    // about to spend a few seconds reading the answer, which is exactly the
    // latency this call hides in.
    if (
      shouldOfferNextPrompt({
        settings: state.settings,
        hadError: turnHadError,
        aborted: turnAborted,
        deadTurn: isDeadTurn,
        finalText: finalAgentText,
        followUpPending,
        credentialReady: nextPromptCredentialReady(settingsForModel(record.modelId, state.settings)),
      }) &&
      versionCurrent()
    ) {
      startNextPromptPrediction(chatId, record, finalAgentText)
    }

    if (canContinue && versionCurrent()) {
      if (leftoverSteering) {
        setState({ steering: withoutKey(state.steering, chatId) })
        await runTurn(record, leftoverSteering, true)
      } else {
        await runNextQueuedMessage(chatId, record)
      }
    }
  }
}

/* ---- artifact invocations ---------------------------------------------- *
 * `ai.invoke(prompt)` inside a living HTML artifact. The background queues the
 * request; the panel claims it and sends it exactly as the composer would,
 * badged with its source, then hands the assistant's final text back so the
 * artifact can render it. Sequential on purpose: each one moves state.current.
 */

let artifactInvocationListenerWired = false
let artifactInvocationDrain: Promise<void> | undefined

function ensureArtifactInvocationListener(): void {
  if (artifactInvocationListenerWired) return
  artifactInvocationListenerWired = true
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const message = raw as Partial<ArtifactRuntimeMessage>
    if (message.target === 'ui' && message.type === 'artifact.invoke.available') void drainArtifactInvocations()
    return false
  })
}

/** The model sees who sent the prompt; the bubble shows the same text the artifact sent. */
function withSourceNote(text: string, source: UserMessageSource): string {
  if (source.kind !== 'artifact') return text
  return (
    `${text}\n\n<context source="artifact">Sent programmatically by the artifact ${source.path} via ai.invoke(). ` +
    'It encodes a standing instruction the user built into that artifact. When the request concerns the artifact\'s ' +
    'content, update the artifact itself (api.artifacts.eval or rewrite the file) and keep the chat reply brief; ' +
    'your final reply text is returned to the artifact.</context>'
  )
}

async function claimArtifactInvocations(): Promise<ArtifactInvocation[]> {
  const response = (await chrome.runtime.sendMessage({
    target: 'background',
    type: 'artifact.invoke.claim',
  } satisfies ArtifactRuntimeMessage)) as { ok?: boolean; value?: { invocations?: ArtifactInvocation[] } } | undefined
  const list = response?.value?.invocations
  return Array.isArray(list) ? list : []
}

function replyToArtifactInvocation(
  invokeId: string,
  result: { ok: true; chatId: string; text: string } | { ok: false; error: string },
): void {
  chrome.runtime
    .sendMessage({ target: 'background', type: 'artifact.invoke.result', invokeId, ...result } satisfies ArtifactRuntimeMessage)
    .catch(() => {})
}

function waitForChatIdle(chatId: string): Promise<void> {
  if (!chatIsRunning(chatId)) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = subscribe(() => {
      if (chatIsRunning(chatId)) return
      unsubscribe()
      resolve()
    })
  })
}

/** Main agent's last reply in `transcript` at or after `from`. */
function lastMainReply(transcript: TranscriptItem[], from: number): string {
  for (let i = transcript.length - 1; i >= Math.max(0, from); i--) {
    const item = transcript[i]
    if (item?.kind === 'text' && item.agentId === 'main' && item.text.trim()) return item.text
  }
  return ''
}

async function runArtifactInvocation(invocation: ArtifactInvocation): Promise<void> {
  const prompt = invocation.prompt.trim()
  if (!prompt) return replyToArtifactInvocation(invocation.id, { ok: false, error: 'prompt is required' })
  const blocked = bridgeBlocker()
  if (blocked) return replyToArtifactInvocation(invocation.id, { ok: false, error: blocked.error })
  try {
    if (invocation.chat === 'new') {
      setState({ current: initialChat(state.settings.modelId), starterPromptsPending: false, starterPromptsDraft: [] })
    } else if (invocation.chat && invocation.chat !== 'current') {
      const known = state.current.id === invocation.chat || state.chats.some((meta) => meta.id === invocation.chat)
      if (!known) return replyToArtifactInvocation(invocation.id, { ok: false, error: `no chat with id ${invocation.chat}` })
      await selectChat(invocation.chat)
    }
    const chatId = state.current.id
    await waitForChatIdle(chatId)
    const from = state.current.id === chatId ? state.current.transcript.length : 0
    debugLog.log('ui', `artifact invocation from ${artifactNameFromPath(invocation.path)} → chat ${chatId}`)
    await sendMessage(prompt, { source: { kind: 'artifact', path: invocation.path } })
    // A user turn that slipped in first queues ours; wait for the queue to drain.
    await waitForChatIdle(chatId)
    const record = state.current.id === chatId ? state.current : await getChat(chatId)
    const text = record ? lastMainReply(record.transcript, from) : ''
    replyToArtifactInvocation(invocation.id, { ok: true, chatId, text })
  } catch (err) {
    replyToArtifactInvocation(invocation.id, { ok: false, error: formatError(err) })
  }
}

function drainArtifactInvocations(): Promise<void> {
  if (!state.loaded) return Promise.resolve()
  if (artifactInvocationDrain) return artifactInvocationDrain
  artifactInvocationDrain = (async () => {
    try {
      // Invocations that arrive while one is running are picked up by the next
      // pass, so loop until the queue is empty.
      for (;;) {
        const invocations = await claimArtifactInvocations()
        if (invocations.length === 0) break
        for (const invocation of invocations) await runArtifactInvocation(invocation)
      }
    } catch (err) {
      debugLog.error('ui', 'artifact invocations', err)
    } finally {
      artifactInvocationDrain = undefined
    }
  })()
  return artifactInvocationDrain
}

/* ---- agent bridge ------------------------------------------------------- *
 * Entry points for local coding agents (Claude Code, Cursor, the `handoff` CLI)
 * reaching in through the loopback daemon. Deliberately thin: they do exactly
 * what the user's own clicks do — open a chat, put it on screen, send a
 * message — so the agent sees no difference between a chat an external tool
 * started and one the user typed. In particular, switching the view to the new
 * chat never touches turns already running in other chats (see selectChat).
 */

export type BridgeActionResult =
  | { ok: true; chatId: string; queued?: boolean }
  | { ok: false; code: BridgeErrorCode; error: string }

/**
 * Requests arrive over a socket and can land in the same tick; each one moves
 * `state.current` and then reads it back, so they run one at a time.
 */
let bridgeQueue: Promise<unknown> = Promise.resolve()

function serializeBridge<T>(fn: () => Promise<T>): Promise<T> {
  const run = bridgeQueue.then(fn, fn)
  bridgeQueue = run.catch(() => undefined)
  return run
}

/** Shared preflight: the panel has to be past setup and hold a usable credential. */
function bridgeBlocker(): { code: BridgeErrorCode; error: string } | undefined {
  if ((state.showOnboarding) || state.setupBlocksComposer) {
    return { code: 'no_credential', error: 'Handoff is still in first-run setup. Finish it in the side panel, then retry.' }
  }
  if (!hasActiveCredential()) {
    return { code: 'no_credential', error: 'Handoff has no model credential connected. Open Settings in the side panel and connect an account or API key.' }
  }
  return undefined
}

/** Open a new chat on behalf of an external agent and start it immediately. */
export function createExternalChat(req: {
  prompt: string
  client: string
  label?: string
  cwd?: string
}): Promise<BridgeActionResult> {
  return serializeBridge(async () => {
    await initStore()
    const prompt = req.prompt.trim()
    if (!prompt) return { ok: false as const, code: 'bad_request' as const, error: 'prompt is required' }
    const blocked = bridgeBlocker()
    if (blocked) return { ok: false as const, ...blocked }

    const origin: ChatOrigin = {
      kind: 'external',
      client: req.client || 'external agent',
      label: req.label,
      cwd: req.cwd,
      at: Date.now(),
    }
    const current: ChatRecord = { ...initialChat(state.settings.modelId), origin }
    // Same move as the context-menu "Research this" handoff: put the new chat
    // on screen without disturbing anything already running elsewhere. Starter
    // prompts are skipped — this chat gets its first message right now.
    setState({ current, starterPromptsPending: false, starterPromptsDraft: [] })
    void sendMessage(prompt).catch((err) => debugLog.error('ui', 'bridge chat send', err))
    debugLog.log('ui', `bridge chat opened by ${origin.client}`)
    return { ok: true as const, chatId: current.id }
  })
}

/**
 * Follow-up into an existing chat. Brings that chat on screen first (the user
 * should see what their tools are doing) and then sends exactly as the
 * composer would — including queueing behind a turn that is still running.
 */
export function sendExternalMessage(chatId: string, text: string): Promise<BridgeActionResult> {
  return serializeBridge(async () => {
    await initStore()
    const trimmed = text.trim()
    if (!trimmed) return { ok: false as const, code: 'bad_request' as const, error: 'message is required' }
    const known = state.current.id === chatId || state.chats.some((meta) => meta.id === chatId)
    if (!known) return { ok: false as const, code: 'not_found' as const, error: `no chat with id ${chatId}` }
    const blocked = bridgeBlocker()
    if (blocked) return { ok: false as const, ...blocked }

    await selectChat(chatId)
    if (state.current.id !== chatId) {
      return { ok: false as const, code: 'internal' as const, error: `could not open chat ${chatId}` }
    }
    const queued = state.runningChatIds.includes(chatId)
    void sendMessage(trimmed).catch((err) => debugLog.error('ui', 'bridge follow-up send', err))
    debugLog.log('ui', `bridge follow-up on ${chatId}${queued ? ' (queued behind running turn)' : ''}`)
    return { ok: true as const, chatId, queued: queued || undefined }
  })
}

/** Stop a chat's turn on behalf of an external agent (same as the Stop button). */
export function cancelExternalChat(chatId: string): BridgeActionResult {
  if (!state.runningChatIds.includes(chatId)) {
    return { ok: false, code: 'not_found', error: `chat ${chatId} is not running` }
  }
  stopChat(chatId)
  return { ok: true, chatId }
}

/** Subscribe to the store without React, for the bridge's status feed. */
export function subscribeStore(cb: () => void): () => void {
  return subscribe(cb)
}

/** Current snapshot, for the bridge's status feed. */
export function readState(): UiState {
  return state
}
