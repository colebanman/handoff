/**
 * Core contracts for handoff. Every module codes against this file.
 *
 * Module map (ownership):
 *  - src/cdp/**      implements CdpService        (chrome.debugger, AX-tree snapshots, input)
 *  - src/sandbox/**  implements SandboxService    (sandboxed eval page + RPC bridge + injected API)
 *  - src/agent/**    implements runAgentTurn       (AI SDK v6 loop, tools, subagents, tasks)
 *  - src/ui/**       renders AgentEvents, owns chats/settings screens
 *  - src/storage/**  chrome.storage persistence for chats + settings
 */

import type { ChatOrigin } from './bridge-protocol'

import type { BrowserContextAttachment } from './browser-events'
import type { JsonValue } from './rpc'
import type { AskUserFn } from './user-prompt'

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

/** 'main' for the top-level agent; 'sub-<uid>' for subagents. */
export type AgentId = string

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** Input tokens served from the provider's prompt cache (subset of inputTokens). */
  cachedInputTokens?: number
}

export interface WorkflowPhaseDefinition {
  id: string
  title: string
  description?: string
}

export interface WorkflowMeta {
  title: string
  description: string
  phases?: WorkflowPhaseDefinition[]
}

export type WorkflowStatus = 'running' | 'done' | 'error' | 'cancelled' | 'orphaned'

export interface WorkflowAgentSnapshot {
  callId: string
  agentId?: AgentId
  label: string
  prompt: string
  phaseId?: string
  batchId?: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  usage?: Usage
  items: TranscriptItem[]
  result?: string
  error?: string
}

export interface WorkflowRunSnapshot {
  runId: string
  meta: WorkflowMeta
  sourcePath: string
  status: WorkflowStatus
  startedAt: number
  endedAt?: number
  currentPhaseId?: string
  logs: Array<{ at: number; message: string }>
  agents: WorkflowAgentSnapshot[]
  usage: Usage
  result?: string
  error?: string
}

/**
 * The event stream emitted by the agent core while a turn runs.
 * The UI folds these into TranscriptItems (see reduceTranscript in src/ui).
 * Subagent events carry their own agentId; the UI nests them under the
 * spawning `subagent_spawn` tool call via parentAgentId on 'agent-start'.
 */
export type AgentEvent =
  | {
      type: 'agent-start'
      agentId: AgentId
      parentAgentId?: AgentId
      parentToolCallId?: string
      task?: string
      modelId: string
      tabIds?: number[]
      workflowRunId?: string
      workflowCallId?: string
    }
  | { type: 'usage-update'; agentId: AgentId; modelId: string; usage: Usage }
  | { type: 'compaction'; agentId: AgentId; id: string; status: 'running' | 'done' | 'error' | 'cancelled' }
  | { type: 'reasoning-start'; agentId: AgentId; id: string }
  | { type: 'reasoning-delta'; agentId: AgentId; id: string; delta: string }
  | { type: 'reasoning-end'; agentId: AgentId; id: string; durationMs?: number }
  | { type: 'text-start'; agentId: AgentId; id: string; at?: number }
  | { type: 'text-delta'; agentId: AgentId; id: string; delta: string }
  | { type: 'text-end'; agentId: AgentId; id: string }
  | { type: 'tool-input-start'; agentId: AgentId; toolCallId: string; toolName: string }
  | { type: 'tool-input-delta'; agentId: AgentId; toolCallId: string; delta: string }
  | { type: 'tool-call'; agentId: AgentId; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; agentId: AgentId; toolCallId: string; toolName: string; output: unknown; durationMs: number; isError?: boolean }
  /** A steering message attached to the running turn at a step boundary (after tool results). */
  | { type: 'steering'; agentId: AgentId; text: string }
  /** The provider rate-limited the request; the turn is paused and will retry indefinitely.
   * `waitingForMain` marks a subagent holding its retry until the main agent's request goes through. */
  | { type: 'rate-limit'; agentId: AgentId; attempt: number; retryInMs: number; message?: string; waitingForMain?: boolean }
  /** A rate-limited request went through; the turn resumed. */
  | { type: 'rate-limit-clear'; agentId: AgentId }
  /** The agent switched models mid-task (e.g. OpenAI rate-limit → Grok). Context is preserved. */
  | { type: 'model-switch'; agentId: AgentId; modelId: string; previousModelId: string }
  | { type: 'agent-finish'; agentId: AgentId; text: string; usage?: Usage; finishReason?: string }
  | { type: 'agent-error'; agentId: AgentId; error: string }
  | { type: 'workflow-start'; toolCallId: string; workflow: WorkflowRunSnapshot }
  | { type: 'workflow-phase'; toolCallId: string; runId: string; phaseId: string }
  | { type: 'workflow-log'; toolCallId: string; runId: string; at: number; message: string }
  | { type: 'workflow-agent-register'; toolCallId: string; runId: string; agent: WorkflowAgentSnapshot }
  | {
      type: 'workflow-finish'
      toolCallId: string
      runId: string
      status: 'done' | 'error' | 'cancelled'
      result?: string
      error?: string
      endedAt: number
    }
  | { type: 'task-update'; task: TaskInfo }
  /** The agent committed durable facts to /workspace/MEMORY.md via `memory_write`. */
  | { type: 'memory-saved'; agentId: AgentId; titles: string[]; forgotten: string[]; file?: string }

