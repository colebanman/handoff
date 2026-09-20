/**
 * Artifacts — living HTML documents the agent builds in the virtual
 * filesystem and the user opens in a tab (artifact.html) or sees embedded in
 * chat. Everything under /workspace renders in the viewer; `.html` files get
 * the full interactive runtime:
 *
 *   artifact.html (extension page)            — loads the file, hosts the API bridge
 *     └ <iframe artifact-frame.html>          — manifest-sandboxed page (permissive CSP)
 *         └ <iframe srcdoc=…>                 — the artifact document + injected runtime
 *
 * The inner document talks to artifact.html with the same `api-call` /
 * `api-result` shapes the code sandbox uses (src/shared/rpc.ts); the frame in
 * the middle only relays. The background service worker reaches live viewers
 * over a runtime port so the agent can evaluate code inside an artifact, save
 * its DOM back to the file, read its console, or screenshot it.
 */

import type { JsonValue } from './rpc'
import type { VfsEntry } from './types'

export const ARTIFACTS_DIR = '/workspace/artifacts'
export const ARTIFACT_VIEWER_PORT = 'artifact-viewer-v1'
export const ARTIFACT_INVOCATION_STORAGE_KEY = 'artifact-invocations'
export const ARTIFACT_STATE_KEY_PREFIX = 'artifact-state:'
/** Console lines a viewer keeps per artifact for `api.artifacts.logs`. */
export const ARTIFACT_LOG_LIMIT = 200
export const ARTIFACT_EVAL_DEFAULT_TIMEOUT_MS = 15_000
export const ARTIFACT_EVAL_MAX_TIMEOUT_MS = 120_000
export const ARTIFACT_INVOKE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const ARTIFACT_OPEN_TIMEOUT_MS = 12_000

export function isVfsPath(value: string): boolean {
  return value.startsWith('/workspace/') || value.startsWith('/skills/')
}

export function artifactUrl(path: string, opts?: { embed?: boolean }): string {
  const query = new URLSearchParams({ path })
  if (opts?.embed) query.set('embed', '1')
  return chrome.runtime.getURL(`artifact.html?${query.toString()}`)
}

export function artifactPathFromLocation(location: Location): string {
  const raw = new URLSearchParams(location.search).get('path') ?? ''
  return raw && isVfsPath(raw) ? raw : ''
}

export function artifactEmbedFromLocation(location: Location): boolean {
  return new URLSearchParams(location.search).get('embed') === '1'
}

/** `.html`/`.htm` files anywhere in the VFS render with the interactive runtime. */
export function isHtmlArtifactPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

export function isHtmlArtifactEntry(entry: Pick<VfsEntry, 'path' | 'mediaType'>): boolean {
  return entry.mediaType === 'text/html' || isHtmlArtifactPath(entry.path)
}

export function artifactNameFromPath(path: string): string {
  const base = path.split('/').filter(Boolean).at(-1) ?? path
  return base.replace(/\.html?$/i, '')
}

/**
 * Model-supplied names are forgiving: "week", "week.html", "artifacts/week",
 * "/workspace/artifacts/week.html" all resolve to the same canonical path.
 * Anything already under /workspace or /skills is kept (with .html enforced).
 */
export function normalizeArtifactPath(raw: string): string {
  let value = raw.trim().replace(/\\/g, '/')
  if (!value) throw new Error('artifact path is required')
  if (!value.startsWith('/')) {
    value = value.replace(/^(workspace\/|artifacts\/)+/, '')
    value = `${ARTIFACTS_DIR}/${value}`
  } else if (!isVfsPath(value)) {
    throw new Error(`artifact paths live under ${ARTIFACTS_DIR} (got ${JSON.stringify(raw)})`)
  }
  const parts = value.split('/').filter((part) => part && part !== '.' && part !== '..')
  value = `/${parts.join('/')}`
  if (!isHtmlArtifactPath(value)) value = `${value}.html`
  return value
}

/**
 * HTML artifacts linked from a message, in order of appearance, deduplicated.
 * Matches Markdown link targets and bare paths; the chat renders an embed
 * card for each.
 */
