import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  artifactEmbedFromLocation,
  artifactNameFromPath,
  artifactPathFromLocation,
  artifactUrl,
  isHtmlArtifactEntry,
  isVfsPath,
} from '../shared/artifacts'
import { sanitizeDocumentHtml } from '../shared/document-html'
import type { VfsEntry } from '../shared/types'
import { createVirtualFileSystemService, subscribeVfsChanges } from '../storage/vfs'
import { createArtifactSession, type ArtifactConsoleLine, type ArtifactSession } from './session'
import '../ui/theme.css'

const REFRESH_MS = 1000
const TEXT_CHARS = 800_000
const EXTRACTED_CHARS = 180_000

type ArtifactState =
  | { status: 'loading'; path: string }
  | { status: 'missing'; path: string; message: string }
  | { status: 'text'; entry: VfsEntry; text: string; markdown: boolean; truncated: boolean; totalChars: number }
  | { status: 'document'; entry: VfsEntry; html: string; messages: string[] }
  | { status: 'html'; entry: VfsEntry; html: string }
  | { status: 'image'; entry: VfsEntry; dataUrl: string }
  | {
      status: 'pdf'
      entry: VfsEntry
      pageUrl?: string
      text: string
      truncated: boolean
      totalChars: number
      renderError?: string
    }
  | { status: 'binary'; entry: VfsEntry; message: string }
  | { status: 'error'; path: string; message: string }

const vfs = createVirtualFileSystemService()
const EMBED = artifactEmbedFromLocation(window.location)
const ARTIFACT_FRAME_URL = chrome.runtime.getURL('artifact-frame.html')

