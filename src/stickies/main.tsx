import { createRoot } from 'react-dom/client'
import { Stickies } from './Stickies'
import styles from './stickies.css?inline'

// Closed shadow root keeps page styles and page scripts out of note contents.
// Only the note cards intercept input; the surrounding page stays interactive.
if (!document.querySelector('[data-ai-stickies-host]')) {
  const host = document.createElement('div')
  host.dataset.aiStickiesHost = ''
  host.popover = 'manual'
  host.style.setProperty('all', 'initial', 'important')
  host.style.setProperty('position', 'fixed', 'important')
  host.style.setProperty('inset', '0', 'important')
  host.style.setProperty('pointer-events', 'none', 'important')
  host.style.setProperty('z-index', '2147483646', 'important')
  for (const [key, value] of Object.entries({ margin: '0', padding: '0', border: '0', background: 'transparent', width: 'auto', height: 'auto', overflow: 'visible' })) host.style.setProperty(key, value, 'important')
  const shadow = host.attachShadow({ mode: 'closed' })
  const css = document.createElement('style')
  css.textContent = styles
  const root = document.createElement('div')
  shadow.append(css, root)
  document.documentElement.append(host)
  // The browser top layer also stays above pages using the maximum z-index.
  // Both calls throw if the popover is already in the state being asked for
  // (or while the document is mid-transition), and an escaped throw here would
  // leave the notes behind the page for the rest of the session.
  const raise = () => { try { if (!host.matches(':popover-open')) host.showPopover() } catch { /* stays in normal stacking */ } }
  raise()
  // Re-entering the top layer after a fullscreen change puts the notes back above the fullscreen element.
  document.addEventListener('fullscreenchange', () => {
    try { if (host.matches(':popover-open')) host.hidePopover() } catch { /* already hidden */ }
    raise()
  })
  const leases = new Map<string, { hide: boolean; timer: ReturnType<typeof setTimeout> }>()
  const sync = () => {
    host.toggleAttribute('data-sticky-automation', leases.size > 0)
    host.toggleAttribute('data-sticky-snapshot', [...leases.values()].some((lease) => lease.hide))
    host.inert = leases.size > 0
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'stickies.automation' || typeof message.id !== 'string') return false
    const old = leases.get(message.id)
    if (old) clearTimeout(old.timer)
    leases.delete(message.id)
    if (message.active) {
      const id = message.id
      leases.set(id, { hide: !!message.hide, timer: setTimeout(() => { leases.delete(id); sync() }, 30_000) })
    }
    sync()
    reply({ ok: true })
    return false
  })
  createRoot(root).render(<Stickies />)
}
