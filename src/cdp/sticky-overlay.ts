import { beginDiagnosticOperation } from '../shared/runtime-diagnostics'
import { uid } from '../shared/ids'

/** Page perception/input must never target the assistant's own controls. */
export async function withoutStickyOverlay<T>(tabId: number, hide: boolean, execute: () => Promise<T>): Promise<T> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return execute()
  const id = uid('sticky-input')
  const send = async (active: boolean) => {
    const diagnostic = beginDiagnosticOperation('overlay', active ? 'suspend stickies' : 'restore stickies', { tabId })
    diagnostic.update('waiting for content-script acknowledgement')
    try { return await chrome.tabs.sendMessage(tabId, { type: 'stickies.automation', id, active, hide }, { frameId: 0 }) }
    catch { return undefined }
    finally { diagnostic.finish() }
  }
  await send(true)
  try { return await execute() }
  finally { await send(false) }
}
