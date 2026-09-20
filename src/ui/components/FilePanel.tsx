import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { VfsEntry, VfsRoot, VfsSkillMetadata } from '../../shared/types'
import { artifactUrl, isHtmlArtifactEntry, isVfsPath } from '../../shared/artifacts'
import { isStickyPath, parseSticky, type StickyRuntimeMessage } from '../../shared/stickies'
import { sanitizeDocumentHtml } from '../../shared/document-html'
import { getRuntime } from '../../runtime'
import { subscribeVfsChanges } from '../../storage/vfs'
import { debugLog } from '../../shared/debug-log'
import { ReplExtensions } from './ReplExtensions'

interface FilePanelProps {
  open: boolean
  onClose: () => void
  /** Select + preview this path when the sheet opens (bump focusNonce to re-trigger). */
  focusPath?: string
  focusNonce?: number
  /** Insert an @file / @folder mention for this path into the composer. */
  onAttach?: (path: string, opts?: { folder?: boolean }) => void
}

const SHEET_MIN_H = 180
const SHEET_KEY = 'fileSheetHeight'

function parentDirectory(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return `/${parts.slice(0, -1).join('/')}`
}

/** Mention text for drag/attach: folders use @folder so intent stays explicit. */
function pathMention(path: string, isFolder: boolean): string {
  return isFolder ? `@folder(${path})` : `@file(${path})`
}

function setMentionDragData(event: React.DragEvent, path: string, isFolder: boolean): void {
  event.dataTransfer.setData('text/plain', ` ${pathMention(path, isFolder)} `)
  event.dataTransfer.effectAllowed = 'copy'
}

interface DroppedFile {
  file: File
  relativePath: string
}

interface BrowserFileSystemEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

interface BrowserFileSystemFileEntry extends BrowserFileSystemEntry {
  isFile: true
  file(success: (file: File) => void, error?: (err: unknown) => void): void
}

interface BrowserFileSystemDirectoryEntry extends BrowserFileSystemEntry {
  isDirectory: true
  createReader(): {
    readEntries(success: (entries: BrowserFileSystemEntry[]) => void, error?: (err: unknown) => void): void
  }
}

interface FolderSummary {
  path: string
  name: string
  count: number
  size: number
  updatedAt: number
}

interface DirectoryView {
  folders: FolderSummary[]
  files: VfsEntry[]
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; entry: VfsEntry }
  | { status: 'text'; entry: VfsEntry; text: string; editable: boolean; truncated: boolean; totalChars: number }
  | { status: 'document'; entry: VfsEntry; html: string; messages: string[] }
  /** HTML artifact: rendered live by the artifact viewer in embed mode. */
  | { status: 'artifact'; entry: VfsEntry }
  | {
      status: 'pdf'
      entry: VfsEntry
      pageUrl?: string
      width?: number
      height?: number
      text: string
      truncated: boolean
      totalChars: number
      renderError?: string
    }
  | { status: 'image'; entry: VfsEntry; dataUrl: string }
  | { status: 'binary'; entry: VfsEntry; message: string }
  | { status: 'error'; entry: VfsEntry; message: string }

const TEXT_PREVIEW_CHARS = 500_000
const EXTRACTED_PREVIEW_CHARS = 80_000
const DOWNLOAD_TIMEOUT_MS = 120_000

