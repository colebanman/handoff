/**
 * Dynamic workflow coordinator.
 *
 * A workflow is model-authored JavaScript evaluated in the existing manifest
 * sandbox with a workflow-only RPC dispatcher. The script may fan out and
 * chain normal tab-scoped subagents, but it cannot reach browser/filesystem
 * APIs directly and cannot create more than MAX_WORKFLOW_AGENTS children.
 */
import type {
  AgentEvent,
  SandboxService,
  Usage,
  VirtualFileSystemService,
  WorkflowAgentSnapshot,
  WorkflowMeta,
  WorkflowPhaseDefinition,
  WorkflowRunSnapshot,
} from '../shared/types'
import type { JsonValue } from '../shared/rpc'
import { WORKFLOW_MAX_WALL_TIMEOUT_MS } from '../shared/rpc'
import { uid } from '../shared/ids'
import { debugLog } from '../shared/debug-log'
import { formatError } from '../shared/errors'
import type { RunWorkflowFn, SpawnSubagentFn, WorkflowRunInput } from './tools'
import type { TaskRegistry } from './tasks'

export const MAX_WORKFLOW_AGENTS = 10
const SOURCE_HEADER = '// handoff-workflow: '
const WORKFLOW_SCRIPT_TIMEOUT_MS = 60_000

interface WorkflowDeps {
  chatId: string
  emit: (event: AgentEvent) => void
  sandbox: SandboxService
  vfs: VirtualFileSystemService
  tasks: TaskRegistry
  spawnSubagent: SpawnSubagentFn
  parentSignal: AbortSignal
}

interface WorkflowSource {
  meta: WorkflowMeta
  script: string
  sourcePath: string
}

interface WorkflowAgentRequest {
  prompt?: unknown
  label?: unknown
  tabIds?: unknown
  keepTabs?: unknown
  phaseId?: unknown
  batchId?: unknown
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'workflow'
}

function validatePhases(phases: WorkflowPhaseDefinition[] | undefined): WorkflowPhaseDefinition[] | undefined {
  if (!phases) return undefined
  const seen = new Set<string>()
  return phases.map((phase) => {
    const id = phase.id.trim()
    const title = phase.title.trim()
    if (!id || !title) throw new Error('workflow phases require non-empty id and title values')
    if (seen.has(id)) throw new Error(`duplicate workflow phase id ${JSON.stringify(id)}`)
    seen.add(id)
    return { id, title, description: phase.description?.trim() || undefined }
  })
}

function parseHeader(text: string): { meta: WorkflowMeta; script: string } {
  const newline = text.indexOf('\n')
  const first = newline >= 0 ? text.slice(0, newline).trim() : text.trim()
  if (!first.startsWith(SOURCE_HEADER)) {
    throw new Error(`workflow file must start with ${JSON.stringify(SOURCE_HEADER + '{...}')}`)
  }
  const raw = JSON.parse(first.slice(SOURCE_HEADER.length)) as Partial<WorkflowMeta>
  if (typeof raw.title !== 'string' || !raw.title.trim()) throw new Error('workflow file metadata is missing title')
  if (typeof raw.description !== 'string' || !raw.description.trim()) {
    throw new Error('workflow file metadata is missing description')
  }
  return {
    meta: {
      title: raw.title.trim(),
      description: raw.description.trim(),
      phases: validatePhases(raw.phases),
    },
    script: newline >= 0 ? text.slice(newline + 1) : '',
  }
}

