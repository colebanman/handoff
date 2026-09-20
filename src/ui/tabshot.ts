import type { OffscreenRuntimeMessage, TabShotCaptureResult } from '../shared/execution-protocol'

/** Keep capture refs in the execution host, where subsequent agent clicks run. */
export async function captureTabShot(tabId: number): Promise<TabShotCaptureResult> {
  const response = await chrome.runtime.sendMessage({
    target: 'background', type: 'tabshot.capture', tabId,
  } satisfies OffscreenRuntimeMessage) as { ok: boolean; value?: TabShotCaptureResult; error?: string } | undefined
  if (!response?.ok || !response.value) throw new Error(response?.error ?? 'TabShot capture failed')
  return response.value
}
