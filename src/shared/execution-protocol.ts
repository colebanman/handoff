import type { AgentEvent, ChatRecord, RunTurnOptions, SnapshotResult, TaskInfo, TurnResult } from './types'
import type { UserPromptAnswer, UserPromptRequest } from './user-prompt'

export const AGENT_HOST_PORT = 'agent-execution-host-v1'
export const EXECUTION_KEY_PREFIX = 'agent-execution:'

export interface TabShotCaptureResult {
  shot: { base64: string; mediaType: string }
  snapshot?: SnapshotResult
}

export type ExecutionStatus =
  | 'running'
  | 'cancelling'
  | 'done'
  | 'cancelled'
  | 'error'
  | 'interrupted'

export interface ExecutionInteraction {
  kind: 'step' | 'user-prompt'
  requestId: string
  steps?: number
  prompt?: UserPromptRequest
}

/** Durable checkpoint owned by the service-worker execution host. */
export interface ExecutionSnapshot {
  runId: string
  ownerId: string
  chatId: string
  status: ExecutionStatus
  record: ChatRecord
  startedAt: number
  updatedAt: number
  eventSeq: number
  result?: TurnResult
  error?: string
  interaction?: ExecutionInteraction
}

export interface SerializableRunOptions {
  chatId: string
  messages: unknown[]
  settings: RunTurnOptions['settings']
  record: ChatRecord
  capabilities?: {
    askUser?: boolean
    /** Unattended runs: auto-continue through this many step checkpoints, then stop. */
    autoContinueSteps?: number
  }
}

export type AgentHostClientMessage =
  | { type: 'start'; runId: string; options: SerializableRunOptions }
  | { type: 'cancel'; runId?: string; chatId?: string }
  | { type: 'steer'; chatId: string; text: string }
  | { type: 'interaction-result'; runId: string; requestId: string; value: boolean | UserPromptAnswer | string }
  | { type: 'task-cancel'; taskId: string }
  | { type: 'task-nudge'; taskId: string; text: string }
  | { type: 'model-override'; value?: { modelId: string; scope: 'all' | 'subagents' } }
  | { type: 'list' }

export type AgentHostServerMessage =
  | { type: 'ready'; executions: ExecutionSnapshot[]; tasks: TaskInfo[] }
  | { type: 'event'; runId: string; seq: number; event: AgentEvent }
  | { type: 'snapshot'; snapshot: ExecutionSnapshot }
  | { type: 'task'; task: TaskInfo }
  | { type: 'interaction'; runId: string; interaction: ExecutionInteraction }

export type OffscreenRuntimeMessage =
  | { target: 'background'; type: 'execution.debug'; chatId: string }
  | { target: 'background'; type: 'tabshot.capture'; tabId: number }
  | {
      target: 'offscreen'
      type: 'sandbox.exec'
      execId: string
      code: string
      sessionId: string
      timeoutMs?: number
      wallTimeoutMs?: number
    }
  | { target: 'offscreen'; type: 'sandbox.cancel'; execId: string; reason?: string }
  | { target: 'background'; type: 'sandbox.api'; execId: string; path: string; args: import('./rpc').JsonValue[] }
  | { target: 'offscreen'; type: 'vfs.call'; requestId: string; method: string; args: unknown[] }
  | { target: 'offscreen'; type: 'vfs.cancel'; requestId: string }
  | { target: 'offscreen'; type: 'execution.activity'; runId: string; active: boolean }
  | { target: 'background'; type: 'execution.keepalive' }
