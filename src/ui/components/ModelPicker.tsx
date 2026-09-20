/**
 * Model picker for the composer control row: curated fallbacks plus the
 * signed-in ChatGPT account catalog, with a "Custom…" entry that swaps to free
 * text.
 *
 * Hand-rolled dropdown, never a native <select>: the OS popup can't be themed
 * and renders bright against the glass surface. Consequences of owning the
 * popover ourselves:
 *  - the composer is flush with the bottom of a ~360–480px side panel, so the
 *    menu opens UPWARD (absolute inside the relative wrapper — no portal) and
 *    caps at 40vh with internal scroll so it can never leave the panel;
 *  - `rows` flattens every selectable entry in DOM order so the roving
 *    activeIndex (ArrowUp/Down + Enter) lines up with what's on screen; the
 *    "Loading account models…" row is deliberately absent from it.
 *
 * The account catalog is fetched on FIRST open, never on mount: the request
 * needs a live ChatGPT session and most turns never touch the picker.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MODEL_OPTIONS,
  type CuratedModelProvider,
  type ModelOption,
  type ProviderKind,
} from '../../shared/types'
import { listChatGPTModels } from '../../agent/openai-chatgpt-oauth'

const CUSTOM = '__custom__'

const MODEL_GROUPS: { provider: CuratedModelProvider; label: string }[] = [
  { provider: 'openai', label: 'OpenAI' },
  { provider: 'xai', label: 'xAI' },
  { provider: 'cerebras', label: 'Cerebras' },
  { provider: 'openai-compatible', label: 'Local' },
]

export function ModelPicker({
  modelId,
  provider,
  openaiAuthMode,
  availableProviders,
  onChange,
  loadModels = listChatGPTModels,
}: {
  modelId: string
  provider: ProviderKind
  openaiAuthMode?: 'api-key' | 'chatgpt'
  /** Curated groups with a live credential — groups the user can't run are
   * hidden rather than offered as dead ends (Custom… always remains). */
  availableProviders: CuratedModelProvider[]
  onChange: (modelId: string) => void
  loadModels?: () => Promise<ModelOption[]>
}): React.ReactElement {
  const [customMode, setCustomMode] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [chatgptModels, setChatgptModels] = useState<ModelOption[]>([])
  const [catalogState, setCatalogState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [catalogRequested, setCatalogRequested] = useState(false)
  /** Bumped when reopening after a failed fetch, so an error is never terminal. */
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const useChatGPTCatalog = provider === 'openai' && openaiAuthMode === 'chatgpt'
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!useChatGPTCatalog) {
      setChatgptModels((prev) => (prev.length > 0 ? [] : prev))
      setCatalogState('idle')
      setCatalogRequested(false)
      return
    }
    if (!catalogRequested) return
    let cancelled = false
    setCatalogState('loading')
    loadModels()
      .then((models) => {
        if (cancelled) return
        setChatgptModels(models)
        setCatalogState('idle')
      })
      .catch(() => {
        if (!cancelled) setCatalogState('error')
      })
    return () => {
      cancelled = true
    }
  }, [useChatGPTCatalog, catalogRequested, catalogAttempt, loadModels])

  const options = useMemo(() => {
    const byId = new Map(MODEL_OPTIONS.map((option) => [option.id, option]))
    for (const option of chatgptModels) byId.set(option.id, option)
    return [...byId.values()]
  }, [chatgptModels])

  const groups = useMemo(
    () =>
      MODEL_GROUPS.filter((group) => availableProviders.includes(group.provider))
        .map((group) => ({
          provider: group.provider,
          label: group.provider === 'openai' && useChatGPTCatalog ? 'ChatGPT' : group.label,
          models: options.filter((m) => m.provider === group.provider),
          loading: group.provider === 'openai' && catalogState === 'loading',
        }))
        .filter((group) => group.models.length > 0 || group.loading),
    [options, useChatGPTCatalog, catalogState, availableProviders],
  )
  const rows = useMemo(
    () => [...groups.flatMap((group) => group.models.map((m) => m.id)), CUSTOM],
    [groups],
  )

  const isKnownModel = options.some((m) => m.id === modelId)
  const triggerLabel = options.find((m) => m.id === modelId)?.label ?? modelId

  const select = useCallback(
    (id: string) => {
      setOpen(false)
      if (id === CUSTOM) setCustomMode(true)
      else onChange(id)
    },
    [onChange],
  )

  // Outside click closes; the trigger lives inside wrapRef, so its own click
  // falls through to the toggle instead of a close-then-reopen flicker.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const path = e.composedPath()
      const root = wrapRef.current?.getRootNode()
      if (path.includes(wrapRef.current!) || path.includes(menuRef.current!)) return
      if (root instanceof ShadowRoot && e.target === root.host) return
      setOpen(false)
    }
    const root = wrapRef.current?.getRootNode()
    document.addEventListener('mousedown', onDoc)
    if (root instanceof ShadowRoot) root.addEventListener('mousedown', onDoc as EventListener)
    return () => { document.removeEventListener('mousedown', onDoc); if (root instanceof ShadowRoot) root.removeEventListener('mousedown', onDoc as EventListener) }
  }, [open])

  // Document-level keys: focus stays on the trigger while open (any click
  // elsewhere closes first), so this never steals keys from the textarea.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.stopPropagation()
        e.preventDefault()
        setActiveIndex((i) => (e.key === 'ArrowDown' ? i + 1 : i - 1 + rows.length) % rows.length)
      } else if (e.key === 'Enter') {
        e.stopPropagation()
        e.preventDefault()
        const id = rows[activeIndex]
        if (id) select(id)
      }
    }
    const root = wrapRef.current?.getRootNode() ?? document
    root.addEventListener('keydown', onKey as EventListener, true)
    return () => root.removeEventListener('keydown', onKey as EventListener, true)
  }, [open, rows, activeIndex, select])

  // The catalog can land while the menu is open and lengthen the list.
  useEffect(() => {
    setActiveIndex((i) => (i < rows.length ? i : Math.max(0, rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])


  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    if (useChatGPTCatalog) {
      // Retry a failed fetch on reopen — the ChatGPT session/network may be
      // back; otherwise one transient error would pin the curated fallbacks
      // for the whole panel lifetime.
      if (catalogState === 'error') setCatalogAttempt((n) => n + 1)
      setCatalogRequested(true)
    }
    const start = rows.indexOf(isKnownModel ? modelId : CUSTOM)
    setActiveIndex(start >= 0 ? start : 0)
    setOpen(true)
  }

  if (customMode) {
    return (
      <input
        className="model-picker__input"
        autoFocus
        defaultValue={isKnownModel ? '' : modelId}
        placeholder={provider === 'gateway' ? 'provider/model-id' : 'model-id'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const v = (e.target as HTMLInputElement).value.trim()
            if (v) onChange(v)
            setCustomMode(false)
          } else if (e.key === 'Escape') {
            setCustomMode(false)
          }
        }}
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (v) onChange(v)
          setCustomMode(false)
        }}
      />
    )
  }

  const customIndex = rows.length - 1
  const menu = open ? (
    <div ref={menuRef} className="model-picker__menu" role="listbox" aria-label="Model">
      {groups.map((group) => (
        <div className="model-picker__group" key={group.provider} role="group" aria-label={group.label}>
          <div className="model-picker__group-label">{group.label}</div>
          {group.models.map((m) => {
            const index = rows.indexOf(m.id)
            const selected = isKnownModel && m.id === modelId
            return <button key={m.id} ref={index === activeIndex ? activeRef : undefined} type="button" role="option"
              aria-selected={selected} className={optionClass(index === activeIndex, selected)}
              onMouseEnter={() => setActiveIndex(index)} onClick={() => select(m.id)}>
              <span className="model-picker__option-label">{m.label}</span>
              {selected ? <CheckGlyph /> : null}
            </button>
          })}
          {group.loading ? <div className="model-picker__note">Loading account models…</div> : null}
        </div>
      ))}
      <div className="model-picker__sep" role="presentation" />
      <button ref={customIndex === activeIndex ? activeRef : undefined} type="button" role="option"
        aria-selected={!isKnownModel} className={optionClass(customIndex === activeIndex, !isKnownModel)}
        onMouseEnter={() => setActiveIndex(customIndex)} onClick={() => select(CUSTOM)}>
        <span className="model-picker__option-label">{!isKnownModel && modelId ? modelId : 'Custom…'}</span>
        {!isKnownModel ? <CheckGlyph /> : null}
      </button>
    </div>
  ) : null
  return (
    <div className="model-picker" ref={wrapRef}>
      <button type="button" className="model-picker__trigger" aria-haspopup="listbox" aria-expanded={open}
        title={catalogState === 'error' ? 'Model (ChatGPT catalog refresh failed; showing defaults)' : 'Model'} onClick={toggle}>
        <span className="model-picker__value">{triggerLabel || 'Model'}</span><ChevronGlyph />
      </button>
      {menu}
    </div>
  )
}

function optionClass(active: boolean, selected: boolean): string {
  return `model-picker__option${active ? ' model-picker__option--active' : ''}${
    selected ? ' model-picker__option--selected' : ''
  }`
}

function ChevronGlyph(): React.ReactElement {
  return (
    <svg className="model-picker__chev" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M2 4 5 7l3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckGlyph(): React.ReactElement {
  return (
    <svg className="model-picker__check" width="11" height="9" viewBox="0 0 11 9" aria-hidden="true">
      <path
        d="M1 4.7 4 7.6 10 1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
