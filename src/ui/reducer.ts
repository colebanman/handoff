/**
 * Pure reducer: fold AgentEvents into a growing TranscriptItem[] for the UI.
 *
 * Rules:
 *  - Monotonic forward progress: items are only appended or updated in place,
 *    never removed or reordered.
 *  - Tool rows are upserted by toolCallId; running -> done morph updates the
 *    same row.
 *  - Reasoning / text deltas accumulate by id.
 *  - Subagent events (identified by agentId != 'main') are routed into the
 *    childItems of the spawning tool row. The spawning row is located by the
 *    parentToolCallId carried on the child's 'agent-start' event; thereafter the
 *    agentId -> parentToolCallId mapping is remembered so later child events land
 *    in the right place.
 *  - 'task-update' events set the childStatus of the spawning tool row.
 *
 * The reducer is a plain function on arrays; the store calls it for each event.
 * Nesting state (agentId -> parentToolCallId) is threaded through a small
 * companion structure returned alongside the items so it survives across calls
 * without a module-level singleton (keeps the reducer pure & testable).
 */
import type { AgentEvent, TranscriptItem, ToolStatus, AgentId, Usage, WorkflowAgentSnapshot } from '../shared/types'
import { uid } from '../shared/ids'
import { parsePartialJson } from '../shared/partial-json'
import { settleTranscriptScope } from '../shared/settle-transcript'

/** The main (top-level) agent id used by the agent core. */
export const MAIN_AGENT_ID: AgentId = 'main'

/**
 * Accumulate a streamed tool-input JSON fragment onto the running text.
 * Exported so callers/tests can reuse the exact concatenation behavior.
 */
export function accumulateToolInput(prev: string, delta: string): string {
  return prev + delta
}

/**
 * Parse the streamed tool-input JSON, tolerating a truncated (still-streaming)
 * tail. Called on every tool-input-delta so tool rows render their input live
 * — headers/payloads derive from the parsed `input`, and waiting for the final
 * tool-call event would leave them frozen while args stream.
 */
function tryParseInput(text: string): unknown {
  return parsePartialJson(text)
}

/**
 * Reducer-scoped nesting map: which tool row (by toolCallId) owns each child
 * agentId's items. Stored on a WeakMap keyed by the items array is fragile
 * across immutable updates, so instead we keep a Map that the store owns and
 * passes in. To keep applyEvent's signature simple (items, event) as the
 * contract requires, we stash the map on a non-enumerable symbol of the array.
 */
const NEST = Symbol('nestMap')

type NestMap = Map<AgentId, string> // agentId -> parentToolCallId

function getNestMap(items: TranscriptItem[]): NestMap {
  const holder = items as TranscriptItem[] & { [NEST]?: NestMap }
  let map = holder[NEST]
  if (!map) {
    map = new Map()
    Object.defineProperty(holder, NEST, { value: map, enumerable: false, configurable: true, writable: true })
  }
  return map
}

