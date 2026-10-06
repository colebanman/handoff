import type { ModelMessage, UserModelMessage } from 'ai'
import { isRuntimeContextText } from './context-blocks'

export interface BrowserMessageContext {
  text: string
  tabId: number | null
}

/** Shared by the sender and service worker. The chat's own full-tab UI is
 * never the implicit page target. Callers should retain this capture rather
 * than query Chrome again after the user has switched tabs. */
export async function getBrowserContextTab(): Promise<chrome.tabs.Tab | undefined> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const chatUrl = chrome.runtime?.getURL?.('sidepanel.html')
  if (!chatUrl || !active?.url?.startsWith(chatUrl)) return active
  const tabs = await chrome.tabs.query({ currentWindow: true })
  return tabs.filter(tab => /^(https?|file):/i.test(tab.url ?? ''))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
}

export function browserContextMetadata(tabId: number | null): Pick<UserModelMessage, 'providerOptions'> {
  return { providerOptions: { harness: { contextTabId: tabId } } }
}

/** Metadata stays in the persisted transcript, including on retry/resume.
 * Older chats fall back to their already-attached ambient context text. */
export function latestContextTabId(messages: readonly unknown[]): number | null | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ModelMessage | undefined
    if (message?.role !== 'user') continue
    const workingTabId = message.providerOptions?.harness?.workingTabId
    if (typeof workingTabId === 'number' && Number.isInteger(workingTabId)) return workingTabId
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : ''
    if (!text.trim() || isRuntimeContextText(text)) continue
    const tabId = message.providerOptions?.harness?.contextTabId
    if (tabId === null || typeof tabId === 'number' && Number.isInteger(tabId)) return tabId
    const context = /<context>\nLocal time:[\s\S]*?<\/context>\s*$/.exec(text)?.[0]
    const id = context && /\nActive tab: \[(\d+)\]/.exec(context)?.[1]
    return id ? Number(id) : undefined
  }
  return undefined
}

/** Routing metadata is for our harness, not an extra provider capability. */
export function withoutBrowserContextMetadata(messages: ModelMessage[]): ModelMessage[] {
  return messages.map(message => {
    if (!message.providerOptions?.harness) return message
    const { harness: _harness, ...providerOptions } = message.providerOptions
    return { ...message, providerOptions }
  })
}
