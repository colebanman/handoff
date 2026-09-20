/**
 * Small, serializable messages shared by the service worker, offscreen
 * navigation tracker, and side-panel UI. Keep these payloads deliberately
 * compact: context-menu handoffs become model context and navigation records
 * may be emitted several times during an OAuth redirect chain.
 */

export const HANDOFF_STORAGE_KEY = 'browser-handoff-queue'
export const CONTEXT_MENU_ROOT_ID = 'handoff-context-root'
export const CONTEXT_MENU_ADD_ID = 'handoff-add-to-chat'
export const CONTEXT_MENU_RESEARCH_ID = 'handoff-research-this'

export type BrowserContextKind = 'selection' | 'link' | 'image' | 'media' | 'page'

export interface BrowserContextAttachment {
  id: string
  kind: BrowserContextKind
  tabId?: number
  windowId?: number
  title?: string
  /** Page on which the context menu was opened. */
  pageUrl?: string
  /** Present when the context came from a child frame. */
  frameUrl?: string
  /** Link, image, audio, or video URL that was clicked. */
  targetUrl?: string
  /** Selected text, compacted before it leaves the service worker. */
  text?: string
  capturedAt: number
}

export interface BrowserHandoff {
  id: string
  action: 'add-to-chat' | 'research-this'
  context: BrowserContextAttachment
  createdAt: number
}

export type NavigationEventKind = 'committed' | 'history' | 'error' | 'created-target'

export interface CompactNavigationEvent {
  tabId: number
  at: number
  kind: NavigationEventKind
  /** Origin + pathname and query-key names only; query values and hashes never cross the boundary. */
  url: string
  frameId: number
  documentId?: string
  transitionType?: string
  transitionQualifiers?: string[]
  error?: string
  authHint?: boolean
  sourceTabId?: number
}

export interface NavigationTrail {
  tabId: number
  updatedAt: number
  /** True when the recent route resembles an OAuth/SSO/MFA flow. */
  authLikely: boolean
  entries: CompactNavigationEvent[]
}

export type BrowserRuntimeMessage =
  | { target: 'background'; type: 'handoff.claim'; windowId?: number }
  | { target: 'background'; type: 'offscreen.ensure' }
  | { target: 'ui'; type: 'handoff.available' }
  | { target: 'offscreen'; type: 'navigation.record'; event: CompactNavigationEvent }
  | { target: 'offscreen'; type: 'navigation.remove'; tabId: number }
  | { target: 'offscreen'; type: 'navigation.get'; tabId: number }
  | { target: 'offscreen'; type: 'offscreen.ping' }

export async function claimBrowserHandoffs(): Promise<BrowserHandoff[]> {
  let windowId: number | undefined
  try {
    windowId = (await chrome.windows.getCurrent()).id
  } catch {
    // Claiming without a window is still safe in single-panel contexts.
  }
  const response = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'handoff.claim',
    windowId,
  } satisfies BrowserRuntimeMessage) as { handoffs?: BrowserHandoff[] } | undefined
  return Array.isArray(response?.handoffs) ? response.handoffs : []
}

export async function ensureOffscreenRuntime(): Promise<boolean> {
  const response = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'offscreen.ensure',
  } satisfies BrowserRuntimeMessage) as { ok?: boolean } | undefined
  return response?.ok === true
}

export async function getNavigationTrail(tabId: number): Promise<NavigationTrail | undefined> {
  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'navigation.get',
      tabId,
    } satisfies BrowserRuntimeMessage) as { trail?: NavigationTrail } | undefined
    return response?.trail
  } catch {
    return undefined
  }
}

/**
 * Automatic model-facing note for redirect chains. Ordinary single-site
 * navigation stays silent; only likely auth/SSO/MFA flows and recent failures
 * consume context.
 */
export function formatNavigationTrail(trail: NavigationTrail | undefined): string {
  if (!trail) return ''
  const recent = trail.entries.filter((entry) => Date.now() - entry.at <= 5 * 60_000)
  const hasError = recent.some((entry) => entry.kind === 'error')
  if (!trail.authLikely && !hasError) return ''

  const deduped = recent.filter((entry, index, all) => {
    const previous = all[index - 1]
    return !previous || previous.url !== entry.url || previous.kind !== entry.kind || previous.frameId !== entry.frameId
  }).slice(-8)
  if (deduped.length === 0) return ''

  const lines = deduped.map((entry) => {
    const frame = entry.frameId === 0 ? '' : ` (auth frame ${entry.frameId})`
    const error = entry.error ? ` — ${entry.error}` : ''
    return `- ${entry.kind}: ${entry.url}${frame}${error}`
  })
  return `<navigation_context>\nChrome observed a recent ${trail.authLikely ? 'OAuth/SSO/MFA-style redirect chain' : 'navigation failure'} in this tab. Query values and URL fragments were intentionally removed:\n${lines.join('\n')}\nTreat intermediate login, account-choice, MFA, and callback pages as one continuing navigation flow. Wait for redirects to settle; ask the user only when the current page actually requires login, an account choice, MFA, or CAPTCHA.\n</navigation_context>`
}
