/**
 * MV3 coordinator: opens the side panel, owns privileged browser event
 * listeners, queues context-menu handoffs, and forwards secret-safe navigation
 * records to the offscreen runtime anchor.
 */

import {
  CONTEXT_MENU_ADD_ID,
  CONTEXT_MENU_RESEARCH_ID,
  CONTEXT_MENU_ROOT_ID,
  HANDOFF_STORAGE_KEY,
  type BrowserContextAttachment,
  type BrowserHandoff,
  type BrowserRuntimeMessage,
  type CompactNavigationEvent,
  type NavigationEventKind,
} from '../shared/browser-events'
import { initBridge } from './bridge'
import { initAgentHost } from './agent-host'
import type { OffscreenRuntimeMessage } from '../shared/execution-protocol'

const OFFSCREEN_PATH = 'offscreen.html'
const MAX_HANDOFFS = 12
const MAX_SELECTION_CHARS = 4_000

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[handoff] setPanelBehavior failed', err))

// Loopback bridge for local coding agents (Claude Code, Cursor, the `handoff`
// CLI). Registers its own listeners synchronously at worker start-up, which is
// what lets an alarm revive a terminated worker and redial the daemon.
initBridge()

/* ---- offscreen lifecycle ------------------------------------------------ */

let creatingOffscreen: Promise<void> | undefined

async function hasOffscreenDocument(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH)
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  })
  return contexts.length > 0
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return
  if (creatingOffscreen) return creatingOffscreen
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['LOCAL_STORAGE'],
      justification: 'Host sandbox/VFS DOM work, active-turn keepalive, and a short-lived redacted navigation trail.',
    })
    .finally(() => {
      creatingOffscreen = undefined
    })
  return creatingOffscreen
}

// The service worker owns agent loops/controllers. DOM-only pieces (sandbox
// iframe, document extraction/rendering) are reached through the offscreen
// document, which also supplies best-effort keepalive traffic during a run.
const agentHost = initAgentHost(ensureOffscreenDocument)

/* ---- context menu handoffs --------------------------------------------- */

function createMenuItem(options: chrome.contextMenus.CreateProperties): void {
  chrome.contextMenus.create(options, () => {
    const err = chrome.runtime.lastError
    if (err) console.error('[handoff] contextMenus.create failed', err.message)
  })
}

async function installContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll()
  const contexts: NonNullable<chrome.contextMenus.CreateProperties['contexts']> = [
    'selection',
    'link',
    'image',
    'video',
    'audio',
    'page',
  ]
  createMenuItem({ id: CONTEXT_MENU_ROOT_ID, title: 'Handoff', contexts })
  createMenuItem({ id: CONTEXT_MENU_ADD_ID, parentId: CONTEXT_MENU_ROOT_ID, title: 'Add to chat', contexts })
  createMenuItem({ id: CONTEXT_MENU_RESEARCH_ID, parentId: CONTEXT_MENU_ROOT_ID, title: 'Research this', contexts })
}

let contextMenuInstall: Promise<void> | undefined
function ensureContextMenus(): Promise<void> {
  if (contextMenuInstall) return contextMenuInstall
  contextMenuInstall = installContextMenus().finally(() => {
    contextMenuInstall = undefined
  })
  return contextMenuInstall
}

void ensureContextMenus().catch((err) => console.error('[handoff] context menu setup failed', err))
chrome.runtime.onInstalled.addListener((details) => {
  void ensureContextMenus().catch((err) => console.error('[handoff] context menu install failed', err))
  // Ordinary reloads preserve learned code and memory. Fresh resets are explicit in Settings.
})

function compactText(value: string | undefined, maxChars: number): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function contextUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(code|state|token|access_token|id_token|session_state|samlresponse|samlrequest|relaystate)$/i.test(key)) {
        parsed.searchParams.set(key, '[redacted]')
      }
    }
    parsed.hash = ''
    return parsed.toString().slice(0, 1_500)
  } catch {
    return value.slice(0, 1_500)
  }
}

function contextFromClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): BrowserContextAttachment {
  const targetUrl = info.linkUrl ?? info.srcUrl
  const kind: BrowserContextAttachment['kind'] = info.selectionText
    ? 'selection'
    : info.linkUrl
      ? 'link'
      : info.mediaType === 'image'
        ? 'image'
        : info.mediaType
          ? 'media'
          : 'page'
  const now = Date.now()
  return {
    id: `ctx-${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
    kind,
    tabId: tab?.id,
    windowId: tab?.windowId,
    title: compactText(tab?.title, 180),
    pageUrl: contextUrl(info.pageUrl ?? tab?.url),
    frameUrl: info.frameUrl && info.frameUrl !== info.pageUrl ? contextUrl(info.frameUrl) : undefined,
    targetUrl: contextUrl(targetUrl),
    text: compactText(info.selectionText, MAX_SELECTION_CHARS),
    capturedAt: now,
  }
}

let handoffMutation: Promise<unknown> = Promise.resolve()

function serializeHandoffMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = handoffMutation.then(fn, fn)
  handoffMutation = run.catch(() => undefined)
  return run
}

async function enqueueHandoff(handoff: BrowserHandoff): Promise<void> {
  await serializeHandoffMutation(async () => {
    const stored = await chrome.storage.session.get(HANDOFF_STORAGE_KEY)
    const queue = Array.isArray(stored[HANDOFF_STORAGE_KEY])
      ? stored[HANDOFF_STORAGE_KEY] as BrowserHandoff[]
      : []
    await chrome.storage.session.set({
      [HANDOFF_STORAGE_KEY]: [...queue, handoff].slice(-MAX_HANDOFFS),
    })
  })
  chrome.runtime.sendMessage({ target: 'ui', type: 'handoff.available' } satisfies BrowserRuntimeMessage).catch(() => {})
}

async function claimHandoffs(windowId?: number): Promise<BrowserHandoff[]> {
  return serializeHandoffMutation(async () => {
    const stored = await chrome.storage.session.get(HANDOFF_STORAGE_KEY)
    const queue = Array.isArray(stored[HANDOFF_STORAGE_KEY])
      ? stored[HANDOFF_STORAGE_KEY] as BrowserHandoff[]
      : []
    const claimed = windowId === undefined
      ? queue
      : queue.filter((handoff) => handoff.context.windowId === undefined || handoff.context.windowId === windowId)
    const remaining = queue.filter((handoff) => !claimed.includes(handoff))
    if (remaining.length > 0) await chrome.storage.session.set({ [HANDOFF_STORAGE_KEY]: remaining })
    else if (queue.length > 0) await chrome.storage.session.remove(HANDOFF_STORAGE_KEY)
    return claimed
  })
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ADD_ID && info.menuItemId !== CONTEXT_MENU_RESEARCH_ID) return
  const action = info.menuItemId === CONTEXT_MENU_RESEARCH_ID ? 'research-this' : 'add-to-chat'
  const context = contextFromClick(info, tab)
  const handoff: BrowserHandoff = {
    id: `handoff-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
    action,
    context,
    createdAt: Date.now(),
  }

  // Opening is initiated synchronously from the context-menu user gesture.
  const openPanel = tab?.windowId === undefined
    ? Promise.resolve()
    : chrome.sidePanel.open({ windowId: tab.windowId })
  void Promise.all([openPanel, enqueueHandoff(handoff)]).catch((err) => {
    console.error('[handoff] context-menu handoff failed', err)
  })
})

/* ---- compact web-navigation tracking ----------------------------------- */

const AUTH_HOST_OR_PATH = /(^|[.\/-])(login|signin|sign-in|auth|oauth|sso|saml|duo|okta|auth0|mfa|authorize|adfs)([.\/-]|$)/i
const AUTH_HOSTS = /(^|\.)(login\.microsoftonline\.com|login\.live\.com|duosecurity\.com|okta\.com|auth0\.com)$/i
const AUTH_QUERY_KEYS = new Set(['code', 'state', 'session_state', 'samlrequest', 'samlresponse', 'relaystate', 'id_token'])

