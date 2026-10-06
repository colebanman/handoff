/**
 * Transcript item renderers for the Cursor-Glass-style feed.
 *
 * - UserBubble        : the user's message (surface-recipe bubble, right-aligned)
 * - ActivityBlock     : tool calls and thinking as one timeline per run
 *                       (components/Activity.tsx); ToolBody here renders a
 *                       step's expanded input/output (code block for
 *                       sandbox_exec, file pill for VFS paths, screenshot
 *                       images, JSON fallback)
 * - ToolRow           : delegations — SubagentCard (metadata embed, full
 *                       transcript in a modal) and WorkflowCard
 * - AssistantMessage  : streaming markdown (react-markdown + gfm + highlight),
 *                       fenced code rendered via CodeBlock (lang label + copy)
 * - ErrorRow          : danger callout
 * - MemoryChip        : "Remembered X" receipt; opens MEMORY.md
 *
 * Chevron + CodeBlock are shared building blocks. Motion lives in CSS,
 * except the activity timeline's (motion/react, see Activity.tsx).
 *
 * Perf: rows are memoized and the reducer preserves item identity for
 * untouched items, so a streaming delta re-renders only the row it changed.
 * Assistant markdown renders as per-block memoized chunks so a delta re-parses
 * only the trailing block, not the whole document. Callers must pass
 * identity-stable onRevert/onOpenFile or the memoization is defeated.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, memo, isValidElement } from 'react'
import { createPortal } from 'react-dom'
import { fmtDuration } from '../format-duration'
import { toolResultError, toolResultImage } from '../../shared/tool-results'
import ReactMarkdown, { type Components } from 'react-markdown'
import { MARKDOWN_REMARK_PLUGINS, MARKDOWN_REHYPE_PLUGINS } from '../markdown-plugins'
import rehypeHighlight from 'rehype-highlight'
import rehypeMarkdownReveal from '../markdown-reveal'
import rehypeStreamCaret from '../markdown-caret'
import rehypeTableLabels from '../markdown-tables'
import remarkPredictiveMarkdown from '../markdown-predictive'
import { splitMarkdownBlocks } from '../markdown-blocks'
import type {
  AgentId,
  TranscriptItem,
  UserAttachment,
  WorkflowAgentSnapshot,
  WorkflowStatus,
  UserMessageSource,
} from '../../shared/types'
import type { BrowserContextAttachment } from '../../shared/browser-events'
import { artifactNameFromPath, artifactUrl, extractArtifactLinks, isVfsPath } from '../../shared/artifacts'
import { findSecrets, redactSecrets } from '../../shared/redact'
import { describeStep, thoughtLabel } from '../tool-labels'
import { isActiveItem, isActivityTool, type ActivityItem } from '../activity'
import { ActivityBlock, type ActivityRenderers } from './Activity'
import { openMemoryFile } from '../store'
import { formatRemaining } from './RateLimitBanner'
import { useVfsImage } from '../hooks/useVfsImage'
import { settleTranscriptScope } from '../../shared/settle-transcript'
import { useAwaitingModel } from '../hooks/useAwaitingModel'
import { reconcileActivityIdentity, type ActivityIdentity } from '../activity-identity'

/** Live rate-limit wait per agent id (structural subset of the store's ChatRateLimit). */
export interface AgentWait {
  /** Timestamp (ms) when the next retry fires. */
  retryAt: number
  message?: string
  /** Subagent holding its request until the main agent's reply goes through. */
  waitingForMain?: boolean
  kind?: 'rate-limit' | 'connection'
  offline?: boolean
}

export type AgentWaits = Record<AgentId, AgentWait>

/* ---- shared bits -------------------------------------------------- */