/* ------------------------------------------------------------------ */
/* Transcript (UI-facing, persisted per chat)                          */
/* ------------------------------------------------------------------ */

export type ToolStatus = 'running' | 'done' | 'error'

/**
 * An image attached to an outgoing user message (drag-drop/paste upload, or an
 * "Appshot" capture of the active tab). The image bytes live in the VFS at
 * `path`; the transcript persists only this metadata and the feed re-reads the
 * file to render the embed. Appshots also carry the capture-time tab metadata
 * (title/url/tabId) shown on the embed card.
 */
export interface UserAttachment {
  id: string
  kind: 'image' | 'appshot'
  /** VFS path of the stored image, e.g. /workspace/appshots/appshot-….png */
  path: string
  name: string
  mediaType: string
  /** Appshot capture metadata. */
  tabId?: number
  title?: string
  url?: string
  capturedAt?: number
}

/** Where a user-role message came from when the user did not type it. */
export type UserMessageSource =
  /** The artifact whose `ai.invoke()` sent the prompt. */
  | { kind: 'artifact'; path: string }
  /** A scheduled automation run. */
  | { kind: 'automation'; id: string; title: string }

export type TranscriptItem =
  /** `steered` marks a message attached mid-turn (user → main agent, or main agent → subagent).
   *  `pending` marks steering the model hasn't received yet (render-only synthetic item — never persisted).
   *  `source` marks a programmatic prompt (an artifact's ai.invoke) so the feed can badge it. */
  | { kind: 'user'; id: string; text: string; at: number; steered?: boolean; pending?: boolean; attachments?: UserAttachment[]; contexts?: BrowserContextAttachment[]; source?: UserMessageSource }
  | { kind: 'reasoning'; id: string; agentId: AgentId; text: string; streaming: boolean; durationMs?: number }
  | { kind: 'text'; id: string; agentId: AgentId; text: string; streaming: boolean; at?: number }
  | { kind: 'compaction'; id: string; agentId: AgentId; status: 'running' | 'done' | 'error' | 'cancelled' }
  | {
      kind: 'tool'
      id: string // === toolCallId
      agentId: AgentId
      toolName: string
      /** Raw streamed JSON while args stream in; parsed input once complete. */
      inputText: string
      input?: unknown
      /**
       * Length of inputText when `input` was last re-parsed. Large streaming
       * inputs are re-parsed on a growth threshold instead of every delta
       * (re-parsing the whole accumulated JSON per delta is O(n²)).
       */
      inputParsedLength?: number
      output?: unknown
      status: ToolStatus
      durationMs?: number
      at: number
      /** For subagent_spawn calls: the child feed rendered nested inside this card. */
      childAgentId?: AgentId
      childItems?: TranscriptItem[]
      childStatus?: 'running' | 'done' | 'error'
      workflow?: WorkflowRunSnapshot
    }
  | { kind: 'error'; id: string; agentId: AgentId; message: string; at: number }
  /** A compact "Remembered X" chip; clicking it opens /workspace/MEMORY.md. */
  | { kind: 'memory'; id: string; agentId: AgentId; titles: string[]; forgotten: string[]; at: number; file?: string }

/* ------------------------------------------------------------------ */
/* Background tasks (async subagents / sandbox jobs)                   */
/* ------------------------------------------------------------------ */

/** 'orphaned': the task was running when its host context (extension reload)
 * died; its last saved state is queryable and it may be resumable. */
/** `cancelling` means authority is revoked but an already-dispatched operation
 * is still settling. It is deliberately non-terminal. */
export type TaskStatus = 'running' | 'cancelling' | 'done' | 'error' | 'cancelled' | 'orphaned'

export interface TaskInfo {
  id: string
  kind: 'subagent' | 'workflow'
  description: string
  status: TaskStatus
  agentId: AgentId
  /** Chat whose turn spawned this task; lets "stop" cancel a chat's subagents. */
  chatId?: string
  startedAt: number
  endedAt?: number
  /** Final text (or error message) once finished. */
  result?: string
  workflowRunId?: string
  /** Browser tabs this agent exclusively holds, as `tab:<id>` keys. */
  surfaces?: string[]
  workflowProgress?: { totalAgents: number; completedAgents: number; totalTokens: number; currentPhaseId?: string }
}

/* ------------------------------------------------------------------ */
/* Settings & models                                                   */
/* ------------------------------------------------------------------ */

