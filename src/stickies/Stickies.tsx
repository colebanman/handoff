import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  STICKY_PORT,
  STICKY_ANCHORS,
  type StickyAnchor,
  type StickyBackgroundToPage,
  type StickyPageToBackground,
  type StickyPin,
  type StickyView,
} from '../shared/stickies'

/**
 * Page overlay for stickies: small glass cards pinned to a corner, rendering
 * the sticky's Markdown with live checkboxes. Everything the user does here —
 * ticking, editing, folding, dragging, closing — goes straight to the sticky
 * host, which rewrites the workspace file; the new state comes back over the
 * same port, so cards never hold local truth beyond the edit draft.
 */

function connect(onItems: (items: StickyView[]) => void, onError: (message: string) => void) {
  let port: chrome.runtime.Port | undefined
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const open = (): void => {
    try {
      const current = chrome.runtime.connect({ name: STICKY_PORT })
      port = current
      current.onMessage.addListener((message: StickyBackgroundToPage) => {
        if (message.type === 'stickies') onItems(message.items)
        else if (message.type === 'error') onError(message.message)
      })
      current.onDisconnect.addListener(() => {
        void chrome.runtime.lastError
        if (port !== current) return
        port = undefined
        if (!stopped) timer = setTimeout(open, 1500)
      })
      current.postMessage({ type: 'hello' } satisfies StickyPageToBackground)
    } catch { /* extension reloaded; the page keeps working without stickies */ }
  }
  open()
  return {
    send(message: StickyPageToBackground): void { try { port?.postMessage(message) } catch { /* reconnecting */ } },
    close(): void { stopped = true; clearTimeout(timer); port?.disconnect() },
  }
}

/**
 * Line number of the enclosing list item. remark-gfm synthesises the task
 * checkbox without source positions, so the line has to come from the `li`.
 */
const TaskLine = createContext<number | undefined>(undefined)

