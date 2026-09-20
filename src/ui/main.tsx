import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installErrorHooks, debugLog } from '../shared/debug-log'
import { ownPanel, focusOwnedPanel } from './panel-ownership'
import './theme.css'

installErrorHooks()

const rootEl = document.getElementById('root')
if (!rootEl) {
  debugLog.log('error', 'main: #root not found')
  throw new Error('#root not found')
}

const root = createRoot(rootEl)
root.render(<main className="panel-standby" role="status">Opening the extension…</main>)
const showWaiting = (): void => root.render(
  <main className="panel-standby">
    <h1>The extension is already open in a different window</h1>
    <p>Use the existing panel to continue. This panel will become available when that one closes.</p>
    <button onClick={focusOwnedPanel}>Go to that window</button>
  </main>,
)

// Importing the app is deferred too: standby windows must not initialize
// stores, migrations, filesystem helpers, or the external-agent bridge.
ownPanel(async () => {
  const { App } = await import('./App')
  root.render(<StrictMode><App /></StrictMode>)
  debugLog.log('ui', 'panel mounted')
}, showWaiting, (error) => {
  debugLog.error('ui', 'panel ownership', error)
  root.render(<main className="panel-standby"><h1>Unable to open the extension</h1><p>Close this panel and open it again.</p></main>)
})