export type ProviderKind = 'gateway' | 'openai' | 'openai-compatible' | 'xai' | 'cerebras'

export interface Settings {
  /** Experimental decision service; disabled unless explicitly enabled with a key. */
  typeSafeEnabled?: boolean
  typeSafeApiKey?: string
  provider: ProviderKind
  /** How direct OpenAI requests authenticate. Absent preserves the legacy API-key path. */
  openaiAuthMode?: 'api-key' | 'chatgpt'
  /** API key for the ACTIVE provider (what resolveModel reads). Kept in sync with `apiKeys`. */
  apiKey: string
  /**
   * Per-provider key vault, so switching models across providers (e.g. GPT ⇄
   * Grok in the model picker) doesn't lose keys. Source of truth once present;
   * legacy records with only `apiKey` are seeded on first normalize.
   */
  apiKeys?: Partial<Record<ProviderKind, string>>
  /** Only for provider === 'openai-compatible'. */
  baseURL?: string
  modelId: string
  /** UI theme; defaults to dark when absent. */
  theme?: 'dark' | 'light'
  /**
   * Set once the first-run onboarding walkthrough has been finished or skipped.
   * Absent (with no keys yet) triggers onboarding on load; also re-triggerable
   * from Settings ("Run setup again").
   */
  onboardingComplete?: boolean
  /**
   * Fire a chrome.notifications alert when a turn running ≥30s finishes while
   * the panel is hidden/unfocused. Undefined means enabled (opt-out toggle,
   * default ON) — only an explicit `false` disables it.
   */
  notifyOnLongTurn?: boolean
  /**
   * Standing instructions the user wants applied to every chat (writing
   * style, default cautions, recurring context). Injected into the DYNAMIC
   * system block only — never the cacheable static prefix. Subagents inherit
   * them. Absent/empty = no section.
   */
  customInstructions?: string
  /**
   * Pause the main agent every STEP_CHECKPOINT steps to ask "keep going?"
   * (the step-prompt banner). Undefined means enabled (opt-out toggle, default
   * ON) — only an explicit `false` disables it, letting a turn run to
   * completion without ever asking about step count.
   */
  pauseAtStepCheckpoints?: boolean
  /**
   * What the user asked to be called, collected on the last onboarding step.
   * Kept in settings (not only in MEMORY.md) because the empty-chat greeting
   * needs it synchronously on first paint; the memory entry is what the agent
   * reads. Absent = greet without a name.
   */
  userName?: string
  /**
   * After each turn, predict the user's likely next message and offer it as
   * accept-on-Tab ghost text in the composer. Costs one cheap model call per
   * turn (which draws on the user's own subscription quota), so it is a toggle.
   * Undefined means enabled (opt-out, default ON) — only an explicit `false`
   * disables it.
   */
  suggestNextPrompt?: boolean
  /**
   * Agent bridge: let local coding agents (Claude Code, Cursor, the `handoff`
   * CLI) open chats here and read the results back through the loopback
   * `handoff-bridge` daemon. Undefined means enabled (opt-out toggle, default ON)
   * — only an explicit `false` disables it, and that choice sticks until the
   * user changes it back.
   */
  bridgeEnabled?: boolean
  /** Loopback port the daemon listens on. Absent = BRIDGE_DEFAULT_PORT. */
  bridgePort?: number
  /**
   * How much of the agent's on-page pointer to draw. `off` never injects it,
   * `actions` only shows it around clicks/typing/scrolls, `ambient` keeps it on
   * the page for the whole run. Absent/unknown migrates to the default
   * (`ambient`) in normalizeSettings, so readers never branch on undefined.
   */
  activityCursor?: ActivityCursorMode
}

/** @see Settings.activityCursor */
export type ActivityCursorMode = 'off' | 'actions' | 'ambient'

/* ------------------------------------------------------------------ */
/* First-run setup (the "Luna pass")                                   */
/* ------------------------------------------------------------------ */

/**
 * State of the one-off background call that seeds /workspace/MEMORY.md and the
 * starter prompts from the user's existing Chrome data. Kicked off the moment
 * ChatGPT OAuth completes during onboarding; the walkthrough screens are what
 * covers its latency.
 */
export type OnboardingSetupStatus = 'idle' | 'running' | 'done' | 'failed'

/** Persisted result of the Luna pass (chrome.storage.local key `onboardingSetup`). */
export interface OnboardingSetupRecord {
  status: OnboardingSetupStatus
  /** Prompts offered as chips on the empty chat screen. */
  starterPrompts: string[]
  startedAt?: number
  finishedAt?: number
  /** Why it failed, for the debug log / Settings — never shown as a blocking error. */
  error?: string
}

/** Hard ceiling on the Luna pass: the composer must never stay locked longer. */
export const ONBOARDING_SETUP_TIMEOUT_MS = 90_000

