import { FULL_TAB_PATH, type PanelViewMessage } from '../shared/panel-view'

let opening: Promise<void> | undefined

/** Serialize repeated clicks so they focus one shared chat tab. */
export function openFullTab(windowId?: number): Promise<void> {
  if (opening) return opening
  opening = open(windowId).finally(() => { opening = undefined })
  return opening
}

async function open(windowId?: number): Promise<void> {
  const url = chrome.runtime.getURL(FULL_TAB_PATH)
  const tabs = await chrome.tabs.query({})
  const existing = tabs.find((tab) => (tab.url ?? tab.pendingUrl)?.split('#')[0] === url)
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true })
    await chrome.windows.update(existing.windowId, { focused: true })
    return
  }

  // Create the destination first, so a failed tab creation never closes the
  // user's panel. Its normal ownership lock keeps it idle until we close it.
  const tab = await chrome.tabs.create({ url, active: false, ...(windowId === undefined ? {} : { windowId }) })
  try {
    const response = await chrome.runtime.sendMessage({ target: 'ui', type: 'panel.prepare-tab' } satisfies PanelViewMessage)
      .catch((error: unknown) => {
        // No owner yet (e.g. opened straight from the toolbar with no sidebar).
        if (/Receiving end does not exist/.test(String(error))) return undefined
        throw error
      }) as { ok: boolean; error?: string } | undefined
    if (response && !response.ok) throw new Error(response.error ?? 'Unable to save the current chat draft')

    // setOptions works on Chrome 120 too. Disabling the global panel closes
    // its documents, releasing the single-writer lock without stopping the
    // service-worker-owned agent. Restore availability for the toolbar icon.
    try {
      await chrome.sidePanel.setOptions({ enabled: false })
    } finally {
      await chrome.sidePanel.setOptions({ enabled: true })
    }
    if (tab.id !== undefined) await chrome.tabs.update(tab.id, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true })
  } catch (error) {
    if (tab.id !== undefined) await chrome.tabs.remove(tab.id).catch(() => {})
    throw error
  }
}

export function initPanelView(): void {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    const message = raw as Partial<PanelViewMessage> | null
    if (message?.target !== 'background' || message.type !== 'panel.open-tab') return false
    void openFullTab(sender.tab?.windowId).then(
      () => sendResponse({ ok: true }),
      (error: unknown) => sendResponse({ ok: false, error: String(error) }),
    )
    return true
  })
}
