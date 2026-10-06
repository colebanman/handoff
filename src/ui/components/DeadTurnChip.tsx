/**
 * Recovery chip for a failed request or a turn interrupted by worker shutdown.
 * Resume uses the last completed model step when one is available.
 */
import type { DeadTurnInfo } from '../store'

export function DeadTurnChip({
  status,
  onRetry,
}: {
  status: DeadTurnInfo
  onRetry: () => void
}): React.ReactElement {
  return (
    <div className="dead-turn" role="status" title={new Date(status.at).toLocaleTimeString()}>
      <span className="dead-turn__dot" aria-hidden="true" />
      <span className="dead-turn__text">{status.kind === 'interrupted'
        ? 'Task was interrupted — saved progress is ready'
        : status.kind === 'review'
          ? 'Task was interrupted during an action — review the last action before continuing'
        : status.kind === 'connection'
          ? 'Connection failed — saved progress is ready'
          : 'Turn failed — no response came through'}</span>
      {status.kind !== 'review' ? (
        <button type="button" className="btn btn--primary dead-turn__btn" onClick={onRetry}>
          {status.kind ? 'Resume' : 'Retry'}
        </button>
      ) : null}
    </div>
  )
}
