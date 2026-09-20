/**
 * Message composer: a single bordered box (Cursor-style control surface) with
 * the textarea on top and a control row (model picker · appshot · elapsed ·
 * send/stop) below. Enter sends; while a turn is running, Enter messages the
 * running turn (steering — attaches at the next step boundary, or follows up if
 * the turn ends first). Shift+Enter inserts a newline. The textarea auto-grows.
 *
 * Attachments: pasted images and staged drops render as thumbnail chips above
 * the textarea; the Appshot button captures the active tab (screenshot + page
 * metadata) into a chip. A message with attachments always sends/queues — it
 * never becomes steering, which is text-only.
 *
 * Next-prompt suggestion: when the store has a predicted follow-up for an idle
 * chat with an empty draft, it is drawn as a ghost-text OVERLAY (plus a "⇥ Tab"
 * keycap). It is not the textarea's placeholder, because a placeholder cannot
 * animate per character — it is not a DOM node, and `::placeholder` supports
 * neither `transform` nor per-character targeting. The usual objection to an
 * overlay (replicating font metrics, breaking on wrap) does not apply here: the
 * suggestion shows ONLY on an empty draft, so there is no user text to stay
 * aligned with, and both surfaces inherit the same 13px/18px metrics. Tab fills
 * the draft, Escape dismisses — both only while the suggestion is on screen.
 */
import { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useState, memo } from 'react'
import type { CuratedModelProvider, ProviderKind, VfsEntry } from '../../shared/types'
import type { PendingAttachment } from '../store'
import type { BrowserContextAttachment } from '../../shared/browser-events'
import { getRuntime } from '../../runtime'
import { ModelPicker } from './ModelPicker'
import { CameraGlyph } from './items'

type MentionItem =
  | { kind: 'workspace'; id: string; label: string; detail: string; path: string; updatedAt: number }
  | { kind: 'folder'; id: string; label: string; detail: string; path: string; updatedAt: number }
  | { kind: 'tab'; id: string; label: string; detail: string; tabId: number; url?: string; active: boolean }

interface MentionMatch {
  start: number
  end: number
  query: string
}

interface MentionSources {
  workspace: Array<Extract<MentionItem, { kind: 'workspace' }>>
  folders: Array<Extract<MentionItem, { kind: 'folder' }>>
  tabs: Array<Extract<MentionItem, { kind: 'tab' }>>
}

const EMPTY_SOURCES: MentionSources = { workspace: [], folders: [], tabs: [] }
const MAX_MENTION_ITEMS = 12

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

