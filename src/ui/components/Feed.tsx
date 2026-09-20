/**
 * The single vertical feed. Auto-scrolls to the bottom while pinned; when the
 * user scrolls up, it detaches and shows a "Jump to latest" pill. Clicking the
 * pill (or scrolling back to the bottom) re-pins.
 *
 * Pinning is paint-time (no animated scroll — animated scroll fights the user).
 *
 * Empty state: one centered question plus starter-prompt chips that AUTOFILL the
 * composer (never send — a one-click send from a guess is not a favor). Props
 * only, like the rest of the feed: App owns store access.
 */
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import type { TranscriptItem } from '../../shared/types'
import { TranscriptList, type AgentWaits } from './items'

const BOTTOM_THRESHOLD = 40 // px from bottom still counts as "pinned"

/** Presentation-only wait: never add a synthetic reasoning step to history. */
function waitingForFirstOutput(items: TranscriptItem[]): boolean {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    // Steering belongs to the current turn, not a new response wait.
    if (item.kind === 'user' && (item.pending || item.steered)) continue
    // A text-start event can arrive before there is anything to display.
    if (item.kind === 'text' && !item.text.trim()) continue
    if (item.kind === 'reasoning' && !item.streaming && !item.durationMs && !item.text.trim()) continue
    return item.kind === 'user'
  }
  return true
}

export function Feed({
  items,
  streaming,
  agentWaits,
  subagentModelBadge,
  starterPrompts,
  starterPromptsPending,
  configuring,
  userName,
  onRevert,
  onOpenFile,
  onStarterPrompt,
}: {
  items: TranscriptItem[]
  /** The current chat's turn is running (keeps a trailing tool group live). */
  streaming?: boolean
  /** Live rate-limit waits by agent id; subagent entries render under their delegation rows. */
  agentWaits?: AgentWaits
  /** Session model override label shown on running subagent cards (e.g. "Grok"). */
  subagentModelBadge?: string
  /** Chips offered on the empty chat; clicking one autofills the composer. */
  starterPrompts?: string[]
  /** A refresh is in flight — show four slots filled from partial streamed prompts. */
  starterPromptsPending?: boolean
  /** First-run setup pass still running — the composer is locked, so offer no chips. */
  configuring?: boolean
  /** What the user asked to be called (settings.userName); absent = greet plainly. */
  userName?: string
  onRevert: (itemId: string) => void
  onOpenFile?: (path: string) => void
  onStarterPrompt?: (prompt: string) => void
}): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [detached, setDetached] = useState(false)
  const thinking = streaming && !agentWaits?.main && waitingForFirstOutput(items)

  const scrollToBottom = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    pinnedRef.current = true
    setDetached(false)
  }, [])

  const onScroll = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const pinned = distance <= BOTTOM_THRESHOLD
    pinnedRef.current = pinned
    setDetached((prev) => (prev === !pinned ? prev : !pinned))
  }, [])

  // Keep pinned to bottom as items grow, unless the user scrolled away.
  useLayoutEffect(() => {
    if (pinnedRef.current) {
      const el = scrollerRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [items, thinking])

  // Pin on first mount.
  useEffect(() => {
    scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="feed" ref={scrollerRef} onScroll={onScroll}>
      <div className="feed__inner">
        {items.length === 0 && !streaming ? (
          <div className="feed__empty">
            {/* Two lines when we have a name: the break is the greeting's beat,
                and letting "What should we work on, Alexandra?" wrap wherever
                a 360px panel happens to run out looks accidental. */}
            {userName ? (
              <p className="feed__empty-title">
                What should we work on,
                <br />
                {userName}?
              </p>
            ) : (
              <p className="feed__empty-title">What should we work on today?</p>
            )}
            {/* While setup runs the composer is disabled, and a chip you can't
                type into is worse than no chip — show the reason instead. */}
            {configuring ? (
              <p className="feed__empty-note">Getting to know your browser — one moment.</p>
            ) : starterPromptsPending || (starterPrompts && starterPrompts.length > 0) ? (
              <div
                className="feed__starters"
                aria-label={starterPromptsPending ? 'Preparing suggestions' : undefined}
                aria-live={starterPromptsPending ? 'polite' : undefined}
              >
                {Array.from(
                  { length: starterPromptsPending ? 4 : (starterPrompts?.length ?? 0) },
                  (_, index) => {
                    const prompt = starterPrompts?.[index]
                    return (
                      <button
                        key={index}
                        type="button"
                        className={`starter-chip${prompt ? '' : ' starter-chip--skeleton'}`}
                        disabled={!prompt}
                        aria-hidden={prompt ? undefined : true}
                        // Clamped to two lines, so the full prompt lives in the
                        // tooltip too (and it lands in the composer either way).
                        title={prompt || undefined}
                        onClick={prompt ? () => onStarterPrompt?.(prompt) : undefined}
                      >
                        {/* Inner span carries the line clamp: -webkit-line-clamp on
                            the button itself fights the anonymous box a <button>
                            wraps its content in. */}
                        {prompt ? (
                          <span className="starter-chip__text">{prompt}</span>
                        ) : (
                          <span className="starter-chip__skeleton-line" />
                        )}
                      </button>
                    )
                  },
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <TranscriptList
            items={items}
            streaming={streaming}
            agentWaits={agentWaits}
            subagentModelBadge={subagentModelBadge}
            onRevert={onRevert}
            onOpenFile={onOpenFile}
          />
        )}
        {thinking ? (
          <div className="feed__thinking" role="status" aria-live="polite">
            <span className="shine">Thinking…</span>
          </div>
        ) : null}
      </div>
      {detached ? (
        <button className="jump-latest" onClick={scrollToBottom} aria-label="Jump to latest">
          ↓ Jump to latest
        </button>
      ) : null}
    </div>
  )
}