function Icon({ name }: { name: 'chevron' | 'close' | 'edit' | 'check' | 'grip' }) {
  const paths = {
    chevron: 'm7 10 5 5 5-5',
    close: 'm6 6 12 12M6 18 18 6',
    edit: 'M4 20h4l10-10-4-4L4 16v4zM13 7l4 4',
    check: 'm5 12 5 5 9-10',
    grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

export function Stickies() {
  const [items, setItems] = useState<StickyView[]>([])
  const [notice, setNotice] = useState('')
  const client = useRef<ReturnType<typeof connect>>(undefined)
  useEffect(() => {
    client.current = connect(setItems, (message) => {
      setNotice(message)
      setTimeout(() => setNotice(''), 4000)
    })
    const onVisible = (): void => { if (document.visibilityState === 'visible') client.current?.send({ type: 'hello' }) }
    document.addEventListener('visibilitychange', onVisible)
    return () => { client.current?.close(); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
  const send = (message: StickyPageToBackground): void => client.current?.send(message)
  const [sizes, setSizes] = useState<Map<string, Size>>(new Map())
  const spots = usePinSpots(items, sizes)
  const measure = (id: string, size: Size | undefined): void => setSizes((prev) => {
    const old = prev.get(id)
    if (size ? old && old.w === size.w && old.h === size.h : !old) return prev
    const next = new Map(prev)
    if (size) next.set(id, size); else next.delete(id)
    return next
  })
  if (!items.length) return null
  // A pin that resolves places the card itself; one whose element is missing
  // falls back to the sticky's corner, so nothing is ever lost off-screen.
  const pinned = items.filter((item) => spots.get(item.id))
  const flowed = items.filter((item) => !spots.has(item.id))
  return (
    <>
      {STICKY_ANCHORS.map((anchor) => {
        const group = flowed.filter((item) => item.position === anchor)
        return group.length ? (
          <div key={anchor} className={`stickies stickies--${anchor}`}>
            {group.map((item) => <StickyCard key={item.id} item={item} send={send} />)}
          </div>
        ) : null
      })}
      {pinned.map((item) => {
        const spot = spots.get(item.id)!
        return (
          <div
            key={item.id}
            className="stickies stickies--pinned"
            style={{ left: `${spot.left}px`, top: `${spot.top}px` }}
            ref={(node) => observeSize(node, (size) => measure(item.id, size))}
          >
            <StickyCard item={item} send={send} pinned />
          </div>
        )
      })}
      {notice ? <div className="sticky-notice glass" role="status">{notice}</div> : null}
    </>
  )
}

interface Size { w: number; h: number }
interface Spot { left: number; top: number }

/** Watch a card's box so element pins can align to its real height. */
function observeSize(node: HTMLElement | null, report: (size: Size | undefined) => void): (() => void) | void {
  if (!node) return
  report({ w: node.offsetWidth, h: node.offsetHeight })
  const observer = new ResizeObserver(() => report({ w: node.offsetWidth, h: node.offsetHeight }))
  observer.observe(node)
  return () => { observer.disconnect(); report(undefined) }
}

/**
 * Where each pinned sticky currently sits, in viewport px. Recomputed on
 * scroll (including inner scrollers, hence capture) and resize, plus a slow
 * poll for layout that moves on its own. An id missing from the map means the
 * pin did not resolve — render that card in its corner instead.
 */
function usePinSpots(items: StickyView[], sizes: Map<string, Size>): Map<string, Spot | undefined> {
  const [spots, setSpots] = useState<Map<string, Spot | undefined>>(new Map())
  useEffect(() => {
    const pinned = items.filter((item) => item.pin)
    if (!pinned.length) { setSpots((prev) => (prev.size ? new Map() : prev)); return }
    const compute = (): void => {
      const next = new Map<string, Spot | undefined>()
      for (const item of pinned) {
        const spot = spotFor(item.pin!, item.dx, item.dy, sizes.get(item.id))
        if (spot !== 'unresolved') next.set(item.id, spot === 'hidden' ? undefined : spot)
      }
      setSpots((prev) => (sameSpots(prev, next) ? prev : next))
    }
    compute()
    const timer = setInterval(compute, 400)
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      clearInterval(timer)
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [items, sizes])
  return spots
}

function sameSpots(a: Map<string, Spot | undefined>, b: Map<string, Spot | undefined>): boolean {
  if (a.size !== b.size) return false
  for (const [id, spot] of b) {
    const old = a.get(id)
    if (!a.has(id) || !!old !== !!spot) return false
    if (old && spot && (Math.round(old.left) !== Math.round(spot.left) || Math.round(old.top) !== Math.round(spot.top))) return false
  }
  return true
}

const PIN_GAP = 10
const EDGE = 8

/** 'unresolved' → fall back to the corner; 'hidden' → the anchor scrolled out of view. */
function spotFor(pin: StickyPin, dx: number, dy: number, size: Size | undefined): Spot | 'unresolved' | 'hidden' {
  const w = size?.w ?? 300
  const h = size?.h ?? 140
  let left: number
  let top: number
  if (pin.kind === 'point') {
    left = pin.x - (pin.origin === 'page' ? window.scrollX : 0)
    top = pin.y - (pin.origin === 'page' ? window.scrollY : 0)
  } else {
    let element: Element | null = null
    try { element = document.querySelector(pin.selector) } catch { return 'unresolved' }
    if (!element) return 'unresolved'
    const rect = element.getBoundingClientRect()
    if (!rect.width && !rect.height) return 'unresolved'
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return 'hidden'
    left = pin.side === 'right' ? rect.right + PIN_GAP
      : pin.side === 'left' ? rect.left - w - PIN_GAP
      : pin.align === 'center' ? rect.left + rect.width / 2 - w / 2
      : pin.align === 'end' ? rect.right - w
      : rect.left
    top = pin.side === 'below' ? rect.bottom + PIN_GAP
      : pin.side === 'above' ? rect.top - h - PIN_GAP
      : pin.align === 'center' ? rect.top + rect.height / 2 - h / 2
      : pin.align === 'end' ? rect.bottom - h
      : rect.top
  }
  return {
    left: Math.max(EDGE, Math.min(left + dx, window.innerWidth - w - EDGE)),
    top: Math.max(EDGE, Math.min(top + dy, window.innerHeight - h - EDGE)),
  }
}

function StickyCard({ item, send, pinned = false }: { item: StickyView; send: (message: StickyPageToBackground) => void; pinned?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.body)
  const [offset, setOffset] = useState({ dx: item.dx, dy: item.dy })
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; moved: boolean }>(undefined)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLElement>(null)
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    onResize() // re-run once the card is measurable so the first paint can be clamped
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  /** Offset we just sent; the card holds it until the host echoes it back, so the drop never snaps back to the old spot first. */
  const settling = useRef<{ dx: number; dy: number; at: number }>(undefined)
  useEffect(() => {
    if (dragging) return
    const wanted = settling.current
    if (wanted) {
      const arrived = wanted.dx === item.dx && wanted.dy === item.dy
      // Give up waiting if the write never lands (error, reload) rather than freeze.
      if (!arrived && Date.now() - wanted.at < 4000) return
      settling.current = undefined
      if (arrived) return
    }
    setOffset({ dx: item.dx, dy: item.dy })
  }, [item.dx, item.dy, dragging])
  useEffect(() => { if (!editing) setDraft(item.body) }, [item.body, editing])
  useEffect(() => { if (editing) requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(draft.length, draft.length) }) }, [editing])

  const sign = (): [number, number] => (pinned ? [1, 1] : dragSign(item.position))

  /**
   * Dragging is driven from the window, not from the header, and the header's
   * pointer capture is only an optimisation on top of it. Capture can be lost
   * mid-drag — the card re-renders, the overlay goes inert, the pointer crosses
   * a cross-origin iframe — and a header-only drag then never sees the
   * pointerup: it stays "grabbed" and re-attaches to the cursor the next time
   * it passes over the card. Window listeners see every event in the document,
   * a released button is detected even when the release itself happened
   * somewhere unreachable, and every exit path tears the drag down exactly once.
   */
  const stopDrag = useRef<(() => void)>(undefined)
  useEffect(() => () => stopDrag.current?.(), [])

  const startDrag = (event: React.PointerEvent): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    // Stops the press from starting a page text selection that the drag would then extend.
    event.preventDefault()
    stopDrag.current?.()
    const node = event.currentTarget as HTMLElement
    const pointerId = event.pointerId
    const state = { x: event.clientX, y: event.clientY, dx: offset.dx, dy: offset.dy, moved: false }
    drag.current = state
    const at = { x: event.clientX, y: event.clientY }
    try { node.setPointerCapture(pointerId) } catch { /* capture is a nicety; the window listeners are the drag */ }

    const teardown = (): void => {
      if (stopDrag.current !== teardown) return
      stopDrag.current = undefined
      drag.current = undefined
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      window.removeEventListener('blur', onCancel)
      try { node.releasePointerCapture(pointerId) } catch { /* never captured, or already released */ }
    }

    const commit = (): void => {
      const [sx, sy] = sign()
      setDragging(false)
      const final = { dx: Math.round(state.dx + (at.x - state.x) * sx), dy: Math.round(state.dy + (at.y - state.y) * sy) }
      settling.current = { ...final, at: Date.now() }
      setOffset(final)
      send({ type: 'set', id: item.id, dx: final.dx, dy: final.dy })
    }

    function onMove(moveEvent: PointerEvent): void {
      if (moveEvent.pointerId !== pointerId) return
      // Button already up: the release happened where we could not hear it.
      if (moveEvent.buttons === 0) { onUp(moveEvent); return }
      at.x = moveEvent.clientX
      at.y = moveEvent.clientY
      if (!state.moved && Math.hypot(at.x - state.x, at.y - state.y) < 4) return
      const [sx, sy] = sign()
      state.moved = true
      setDragging(true)
      setOffset({ dx: state.dx + (at.x - state.x) * sx, dy: state.dy + (at.y - state.y) * sy })
    }

    function onUp(upEvent: PointerEvent): void {
      if (upEvent.pointerId !== pointerId) return
      if (upEvent.type === 'pointerup') { at.x = upEvent.clientX; at.y = upEvent.clientY }
      const moved = state.moved
      teardown()
      if (moved) commit()
      else send({ type: 'set', id: item.id, collapsed: !item.collapsed })
    }

    /** Cancelled or interrupted: settle wherever the card is now rather than stay grabbed. */
    function onCancel(): void {
      const moved = state.moved
      teardown()
      if (moved) commit()
    }

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('blur', onCancel)
    stopDrag.current = teardown
  }
  const save = (): void => {
    setEditing(false)
    if (draft !== item.body) send({ type: 'edit', id: item.id, body: draft, revision: item.revision })
  }
  const cancel = (): void => { setDraft(item.body); setEditing(false) }

  const live = useRef({ send, id: item.id })
  live.current = { send, id: item.id }
  const components = useMemo(() => ({
    li: ({ node, children, ...props }: { node?: MarkdownNode; children?: ReactNode; className?: string }) => {
      const line = node?.position?.start.line
      return <li {...props}>{line === undefined ? children : <TaskLine.Provider value={line}>{children}</TaskLine.Provider>}</li>
    },
    input: ({ node, ...props }: { node?: MarkdownNode; checked?: boolean; type?: string; disabled?: boolean }) => <TaskCheckbox {...props} live={live} />,
    a: ({ children, ...props }: { children?: ReactNode; href?: string }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
  }), [])

  const [sx, sy] = sign()
  const shown = dragging || pinned ? offset : keepOnScreen(offset, card.current, viewport)
  return (
    <section
      ref={card}
      className={`sticky glass${item.collapsed ? ' sticky--collapsed' : ''}${dragging ? ' sticky--dragging' : ''}`}
      style={{ transform: `translate(${shown.dx * sx}px, ${shown.dy * sy}px)` }}
      aria-label={`Sticky: ${item.title}`}
    >
      <header className="sticky-head" onPointerDown={startDrag}>
        <span className="sticky-grip" aria-hidden="true"><Icon name="grip" /></span>
        <span className="sticky-title">{item.title}</span>
        {!item.collapsed && !editing ? (
          <button type="button" className="sticky-btn" title="Edit" aria-label="Edit sticky" onClick={() => setEditing(true)}><Icon name="edit" /></button>
        ) : null}
        <button type="button" className="sticky-btn" title={item.collapsed ? 'Expand' : 'Collapse'} aria-label={item.collapsed ? 'Expand sticky' : 'Collapse sticky'} aria-expanded={!item.collapsed}
          onClick={() => send({ type: 'set', id: item.id, collapsed: !item.collapsed })}>
          <span className={`sticky-chevron${item.collapsed ? ' is-collapsed' : ''}`}><Icon name="chevron" /></span>
        </button>
        <button type="button" className="sticky-btn" title="Close (keeps the note in your workspace)" aria-label="Close sticky" onClick={() => send({ type: 'set', id: item.id, open: false })}><Icon name="close" /></button>
      </header>
      {item.collapsed ? null : editing ? (
        <div className="sticky-editor">
          <textarea
            ref={textarea}
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); cancel() }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save() }
            }}
          />
          <div className="sticky-editor-row">
            <span>Markdown · ⌘↵ to save</span>
            <button type="button" className="sticky-btn" onClick={cancel}>Cancel</button>
            <button type="button" className="sticky-btn sticky-btn--primary" onClick={save}><Icon name="check" />Save</button>
          </div>
        </div>
      ) : (
        <div className="sticky-body" onDoubleClick={() => setEditing(true)}>
          {item.body.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{item.body}</ReactMarkdown>
          ) : <p className="sticky-empty">Empty note — double-click to write.</p>}
        </div>
      )}
    </section>
  )
}

