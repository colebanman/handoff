/**
 * Header: chat switcher (dropdown), new-chat button, context meter, debug-log
 * copy, files toggle, settings gear. The model picker lives in the composer's
 * control row. Rewinding is per-message (hover a message → Revert), not a
 * header button.
 */
import { useState, useRef, useEffect, memo } from 'react'
import type { Settings } from '../../shared/types'
import type { ChatMeta } from '../../storage/chats'
import type { ChatOrigin } from '../../shared/bridge-protocol'
import { downloadChatExport } from '../../storage/export'
import { debugLog } from '../../shared/debug-log'
import type { OffscreenRuntimeMessage } from '../../shared/execution-protocol'
import { contextModelKey, defaultContextWindow, type ContextModel, type ContextWindow } from '../../shared/model-context'
import { contextInputTokens, contextUsageMatches, contextMeterTitle, formatContextTokens, type ContextUsageInfo } from '../../shared/context-usage'
import { resolveContextWindow } from '../../agent/model-context'
import { SettingsIcon } from './SettingsIcon'
import { ExpandView } from './ExpandView'

const TAU = Math.PI * 2

export function formatChatTimestamp(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Unknown date'
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startValue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
  if (startValue === startToday) return `Today ${time}`
  if (startValue === startToday - 24 * 60 * 60 * 1000) return `Yesterday ${time}`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

export function fullChatTimestamp(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Unknown date'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function ContextMeter({
  model,
  usage,
  isRunning,
}: {
  model: ContextModel
  usage?: ContextUsageInfo
  isRunning: boolean
}): React.ReactElement {
  const key = contextModelKey(model)
  const fallback = defaultContextWindow(model)
  const measured = contextUsageMatches(usage, model) ? usage : undefined
  const [resolved, setResolved] = useState<{ key: string; window?: ContextWindow }>()
  // A completed request carries the exact limit used by the harness. A late
  // catalog response (or a previous model's state) cannot replace that limit.
  const contextWindow = measured?.context?.window ?? (resolved?.key === key ? resolved.window : undefined) ?? fallback
  const used = contextInputTokens(measured)
  const percent = used !== undefined && contextWindow ? Math.min(1, used / contextWindow.tokens) : 0
  const r = 7
  const circumference = TAU * r
  const dash = circumference * percent
  const label = `${formatContextTokens(used)} / ${contextWindow?.source === 'fallback' ? '~' : ''}${formatContextTokens(contextWindow?.tokens)}`
  const title = contextMeterTitle(measured, contextWindow)
  const { provider, modelId, openaiAuthMode, anthropicAuthMode, baseURL } = model
  const measuredWindow = measured?.context?.window

  useEffect(() => {
    if (measuredWindow) return
    const controller = new AbortController()
    void resolveContextWindow({ provider, modelId, openaiAuthMode, anthropicAuthMode, baseURL }, controller.signal)
      .then((window) => {
        if (!controller.signal.aborted) setResolved({ key, window })
      })
      .catch((err) => {
        if (!controller.signal.aborted) debugLog.error('ui', 'fetch model context window', err)
      })
    return () => controller.abort()
  }, [key, provider, modelId, openaiAuthMode, anthropicAuthMode, baseURL, measuredWindow])

  return (
    <div className={`context-meter${isRunning ? ' context-meter--running' : ''}`} title={title} aria-label={title}>
      <svg className="context-meter__ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle className="context-meter__track" cx="9" cy="9" r={r} />
        <circle
          className="context-meter__value"
          cx="9"
          cy="9"
          r={r}
          strokeDasharray={`${dash} ${circumference}`}
        />
      </svg>
      <span className="context-meter__label">{label}</span>
    </div>
  )
}

/** Tooltip for the "made by an agent" badge: who asked, from where, and when. */
function originTitle(origin: ChatOrigin): string {
  const parts = [
    origin.kind === 'automation'
      ? `Opened by the scheduled automation${origin.label ? ` "${origin.label}"` : ''}`
      : `Started by ${origin.client} through the agent bridge`,
  ]
  if (origin.label) parts.push(origin.label)
  if (origin.cwd) parts.push(origin.cwd)
  parts.push(fullChatTimestamp(origin.at))
  return parts.join(' · ')
}