/** Shown as chips when the Luna pass produced nothing (skipped, failed, xAI-only user). */
export const FALLBACK_STARTER_PROMPTS = [
  'Summarize my open tabs',
  'Find that page I visited last week about ',
  'Pull the key details off this page into a file',
]

/**
 * Steps between "keep going?" checkpoints. There is no hard step cap: the main
 * agent pauses at every multiple of this and asks the user to continue (see
 * RunTurnOptions.onStepLimit). Subagents have no prompt channel and stop hard
 * at the first checkpoint.
 */
export const STEP_CHECKPOINT = 50

export const DEFAULT_MODEL_ID = 'grok-4.6'
export const OPENAI_DEFAULT_MODEL_ID = 'gpt-5.6-sol'
export const XAI_DEFAULT_MODEL_ID = 'grok-4.6'
export const CEREBRAS_DEFAULT_MODEL_ID = 'qwen-3.8-27b'

/** Providers with curated entries in the model picker. */
export type CuratedModelProvider = 'openai' | 'xai' | 'openai-compatible' | 'cerebras'

export interface ModelOption {
  id: string
  label: string
  provider: CuratedModelProvider
  contextWindow?: number
  /**
   * Endpoint this entry is pinned to. Set only for locally served models, where
   * the URL is a property of the model rather than a user setting. Applied at
   * request time, so it never overwrites a user-configured proxy `baseURL`.
   */
  baseURL?: string
}

/**
 * A local server authenticates nothing, but every "is this provider usable"
 * guard requires a non-empty key, so pinned local entries carry a placeholder.
 */
export const LOCAL_ENDPOINT_PLACEHOLDER_KEY = 'local'

/** Curated picker options; free-text custom ids are also allowed. */
export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai' },
  { id: 'grok-4.6', label: 'Grok 4.6', provider: 'xai' },
  { id: 'grok-4.6-fast', label: 'Grok 4.6 Fast', provider: 'xai' },
  { id: CEREBRAS_DEFAULT_MODEL_ID, label: 'Qwen 3.8 27B', provider: 'cerebras' },
  {
    // Optional local endpoints; users supply their own compatible model server.
    id: 'handoff-qwen3.5-4b-secondary',
    label: 'Qwen3.5-4B (local, port 8098)',
    provider: 'openai-compatible',
    baseURL: 'http://127.0.0.1:8098/v1',
  },
  {
    id: 'handoff-qwen3.5-4b',
    label: 'Qwen3.5-4B (local, port 8099)',
    provider: 'openai-compatible',
    baseURL: 'http://127.0.0.1:8099/v1',
  },
]

/** True for a curated entry served from a pinned local endpoint. */
export function isLocalModelId(modelId: string): boolean {
  return Boolean(MODEL_OPTIONS.find((m) => m.id === modelId.trim())?.baseURL)
}

/**
 * Chars of accessibility-tree snapshot the locally served Qwen adapters may
 * carry in replayed history.
 *
 * Their window is 32,768 tokens, of which the pinned training prefix (system
 * prompt + 19 tool schemas) already spends ~11,700 and generation reserves
 * 2,048 — leaving ~19,000 for the conversation. Snapshot text measures 3.1
 * chars/token against the Qwen3.5 tokenizer, so this budget is ~11,600 tokens:
 * a little over half of what remains, leaving the rest for user text, assistant
 * output and non-snapshot tool results. Overrunning the window is not a soft
 * failure — the server rejects the whole request.
 *
 * Frontier models get no budget: their windows make one pointless, and an
 * unbudgeted replay keeps their cached prefixes byte-stable.
 */
export const LOCAL_SNAPSHOT_REPLAY_BUDGET_CHARS = 36_000

/**
 * Per-result visible text ceiling for the local 32K Qwen model. The complete
 * value is still spilled to the VFS, so this bounds prefill work without
 * destroying recoverability. Hosted models retain the ordinary 15K ceiling.
 */
export const LOCAL_TOOL_OUTPUT_MAX_CHARS = 6_000

/** Snapshot replay budget for a model, or undefined to replay unbounded. */
export function snapshotBudgetForModel(modelId: string): number | undefined {
  return isLocalModelId(modelId) ? LOCAL_SNAPSHOT_REPLAY_BUDGET_CHARS : undefined
}

/** Smaller individual tool results keep local multi-step prefills bounded. */
export function toolOutputLimitForModel(modelId: string): number | undefined {
  return isLocalModelId(modelId) ? LOCAL_TOOL_OUTPUT_MAX_CHARS : undefined
}

/**
 * Settings a curated pick pins.
 *
 * A curated entry always owns its provider, so selecting one switches provider
 * (and pulls that provider's vaulted key) even from `openai-compatible` —
 * otherwise picking GPT while a local model is active would send the GPT id to
 * the local server. A free-text custom id keeps the old behaviour and never
 * overrides a user-configured proxy.
 *
 * `pinEndpoint` is for request-time resolution only: it materializes the local
 * `baseURL` and placeholder key. Persisted settings leave `baseURL` untouched
 * so a user's own proxy URL survives a trip through a local model.
 */
