/**
 * The shared streamText loop, factored so both the main agent (`runTurn`) and
 * subagents (subagents.ts) reuse it. `runLoop` resolves the model, builds the
 * tool set, runs streamText, maps every fullStream part to an AgentEvent via
 * `emit`, and returns the final text / response messages / usage.
 */

import { streamText, type ModelMessage, type ToolSet } from 'ai'
import type { AgentEvent, Settings, SteeringFeed, Usage } from '../shared/types'
import type { ArtifactHostService } from '../shared/artifacts'
import { STEP_CHECKPOINT, snapshotBudgetForModel, toolOutputLimitForModel } from '../shared/types'
import type { AskUserFn } from '../shared/user-prompt'
import { uid } from '../shared/ids'
import { debugLog } from '../shared/debug-log'
import { formatError } from '../shared/errors'
import { toolResultError } from '../shared/tool-results'
import { abortable, throwIfAborted } from '../shared/abort'
import { sanitizeModelMessages } from '../shared/model-messages'
import { publishTap, summarizeTapPart, tapEnabled } from '../shared/stream-tap'
import { resolveModel, resolveModelAccess } from './models'
import { OpenAICompaction, withoutCompaction } from './compaction'
import { openAIContextWindow } from '../shared/model-context'
import { listChatGPTModels } from './openai-chatgpt-oauth'
import { withModelIdleTimeout } from './model-idle-timeout'
import { withRateLimitRetry, type MainAgentPriority, type RateLimitHooks } from './rate-limit'
import {
  buildSystemMessages,
  cacheRequestOptions,
  supportsAnthropicPromptCache,
  withCacheBreakpoints,
} from './prompt-cache'
import { inlineMediaToolResults, supportsMediaToolResults } from './tool-result-media'
import { pruneReplayedHistory } from './history-pruning'
import { compressBrowserSnapshots, latestBrowserSnapshotContext } from './browser-snapshot-context'
import { buildSystemPrompt } from './system-prompt'
import { RuntimeContextDelivery, latestTaskText, selectSiteMemories, type ContextTab } from './runtime-context'
import { readMemory, serializeMemoryForPrompt } from './memory'
import { readSiteMemory } from './site-memory'
import { createTypeSafe } from './typesafe'
import { chooseSavedShortcut } from './typesafe-shortcut'
import type { ExtensionSummary } from '../shared/extensions'
import { buildTools, ToolOperationTracker, type AgentContext, type MessageSubagentFn, type RunWorkflowFn, type SpawnSubagentFn, type TaskAccess } from './tools'
import type { CdpService, SandboxService, VirtualFileSystemService } from '../shared/types'
import type { AgentTabGroups } from './tab-groups'
import {
  isAgentLoopRestart,
  AgentLoopRestartError,
  resolveDesiredModelId,
  type SessionModelOverride,
} from './model-switch'

export interface RunLoopOptions {
  ctx: AgentContext
  settings: Settings
  /** The model id to actually run (may override settings.modelId, e.g. per-subagent). */
  modelId: string
  messages: ModelMessage[]
  signal: AbortSignal
  emit: (e: AgentEvent) => void
  deps: { cdp: CdpService; sandbox: SandboxService; vfs: VirtualFileSystemService; artifacts?: ArtifactHostService }
  /** Chat this loop belongs to (main agent only). */
  chatId?: string
  spawnSubagent: SpawnSubagentFn
  tasks: TaskAccess
  sandboxSessionId: string
  tabGroups?: AgentTabGroups
  isSubagent: boolean
  /** For subagents: the parent's spawning tool call id (for agent-start). */
  parentToolCallId?: string
  parentAgentId?: string
  workflowRunId?: string
  workflowCallId?: string
  /** For subagents: the task text (used in system prompt + agent-start). */
  task?: string
  /** Mid-turn steering (user → main agent, or subagent_message → background
   * subagent), drained at step boundaries. */
  steering?: SteeringFeed
  /** Shared gate: a rate-limit-waiting main agent outranks subagent requests. */
  priority?: MainAgentPriority
  /** Called after each completed step with the full conversation so far
   * (request messages + cumulative response messages, steering included).
   * Background subagents save this so a cancelled run can be resumed. */
  onStepMessages?: (messages: ModelMessage[]) => void
  /** Main agent only: steer-or-resume a background subagent (subagent_message). */
  messageSubagent?: MessageSubagentFn
  /** Main agent only: execute a dynamic workflow. */
  runWorkflow?: RunWorkflowFn
  /**
   * Step-checkpoint prompt (main agent only): called every STEP_CHECKPOINT
   * steps, between provider requests. Resolve true to keep going for another
   * checkpoint, false to end the run gracefully. Absent (subagents) = hard
   * stop at the first checkpoint.
   */
  onStepLimit?: (steps: number) => Promise<boolean>
  /**
   * Main agent only: block on a user-prompt card (ask_user). Passed straight
   * through to the tool layer, which awaits it inside execute — the turn is
   * idle between steps while it is pending, exactly like a checkpoint.
   */
  askUser?: AskUserFn
  /**
   * Session model override (OpenAI rate-limit → Grok). Read at start and at
   * each step boundary; changing it mid-rate-limit wait restarts the loop on
   * the new model while preserving conversation context.
   */
  getModelOverride?: () => SessionModelOverride | undefined
}