export function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      className={`chevron${open ? ' chevron--open' : ''}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


/** Recursively extract plain text from rendered React children (for copy). */
function nodeText(n: React.ReactNode): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(nodeText).join('')
  if (isValidElement(n)) return nodeText((n.props as { children?: React.ReactNode }).children)
  return ''
}

function useCopy(getText: () => string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(getText()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return { copied, copy }
}

/** Code block with a top bar: language label + copy button. No wrapping. */
export function CodeBlock({
  lang,
  tool,
  children,
}: {
  lang?: string
  tool?: boolean
  children: React.ReactNode
}): React.ReactElement {
  const { copied, copy } = useCopy(() => nodeText(children))
  return (
    <div className={`code-block${tool ? ' code-block--tool' : ''}`}>
      <div className="code-block__bar">
        <span className="code-block__lang">{lang ?? 'code'}</span>
        <button className="code-block__copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/* ---- item renderers ----------------------------------------------- */

function ItemActions({
  itemId,
  copyText,
  onRevert,
}: {
  itemId: string
  copyText?: string
  onRevert?: (itemId: string) => void
}): React.ReactElement | null {
  const { copied, copy } = useCopy(() => copyText ?? '')
  if (!onRevert && !copyText) return null
  return (
    <div className="item-actions">
      {copyText ? (
        <button
          className="item-action"
          onClick={copy}
          title={copied ? 'Copied' : 'Copy message'}
          aria-label={copied ? 'Message copied' : 'Copy message'}
        >
          {copied ? <ActionCheckGlyph /> : <CopyGlyph />}
        </button>
      ) : null}
      {onRevert ? (
        <button
          className="item-action"
          onClick={() => onRevert(itemId)}
          title="Revert to this point"
          aria-label="Revert to this point"
        >
          <RevertGlyph />
        </button>
      ) : null}
    </div>
  )
}

function CopyGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.35" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.75 3.75v-.5A1.25 1.25 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6a1.25 1.25 0 0 0 1.25 1.25h.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function RevertGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.25 4.25H9a4 4 0 1 1-3.65 5.64" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="m5.25 1.9-2.4 2.35 2.4 2.35" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ActionCheckGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.25 8.25 3 3 6.5-6.5" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const USER_CLAMP_CHARS = 500

function compactAttachmentUrl(url?: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

/**
 * File embedded in a sent user message. Images are re-read from the
 * VFS by path; appshots get a caption bar with the captured tab's title + URL.
 * Clicking opens the file in the file panel.
 */
const AttachmentEmbed = memo(function AttachmentEmbed({
  attachment,
  onOpenFile,
}: {
  attachment: UserAttachment
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const isFile = attachment.kind === 'file'
  const { src, failed } = useVfsImage(isFile ? '' : attachment.path)
  const isAppshot = attachment.kind === 'appshot'
  const label = isAppshot ? attachment.title || 'TabShot' : attachment.name
  return (
    <button
      type="button"
      className={`attachment-embed${isAppshot ? ' attachment-embed--appshot' : ''}${isFile ? ' attachment-embed--file' : ''}`}
      onClick={onOpenFile ? () => onOpenFile(attachment.path) : undefined}
      title={`Open ${attachment.name}`}
    >
      {isFile ? (
        <span className="attachment-embed__file-icon" aria-hidden="true">📄</span>
      ) : src ? (
        <img className="attachment-embed__img" src={src} alt={label} loading="lazy" />
      ) : (
        <span className="attachment-embed__missing">{failed ? 'Image no longer in workspace' : 'Loading…'}</span>
      )}
      {isFile ? (
        <span className="attachment-embed__file-name">{attachment.name}</span>
      ) : isAppshot ? (
        <span className="attachment-embed__caption">
          <span className="attachment-embed__badge">
            <CameraGlyph />
            TabShot
          </span>
          <span className="attachment-embed__text">
            <span className="attachment-embed__title">{label}</span>
            {attachment.url ? <span className="attachment-embed__url">{compactAttachmentUrl(attachment.url)}</span> : null}
          </span>
        </span>
      ) : null}
    </button>
  )
})

const BrowserContextEmbed = memo(function BrowserContextEmbed({
  context,
}: {
  context: BrowserContextAttachment
}): React.ReactElement {
  const label = context.text || context.title || context.targetUrl || context.pageUrl || 'Browser context'
  const detail = context.targetUrl || context.pageUrl
  return (
    <div className="browser-context-embed" title={[context.text, context.targetUrl, context.pageUrl].filter(Boolean).join('\n')}>
      <span className="browser-context-embed__badge">
        {context.kind === 'selection' ? 'Aa' : context.kind === 'link' ? 'Link' : context.kind === 'image' ? 'Image' : 'Page'}
      </span>
      <span className="browser-context-embed__text">
        <span className="browser-context-embed__title">{label}</span>
        {detail ? <span className="browser-context-embed__url">{compactAttachmentUrl(detail)}</span> : null}
      </span>
      {context.tabId !== undefined ? <span className="browser-context-embed__tab">Tab {context.tabId}</span> : null}
    </div>
  )
})

export function CameraGlyph(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5.5 4 6.6 2.5h2.8L10.5 4H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 3 4h2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8.2" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export const UserBubble = memo(function UserBubble({
  id,
  text,
  steered,
  pending,
  attachments,
  contexts,
  source,
  onRevert,
  onOpenFile,
}: {
  id: string
  text: string
  /** Message attached mid-turn: user → main agent, or main agent → subagent. */
  steered?: boolean
  /** Steering the model hasn't received yet (synthetic feed item; no actions). */
  pending?: boolean
  attachments?: UserAttachment[]
  contexts?: BrowserContextAttachment[]
  /** Programmatic prompt (an artifact's ai.invoke) rather than typed by the user. */
  source?: UserMessageSource
  onRevert?: (itemId: string) => void
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const clampable = text.length > USER_CLAMP_CHARS || text.split('\n').length > 8
  const [expanded, setExpanded] = useState(!clampable)
  return (
    <div className={`item item--user${pending ? ' item--user-pending' : ''}`}>
      {source?.kind === 'artifact' ? (
        <a
          className="steer-chip steer-chip--artifact"
          href={artifactUrl(source.path)}
          target="_blank"
          rel="noreferrer"
          title={`Sent by ${source.path} via ai.invoke()`}
        >
          ⚡ from artifact {artifactNameFromPath(source.path)}
        </a>
      ) : source?.kind === 'automation' ? (
        <div className="steer-chip steer-chip--automation" title={`Scheduled run of automation ${source.id}`}>
          ⏰ automation · {source.title}
        </div>
      ) : null}
      {steered ? (
        <div className="steer-chip">{pending ? '⋯ will steer at the next step' : '↪ steered mid-task'}</div>
      ) : null}
      {attachments && attachments.length > 0 ? (
        <div className="attachment-embeds">
          {attachments.map((att) => (
            <AttachmentEmbed key={att.id} attachment={att} onOpenFile={onOpenFile} />
          ))}
        </div>
      ) : null}
      {contexts && contexts.length > 0 ? (
        <div className="browser-context-embeds">
          {contexts.map((context) => <BrowserContextEmbed key={context.id} context={context} />)}
        </div>
      ) : null}
      {text ? (
        <div
          className={`user-bubble${steered ? ' user-bubble--steer' : ''}${clampable && !expanded ? ' user-bubble--clamped' : ''}`}
          onClick={clampable && !expanded ? () => setExpanded(true) : undefined}
          title={clampable && !expanded ? 'Show full message' : undefined}
        >
          <span className="user-bubble__text">{text}</span>
          {pending ? null : <ItemActions itemId={id} copyText={text} onRevert={onRevert} />}
        </div>
      ) : pending ? null : (
        <ItemActions itemId={id} copyText={text} onRevert={onRevert} />
      )}
    </div>
  )
})

/** Pretty-print a value for the tool body. */
function prettyValue(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function MarkdownLink({
  href,
  children,
  onOpenFile,
  node: _node,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { onOpenFile?: (path: string) => void; node?: unknown }): React.ReactElement {
  if (href && isVfsPath(href)) {
    // href stays the artifact URL so middle-click and ctrl/cmd/shift-click
    // still open the artifact view in a new tab natively; a plain left click
    // opens the in-panel file sheet instead (same pattern as FilePill).
    return (
      <a
        {...props}
        href={artifactUrl(href)}
        target="_blank"
        rel="noreferrer"
        onClick={
          onOpenFile
            ? (e) => {
                if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
                e.preventDefault()
                onOpenFile(href)
              }
            : undefined
        }
      >
        {children}
      </a>
    )
  }
  return (
    <a {...props} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

/** Fenced code -> CodeBlock with language label + copy button. */
function MarkdownPre({ children }: React.HTMLAttributes<HTMLPreElement>): React.ReactElement {
  const child = Array.isArray(children) ? children[0] : children
  if (isValidElement(child)) {
    const props = child.props as { className?: string }
    const lang = /language-([\w-]+)/.exec(props.className ?? '')?.[1]
    return <CodeBlock lang={lang}>{child}</CodeBlock>
  }
  return <pre>{children}</pre>
}

function normalizeArtifactLinks(text: string): string {
  return text.replace(/\(([^)\n]+)\)\[((?:\/workspace|\/skills)\/[^\]\n]+)\]/g, '[$1]($2)')
}

interface ToolItem extends Extract<TranscriptItem, { kind: 'tool' }> {}

/** Draggable/clickable file pill: click previews in the sheet, drag attaches. */
function FilePill({ path, onOpenFile }: { path: string; onOpenFile?: (path: string) => void }): React.ReactElement {
  return (
    <a
      className="file-pill"
      href={artifactUrl(path)}
      target="_blank"
      rel="noreferrer"
      draggable
      title={`${path} — click to preview, drag into the message to attach`}
      onClick={
        onOpenFile
          ? (e) => {
              e.preventDefault()
              onOpenFile(path)
            }
          : undefined
      }
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', ` @file(${path}) `)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      {path}
    </a>
  )
}

/** Plain-string renderer with click-to-reveal chips over any detected secret span. */
function RedactedText({ text }: { text: string }): React.ReactElement {
  const matches = useMemo(() => findSecrets(text), [text])
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set())
  if (matches.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let cursor = 0
  matches.forEach((m, i) => {
    if (m.start > cursor) parts.push(text.slice(cursor, m.start))
    const isRevealed = revealed.has(i)
    parts.push(
      <button
        key={`redact-${i}`}
        type="button"
        className="redact-chip"
        title={isRevealed ? 'Click to hide' : `Click to reveal ${m.kind}`}
        onClick={() =>
          setRevealed((prev) => {
            const next = new Set(prev)
            if (isRevealed) next.delete(i)
            else next.add(i)
            return next
          })
        }
      >
        {isRevealed ? text.slice(m.start, m.end) : `[redacted:${m.kind}…${m.last4}]`}
      </button>,
    )
    cursor = m.end
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

/** Rich body for an expanded tool row: per-tool renderer + JSON fallback. */
function ToolBody({ item, onOpenFile }: { item: ToolItem; onOpenFile?: (path: string) => void }): React.ReactElement {
  // Memoized: stringifying a large input/output on every streaming frame while
  // the row is open is the expensive part of heavy tool params.
  const img = useMemo(() => toolResultImage(item.output), [item.output])
  const outText = useMemo(() => img ? '' : prettyValue(item.output), [img, item.output])
  const bodyText = useMemo(
    () => prettyValue(item.input ?? (item.inputText || undefined)),
    [item.input, item.inputText],
  )

  // sandbox_exec: input is code -> code block; string output -> mono block
  if (item.toolName === 'sandbox_exec') {
    const code = item.input && typeof item.input === 'object' ? (item.input as { code?: unknown }).code : undefined
    return (
      <div className="crow__body">
        {typeof code === 'string' && code ? (
          <div className="tool-body__block">
            <div className="tool-body__label">code</div>
            <CodeBlock lang="js" tool>
              <code>{code}</code>
            </CodeBlock>
          </div>
        ) : null}
        {img ? <img className="tool-body__img" src={img} alt="screenshot" /> : outText ? (
          <div className="tool-body__block">
            <div className="tool-body__label">output</div>
            <pre className="tool-body__pre"><RedactedText text={outText} /></pre>
          </div>
        ) : null}
      </div>
    )
  }

  // filesystem tools: link the path as a file pill when it's a VFS path
  const path =
    item.input && typeof item.input === 'object' ? (item.input as { path?: unknown }).path : undefined
  const filePill =
    typeof path === 'string' && isVfsPath(path) ? (
      <div className="tool-body__block">
        <FilePill path={path} onOpenFile={onOpenFile} />
      </div>
    ) : null

  return (
    <div className="crow__body">
      {filePill}
      {bodyText ? (
        <div className="tool-body__block">
          <div className="tool-body__label">input</div>
          <pre className="tool-body__pre"><RedactedText text={bodyText} /></pre>
        </div>
      ) : null}
      {img ? (
        <div className="tool-body__block">
          <div className="tool-body__label">output</div>
          <img className="tool-body__img" src={img} alt="screenshot" />
        </div>
      ) : outText ? (
        <div className="tool-body__block">
          <div className="tool-body__label">output</div>
          <pre className="tool-body__pre"><RedactedText text={outText} /></pre>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Live wait note under a subagent delegation row: "waiting for main agent
 * reply" while the subagent yields its rate-limited request to the main agent,
 * otherwise a retry countdown. When a model override is active, the note says
 * so — so a switch never looks like a silent no-op.
 */
function SubagentWaitNote({
  wait,
  modelBadge,
}: {
  wait: AgentWait
  modelBadge?: string
}): React.ReactElement {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (wait.waitingForMain) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [wait.waitingForMain, wait.retryAt])
  const remaining = wait.retryAt - now
  const text = wait.waitingForMain
    ? 'Rate limited — waiting for main agent reply'
    : wait.kind === 'connection'
      ? wait.offline ? 'Connection lost — waiting to reconnect' : `Connection interrupted — ${remaining > 0 ? `retrying in ${formatRemaining(remaining)}` : 'retrying now…'}`
    : modelBadge
      ? `Switching to ${modelBadge}…`
      : `Rate limited — ${remaining > 0 ? `retrying in ${formatRemaining(remaining)}` : 'retrying now…'}`
  return (
    <div className={`crow__note${modelBadge ? ' crow__note--switch' : ''}`} role="status" title={wait.message}>
      <span className="crow__note-dot" aria-hidden="true" />
      {text}
    </div>
  )
}

export const ToolRow = memo(function ToolRow({
  item,
  agentWaits,
  subagentModelBadge,
  onOpenFile,
}: {
  item: ToolItem
  agentWaits?: AgentWaits
  /** Session model override label for running subagent cards (e.g. "Grok"). */
  subagentModelBadge?: string
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const childWait =
    item.childAgentId && item.childStatus === 'running' ? agentWaits?.[item.childAgentId] : undefined

  if (item.toolName === 'workflow_run' || item.workflow) {
    return <WorkflowCard item={item} onOpenFile={onOpenFile} />
  }

  // Delegations render as a metadata card (title + live activity), full
  // transcript in a modal on click — never as an inline nested feed.
  if (item.toolName === 'subagent_spawn' || item.childAgentId !== undefined || item.childItems !== undefined) {
    return (
      <SubagentCard
        item={item}
        wait={childWait}
        modelBadge={subagentModelBadge}
        onOpenFile={onOpenFile}
      />
    )
  }

  // Plain calls arrive inside activity blocks; one rendered alone gets its own.
  return (
    <ActivityBlock
      items={[item]}
      live={item.status === 'running'}
      pending={false}
      renderers={ACTIVITY_RENDERERS}
      onOpenFile={onOpenFile}
    />
  )
})

/**
 * One-line summary of the subagent's latest activity, for the card. `key`
 * identifies the *step* producing the text (item id + tool status) — the
 * card keys its crossfade on it, so the animation replays when the agent
 * moves to a new step, not on every streamed token of the current one.
 * A running agent with nothing in progress is between steps: "Thinking…".
 */
export function subagentTail(items: TranscriptItem[], running = false): { text: string; key: string } {
  if (running && items.length > 0 && !items.some(isActiveItem)) {
    return { text: 'Thinking…', key: `pause:${items[items.length - 1]!.id}` }
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === 'text') {
      const t = it.text.trim()
      if (t) return { text: t, key: it.id }
      if (it.streaming) return { text: 'Writing…', key: it.id }
    } else if (it.kind === 'reasoning') {
      if (!it.text.trim() && !it.streaming) continue
      const { label, placeholder } = thoughtLabel(it.text, it.streaming, it.durationMs)
      return { text: placeholder ? 'Thinking…' : label, key: placeholder ? it.id : `${it.id}:${label}` }
    } else if (it.kind === 'tool') {
      const view = describeStep(it)
      const text = view.placeholder ? 'Thinking…' : view.detail ? `${view.label} ${view.detail}` : view.label
      return { text, key: `${it.id}:${it.status}` }
    } else if (it.kind === 'error') {
      return { text: it.message, key: it.id }
    }
  }
  return { text: '', key: 'empty' }
}

function Spinner(): React.ReactElement {
  return <span className="spinner" role="status" aria-label="running" />
}

function CheckGlyph(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
      <path d="M4.4 7.2 6.2 9 9.6 5.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CrossGlyph(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
      <path d="M4.8 4.8 9.2 9.2 M9.2 4.8 4.8 9.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** First line of the delegated task, trimmed for the card title. */
function subagentTitle(input: unknown, inputText?: string): string {
  const task =
    input && typeof input === 'object' && typeof (input as { task?: unknown }).task === 'string'
      ? ((input as { task: string }).task)
      : inputText ?? ''
  const line = task.split('\n')[0]!.trim()
  if (!line) return 'Subagent'
  return line.length > 80 ? line.slice(0, 80) + '…' : line
}

function compactTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`
  return `${Math.round(tokens / 100_000) / 10}m`
}