export function pinnedSettingsForModel(
  modelId: string,
  settings: Settings,
  opts: { pinEndpoint?: boolean } = {},
): Settings {
  const id = modelId.trim()
  const next: Settings = { ...settings, modelId: id }
  const option = MODEL_OPTIONS.find((m) => m.id === id)
  const targetProvider = option?.provider ?? (isOpenAIModelId(id) ? 'openai' : undefined)
  if (!targetProvider) return next
  if (!option && settings.provider === 'openai-compatible') return next
  if (targetProvider !== settings.provider) {
    next.provider = targetProvider
    next.apiKey = settings.apiKeys?.[targetProvider] ?? ''
  }
  if (opts.pinEndpoint && option?.baseURL) {
    next.baseURL = option.baseURL
    next.apiKey = LOCAL_ENDPOINT_PLACEHOLDER_KEY
  }
  return next
}

/**
 * Suffix marking the Priority Processing variant of an xAI model. xAI ships no
 * `-fast` model id: "fast" is `service_tier: 'priority'` on an ordinary
 * request (lower time-to-first-token and inter-token latency, billed at
 * premium token rates). The suffix is our picker-level handle for that flag;
 * `resolveModel` strips it and sets the body field instead.
 */
export const XAI_PRIORITY_SUFFIX = '-fast'

/** True for a curated or custom xAI id that asks for Priority Processing. */
export function isXaiPriorityModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  const bare = id.startsWith('xai/') ? id.slice('xai/'.length) : id
  return bare.startsWith('grok') && bare.endsWith(XAI_PRIORITY_SUFFIX)
}

/** The real xAI model id behind a `-fast` picker entry. */
export function stripXaiPrioritySuffix(modelId: string): string {
  const id = modelId.trim()
  return isXaiPriorityModelId(id) ? id.slice(0, -XAI_PRIORITY_SUFFIX.length) : id
}

/** Recognize OpenAI-owned IDs that may arrive dynamically from the ChatGPT catalog. */
export function isOpenAIModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  const bare = id.startsWith('openai/') ? id.slice('openai/'.length) : id
  return (
    id.startsWith('openai/') ||
    bare.startsWith('gpt-') ||
    bare.startsWith('chatgpt-') ||
    bare.startsWith('codex-') ||
    /^o\d(?:-|$)/.test(bare)
  )
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'xai',
  apiKey: '',
  modelId: DEFAULT_MODEL_ID,
}

/* ------------------------------------------------------------------ */
/* Chat storage                                                        */
/* ------------------------------------------------------------------ */

/**
 * Per-turn harness metadata, appended when a turn ends (success, error, or
 * abort). Analytics-only: rewinding a chat does not remove entries — they
 * record API activity that really happened.
 */
export interface ChatTurnMeta {
  /** Turn start timestamp (ms). */
  at: number
  /** Wall-clock duration of the whole turn. */
  wallMs: number
  modelId: string
  provider: ProviderKind
  /** Legacy hard step cap (removed 2026-07; STEP_CHECKPOINT prompts replaced it). */
  maxSteps?: number
  /** Steps the turn actually ran. */
  steps?: number
  usage?: Usage
  /** e.g. 'stop', 'tool-calls' (what a step-checkpoint stop looks like). */
  finishReason?: string
  errorText?: string
  aborted?: boolean
  /** True when the turn ended with zero visible output (no text/reasoning/
   * tool activity reached the transcript) and wasn't a user abort — the
   * harness-level "dead turn" the UI shows a retry chip for. */
  deadTurn?: boolean
  /** Mid-turn steering messages attached at step boundaries. */
  steeringCount?: number
  /** Provider rate-limit waits the turn sat through. */
  rateLimitWaits?: number
}

export interface ChatRecord {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  modelId: string
  /** ModelMessage[] from the AI SDK — the model-facing history, opaque here. */
  messages: unknown[]
  /** UI-facing rendered history. */
  transcript: TranscriptItem[]
  /** Per-turn harness metadata (usage, finishReason, timing), append-only. */
  turns?: ChatTurnMeta[]
  /**
   * Recent cases where the composer offered an auto-suggestion but the user
   * sent different text. Fed back into the next prediction as compact preference
   * examples; accepted suggestions are deliberately omitted.
   */
  nextPromptFeedback?: NextPromptFeedback[]
  /**
   * Chat-only rewind points. These intentionally store only model-history and
   * transcript offsets; reverting never touches tabs, artifacts, or files.
   */
  checkpoints?: ChatCheckpoint[]
  /**
   * Set when a local coding agent opened this chat over the bridge. Absent =
   * the user started it. Drives the "via <client>" badge in the chat list.
   */
  origin?: ChatOrigin
}