export interface RunLoopResult {
  responseMessages: unknown[]
  text: string
  usage?: Usage
  finishReason?: string
  /** Steps the run completed. */
  stepCount: number
  /** First stream error, when the loop ended because of one (streamText emits
   * an `error` part and finishes normally instead of throwing). */
  errorText?: string
}

/**
 * Shortest text run worth reporting a rate for. Below this a step is one or two
 * deltas and the first→last window divides by near-zero, producing numbers in
 * the hundreds that say nothing about the model's actual speed.
 */
const MIN_THROUGHPUT_SAMPLE_MS = 250

function toUsage(
  u: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number } | undefined,
): Usage | undefined {
  if (!u) return undefined
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    cachedInputTokens: u.cachedInputTokens,
  }
}

/**
 * Run one agent loop to completion, emitting AgentEvents throughout.
 * Emits `agent-start` first and `agent-finish` last (or `agent-error` on throw).
 */
export async function runLoop(opts: RunLoopOptions): Promise<RunLoopResult> {
  const { ctx, settings, modelId, messages, signal, emit, deps, spawnSubagent, tasks, sandboxSessionId, isSubagent } =
    opts

  // Unique key for this run in the shared priority gate (agentId alone is
  // 'main' for every chat's top-level turn).
  const runKey = uid('run')
  const operationTracker = new ToolOperationTracker(() => deps.cdp.beginToolActivity?.(signal))
  const endActivity = deps.cdp.beginActivity?.(signal, ctx.agentId)

  // Honor a session override already set before this run starts (e.g. user
  // switched all agents to Grok on a prior turn's rate-limit banner).
  let activeModelId = resolveDesiredModelId(modelId, isSubagent, opts.getModelOverride?.())

  emit({
    type: 'agent-start',
    agentId: ctx.agentId,
    parentAgentId: opts.parentAgentId,
    parentToolCallId: opts.parentToolCallId,
    task: opts.task,
    modelId: activeModelId,
    tabIds: ctx.allowedTabIds ? [...ctx.allowedTabIds] : undefined,
    workflowRunId: opts.workflowRunId,
    workflowCallId: opts.workflowCallId,
  })

  let emittedError = false
  let streamErrorText: string | undefined

  if (isSubagent) {
    try {
      await opts.tabGroups?.ensureAgent({
        agentId: ctx.agentId,
        isSubagent,
        tabIds: ctx.offlineOnly ? [] : ctx.allowedTabIds && ctx.allowedTabIds.length > 0 ? ctx.allowedTabIds : [ctx.currentTabId],
      })
    } catch (err) {
      debugLog.error('agent', 'tab group ensureAgent', err)
    }
  }

  try {
    // Priority under rate limits: the main agent marks itself while waiting
    // out a 429 (keyed per run — 'main' collides across parallel chats), and
    // subagents hold every send attempt until no main agent is waiting, so a
    // user message never starves behind parallel subagent retries.
    const priority = opts.priority
    const rateLimitHooks: RateLimitHooks = {
      onWait: ({ attempt, delayMs, message }) => {
        if (!isSubagent) priority?.markWaiting(runKey)
        emit({ type: 'rate-limit', agentId: ctx.agentId, attempt, retryInMs: delayMs, message })
      },
      onClear: () => {
        if (!isSubagent) priority?.clearWaiting(runKey)
        emit({ type: 'rate-limit-clear', agentId: ctx.agentId })
      },
      beforeAttempt:
        isSubagent && priority
          ? async () => {
              if (!priority.busy()) return
              emit({
                type: 'rate-limit',
                agentId: ctx.agentId,
                attempt: 0,
                retryInMs: 0,
                waitingForMain: true,
                message: 'Holding this subagent request until the main agent’s reply goes through.',
              })
              debugLog.log('agent', 'subagent yielding to main', { agentId: ctx.agentId })
              try {
                await priority.waitForClear(signal)
              } finally {
                emit({ type: 'rate-limit-clear', agentId: ctx.agentId })
              }
            }
          : undefined,
      // Wake rate-limit waits when the user switches model or OpenAI
      // processing mode; the outer loop rebuilds the request immediately.
      shouldRestart: () =>
        resolveDesiredModelId(activeModelId, isSubagent, opts.getModelOverride?.()) !== activeModelId,
    }

    const observedTabIds = new Set<number>()
    const typeSafe = createTypeSafe(settings, signal)
    const tools: ToolSet = buildTools({
      typeSafe,
      cdp: deps.cdp,
      sandbox: deps.sandbox,
      vfs: deps.vfs,
      artifacts: deps.artifacts,
      chatId: opts.chatId,
      ctx,
      emit,
      spawnSubagent,
      tasks,
      signal,
      sandboxSessionId,
      tabGroups: opts.tabGroups,
      steeringPending: () => opts.steering?.peek?.() ?? false,
      messageSubagent: opts.messageSubagent,
      runWorkflow: opts.runWorkflow,
      maxToolOutputChars: toolOutputLimitForModel(activeModelId),
      askUser: opts.askUser,
      operationTracker,
      onTabObserved: (tabId) => observedTabIds.add(tabId),
    })

    // Original turn/spawn messages — responseMessages returned at the end are
    // everything after this prefix, even across mid-task model restarts.
    // Replayed history is pruned here (request-time only; the persisted
    // ChatRecord keeps full fidelity): superseded snapshots become stubs and
    // stale oversized outputs are trimmed. Message COUNT is preserved, so the
    // responseMessages slice math and steering-injection indices are unchanged.
    // Model-switch restarts do not persist a pruned copy. For the constrained
    // local model only, prepareStep additionally removes superseded snapshots
    // from its request-time copy; exact cache validation then reuses whatever
    // prefix remains stable without carrying invalid refs forward.
    // The snapshot budget applies only to the small-window local adapters; it
    // is undefined for every hosted model, which leaves their replay unbounded
    // and their cached prefixes byte-identical to before.
    const sanitized = sanitizeModelMessages(messages) as ModelMessage[]
    const prunedHistory = pruneReplayedHistory(sanitized, {
      snapshotBudgetChars: snapshotBudgetForModel(activeModelId),
    })
    if (
      prunedHistory.stubbedSnapshots > 0 ||
      prunedHistory.trimmedOutputs > 0 ||
      prunedHistory.prunedMedia > 0
    ) {
      debugLog.log('agent', 'history pruned', {
        agentId: ctx.agentId,
        stubbedSnapshots: prunedHistory.stubbedSnapshots,
        droppedForBudget: prunedHistory.droppedForBudget,
        trimmedOutputs: prunedHistory.trimmedOutputs,
        prunedMedia: prunedHistory.prunedMedia,
        mediaCharsSaved: prunedHistory.mediaCharsSaved,
        charsSaved: prunedHistory.charsSaved,
      })
    }
    const originalRequest = prunedHistory.messages
    // Pruning is a request projection, never a storage update. Restore the
    // original prefix when checkpointing a run (including subagent resumes).
    const canonicalHistory = (history: ModelMessage[]): ModelMessage[] =>
      [...sanitized, ...history.slice(sanitized.length)]
    let runtimeContext = new RuntimeContextDelivery(sanitized, typeSafe)
    // Initial messages for the current streamText attempt; advanced to the
    // last completed-step snapshot when we restart on a new model.
    let streamMessages = originalRequest

    // Steering messages injected mid-turn. The SDK rebuilds each step's input
    // as [...initialMessages, ...responseMessages] (a prepareStep override only
    // applies to that one step, and response.messages never includes it), so
    // every injection is recorded with its position in those un-injected
    // coordinates, re-spliced on every subsequent step, and merged into the
    // responseMessages we return. Cleared on model-switch restart once the
    // injections have been folded into streamMessages.
    const injected: Array<{ index: number; message: ModelMessage }> = []
    const withInjections = (base: ModelMessage[], baseOffset: number): ModelMessage[] => {
      const merged = [...base]
      let shift = 0
      for (const inj of injected) {
        const at = Math.min(Math.max(inj.index - baseOffset + shift, 0), merged.length)
        merged.splice(at, 0, inj.message)
        shift += 1
      }
      return merged
    }

    // No hard step cap. At every STEP_CHECKPOINT steps the run pauses — the
    // stop condition is evaluated between provider requests, so awaiting the
    // caller's decision holds nothing open — and `onStepLimit` decides whether
    // to grant another checkpoint's worth of steps. An abort while waiting
    // resolves the decision to "stop" so the loop can wind down.
    // stepLimit counts total steps across model-switch restarts.
    let stepLimit = STEP_CHECKPOINT
    let stepCount = 0
    const decideAtCheckpoint = (steps: number): Promise<boolean> =>
      new Promise((resolve) => {
        const onAbort = (): void => resolve(false)
        signal.addEventListener('abort', onAbort, { once: true })
        opts.onStepLimit!(steps).then(
          (keepGoing) => {
            signal.removeEventListener('abort', onAbort)
            resolve(keepGoing)
          },
          (err) => {
            signal.removeEventListener('abort', onAbort)
            debugLog.error('agent', 'onStepLimit', err)
            resolve(false)
          },
        )
      })

    // Full conversation after the latest completed step (or final response),
    // used for subagent resume snapshots and for computing responseMessages
    // across model-switch restarts.
    let fullConversation = sanitized
    let finalText = ''
    let finalUsage: Usage | undefined
    let finalFinishReason: string | undefined

    // Attempt once per fresh main-agent turn. Execute through the ordinary tool
    // wrapper so scope, cancellation, activity, output spilling and UI stay intact.
    if (typeSafe && !isSubagent && !ctx.offlineOnly && deps.vfs.extensions && !opts.steering?.peek?.()) {
      let shortcut
      try {
        const [entries, tabs, memory, sites] = await Promise.all([
          deps.vfs.extensions('list') as Promise<ExtensionSummary[]>, chrome.tabs.query({}),
          readMemory(deps.vfs), readSiteMemory(deps.vfs),
        ])
        const constraints = JSON.stringify({ standingInstructions: settings.customInstructions,
          userMemory: serializeMemoryForPrompt(memory),
          siteGuidance: selectSiteMemories(sites, latestTaskText(sanitized), tabs, { isSubagent: false, currentTabId: ctx.currentTabId }),
        })
        shortcut = await chooseSavedShortcut(typeSafe, entries, tabs, sanitized, constraints)
        if (shortcut) {
          const fresh = await deps.vfs.extensions('list') as ExtensionSummary[]
          if (!fresh.some((e) => e.id === shortcut!.id && e.enabled && e.revision === shortcut!.revision)) shortcut = undefined
        }
      } catch {
        throwIfAborted(signal)
        debugLog.log('agent', 'TypeSafe shortcut unavailable; using agent')
      }
      throwIfAborted(signal)
      if (shortcut && !opts.steering?.peek?.()) {
        const toolCallId = uid('shortcut')
        const input = { intent: shortcut.intent, code: shortcut.code }
        ctx.extensionRevisions = { ...ctx.extensionRevisions, [shortcut.id]: shortcut.revision }
        emit({ type: 'tool-call', agentId: ctx.agentId, toolCallId, toolName: 'sandbox_exec', input })
        const started = Date.now()
        const output = await tools.sandbox_exec!.execute!(input, { toolCallId, messages: sanitized, abortSignal: signal })
        throwIfAborted(signal)
        const text = String(output)
        emit({ type: 'tool-result', agentId: ctx.agentId, toolCallId, toolName: 'sandbox_exec', output: text,
          durationMs: Date.now() - started, isError: !!toolResultError(text) })
        const completed: ModelMessage[] = [
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'sandbox_exec', input }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'sandbox_exec', output: { type: 'text', value: text } }] },
        ]
        streamMessages = [...originalRequest, ...completed]
        fullConversation = [...sanitized, ...completed]
        opts.onStepMessages?.(fullConversation)
      }
    }

    // Restart streamText when the model switches mid-task (rate-limit banner
    // or step boundary). Each attempt keeps conversation context.
    while (true) {
      const desired = resolveDesiredModelId(activeModelId, isSubagent, opts.getModelOverride?.())
      if (desired !== activeModelId) {
        const previousModelId = activeModelId
        activeModelId = desired
        emit({ type: 'model-switch', agentId: ctx.agentId, modelId: activeModelId, previousModelId })
        debugLog.log('agent', 'model switch', {
          agentId: ctx.agentId,
          from: previousModelId,
          to: activeModelId,
        })
      }

      // Per-subagent / cross-provider overrides: `effective` carries the
      // provider/key/model the request will actually use.
      const access = await abortable(resolveModelAccess(settings, activeModelId), signal)
      const effective = access.settings
      if (effective.modelId !== activeModelId) {
        const previousModelId = activeModelId
        activeModelId = effective.modelId
        emit({ type: 'model-switch', agentId: ctx.agentId, modelId: activeModelId, previousModelId })
      }
      const authMode = effective.provider === 'openai' ? effective.openaiAuthMode : undefined
      let contextWindow = openAIContextWindow(effective.modelId, authMode)
      if (access.chatgptCredentials) {
        try {
          contextWindow = (await listChatGPTModels(false, signal)).find((model) => model.id === effective.modelId.replace(/^openai\//, ''))?.contextWindow ?? contextWindow
        } catch { throwIfAborted(signal) /* The fallback still leaves ample headroom. */ }
      }
      let browserContext: string | undefined
      const compaction = (effective.provider === 'openai' || (effective.provider === 'gateway' && effective.modelId.startsWith('openai/'))) ? new OpenAICompaction({
        modelId: effective.modelId,
        contextWindow,
        agentId: ctx.agentId, signal, emit,
        scope: `${effective.provider}:${authMode ?? 'api-key'}:${access.chatgptCredentials?.accountId ?? ''}`,
        serverSide: authMode === 'chatgpt',
        browserContext: () => browserContext,
      }) : undefined
      const resolvedModel = resolveModel(effective, access.chatgptCredentials, compaction?.wrapFetch.bind(compaction))
      // Main-agent requests can stall after tool completion too. Keep the
      // watchdog inside retry so intentional rate-limit waits are excluded.
      const model = withRateLimitRetry(withModelIdleTimeout(resolvedModel, undefined, { chatId: opts.chatId, agentId: ctx.agentId }), rateLimitHooks)
      const cacheBreakpoints = supportsAnthropicPromptCache(effective.provider, effective.modelId)
      const cache = cacheRequestOptions(
        effective.provider,
        effective.modelId,
        sandboxSessionId,
        effective.openaiAuthMode,
      )
      // xAI can't carry media in tool results; re-deliver screenshots as user
      // messages on request-time copies (see tool-result-media.ts).
      const inlineMedia = !supportsMediaToolResults(effective.provider, effective.modelId)
      const system = buildSystemMessages(
        buildSystemPrompt({
          isSubagent,
          allowedTabIds: ctx.allowedTabIds,
          offlineOnly: ctx.offlineOnly,
          task: opts.task,
          customInstructions: settings.customInstructions,
          typeSafe: !!typeSafe,
        }),
        cacheBreakpoints,
      )
      // Steps already completed on prior model attempts count toward the
      // checkpoint so a switch doesn't reset the "keep going?" prompt.
      const stepsBeforeAttempt = stepCount
      // Initial messages for this streamText call — capture for injection
      // coordinate math and onStepFinish snapshots.
      const attemptMessages = streamMessages

      streamErrorText = undefined

      debugLog.log('agent', 'runLoop start', {
        agentId: ctx.agentId,
        modelId: activeModelId,
        isSubagent,
        messageCount: attemptMessages.length,
        stepsBeforeAttempt,
      })

      // Ambient pointer: breathe on the agent's tabs while this attempt
      // streams. Tools pause it themselves via ToolOperationTracker.
      const endModelTurn = deps.cdp.beginModelTurn?.(signal)
      try {
        const result = streamText({
          model,
          // The request middleware owns admission and transport recovery.
          maxRetries: 0,
          system,
          messages: attemptMessages,
          tools,
          stopWhen: async ({ steps }) => {
            const totalSteps = stepsBeforeAttempt + steps.length
            if (totalSteps < stepLimit) return false
            if (!opts.onStepLimit || signal.aborted) return true
            debugLog.log('agent', 'step checkpoint', { agentId: ctx.agentId, steps: totalSteps })
            const keepGoing = await decideAtCheckpoint(totalSteps)
            if (!keepGoing) return true
            stepLimit += STEP_CHECKPOINT
            return false
          },
          abortSignal: signal,
          providerOptions: cache.providerOptions,
          headers: cache.headers,
          prepareStep: async ({ messages: stepMessages }) => {
            for (const raw of opts.steering?.take() ?? []) {
              const text = raw.trim()
              if (!text) continue
              injected.push({ index: stepMessages.length, message: { role: 'user', content: text } })
              emit({ type: 'steering', agentId: ctx.agentId, text })
              debugLog.log('agent', 'steering attached', { agentId: ctx.agentId })
            }
            // Mid-task model switch at a step boundary (after tool results /
            // completed output) — same timing as steering. Fold progress into
            // streamMessages and restart streamText on the new model.
            const next = resolveDesiredModelId(activeModelId, isSubagent, opts.getModelOverride?.())
            if (next !== activeModelId) {
              streamMessages = sanitizeModelMessages(
                injected.length > 0 ? withInjections(stepMessages, 0) : stepMessages,
              ) as ModelMessage[]
              fullConversation = canonicalHistory(streamMessages)
              injected.length = 0
              throw new AgentLoopRestartError()
            }
            let merged = injected.length > 0 ? withInjections(stepMessages, 0) : stepMessages
            const refreshRuntimeContext = async (history: ModelMessage[]) => {
              let tabs: ContextTab[] = []
              if (!ctx.offlineOnly) {
                try { tabs = await chrome.tabs.query({}) } catch { /* Explicit task URLs still route guides. */ }
              }
              const update = await runtimeContext.next(deps.vfs, history, tabs, {
                isSubagent, currentTabId: ctx.currentTabId, observedTabIds: [...observedTabIds],
                allowedTabIds: ctx.allowedTabIds, offlineOnly: ctx.offlineOnly, task: opts.task, chatId: opts.chatId,
                pendingTasks: !isSubagent && opts.chatId ? opts.tasks.list?.().filter((task) => task.chatId === opts.chatId) : [],
              })
              ctx.extensionRevisions = runtimeContext.extensionRevisions
              if (signal.aborted) throw signal.reason ?? new Error('Turn stopped')
              return update
            }
            // Deliver mutable state after tool results/steering, without rewriting
            // any earlier message or the cached system prefix. Persist it through
            // the same injection path used for steering and model restarts.
            try {
              const update = await refreshRuntimeContext(merged)
              if (update) {
                injected.push({ index: stepMessages.length, message: update })
                merged = withInjections(stepMessages, 0)
              }
            } catch (err) {
              if (signal.aborted) throw err
              debugLog.error('agent', 'runtime context', err)
            }
            const localSnapshotBudget = snapshotBudgetForModel(activeModelId)
            if (localSnapshotBudget !== undefined) {
              // Within one tool loop, every interaction appends a fresh page
              // snapshot. Older refs for that tab are already invalid, so
              // replaying all prior 6K snapshots only compounds local prefill
              // latency. Prune the request-time copy at each step, retaining
              // the newest exact snapshot and recoverable stubs. Persisted
              // history and hosted-model cache behavior remain unchanged.
              const stepPruned = pruneReplayedHistory(merged, {
                snapshotBudgetChars: localSnapshotBudget,
              })
              merged = stepPruned.messages
            }
            // Media inlining, local snapshot pruning, and cache breakpoints go
            // on per-step copies only;
            // `injected` keeps the clean originals that get merged into persisted
            // responseMessages.
            browserContext = latestBrowserSnapshotContext(merged)
            if (inlineMedia) merged = inlineMediaToolResults(merged)
            merged = compaction ? compaction.prepare(merged, async (message) => {
              injected.push({ index: stepMessages.length, message })
              // Standalone compaction resumes inference in this same fetch,
              // before prepareStep gets another chance to restore context.
              const update = await refreshRuntimeContext(withInjections(stepMessages, 0))
              if (update) injected.push({ index: stepMessages.length, message: update })
              fullConversation = canonicalHistory(sanitizeModelMessages(withInjections(stepMessages, 0)) as ModelMessage[])
              opts.onStepMessages?.(fullConversation)
              return update
            }) : withoutCompaction(merged)
            merged = runtimeContext.restoreExtensions(merged)
            merged = compressBrowserSnapshots(merged)
            if (cacheBreakpoints) return { messages: withCacheBreakpoints(merged) }
            return merged !== stepMessages ? { messages: merged } : undefined
          },
          onStepFinish: (step) => {
            compaction?.observeUsage(toUsage(step.usage) ?? {})
            const compacted = compaction?.takeCheckpoint()
            if (compacted) {
              const responses = step.response.messages as ModelMessage[]
              // Compaction covers response output, but tools execute locally.
              // Replay the trailing tool results after the canonical window.
              let end = responses.length
              while (end > 0 && responses[end - 1]!.role === 'tool') end--
              injected.push({ index: attemptMessages.length + end, message: compacted })
            }
            try {
              // step.response.messages is cumulative across this streamText
              // attempt's steps; re-splice steering injections so the snapshot
              // is the exact conversation a resumed run / model restart should
              // continue from.
              const snapshot = withInjections(
                [...attemptMessages, ...(step.response.messages as ModelMessage[])],
                0,
              )
              fullConversation = canonicalHistory(sanitizeModelMessages(snapshot) as ModelMessage[])
              opts.onStepMessages?.(fullConversation)
            } catch (err) {
              debugLog.error('agent', 'onStepMessages', err)
            }
          },
          onError: ({ error }) => {
            if (isAgentLoopRestart(error)) return
            debugLog.error('agent', 'streamText onError', error)
          },
        })

        // Start timestamps for duration labels: tool execution (keyed by
        // toolCallId, set when args are complete) and reasoning (keyed by part id).
        const startTimes = new Map<string, number>()
        // Per-tool-call count of streamed input deltas. Providers differ: Anthropic
        // streams args token-by-token; xAI ships them in one chunk (count 0/1), so
        // this line in the debug log answers "why didn't the input stream live".
        const inputDeltaCounts = new Map<string, number>()
        const elapsed = (key: string): number => {
          const start = startTimes.get(key)
          startTimes.delete(key)
          return start === undefined ? 0 : Date.now() - start
        }
        // Steps completed in this streamText attempt only.
        let attemptSteps = 0

        // Text-generation throughput, measured strictly on the visible answer:
        // the window runs from the first to the last text delta of a step, so
        // it excludes queueing, time-to-first-token, reasoning, and tool
        // execution. Steps that also called tools are skipped entirely —
        // providers report text tokens as (output - reasoning), which folds
        // tool-argument tokens in and would inflate the rate.
        let textFirstMs: number | undefined
        let textLastMs: number | undefined
        let textChars = 0
        let stepCalledTools = false

        // Text/reasoning part ids are only unique per response for providers on
        // the Responses API. The OpenAI chat-completions transport hardcodes
        // `id: "0"` for every text part, so an openai-compatible server would
        // reuse it on every step of every turn — and the transcript reducer keys
        // items by id, which made later answers append to the first one. Scope
        // every part id to the step that produced it.
        let partScope = crypto.randomUUID()
        const scopedId = (id: string): string => `${partScope}:${id}`

        // With parallel tool calls the SDK only ends a step once every tool
        // execute() has settled; a tool that doesn't observe the abort signal
        // would keep this loop (and the whole turn) hanging after the user's
        // Stop, so the turn's finally/cleanup never runs and queued steering
        // strands. Race each chunk against abort so Stop always ends the turn.
        const streamIterator = result.fullStream[Symbol.asyncIterator]()
        const streamAborted = new Promise<{ done: true; value?: undefined }>((resolve) => {
          const onAbort = (): void => resolve({ done: true })
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        })
        while (true) {
          const nextChunk = streamIterator.next()
          // If abort wins the race, the abandoned next() must not surface as
          // an unhandled rejection when the stream errors afterwards.
          nextChunk.catch(() => {})
          const chunk = await Promise.race([nextChunk, streamAborted])
          if (chunk.done) break
          const part = chunk.value
          // Parsed-stream tap: correlate raw SSE against what the SDK handed us
          // (the fastest way to spot a provider changing its stream shape).
          if (__DEV_BUILD__ && tapEnabled()) {
            publishTap({ kind: 'part', label: part.type, text: summarizeTapPart(part) })
          }
          switch (part.type) {
            case 'text-start':
              emit({ type: 'text-start', agentId: ctx.agentId, id: scopedId(part.id), at: Date.now() })
              break
            case 'text-delta': {
              const now = Date.now()
              textFirstMs ??= now
              textLastMs = now
              textChars += part.text.length
              emit({ type: 'text-delta', agentId: ctx.agentId, id: scopedId(part.id), delta: part.text })
              break
            }
            case 'text-end':
              emit({ type: 'text-end', agentId: ctx.agentId, id: scopedId(part.id) })
              break

            case 'reasoning-start':
              startTimes.set(scopedId(part.id), Date.now())
              emit({ type: 'reasoning-start', agentId: ctx.agentId, id: scopedId(part.id) })
              break
            case 'reasoning-delta':
              emit({ type: 'reasoning-delta', agentId: ctx.agentId, id: scopedId(part.id), delta: part.text })
              break
            case 'reasoning-end':
              emit({
                type: 'reasoning-end',
                agentId: ctx.agentId,
                id: scopedId(part.id),
                durationMs: elapsed(scopedId(part.id)),
              })
              break

            case 'tool-input-start':
              stepCalledTools = true
              // `id` here IS the toolCallId (per ai-sdk-v6 doc).
              emit({
                type: 'tool-input-start',
                agentId: ctx.agentId,
                toolCallId: part.id,
                toolName: part.toolName,
              })
              break
            case 'tool-input-delta':
              inputDeltaCounts.set(part.id, (inputDeltaCounts.get(part.id) ?? 0) + 1)
              emit({
                type: 'tool-input-delta',
                agentId: ctx.agentId,
                toolCallId: part.id,
                delta: part.delta,
              })
              break
            case 'tool-input-end':
              // No corresponding AgentEvent; the tool-call part carries the parsed input.
              break

            case 'tool-call': {
              stepCalledTools = true
              startTimes.set(part.toolCallId, Date.now())
              const input = part.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : undefined
              const target = part.toolName === 'browser_click' && typeof input?.ref === 'string'
                ? deps.cdp.describeRef?.(typeof input.tabId === 'number' ? input.tabId : ctx.currentTabId, input.ref)
                : undefined
              // UI-only enrichment: leave the tool's real arguments and model history untouched.
              emit({
                type: 'tool-call',
                agentId: ctx.agentId,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: target ? { ...input, __target: target } : part.input,
              })
              debugLog.log('agent', 'tool-call', {
                agentId: ctx.agentId,
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                inputDeltas: inputDeltaCounts.get(part.toolCallId) ?? 0,
              })
              inputDeltaCounts.delete(part.toolCallId)
              break
            }
            case 'tool-result': {
              const error = toolResultError(part.output)
              emit({
                type: 'tool-result',
                agentId: ctx.agentId,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: part.output,
                durationMs: elapsed(part.toolCallId),
                isError: !!error,
              })
              debugLog.log('agent', 'tool-result', {
                agentId: ctx.agentId,
                toolName: part.toolName,
                toolCallId: part.toolCallId,
              })
              break
            }
            case 'tool-error':
              emit({
                type: 'tool-result',
                agentId: ctx.agentId,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: formatError(part.error),
                durationMs: elapsed(part.toolCallId),
                isError: true,
              })
              debugLog.error('agent', `tool-error ${part.toolName}`, part.error)
              break

            case 'start':
              break
            case 'start-step':
              textFirstMs = undefined
              textLastMs = undefined
              textChars = 0
              stepCalledTools = false
              partScope = crypto.randomUUID()
              break
            case 'finish-step': {
              attemptSteps += 1
              stepCount = stepsBeforeAttempt + attemptSteps
              // Tokens/sec for the answer text alone.
              const textTokens = part.usage?.outputTokenDetails?.textTokens
              const textMs =
                textFirstMs !== undefined && textLastMs !== undefined ? textLastMs - textFirstMs : 0
              if (!stepCalledTools && textTokens && textMs >= MIN_THROUGHPUT_SAMPLE_MS) {
                debugLog.log('agent', 'text throughput', {
                  agentId: ctx.agentId,
                  modelId: activeModelId,
                  textTokens,
                  ms: textMs,
                  tps: Math.round((textTokens / textMs) * 1000 * 10) / 10,
                  charsPerSec: Math.round((textChars / textMs) * 1000),
                })
              }
              emit({
                type: 'usage-update',
                agentId: ctx.agentId,
                modelId: activeModelId,
                usage: toUsage(part.usage) ?? {},
              })
              break
            }
            case 'finish':
              debugLog.log('agent', 'finish', {
                agentId: ctx.agentId,
                finishReason: part.finishReason,
              })
              break

            case 'abort':
              debugLog.log('agent', 'abort', { agentId: ctx.agentId, reason: part.reason })
              break
            case 'error':
              if (isAgentLoopRestart(part.error)) {
                // Surfaces as a stream error part when thrown from prepareStep
                // / rate-limit middleware inside the stream. Restart outside.
                throw part.error
              }
              emittedError = true
              streamErrorText ??= formatError(part.error)
              emit({
                type: 'agent-error',
                agentId: ctx.agentId,
                error: formatError(part.error),
              })
              debugLog.error('agent', 'stream error part', part.error)
              throw part.error

            // source / file / raw / tool-output-denied / tool-approval-request: ignore for our UI.
            default:
              break
          }
        }

        if (signal.aborted) {
          // The post-stream promises below may never settle once the run aborted;
          // don't hang the turn on them. Not an error either — a user stop is
          // settled visually by the UI, not by an error row.
          throw new DOMException('Aborted', 'AbortError')
        }

        const response = await result.response
        const text = await result.text
        const totalUsage = await result.totalUsage
        const finishReason = await result.finishReason

        finalText = text
        finalUsage = toUsage(totalUsage)
        finalFinishReason = finishReason

        const attemptResponse =
          injected.length > 0
            ? withInjections(response.messages as ModelMessage[], attemptMessages.length)
            : (response.messages as ModelMessage[])
        fullConversation = canonicalHistory(sanitizeModelMessages([...attemptMessages, ...attemptResponse]) as ModelMessage[])

        break // stream completed successfully
      } catch (err) {
        if (isAgentLoopRestart(err) && !signal.aborted) {
          // Prefer the last completed-step snapshot; if we were rate-limited
          // before any generation this step, fullConversation/streamMessages
          // are already correct (no partial output to drop).
          if (fullConversation !== streamMessages && fullConversation.length >= streamMessages.length) {
            streamMessages = fullConversation
          }
          injected.length = 0
          // A provider switch can abandon a prepared request before its first
          // completed step. Rehydrate only what survived into replay history.
          runtimeContext = new RuntimeContextDelivery(streamMessages, typeSafe)
          debugLog.log('agent', 'restarting loop after session setting change', {
            agentId: ctx.agentId,
            messageCount: streamMessages.length,
            steps: stepCount,
          })
          continue
        }
        throw err
      } finally {
        endModelTurn?.()
      }
    }



    emit({
      type: 'agent-finish',
      agentId: ctx.agentId,
      text: finalText,
      usage: finalUsage,
      finishReason: finalFinishReason,
    })

    debugLog.log('agent', 'runLoop done', {
      agentId: ctx.agentId,
      finishReason: finalFinishReason,
      steps: stepCount,
      messages: fullConversation.length,
    })

    return {
      responseMessages: sanitizeModelMessages(fullConversation.slice(originalRequest.length)),
      text: finalText,
      usage: finalUsage,
      finishReason: finalFinishReason,
      stepCount,
      errorText: streamErrorText,
    }
  } catch (err) {
    const message = formatError(err)
    // An abort is a user stop, not a failure: no agent-error row (the UI
    // settles streaming/running indicators itself when Stop is clicked).
    if (!emittedError && !signal.aborted) emit({ type: 'agent-error', agentId: ctx.agentId, error: message })
    debugLog.error('agent', `runLoop failed (${ctx.agentId})`, err)
    throw err
  } finally {
    endActivity?.()
    // streamText may reject as soon as its AbortSignal fires. Tool execution
    // is independent async work, so terminal cancellation must explicitly
    // join it before the caller/task registry announces completion.
    await operationTracker.settle()
    // A main run that errored/aborted mid-wait must not keep subagents gated.
    if (!isSubagent) opts.priority?.clearWaiting(runKey)
    if (isSubagent) {
      try {
        await opts.tabGroups?.finishAgent(ctx.agentId)
      } catch (err) {
        debugLog.error('agent', 'tab group finishAgent', err)
      }
    }
  }
}

/** Query the active tab id; falls back to 0 if none can be determined. */
export async function getActiveTabId(): Promise<number> {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (active?.id !== undefined) return active.id
    const [any] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (any?.id !== undefined) return any.id
  } catch (err) {
    debugLog.error('agent', 'getActiveTabId', err)
  }
  return 0
}