export function FilePanel({ open, onClose, focusPath, focusNonce, onAttach }: FilePanelProps): React.ReactElement | null {
  const [root, setRoot] = useState<VfsRoot>('workspace')
  const [dirPath, setDirPath] = useState('/workspace')
  const [entries, setEntries] = useState<VfsEntry[]>([])
  const [skills, setSkills] = useState<VfsSkillMetadata[]>([])
  const [busy, setBusy] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | undefined>()
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' })
  const [draftText, setDraftText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [mdEditing, setMdEditing] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState<string | undefined>()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)
  const [sheetHeight, setSheetHeight] = useState(() => {
    const stored = Number(localStorage.getItem(SHEET_KEY))
    return Number.isFinite(stored) && stored >= SHEET_MIN_H ? stored : 340
  })

  // Sheet resize: drag the top handle; height persists across sessions.
  function onHandlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const startY = event.clientY
    const startH = sheetHeight
    const maxH = Math.round(window.innerHeight * 0.8)
    let next = startH
    const onMove = (ev: PointerEvent): void => {
      next = Math.min(maxH, Math.max(SHEET_MIN_H, startH + (startY - ev.clientY)))
      setSheetHeight(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      localStorage.setItem(SHEET_KEY, String(next))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Esc closes the sheet.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Focus a specific file (from a pill / tray click).
  useEffect(() => {
    if (!open || !focusPath) return
    const nextRoot: VfsRoot = focusPath.startsWith('/skills') ? 'skills' : 'workspace'
    setRoot(nextRoot)
    setDirPath(parentDirectory(focusPath))
    setSelectedPath(focusPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusPath, focusNonce])

  useEffect(() => {
    const input = dirInputRef.current as (HTMLInputElement & { webkitdirectory?: boolean }) | null
    if (input) input.webkitdirectory = true
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    // Live-follow: refresh immediately on any VFS change (agent writes,
    // uploads, deletes); the preview effect keys on updatedAt and reloads.
    const unsubscribe = subscribeVfsChanges(() => {
      void refresh()
    })
    return unsubscribe
  }, [open])

  const counts = useMemo(
    () => ({
      workspace: entries.filter((entry) => entry.root === 'workspace').length,
      skills: skills.length,
    }),
    [entries, skills],
  )

  const currentDir = useMemo(() => normalizeDirForRoot(dirPath, root), [dirPath, root])
  const visible = useMemo(() => buildDirectoryView(entries, currentDir), [entries, currentDir])
  const currentDirEntries = useMemo(() => entries.filter((entry) => isPathUnderDirectory(entry.path, currentDir)), [entries, currentDir])
  const breadcrumbs = useMemo(() => directoryBreadcrumbs(currentDir), [currentDir])
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedPath),
    [entries, selectedPath],
  )

  useEffect(() => {
    if (!selectedPath || entries.length === 0) return
    if (!entries.some((entry) => entry.path === selectedPath)) setSelectedPath(undefined)
  }, [entries, selectedPath])

  useEffect(() => {
    const entry = selectedEntry
    if (!open || !entry) {
      setPreview({ status: 'idle' })
      setDraftText('')
      setDirty(false)
      return
    }

    let active = true
    setPreview({ status: 'loading', entry })
    setDraftText('')
    setDirty(false)
    setMdEditing(false)

    void loadPreview(entry)
      .then((next) => {
        if (!active) return
        setPreview(next)
        if (next.status === 'text') setDraftText(next.text)
      })
      .catch((err) => {
        if (!active) return
        setPreview({ status: 'error', entry, message: errorMessage(err) })
      })

    return () => {
      active = false
    }
  }, [open, selectedEntry?.path, selectedEntry?.updatedAt])

  async function refresh(): Promise<void> {
    try {
      const summary = await getRuntime().vfs.summary()
      setEntries(summary.entries)
      setSkills(summary.skills)
    } catch (err) {
      setDownloadStatus(`Could not load files: ${errorMessage(err)}`)
      debugLog.error('ui', 'load vfs panel', err)
    }
  }

  async function upload(files: FileList | null, targetRoot: VfsRoot): Promise<void> {
    if (!files || files.length === 0) return
    const dropped = Array.from(files).map((file) => ({
      file,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }))
    await uploadDropped(dropped, targetRoot)
  }

  async function uploadDropped(files: DroppedFile[], targetRoot: VfsRoot): Promise<void> {
    if (files.length === 0) return
    setBusy(true)
    try {
      const vfs = getRuntime().vfs
      for (const item of files) {
        await vfs.putFile(targetRoot, item.file, item.relativePath)
      }
      await refresh()
    } catch (err) {
      setDownloadStatus(`Upload failed: ${errorMessage(err)}`)
      debugLog.error('ui', 'upload vfs files', err)
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (dirInputRef.current) dirInputRef.current.value = ''
    }
  }

  function onDragOver(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!busy) setDragActive(true)
  }

  function onDragLeave(event: React.DragEvent<HTMLDivElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragActive(false)
  }

  async function onDrop(event: React.DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault()
    setDragActive(false)
    if (busy) return
    const dropped = await collectDroppedFiles(event.dataTransfer)
    await uploadDropped(dropped, root)
  }

  async function remove(path: string): Promise<void> {
    setBusy(true)
    try {
      await getRuntime().vfs.delete(path)
      if (selectedPath === path) setSelectedPath(undefined)
      await refresh()
    } catch (err) {
      setDownloadStatus(`Delete failed: ${errorMessage(err)}`)
      debugLog.error('ui', 'delete vfs file', err)
    } finally {
      setBusy(false)
    }
  }

  async function copyPath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path)
      setDownloadStatus(`Copied ${path}`)
      window.setTimeout(() => setDownloadStatus((s) => (s === `Copied ${path}` ? undefined : s)), 1500)
    } catch (err) {
      setDownloadStatus(`Could not copy path: ${errorMessage(err)}`)
      debugLog.error('ui', 'copy vfs path', err)
    }
  }

  function selectRoot(next: VfsRoot): void {
    setRoot(next)
    setDirPath(`/${next}`)
    setSelectedPath(undefined)
  }

  function selectDirectory(path: string): void {
    setDirPath(path)
    setSelectedPath(undefined)
  }

  async function saveDraft(): Promise<void> {
    if (preview.status !== 'text' || !preview.editable || preview.truncated) return
    setBusy(true)
    try {
      await getRuntime().vfs.writeText(preview.entry.path, draftText, { mediaType: preview.entry.mediaType })
      setDirty(false)
      setDownloadStatus(`Saved ${preview.entry.name}`)
      await refresh()
    } catch (err) {
      setDownloadStatus(`Save failed: ${errorMessage(err)}`)
      debugLog.error('ui', 'save vfs preview', err)
    } finally {
      setBusy(false)
    }
  }

  function openEntry(entry: VfsEntry): void {
    setSelectedPath((current) => (current === entry.path ? undefined : entry.path))
  }

  function onRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>, entry: VfsEntry): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openEntry(entry)
  }

  function onFolderKeyDown(event: React.KeyboardEvent<HTMLDivElement>, folder: FolderSummary): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectDirectory(folder.path)
  }

  async function downloadFile(entry: VfsEntry): Promise<void> {
    setBusy(true)
    setDownloadStatus(`Downloading ${entry.name}...`)
    try {
      const blob = await getRuntime().vfs.blob(entry.path)
      const filename = safeDownloadName(entry.name || pathBasename(entry.path))
      await saveBlob(blob, filename)
      setDownloadStatus(`Downloaded ${filename}`)
    } catch (err) {
      setDownloadStatus(`Download failed: ${errorMessage(err)}`)
      debugLog.error('ui', 'download vfs file', err)
    } finally {
      setBusy(false)
    }
  }

  async function downloadDirectory(path: string): Promise<void> {
    const files = entries.filter((entry) => isPathUnderDirectory(entry.path, path))
    if (files.length === 0) return
    setBusy(true)
    setDownloadStatus(`Preparing ${path}...`)
    try {
      const zip = new JSZip()
      const vfs = getRuntime().vfs
      for (const entry of files) {
        const rel = relativeToDirectory(entry.path, path) || entry.name
        zip.file(rel, await vfs.blob(entry.path), { date: new Date(entry.updatedAt) })
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
      const filename = `${safeDownloadName(path.split('/').filter(Boolean).join('-') || 'filesystem')}.zip`
      setDownloadStatus(`Downloading ${filename}...`)
      await saveBlob(blob, filename)
      setDownloadStatus(`Downloaded ${filename}`)
    } catch (err) {
      setDownloadStatus(`Download failed: ${errorMessage(err)}`)
      debugLog.error('ui', 'download vfs folder', err)
    } finally {
      setBusy(false)
    }
  }

  function renderDownloadButton(entry: VfsEntry): React.ReactElement {
    return (
      <button className="icon-btn" disabled={busy} onClick={() => void downloadFile(entry)} title="Download file">
        <DownloadIcon />
      </button>
    )
  }

  function renderPreviewActions(entry: VfsEntry): React.ReactElement {
    const stickyOpen = isStickyPath(entry.path) && preview.status === 'text' && preview.entry.path === entry.path
      ? parseSticky(preview.text).meta.open : undefined
    return (
      <>
        {isStickyPath(entry.path) ? (
          <button
            className="icon-btn"
            onClick={() => void toggleSticky(entry.path, stickyOpen === undefined ? undefined : !stickyOpen)}
            title={stickyOpen === false ? 'Show this sticky on your pages again' : 'Hide this sticky from your pages (keeps the file)'}
          >
            {stickyOpen === false ? 'Show sticky' : 'Hide sticky'}
          </button>
        ) : null}
        {onAttach ? (
          <button className="icon-btn" onClick={() => onAttach(entry.path)} title="Attach to message as @file mention">
            Attach
          </button>
        ) : null}
        <button className="icon-btn" onClick={() => void openArtifact(entry.path)} title="Open artifact in new tab">
          <OpenIcon />
        </button>
        {renderDownloadButton(entry)}
        <button className="icon-btn" onClick={() => setSelectedPath(undefined)} title="Back to files">
          <CloseIcon />
        </button>
      </>
    )
  }

  function renderPreview(): React.ReactElement {
    if (preview.status === 'idle') {
      return (
        <div className="file-preview__empty">
          <FileIcon mediaType="application/octet-stream" />
          <span>Select a file to preview it.</span>
        </div>
      )
    }

    if (preview.status === 'loading') {
      return (
        <div className="file-preview__empty">
          <FileIcon mediaType={preview.entry.mediaType} />
          <span>Loading preview...</span>
        </div>
      )
    }

    if (preview.status === 'error') {
      return (
        <>
          <PreviewHeader entry={preview.entry}>{renderPreviewActions(preview.entry)}</PreviewHeader>
          <div className="file-preview__empty file-preview__empty--error">{preview.message}</div>
        </>
      )
    }

    if (preview.status === 'binary') {
      return (
        <>
          <PreviewHeader entry={preview.entry}>{renderPreviewActions(preview.entry)}</PreviewHeader>
          <div className="file-preview__empty">{preview.message}</div>
        </>
      )
    }

    if (preview.status === 'image') {
      return (
        <>
          <PreviewHeader entry={preview.entry}>{renderPreviewActions(preview.entry)}</PreviewHeader>
          <div className="file-preview__image-wrap">
            <img className="file-preview__image" src={preview.dataUrl} alt={preview.entry.name} />
          </div>
        </>
      )
    }

    if (preview.status === 'pdf') {
      return (
        <>
          <PreviewHeader entry={preview.entry} note={preview.truncated ? 'Extracted text truncated' : 'PDF preview'}>
            {renderPreviewActions(preview.entry)}
          </PreviewHeader>
          <div className="file-preview__pdf">
            {preview.pageUrl ? (
              <img className="file-preview__pdf-page" src={preview.pageUrl} alt={`${preview.entry.name} page 1`} />
            ) : (
              <div className="file-preview__empty file-preview__empty--inline">{preview.renderError || 'Unable to render PDF page.'}</div>
            )}
            {preview.text ? <pre className="file-preview__pre">{preview.text}</pre> : null}
          </div>
        </>
      )
    }

    if (preview.status === 'artifact') {
      return (
        <>
          <PreviewHeader entry={preview.entry} note="Live artifact — edits by the agent appear here as they happen">
            {renderPreviewActions(preview.entry)}
          </PreviewHeader>
          <iframe
            className="file-preview__artifact"
            src={artifactUrl(preview.entry.path, { embed: true })}
            title={`${preview.entry.name} artifact`}
          />
        </>
      )
    }

    if (preview.status === 'document') {
      return (
        <>
          <PreviewHeader
            entry={preview.entry}
            note={preview.messages.length > 0 ? `DOCX preview with ${preview.messages.length} conversion note(s)` : 'DOCX preview'}
          >
            {renderPreviewActions(preview.entry)}
          </PreviewHeader>
          <div className="file-preview__document-wrap" onClick={onDocumentHtmlClick}>
            <article className="file-preview__document" dangerouslySetInnerHTML={{ __html: preview.html }} />
          </div>
        </>
      )
    }

    return (
      <>
        <PreviewHeader
          entry={preview.entry}
          note={
            preview.editable
              ? preview.truncated
                ? 'Preview truncated'
                : dirty
                  ? 'Unsaved changes'
                  : 'Editable'
              : preview.truncated
                ? 'Read-only truncated preview'
                : 'Read-only preview'
          }
        >
          {isMarkdown(preview.entry) && preview.editable && !mdEditing ? (
            <button className="icon-btn" disabled={busy || preview.truncated} onClick={() => setMdEditing(true)} title="Edit source">
              Edit
            </button>
          ) : null}
          {preview.editable && (mdEditing || !isMarkdown(preview.entry)) ? (
            <button className="icon-btn" disabled={busy || !dirty || preview.truncated} onClick={() => void saveDraft()}>
              Save
            </button>
          ) : null}
          {renderPreviewActions(preview.entry)}
        </PreviewHeader>
        {isMarkdown(preview.entry) ? (
          mdEditing ? (
            <div className="file-preview__markdown-split">
              {renderTextEditor(preview, draftText, setDraftText, setDirty)}
              <div className="file-preview__markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ArtifactMarkdownLink }}>
                  {preview.editable ? draftText : preview.text}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="file-preview__markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ArtifactMarkdownLink }}>
                {preview.editable && dirty ? draftText : preview.text}
              </ReactMarkdown>
            </div>
          )
        ) : (
          renderTextEditor(preview, draftText, setDraftText, setDirty)
        )}
      </>
    )
  }

  if (!open) return null

  return (
    <div
      className={`file-panel${dragActive ? ' file-panel--drag' : ''}`}
      style={{ height: sheetHeight }}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      <div className="file-panel__handle" onPointerDown={onHandlePointerDown} title="Drag to resize" />
      {dragActive ? <div className="file-panel__drop">Drop into {root === 'skills' ? 'Skills' : 'Workspace'}</div> : null}
      <div className="file-panel__top">
        <div className="file-panel__title">
          <FolderIcon />
          Files
        </div>
        <div className="file-panel__folders">
          <button className={`file-folder${root === 'workspace' ? ' file-folder--active' : ''}`} onClick={() => selectRoot('workspace')}>
            <FolderIcon />
            <span>Workspace</span>
            <span className="file-folder__count">{counts.workspace}</span>
          </button>
          <button className={`file-folder${root === 'skills' ? ' file-folder--active' : ''}`} onClick={() => selectRoot('skills')}>
            <FolderIcon />
            <span>Skills</span>
            <span className="file-folder__count">{counts.skills}</span>
          </button>
        </div>
        <div className="file-panel__actions">
          <button className="icon-btn" disabled={busy} onClick={() => fileInputRef.current?.click()} title="Upload files">
            <UploadIcon />
            Upload
          </button>
          {root === 'skills' ? (
            <button className="icon-btn" disabled={busy} onClick={() => dirInputRef.current?.click()} title="Import skill folder">
              <FolderUpIcon />
              Import
            </button>
          ) : null}
          <button
            className="icon-btn"
            disabled={busy || currentDirEntries.length === 0}
            onClick={() => void downloadDirectory(currentDir)}
            title="Download current folder as ZIP"
          >
            <DownloadIcon />
            Download
          </button>
          <button className="icon-btn" onClick={onClose} title="Close files">
            <CloseIcon />
          </button>
        </div>
      </div>

      {downloadStatus ? <div className="file-panel__status" role="status">{downloadStatus}</div> : null}
      <div className="file-panel__body file-panel__body--single">
        {selectedPath ? null : (
        <div className="file-panel__browser">
          {root === 'skills' && <ReplExtensions onSource={(path) => setSelectedPath(path)} />}
          {root === 'skills' && skills.length > 0 ? (
            <div className="skill-strip">
              {skills.map((skill) => (
                <div key={skill.path} className="skill-chip" title={skill.description}>
                  <span className="skill-chip__name">${skill.name}</span>
                  <span className="skill-chip__desc">{skill.shortDescription || skill.description}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="file-panel__crumbs">
            {breadcrumbs.map((crumb, index) => (
              <button
                key={crumb.path}
                className={`file-crumb${index === breadcrumbs.length - 1 ? ' file-crumb--active' : ''}`}
                draggable
                title={`${crumb.path} — drag into the message to attach`}
                onDragStart={(event) => setMentionDragData(event, crumb.path, true)}
                onClick={() => selectDirectory(crumb.path)}
              >
                {crumb.label}
              </button>
            ))}
            {breadcrumbs.length > 1 ? (
              <div className="file-panel__crumb-actions">
                {onAttach ? (
                  <button className="icon-btn" onClick={() => onAttach(currentDir, { folder: true })} title="Attach this folder to message">
                    <AtIcon />
                  </button>
                ) : null}
                <button className="icon-btn" onClick={() => void copyPath(currentDir)} title="Copy folder path">
                  <CopyIcon />
                </button>
              </div>
            ) : null}
          </div>

          <div className="file-list">
            {visible.folders.length === 0 && visible.files.length === 0 ? (
              <div className="file-list__empty">No files.</div>
            ) : (
              <>
                {visible.folders.map((folder) => (
                  <div
                    key={folder.path}
                    className="file-row file-row--folder"
                    role="button"
                    tabIndex={0}
                    draggable
                    title={`${folder.path} — drag into the message to attach`}
                    onDragStart={(event) => setMentionDragData(event, folder.path, true)}
                    onClick={() => selectDirectory(folder.path)}
                    onKeyDown={(event) => onFolderKeyDown(event, folder)}
                  >
                    <FolderIcon />
                    <div className="file-row__body">
                      <div className="file-row__name">{folder.name}</div>
                      <div className="file-row__meta">
                        {folder.count} file{folder.count === 1 ? '' : 's'} · {formatBytes(folder.size)}
                      </div>
                    </div>
                    <div className="file-row__actions">
                      {onAttach ? (
                        <button
                          className="icon-btn"
                          onClick={(event) => {
                            event.stopPropagation()
                            onAttach(folder.path, { folder: true })
                          }}
                          title="Attach folder to message"
                        >
                          <AtIcon />
                        </button>
                      ) : null}
                      <button
                        className="icon-btn"
                        onClick={(event) => {
                          event.stopPropagation()
                          void copyPath(folder.path)
                        }}
                        title="Copy folder path"
                      >
                        <CopyIcon />
                      </button>
                      <button
                        className="icon-btn"
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation()
                          void downloadDirectory(folder.path)
                        }}
                        title="Download folder"
                      >
                        <DownloadIcon />
                      </button>
                    </div>
                  </div>
                ))}
                {visible.files.map((entry) => (
                <div
                  key={entry.path}
                  className={`file-row${selectedPath === entry.path ? ' file-row--active' : ''}`}
                  role="button"
                  tabIndex={0}
                  draggable
                  title={`${entry.path} — drag into the message to attach`}
                  onDragStart={(event) => setMentionDragData(event, entry.path, false)}
                  onClick={() => openEntry(entry)}
                  onKeyDown={(event) => onRowKeyDown(event, entry)}
                >
                  <FileIcon mediaType={entry.mediaType} />
                  <div className="file-row__body">
                    <div className="file-row__name">{relativeToDirectory(entry.path, currentDir) || entry.name}</div>
                    <div className="file-row__meta">
                      {entry.mediaType} · {formatBytes(entry.size)}
                    </div>
                  </div>
                  <div className="file-row__actions">
                    <button
                      className="icon-btn"
                      onClick={(event) => {
                        event.stopPropagation()
                        void copyPath(entry.path)
                      }}
                      title="Copy file path"
                    >
                      <CopyIcon />
                    </button>
                    <button
                      className="file-row__download icon-btn"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation()
                        void downloadFile(entry)
                      }}
                      title="Download file"
                    >
                      <DownloadIcon />
                    </button>
                    <button
                      className="file-row__delete icon-btn"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation()
                        void remove(entry.path)
                      }}
                      title="Delete file"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
                ))}
              </>
            )}
          </div>
        </div>
        )}

        {selectedPath ? <div className="file-preview">{renderPreview()}</div> : null}
      </div>

      <input
        ref={fileInputRef}
        className="file-panel__input"
        type="file"
        multiple
        onChange={(event) => void upload(event.currentTarget.files, root)}
      />
      <input
        ref={dirInputRef}
        className="file-panel__input"
        type="file"
        multiple
        onChange={(event) => void upload(event.currentTarget.files, 'skills')}
      />
    </div>
  )
}