export interface NextPromptFeedback {
  suggested: string
  sentInstead: string
}

export interface ChatCheckpoint {
  id: string
  /** User transcript item that started this turn. */
  userItemId: string
  userText: string
  at: number
  /** State immediately before that user message was added. */
  transcriptIndexBefore: number
  messageCountBefore: number
}

/* ------------------------------------------------------------------ */
/* CDP service contract (implemented by src/cdp)                       */
/* ------------------------------------------------------------------ */

export interface SnapshotResult {
  tabId: number
  url: string
  title: string
  /** Serialized AX-tree text with element refs like [e12]. */
  text: string
}

/** One captured page network request (per-tab ring buffer while attached). */
export interface NetworkRequestEntry {
  requestId: string
  url: string
  method: string
  /** CDP ResourceType: 'XHR' | 'Fetch' | 'Document' | 'Script' | 'Image' | ... */
  resourceType: string
  status?: number
  mimeType?: string
  /** First ~2000 chars of the request body when CDP included it inline. */
  postData?: string
  hasPostData?: boolean
  /** errorText when the request failed (blocked, aborted, net error). */
  failed?: string
  /** True once loading finished — only then is the response body retrievable. */
  finished: boolean
  /** Epoch ms when the request was sent. */
  ts: number
}

/** One frame in a tab, from api.frames.list. */
export interface FrameInfo {
  frameId: string
  url: string
  name?: string
  parentFrameId?: string
  /** True for the tab's top-level frame. */
  main?: boolean
  /** True when the frame renders in another process (cross-origin iframe). */
  oopif?: boolean
  /** OOPIFs only: whether a debugger session is attached (frames.eval/click reachable). */
  attached?: boolean
}

/** A VFS file transferred into a page as a real browser File object. */
export interface PageAttachmentFile {
  name: string
  mediaType: string
  size: number
  base64: string
  lastModified?: number
}

export interface PageAttachmentTarget {
  /** Element ref from the newest accessibility snapshot. */
  ref?: string
  /** CSS selector, useful for hidden input[type=file] elements. */
  selector?: string
  /** Auto uses a file input when the target is/contains one, otherwise drop. */
  mode?: 'auto' | 'input' | 'drop'
}

export interface PageAttachmentResult {
  ok: true
  mode: 'input' | 'drop'
  target: string
  count: number
  names: string[]
}

export interface CdpService {
  /** Cached AX label for a current snapshot ref; never makes a browser request. */
  describeRef?(tabId: number, ref: string): { role: string; name: string } | undefined
  /** Scope visual browser feedback to a live agent run. Cleanup also runs on abort. */
  /** `agentId` colors this agent's pointer; omitted keeps the single-agent accent. */
  beginActivity?(signal: AbortSignal, agentId?: string): () => void
  /** Keep an already-positioned cursor visible while a tool is executing. */
  beginToolActivity?(signal: AbortSignal): () => void
  /** Breathe on owned tabs while the model streams and no tool is running. */
  beginModelTurn?(signal: AbortSignal): () => void
  /** Choreograph a visible tab switch around the caller's own activation call. */
  switchTabs?(opts: { fromTab?: number; toTab: number; signal?: AbortSignal; activate: () => Promise<void> }): Promise<void>
  /** Apply the user's pointer-mode setting. */
  setCursorMode?(mode: ActivityCursorMode): void
  /** Navigation lifecycle for frame 0 — lets the pointer re-materialize. */
  onNavigated?(tabId: number, phase: 'committed' | 'domcontentloaded'): void
  /** A tab became active (agent- or user-initiated). */
  onTabActivated?(tabId: number): void
  /** Attach if not already attached. Safe to call repeatedly. */
  attach(tabId: number): Promise<void>
  detach(tabId: number): Promise<void>
  detachAll(): Promise<void>
  /** Raw CDP. Attaches on demand. */
  send<T = unknown>(tabId: number, method: string, params?: object, signal?: AbortSignal): Promise<T>
  /** AX-tree snapshot. Registers refs for this tab (invalidates previous refs). */
  snapshot(tabId: number, visibleTabIds?: number[]): Promise<SnapshotResult>
  click(tabId: number, ref: string, signal?: AbortSignal): Promise<void>
  /** A durable CSS selector for a snapshot ref (refs themselves expire with the snapshot). */
  selectorForRef(tabId: number, ref: string, signal?: AbortSignal): Promise<{ selector: string; label: string }>
  /** Focus element, optionally clear, insert text, optionally press Enter. */
  type(tabId: number, ref: string, text: string, opts?: { clear?: boolean; submit?: boolean; signal?: AbortSignal }): Promise<void>
  /** key: 'Enter' | 'Tab' | 'Escape' | 'ArrowDown' | 'ctrl+a' | ... */
  pressKey(tabId: number, key: string, signal?: AbortSignal): Promise<void>
  scroll(tabId: number, opts: { ref?: string; dy?: number; signal?: AbortSignal }): Promise<void>
  navigate(tabId: number, url: string, signal?: AbortSignal): Promise<void>
  /** True only when document.readyState reached "complete" before the deadline. */
  waitForLoad(tabId: number, timeoutMs?: number, signal?: AbortSignal): Promise<boolean>
  screenshot(tabId: number): Promise<{ base64: string; mediaType: string }>
  /**
   * Runtime.evaluate in the page's main world; returns JSON-serializable result.
   * Default: two-pass — expression form first, statement form on SyntaxError.
   * `statement: true` skips pass 1 for snippets known to use top-level `return`.
   */
  evalInPage<T = unknown>(tabId: number, expression: string, opts?: { statement?: boolean; signal?: AbortSignal }): Promise<T>
  /** Put VFS-backed File objects into an input or dispatch them on a drop target. */
  attachFiles(tabId: number, target: PageAttachmentTarget, files: PageAttachmentFile[], signal?: AbortSignal): Promise<PageAttachmentResult>
  /** Frames in the tab: local frames via Page.getFrameTree + cross-process iframes (OOPIFs). */
  listFrames(tabId: number): Promise<FrameInfo[]>
  /** Runtime.evaluate in an isolated world of the given frame. Two-pass like evalInPage; `statement: true` skips the expression pass. */
  evalInFrame<T = unknown>(tabId: number, frameId: string, expression: string, opts?: { statement?: boolean; signal?: AbortSignal }): Promise<T>
  /** querySelector + scrollIntoView + synthesized click sequence inside the frame. */
  clickInFrame(tabId: number, frameId: string, selector: string, signal?: AbortSignal): Promise<{ ok: boolean; tag?: string; text?: string }>
  /** Requests captured on this tab since attach (oldest → newest, ring-buffered). */
  networkRequests(tabId: number): NetworkRequestEntry[]
  /** Response body for a captured request (Network.getResponseBody). */
  networkResponseBody(tabId: number, requestId: string): Promise<{ body: string; base64Encoded: boolean }>
}

