/**
 * Opening the stream inspector window (`stream-debug.html`).
 *
 * Shared by the Settings button and the dev build's auto-open at store init, so
 * there is exactly one definition of "the inspector window" — including its
 * dedupe rule. The side panel is opened and closed constantly during testing,
 * and a naive create-on-init would spawn a fresh popup every time; we remember
 * the window id in `chrome.storage.session` (per browser session, cleared on
 * restart, needs no permission beyond `storage`) and reuse a live one.
 *
 * Focus is opt-in. Auto-open at startup must NOT steal focus from the panel the
 * user is about to type into; an explicit click from Settings should.
 */

import { debugLog } from './debug-log'

const WINDOW_ID_KEY = 'streamInspectorWindowId'

async function liveWindowId(): Promise<number | undefined> {
  try {
    const out = await chrome.storage.session.get(WINDOW_ID_KEY)
    const id = out[WINDOW_ID_KEY]
    if (typeof id !== 'number') return undefined
    // chrome.windows.get rejects for a window the user already closed.
    await chrome.windows.get(id)
    return id
  } catch {
    return undefined
  }
}

/**
 * Open the inspector, or surface the one already open. Never throws — this is a
 * debugging affordance and must not break the caller (notably store init).
 */
export async function openStreamInspector(opts?: { focus?: boolean }): Promise<void> {
  const focus = opts?.focus ?? true
  try {
    const existing = await liveWindowId()
    if (existing !== undefined) {
      if (focus) await chrome.windows.update(existing, { focused: true })
      return
    }
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL('stream-debug.html'),
      type: 'popup',
      width: 960,
      height: 900,
      focused: focus,
    })
    if (typeof created?.id === 'number') {
      await chrome.storage.session.set({ [WINDOW_ID_KEY]: created.id })
    }
  } catch (err) {
    debugLog.error('ui', 'openStreamInspector', err)
  }
}