function PreviewHeader({
  entry,
  note,
  children,
}: {
  entry: VfsEntry
  note?: string
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="file-preview__head">
      <FileIcon mediaType={entry.mediaType} />
      <div className="file-preview__title">
        <div className="file-preview__name">{entry.path}</div>
        <div className="file-preview__meta">
          {entry.mediaType} · {formatBytes(entry.size)}
          {note ? ` · ${note}` : ''}
        </div>
      </div>
      {children ? <div className="file-preview__actions">{children}</div> : null}
    </div>
  )
}

function ArtifactMarkdownLink({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.ReactElement {
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

async function loadPreview(entry: VfsEntry): Promise<PreviewState> {
  const vfs = getRuntime().vfs

  if (isImage(entry)) {
    return { status: 'image', entry, dataUrl: await vfs.dataUrl(entry.path) }
  }

  if (isPdf(entry)) {
    const [pageResult, textResult] = await Promise.allSettled([
      vfs.renderPdfPage(entry.path, { page: 1, scale: 1.2 }),
      vfs.readText(entry.path, { maxChars: EXTRACTED_PREVIEW_CHARS }),
    ])
    const page = pageResult.status === 'fulfilled' ? pageResult.value : undefined
    const text = textResult.status === 'fulfilled' ? textResult.value : undefined

    return {
      status: 'pdf',
      entry,
      pageUrl: page ? `data:${page.mediaType};base64,${page.base64}` : undefined,
      width: page?.width,
      height: page?.height,
      text: text?.text ?? '',
      truncated: text?.truncated ?? false,
      totalChars: text?.totalChars ?? 0,
      renderError: pageResult.status === 'rejected' ? errorMessage(pageResult.reason) : undefined,
    }
  }

  if (isHtmlArtifactEntry(entry)) return { status: 'artifact', entry }

  if (isDocx(entry)) {
    const result = await vfs.readHtml(entry.path)
    return {
      status: 'document',
      entry,
      html: sanitizeDocumentHtml(result.html),
      messages: result.messages,
    }
  }

  if (isEditableText(entry) || isDocx(entry)) {
    const result = await vfs.readText(entry.path, {
      maxChars: isEditableText(entry) ? TEXT_PREVIEW_CHARS : EXTRACTED_PREVIEW_CHARS,
    })
    return {
      status: 'text',
      entry,
      text: result.text,
      editable: isEditableText(entry) && !result.truncated,
      truncated: result.truncated,
      totalChars: result.totalChars,
    }
  }

  return {
    status: 'binary',
    entry,
    message: 'Preview unavailable for this file type. The agent can still read bytes or use the file through sandbox APIs.',
  }
}

function renderTextEditor(
  preview: Extract<PreviewState, { status: 'text' }>,
  draftText: string,
  setDraftText: (text: string) => void,
  setDirty: (dirty: boolean) => void,
): React.ReactElement {
  return (
    <textarea
      className="file-preview__editor"
      value={preview.editable ? draftText : preview.text}
      readOnly={!preview.editable || preview.truncated}
      spellCheck={false}
      onChange={(event) => {
        setDraftText(event.currentTarget.value)
        setDirty(true)
      }}
    />
  )
}

function onDocumentHtmlClick(event: React.MouseEvent<HTMLDivElement>): void {
  const target = event.target
  const link = target instanceof Element ? target.closest('a') : null
  const href = link?.getAttribute('href')
  if (!href || !isVfsPath(href)) return
  event.preventDefault()
  void openArtifact(href)
}

function buildDirectoryView(entries: VfsEntry[], dirPath: string): DirectoryView {
  const folders = new Map<string, FolderSummary>()
  const files: VfsEntry[] = []

  for (const entry of entries) {
    const rel = relativeToDirectory(entry.path, dirPath)
    if (!rel) continue
    const [first, ...rest] = rel.split('/')
    if (!first) continue
    if (rest.length === 0) {
      files.push(entry)
      continue
    }

    const folderPath = `${dirPath}/${first}`
    const current = folders.get(folderPath)
    folders.set(folderPath, {
      path: folderPath,
      name: first,
      count: (current?.count ?? 0) + 1,
      size: (current?.size ?? 0) + entry.size,
      updatedAt: Math.max(current?.updatedAt ?? 0, entry.updatedAt),
    })
  }

  return {
    folders: Array.from(folders.values()).sort((a, b) => a.name.localeCompare(b.name)),
    files: files.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function normalizeDirForRoot(dirPath: string, root: VfsRoot): string {
  const rootPath = `/${root}`
  if (dirPath === rootPath || dirPath.startsWith(`${rootPath}/`)) return dirPath.replace(/\/+$/g, '') || rootPath
  return rootPath
}

function directoryBreadcrumbs(dirPath: string): Array<{ label: string; path: string }> {
  const parts = dirPath.split('/').filter(Boolean)
  const crumbs: Array<{ label: string; path: string }> = []
  let path = ''
  for (const part of parts) {
    path += `/${part}`
    crumbs.push({ label: part === 'workspace' ? 'Workspace' : part === 'skills' ? 'Skills' : part, path })
  }
  return crumbs
}

function relativeToDirectory(path: string, dirPath: string): string {
  const dir = dirPath.endsWith('/') ? dirPath : `${dirPath}/`
  if (!path.startsWith(dir)) return ''
  return path.slice(dir.length)
}

function isPathUnderDirectory(path: string, dirPath: string): boolean {
  const dir = dirPath.endsWith('/') ? dirPath : `${dirPath}/`
  return path.startsWith(dir)
}

function pathBasename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? 'download'
}

function safeDownloadName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+$/g, 'download').trim() || 'download'
}

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const url = await blobToDataUrl(blob)
  const downloadId = await new Promise<number>((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: 'uniquify',
      },
      (id) => {
        const error = chrome.runtime.lastError
        if (error) {
          reject(new Error(error.message))
          return
        }
        if (typeof id !== 'number') {
          reject(new Error('Chrome did not create a download item.'))
          return
        }
        resolve(id)
      },
    )
  })
  await waitForDownload(downloadId)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('failed to serialize download'))
    reader.readAsDataURL(blob)
  })
}