function workflowTitle(item: ToolItem): string {
  if (item.workflow?.meta.title) return item.workflow.meta.title
  if (item.input && typeof item.input === 'object' && typeof (item.input as { title?: unknown }).title === 'string') {
    return (item.input as { title: string }).title
  }
  return 'Dynamic workflow'
}

/** Sentence-case status word — the UI never surfaces a raw status string. */
function statusWord(status: WorkflowStatus): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'done':
      return 'Done'
    case 'cancelled':
      return 'Stopped'
    case 'orphaned':
      return 'Interrupted'
    default:
      return 'Failed'
  }
}

/** Every status collapses onto the three tones the glyphs and pills have. */
function statusTone(status: WorkflowStatus): 'running' | 'done' | 'error' {
  return status === 'running' ? 'running' : status === 'done' ? 'done' : 'error'
}

/**
 * Markdown → one line of prose. Agent tails and workflow logs are raw model
 * output, so an unprocessed preview reads "## Scenario: Compare project-…"
 * with the syntax still in it.
 */
function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^\s{0,3}[#>]+\s*/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Dim `a · b · c` run of facts. One line of separated segments replaces what
 * would otherwise be a stack of labelled rows or a grid of stat tiles; falsy
 * parts drop out, so counts appear only once they mean something.
 */
function MetaLine({ className, parts }: { className?: string; parts: React.ReactNode[] }): React.ReactElement {
  const shown = parts.filter(Boolean)
  return (
    <span className={className ? `workflow-meta ${className}` : 'workflow-meta'}>
      {shown.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span className="workflow-meta__sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {part}
        </Fragment>
      ))}
    </span>
  )
}