/* ------------------------------------------------------------------ */
/* Sandbox service contract (implemented by src/sandbox)               */
/* ------------------------------------------------------------------ */

/** undefined allowedTabIds = unrestricted (main agent). */
export interface TabScope {
  /** Identity of the agent this scope belongs to ('main' | 'sub-…'). */
  agentId?: string
  /** True when the agent holds no browser surface at all. */
  offlineOnly?: boolean
  /** Exact extension revisions advertised in the current model step. */
  extensionRevisions?: Record<string, number>
  /** Notify the harness when a sandbox operation resolves an in-scope tab. */
  onTabObserved?: (tabId: number) => void
  allowedTabIds?: number[]
  /** Called when the sandbox creates a tab so the scope can absorb it. */
  onTabCreated?: (tabId: number) => void
  /** Agent-owned working tab used when an api call omits tabId. */
  getCurrentTabId?: () => number
  /** Keep the agent's working-tab state aligned after create/activate/navigation. */
  setCurrentTabId?: (tabId: number) => void
}

export interface SandboxExecResult {
  ok: boolean
  /** JSON.stringify of the completion value (pretty, truncated by caller policy). */
  value?: string
  error?: string
  logs: string[]
  durationMs: number
}

export interface SandboxService {
  /**
   * Run async JS in the sandboxed page. `sessionId` keys the persistent
   * `state` object (one per agent). Code has top-level await and sees the
   * injected `api` object plus `state` and `console`.
   */
  exec(opts: {
    code: string
    sessionId: string
    timeoutMs?: number
    scope?: TabScope
    /** Chat the calling agent belongs to (scheduling defaults to it). */
    chatId?: string
    /** Replace the normal browser/filesystem dispatcher (workflow mode). */
    dispatch?: (path: string, args: JsonValue[]) => Promise<JsonValue>
    /** Host wall ceiling; normal sandbox calls keep the five-minute default. */
    wallTimeoutMs?: number
    signal?: AbortSignal
  }): Promise<SandboxExecResult>
}

/* ------------------------------------------------------------------ */
/* Virtual filesystem                                                  */
/* ------------------------------------------------------------------ */

export type VfsRoot = 'skills' | 'workspace'

export interface VfsEntry {
  path: string
  root: VfsRoot
  name: string
  mediaType: string
  size: number
  createdAt: number
  updatedAt: number
  /** Set when writeText() redacted secret-shaped content before persisting (skills only). */
  redactionWarning?: string
}

export interface VfsSkillMetadata {
  name: string
  description: string
  shortDescription?: string
  path: string
  rootPath: string
  updatedAt: number
}

export interface VfsSummary {
  entries: VfsEntry[]
  skills: VfsSkillMetadata[]
}