async function resolveSource(input: WorkflowRunInput, vfs: VirtualFileSystemService, runId: string): Promise<WorkflowSource> {
  const hasScript = typeof input.script === 'string'
  const hasPath = typeof input.scriptPath === 'string' && input.scriptPath.trim().length > 0
  if (hasScript === hasPath) throw new Error('provide exactly one of script or scriptPath')

  if (hasPath) {
    const sourcePath = input.scriptPath!.trim()
    if (!sourcePath.startsWith('/workspace/')) throw new Error('workflow scriptPath must be under /workspace')
    const read = await vfs.readText(sourcePath, { maxChars: 1_000_000 })
    if (read.truncated) throw new Error('workflow source exceeds the 1,000,000-character limit')
    const parsed = parseHeader(read.text)
    if (!parsed.script.trim()) throw new Error('workflow script is empty')
    return { ...parsed, sourcePath }
  }

  const title = input.title?.trim()
  const description = input.description?.trim()
  const script = input.script ?? ''
  if (!title) throw new Error('workflow title is required for an inline script')
  if (!description) throw new Error('workflow description is required for an inline script')
  if (!script.trim()) throw new Error('workflow script is empty')
  const meta: WorkflowMeta = { title, description, phases: validatePhases(input.phases) }
  const sourcePath = `/workspace/workflows/${slugify(title)}-${runId}.js`
  const persisted = `${SOURCE_HEADER}${JSON.stringify(meta)}\n${script}`
  await vfs.writeText(sourcePath, persisted, { mediaType: 'text/javascript' })
  return { meta, script, sourcePath }
}

function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  }
}

function workflowPrelude(args: JsonValue | undefined): string {
  const encodedArgs = JSON.stringify(args ?? null).replace(/</g, '\\u003c')
  return `
const args = ${encodedArgs};
let __workflowPhase;
let __workflowBatch;
let __workflowBatchSeq = 0;
let __workflowSignals = [];
const __flushWorkflowSignals = async () => {
  const pending = __workflowSignals;
  __workflowSignals = [];
  if (pending.length) await Promise.allSettled(pending);
};
const phase = (id) => {
  if (typeof id !== 'string' || !id.trim()) throw new Error('phase(id) requires a non-empty string');
  __workflowPhase = id.trim();
  __workflowSignals.push(api.workflow.phase(__workflowPhase));
};
const log = (message) => { __workflowSignals.push(api.workflow.log(String(message))); };
const agent = async (prompt, options = {}) => {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('agent(prompt) requires a non-empty string');
  await __flushWorkflowSignals();
  const request = { prompt };
  if (options.label !== undefined) request.label = options.label;
  if (options.tabIds !== undefined) request.tabIds = options.tabIds;
  if (options.keepTabs !== undefined) request.keepTabs = options.keepTabs;
  if (__workflowPhase !== undefined) request.phaseId = __workflowPhase;
  if (__workflowBatch !== undefined) request.batchId = __workflowBatch;
  return await api.workflow.agent(request);
};
const parallel = async (tasks) => {
  if (!Array.isArray(tasks) || tasks.some((task) => typeof task !== 'function')) {
    throw new Error('parallel() expects an array of zero-argument functions');
  }
  const previous = __workflowBatch;
  __workflowBatch = 'batch-' + (++__workflowBatchSeq);
  try { return await Promise.all(tasks.map((task) => task())); }
  finally { __workflowBatch = previous; }
};
const pipeline = async (items, mapper) => {
  if (!Array.isArray(items) || typeof mapper !== 'function') {
    throw new Error('pipeline(items, mapper) expects an array and function');
  }
  return await parallel(items.map((item, index) => () => mapper(item, items, index)));
};
`
}

/** Build the exact restricted JavaScript body sent to the sandbox. */
export function buildWorkflowCode(script: string, args?: JsonValue): string {
  return `${workflowPrelude(args)}
const __workflowResult = await (async () => {
${script}
})();
await __flushWorkflowSignals();
return __workflowResult;`
}

function displayResult(value: string | undefined): string {
  if (value === undefined) return '(workflow completed with no return value)'
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)
  } catch {
    return value
  }
}