function waitForDownload(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      chrome.downloads.onChanged.removeListener(onChanged)
      if (err) reject(err)
      else resolve()
    }

    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) return
      if (delta.error?.current) finish(new Error(`Chrome download interrupted: ${delta.error.current}`))
      else if (delta.state?.current === 'interrupted') finish(new Error('Chrome download interrupted.'))
      else if (delta.state?.current === 'complete') finish()
    }

    const timer = window.setTimeout(() => {
      finish(new Error(`Chrome did not finish the download within ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s.`))
    }, DOWNLOAD_TIMEOUT_MS)

    chrome.downloads.onChanged.addListener(onChanged)
    chrome.downloads.search({ id: downloadId }, (items) => {
      const error = chrome.runtime.lastError
      if (error) {
        finish(new Error(error.message))
        return
      }
      const item = items[0]
      if (!item) return
      if (item.error) finish(new Error(`Chrome download interrupted: ${item.error}`))
      else if (item.state === 'interrupted') finish(new Error('Chrome download interrupted.'))
      else if (item.state === 'complete') finish()
    })
  })
}

async function toggleSticky(path: string, open?: boolean): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ target: 'background', type: 'stickies.set', path, open } satisfies StickyRuntimeMessage)
  } catch (err) {
    debugLog.error('ui', 'toggle sticky', err)
  }
}