function ArtifactApp(): React.ReactElement {
  const [path, setPath] = useState(() => artifactPathFromLocation(window.location))
  const sessionRef = useRef<ArtifactSession | undefined>(undefined)
  const [consoleLines, setConsoleLines] = useState<ArtifactConsoleLine[]>([])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [invoking, setInvoking] = useState(0)

  // One session per path: it owns the frame channel, the API bridge, and the
  // background port. Recreated only when the viewer navigates to another file.
  const [session, setSession] = useState<ArtifactSession | undefined>()
  useEffect(() => {
    if (!path) {
      sessionRef.current = undefined
      setSession(undefined)
      return
    }
    const next = createArtifactSession({
      path,
      embed: EMBED,
      vfs,
      events: {
        onConsole: (lines) => setConsoleLines([...lines]),
        onInvokeState: (active) => setInvoking(active),
      },
    })
    sessionRef.current = next
    setSession(next)
    setConsoleLines([])
    return () => {
      next.dispose()
      if (sessionRef.current === next) sessionRef.current = undefined
    }
  }, [path])
  const [state, setState] = useState<ArtifactState>(() =>
    path ? { status: 'loading', path } : { status: 'missing', path: '', message: 'No artifact path provided.' },
  )
  const [lastSeen, setLastSeen] = useState<{ path: string; updatedAt: number; size: number } | undefined>()

  useEffect(() => {
    const onPop = (): void => {
      const next = artifactPathFromLocation(window.location)
      setPath(next)
      setLastSeen(undefined)
      setState(next ? { status: 'loading', path: next } : { status: 'missing', path: '', message: 'No artifact path provided.' })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (!path) return
    let active = true

    async function tick(): Promise<void> {
      try {
        const entry = await vfs.getEntry(path)
        if (!active) return
        if (!entry) {
          setState({ status: 'missing', path, message: `No file exists at ${path}. Waiting for it to be created...` })
          setLastSeen(undefined)
          return
        }
        if (lastSeen && lastSeen.path === entry.path && lastSeen.updatedAt === entry.updatedAt && lastSeen.size === entry.size) {
          return
        }
        const next = await loadArtifact(entry)
        if (!active) return
        setLastSeen({ path: entry.path, updatedAt: entry.updatedAt, size: entry.size })
        // A write that came from the live document itself (ai.save / autosave)
        // must not tear down the DOM it was serialized from: keep the rendered
        // source, refresh only the file metadata.
        if (next.status === 'html' && sessionRef.current?.lastSavedHtml() === next.html) {
          setState((prev) => (prev.status === 'html' ? { ...prev, entry: next.entry } : next))
          return
        }
        setState(next)
      } catch (err) {
        if (!active) return
        setState({ status: 'error', path, message: errorMessage(err) })
      }
    }

    void tick()
    const id = window.setInterval(() => void tick(), REFRESH_MS)
    const unsubscribe = subscribeVfsChanges((change) => {
      if (change.path === path) void tick()
    })
    return () => {
      active = false
      window.clearInterval(id)
      unsubscribe()
    }
  }, [path, lastSeen])

  const title = useMemo(() => {
    if ('entry' in state) return state.entry.name
    return path || 'Artifact'
  }, [path, state])

  const errorCount = consoleLines.filter((line) => line.level === 'error').length
  const isHtml = state.status === 'html'

  // The tab reads like the app it shows, not like a file browser.
  useEffect(() => {
    document.title = 'entry' in state ? (isHtml ? artifactNameFromPath(state.entry.path) : state.entry.name) : 'Artifact'
  }, [state, isHtml])

  const body =
    state.status === 'html' && session ? (
      <ArtifactHtmlView session={session} html={state.html} />
    ) : (
      renderArtifact(state)
    )

  if (EMBED) {
    return (
      <div className="artifact-page artifact-page--embed">
        <main className="artifact-body">{body}</main>
      </div>
    )
  }

  if (isHtml && state.status === 'html') {
    const consolePanel = consoleOpen ? (
      <aside className="artifact-console artifact-console--overlay">
        <div className="artifact-console__bar">
          <span>Console</span>
          <div className="artifact-console__bar-actions">
            <button className="icon-btn" onClick={() => session?.clearLogs()}>
              Clear
            </button>
            <button className="icon-btn" onClick={() => setConsoleOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <div className="artifact-console__lines">
          {consoleLines.length === 0 ? (
            <div className="artifact-console__empty">No output yet. console.* calls and errors from the artifact appear here.</div>
          ) : (
            consoleLines.map((line, index) => (
              <div key={index} className={`artifact-console__line artifact-console__line--${line.level}`}>
                {line.text}
              </div>
            ))
          )}
        </div>
      </aside>
    ) : null
    return (
      <div className="artifact-page artifact-page--app">
        <main className="artifact-body">{body}</main>
        <div className={`artifact-hud${errorCount > 0 || invoking > 0 || consoleOpen ? ' artifact-hud--visible' : ''}`}>
          {invoking > 0 ? <span className="artifact-badge artifact-badge--live">Asking the assistant…</span> : null}
          <button
            className={`icon-btn${errorCount > 0 ? ' icon-btn--danger' : ''}`}
            onClick={() => setConsoleOpen((open) => !open)}
            title="Toggle the artifact console"
          >
            {errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : 'Console'}
          </button>
          <button className="icon-btn" onClick={() => void downloadEntry(state.entry)} title={`Download ${state.entry.name}`}>
            <DownloadIcon />
          </button>
        </div>
        {consolePanel}
      </div>
    )
  }

  return (
    <div className="artifact-page">
      <header className="artifact-topbar">
        <div className="artifact-title">
          <div className="artifact-title__name">{title}</div>
          <div className="artifact-title__path">{path || 'No path'}</div>
        </div>
        <div className="artifact-actions">
          {invoking > 0 ? <span className="artifact-badge artifact-badge--live">Asking the assistant…</span> : null}
          {'entry' in state ? (
            <span className="artifact-meta">
              {state.entry.mediaType} · {formatBytes(state.entry.size)} · Updated {formatTime(state.entry.updatedAt)}
            </span>
          ) : null}
          {isHtml ? (
            <button
              className={`icon-btn${errorCount > 0 ? ' icon-btn--danger' : ''}`}
              onClick={() => setConsoleOpen((open) => !open)}
              title="Toggle the artifact console"
            >
              Console{consoleLines.length > 0 ? ` (${errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : consoleLines.length})` : ''}
            </button>
          ) : null}
          {'entry' in state ? (
            <button className="icon-btn" onClick={() => void downloadEntry(state.entry)} title="Download artifact">
              <DownloadIcon />
              Download
            </button>
          ) : null}
        </div>
      </header>
      <main className={`artifact-body${consoleOpen && isHtml ? ' artifact-body--with-console' : ''}`}>
        {body}
        {consoleOpen && isHtml ? (
          <aside className="artifact-console">
            <div className="artifact-console__bar">
              <span>Console</span>
              <button className="icon-btn" onClick={() => session?.clearLogs()}>
                Clear
              </button>
            </div>
            <div className="artifact-console__lines">
              {consoleLines.length === 0 ? (
                <div className="artifact-console__empty">No output yet. console.* calls and errors from the artifact appear here.</div>
              ) : (
                consoleLines.map((line, index) => (
                  <div key={index} className={`artifact-console__line artifact-console__line--${line.level}`}>
                    {line.text}
                  </div>
                ))
              )}
            </div>
          </aside>
        ) : null}
      </main>
    </div>
  )
}

/**
 * Mounts the sandboxed artifact-frame and re-renders whenever the file's
 * source changes. The frame element is stable for the session's lifetime;
 * each render swaps the nested document inside it.
 */
function ArtifactHtmlView({ session, html }: { session: ArtifactSession; html: string }): React.ReactElement {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [renderError, setRenderError] = useState<string | undefined>()

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    return session.attachFrame(frame)
  }, [session])

  useEffect(() => {
    let cancelled = false
    setRenderError(undefined)
    session.render(html).catch((err) => {
      if (!cancelled) setRenderError(errorMessage(err))
    })
    return () => {
      cancelled = true
    }
  }, [session, html])

  return (
    <div className="artifact-html">
      {renderError ? <div className="artifact-empty artifact-empty--error">{renderError}</div> : null}
      <iframe ref={frameRef} className="artifact-html__frame" src={ARTIFACT_FRAME_URL} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" title="artifact" />
    </div>
  )
}

