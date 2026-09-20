/**
 * Transcript item renderers for the Cursor-Glass-style feed.
 *
 * - UserBubble        : the user's message (surface-recipe bubble, right-aligned)
 * - ReasoningRow      : thinking; shimmering "Thinking…" header + live 2-line
 *                       tail preview while streaming. Finished one-line
 *                       summaries render as a plain "Thought  …" label row
 *                       (nothing more to reveal); longer ones keep the
 *                       "Thought for Xs" collapsible with a markdown body
 * - ToolRow           : one row that morphs running -> done (running = 0.8
 *                       opacity); dim verb + payload; collapsible body with
 *                       per-tool rich renderers (code block for sandbox_exec,
 *                       file pill for VFS paths, screenshot images, JSON
 *                       fallback); delegations render as SubagentCard (metadata
 *                       embed, full transcript in a modal)
 * - AssistantMessage  : streaming markdown (react-markdown + gfm + highlight),
 *                       fenced code rendered via CodeBlock (lang label + copy)
 * - ErrorRow          : danger callout
 * - MemoryChip        : "Remembered X" receipt; opens MEMORY.md
 *
 * Chevron + Dots + CodeBlock are shared building blocks. Motion lives in CSS.
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
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeMarkdownReveal from '../markdown-reveal'
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
import { toolLabel, toolGroupSummary, GROUP_THOUGHT } from '../tool-labels'
import { openMemoryFile } from '../store'
import { formatRemaining } from './RateLimitBanner'
import { useVfsImage } from '../hooks/useVfsImage'
import { settleTranscriptScope } from '../../shared/settle-transcript'

/** Live rate-limit wait per agent id (structural subset of the store's ChatRateLimit). */
export interface AgentWait {
  /** Timestamp (ms) when the next retry fires. */
  retryAt: number
  message?: string
  /** Subagent holding its request until the main agent's reply goes through. */
  waitingForMain?: boolean
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

export function Dots(): React.ReactElement {
  return (
    <span className="dots" aria-label="working" role="status">
      <span />
      <span />
      <span />
    </span>
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
 * Image/appshot embedded in a sent user message. The image is re-read from the
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
  const { src, failed } = useVfsImage(attachment.path)
  const isAppshot = attachment.kind === 'appshot'
  const label = isAppshot ? attachment.title || 'TabShot' : attachment.name
  return (
    <button
      type="button"
      className={`attachment-embed${isAppshot ? ' attachment-embed--appshot' : ''}`}
      onClick={onOpenFile ? () => onOpenFile(attachment.path) : undefined}
      title={`Open ${attachment.name}`}
    >
      {src ? (
        <img className="attachment-embed__img" src={src} alt={label} loading="lazy" />
      ) : (
        <span className="attachment-embed__missing">{failed ? 'Image no longer in workspace' : 'Loading…'}</span>
      )}
      {isAppshot ? (
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

/**
 * Clean a one-line reasoning summary for the collapsed row: markdown emphasis
 * markers and a trailing period stripped, casing left exactly as the model
 * wrote it.
 *
 * This used to lowercase the first letter, because the row read "Thought about
 * {x}" and needed a noun phrase to complete the sentence. Providers do not
 * reliably emit noun phrases — a summary is just as often a finished thought
 * ("Good, closed the tab. Give clear summary"), which that template turned into
 * "Thought about good, closed the tab. Give clear summary". The row now labels
 * the summary instead of absorbing it into a sentence, so no grammar is
 * assumed and the model's own capitalisation survives.
 */
function reasoningSummary(text: string): string {
  // Strip PAIRED emphasis/code markers only — a global [*_`] delete would
  // corrupt snake_case identifiers, which these summaries are full of
  // ("sandbox_exec" must not become "sandboxexec").
  let t = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
  if (t.endsWith('.')) t = t.slice(0, -1).trimEnd()
  return t
}

export const ReasoningRow = memo(function ReasoningRow({
  text,
  streaming,
  durationMs,
}: {
  text: string
  streaming: boolean
  durationMs?: number
}): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const trimmed = text.trim()
  // reasoning-start + reasoning-end with no summary deltas: a chevron here
  // would be a control with nothing behind it. Keep the duration when we
  // have one; render nothing at all otherwise.
  if (!streaming && trimmed.length === 0) {
    if (!durationMs) return null
    return (
      <div className="item crow">
        <div className="reasoning-line">
          <span className="reasoning-line__text">Thought for {fmtDuration(durationMs)}</span>
        </div>
      </div>
    )
  }
  // A finished single-line summary has nothing more to reveal, so it renders
  // as a plain line instead of an empty collapsible. Label + summary, on the
  // same verb/payload footing as the tool rows it sits between, rather than a
  // sentence the summary has to grammatically complete. `title` carries the
  // full text — the line clamps at two rows in a ~360px panel.
  if (!streaming && trimmed.length <= 90 && !trimmed.includes('\n')) {
    return (
      <div className="item crow">
        <div className="reasoning-line" title={trimmed}>
          <span className="reasoning-line__verb">Thought</span>
          <span className="reasoning-line__text">{reasoningSummary(trimmed)}</span>
          {durationMs ? <span className="crow__trailing">{fmtDuration(durationMs)}</span> : null}
        </div>
      </div>
    )
  }
  const header = streaming ? 'Thinking…' : durationMs ? `Thought for ${fmtDuration(durationMs)}` : 'Thought'
  return (
    <div className="item crow">
      {/* Chevron on the TRAILING edge, not leading — see .crow__header in
          theme.css: a leading chevron pushed every row's text 18px right of the
          assistant's prose. */}
      <button className="crow__header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`crow__verb${streaming ? ' shine' : ''}`}>{header}</span>
        <span className="crow__trailing">
          <Chevron open={open} />
        </span>
      </button>
      {open && text ? (
        // Markdown, not raw text: summary parts arrive as bold headlines and
        // lists, which read as literal asterisks in a plain div.
        <div className="crow__body reasoning-body reasoning-body--md">
          <MarkdownBlock text={text} />
        </div>
      ) : null}
      {!open && streaming && text ? <div className="reasoning-preview">{text.slice(-500)}</div> : null}
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
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { onOpenFile?: (path: string) => void }): React.ReactElement {
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
  const [open, setOpen] = useState(false)
  const isError = item.status === 'error' || (item.status === 'done' && !!toolResultError(item.output))
  const { verb, payload } = toolLabel(item.toolName, isError ? 'error' : item.status, item.input, item.output)
  const running = item.status === 'running'
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

  const monoPayload =
    item.toolName === 'browser_click' ||
    item.toolName === 'browser_type' ||
    item.toolName === 'browser_fill' ||
    item.toolName === 'sandbox_exec' ||
    item.toolName === 'browser_navigate'

  const trailing = (() => {
    if (running) return <Dots />
    if (item.durationMs) return <span>{fmtDuration(item.durationMs)}</span>
    return null
  })()

  return (
    <div className={`item crow${isError ? ' crow--error' : ''}${running ? ' crow--running' : ''}`}>
      <button className="crow__header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`crow__verb${running ? ' shine' : ''}`}>{verb}</span>
        {payload ? <span className={`crow__payload${monoPayload ? ' crow__payload--mono' : ''}`}>{payload}</span> : null}
        <span className="crow__trailing">
          {trailing}
          <Chevron open={open} />
        </span>
      </button>

      {open ? <ToolBody item={item} onOpenFile={onOpenFile} /> : null}
    </div>
  )
})

/**
 * One-line summary of the subagent's latest activity, for the card. `key`
 * identifies the *step* producing the text (item id + tool status) — the
 * card keys its crossfade on it, so the animation replays when the agent
 * moves to a new step, not on every streamed token of the current one.
 */
export function subagentTail(items: TranscriptItem[]): { text: string; key: string } {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === 'text' || it.kind === 'reasoning') {
      const t = it.text.trim()
      if (t) return { text: t, key: it.id }
      if (it.streaming) return { text: it.kind === 'reasoning' ? 'Thinking…' : 'Writing…', key: it.id }
    } else if (it.kind === 'tool') {
      const { verb, payload } = toolLabel(it.toolName, it.status, it.input, it.output)
      return { text: payload ? `${verb} ${payload}` : verb, key: `${it.id}:${it.status}` }
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
  const status: 'running' | 'done' | 'error' =
    item.childStatus ?? (item.status === 'error' ? 'error' : item.status === 'running' ? 'running' : 'done')
  const running = status === 'running'
  // Persisted transcripts from older builds may still have streaming flags
  // after a terminal task update. The card's terminal state is authoritative.
  const items = useMemo(() => running ? item.childItems ?? [] : settleTranscriptScope(item.childItems ?? []), [item.childItems, running])
  const title = subagentTitle(item.input, item.inputText)
  const tail = subagentTail(items)
  const activity = tail.text || (running ? (item.childAgentId ? 'Waiting for model response…' : 'Starting agent…') : status === 'error' ? 'Failed' : 'Done')
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
          showModelBadge
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
            <span key={activityKey} className={`subagent-card__activity${running ? ' shine' : ''}`}>
              {activity}
            </span>
          )}
        </span>
        <span className="subagent-card__trailing">
          {showModelBadge ? <span className="subagent-card__model">{modelBadge}</span> : null}
          {items.length > 0 ? `${items.length} step${items.length === 1 ? '' : 's'}` : null}
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
  const pinnedRef = useRef(true)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items])
  const onScroll = (): void => {
    const el = scrollerRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40
  }
  return (
    <div className="feed" ref={scrollerRef} onScroll={onScroll}>
      <div className="feed__inner">
        <TranscriptList items={items} streaming={streaming} onOpenFile={onOpenFile} />
      </div>
    </div>
  )
}

/* ---- Activity group ------------------------------------------------
 * A run of consecutive tool calls AND interleaved thinking (no text output
 * between, no subagent feeds) renders as one cluster with three states:
 *  - live      : the turn is still working here — fixed-height box,
 *                auto-following the newest row (including streamed thinking),
 *                older rows fading out at the top edge
 *  - collapsed : the run moved on (final output arrived) — one human summary
 *                line ("Thought ×3, ran code ×2"); click to reopen
 *  - open      : user-expanded — full scrollable list; every row keeps its
 *                own input/output drill-down
 * A manual toggle always wins over the auto behavior. Thinking joins the
 * cluster because reasoning models interleave thought/tool/thought — boxing
 * only the tools would leave exactly those long-horizon turns unclustered.
 * ------------------------------------------------------------------- */

/** A group member: a plain tool call, or one reasoning (thinking) part. */
type ActivityItem = ToolItem | ReasoningItem

/** Adjacent 'detailed' summary parts merged into one ReasoningRow. Memoized
 * on element identity: TranscriptList rebuilds the items array every frame
 * while streaming, and re-joining every finished entry's text per delta is
 * pure waste — the reducer preserves untouched item identity. */
const MergedReasoning = memo(
  function MergedReasoning({ items }: { items: ReasoningItem[] }): React.ReactElement | null {
    const durations = items.map((r) => r.durationMs).filter((d): d is number => d !== undefined)
    return (
      <ReasoningRow
        text={items.map((r) => r.text.trim()).filter(Boolean).join('\n\n')}
        streaming={items[items.length - 1]!.streaming}
        durationMs={durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : undefined}
      />
    )
  },
  (prev, next) => sameItems(prev.items, next.items),
)

type GroupUnit = { kind: 'tool'; item: ToolItem } | { kind: 'thought'; items: ReasoningItem[] }

/** Render units for a group's list: consecutive reasoning parts merge. */
function groupUnits(items: ActivityItem[]): GroupUnit[] {
  const units: GroupUnit[] = []
  for (const it of items) {
    const last = units[units.length - 1]
    if (it.kind === 'reasoning') {
      if (last?.kind === 'thought') last.items.push(it)
      else units.push({ kind: 'thought', items: [it] })
    } else {
      units.push({ kind: 'tool', item: it })
    }
  }
  return units
}

/**
 * Element-wise array equality. The grouping pass rebuilds entry arrays every
 * render, but the reducer preserves the identity of untouched items — so
 * comparing elements (not the array) lets groups/lists skip re-rendering when
 * nothing inside them changed.
 */
function sameItems(a: readonly TranscriptItem[], b: readonly TranscriptItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export const ToolGroup = memo(function ToolGroup({
  items,
  live,
  onOpenFile,
}: {
  items: ActivityItem[]
  /** The turn is still appending tool calls / thinking to this group. */
  live: boolean
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? live
  const listRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [masked, setMasked] = useState(false)

  // Streamed thinking grows a row WITHOUT adding items, so keying the follow
  // effect on items.length alone would let the newest text drift below the
  // fold mid-thought; fold reasoning text growth into the dependency.
  const growth = items.reduce((n, it) => n + (it.kind === 'reasoning' ? it.text.length : 1), 0)

  // Follow the newest row while live (unless the user scrolled up inside the
  // box), and only fade the top edge once content actually overflows.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || !open) return
    if (live && pinnedRef.current) el.scrollTop = el.scrollHeight
    setMasked(live && el.scrollHeight > el.clientHeight)
  }, [growth, live, open])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 30
  }

  const working = items.some((it) => (it.kind === 'tool' ? it.status === 'running' : it.streaming))
  const toolCount = items.filter((it) => it.kind === 'tool').length
  const failed = items.filter((it) => it.kind === 'tool' && (it.status === 'error' || (it.status === 'done' && !!toolResultError(it.output)))).length
  const summary = toolGroupSummary(items.map((it) => (it.kind === 'tool' ? it : { toolName: GROUP_THOUGHT })))

  return (
    <div className={`item tool-group${open ? ' tool-group--open' : ''}`}>
      <button
        className="tool-group__header"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        title={open ? 'Collapse the steps' : 'Show the steps'}
      >
        <span className={`tool-group__summary${working ? ' shine' : ''}`}>{summary}</span>
        {failed > 0 ? <span className="tool-group__failed">{failed} failed</span> : null}
        <span className="crow__trailing">
          {working ? <Dots /> : <span className="tool-group__count">{toolCount} {toolCount === 1 ? 'tool call' : 'tool calls'}</span>}
          <Chevron open={open} />
        </span>
      </button>
      <div className={`tool-group__reveal${open ? '' : ' tool-group__reveal--closed'}`}>
        <div className="tool-group__clip">
          <div
            className={`tool-group__list${live ? ' tool-group__list--live' : ''}${masked ? ' tool-group__list--masked' : ''}`}
            ref={listRef}
            onScroll={onScroll}
          >
            {groupUnits(items).map((u) =>
              u.kind === 'tool' ? (
                <ToolRow key={u.item.id} item={u.item} onOpenFile={onOpenFile} />
              ) : (
                <MergedReasoning key={u.items[0]!.id} items={u.items} />
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  )
},
(prev, next) => prev.live === next.live && prev.onOpenFile === next.onOpenFile && sameItems(prev.items, next.items))

/** Plain tool call that can join a group: delegations (subagent cards) never group. */
function groupable(it: TranscriptItem): it is ToolItem {
  return (
    it.kind === 'tool' &&
    it.toolName !== 'subagent_spawn' &&
    it.toolName !== 'workflow_run' &&
    it.childItems === undefined &&
    it.childAgentId === undefined
  )
}

type ReasoningItem = Extract<TranscriptItem, { kind: 'reasoning' }>

type FeedEntry =
  | { kind: 'single'; item: TranscriptItem }
  | { kind: 'group'; items: ActivityItem[] }
  | { kind: 'reasoning'; items: ReasoningItem[] }

/**
 * Transcript renderer with tool-call clustering: runs of 2+ consecutive
 * groupable tool calls become a ToolGroup; consecutive reasoning items (the
 * provider emits one per 'detailed' summary part) merge into a single
 * ReasoningRow at render time — durations summed, texts joined — without
 * touching the reducer or persisted items. Everything else renders as before.
 * Used by the main feed and by nested subagent feeds.
 */
export const TranscriptList = memo(function TranscriptList({
  items,
  streaming,
  agentWaits,
  subagentModelBadge,
  onRevert,
  onOpenFile,
}: {
  items: TranscriptItem[]
  /** The owning turn (chat or subagent) is still running. */
  streaming?: boolean
  agentWaits?: AgentWaits
  /** Session model override label for running subagent cards (e.g. "Grok"). */
  subagentModelBadge?: string
  onRevert?: (itemId: string) => void
  onOpenFile?: (path: string) => void
}): React.ReactElement {
  const entries: FeedEntry[] = []
  for (const it of items) {
    // Finished, empty, durationless reasoning renders nothing — keeping it in
    // a run would inflate the box's step count with invisible rows.
    if (it.kind === 'reasoning' && !it.streaming && !it.durationMs && it.text.trim() === '') continue
    const last = entries[entries.length - 1]
    if (groupable(it)) {
      if (last?.kind === 'group') last.items.push(it)
      // Thinking that PRECEDED this tool call joins the same cluster: models
      // interleave thought/tool/thought, and boxing only the tools would
      // leave exactly those long-horizon runs unclustered in the feed.
      else if (last?.kind === 'reasoning') entries[entries.length - 1] = { kind: 'group', items: [...last.items, it] }
      else entries.push({ kind: 'group', items: [it] })
    } else if (it.kind === 'reasoning') {
      if (last?.kind === 'group') last.items.push(it)
      else if (last?.kind === 'reasoning') last.items.push(it)
      else entries.push({ kind: 'reasoning', items: [it] })
    } else {
      entries.push({ kind: 'single', item: it })
    }
  }
  const lastEntry = entries[entries.length - 1]
  return (
    <>
      {entries.map((e) => {
        if (e.kind === 'group') {
          // Box only runs with 2+ TOOL calls. A single tool call — however
          // much thinking surrounds it — stays inline: collapsing it would
          // permanently hide the intent label ("Ran · parsing the syllabus"),
          // the most informative line of a one-tool reasoning turn.
          const toolCount = e.items.reduce((n, it) => n + (it.kind === 'tool' ? 1 : 0), 0)
          if (toolCount >= 2) {
            const live =
              e.items.some((it) => (it.kind === 'tool' ? it.status === 'running' : it.streaming)) ||
              (streaming === true && e === lastEntry)
            return <ToolGroup key={`group-${e.items[0]!.id}`} items={e.items} live={live} onOpenFile={onOpenFile} />
          }
          return (
            <Fragment key={`run-${e.items[0]!.id}`}>
              {groupUnits(e.items).map((u) =>
                u.kind === 'tool' ? (
                  <ToolRow key={u.item.id} item={u.item} onOpenFile={onOpenFile} />
                ) : (
                  <MergedReasoning key={u.items[0]!.id} items={u.items} />
                ),
              )}
            </Fragment>
          )
        }
        if (e.kind === 'reasoning') {
          // Only the last part can still be streaming; rebuilt strings are
          // compared by value in ReasoningRow's memo, so no re-render churn.
          return <MergedReasoning key={e.items[0]!.id} items={e.items} />
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

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]
// Both arrays are module constants: building one per render would change
// MarkdownBlock's props identity every delta and re-parse every block.
const REHYPE_PLUGINS_REVEAL = [rehypeHighlight, rehypeMarkdownReveal]
const MD_COMPONENTS: Components = { a: MarkdownLink, pre: MarkdownPre }

// memo compares text + components — callers must pass an identity-stable
// components object (or omit it) or streaming re-parses every block.
//
// `reveal` wraps each word in a fading span (see markdown-reveal.ts) and is
// passed ONLY for the still-growing last block: earlier blocks are already
// mounted and historical messages render with zero extra nodes. Dropping
// `reveal` remounts the block once, which is invisible — the plain output is
// the same text without the animation.
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  components = MD_COMPONENTS,
  reveal = false,
}: {
  text: string
  components?: Components
  reveal?: boolean
}): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={reveal ? REHYPE_PLUGINS_REVEAL : REHYPE_PLUGINS}
      components={components}
    >
      {text}
    </ReactMarkdown>
  )
})

const LIST_LINE_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/

/**
 * Split markdown into independently renderable top-level blocks on blank
 * lines. Fence-aware (blank lines inside ``` fences don't split) and
 * list-aware (loose lists — blank lines between items/continuations — stay
 * one block so numbering and tightness render exactly as before).
 */
function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  const flush = (): void => {
    if (cur.length > 0) {
      blocks.push(cur.join('\n'))
      cur = []
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!inFence) {
        inFence = true
        fenceChar = marker[0]!
        fenceLen = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        inFence = false
      }
      cur.push(line)
      continue
    }
    if (!inFence && line.trim() === '') {
      let j = i + 1
      while (j < lines.length && lines[j]!.trim() === '') j++
      const next = lines[j]
      const prevLine = cur[cur.length - 1] ?? ''
      const looseList =
        next !== undefined &&
        (LIST_LINE_RE.test(prevLine) || /^\s{2,}\S/.test(prevLine)) &&
        (LIST_LINE_RE.test(next) || /^\s{2,}\S/.test(next))
      if (looseList) {
        cur.push(line)
        continue
      }
      flush()
      continue
    }
    cur.push(line)
  }
  flush()
  return blocks
}

// No ItemActions here: copy/revert live on the user message only — showing
// them on the answer too duplicated the affordance, and the hover strip's
// reserved height read as a stray gap between the tool run and the text.
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
          }
        : MD_COMPONENTS,
    [onOpenFile],
  )
  // Embeds mount once the reply is complete: a half-streamed link would flash
  // a viewer for a file that may still be being written.
  const artifacts = useMemo(() => (streaming ? [] : extractArtifactLinks(text)), [text, streaming])
  return (
    <div className="item assistant">
      {blocks.map((block, i) => (
        <MarkdownBlock
          key={i}
          text={block}
          components={components}
          reveal={streaming && i === blocks.length - 1}
        />
      ))}
      {streaming ? <span className="assistant__caret" aria-hidden="true" /> : null}
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
      return <ReasoningRow text={item.text} streaming={item.streaming} durationMs={item.durationMs} />
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