function compactNavigationUrl(rawUrl: string): { url: string; authHint: boolean } | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined
    const queryKeys = [...new Set([...parsed.searchParams.keys()].map((key) => key.toLowerCase()))].slice(0, 12)
    const authHint =
      AUTH_HOSTS.test(parsed.hostname) ||
      AUTH_HOST_OR_PATH.test(`${parsed.hostname}${parsed.pathname}`) ||
      queryKeys.some((key) => AUTH_QUERY_KEYS.has(key))
    const queryShape = queryKeys.length > 0 ? `?${queryKeys.join('&')}` : ''
    return { url: `${parsed.origin}${parsed.pathname}${queryShape}`, authHint }
  } catch {
    return undefined
  }
}

async function forwardNavigationEvent(event: CompactNavigationEvent): Promise<void> {
  await ensureOffscreenDocument()
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'navigation.record', event } satisfies BrowserRuntimeMessage)
}

function recordNavigation(
  kind: NavigationEventKind,
  details: {
    tabId: number
    timeStamp: number
    url: string
    frameId: number
    documentId?: string
    transitionType?: string
    transitionQualifiers?: string[]
    error?: string
    sourceTabId?: number
  },
): void {
  if (details.tabId < 0) return
  const compact = compactNavigationUrl(details.url)
  if (!compact) return
  // Child-frame churn is noisy; retain only auth/MFA frames. Main-frame
  // commits are always useful for reconstructing the redirect chain.
  if (details.frameId !== 0 && !compact.authHint) return
  const event: CompactNavigationEvent = {
    tabId: details.tabId,
    at: Date.now(),
    kind,
    url: compact.url,
    frameId: details.frameId,
    documentId: details.documentId,
    transitionType: details.transitionType,
    transitionQualifiers: details.transitionQualifiers,
    error: compactText(details.error, 240),
    authHint: compact.authHint || undefined,
    sourceTabId: details.sourceTabId,
  }
  void forwardNavigationEvent(event).catch((err) => console.error('[handoff] navigation record failed', err))
}

chrome.webNavigation.onCommitted.addListener((details) => {
  recordNavigation('committed', details)
  // The agent's pointer lives in the page; a top-frame commit wipes it.
  if (details.frameId === 0) agentHost.cdp.onNavigated?.(details.tabId, 'committed')
})

chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
  if (details.frameId === 0) agentHost.cdp.onNavigated?.(details.tabId, 'domcontentloaded')
})

chrome.tabs.onActivated.addListener((activeInfo) => {
  agentHost.cdp.onTabActivated?.(activeInfo.tabId)
})

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  recordNavigation('history', details)
})

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  recordNavigation('error', details)
})

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  recordNavigation('created-target', {
    ...details,
    frameId: 0,
    sourceTabId: details.sourceTabId,
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void ensureOffscreenDocument()
    .then(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'navigation.remove', tabId } satisfies BrowserRuntimeMessage))
    .catch(() => {})
})

/* ---- requests from extension pages ------------------------------------- */

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const runtimeMessage = raw as Partial<OffscreenRuntimeMessage>
  if (runtimeMessage.target === 'background') {
    if (runtimeMessage.type === 'execution.keepalive') {
      sendResponse({ ok: true })
      return false
    }
    const handled = agentHost.handleRuntimeMessage(runtimeMessage)
    if (handled) {
      void handled.then(
        (value) => sendResponse({ ok: true, value }),
        (error) => sendResponse({ ok: false, error: String(error instanceof Error ? error.message : error) }),
      )
      return true
    }
  }

  const message = raw as Partial<BrowserRuntimeMessage>
  if (message.target !== 'background') return false

  if (message.type === 'handoff.claim') {
    const windowId = 'windowId' in message && typeof message.windowId === 'number' ? message.windowId : undefined
    void claimHandoffs(windowId).then(
      (handoffs) => sendResponse({ handoffs }),
      (error) => sendResponse({ handoffs: [], error: String(error) }),
    )
    return true
  }

  if (message.type === 'offscreen.ensure') {
    void ensureOffscreenDocument().then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error) }),
    )
    return true
  }

  return false
})