export function extractArtifactLinks(markdown: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\/workspace\/[^\s)\]"'<>]+?\.html?(?=[\s)\]"'<>.,;:!?]|$)/gi
  for (const match of markdown.matchAll(re)) {
    const path = match[0]
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Document assembly                                                   */
/* ------------------------------------------------------------------ */

export interface ArtifactDocumentMeta {
  path: string
  url: string
  /** Side-panel theme the kit tokens should follow. */
  theme?: 'dark' | 'light'
}

/** Design system + <ai-*> components injected alongside the runtime. */
export interface ArtifactKitSource {
  css: string
  js: string
}

/** `<meta name="artifact-kit" content="off">` keeps a document unstyled (custom visuals). */
export function artifactKitDisabled(html: string): boolean {
  return /<meta\s+[^>]*name\s*=\s*["']artifact-kit["'][^>]*content\s*=\s*["']off["']/i.test(html) ||
    /<meta\s+[^>]*content\s*=\s*["']off["'][^>]*name\s*=\s*["']artifact-kit["']/i.test(html)
}

/**
 * Inject the runtime prelude (and the kit) into an artifact's HTML. The script
 * goes at the top of <head> so `ai` exists before any author script runs; the
 * kit stylesheet precedes author styles so they can override it. A `<base
 * target="_blank">` keeps links from navigating the sandboxed frame itself.
 */
export function buildArtifactDocument(html: string, runtimeSource: string, meta: ArtifactDocumentMeta, kit?: ArtifactKitSource): string {
  const useKit = kit !== undefined && !artifactKitDisabled(html)
  const prelude =
    `<script data-artifact-runtime="1">window.__ARTIFACT__=${JSON.stringify(meta)};\n${runtimeSource}\n</script>` +
    (useKit ? `<style data-artifact-runtime="1">\n${kit.css}\n</style><script data-artifact-runtime="1">\n${kit.js}\n</script>` : '') +
    (/<base\b/i.test(html) ? '' : '<base target="_blank" data-artifact-runtime="1">')
  const headOpen = /<head\b[^>]*>/i.exec(html)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return html.slice(0, at) + prelude + html.slice(at)
  }
  const htmlOpen = /<html\b[^>]*>/i.exec(html)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return html.slice(0, at) + `<head>${prelude}</head>` + html.slice(at)
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) {
    const at = doctype[0].length
    return html.slice(0, at) + `<head>${prelude}</head>` + html.slice(at)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${prelude}</head><body>${html}</body></html>`
}

/** External `<script src>` tags the sandbox CSP would block; inlined by the viewer. */
export interface ExternalScriptRef {
  /** Full tag text as written. */
  tag: string
  url: string
  /** Attributes other than src (type, defer, …), preserved on the inlined tag. */
  attrs: string
}

export function findExternalScripts(html: string): ExternalScriptRef[] {
  const out: ExternalScriptRef[] = []
  const re = /<script\b([^>]*?)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>\s*<\/script\s*>/gi
  for (const match of html.matchAll(re)) {
    const url = (match[2] ?? match[3] ?? match[4] ?? '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    const attrs = `${match[1] ?? ''} ${match[5] ?? ''}`.replace(/\s+/g, ' ').trim()
    out.push({ tag: match[0], url, attrs })
  }
  return out
}

/**
 * Replace remote script tags with their fetched source. Scripts the viewer
 * could not fetch become a console error so the author (agent) sees why the
 * page is broken instead of a silently blocked request.
 */
export function inlineExternalScripts(html: string, sources: Map<string, string | Error>): string {
  let out = html
  for (const ref of findExternalScripts(html)) {
    const source = sources.get(ref.url)
    const attrs = ref.attrs ? ` ${ref.attrs}` : ''
    const replacement =
      typeof source === 'string'
        ? `<script${attrs} data-artifact-src=${JSON.stringify(ref.url)}>${source.replace(/<\/script/gi, '<\\/script')}</script>`
        : `<script data-artifact-src=${JSON.stringify(ref.url)}>console.error(${JSON.stringify(
            `artifact: could not load ${ref.url}: ${source instanceof Error ? source.message : 'not fetched'}`,
          )})</script>`
    out = out.replace(ref.tag, replacement)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Inner document ⟷ viewer (relayed verbatim by artifact-frame.html)    */
/* ------------------------------------------------------------------ */

export type ArtifactRequestOp = 'eval' | 'save' | 'ping'

/** viewer → frame → document */
export type ArtifactHostToDocument =
  | { kind: 'artifact-frame-ping' }
  | { kind: 'artifact-render'; html: string; path: string; url: string }
  | { kind: 'artifact-request'; requestId: string; op: ArtifactRequestOp; code?: string; timeoutMs?: number }
  | { kind: 'api-result'; callId: string; ok: boolean; value?: JsonValue; error?: string }

/** document → frame → viewer */
export type ArtifactDocumentToHost =
  | { kind: 'artifact-frame-ready' }
  | { kind: 'artifact-ready' }
  | { kind: 'api-call'; callId: string; path: string; args: JsonValue[] }
  | { kind: 'artifact-console'; level: 'log' | 'warn' | 'error'; text: string }
  | { kind: 'artifact-response'; requestId: string; ok: boolean; value?: JsonValue; error?: string; logs?: string[] }

/** api paths served by the viewer itself rather than the shared dispatcher. */
export const ARTIFACT_LOCAL_API_PATHS = [
  'artifact.save',
  'artifact.invoke',
  'artifact.open',
  'artifact.script',
  'artifact.state.get',
  'artifact.state.set',
  'artifact.state.all',
  'artifact.state.clear',
  'artifact.meta',
] as const

/** One `ai.*` call the document made, kept in a per-viewer ring buffer for `api.artifacts.trace`. */
export interface ArtifactTraceEntry {
  at: number
  /** Dotted api path, e.g. "fetch" or "fs.readText". */
  path: string
  /** Compact argument summary (URLs, paths, first ~120 chars). */
  args: string
  ok: boolean
  error?: string
  ms: number
  /** For fetch: HTTP status when the call returned one. */
  status?: number
}

/** Shared dispatcher paths an artifact document may call (no CDP, no page driving). */
export const ARTIFACT_ALLOWED_API_PREFIXES = [
  'fs.',
  'tabs.',
  'tabGroups.',
  'history.',
  'bookmarks.',
  'downloads.',
  'storage.',
  'navigation.',
  'fetch',
  'require.source',
] as const

export function isArtifactAllowedApiPath(path: string): boolean {
  return ARTIFACT_ALLOWED_API_PREFIXES.some((prefix) => (prefix.endsWith('.') ? path.startsWith(prefix) : path === prefix))
}

/* ------------------------------------------------------------------ */
/* Viewer ⟷ background (chrome.runtime port ARTIFACT_VIEWER_PORT)      */
/* ------------------------------------------------------------------ */

export type ArtifactViewerRequestOp = 'eval' | 'save' | 'reload' | 'logs' | 'trace' | 'reset' | 'ping'

export type ArtifactViewerToBackground =
  | { type: 'hello'; path: string; embed: boolean }
  | { type: 'ready'; path: string }
  | { type: 'response'; requestId: string; ok: boolean; value?: JsonValue; error?: string }
  | { type: 'invoke'; invokeId: string; path: string; prompt: string; chat: string }

export type ArtifactBackgroundToViewer =
  | { type: 'request'; requestId: string; op: ArtifactViewerRequestOp; code?: string; timeoutMs?: number }
  | { type: 'invoke-result'; invokeId: string; ok: boolean; chatId?: string; text?: string; error?: string }

/* ------------------------------------------------------------------ */
/* Background ⟷ side panel (chrome.runtime.sendMessage)                */
/* ------------------------------------------------------------------ */

export interface ArtifactInvocation {
  id: string
  path: string
  prompt: string
  /** 'current' | 'new' | an existing chat id. */
  chat: string
  createdAt: number
}

export type ArtifactRuntimeMessage =
  | { target: 'ui'; type: 'artifact.invoke.available' }
  | { target: 'background'; type: 'artifact.invoke.claim' }
  | {
      target: 'background'
      type: 'artifact.invoke.result'
      invokeId: string
      ok: boolean
      chatId?: string
      text?: string
      error?: string
    }

/* ------------------------------------------------------------------ */
/* Service the agent consumes (implemented in src/background)          */
/* ------------------------------------------------------------------ */

export interface ArtifactViewerInfo {
  path: string
  url: string
  tabId?: number
  embed: boolean
  ready: boolean
}

export interface ArtifactEvalResult {
  value: JsonValue
  logs: string[]
}

export interface ArtifactHostService {
  /** Live viewers (tabs and in-chat embeds) with the artifact they show. */
  list(): ArtifactViewerInfo[]
  /** Open (or focus) a tab showing the artifact; resolves once its runtime is ready. */
  open(path: string, opts?: { active?: boolean; signal?: AbortSignal }): Promise<{ tabId: number; url: string; created: boolean }>
  /** Run async JS inside the live document (`ai` in scope, bare expression auto-returned). */
  eval(path: string, code: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ArtifactEvalResult>
  /** Serialize the live DOM back into the file. */
  save(path: string, opts?: { signal?: AbortSignal }): Promise<VfsEntry | null>
  /** Re-read the file into the frame (fresh document state). */
  reload(path: string, opts?: { signal?: AbortSignal }): Promise<void>
  /** Recent console output from the live document. */
  logs(path: string, opts?: { signal?: AbortSignal }): Promise<string[]>
  /** Every ai.* call the live document made (newest last) with outcome and timing. */
  trace(path: string, opts?: { signal?: AbortSignal }): Promise<ArtifactTraceEntry[]>
  /** First-open simulation: clear the artifact's persisted state, console, and trace, then re-render. */
  reset(path: string, opts?: { signal?: AbortSignal }): Promise<void>
  /** PNG of the rendered artifact tab (opens one if needed). */
  screenshot(path: string, opts?: { signal?: AbortSignal }): Promise<{ base64: string; mediaType: string; tabId: number }>
  /** Close every tab showing the artifact; returns how many closed. */
  close(path: string): Promise<number>
}