async function openArtifact(path: string): Promise<void> {
  await chrome.tabs.create({ url: artifactUrl(path), active: true })
}

async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const itemEntries = Array.from(dataTransfer.items ?? [])
    .map((item) => {
      const withEntry = item as DataTransferItem & { webkitGetAsEntry?: () => BrowserFileSystemEntry | null }
      return (withEntry.webkitGetAsEntry?.() ?? null) as BrowserFileSystemEntry | null
    })
    .filter((entry): entry is BrowserFileSystemEntry => entry !== null)

  if (itemEntries.length > 0) {
    const groups = await Promise.all(itemEntries.map((entry) => collectEntryFiles(entry)))
    return groups.flat()
  }

  return Array.from(dataTransfer.files ?? []).map((file) => ({ file, relativePath: file.name }))
}

async function collectEntryFiles(entry: BrowserFileSystemEntry, parentPath = ''): Promise<DroppedFile[]> {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name

  if (entry.isFile) {
    const file = await readEntryFile(entry as BrowserFileSystemFileEntry)
    return [{ file, relativePath }]
  }

  if (entry.isDirectory) {
    const children = await readDirectoryEntries(entry as BrowserFileSystemDirectoryEntry)
    const groups = await Promise.all(children.map((child) => collectEntryFiles(child, relativePath)))
    return groups.flat()
  }

  return []
}