function carryNestMap(from: TranscriptItem[], to: TranscriptItem[]): TranscriptItem[] {
  const map = getNestMap(from)
  Object.defineProperty(to as TranscriptItem[] & { [NEST]?: NestMap }, NEST, {
    value: map,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return to
}

/**
 * Append an item while preserving the nesting map. Store code that extends a
 * live transcript outside applyEvent (e.g. appending the next user message
 * while background subagents are still running) must use this instead of a
 * bare spread — the map rides on a non-enumerable symbol, so a spread drops it
 * and the subagents' events would fall back to the top level.
 */
export function appendTranscriptItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  return carryNestMap(items, [...items, item])
}

/** Locate the tool row that owns a child agent's items. */
function findOwnerToolCallId(items: TranscriptItem[], agentId: AgentId): string | undefined {
  const map = getNestMap(items)
  const known = map.get(agentId)
  if (known) return known
  // The nest map rides on a symbol of the array and is lost whenever the
  // transcript crosses a turn/normalize/reload boundary (fresh arrays). A
  // background subagent can outlive the turn that spawned it, so rebuild the
  // mapping from the childAgentId persisted on its spawning row.
  for (const it of items) {
    if (it.kind === 'tool' && it.childAgentId === agentId) {
      map.set(agentId, it.id)
      return it.id
    }
    if (it.kind === 'tool' && it.workflow?.agents.some((agent) => agent.agentId === agentId)) {
      map.set(agentId, it.id)
      return it.id
    }
  }
  return undefined
}

/**
 * Resolve the spawning tool row's childStatus when a child agent ends. Only
 * flips rows still 'running' so a task-update (e.g. cancelled -> error) that
 * already landed is not overwritten.
 */
function setChildStatus(
  items: TranscriptItem[],
  agentId: AgentId,
  status: 'done' | 'error',
): TranscriptItem[] {
  if (agentId === MAIN_AGENT_ID) return items
  const owner = findOwnerToolCallId(items, agentId)
  if (!owner) return items
  const next = items.map((it) =>
    it.kind === 'tool' && it.id === owner && it.workflow
      ? {
          ...it,
          workflow: {
            ...it.workflow,
            agents: it.workflow.agents.map((agent) =>
              agent.agentId === agentId && agent.status === 'running'
                ? { ...agent, status, endedAt: Date.now() }
                : agent,
            ),
          },
        }
      : it.kind === 'tool' && it.id === owner && it.childStatus === 'running'
        ? { ...it, childStatus: status }
        : it,
  )
  return carryNestMap(items, next)
}

/**
 * Apply the update `fn` to the transcript that owns child `agentId`. If agentId
 * is the main agent, update the top-level list; otherwise recurse into the
 * childItems of the owning tool row.
 */
function applyToScope(
  items: TranscriptItem[],
  agentId: AgentId,
  fn: (scoped: TranscriptItem[]) => TranscriptItem[],
): TranscriptItem[] {
  if (agentId === MAIN_AGENT_ID) return carryNestMap(items, fn(items))

  const owner = findOwnerToolCallId(items, agentId)
  if (!owner) {
    // Unknown child scope (agent-start not yet seen): fall back to top-level so
    // nothing is lost. Should be rare.
    return carryNestMap(items, fn(items))
  }
  const next = items.map((it) => {
    if (it.kind === 'tool' && it.id === owner) {
      if (it.workflow) {
        return {
          ...it,
          workflow: {
            ...it.workflow,
            agents: it.workflow.agents.map((agent) =>
              agent.agentId === agentId ? { ...agent, items: fn(agent.items ?? []) } : agent,
            ),
          },
        }
      }
      const child = it.childItems ? [...it.childItems] : []
      return { ...it, childItems: fn(child) }
    }
    return it
  })
  return carryNestMap(items, next)
}

function addUsage(a: Usage | undefined, b: Usage): Usage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b.totalTokens ?? 0),
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  }
}

function updateWorkflowAgent(
  items: TranscriptItem[],
  agentId: AgentId,
  patch: (agent: WorkflowAgentSnapshot) => WorkflowAgentSnapshot,
): TranscriptItem[] {
  const owner = findOwnerToolCallId(items, agentId)
  if (!owner) return items
  const next = items.map((it) => {
    if (it.kind !== 'tool' || it.id !== owner || !it.workflow) return it
    const agents = it.workflow.agents.map((agent) => (agent.agentId === agentId ? patch(agent) : agent))
    const usage = agents.reduce<Usage>((total, agent) => addUsage(total, agent.usage ?? {}), {})
    return { ...it, workflow: { ...it.workflow, agents, usage } }
  })
  return carryNestMap(items, next)
}

/** Upsert a tool row (by toolCallId) inside a given scope array. */
function upsertTool(
  scope: TranscriptItem[],
  toolCallId: string,
  agentId: AgentId,
  patch: (prev: Extract<TranscriptItem, { kind: 'tool' }> | undefined) => Extract<TranscriptItem, { kind: 'tool' }>,
): TranscriptItem[] {
  const idx = scope.findIndex((it) => it.kind === 'tool' && it.id === toolCallId)
  if (idx === -1) {
    return [...scope, patch(undefined)]
  }
  const prev = scope[idx] as Extract<TranscriptItem, { kind: 'tool' }>
  const next = [...scope]
  next[idx] = patch(prev)
  return next
}

/** Accumulate a reasoning/text delta by id inside a scope. */
function accumStreamText(
  scope: TranscriptItem[],
  kind: 'reasoning' | 'text',
  id: string,
  agentId: AgentId,
  delta: string,
): TranscriptItem[] {
  const idx = scope.findIndex((it) => it.kind === kind && it.id === id)
  if (idx === -1) {
    const base: TranscriptItem =
      kind === 'reasoning'
        ? { kind: 'reasoning', id, agentId, text: delta, streaming: true }
        : { kind: 'text', id, agentId, text: delta, streaming: true }
    return [...scope, base]
  }
  const next = [...scope]
  const prev = next[idx]!
  if (prev.kind === 'reasoning' || prev.kind === 'text') {
    next[idx] = { ...prev, text: prev.text + delta }
  }
  return next
}