/** Build the per-turn workflow runner used by workflow_run. */
export function makeRunWorkflow(deps: WorkflowDeps): RunWorkflowFn {
  return async (input: WorkflowRunInput): Promise<string> => {
    const runId = `wf-${uid('w')}`
    let source: WorkflowSource
    try {
      source = await resolveSource(input, deps.vfs, runId)
    } catch (err) {
      return `Error: could not prepare workflow — ${formatError(err)}`
    }

    const snapshot: WorkflowRunSnapshot = {
      runId,
      meta: source.meta,
      sourcePath: source.sourcePath,
      status: 'running',
      startedAt: Date.now(),
      logs: [],
      agents: [],
      usage: {},
    }
    deps.emit({ type: 'workflow-start', toolCallId: input.parentToolCallId, workflow: snapshot })

    const execute = async (signal: AbortSignal, taskId?: string): Promise<string> => {
      let launched = 0
      const agentByCallId = new Map<string, WorkflowAgentSnapshot>()

      const publishTaskProgress = (): void => {
        if (!taskId) return
        deps.tasks.update(taskId, {
          workflowProgress: {
            totalAgents: snapshot.agents.length,
            completedAgents: snapshot.agents.filter((agent) => agent.status !== 'running').length,
            totalTokens: snapshot.usage.totalTokens ?? 0,
            currentPhaseId: snapshot.currentPhaseId,
          },
        })
      }

      const dispatch = async (path: string, rpcArgs: JsonValue[]): Promise<JsonValue> => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (path === 'workflow.phase') {
          const phaseId = typeof rpcArgs[0] === 'string' ? rpcArgs[0].trim() : ''
          if (!phaseId) throw new Error('phase id must be a non-empty string')
          snapshot.currentPhaseId = phaseId
          deps.emit({ type: 'workflow-phase', toolCallId: input.parentToolCallId, runId, phaseId })
          publishTaskProgress()
          return null
        }
        if (path === 'workflow.log') {
          const message = String(rpcArgs[0] ?? '').trim()
          if (message) {
            const at = Date.now()
            snapshot.logs.push({ at, message })
            deps.emit({ type: 'workflow-log', toolCallId: input.parentToolCallId, runId, at, message })
          }
          return null
        }
        if (path !== 'workflow.agent') throw new Error(`workflow scripts cannot call api.${path}`)

        if (launched >= MAX_WORKFLOW_AGENTS) {
          throw new Error(`workflow agent limit exceeded: at most ${MAX_WORKFLOW_AGENTS} agents may be started`)
        }
        const request = (rpcArgs[0] ?? {}) as WorkflowAgentRequest
        const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
        if (!prompt) throw new Error('agent prompt must be a non-empty string')
        const tabIds = Array.isArray(request.tabIds)
          ? request.tabIds.map(Number).filter((id) => Number.isInteger(id))
          : []
        const callId = `call-${uid('wc')}`
        const labelRaw = typeof request.label === 'string' ? request.label.trim() : ''
        const label = labelRaw || prompt.split('\n')[0]!.slice(0, 80) || `Agent ${launched + 1}`
        const agent: WorkflowAgentSnapshot = {
          callId,
          label,
          prompt,
          phaseId: typeof request.phaseId === 'string' ? request.phaseId : snapshot.currentPhaseId,
          batchId: typeof request.batchId === 'string' ? request.batchId : undefined,
          status: 'running',
          startedAt: Date.now(),
          items: [],
        }
        launched += 1
        snapshot.agents.push(agent)
        agentByCallId.set(callId, agent)
        deps.emit({ type: 'workflow-agent-register', toolCallId: input.parentToolCallId, runId, agent })
        publishTaskProgress()

        let incrementalUsage: Usage = {}
        const onEvent = (event: AgentEvent): void => {
          if (event.type === 'agent-start' && event.workflowCallId === callId) agent.agentId = event.agentId
          if (event.type === 'usage-update' && event.agentId === agent.agentId) {
            incrementalUsage = addUsage(incrementalUsage, event.usage)
            agent.usage = incrementalUsage
          }
          if (event.type === 'agent-finish' && event.agentId === agent.agentId) {
            agent.usage = event.usage ?? incrementalUsage
            agent.status = 'done'
            agent.result = event.text
            agent.endedAt = Date.now()
          }
          if (event.type === 'agent-error' && event.agentId === agent.agentId) {
            agent.status = 'error'
            agent.error = event.error
          }
          deps.emit(event)
        }

        try {
          const result = await deps.spawnSubagent({
            task: prompt,
            tabIds,
            keepTabs: request.keepTabs === true,
            parentToolCallId: input.parentToolCallId,
            workflowRunId: runId,
            workflowCallId: callId,
            onEvent,
            signal,
          })
          if (result.startsWith('Error: subagent failed')) {
            agent.status = signal.aborted ? 'cancelled' : 'error'
            agent.error = result
            agent.endedAt = Date.now()
            snapshot.usage = snapshot.agents.reduce((total, child) => addUsage(total, child.usage), {})
            publishTaskProgress()
            return null
          }
          agent.status = 'done'
          agent.result = result
          agent.endedAt ??= Date.now()
          snapshot.usage = snapshot.agents.reduce((total, child) => addUsage(total, child.usage), {})
          publishTaskProgress()
          return result
        } catch (err) {
          agent.status = signal.aborted ? 'cancelled' : 'error'
          agent.error = formatError(err)
          agent.endedAt = Date.now()
          snapshot.usage = snapshot.agents.reduce((total, child) => addUsage(total, child.usage), {})
          publishTaskProgress()
          return null
        }
      }

      const code = buildWorkflowCode(source.script, input.args)
      const sandboxResult = await deps.sandbox.exec({
        code,
        sessionId: `workflow-${runId}`,
        timeoutMs: WORKFLOW_SCRIPT_TIMEOUT_MS,
        wallTimeoutMs: WORKFLOW_MAX_WALL_TIMEOUT_MS,
        dispatch,
        signal,
      })
      snapshot.usage = snapshot.agents.reduce((total, child) => addUsage(total, child.usage), {})
      snapshot.endedAt = Date.now()

      if (signal.aborted) {
        snapshot.status = 'cancelled'
        snapshot.error = 'Cancelled by user.'
      } else if (!sandboxResult.ok) {
        snapshot.status = 'error'
        snapshot.error = sandboxResult.error ?? 'workflow execution failed'
      } else {
        snapshot.status = 'done'
        snapshot.result = displayResult(sandboxResult.value)
      }
      deps.emit({
        type: 'workflow-finish',
        toolCallId: input.parentToolCallId,
        runId,
        status: snapshot.status === 'done' ? 'done' : snapshot.status === 'cancelled' ? 'cancelled' : 'error',
        result: snapshot.result,
        error: snapshot.error,
        endedAt: snapshot.endedAt,
      })

      const report = snapshot.status === 'done'
        ? `Workflow completed: ${source.meta.title}\nResult:\n${snapshot.result}`
        : `Error: workflow ${snapshot.status} — ${snapshot.error}`
      if (taskId) {
        const taskStatus = snapshot.status === 'done' ? 'done' : snapshot.status === 'cancelled' ? 'cancelled' : 'error'
        deps.tasks.finish(taskId, taskStatus, report)
      }
      debugLog.log('agent', 'workflow finished', {
        runId,
        status: snapshot.status,
        agents: snapshot.agents.length,
        tokens: snapshot.usage.totalTokens,
      })
      return `${report}\nSource: ${source.sourcePath}`
    }

    if (input.background) {
      const taskId = `task-${uid('t')}`
      const task = {
        id: taskId,
        kind: 'workflow' as const,
        description: source.meta.title,
        status: 'running' as const,
        agentId: `workflow-${runId}`,
        chatId: deps.chatId,
        startedAt: snapshot.startedAt,
        workflowRunId: runId,
        workflowProgress: { totalAgents: 0, completedAgents: 0, totalTokens: 0 },
      }
      const controller = deps.tasks.register(task)
      void execute(controller.signal, taskId).catch((err) => {
        if (controller.signal.aborted) {
          deps.tasks.finish(taskId, 'cancelled', 'Error: workflow cancelled — Cancelled by user.')
          return
        }
        deps.tasks.finish(taskId, 'error', `Error: workflow failed — ${formatError(err)}`)
      })
      return `Started background workflow ${taskId} (${source.meta.title}). Wait with task_wait or inspect with task_status.\nSource: ${source.sourcePath}`
    }

    return execute(deps.parentSignal)
  }
}