interface MarkdownNode { position?: { start: { line: number } } }

/** A task checkbox that writes straight through to the sticky file. */
function TaskCheckbox({ live, checked, type, ...props }: {
  live: { current: { send: (message: StickyPageToBackground) => void; id: string } }
  checked?: boolean
  type?: string
}) {
  const line = useContext(TaskLine)
  if (type !== 'checkbox') return <input type={type} checked={checked} readOnly {...props} />
  return (
    <input
      type="checkbox"
      className="sticky-check"
      checked={!!checked}
      disabled={line === undefined}
      onChange={(event) => { if (line !== undefined) live.current.send({ type: 'toggle-task', id: live.current.id, line, checked: event.currentTarget.checked }) }}
    />
  )
}

/**
 * A card dragged to the far side of a wide window must not end up off-screen
 * (and unreachable) when the window is later made narrow. The stored offset is
 * left alone, so the card returns to where the user put it once there is room.
 */
function keepOnScreen(offset: { dx: number; dy: number }, node: HTMLElement | null, viewport: { w: number; h: number }): { dx: number; dy: number } {
  if (!node) return offset
  return {
    dx: Math.max(-12, Math.min(offset.dx, viewport.w - node.offsetWidth - 28)),
    dy: Math.max(-12, Math.min(offset.dy, viewport.h - node.offsetHeight - 100)),
  }
}

/** Drag offsets are stored as distance from the anchor corner, so the sign depends on the corner. */
function dragSign(anchor: StickyAnchor): [number, number] {
  return [anchor.endsWith('right') ? -1 : 1, anchor.startsWith('bottom') ? -1 : 1]
}
