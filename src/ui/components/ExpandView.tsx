import { useEffect, useState } from 'react'
import { isFullTab, type PanelViewMessage } from '../../shared/panel-view'
import { debugLog } from '../../shared/debug-log'

export function ExpandView(): React.ReactElement {
  const fullTab = isFullTab()
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const update = (): void => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])
  const label = fullTab ? (fullscreen ? 'Exit full screen' : 'Enter full screen') : 'Open in full tab'
  const expand = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (fullTab) {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await document.documentElement.requestFullscreen()
      } else {
        const response = await chrome.runtime.sendMessage({ target: 'background', type: 'panel.open-tab' } satisfies PanelViewMessage)
        if (!response?.ok) throw new Error(response?.error ?? 'Unable to open chat')
      }
    } catch (err) {
      debugLog.error('ui', 'expand view', err)
      setError('Unable to expand the chat. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button className="icon-btn" onClick={() => void expand()} disabled={busy} title={error || label} aria-label={label}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={fullscreen ? 'M2 6h4V2m8 4h-4V2M2 10h4v4m8-4h-4v4' : 'M6 2H2v4m8-4h4v4M2 10v4h4m4 0h4v-4'} />
        </svg>
      </button>
      {error ? <span className="view-error" role="alert">{error}</span> : null}
    </>
  )
}
