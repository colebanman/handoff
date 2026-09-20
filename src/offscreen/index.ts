/**
 * Offscreen runtime anchor.
 *
 * Chrome exposes only chrome.runtime inside an offscreen document, so this is
 * owns DOM-only runtime pieces: the sandbox iframe, VFS extraction/rendering,
 * active-execution keepalive, and the small secret-safe navigation trail.
 * Agent loops and privileged dispatch remain in the service worker.
 */

import type {
  BrowserRuntimeMessage,
  CompactNavigationEvent,
  NavigationTrail,
} from '../shared/browser-events'
import type { OffscreenRuntimeMessage } from '../shared/execution-protocol'
import { createSandboxService } from '../sandbox/host'
import { createVirtualFileSystemService } from '../storage/vfs'
import type { CdpService, VirtualFileSystemService } from '../shared/types'
import { formatError } from '../shared/errors'

const MAX_EVENTS_PER_TAB = 16
const MAX_TRACKED_TABS = 40
const TRAIL_TTL_MS = 15 * 60_000
const STORAGE_KEY = 'redacted-navigation-trails-v1'

const trails = new Map<number, CompactNavigationEvent[]>()

function persistTrails(): void {
  try {
    const compact = [...trails.entries()]
      .map(([tabId, entries]) => [tabId, prune(entries)] as const)
      .filter(([, entries]) => entries.length > 0)
      .sort((a, b) => b[1][b[1].length - 1]!.at - a[1][a[1].length - 1]!.at)
      .slice(0, MAX_TRACKED_TABS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(compact))
  } catch {
    // Navigation context is best-effort; storage pressure must never affect browsing.
  }
}

function hydrateTrails(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Array<[number, CompactNavigationEvent[]]>
    for (const [tabId, entries] of raw) {
      if (typeof tabId !== 'number' || !Array.isArray(entries)) continue
      const live = prune(entries)
      if (live.length > 0) trails.set(tabId, live)
    }
    persistTrails()
  } catch {
    localStorage.removeItem(STORAGE_KEY)
  }
}

hydrateTrails()

/* ---- durable agent helpers --------------------------------------------- */

// Every sandbox exec supplies a background dispatcher, so these methods are
// intentionally unreachable. The cast keeps the ordinary sandbox host (and
// therefore one cancellation implementation) shared by panel and offscreen.
const unavailableCdp = new Proxy({}, {
  get: () => () => Promise.reject(new Error('CDP is only available in the service worker')),
}) as CdpService
const vfs = createVirtualFileSystemService()
const sandbox = createSandboxService(unavailableCdp, vfs)
const sandboxControllers = new Map<string, AbortController>()
const vfsControllers = new Map<string, AbortController>()
const activeRuns = new Set<string>()
let keepaliveTimer: ReturnType<typeof setInterval> | undefined

function refreshKeepalive(): void {
  if (activeRuns.size > 0 && keepaliveTimer === undefined) {
    // Chrome documents extension API activity as resetting the MV3 idle
    // timer. This is a best-effort keepalive, not a claim that MV3 workers can
    // never be reaped; checkpoints make an unexpected reap visible/recoverable.
    keepaliveTimer = setInterval(() => {
      void chrome.runtime.sendMessage({ target: 'background', type: 'execution.keepalive' } satisfies OffscreenRuntimeMessage)
    }, 20_000)
  } else if (activeRuns.size === 0 && keepaliveTimer !== undefined) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = undefined
  }
}

async function handleRuntimeMessage(message: OffscreenRuntimeMessage): Promise<unknown> {
  if (message.type === 'execution.activity') {
    if (message.active) activeRuns.add(message.runId)
    else activeRuns.delete(message.runId)
    refreshKeepalive()
    return { ok: true }
  }
  if (message.type === 'sandbox.cancel') {
    sandboxControllers.get(message.execId)?.abort(new DOMException(message.reason ?? 'Cancelled', 'AbortError'))
    return { ok: true }
  }
  if (message.type === 'sandbox.exec') {
    const controller = new AbortController()
    sandboxControllers.set(message.execId, controller)
    try {
      return await sandbox.exec({
        code: message.code,
        sessionId: message.sessionId,
        timeoutMs: message.timeoutMs,
        wallTimeoutMs: message.wallTimeoutMs,
        signal: controller.signal,
        dispatch: async (path, args) => {
          const response = await chrome.runtime.sendMessage({
            target: 'background',
            type: 'sandbox.api',
            execId: message.execId,
            path,
            args,
          } satisfies OffscreenRuntimeMessage) as { ok?: boolean; value?: import('../shared/rpc').JsonValue; error?: string }
          if (response && 'ok' in response) {
            if (!response.ok) throw new Error(response.error ?? 'sandbox API dispatch failed')
            return response.value ?? null
          }
          return response as import('../shared/rpc').JsonValue
        },
      })
    } finally {
      sandboxControllers.delete(message.execId)
    }
  }
  if (message.type === 'vfs.cancel') {
    vfsControllers.get(message.requestId)?.abort(new DOMException('Cancelled', 'AbortError'))
    return { ok: true }
  }
  if (message.type === 'vfs.call') {
    const controller = new AbortController()
    vfsControllers.set(message.requestId, controller)
    try {
      return { ok: true, value: await callVfs(message.method, message.args, controller.signal) }
    } catch (error) {
      return { ok: false, error: formatError(error) }
    } finally {
      vfsControllers.delete(message.requestId)
    }
  }
  return undefined
}