function readEntryFile(entry: BrowserFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject)
  })
}

async function readDirectoryEntries(entry: BrowserFileSystemDirectoryEntry): Promise<BrowserFileSystemEntry[]> {
  const reader = entry.createReader()
  const out: BrowserFileSystemEntry[] = []

  for (;;) {
    const batch = await new Promise<BrowserFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (batch.length === 0) break
    out.push(...batch)
  }

  return out
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`
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

function isEditableText(entry: VfsEntry): boolean {
  if (entry.mediaType.startsWith('text/')) return true
  return [
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'image/svg+xml',
  ].includes(entry.mediaType)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function FolderIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M1.8 4.4h10.4v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.4Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.8 4.6V3.3a1 1 0 0 1 1-1h3l1.1 1.4h4.3a1 1 0 0 1 1 1v.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function FileIcon({ mediaType }: { mediaType: string }): React.ReactElement {
  const folded = mediaType.startsWith('image/') || mediaType === 'application/pdf'
  return (
    <svg className="file-row__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 1.8h5.2L12 4.6v9.6H4V1.8Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {folded ? <path d="M9.2 1.9v2.8H12" fill="none" stroke="currentColor" strokeWidth="1.2" /> : null}
      {mediaType.startsWith('image/') ? <circle cx="7" cy="8" r="1.2" fill="currentColor" /> : null}
    </svg>
  )
}

function UploadIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 10.5V2.2M3.8 5.4 7 2.2l3.2 3.2M2.2 11.8h9.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FolderUpIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M1.8 4.5h10.4v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 8 7 6l2 2M7 6v4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DownloadIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 2v7M4.2 6.4 7 9.2l2.8-2.8M2.5 11.8h9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CopyIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" aria-hidden="true">
      <rect x="5" y="4.5" width="7" height="8.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10 4.5V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function AtIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M9.9 7.5v1a1.6 1.6 0 0 0 3.2 0v-1a5.6 5.6 0 1 0-2.2 4.45"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function OpenIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M5 3h6v6M10.8 3.2 5.2 8.8M3.2 4.8v6h6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <path d="M2.5 3.6h8M5 3.6V2.4h3v1.2M4 5v5.4M6.5 5v5.4M9 5v5.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
