import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installErrorHooks, debugLog } from '../shared/debug-log'
import { ownPanel, focusOwnedPanel } from './panel-ownership'
import { isFullTab, type PanelViewMessage } from '../shared/panel-view'
import './theme.css'
import { installPhaseLock } from './phase-lock'

installErrorHooks()
// Ambient loops (shimmer, breathing rings, dots) share one clock, so content
// that re-creates them mid-stream never restarts them. See phase-lock.ts.
installPhaseLock()
document.documentElement.dataset.view = isFullTab() ? 'tab' : 'panel'

const rootEl = document.getElementById('root')
if (!rootEl) {
  debugLog.log('error', 'main: #root not found')
  throw new Error('#root not found')
}

const root = createRoot(rootEl)
root.render(<main className="panel-standby" role="status">Opening the extension…</main>)
const showWaiting = (): void => root.render(
  <main className="panel-standby">
    <h1>The extension is already open</h1>
    <p>Continue in the open chat. This view will become available when that one closes.</p>
    <button onClick={focusOwnedPanel}>Go to open chat</button>
  </main>,
)

// Importing the app is deferred too: standby windows must not initialize
// stores, migrations, filesystem helpers, or the external-agent bridge.
ownPanel(async () => {
  const app = import('./App')
  // Only the lock owner responds. Waiting views must never load the store.
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const message = raw as Partial<PanelViewMessage> | null
    if (message?.target !== 'ui' || message.type !== 'panel.prepare-tab' || isFullTab()) return false
    void app.then(async () => {
      const { savePanelDraft } = await import('./store')
      await savePanelDraft()
    }).then(
      () => sendResponse({ ok: true }),
      (error: unknown) => sendResponse({ ok: false, error: String(error) }),
    )
    return true
  })
  const { App } = await app
  root.render(<StrictMode><App /></StrictMode>)
  debugLog.log('ui', 'panel mounted')
}, showWaiting, (error) => {
  debugLog.error('ui', 'panel ownership', error)
  root.render(<main className="panel-standby"><h1>Unable to open the extension</h1><p>Close this panel and open it again.</p></main>)
})