async function callVfs(method: string, args: unknown[], signal: AbortSignal): Promise<unknown> {
  if (method === 'putFileBase64') {
    const [root, name, mediaType, base64, relativePath] = args as [import('../shared/types').VfsRoot, string, string, string, string?]
    const bytes = base64Bytes(base64)
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    const file = new File([buffer], name, { type: mediaType })
    return vfs.putFile(root, file, relativePath)
  }
  if (method === 'blobBase64') {
    const blob = await vfs.blob(String(args[0]))
    return { base64: bytesBase64(new Uint8Array(await blob.arrayBuffer())), mediaType: blob.type }
  }
  const fn = (vfs as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>)[method]
  if (typeof fn !== 'function') throw new Error(`unknown VFS method ${method}`)
  const values = [...args]
  if (method === 'extensions') values[2] = { signal }
  else if (method === 'writeText' || method === 'writeBase64') values[2] = { ...((values[2] as object | undefined) ?? {}), signal }
  else if (method === 'importUrl') values[1] = { ...((values[1] as object | undefined) ?? {}), signal }
  else if (method === 'createSkill') values[0] = { ...((values[0] as object | undefined) ?? {}), signal }
  else if (method === 'delete' || method === 'renderPdfPage') values[1] = { ...((values[1] as object | undefined) ?? {}), signal }
  return fn.apply(vfs, values)
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function prune(entries: CompactNavigationEvent[], now = Date.now()): CompactNavigationEvent[] {
  return entries
    .filter((entry) => now - entry.at <= TRAIL_TTL_MS)
    .slice(-MAX_EVENTS_PER_TAB)
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

function buildTrail(tabId: number): NavigationTrail | undefined {
  const entries = prune(trails.get(tabId) ?? [])
  if (entries.length === 0) {
    trails.delete(tabId)
    return undefined
  }
  trails.set(tabId, entries)
  const origins = new Set(entries.map((entry) => originOf(entry.url)).filter(Boolean))
  const authLikely = entries.some((entry) => entry.authHint) && (origins.size > 1 || entries.length > 1)
  return { tabId, updatedAt: entries[entries.length - 1]!.at, authLikely, entries }
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const runtimeMessage = raw as { target?: string; type?: string }
  if (runtimeMessage.target !== 'offscreen') return false

  if (
    runtimeMessage.type === 'sandbox.exec' ||
    runtimeMessage.type === 'sandbox.cancel' ||
    runtimeMessage.type === 'vfs.call' ||
    runtimeMessage.type === 'vfs.cancel' ||
    runtimeMessage.type === 'execution.activity'
  ) {
    void handleRuntimeMessage(raw as OffscreenRuntimeMessage).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: formatError(error) }),
    )
    return true
  }

  const message = raw as Partial<BrowserRuntimeMessage>

  if (message.type === 'navigation.record' && 'event' in message && message.event) {
    const event = message.event as CompactNavigationEvent
    trails.set(event.tabId, prune([...(trails.get(event.tabId) ?? []), event]))
    persistTrails()
    sendResponse({ ok: true })
    return false
  }

  if (message.type === 'navigation.remove' && 'tabId' in message && typeof message.tabId === 'number') {
    trails.delete(message.tabId)
    persistTrails()
    sendResponse({ ok: true })
    return false
  }

  if (message.type === 'navigation.get' && 'tabId' in message && typeof message.tabId === 'number') {
    sendResponse({ trail: buildTrail(message.tabId) })
    return false
  }

  if (message.type === 'offscreen.ping') {
    sendResponse({ ok: true })
    return false
  }

  return false
})