function endStreamText(scope: TranscriptItem[], kind: 'reasoning' | 'text', id: string, durationMs?: number): TranscriptItem[] {
  const idx = scope.findIndex((it) => it.kind === kind && it.id === id)
  if (idx === -1) return scope
  const next = [...scope]
  const prev = next[idx]!
  if (prev.kind === 'reasoning') {
    next[idx] = { ...prev, streaming: false, durationMs: durationMs ?? prev.durationMs }
  } else if (prev.kind === 'text') {
    next[idx] = { ...prev, streaming: false }
  }
  return next
}

/** Fold a single AgentEvent into the transcript, returning a new array. */
export function applyEvent(items: TranscriptItem[], e: AgentEvent): TranscriptItem[] {
  if (e.type === 'agent-start' || e.type === 'agent-finish' || e.type === 'agent-error') {
    items = applyToScope(items, e.agentId, (scope) => scope.map((item) =>
      item.kind === 'compaction' && item.status === 'running' ? { ...item, status: 'cancelled' } : item))
  }
  switch (e.type) {
    case 'agent-start': {
      // Remember which tool row owns this child agent's items.
      if (e.parentToolCallId) {
        getNestMap(items).set(e.agentId, e.parentToolCallId)
        if (e.workflowRunId && e.workflowCallId) {
          const next = items.map((it) => {
            if (it.kind !== 'tool' || it.id !== e.parentToolCallId || it.workflow?.runId !== e.workflowRunId) return it
            const workflow = it.workflow!
            return {
              ...it,
              workflow: {
                ...workflow,
                agents: workflow.agents.map((agent) =>
                  agent.callId === e.workflowCallId ? { ...agent, agentId: e.agentId, status: 'running' as const } : agent,
                ),
              },
            }
          })
          return carryNestMap(items, next)
        }
        // Seed the childAgentId / childStatus on the spawning tool row.
        const next = items.map((it) => {
          if (it.kind === 'tool' && it.id === e.parentToolCallId) {
            return { ...it, childAgentId: e.agentId, childStatus: it.childStatus ?? ('running' as const) }
          }
          return it
        })
        return carryNestMap(items, next)
      }
      return items
    }

    case 'usage-update': {
      return updateWorkflowAgent(items, e.agentId, (agent) => ({ ...agent, usage: addUsage(agent.usage, e.usage) }))
    }

    case 'compaction': {
      return applyToScope(items, e.agentId, (scope) => {
        const item: TranscriptItem = { kind: 'compaction', id: e.id, agentId: e.agentId, status: e.status }
        return scope.some((previous) => previous.id === e.id)
          ? scope.map((previous) => previous.id === e.id ? item : previous)
          : [...scope, item]
      })
    }

    case 'workflow-start': {
      const next = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId ? { ...it, workflow: { ...e.workflow, agents: [], logs: [] } } : it,
      )
      return carryNestMap(items, next)
    }

    case 'workflow-phase': {
      const next = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId && it.workflow?.runId === e.runId
          ? { ...it, workflow: { ...it.workflow, currentPhaseId: e.phaseId } }
          : it,
      )
      return carryNestMap(items, next)
    }

    case 'workflow-log': {
      const next = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId && it.workflow?.runId === e.runId
          ? { ...it, workflow: { ...it.workflow, logs: [...it.workflow.logs, { at: e.at, message: e.message }] } }
          : it,
      )
      return carryNestMap(items, next)
    }

    case 'workflow-agent-register': {
      const next = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId && it.workflow?.runId === e.runId
          ? { ...it, workflow: { ...it.workflow, agents: [...it.workflow.agents, { ...e.agent, items: [] }] } }
          : it,
      )
      return carryNestMap(items, next)
    }

    case 'workflow-finish': {
      const next = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId && it.workflow?.runId === e.runId
          ? {
              ...it,
              workflow: {
                ...it.workflow,
                status: e.status,
                result: e.result,
                error: e.error,
                endedAt: e.endedAt,
              },
            }
          : it,
      )
      return carryNestMap(items, next)
    }

    case 'reasoning-start': {
      return applyToScope(items, e.agentId, (scope) => {
        const exists = scope.some((it) => it.kind === 'reasoning' && it.id === e.id)
        if (exists) return scope
        return [...scope, { kind: 'reasoning', id: e.id, agentId: e.agentId, text: '', streaming: true }]
      })
    }
    case 'reasoning-delta': {
      return applyToScope(items, e.agentId, (scope) => accumStreamText(scope, 'reasoning', e.id, e.agentId, e.delta))
    }
    case 'reasoning-end': {
      return applyToScope(items, e.agentId, (scope) => endStreamText(scope, 'reasoning', e.id, e.durationMs))
    }

    case 'text-start': {
      return applyToScope(items, e.agentId, (scope) => {
        const exists = scope.some((it) => it.kind === 'text' && it.id === e.id)
        if (exists) return scope
        return [...scope, { kind: 'text', id: e.id, agentId: e.agentId, text: '', streaming: true, ...(e.at !== undefined ? { at: e.at } : {}) }]
      })
    }
    case 'text-delta': {
      return applyToScope(items, e.agentId, (scope) => accumStreamText(scope, 'text', e.id, e.agentId, e.delta))
    }
    case 'text-end': {
      return applyToScope(items, e.agentId, (scope) => endStreamText(scope, 'text', e.id))
    }

    case 'tool-input-start': {
      return applyToScope(items, e.agentId, (scope) =>
        upsertTool(scope, e.toolCallId, e.agentId, (prev) =>
          prev
            ? { ...prev, toolName: e.toolName }
            : {
                kind: 'tool',
                id: e.toolCallId,
                agentId: e.agentId,
                toolName: e.toolName,
                inputText: '',
                status: 'running',
                at: Date.now(),
              },
        ),
      )
    }
    case 'tool-input-delta': {
      return applyToScope(items, e.agentId, (scope) =>
        upsertTool(scope, e.toolCallId, e.agentId, (prev) => {
          const inputText = accumulateToolInput(prev?.inputText ?? '', e.delta)
          // Re-parsing the whole accumulated JSON on every delta is O(n²) and
          // stalls the UI on heavy args (inline file contents, big code
          // strings). Small inputs parse every delta so labels stay live;
          // large ones re-parse only after ~12.5% growth. The final tool-call
          // event always carries the exact parsed input.
          const parsedLen = prev?.inputParsedLength ?? 0
          const shouldParse =
            inputText.length < 1024 || inputText.length - parsedLen >= Math.max(1024, parsedLen >> 3)
          const input = shouldParse ? tryParseInput(inputText) ?? prev?.input : prev?.input
          const inputParsedLength = shouldParse ? inputText.length : parsedLen
          return prev
            ? { ...prev, inputText, input, inputParsedLength }
            : {
                kind: 'tool',
                id: e.toolCallId,
                agentId: e.agentId,
                toolName: '',
                inputText,
                input,
                inputParsedLength,
                status: 'running',
                at: Date.now(),
              }
        }),
      )
    }
    case 'tool-call': {
      return applyToScope(items, e.agentId, (scope) =>
        upsertTool(scope, e.toolCallId, e.agentId, (prev) => {
          const inputText = prev?.inputText || safeStringify(e.input)
          return {
            kind: 'tool',
            id: e.toolCallId,
            agentId: e.agentId,
            toolName: e.toolName,
            inputText,
            input: e.input,
            status: prev?.status === 'done' || prev?.status === 'error' ? prev.status : 'running',
            durationMs: prev?.durationMs,
            output: prev?.output,
            at: prev?.at ?? Date.now(),
            childAgentId: prev?.childAgentId,
            childItems: prev?.childItems,
            childStatus: prev?.childStatus,
            workflow: prev?.workflow,
          }
        }),
      )
    }
    case 'tool-result': {
      return applyToScope(items, e.agentId, (scope) =>
        upsertTool(scope, e.toolCallId, e.agentId, (prev) => {
          const status: ToolStatus = e.isError ? 'error' : 'done'
          return prev
            ? { ...prev, toolName: e.toolName || prev.toolName, output: e.output, status, durationMs: e.durationMs }
            : {
                kind: 'tool',
                id: e.toolCallId,
                agentId: e.agentId,
                toolName: e.toolName,
                inputText: '',
                output: e.output,
                status,
                durationMs: e.durationMs,
                at: Date.now(),
              }
        }),
      )
    }

    case 'steering': {
      // Steering attached mid-turn: shows as a fresh user message at the point
      // (step boundary) where the model actually received it. Inside a child
      // feed this is the main agent steering its subagent (subagent_message).
      return applyToScope(items, e.agentId, (scope) => [
        ...scope,
        { kind: 'user', id: uid('u'), text: e.text, at: Date.now(), steered: true },
      ])
    }

    case 'memory-saved': {
      // The model writes memory once, near the end of a turn, so this chip lands
      // beside the answer rather than mid-task. Quiet by design: it fires on
      // ordinary turns and is an affordance (open MEMORY.md), not an event.
      return applyToScope(items, e.agentId, (scope) =>
        appendTranscriptItem(scope, {
          kind: 'memory',
          id: uid('mem'),
          agentId: e.agentId,
          titles: e.titles,
          forgotten: e.forgotten,
          at: Date.now(),
          file: e.file,
        }),
      )
    }

    case 'agent-finish': {
      // Mark any still-streaming reasoning/text in this scope as complete.
      const marked = applyToScope(items, e.agentId, (scope) =>
        scope.map((it) => {
          if ((it.kind === 'reasoning' || it.kind === 'text') && it.streaming) {
            return { ...it, streaming: false }
          }
          return it
        }),
      )
      // A finished child agent resolves its spawning row's childStatus. Only
      // background subagents get task-update events, so sync ones end here.
      const withResult = updateWorkflowAgent(marked, e.agentId, (agent) => ({
        ...agent,
        status: agent.status === 'error' ? 'error' : 'done',
        result: e.text,
        usage: e.usage ?? agent.usage,
        endedAt: Date.now(),
      }))
      return setChildStatus(withResult, e.agentId, 'done')
    }

    case 'agent-error': {
      const appended = applyToScope(items, e.agentId, (scope) => {
        const settled = settleTranscriptScope(scope, e.error)
        if (settled.some((item) => item.kind === 'error' && item.message === e.error)) return settled
        return [...settled, { kind: 'error', id: uid('err'), agentId: e.agentId, message: e.error, at: Date.now() }]
      })
      const withError = updateWorkflowAgent(appended, e.agentId, (agent) => ({
        ...agent,
        status: 'error',
        error: e.error,
        endedAt: Date.now(),
      }))
      return setChildStatus(withError, e.agentId, 'error')
    }

    case 'task-update': {
      if (e.task.kind === 'workflow' && e.task.workflowRunId) {
        const status: import('../shared/types').WorkflowStatus =
          e.task.status === 'running' || e.task.status === 'cancelling'
            ? 'running'
            : e.task.status === 'done'
              ? 'done'
              : e.task.status === 'cancelled'
                ? 'cancelled'
                : e.task.status === 'orphaned'
                  ? 'orphaned'
                  : 'error'
        const next: TranscriptItem[] = items.map((it) => {
          if (it.kind !== 'tool' || it.workflow?.runId !== e.task.workflowRunId) return it
          const workflow = it.workflow!
          return {
            ...it,
            workflow: {
              ...workflow,
              status,
              endedAt: e.task.endedAt ?? workflow.endedAt,
              error: status === 'done' || status === 'running' ? workflow.error : e.task.result,
            },
          }
        })
        return carryNestMap(items, next)
      }
      // Route to the tool row whose child agentId matches this task's agentId.
      const owner = findOwnerToolCallId(items, e.task.agentId)
      const status: 'running' | 'done' | 'error' =
        e.task.status === 'done' ? 'done' : e.task.status === 'running' || e.task.status === 'cancelling' ? 'running' : 'error'
      const next = items.map((it) => {
        if (it.kind === 'tool' && (it.id === owner || it.childAgentId === e.task.agentId)) {
          let childItems = it.childItems ?? []
          if (status !== 'running') {
            childItems = settleTranscriptScope(childItems, e.task.result)
            // The task registry can report completion after the child's event
            // stream has disconnected. Its terminal reason must still reach
            // the detail view, without duplicating a delivered agent-error.
            if (e.task.status === 'error') {
              const message = e.task.result || 'Subagent failed without an error message.'
              if (!childItems.some((item) => item.kind === 'error' &&
                (item.message === message || message.startsWith(`${item.message}\n\nPartial output:`)))) {
                childItems = [...childItems, {
                  kind: 'error', id: `task-error:${e.task.id}:${e.task.endedAt ?? ''}`,
                  agentId: e.task.agentId, message, at: e.task.endedAt ?? Date.now(),
                }]
              }
            }
          }
          return { ...it, childAgentId: e.task.agentId, childStatus: status, childItems }
        }
        return it
      })
      return carryNestMap(items, next)
    }

    default: {
      // Exhaustiveness guard — unknown event kinds pass through unchanged.
      return items
    }
  }
}

function safeStringify(v: unknown): string {
  if (v === undefined) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}
