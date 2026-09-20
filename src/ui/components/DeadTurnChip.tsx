/**
 * Inline chip shown when the current chat's last turn ended with zero
 * visible output — a harness-level failure (provider stall, transport error,
 * or a finishReason:null death that survived run.ts's bounded auto-retry)
 * rather than a normal reply. Never shown for a user-initiated Stop: store.ts
 * only sets `deadTurns` when the turn was not aborted (see `isDeadTurn` in
 * `runTurn`'s `finally` block). Retrying re-fires the exact same conversation
 * (`retryDeadTurn` in store.ts) instead of asking the user to retype.
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
      <span className="dead-turn__text">Turn failed — no response came through</span>
      <button type="button" className="btn btn--primary dead-turn__btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}
