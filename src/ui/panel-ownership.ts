export const PANEL_LOCK = 'handoff-panel-owner-v1'
const PANEL_CHANNEL = 'handoff-panel-focus-v1'

/** The document owns this lock, not a window id or a service-worker port.
 * Moving/hiding a tab and restarting the worker cannot transfer ownership.
 * Chrome releases it when the document dies, then admits the next panel.
 */
export function ownPanel(
  onOwned: () => Promise<void>,
  onWaiting: () => void,
  onError: (error: unknown) => void,
): void {
  const hold = async (): Promise<void> => {
    try {
      const channel = new BroadcastChannel(PANEL_CHANNEL)
      channel.onmessage = (event) => {
        if (event.data !== 'focus') return
        void chrome.windows.getCurrent().then((win) => {
          if (win.id !== undefined) return chrome.windows.update(win.id, { focused: true })
        }).catch(console.error)
      }
      await onOwned()
    } catch (error) {
      onError(error)
    }
    // Never release on blur, visibilitychange, pagehide, or React cleanup:
    // the old store can still have async writers even after an unmount.
    await new Promise<void>(() => {})
  }
  void navigator.locks.request(PANEL_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) return hold()
    onWaiting()
    void navigator.locks.request(PANEL_LOCK, hold).catch(onError)
  }).catch(onError)
}

export function focusOwnedPanel(): void {
  const channel = new BroadcastChannel(PANEL_CHANNEL)
  channel.postMessage('focus')
  channel.close()
}