async function loadArtifact(entry: VfsEntry): Promise<ArtifactState> {
  if (isImage(entry)) return { status: 'image', entry, dataUrl: await vfs.dataUrl(entry.path) }

  if (isPdf(entry)) {
    const [pageResult, textResult] = await Promise.allSettled([
      vfs.renderPdfPage(entry.path, { page: 1, scale: 1.6 }),
      vfs.readText(entry.path, { maxChars: EXTRACTED_CHARS }),
    ])
    const page = pageResult.status === 'fulfilled' ? pageResult.value : undefined
    const text = textResult.status === 'fulfilled' ? textResult.value : undefined
    return {
      status: 'pdf',
      entry,
      pageUrl: page ? `data:${page.mediaType};base64,${page.base64}` : undefined,
      text: text?.text ?? '',
      truncated: text?.truncated ?? false,
      totalChars: text?.totalChars ?? 0,
      renderError: pageResult.status === 'rejected' ? errorMessage(pageResult.reason) : undefined,
    }
  }

  if (isHtmlArtifactEntry(entry)) {
    const result = await vfs.readHtml(entry.path)
    return { status: 'html', entry, html: result.html }
  }

  if (isDocx(entry)) {
    const result = await vfs.readHtml(entry.path)
    return {
      status: 'document',
      entry,
      html: sanitizeDocumentHtml(result.html),
      messages: result.messages,
    }
  }

  if (isReadableText(entry) || isDocx(entry)) {
    const result = await vfs.readText(entry.path, { maxChars: isReadableText(entry) ? TEXT_CHARS : EXTRACTED_CHARS })
    return {
      status: 'text',
      entry,
      text: result.text,
      markdown: isMarkdown(entry),
      truncated: result.truncated,
      totalChars: result.totalChars,
    }
  }

  return {
    status: 'binary',
    entry,
    message: 'Preview unavailable for this file type. You can still download it.',
  }
}

function renderArtifact(state: ArtifactState): React.ReactElement {
  if (state.status === 'html') return <div className="artifact-empty">Preparing artifact...</div>
  if (state.status === 'loading') return <div className="artifact-empty">Loading {state.path}...</div>
  if (state.status === 'missing') return <div className="artifact-empty">{state.message}</div>
  if (state.status === 'error') return <div className="artifact-empty artifact-empty--error">{state.message}</div>
  if (state.status === 'binary') return <div className="artifact-empty">{state.message}</div>
  if (state.status === 'image') {
    return (
      <div className="artifact-image-wrap">
        <img className="artifact-image" src={state.dataUrl} alt={state.entry.name} />
      </div>
    )
  }
  if (state.status === 'pdf') {
    return (
      <div className="artifact-pdf">
        <div className="artifact-pdf__page">
          {state.pageUrl ? <img src={state.pageUrl} alt={`${state.entry.name} page 1`} /> : <div>{state.renderError || 'Unable to render PDF page.'}</div>}
        </div>
        <pre className="artifact-pre">{state.text || 'No extractable text found.'}</pre>
      </div>
    )
  }
  if (state.status === 'document') {
    return (
      <div className="artifact-document-wrap" onClick={onDocumentHtmlClick}>
        <article className="artifact-document" dangerouslySetInnerHTML={{ __html: state.html }} />
      </div>
    )
  }
  if (state.markdown) {
    return (
      <article className="artifact-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ArtifactLink }}>{state.text}</ReactMarkdown>
      </article>
    )
  }
  return <pre className="artifact-pre artifact-pre--full">{state.text}</pre>
}

function onDocumentHtmlClick(event: React.MouseEvent<HTMLDivElement>): void {
  const target = event.target
  const link = target instanceof Element ? target.closest('a') : null
  const href = link?.getAttribute('href')
  if (!href || !isVfsPath(href)) return
  event.preventDefault()
  window.open(artifactUrl(href), '_blank', 'noreferrer')
}

function ArtifactLink({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.ReactElement {
  if (href && isVfsPath(href)) {
    return (
      <a {...props} href={artifactUrl(href)} target="_blank" rel="noreferrer">
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

async function downloadEntry(entry: VfsEntry): Promise<void> {
  const blob = await vfs.blob(entry.path)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = entry.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function isImage(entry: VfsEntry): boolean {
  return entry.mediaType.startsWith('image/')
}

function isPdf(entry: VfsEntry): boolean {
  return entry.mediaType === 'application/pdf' || entry.path.toLowerCase().endsWith('.pdf')
}

function isDocx(entry: VfsEntry): boolean {
  return (
    entry.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    entry.path.toLowerCase().endsWith('.docx')
  )
}

function isMarkdown(entry: VfsEntry): boolean {
  const lower = entry.path.toLowerCase()
  return entry.mediaType === 'text/markdown' || lower.endsWith('.md') || lower.endsWith('.markdown')
}

function isReadableText(entry: VfsEntry): boolean {
  if (entry.mediaType.startsWith('text/')) return true
  return ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'image/svg+xml'].includes(entry.mediaType)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function DownloadIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 2v7M4.2 6.4 7 9.2l2.8-2.8M2.5 11.8h9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ArtifactApp />
  </StrictMode>,
)
