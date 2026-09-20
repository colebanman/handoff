/**
 * Task tray (Altitude 1): a collapsible list of live background subagent tasks,
 * docked between the feed and the composer. Appears only when
 * at least one background task exists for the current chat. Each row shows the
 * task's status, elapsed time, and last action, with Nudge/Cancel controls that
 * act on the shared TaskRegistry directly — no model turn is consumed.
 *
 * Nudge queues a steering message (delivered at the subagent's next step
 * boundary, exactly like `subagent_message`); Cancel stops the one subagent
 * without aborting the chat's turn. Orphaned tasks (whose host context died
 * mid-run) render honestly with their own status and a Nudge affordance to
 * revive them — they are never collapsed into a generic error.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentId, TaskInfo, TranscriptItem } from '../../shared/types'
import { Chevron, subagentTail } from './items'
import { isCompacting } from '../../shared/compaction'
import { surfaceLabels } from '../../shared/surfaces-label'
import { agentAccent } from '../../cdp/activity-cursor-renderer'

/** Finished/orphaned rows linger this long after ending, then vanish. */
const LINGER_MS = 30_000
/** Descriptions longer than this are truncated in the row label. */
const LABEL_MAX = 60

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function CheckMark(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
      <path d="M4.4 7.2 6.2 9 9.6 5.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CrossMark(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
      <path d="M4.8 4.8 9.2 9.2 M9.2 4.8 4.8 9.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Interrupted/resumable mark for orphaned tasks (a broken-loop circle arrow). */
function OrphanMark(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M11 7a4 4 0 1 1-1.2-2.85" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9.6 2.4 10 4.4 8 4.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export const TaskTray = memo(function TaskTray({
  tasks,
  transcript,
  onNudge,
  onCancel,
}: {
  /** Background tasks for the currently-viewed chat only (caller filters by chatId). */
  tasks: TaskInfo[]
  /** Current chat's top-level transcript, used to derive each task's last-action line. */
  transcript: TranscriptItem[]
  onNudge: (taskId: string, text: string) => void
  onCancel: (taskId: string) => void
}): React.ReactElement | null {
  const [, setTick] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [openNudgeId, setOpenNudgeId] = useState<string | undefined>()
  const prevRunningRef = useRef(0)

  const now = Date.now()
  const runningCount = tasks.filter((t) => t.status === 'running').length
  const cancellingCount = tasks.filter((t) => t.status === 'cancelling').length
  const activeCount = runningCount + cancellingCount

  // Agent color only appears once there is more than one agent to tell apart:
  // a single-agent run keeps the tray exactly as it looked before.
  const multiAgent = useMemo(
    () =>
      new Set(
        tasks.filter((t) => t.status === 'running' || t.status === 'cancelling').map((t) => t.agentId),
      ).size > 1,
    [tasks],
  )

  // Which rows are visible: all running, plus recently-finished/orphaned rows
  // still inside their linger window. Recomputes each render (incl. ticks), so
  // a lingering row drops out without needing a new task-update.
  const visible = useMemo(
    () => tasks.filter((t) => t.status === 'running' || t.status === 'cancelling' || now - (t.endedAt ?? 0) < LINGER_MS),
    [tasks, now],
  )

  // Derive each subagent/workflow's last-action line from its owning card.
  // (background subagents are always spawned by the main agent, so the owning
  // row is always in the top-level transcript).
  const lastActionByAgentId = useMemo(() => {
    const map: Record<AgentId, string> = {}
    for (const it of transcript) {
      if (it.kind === 'tool' && it.childAgentId) {
        map[it.childAgentId] = subagentTail(it.childItems ?? []).text
      }
    }
    return map
  }, [transcript])
  const lastActionByWorkflowId = useMemo(() => {
    const map: Record<string, string> = {}
    for (const it of transcript) {
      if (it.kind !== 'tool' || !it.workflow) continue
      const workflow = it.workflow
      const active = [...workflow.agents].reverse().find((agent) => agent.status === 'running')
      map[workflow.runId] =
        workflow.logs[workflow.logs.length - 1]?.message ??
        active?.label ??
        (workflow.status === 'done' ? 'Workflow complete' : workflow.status)
    }
    return map
  }, [transcript])

  // Tick while anything is running or a finished row is still lingering; stop
  // once nothing needs it. needsTick flips false when the last linger window
  // closes (recomputed on the previous tick's render), so the interval clears.
  const needsTick =
    activeCount > 0 || tasks.some((t) => t.status !== 'running' && t.status !== 'cancelling' && now - (t.endedAt ?? 0) < LINGER_MS)
  useEffect(() => {
    if (!needsTick) return
    const id = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [needsTick])

  // Auto-collapse when the running count drops to zero (all tasks finished).
  useEffect(() => {
    const prev = prevRunningRef.current
    if (prev > 0 && activeCount === 0) setCollapsed(true)
    prevRunningRef.current = activeCount
  }, [activeCount])

  if (visible.length === 0) return null

  const summary = cancellingCount > 0
    ? `${runningCount > 0 ? `${runningCount} running · ` : ''}${cancellingCount} stopping`
    : runningCount > 0
      ? `${runningCount} running`
      : visible.some((task) => task.status === 'error')
        ? `${visible.filter((task) => task.status === 'error').length} failed`
        : 'All done'

  return (
    <div className="task-tray" role="toolbar" aria-label="Background tasks">
      <div className="task-tray__header">
        <button
          className="task-tray__toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Show background tasks' : 'Hide background tasks'}
          aria-expanded={!collapsed}
        >
          <Chevron open={!collapsed} />
        </button>
        <span>{summary}</span>
      </div>

      {!collapsed
        ? visible.map((task) => {
            const running = task.status === 'running'
            const cancelling = task.status === 'cancelling'
            const active = running || cancelling
            const orphaned = task.status === 'orphaned'
            const compacting = task.agentId ? isCompacting(transcript, task.agentId) : false
            const canNudge = task.kind === 'subagent' && (running || orphaned) && !compacting
            const label =
              task.description.length > LABEL_MAX
                ? task.description.slice(0, LABEL_MAX) + '…'
                : task.description
            const action = cancelling
              ? 'Waiting for in-flight operation to settle…'
              : running
              ? task.kind === 'workflow'
                ? lastActionByWorkflowId[task.workflowRunId ?? ''] ??
                  (task.workflowProgress
                    ? `${task.workflowProgress.completedAgents}/${task.workflowProgress.totalAgents} agents complete`
                    : 'Starting workflow…')
                : lastActionByAgentId[task.agentId] ?? ''
              : task.result ?? ''
            const elapsed = formatElapsed((active ? now : task.endedAt ?? now) - task.startedAt)
            const nudgeOpen = openNudgeId === task.id
            const surfaces = active ? surfaceLabels(task.surfaces) : []

            return (
              <div
                key={task.id}
                className={`task-row task-row--${task.status}${multiAgent ? ' task-row--tinted' : ''}`}
                style={multiAgent ? ({ '--agent-accent': agentAccent(task.agentId) } as React.CSSProperties) : undefined}
              >
                <span className="task-row__dot" aria-hidden="true" />
                <div className="task-row__main">
                  <span className="task-row__label" title={task.description}>
                    {task.kind === 'workflow' ? `Workflow · ${label}` : label}
                  </span>
                  {action ? (
                    <span className="task-row__action-line" title={action}>
                      {action}
                    </span>
                  ) : null}
                  {surfaces.length ? (
                    <span className="task-row__surfaces">
                      {surfaces.map((surface) => (
                        <span className="task-row__surface" key={surface} title={surface}>
                          {surface}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <span className="task-row__elapsed">{elapsed}</span>
                {nudgeOpen && !compacting ? (
                  <input
                    className="task-row__nudge-input"
                    defaultValue=""
                    autoFocus
                    placeholder="Nudge…"
                    aria-label={`Nudge ${label}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onNudge(task.id, (e.target as HTMLInputElement).value)
                        setOpenNudgeId(undefined)
                      } else if (e.key === 'Escape') {
                        setOpenNudgeId(undefined)
                      }
                    }}
                    onBlur={() => setOpenNudgeId(undefined)}
                  />
                ) : canNudge ? (
                  <div className="task-row__actions">
                    <button
                      className="task-row__btn"
                      onClick={() => setOpenNudgeId(task.id)}
                      title={orphaned ? 'Send a message to resume this task' : 'Send a steering message'}
                    >
                      Nudge
                    </button>
                    {running ? (
                      <button
                        className="task-row__btn task-row__btn--cancel"
                        onClick={() => onCancel(task.id)}
                        title="Cancel this task"
                      >
                        Cancel
                      </button>
                    ) : null}
                    {orphaned ? (
                      <span className="task-row__glyph task-row__glyph--orphaned" title={task.result}>
                        <OrphanMark />
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <span
                    className={`task-row__glyph task-row__glyph--${task.status}`}
                    title={task.result}
                  >
                    {task.status === 'done' ? <CheckMark /> : <CrossMark />}
                  </span>
                )}
              </div>
            )
          })
        : null}
    </div>
  )
})
