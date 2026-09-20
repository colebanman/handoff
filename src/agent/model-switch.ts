/**
 * Session-scoped mid-task model switching.
 *
 * When OpenAI rate-limits a turn, the user can flip main and/or subagents to
 * Grok without stopping the task. The override lives on the agent runtime for
 * the whole extension session (not just the current turn), so background
 * subagents and later turns honor it too.
 *
 * Application is steering-like: at the next step boundary (after a tool result
 * or completed model output), or immediately when a request is only waiting on
 * a rate-limit retry (nothing generated yet for that step). The loop restarts
 * streamText with the new model while preserving the conversation so far.
 */

import { XAI_DEFAULT_MODEL_ID } from '../shared/types'

/** Who the session override applies to. */
export type ModelSwitchScope = 'all' | 'subagents'

export interface SessionModelOverride {
  modelId: string
  scope: ModelSwitchScope
  /** Bumped on every set so rate-limit waits can detect a change. */
  generation: number
}

/**
 * Thrown inside the agent loop to rebuild streamText after a session setting
 * that affects provider requests changes (currently the model override).
 */
export class AgentLoopRestartError extends Error {
  constructor() {
    super('Agent loop restart')
    this.name = 'AgentLoopRestartError'
  }
}

export function isAgentLoopRestart(err: unknown): boolean {
  if (err instanceof AgentLoopRestartError) return true
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === 'AgentLoopRestartError'
}

/** Default target when the rate-limit banner switches away from OpenAI. */
export const GROK_SWITCH_MODEL_ID = XAI_DEFAULT_MODEL_ID

/**
 * Resolve the model id an agent should run with, given an optional session
 * override. `baseModelId` is the turn/spawn id (chat sticky model for main,
 * parent settings for subagents).
 */
export function resolveDesiredModelId(
  baseModelId: string,
  isSubagent: boolean,
  override: SessionModelOverride | undefined,
): string {
  if (!override) return baseModelId
  if (override.scope === 'all') return override.modelId
  if (override.scope === 'subagents' && isSubagent) return override.modelId
  return baseModelId
}

/**
 * Mutable session override + wake listeners. One instance per agent runtime.
 */
export class SessionModelSwitch {
  private override: SessionModelOverride | undefined
  private generation = 0
  private readonly listeners = new Set<() => void>()

  get(): SessionModelOverride | undefined {
    return this.override
  }

  /**
   * Set (or clear with `undefined`) the session override. Notifies waiters so
   * rate-limit sleeps can abort and the loop can restart on the new model.
   */
  set(next: { modelId: string; scope: ModelSwitchScope } | undefined): void {
    this.generation += 1
    this.override = next
      ? { modelId: next.modelId, scope: next.scope, generation: this.generation }
      : undefined
    for (const wake of this.listeners) {
      try {
        wake()
      } catch {
        // Listener errors must not break other subscribers.
      }
    }
  }

  /** Subscribe to override changes. Returns unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