// Memoized: the app re-renders every streaming frame, and the header only
// needs to follow chat/usage changes (all callback props are identity-stable).
export const Header = memo(function Header({
  chats,
  currentId,
  runningChatIds,
  settings,
  contextUsage,
  isRunning,
  transcriptCount,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  onOpenFiles,
  onOpenSettings,
}: {
  chats: ChatMeta[]
  currentId: string
  /** Chats with a live turn (parallel turns run concurrently). */
  runningChatIds: string[]
  settings: Settings
  contextUsage?: ContextUsageInfo
  isRunning: boolean
  transcriptCount: number
  onNewChat: () => void
  onSelectChat: (id: string) => void
  onDeleteChat: (id: string) => void
  onOpenFiles: () => void
  onOpenSettings: () => void
}): React.ReactElement {
  const [listOpen, setListOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [exported, setExported] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Chats an external agent opened carry provenance; surface it both in the
  // list and while you are reading the chat itself.
  const currentOrigin = chats.find((chat) => chat.id === currentId)?.origin

  // Close the chat panel on outside click.
  useEffect(() => {
    if (!listOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (!panelRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) setListOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setListOpen(false); triggerRef.current?.focus() } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [listOpen])

  const copyLog = async (): Promise<void> => {
    try {
      let background: string
      try {
        const response = await chrome.runtime.sendMessage({
          target: 'background', type: 'execution.debug', chatId: currentId,
        } satisfies OffscreenRuntimeMessage)
        if (!response?.ok || typeof response.value !== 'string') throw new Error(response?.error ?? 'No background diagnostic response')
        background = response.value
      } catch (err) {
        debugLog.error('ui', 'background debug log unavailable', err)
        background = 'Background debug log unavailable; panel log follows.'
      }
      await navigator.clipboard.writeText(
        background + '\n\n' + debugLog.dump({
          model: settings.modelId,
          provider: settings.provider,
          chatId: currentId,
          transcriptItems: transcriptCount,
        }),
      )
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      debugLog.error('ui', 'copy debug log', err)
    }
  }

  const exportChats = async (): Promise<void> => {
    try {
      await downloadChatExport()
      setExported(true)
      window.setTimeout(() => setExported(false), 1500)
    } catch (err) {
      debugLog.error('ui', 'export chats', err)
    }
  }

  return (
    <div className="header">
      <button
        ref={triggerRef}
        className="icon-btn"
        onClick={() => setListOpen((o) => !o)}
        aria-expanded={listOpen}
        title="Chats"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        Chats
        {runningChatIds.length > 0 ? (
          <span
            className="run-badge"
            title={`${runningChatIds.length} chat${runningChatIds.length > 1 ? 's' : ''} running`}
          >
            <span className="run-dot" aria-hidden="true" />
            {runningChatIds.length > 1 ? runningChatIds.length : null}
          </span>
        ) : null}
      </button>

      {currentOrigin ? (
        <span className="agent-chip" title={originTitle(currentOrigin)}>
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M6 1.2l1.4 2.9 3.2.4-2.3 2.2.6 3.1L6 8.4 3.1 9.8l.6-3.1L1.4 4.5l3.2-.4z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
            />
          </svg>
          {currentOrigin.client}
        </span>
      ) : null}

      <button className="icon-btn" onClick={() => { onNewChat(); setListOpen(false) }} title="New chat" aria-label="New chat">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      <div className="header__spacer" />

      <ContextMeter
        model={settings}
        usage={contextUsage}
        isRunning={isRunning}
      />

      <button className="icon-btn" onClick={copyLog} title="Copy debug log" aria-label="Copy debug log">
        {copied ? (
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <path d="M3 8l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <rect x="5" y="4.5" width="7" height="8.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M10 4.5V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>

      <button className="icon-btn" onClick={exportChats} title="Export chats (JSON, media stripped)" aria-label="Export chats">
        {exported ? (
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <path d="M3 8l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <path d="M7.5 2v7M4.5 6.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.5 10.5v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        )}
      </button>

      <button className="icon-btn" onClick={onOpenFiles} title="Files">
        <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
          <path d="M2.2 5h10.6v6.5a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V5Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M2.2 5.1V3.6a1 1 0 0 1 1-1h3.1l1.1 1.5h4.4a1 1 0 0 1 1 1v.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        Files
      </button>

      <ExpandView />

      <button className="icon-btn" onClick={() => { onOpenSettings(); setListOpen(false) }} title="Settings" aria-label="Settings">
        <SettingsIcon />
      </button>

      {listOpen ? (
        <div className="chat-panel" ref={panelRef}>
          {chats.length === 0 ? (
            <div className="chat-panel__empty">No saved chats yet.</div>
          ) : (
            chats.map((c) => {
              const running = runningChatIds.includes(c.id)
              return (
              <div
                key={c.id}
                className={`chat-row${c.id === currentId ? ' chat-row--active' : ''}`}
                role="button"
                tabIndex={0}
                aria-current={c.id === currentId ? 'true' : undefined}
                title={`Updated ${fullChatTimestamp(c.updatedAt)} · Created ${fullChatTimestamp(c.createdAt)}`}
                onClick={() => {
                  onSelectChat(c.id)
                  setListOpen(false)
                }}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault(); onSelectChat(c.id); setListOpen(false)
                  }
                }}
              >
                <div className="chat-row__body">
                  <div className="chat-row__top">
                    {running ? <span className="run-dot" aria-hidden="true" /> : null}
                    <div className="chat-row__title">{c.title || 'Untitled'}</div>
                    {running ? <span className="chat-row__badge chat-row__badge--running">Running</span> : null}
                    {c.origin ? (
                      <span className="chat-row__badge chat-row__badge--agent" title={originTitle(c.origin)}>
                        {c.origin.kind === 'automation' ? '⏰ automation' : c.origin.client}
                      </span>
                    ) : null}
                    {c.id === currentId ? <span className="chat-row__badge">Open</span> : null}
                  </div>
                  <div className="chat-row__meta">
                    <span>Updated {formatChatTimestamp(c.updatedAt)}</span>
                    <span>Created {formatChatTimestamp(c.createdAt)}</span>
                  </div>
                  {c.preview ? <div className="chat-row__preview">{c.preview}</div> : null}
                </div>
                <button
                  className="chat-row__del icon-btn"
                  title="Delete chat"
                  aria-label={`Delete ${c.title || 'untitled chat'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteChat(c.id)
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
})