function compactUrl(url?: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

function browserContextLabel(context: BrowserContextAttachment): string {
  if (context.kind === 'selection') return context.text || 'Selected text'
  if (context.kind === 'link') return context.title || 'Link'
  if (context.kind === 'image') return context.title || 'Image'
  if (context.kind === 'media') return context.title || 'Media'
  return context.title || 'Page'
}

function findMention(value: string, cursor: number | null | undefined): MentionMatch | undefined {
  if (cursor === null || cursor === undefined) return undefined
  const before = value.slice(0, cursor)
  const match = before.match(/(^|[\s([{])@([^\s@]*)$/)
  if (!match) return undefined
  const query = match[2] ?? ''
  return { start: before.length - query.length - 1, end: cursor, query }
}

function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/^\/+/, '')
}

function scoreMention(item: MentionItem, query: string): number {
  if (!query) return item.kind === 'tab' && item.active ? 3 : 1
  const extra = item.kind === 'tab' ? item.tabId : item.path
  const haystack = `${item.label} ${item.detail} ${extra}`.toLowerCase()
  if (haystack.startsWith(query)) return 4
  if (item.label.toLowerCase().includes(query)) return 3
  if (haystack.includes(query)) return 2
  return 0
}

function mentionText(item: MentionItem): string {
  if (item.kind === 'workspace') return `@file(${item.path})`
  if (item.kind === 'folder') return `@folder(${item.path})`
  const title = item.label.replaceAll('"', "'")
  const url = item.url ? ` ${item.url}` : ''
  return `@tab(${item.tabId} "${title}"${url})`
}

/** Derive folder mention items from the flat workspace listing. */
function folderMentions(entries: VfsEntry[]): Array<Extract<MentionItem, { kind: 'folder' }>> {
  const folders = new Map<string, { updatedAt: number; count: number }>()
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean)
    for (let depth = 2; depth < parts.length; depth++) {
      const dir = `/${parts.slice(0, depth).join('/')}`
      const info = folders.get(dir) ?? { updatedAt: 0, count: 0 }
      info.count += 1
      info.updatedAt = Math.max(info.updatedAt, entry.updatedAt)
      folders.set(dir, info)
    }
  }
  return [...folders.entries()]
    .map(([path, info]) => ({
      kind: 'folder' as const,
      id: `folder:${path}`,
      label: basename(path),
      detail: `${path} · ${info.count} file${info.count === 1 ? '' : 's'}`,
      path,
      updatedAt: info.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function workspaceMention(entry: VfsEntry): Extract<MentionItem, { kind: 'workspace' }> {
  return {
    kind: 'workspace',
    id: `workspace:${entry.path}`,
    label: basename(entry.path),
    detail: entry.path,
    path: entry.path,
    updatedAt: entry.updatedAt,
  }
}

/**
 * Ghost-text reveal timing. Kept in sync with `ghost-drop` and
 * `.composer__ghost > span` in theme.css — the keyframe owns the per-character
 * duration, these own when each character starts.
 */
const GHOST_REVEAL_MS = 460
const GHOST_STEP_MAX_MS = 7

function tabMention(tab: chrome.tabs.Tab): Extract<MentionItem, { kind: 'tab' }> | undefined {
  if (typeof tab.id !== 'number') return undefined
  return {
    kind: 'tab',
    id: `tab:${tab.id}`,
    label: tab.title || tab.url || `Tab ${tab.id}`,
    detail: [String(tab.id), compactUrl(tab.url)].filter(Boolean).join(' · '),
    tabId: tab.id,
    url: tab.url,
    active: !!tab.active,
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`
}

/**
 * Elapsed wall time for the running turn. Memoized with its own 1s interval so
 * the tick re-renders this span alone, never the composer — and so the store
 * never has to write a clock value per second. Step counts and the current tool
 * live in the feed, not here.
 */
const ElapsedTimer = memo(function ElapsedTimer({ startedAt }: { startedAt: number }): React.ReactElement {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <span className="composer__elapsed" role="timer" aria-label="Elapsed time">
      {formatElapsed(Date.now() - startedAt)}
    </span>
  )
})

// Memoized: streaming re-renders the app every frame; with identity-stable
// callbacks from App, the composer only re-renders when its own props move.
export const Composer = memo(function Composer({
  value,
  isRunning,
  disabled,
  disabledReason,
  queuedCount,
  pendingSteering,
  modelId,
  provider,
  openaiAuthMode,
  modelProviders,
  attachments,
  browserContexts,
  appshotBusy,
  attachmentNotice,
  runStartedAt,
  nextPrompt,
  stopLabel = 'Stop',
  onModelChange,
  onChange,
  onSend,
  onSteer,
  onClearSteering,
  onClearQueue,
  onStop,
  onAttachFiles,
  onRemoveAttachment,
  onRemoveBrowserContext,
  onAppshot,
  onClearNotice,
  onAcceptNextPrompt,
  onDismissNextPrompt,
}: {
  value: string
  isRunning: boolean
  disabled: boolean
  /**
   * Placeholder while disabled, for reasons the credential branches below can't
   * infer (e.g. first-run setup still running). Falls back to the "no credential"
   * copy when absent.
   */
  disabledReason?: string
  queuedCount: number
  pendingSteering?: string
  modelId: string
  provider: ProviderKind
  openaiAuthMode?: 'api-key' | 'chatgpt'
  /** Picker groups with live credentials (store.availableModelProviders). */
  modelProviders: CuratedModelProvider[]
  attachments: PendingAttachment[]
  browserContexts: BrowserContextAttachment[]
  appshotBusy: boolean
  attachmentNotice?: string
  /** Wall-clock start of the running turn; drives the elapsed timer. */
  runStartedAt?: number
  /**
   * Predicted next message for this chat, if the store has one. Offered — never
   * imposed: it only surfaces on an empty draft in an idle, enabled composer.
   */
  nextPrompt?: string
  stopLabel?: string
  onModelChange: (modelId: string) => void
  onChange: (text: string) => void
  onSend: (text: string) => void
  onSteer: (text: string) => void
  onClearSteering: () => void
  onClearQueue: () => void
  onStop: () => void
  onAttachFiles: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
  onRemoveBrowserContext: (id: string) => void
  onAppshot: () => void
  onClearNotice: () => void
  /** Tab: put the suggestion in the draft. Never sends it. */
  onAcceptNextPrompt: () => void
  /** Escape: drop the suggestion for this chat. */
  onDismissNextPrompt: () => void
}): React.ReactElement {
  const taRef = useRef<HTMLTextAreaElement>(null)
  /** Ghost-text overlay, measured to reserve textarea height for wrapped suggestions. */
  const ghostRef = useRef<HTMLDivElement>(null)
  const [mention, setMention] = useState<MentionMatch | undefined>(undefined)
  const [mentionSources, setMentionSources] = useState<MentionSources>(EMPTY_SOURCES)
  const [selectedMention, setSelectedMention] = useState(0)
  const [mentionLoading, setMentionLoading] = useState(false)

  const loadMentionSources = useCallback(async (): Promise<void> => {
    setMentionLoading(true)
    try {
      const [workspace, tabs] = await Promise.all([
        getRuntime().vfs.list('workspace'),
        chrome.tabs.query({}),
      ])
      setMentionSources({
        workspace: workspace
          .map(workspaceMention)
          .sort((a, b) => b.updatedAt - a.updatedAt),
        folders: folderMentions(workspace),
        tabs: tabs
          .map(tabMention)
          .filter((item): item is Extract<MentionItem, { kind: 'tab' }> => item !== undefined)
          .sort((a, b) => Number(b.active) - Number(a.active)),
      })
    } finally {
      setMentionLoading(false)
    }
  }, [])

  const mentionItems = useMemo(() => {
    if (!mention) return []
    const query = normalizeQuery(mention.query)
    return [...mentionSources.tabs, ...mentionSources.folders, ...mentionSources.workspace]
      .map((item) => ({ item, score: scoreMention(item, query) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MENTION_ITEMS)
      .map(({ item }) => item)
  }, [mention, mentionSources])

  const openMention = useCallback(
    (nextValue: string, cursor: number | null | undefined): void => {
      const next = findMention(nextValue, cursor)
      const wasClosed = mention === undefined
      setMention(next)
      setSelectedMention(0)
      if (next && wasClosed && !mentionLoading) {
        void loadMentionSources()
      }
    },
    [loadMentionSources, mention, mentionLoading],
  )

  const insertMention = useCallback(
    (item: MentionItem): void => {
      const current = mention
      if (!current) return
      const text = mentionText(item)
      const before = value.slice(0, current.start)
      const after = value.slice(current.end)
      const suffix = after.startsWith(' ') || after.startsWith('\n') || after.length === 0 ? '' : ' '
      const next = `${before}${text}${suffix}${after}`
      const caret = before.length + text.length + suffix.length
      onChange(next)
      setMention(undefined)
      requestAnimationFrame(() => {
        const ta = taRef.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(caret, caret)
      })
    },
    [mention, onChange, value],
  )

  // While running, sending means steering the live turn (Cursor model: you
  // just keep talking to the agent; leftover steering becomes a follow-up).
  // Steering is text-only, so a message with attachments sends instead — the
  // store queues it as a follow-up while a turn is live.
  const hasAttachments = attachments.length > 0 || browserContexts.length > 0
  const submit = useCallback((): void => {
    const text = value.trim()
    if (disabled || (!text && !hasAttachments)) return
    if (isRunning && !hasAttachments) onSteer(text)
    else onSend(text)
  }, [value, disabled, isRunning, hasAttachments, onSend, onSteer])

  /**
   * The suggestion is only ever *offered*: it shows on an empty draft in an
   * idle, enabled composer and nowhere else, so it can never sit under or
   * obscure something the user wrote. An empty draft also means no '@' has been
   * typed, so the mention menu cannot be open at the same time — which is what
   * keeps Tab/Escape unambiguous below.
   */
  const suggestion = nextPrompt && !value && !isRunning && !disabled ? nextPrompt : undefined

  /**
   * Per-character reveal. Memoized on the suggestion TEXT so the drop-in plays
   * once when a suggestion arrives and not again on the re-renders this
   * (memoized, stream-heavy) component sees constantly.
   *
   * The stagger is budgeted rather than fixed: at a constant per-char delay a
   * 240-char suggestion would crawl for over a second, so the step shrinks with
   * length and the whole reveal lands inside GHOST_REVEAL_MS either way.
   */
  const ghost = useMemo(() => {
    if (!suggestion) return undefined
    // Split into words AND the runs of whitespace between them. Characters are
    // laid out as individual inline-blocks so each can be transformed, which
    // means the line breaker sees N independent boxes and NO words — it will
    // happily break "Final" into "F / inal". Grouping each word into a nowrap
    // wrapper restores real word boundaries; the whitespace spans stay outside
    // the wrappers so they remain the only break opportunities.
    const tokens = suggestion.split(/(\s+)/).filter((token) => token.length > 0)
    const total = Array.from(suggestion).length
    const step = Math.min(GHOST_STEP_MAX_MS, GHOST_REVEAL_MS / Math.max(1, total))
    let at = 0
    const groups = tokens.map((token) => {
      const start = at
      at += Array.from(token).length
      return { token, start, space: /^\s+$/.test(token) }
    })
    return {
      groups,
      step: `${Math.round(step * 100) / 100}ms`,
      // The keycap fades in once the text has finished landing.
      outro: `${Math.round(step * total)}ms`,
    }
  }, [suggestion])

  // Auto-grow the textarea to fit its content (capped by CSS max-height).
  //
  // Ghost text also feeds this: it wraps to however many lines it needs and is
  // absolutely positioned, so the textarea has to reserve that height or a
  // multi-line suggestion spills out of the composer. Measured rather than
  // estimated from character count — where the text wraps depends on font
  // rendering — and it runs before paint, so there is no visible reflow.
  // Declared after `suggestion` because it reads it.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const content = ta.scrollHeight
    const ghostHeight = ghostRef.current?.offsetHeight ?? 0
    ta.style.height = `${Math.max(content, ghostHeight)}px`
  }, [value, suggestion])

  const acceptSuggestion = useCallback((): void => {
    if (!suggestion) return
    onAcceptNextPrompt()
    // Focus must stay here (Tab's default would move it) and the caret belongs
    // at the end so Enter sends or typing continues the line — same trick as
    // mention insertion, after React has committed the new value.
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(suggestion.length, suggestion.length)
    })
  }, [onAcceptNextPrompt, suggestion])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // Guarded on `suggestion`, so both keys keep their normal meaning
      // (focus move / mention dismissal) whenever nothing is being offered.
      if (suggestion) {
        if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault()
          acceptSuggestion()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          onDismissNextPrompt()
          return
        }
      }
      if (mention) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedMention((i) => (mentionItems.length === 0 ? 0 : (i + 1) % mentionItems.length))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedMention((i) => (mentionItems.length === 0 ? 0 : (i - 1 + mentionItems.length) % mentionItems.length))
          return
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && mentionItems[selectedMention]) {
          e.preventDefault()
          insertMention(mentionItems[selectedMention])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setMention(undefined)
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submit()
      }
    },
    [acceptSuggestion, insertMention, mention, mentionItems, onDismissNextPrompt, selectedMention, submit, suggestion],
  )

  const onTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
      onChange(e.target.value)
      openMention(e.target.value, e.target.selectionStart)
    },
    [onChange, openMention],
  )

  const onTextareaSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
      openMention(e.currentTarget.value, e.currentTarget.selectionStart)
    },
    [openMention],
  )

  // Pasted images (screenshots from the clipboard) become attachment chips.
  const onTextareaPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
      const images = Array.from(e.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
      if (images.length === 0) return
      e.preventDefault()
      onAttachFiles(images)
    },
    [onAttachFiles],
  )

  const canSend = (value.trim().length > 0 || hasAttachments) && !disabled

  return (
    <div className="composer">
      {pendingSteering ? (
        <div className="composer__meta composer__meta--steer" title="Attaches after the next tool call finishes">
          <span className="composer__meta-label">steering</span>
          <span className="composer__meta-text">{pendingSteering}</span>
          {/* A glyph, not the word "Clear": this strip is one line of annotation
              and a text button doubled its visual weight. */}
          <button
            className="composer__meta-btn composer__meta-btn--icon"
            onClick={onClearSteering}
            title="Clear steering"
            aria-label="Clear steering"
          >
            ✕
          </button>
        </div>
      ) : null}
      {queuedCount > 0 ? (
        <div className="composer__meta">
          <span className="composer__meta-label">{queuedCount} queued</span>
          <button className="composer__meta-btn" onClick={onClearQueue} title="Clear queued messages">
            Clear queue
          </button>
        </div>
      ) : null}
      {attachmentNotice ? (
        <div className="composer__meta composer__meta--notice">
          <span className="composer__meta-text" title={attachmentNotice}>
            {attachmentNotice}
          </span>
          <button className="composer__meta-btn" onClick={onClearNotice} title="Dismiss">
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="composer__box">
        {attachments.length > 0 || browserContexts.length > 0 ? (
          <div className="composer__attachments">
            {browserContexts.map((context) => (
              <div
                key={context.id}
                className="attachment-chip attachment-chip--browser-context"
                title={[context.text, context.targetUrl, context.pageUrl].filter(Boolean).join('\n')}
              >
                <span className="browser-context-chip__icon" aria-hidden="true">
                  {context.kind === 'selection' ? 'Aa' : context.kind === 'link' ? '↗' : context.kind === 'image' ? '▧' : '●'}
                </span>
                <span className="attachment-chip__text">
                  <span className="attachment-chip__label">{browserContextLabel(context)}</span>
                  <span className="attachment-chip__detail">
                    {context.kind === 'selection'
                      ? `Selection · tab ${context.tabId ?? '?'}`
                      : compactUrl(context.targetUrl || context.pageUrl) || `Tab ${context.tabId ?? '?'}`}
                  </span>
                </span>
                <button
                  type="button"
                  className="attachment-chip__remove"
                  onClick={() => onRemoveBrowserContext(context.id)}
                  title="Remove browser context"
                  aria-label="Remove browser context"
                >
                  ×
                </button>
              </div>
            ))}
            {attachments.map((att) => (
              <div
                key={att.id}
                className={`attachment-chip${att.kind === 'appshot' ? ' attachment-chip--appshot' : ''}`}
                title={att.kind === 'appshot' ? `${att.title || 'TabShot'}\n${att.url ?? ''}` : att.name}
              >
                <img className="attachment-chip__thumb" src={att.previewUrl} alt="" />
                <span className="attachment-chip__text">
                  <span className="attachment-chip__label">
                    {att.kind === 'appshot' ? att.title || 'TabShot' : att.name}
                  </span>
                  <span className="attachment-chip__detail">
                    {att.kind === 'appshot' ? compactUrl(att.url) || 'Active tab capture' : 'Image'}
                  </span>
                </span>
                <button
                  type="button"
                  className="attachment-chip__remove"
                  onClick={() => onRemoveAttachment(att.id)}
                  title="Remove attachment"
                  aria-label="Remove attachment"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer__input-wrap">
          {mention ? (
            <div className="mention-menu" role="listbox">
              {mentionItems.length > 0 ? (
                mentionItems.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`mention-menu__item${index === selectedMention ? ' mention-menu__item--active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      insertMention(item)
                    }}
                    role="option"
                    aria-selected={index === selectedMention}
                  >
                    <span className={`mention-menu__kind mention-menu__kind--${item.kind}`}>
                      {item.kind === 'tab' ? 'Tab' : item.kind === 'folder' ? 'Dir' : 'File'}
                    </span>
                    <span className="mention-menu__text">
                      <span className="mention-menu__label">{item.label}</span>
                      <span className="mention-menu__detail">{item.detail}</span>
                    </span>
                  </button>
                ))
              ) : (
                <div className="mention-menu__empty">{mentionLoading ? 'Loading…' : 'No matches'}</div>
              )}
            </div>
          ) : null}
          <textarea
            ref={taRef}
            className="composer__textarea"
            // Blank while a suggestion shows: the overlay below is drawing that
            // text, and a placeholder underneath it would double-render.
            placeholder={
              disabled
                ? (disabledReason ??
                  (provider === 'openai' && openaiAuthMode === 'chatgpt'
                    ? 'Sign in with ChatGPT in Settings to start…'
                    : 'Set your API key in Settings to start…'))
                : suggestion
                  ? ''
                  : 'Message the agent…'
            }
            title={
              suggestion
                ? `Suggested next message: ${suggestion}\nTab to put it in the box, Esc to dismiss. Nothing is sent until you press Enter.`
                : 'Enter to send · Shift+Enter for newline'
            }
            value={value}
            rows={1}
            disabled={disabled}
            onChange={onTextareaChange}
            onSelect={onTextareaSelect}
            onKeyDown={onKeyDown}
            onPaste={onTextareaPaste}
          />
          {/* The suggestion itself. `key` on the text so a NEW suggestion
              replays the reveal while ordinary re-renders don't. aria-hidden
              because the textarea's title already carries the full text. */}
          {ghost ? (
            <div
              key={suggestion}
              ref={ghostRef}
              className="composer__ghost"
              style={
                { '--ghost-step': ghost.step, '--ghost-outro': ghost.outro } as React.CSSProperties
              }
            >
              {/* aria-hidden sits on the TEXT, not the wrapper: the wrapper now
                  also holds the accept button, which must stay reachable. */}
              <span className="composer__ghost-text" aria-hidden="true">
                {ghost.groups.map((group, index) =>
                  group.space ? (
                    <span
                      key={index}
                      className="composer__ghost-space"
                      style={{ '--ghost-i': group.start } as React.CSSProperties}
                    >
                      {group.token}
                    </span>
                  ) : (
                    <span key={index} className="composer__ghost-word">
                      {Array.from(group.token).map((char, offset) => (
                        <span
                          key={offset}
                          style={{ '--ghost-i': group.start + offset } as React.CSSProperties}
                        >
                          {char}
                        </span>
                      ))}
                    </span>
                  ),
                )}
              </span>
              {/* Inline, so it lands just past the last word on whichever line
                  that word ended up on — and wraps with the text instead of
                  covering it, which is what the old absolute top-right pin did. */}
              <button
                type="button"
                className="composer__suggest-accept"
                onMouseDown={(e) => {
                  // Keep focus in the textarea: the caret placement assumes it.
                  e.preventDefault()
                  acceptSuggestion()
                }}
                title="Use this suggestion (Tab)"
                aria-label={`Use suggested message: ${suggestion}`}
              >
                <kbd className="composer__suggest-key">⇥ Tab</kbd>
              </button>
            </div>
          ) : null}
        </div>
        <div className="composer__row">
          <ModelPicker
            modelId={modelId}
            provider={provider}
            openaiAuthMode={openaiAuthMode}
            availableProviders={modelProviders}
            onChange={onModelChange}
          />
          <div className="composer__row-spacer" />
          {/* Icon only: the camera reads as "capture" on its own, and the word
              cost ~60px of a ~360px row that the model picker wants. The name
              lives in the tooltip and the accessible name instead. */}
          <button
            type="button"
            className={`icon-btn composer__appshot${appshotBusy ? ' composer__appshot--busy' : ''}`}
            onClick={onAppshot}
            disabled={disabled || appshotBusy}
            title={appshotBusy ? 'Capturing this tab…' : 'TabShot — capture this tab'}
            aria-label={appshotBusy ? 'Capturing this tab…' : 'TabShot — capture this tab'}
          >
            <CameraGlyph />
          </button>
          {isRunning && canSend ? (
            <button
              className="composer__send composer__send--ghost"
              onClick={submit}
              title={
                hasAttachments
                  ? 'Queue this message — attachments send as a follow-up when the turn ends'
                  : 'Message the running turn — attaches after its next tool call'
              }
            >
              Send
            </button>
          ) : null}
          {isRunning && runStartedAt !== undefined ? <ElapsedTimer startedAt={runStartedAt} /> : null}
          {isRunning ? (
            <button className="composer__send composer__send--stop" onClick={onStop}>
              {stopLabel}
            </button>
          ) : (
            <button className="composer__send" onClick={submit} disabled={!canSend}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
})