export interface VfsTextResult {
  path: string
  text: string
  truncated: boolean
  totalChars: number
}

export interface VfsHtmlResult {
  path: string
  html: string
  messages: string[]
}

export interface VfsLineResult {
  path: string
  startLine: number
  lines: string[]
  totalLines: number
}

export interface VfsBytesResult {
  path: string
  base64: string
  mediaType: string
  size: number
  truncated: boolean
}

export interface VfsRenderedPage {
  path: string
  page: number
  mediaType: string
  base64: string
  width: number
  height: number
}

export interface VirtualFileSystemService {
  extensions(operation: string, input?: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>
  list(root?: VfsRoot): Promise<VfsEntry[]>
  summary(): Promise<VfsSummary>
  skills(): Promise<VfsSkillMetadata[]>
  putFile(root: VfsRoot, file: File, relativePath?: string): Promise<VfsEntry>
  writeText(path: string, text: string, opts?: { mediaType?: string; signal?: AbortSignal }): Promise<VfsEntry>
  writeBase64(path: string, base64: string, opts?: { mediaType?: string; signal?: AbortSignal }): Promise<VfsEntry>
  /** Download an http(s) URL into the filesystem (default /workspace/imports/<filename>). */
  importUrl(url: string, opts?: { path?: string; maxBytes?: number; signal?: AbortSignal }): Promise<VfsEntry>
  createSkill(opts: {
    name: string
    description: string
    body?: string
    files?: Array<{ path: string; text?: string; base64?: string; mediaType?: string }>
    signal?: AbortSignal
  }): Promise<VfsEntry[]>
  delete(path: string, opts?: { signal?: AbortSignal }): Promise<void>
  getEntry(path: string): Promise<VfsEntry | undefined>
  readText(path: string, opts?: { offset?: number; maxChars?: number }): Promise<VfsTextResult>
  readHtml(path: string): Promise<VfsHtmlResult>
  readLines(path: string, opts?: { startLine?: number; count?: number }): Promise<VfsLineResult>
  readBytes(path: string, opts?: { offset?: number; length?: number }): Promise<VfsBytesResult>
  blob(path: string): Promise<Blob>
  dataUrl(path: string): Promise<string>
  renderPdfPage(path: string, opts?: { page?: number; scale?: number; signal?: AbortSignal }): Promise<VfsRenderedPage>
  search(query: string, opts?: { root?: VfsRoot; maxResults?: number }): Promise<Array<{ path: string; lines: VfsLineResult['lines'] }>>
}

/* ------------------------------------------------------------------ */
/* Agent core contract (implemented by src/agent)                      */
/* ------------------------------------------------------------------ */

export interface TurnResult {
  /** Response ModelMessages to append to ChatRecord.messages. */
  responseMessages: unknown[]
  text: string
  usage?: Usage
  finishReason?: string
  /** Steps the turn ran (for turn metadata / analytics). */
  steps?: number
  /** First stream error, when the loop ended via an error part instead of throwing. */
  errorText?: string
}

/**
 * Live feed of mid-turn steering messages. The agent calls `take()` at each
 * step boundary (after the previous step's tool results); returned texts are
 * attached as user messages, emitted as 'steering' events, and included in the
 * turn's responseMessages. Steering still pending when the turn finishes is
 * the caller's responsibility (e.g. send it as a follow-up message).
 */
export interface SteeringFeed {
  take(): string[]
  /** Non-consuming check for pending steering, so blocking tools (task_wait) can return early. */
  peek?(): boolean
}

export interface RunTurnOptions {
  chatId: string
  /** Full model-facing history including the just-added user message. */
  messages: unknown[]
  /** Mid-turn user steering, delivered at step boundaries while the turn runs. */
  steering?: SteeringFeed
  settings: Settings
  onEvent: (e: AgentEvent) => void
  signal: AbortSignal
  /** Completed-step history retained if the next command is interrupted. */
  onStepMessages?: (messages: unknown[]) => void
  /**
   * Called when the main agent reaches a step checkpoint (every STEP_CHECKPOINT
   * steps). Runs between provider requests, so nothing is held open while the
   * promise is pending. Resolve true to run another STEP_CHECKPOINT steps,
   * false to end the turn gracefully with what it has. Absent = stop at the
   * first checkpoint.
   */
  onStepLimit?: (steps: number) => Promise<boolean>
  /**
   * Raise a blocking prompt card above the composer and wait for the user
   * (ask_user, approvals). Like onStepLimit this runs between provider
   * requests, so an unanswered prompt holds nothing open. Main agent only —
   * subagents have no prompt channel and never see the tool.
   */
  askUser?: AskUserFn
  /** Initial durable UI checkpoint. The remote MV3 execution host folds every
   * AgentEvent into this record so a reattached panel can render immediately. */
  lifecycleRecord?: ChatRecord
}

export type RunAgentTurn = (opts: RunTurnOptions) => Promise<TurnResult>
