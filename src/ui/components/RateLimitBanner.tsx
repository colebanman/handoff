/**
 * Transient banner shown while the running turn is paused on a provider rate
 * limit. The agent retries the same request indefinitely; this makes the wait
 * visible with a live countdown, and — when the limited model is OpenAI —
 * offers a mid-task switch to Grok with clear feedback about who moved.
 */
import { useEffect, useState } from 'react'
import type { ModelSwitchScope } from '../../agent/model-switch'

export interface RateLimitStatus {
  attempt: number
  /** Timestamp (ms) when the next retry fires. */
  retryAt: number
  message?: string
}

export interface ModelOverrideStatus {
  modelId: string
  scope: ModelSwitchScope
}

export function formatRemaining(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms % 60_000) / 1000)
    return `${m}m ${s}s`
  }
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`
  return `${(ms / 1000).toFixed(1)}s`
}

function CheckGlyph(): React.ReactElement {
  return (
    <svg className="rate-limit__check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2.5 6.2 5 8.7 9.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function RateLimitBanner({
  status,
  showGrokSwitch,
  hasXaiKey,
  modelOverride,
  onSwitchToGrok,
}: {
  status: RateLimitStatus
  /** True when the rate-limited model is OpenAI (or gateway openai/*). */
  showGrokSwitch?: boolean
  /** False when no xAI API key is configured — actions stay visible but disabled. */
  hasXaiKey?: boolean
  /** Active session override — drives instant confirmation after a press. */
  modelOverride?: ModelOverrideStatus
  onSwitchToGrok?: (scope: ModelSwitchScope) => void
}): React.ReactElement {
  const [now, setNow] = useState(() => Date.now())
  // Which button was pressed this mount — keeps press→confirm continuous even
  // if the store lags a frame (should not, but local state is free insurance).
  const [pressed, setPressed] = useState<ModelSwitchScope | undefined>()

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])

  const remaining = status.retryAt - now
  const retryText =
    remaining > 0 ? `retrying in ${formatRemaining(remaining)}` : 'retrying now…'
  const confirmed = modelOverride ?? (pressed ? { modelId: 'grok-4.6', scope: pressed } : undefined)
  const canOfferSwitch = Boolean(showGrokSwitch && onSwitchToGrok && !confirmed)
  const disabled = !hasXaiKey

  const onPick = (scope: ModelSwitchScope): void => {
    if (disabled || !onSwitchToGrok) return
    setPressed(scope)
    onSwitchToGrok(scope)
  }

  // Everyone moved: rate-limit wait is ending; celebrate the choice, don't
  // keep advertising the OpenAI countdown that no longer applies.
  if (confirmed?.scope === 'all') {
    return (
      <div className="rate-limit rate-limit--confirmed" role="status">
        <span className="rate-limit__mark" aria-hidden="true">
          <CheckGlyph />
        </span>
        <span className="rate-limit__text">
          Switching <strong>everyone</strong> to Grok — main agent and all subagents
        </span>
      </div>
    )
  }

  // Subagents only: main is still limited. Keep the countdown, but lock in
  // what already changed so the press never feels ignored.
  if (confirmed?.scope === 'subagents') {
    return (
      <div className="rate-limit rate-limit--split" role="status" title={status.message}>
        <div className="rate-limit__row">
          <span className="rate-limit__dot" aria-hidden="true" />
          <span className="rate-limit__text">
            Main still rate limited — {retryText}
          </span>
          {status.attempt > 1 ? (
            <span className="rate-limit__attempt">attempt {status.attempt}</span>
          ) : null}
        </div>
        <div className="rate-limit__confirm" aria-live="polite">
          <span className="rate-limit__mark" aria-hidden="true">
            <CheckGlyph />
          </span>
          <span>
            <strong>Subagents</strong> will use Grok from their next step
            <span className="rate-limit__confirm-sub"> · main stays on OpenAI</span>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`rate-limit${canOfferSwitch ? ' rate-limit--choose' : ''}`}
      role="status"
      title={status.message}
    >
      <div className="rate-limit__row">
        <span className="rate-limit__dot" aria-hidden="true" />
        <span className="rate-limit__text">Rate limited — {retryText}</span>
        {status.attempt > 1 ? (
          <span className="rate-limit__attempt">attempt {status.attempt}</span>
        ) : null}
      </div>

      {canOfferSwitch ? (
        <div className="rate-limit__switch">
          <span className="rate-limit__switch-label">Continue on Grok instead?</span>
          <div className="rate-limit__actions">
            <button
              type="button"
              className="rate-limit__btn rate-limit__btn--primary"
              disabled={disabled}
              title={
                disabled
                  ? 'Add an xAI API key in Settings to switch to Grok'
                  : 'Main agent and every subagent switch to Grok for the rest of this session'
              }
              onPointerDown={(e) => {
                // Instant press highlight (Apple: feedback on down, not click).
                if (e.button === 0) e.currentTarget.classList.add('is-pressed')
              }}
              onPointerUp={(e) => e.currentTarget.classList.remove('is-pressed')}
              onPointerLeave={(e) => e.currentTarget.classList.remove('is-pressed')}
              onClick={() => onPick('all')}
            >
              Everyone
            </button>
            <button
              type="button"
              className="rate-limit__btn rate-limit__btn--ghost"
              disabled={disabled}
              title={
                disabled
                  ? 'Add an xAI API key in Settings to switch to Grok'
                  : 'Only subagents switch to Grok — keeps OpenAI free for the main agent'
              }
              onPointerDown={(e) => {
                if (e.button === 0) e.currentTarget.classList.add('is-pressed')
              }}
              onPointerUp={(e) => e.currentTarget.classList.remove('is-pressed')}
              onPointerLeave={(e) => e.currentTarget.classList.remove('is-pressed')}
              onClick={() => onPick('subagents')}
            >
              Subagents only
            </button>
          </div>
          {disabled ? (
            <p className="rate-limit__hint rate-limit__hint--warn">Add an xAI API key in Settings first.</p>
          ) : (
            <p className="rate-limit__hint">
              <strong>Everyone</strong> ends this wait now.
              {' '}
              <strong>Subagents only</strong> frees OpenAI quota for the main agent.
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