function useElapsed(startedAt: number, endedAt: number | undefined, running: boolean): string {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  return fmtDuration(Math.max(0, (endedAt ?? Date.now()) - startedAt))
}

/**
 * Workflow embed: the same two-line card recipe as a delegation (status glyph,
 * title, one dim meta line) so a workflow reads as a sibling of the rows around
 * it rather than a differently-designed panel. Per-phase progress, agent
 * transcripts, logs and the raw result all live behind the click.
 */
function WorkflowCard({
  item,
  onOpenFile,
}: {
  item: ToolItem
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false)
  const [selectedCallId, setSelectedCallId] = useState<string>()
  const workflow = item.workflow
  const status: WorkflowStatus = workflow?.status ?? (item.status === 'error' ? 'error' : 'running')
  const running = status === 'running'
  const title = workflowTitle(item)
  const agents = workflow?.agents ?? []
  const completed = agents.filter((agent) => agent.status !== 'running').length
  const tokens = workflow?.usage.totalTokens ?? agents.reduce((sum, agent) => sum + (agent.usage?.totalTokens ?? 0), 0)
  const phase = workflow?.meta.phases?.find((candidate) => candidate.id === workflow.currentPhaseId)
  const lastLog = workflow?.logs[workflow.logs.length - 1]?.message
  const currentAgent = [...agents].reverse().find((agent) => agent.status === 'running')
  const activity =
    plainPreview(phase?.title ?? lastLog ?? currentAgent?.label ?? '') ||
    (running ? 'Preparing workflow…' : statusWord(status))
  const startedAt = workflow?.startedAt ?? item.at
  const elapsed = useElapsed(startedAt, workflow?.endedAt, running)

  useEffect(() => {
    if (!modalOpen) setSelectedCallId(undefined)
  }, [modalOpen])

  return (
    <div className="item workflow">
      <button
        className={`workflow-card workflow-card--${statusTone(status)}`}
        onClick={() => setModalOpen(true)}
        aria-label={`Workflow: ${title} — ${statusWord(status)}, ${completed} of ${agents.length} agents complete`}
        title="Open workflow details"
      >
        <span className={`subagent-card__status subagent-card__status--${statusTone(status)}`} aria-hidden="true">
          {running ? <Spinner /> : status === 'done' ? <CheckGlyph /> : <CrossGlyph />}
        </span>
        <span className="workflow-card__main">
          <span className="workflow-card__title">{title}</span>
          <MetaLine
            parts={[
              'Workflow',
              agents.length ? (
                <>
                  <b>
                    {completed}/{agents.length}
                  </b>{' '}
                  agents
                </>
              ) : null,
              tokens ? (
                <>
                  <b>{compactTokens(tokens)}</b> tokens
                </>
              ) : null,
              <span className={running ? 'shine' : undefined}>{activity}</span>,
            ]}
          />
        </span>
        <span className="workflow-card__trailing">{elapsed}</span>
      </button>
      {modalOpen ? (
        <WorkflowModal
          item={item}
          selectedCallId={selectedCallId}
          onSelectAgent={setSelectedCallId}
          onBack={() => setSelectedCallId(undefined)}
          onClose={() => setModalOpen(false)}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </div>
  )
}

function WorkflowModal({
  item,
  selectedCallId,
  onSelectAgent,
  onBack,
  onClose,
  onOpenFile,
}: {
  item: ToolItem
  selectedCallId?: string
  onSelectAgent: (callId: string) => void
  onBack: () => void
  onClose: () => void
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const workflow = item.workflow
  const agents = workflow?.agents ?? []
  const selected = agents.find((agent) => agent.callId === selectedCallId)
  const status: WorkflowStatus = workflow?.status ?? 'running'
  const running = status === 'running'
  const completed = agents.filter((agent) => agent.status !== 'running').length
  const tokens = workflow?.usage.totalTokens ?? 0
  const startedAt = workflow?.startedAt ?? item.at
  // Ticks once a second while running, which is also what refreshes the
  // per-agent durations below.
  const elapsed = useElapsed(startedAt, workflow?.endedAt, running)
  const logs = workflow?.logs ?? []
  const lastLog = logs[logs.length - 1]?.message
  const headStatus: WorkflowStatus = selected ? selected.status : status

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (selectedCallId) onBack()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, onClose, selectedCallId])

  const declared = workflow?.meta.phases ?? []
  const phaseIds = [
    ...declared.map((phase) => phase.id),
    ...agents.map((agent) => agent.phaseId).filter((id): id is string => Boolean(id && !declared.some((phase) => phase.id === id))),
  ]
  const uniquePhaseIds = [...new Set(phaseIds)]
  const hasUnphased = agents.some((agent) => !agent.phaseId)

  return createPortal(
    <div className="modal-scrim" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="workflow-modal" role="dialog" aria-modal="true" aria-label={`Workflow: ${workflowTitle(item)}`}>
        <div className="workflow-modal__header">
          {selected ? (
            <button
              className="icon-btn workflow-modal__back"
              onClick={onBack}
              title={`Back to ${workflowTitle(item)}`}
              aria-label="Back to workflow"
            >
              ←
            </button>
          ) : (
            <span className={`subagent-card__status subagent-card__status--${statusTone(status)}`} aria-hidden="true">
              {running ? <Spinner /> : status === 'done' ? <CheckGlyph /> : <CrossGlyph />}
            </span>
          )}
          <span className="workflow-modal__title" title={selected?.label ?? workflowTitle(item)}>
            {selected?.label ?? workflowTitle(item)}
          </span>
          <span className={`status-pill status-pill--${statusTone(headStatus)}`}>{statusWord(headStatus)}</span>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">✕</button>
        </div>

        {selected ? (
          <div className="workflow-modal__agent-body">
            <div className="workflow-agent__prompt">{selected.prompt}</div>
            {selected.items.length > 0 ? (
              <SubagentModalFeed items={selected.items} streaming={selected.status === 'running'} onOpenFile={onOpenFile} />
            ) : (
              <div className="feed__empty">{selected.status === 'running' ? 'Waiting for the agent’s first step…' : 'No activity recorded.'}</div>
            )}
          </div>
        ) : (
          <div className="workflow-modal__body">
            <div className="workflow-modal__summary">
              <p className="workflow-modal__description">{workflow?.meta.description ?? 'Dynamic multi-agent workflow'}</p>
              <MetaLine
                parts={[
                  <>
                    <b>{agents.length}</b> agents
                  </>,
                  agents.length ? (
                    <>
                      <b>
                        {completed}/{agents.length}
                      </b>{' '}
                      done
                    </>
                  ) : null,
                  tokens ? (
                    <>
                      <b>{compactTokens(tokens)}</b> tokens
                    </>
                  ) : null,
                  <>
                    <b>{elapsed}</b> elapsed
                  </>,
                ]}
              />
            </div>

            {running && lastLog ? (
              <div className="crow__note workflow-modal__note" role="status">
                <span className="crow__note-dot" aria-hidden="true" />
                <span className="workflow-modal__note-text">{plainPreview(lastLog)}</span>
              </div>
            ) : null}

            <div className="workflow-phases">
              {uniquePhaseIds.map((phaseId, index) => {
                const definition = declared.find((phase) => phase.id === phaseId)
                const phaseAgents = agents.filter((agent) => agent.phaseId === phaseId)
                return (
                  <WorkflowPhase
                    key={phaseId}
                    index={index}
                    title={definition?.title ?? phaseId}
                    description={definition?.description}
                    agents={phaseAgents}
                    onSelectAgent={onSelectAgent}
                  />
                )
              })}
              {hasUnphased || uniquePhaseIds.length === 0 ? (
                <WorkflowPhase
                  index={uniquePhaseIds.length}
                  title={uniquePhaseIds.length ? 'Other agents' : 'Agents'}
                  agents={agents.filter((agent) => !agent.phaseId)}
                  onSelectAgent={onSelectAgent}
                />
              ) : null}
            </div>

            {workflow?.error ? <p className="workflow-error">{workflow.error}</p> : null}

            {/* Side content sits behind house collapsibles: the full log and the
             * raw result are worth keeping, but not worth the screen they take
             * open by default. */}
            {logs.length > 1 ? (
              <Disclosure label="Activity log" trailing={`${logs.length} entries`}>
                <ol className="workflow-log">
                  {logs.map((entry, index) => (
                    <li key={`${entry.at}-${index}`}>
                      <span className="workflow-log__at">+{fmtDuration(Math.max(0, entry.at - startedAt))}</span>
                      <span className="workflow-log__msg">{plainPreview(entry.message)}</span>
                    </li>
                  ))}
                </ol>
              </Disclosure>
            ) : null}
            {workflow?.result ? (
              <Disclosure label="Result">
                <pre className="workflow-result">{prettyJson(workflow.result)}</pre>
              </Disclosure>
            ) : null}
            {workflow?.sourcePath ? (
              <div className="workflow-modal__source">
                <FilePill path={workflow.sourcePath} onOpenFile={onOpenFile} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * One numbered step of the workflow. The rail number carries the phase's own
 * state (pending / running / complete), so progress reads down the left edge
 * without a per-phase badge.
 */
function WorkflowPhase({
  index,
  title,
  description,
  agents,
  onSelectAgent,
}: {
  index: number
  title: string
  description?: string
  agents: WorkflowAgentSnapshot[]
  onSelectAgent: (callId: string) => void
}): React.ReactElement {
  const done = agents.filter((agent) => agent.status !== 'running').length
  const state = agents.length === 0 ? 'pending' : done === agents.length ? 'done' : 'running'
  // "parallel" is a property of the batch, not of each agent: one note on the
  // phase says what three badges down the list used to.
  const parallel = agents.some(
    (agent) => agent.batchId && agents.some((other) => other !== agent && other.batchId === agent.batchId),
  )
  return (
    <section className={`workflow-phase workflow-phase--${state}`}>
      <div className="workflow-phase__rail" aria-hidden="true">
        <span>{index + 1}</span>
      </div>
      <div className="workflow-phase__content">
        <div className="workflow-phase__header">
          <strong>{title}</strong>
          <MetaLine
            className="workflow-phase__count"
            parts={[parallel ? 'parallel' : null, agents.length ? `${done}/${agents.length}` : null]}
          />
        </div>
        {description ? <p className="workflow-phase__desc">{description}</p> : null}
        <WorkflowAgentList agents={agents} onSelect={onSelectAgent} />
      </div>
    </section>
  )
}

/** One row per agent — full width, so long labels and tails stay readable. */
function WorkflowAgentList({
  agents,
  onSelect,
}: {
  agents: WorkflowAgentSnapshot[]
  onSelect: (callId: string) => void
}): React.ReactElement {
  if (agents.length === 0) return <p className="workflow-phase__empty">Waiting for agents…</p>
  return (
    <div className="workflow-agent-list">
      {agents.map((agent) => {
        const tail = plainPreview(subagentTail(agent.items).text)
        const tokens = agent.usage?.totalTokens ?? 0
        return (
          <button
            key={agent.callId}
            className={`workflow-agent workflow-agent--${agent.status}`}
            onClick={() => onSelect(agent.callId)}
            title={`${agent.label} — open transcript`}
          >
            <span className={`workflow-agent__dot workflow-agent__dot--${agent.status}`} aria-hidden="true" />
            <span className="workflow-agent__main">
              <strong>{agent.label}</strong>
              <small>{tail || (agent.status === 'running' ? 'Starting…' : statusWord(agent.status))}</small>
            </span>
            <MetaLine
              className="workflow-agent__meta"
              parts={[
                tokens ? compactTokens(tokens) : null,
                fmtDuration(Math.max(0, (agent.endedAt ?? Date.now()) - agent.startedAt)),
              ]}
            />
          </button>
        )
      })}
    </div>
  )
}

/** Collapsed-by-default side content, using the feed's own collapsible chrome. */
function Disclosure({
  label,
  trailing,
  children,
}: {
  label: string
  trailing?: string
  children: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="crow workflow-disclosure">
      <button className="crow__header" onClick={() => setOpen((prev) => !prev)} aria-expanded={open}>
        <Chevron open={open} />
        <span className="crow__verb">{label}</span>
        {trailing ? <span className="crow__trailing">{trailing}</span> : null}
      </button>
      {open ? <div className="crow__body">{children}</div> : null}
    </div>
  )
}

/** Workflow results are usually JSON strings; indent them if they parse. */
function prettyJson(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

/**
 * Delegation embed: metadata card showing the task title + the subagent's
 * live activity (latest tool call / thinking tail), with a spinner and a
 * breathing border while running. Click opens the full transcript in a
 * modal styled like the main chat view.
 */
export function SubagentCard({
  item,
  wait,
  modelBadge,
  onOpenFile,
}: {
  item: ToolItem
  wait?: AgentWait
  /** Shown while running when a session override redirected this agent (e.g. "Grok"). */
  modelBadge?: string
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false)
  const spawnError = toolResultError(item.output)?.message ??
    (item.status === 'error' && typeof item.output === 'string' ? item.output : undefined)
  const status: 'running' | 'done' | 'error' =
    item.childStatus ?? (item.status === 'error' || spawnError ? 'error' : item.status === 'running' ? 'running' : 'done')
  const running = status === 'running'
  // Persisted transcripts from older builds may still have streaming flags
  // after a terminal task update. The card's terminal state is authoritative.
  const items = useMemo(() => {
    const childItems = running ? item.childItems ?? [] : settleTranscriptScope(item.childItems ?? [])
    // A spawn rejected before agent-start has no child transcript. Include
    // its tool error so the card and modal both explain the failure.
    if (status === 'error' && spawnError && !childItems.some((child) => child.kind === 'error')) {
      return [...childItems, {
        kind: 'error' as const, id: `${item.id}:spawn-error`,
        agentId: item.childAgentId ?? item.agentId, message: spawnError, at: item.at,
      }]
    }
    return childItems
  }, [item.childItems, item.id, item.childAgentId, item.agentId, item.at, running, status, spawnError])
  const title = subagentTitle(item.input, item.inputText)
  const tail = subagentTail(items, running)
  const failure = status === 'error' ? items.filter((child) => child.kind === 'error').at(-1) : undefined
  const activity = redactSecrets(failure?.message || tail.text || (running ? (item.childAgentId ? 'Thinking…' : 'Starting agent…') : status === 'error' ? 'Failed' : 'Done'))
  // Step identity, not text: keying on the text would remount (and replay the
  // enter animation of) the activity line on every streamed token.
  const activityKey = tail.text ? tail.key : status
  const showModelBadge = Boolean(modelBadge && running)

  return (
    <div className="item subagent">
      <button
        className={`subagent-card subagent-card--${status}`}
        onClick={() => setModalOpen(true)}
        title={
          status === 'error'
            ? `${activity} · Open subagent transcript`
            : showModelBadge
            ? `Open subagent transcript · running on ${modelBadge}`
            : 'Open subagent transcript'
        }
      >
        <span className={`subagent-card__status subagent-card__status--${status}`} aria-hidden="true">
          {running ? <Spinner /> : status === 'error' ? <CrossGlyph /> : <CheckGlyph />}
        </span>
        <span className="subagent-card__main">
          <span className="subagent-card__title">{title}</span>
          {wait ? (
            <SubagentWaitNote wait={wait} modelBadge={showModelBadge ? modelBadge : undefined} />
          ) : (
            <span key={activityKey} className={`subagent-card__activity${running ? ' shine' : ''}`} title={activity}>
              {activity}
            </span>
          )}
        </span>
        <span className="subagent-card__trailing">
          {showModelBadge ? <span className="subagent-card__model">{modelBadge}</span> : null}
          {item.childItems?.length ? `${item.childItems.length} step${item.childItems.length === 1 ? '' : 's'}` : null}
        </span>
      </button>
      {modalOpen ? (
        <SubagentModal
          title={title}
          status={status}
          items={items}
          onClose={() => setModalOpen(false)}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </div>
  )
}

/** Full subagent chat view in a modal — same transcript renderer as the main feed. */
function SubagentModal({
  title,
  status,
  items,
  onClose,
  onOpenFile,
}: {
  title: string
  status: 'running' | 'done' | 'error'
  items: TranscriptItem[]
  onClose: () => void
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const running = status === 'running'
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Portaled to <body>: rendered in place, the position:fixed scrim would be
  // trapped by any transformed/animated ancestor (feed items animate in).
  return createPortal(
    <div
      className="modal-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="subagent-modal" role="dialog" aria-modal="true" aria-label={`Subagent: ${title}`}>
        <div className="subagent-modal__header">
          <span className={`subagent-card__status subagent-card__status--${status}`} aria-hidden="true">
            {running ? <Spinner /> : status === 'error' ? <CrossGlyph /> : <CheckGlyph />}
          </span>
          <span className="subagent-modal__title">{title}</span>
          <span className={`status-pill status-pill--${status}`}>
            {running ? 'Running' : status === 'error' ? 'Failed' : 'Done'}
          </span>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="subagent-modal__body">
          {items.length === 0 ? (
            <div className="feed__empty">{running ? 'Waiting for the agent’s first step…' : 'No activity recorded.'}</div>
          ) : (
            <SubagentModalFeed items={items} streaming={running} onOpenFile={onOpenFile} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Auto-following scroller for the modal transcript (same pin behavior as Feed). */
function SubagentModalFeed({
  items,
  streaming,
  onOpenFile,
}: {
  items: TranscriptItem[]
  streaming: boolean
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const pending = useAwaitingModel(items, streaming)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items, pending])
  // Timeline rows ease open between renders; stay pinned through that too.
  useEffect(() => {
    const el = scrollerRef.current
    const inner = innerRef.current
    if (!el || !inner || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])
  const onScroll = (): void => {
    const el = scrollerRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40
  }
  return (
    <div className="feed" ref={scrollerRef} onScroll={onScroll}>
      <div className="feed__inner" ref={innerRef}>
        <TranscriptList items={items} streaming={streaming} pending={pending} onOpenFile={onOpenFile} />
      </div>
    </div>
  )
}

/* ---- Activity blocks -----------------------------------------------
 * Consecutive tool calls and thinking (no prose between, no delegation
 * cards) render as one ActivityBlock — see Activity.tsx. Prose that hasn't
 * produced a word yet doesn't split a run. When the turn is running and
 * nothing is progressing, the newest block ends in a Thinking row (after
 * prose, a fresh block opens for it). Blocks retain their identity, so the
 * step that ends a pause lands in the very block that showed the Thinking
 * row, in the same slot. Identity follows the block's members across retry
 * removals and history edits; position alone can remount unrelated activity.
 * ------------------------------------------------------------------- */

/** A thought's full text, as markdown (summary parts arrive as bold headlines and lists). */
function ThoughtMarkdown({ text }: { text: string }): React.ReactElement {
  return <MarkdownBlock text={text} />
}

/** What the timeline renders inside rows; a module constant so rows stay memoized. */
const ACTIVITY_RENDERERS: ActivityRenderers = { ToolBody, Markdown: ThoughtMarkdown }

/**
 * Element-wise array equality. The grouping pass rebuilds entry arrays every
 * render, but the reducer preserves the identity of untouched items — so
 * comparing elements (not the array) lets lists skip re-rendering when
 * nothing inside them changed.
 */
function sameItems(a: readonly TranscriptItem[], b: readonly TranscriptItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

type FeedEntry = { kind: 'activity'; items: ActivityItem[] } | { kind: 'single'; item: TranscriptItem }

/**
 * Transcript renderer: runs of tool calls and thinking become activity
 * blocks; everything else renders as its own item. Used by the main feed and
 * by nested subagent feeds.
 */
export const TranscriptList = memo(function TranscriptList({
  items,
  streaming,
  pending,
  agentWaits,
  subagentModelBadge,
  onRevert,
  onOpenFile,
}: {
  items: TranscriptItem[]
  /** The owning turn (chat or subagent) is still running. */
  streaming?: boolean
  /** The model is between steps: end the newest block with a Thinking row. */
  pending?: boolean
  agentWaits?: AgentWaits
  /** Session model override label for running subagent cards (e.g. "Grok"). */
  subagentModelBadge?: string
  onRevert?: (itemId: string) => void
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const entries: FeedEntry[] = []
  for (const it of items) {
    // Finished, empty, durationless reasoning renders nothing, and prose
    // without a word yet has nothing to show — neither may split a run.
    if (it.kind === 'reasoning' && !it.streaming && !it.durationMs && it.text.trim() === '') continue
    if (it.kind === 'text' && it.text.trim() === '') continue
    const last = entries[entries.length - 1]
    if (it.kind === 'reasoning' || isActivityTool(it)) {
      if (last?.kind === 'activity') last.items.push(it)
      else entries.push({ kind: 'activity', items: [it] })
    } else {
      entries.push({ kind: 'single', item: it })
    }
  }
  // The turn's newest entry. Steering typed but not yet delivered renders
  // after it, so it never steals the Thinking row.
  let newest = entries.length - 1
  while (newest >= 0) {
    const e = entries[newest]!
    if (e.kind === 'single' && e.item.kind === 'user' && e.item.pending) newest--
    else break
  }
  if (pending && entries[newest]?.kind !== 'activity') {
    newest++
    entries.splice(newest, 0, { kind: 'activity', items: [] })
  }
  const previousBlocks = useRef<ActivityIdentity[]>([])
  let after: string | null = null
  const blocks = reconcileActivityIdentity(previousBlocks.current, entries.flatMap(entry => {
    if (entry.kind === 'single') {
      after = entry.item.id
      return []
    }
    return [{ ids: entry.items.map(item => item.id), after }]
  }))
  useLayoutEffect(() => { previousBlocks.current = blocks })
  let blockIndex = 0
  return (
    <>
      {entries.map((e, index) => {
        if (e.kind === 'activity') {
          const isNewest = index === newest
          const live = e.items.some(isActiveItem) || (streaming === true && isNewest)
          // The same turn's next output closes the block's clock; a user
          // message (or nothing yet) doesn't — that gap isn't the agent working.
          const next = entries[index + 1]
          const until = next?.kind === 'single' && (next.item.kind === 'text' || next.item.kind === 'tool') ? next.item.at : undefined
          return (
            <ActivityBlock
              key={blocks[blockIndex++]!.key}
              items={e.items}
              until={until}
              live={live}
              pending={pending === true && isNewest}
              renderers={ACTIVITY_RENDERERS}
              onOpenFile={onOpenFile}
            />
          )
        }
        const item = e.item
        return (
          <TranscriptItemView
            key={item.id}
            item={item}
            agentWaits={agentWaits}
            subagentModelBadge={subagentModelBadge}
            onRevert={onRevert}
            onOpenFile={onOpenFile}
          />
        )
      })}
    </>
  )
},
(prev, next) =>
  prev.streaming === next.streaming &&
  prev.pending === next.pending &&
  prev.agentWaits === next.agentWaits &&
  prev.subagentModelBadge === next.subagentModelBadge &&
  prev.onRevert === next.onRevert &&
  prev.onOpenFile === next.onOpenFile &&
  sameItems(prev.items, next.items))

/* ---- streaming markdown -------------------------------------------
 * Re-parsing the whole document (remark + rehype-highlight) on every delta is
 * O(n²) over the message length. Instead the text splits into top-level
 * blocks and each renders through a memoized child — while streaming, only
 * the trailing block's text changes, so earlier blocks skip re-parsing.
 * ------------------------------------------------------------------- */

const REMARK_PLUGINS = MARKDOWN_REMARK_PLUGINS
const REMARK_PLUGINS_PREDICTIVE = [...REMARK_PLUGINS, remarkPredictiveMarkdown]
// Label tables before KaTeX duplicates their text into HTML and MathML.
const REHYPE_PLUGINS = [rehypeTableLabels, ...MARKDOWN_REHYPE_PLUGINS, rehypeHighlight]
// Plugin arrays are module constants: building one per render would change
// MarkdownBlock's props identity every delta and re-parse every block.
const REHYPE_PLUGINS_REVEAL = [...REHYPE_PLUGINS, rehypeMarkdownReveal]
const REHYPE_PLUGINS_REVEAL_CARET = [...REHYPE_PLUGINS_REVEAL, rehypeStreamCaret]
function MarkdownTable({
  children,
  node: _node,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement> & { node?: unknown }): React.ReactElement {
  // `node` is react-markdown's hast node: spreading it would print
  // node="[object Object]" onto the <table>.
  return (
    <div className="assistant-table-scroll" role="region" aria-label="Table" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  )
}
const MD_COMPONENTS: Components = { a: MarkdownLink, pre: MarkdownPre, table: MarkdownTable }

// memo compares text + components — callers must pass an identity-stable
// components object (or omit it) or streaming re-parses every block.
//
// `reveal` wraps each word in a fading span (see markdown-reveal.ts). It stays
// on for EVERY block while the message streams: a finished block keeps the
// spans it was revealed with (memo holds it — neither prop changes), so no
// block swaps spans for text mid-stream, which cut short the fade of its last
// words. Historical messages render with zero extra nodes.
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  components = MD_COMPONENTS,
  reveal = false,
  predictive = false,
  caret = false,
}: {
  text: string
  components?: Components
  reveal?: boolean
  predictive?: boolean
  /** End the text with the streaming caret (see markdown-caret.ts). */
  caret?: boolean
}): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={predictive ? REMARK_PLUGINS_PREDICTIVE : REMARK_PLUGINS}
      rehypePlugins={caret ? REHYPE_PLUGINS_REVEAL_CARET : reveal ? REHYPE_PLUGINS_REVEAL : REHYPE_PLUGINS}
      components={components}
    >
      {text}
    </ReactMarkdown>
  )
})

// No ItemActions here: copy/revert live on the user message only — showing
// them on the answer too duplicated the affordance, and the hover strip's
// reserved height read as a stray gap between the tool run and the text.
/** A word's fade (.md-word in theme.css) plus a frame of slack. */
const REVEAL_LINGER_MS = 360

/** `value`, but a `true` → `false` edge waits `ms` before it lands. */
function useLinger(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(value)
  useEffect(() => {
    if (value) {
      setHeld(true)
      return
    }
    const timer = setTimeout(() => setHeld(false), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return value || held
}

export const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming,
  onOpenFile,
}: {
  text: string
  streaming: boolean
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  // Index keys are stable: blocks only append, or the last one grows.
  const blocks = useMemo(() => splitMarkdownBlocks(normalizeArtifactLinks(redactSecrets(text))), [text])
  // Keyed on onOpenFile (App's openFile is identity-stable), so the object
  // stays stable and MarkdownBlock's memo keeps skipping earlier blocks.
  const components = useMemo<Components>(
    () =>
      onOpenFile
        ? {
            a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
              <MarkdownLink {...props} onOpenFile={onOpenFile} />
            ),
            pre: MarkdownPre,
            table: MarkdownTable,
          }
        : MD_COMPONENTS,
    [onOpenFile],
  )
  // Embeds mount once the reply is complete: a half-streamed link would flash
  // a viewer for a file that may still be being written.
  const artifacts = useMemo(() => (streaming ? [] : extractArtifactLinks(text)), [text, streaming])
  // Word spans outlive the stream by one fade, so the last words land
  // instead of snapping to full opacity when the spans are dropped.
  const revealing = useLinger(streaming, REVEAL_LINGER_MS)
  return (
    <div className={`item assistant${revealing ? ' assistant--streaming' : ''}`}>
      {blocks.map((block, i) => (
        <MarkdownBlock
          key={i}
          text={block}
          components={components}
          reveal={revealing}
          predictive={streaming && i === blocks.length - 1}
          caret={streaming && i === blocks.length - 1}
        />
      ))}
      {artifacts.length > 0 ? (
        <div className="artifact-embeds">
          {artifacts.map((path) => (
            <ArtifactEmbed key={path} path={path} />
          ))}
        </div>
      ) : null}
    </div>
  )
})

/**
 * Live preview of an HTML artifact linked from a reply. The iframe is the
 * viewer itself in embed mode (same file, same runtime), so what the user sees
 * here is exactly what opens in the tab.
 */
export const ArtifactEmbed = memo(function ArtifactEmbed({ path }: { path: string }): React.ReactElement {
  const [tall, setTall] = useState(false)
  const [nonce, setNonce] = useState(0)
  const name = artifactNameFromPath(path)
  return (
    <div className={`artifact-embed${tall ? ' artifact-embed--tall' : ''}`}>
      <div className="artifact-embed__bar">
        <span className="artifact-embed__name" title={path}>
          {name}
        </span>
        <span className="artifact-embed__path">{path}</span>
        <button className="icon-btn artifact-embed__btn" onClick={() => setNonce((n) => n + 1)} title="Reload the preview">
          Reload
        </button>
        <button className="icon-btn artifact-embed__btn" onClick={() => setTall((v) => !v)} title={tall ? 'Shrink the preview' : 'Expand the preview'}>
          {tall ? 'Shrink' : 'Expand'}
        </button>
        <a className="icon-btn artifact-embed__btn" href={artifactUrl(path)} target="_blank" rel="noreferrer" title="Open in a new tab">
          Open ↗
        </a>
      </div>
      <iframe
        key={nonce}
        className="artifact-embed__frame"
        src={artifactUrl(path, { embed: true })}
        title={`${name} artifact`}
        loading="lazy"
      />
    </div>
  )
})

export const ErrorRow = memo(function ErrorRow({
  id,
  message,
  onRevert,
}: {
  id: string
  message: string
  onRevert?: (itemId: string) => void
}): React.ReactElement {
  return (
    <div className="item callout-danger" role="alert">
      <ItemActions itemId={id} onRevert={onRevert} />
      <div className="callout-danger__title">Error</div>
      <div className="callout-danger__body">{message}</div>
    </div>
  )
})

/**
 * "Remembered X" — the receipt for a memory_write. Deliberately the quietest row
 * in the feed: it fires on ordinary turns and must never compete with the answer.
 * The whole chip is a button that opens /workspace/MEMORY.md, which IS the
 * "see all memories" affordance (there is no separate memory UI, by design).
 *
 * Reads as dim verb + bright payload, like tool rows. Renders nothing when the
 * write turned out to be a no-op.
 */
export const MemoryChip = memo(function MemoryChip({
  titles,
  forgotten,
  file,
}: {
  titles: string[]
  forgotten: string[]
  /** Which memory file the write landed in; defaults to MEMORY.md. */
  file?: string
}): React.ReactElement | null {
  const fileName = file?.split('/').at(-1) ?? 'MEMORY.md'
  const saved = titles.length === 1 ? titles[0]! : titles.length > 1 ? `${titles.length} things` : ''
  const dropped =
    forgotten.length === 1 ? forgotten[0]! : forgotten.length > 1 ? `${forgotten.length} things` : ''
  if (!saved && !dropped) return null

  const verb = saved ? 'Remembered' : 'Forgot'
  const payload = saved && dropped ? `${saved} · forgot ${dropped}` : saved || dropped

  return (
    <button
      type="button"
      className="item memory-chip"
      onClick={() => openMemoryFile(file)}
      title={`Open ${fileName}`}
    >
      <MemoryGlyph />
      <span className="memory-chip__verb">{verb}</span>
      <span className="memory-chip__payload">{payload}</span>
    </button>
  )
})

function MemoryGlyph(): React.ReactElement {
  return (
    <svg
      className="memory-chip__glyph"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4h9l4 4v12H6z" />
      <path d="M9 12h7M9 16h5" />
    </svg>
  )
}

/** Dispatch a single transcript item to its renderer. */
export const TranscriptItemView = memo(function TranscriptItemView({
  item,
  agentWaits,
  subagentModelBadge,
  onRevert,
  onOpenFile,
}: {
  item: TranscriptItem
  agentWaits?: AgentWaits
  subagentModelBadge?: string
  onRevert?: (itemId: string) => void
  onOpenFile?: (path: string) => void
}): React.ReactElement | null {
  switch (item.kind) {
    case 'user':
      return (
        <UserBubble
          id={item.id}
          text={item.text}
          steered={item.steered}
          pending={item.pending}
          attachments={item.attachments}
          contexts={item.contexts}
          source={item.source}
          onRevert={onRevert}
          onOpenFile={onOpenFile}
        />
      )
    case 'reasoning':
      return <ActivityBlock items={[item]} live={item.streaming} pending={false} renderers={ACTIVITY_RENDERERS} onOpenFile={onOpenFile} />
    case 'tool':
      return (
        <ToolRow
          item={item}
          agentWaits={agentWaits}
          subagentModelBadge={subagentModelBadge}
          onOpenFile={onOpenFile}
        />
      )
    case 'text':
      return <AssistantMessage text={item.text} streaming={item.streaming} onOpenFile={onOpenFile} />
    case 'error':
      return <ErrorRow id={item.id} message={item.message} onRevert={onRevert} />
    case 'memory':
      return <MemoryChip titles={item.titles} forgotten={item.forgotten} file={item.file} />
    case 'compaction':
      return <div className="compaction-status" role="status" aria-live="polite">
        {item.status === 'running' ? 'Compacting conversation…' : item.status === 'done' ? 'Conversation compacted' : item.status === 'cancelled' ? 'Compaction cancelled' : 'Compaction failed — history preserved'}
      </div>
    default:
      return null
  }
})
