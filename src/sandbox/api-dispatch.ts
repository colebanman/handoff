/**
 * Host-side implementations of every SANDBOX_API_PATH. Runs in the side-panel
 * page (has chrome.* + the CdpService). The sandbox posts an `api-call` with a
 * dotted path + positional args; the host resolves it here and posts back an
 * `api-result`. Every return value must be JSON-serializable (it crosses the
 * postMessage boundary as structured-clone data).
 *
 * Tab scoping: any path that takes a tabId (page.*, cdp, tabs.get/activate/
 * close) validates the id against `scope.allowedTabIds` when defined; a scoped
 * `tabs.create` reports the new tab via `scope.onTabCreated`.
 */

import type { CdpService, TabScope, VfsEntry, VfsRoot, VirtualFileSystemService } from '../shared/types'
import type { JsonValue } from '../shared/rpc'
import { debugLog } from '../shared/debug-log'
import { getNavigationTrail } from '../shared/browser-events'
import { throwIfAborted } from '../shared/abort'
import { supportsUrl } from '../shared/extension-matching'
import type { ExtensionRevision } from '../shared/extensions'
import {
  ARTIFACTS_DIR,
  artifactUrl,
  isHtmlArtifactEntry,
  normalizeArtifactPath,
  type ArtifactHostService,
} from '../shared/artifacts'
import { summarizeAutomation, type AutomationInput, type AutomationPatch, type AutomationService } from '../shared/automations'
import { isStickyPath, type StickyInput, type StickyPatch, type StickyService } from '../shared/stickies'

/** Optional capabilities only some hosts have (the service worker can reach artifact viewers and the scheduler). */
export interface ApiDispatchExtras {
  artifacts?: ArtifactHostService
  automations?: AutomationService
  stickies?: StickyService
  /** Chat the calling agent belongs to (default target for automations). */
  chatId?: string
}

type Args = JsonValue[]

/** Narrow a JsonValue arg to a plain object (or {} if absent/not an object). */
function asObject(v: JsonValue | undefined): Record<string, JsonValue> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {}
}

/** Narrow a JsonValue arg to a number, throwing a readable error otherwise. */
function asTabId(v: JsonValue | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`expected a numeric tabId, got ${JSON.stringify(v)}`)
  }
  return v
}

function asString(v: JsonValue | undefined, name: string): string {
  if (typeof v !== 'string') throw new Error(`expected a string ${name}, got ${JSON.stringify(v)}`)
  return v
}

/** Narrow a JsonValue arg to a non-empty array of tab ids. */
function asTabIdArray(v: JsonValue | undefined): number[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`expected a non-empty tabIds array, got ${JSON.stringify(v)}`)
  }
  return v.map((id) => asTabId(id))
}

/** Narrow a JsonValue arg (number or { groupId }) to a tab-group id. */
function asGroupId(v: JsonValue | undefined): number {
  const raw = typeof v === 'number' ? v : asObject(v).groupId
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`expected a numeric groupId, got ${JSON.stringify(v)}`)
  }
  return raw
}

interface FsLocation {
  root?: VfsRoot
  prefix?: string
}

function parseFsLocation(raw: string, name = 'root'): FsLocation {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (HOST_PATH_RE.test(trimmed)) {
    throw new Error(
      `${JSON.stringify(raw)} is a path outside the virtual filesystem — the sandbox only sees /workspace and /skills. Bring files in with filesystem_import_url / api.fs.importUrl(url), or check api.downloads.search.`,
    )
  }
  if (!trimmed) return {}
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) return {}
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`expected ${name} without "." or ".." segments, got ${JSON.stringify(raw)}`)
  }
  const root = parts[0]
  if (root !== 'skills' && root !== 'workspace') {
    throw new Error(`expected ${name} "skills", "workspace", or a path under /skills or /workspace, got ${JSON.stringify(raw)}`)
  }
  return {
    root,
    prefix: parts.length > 1 ? `/${root}/${parts.slice(1).join('/')}` : undefined,
  }
}

function fsLocationFromArg(arg: JsonValue | undefined): FsLocation {
  const q = asObject(arg)
  const rootRaw = typeof q.root === 'string' ? q.root : undefined
  const pathRaw =
    typeof arg === 'string'
      ? arg
      : typeof q.path === 'string'
        ? q.path
        : typeof q.prefix === 'string'
          ? q.prefix
          : typeof q.dir === 'string'
            ? q.dir
            : rootRaw

  if (!pathRaw) return {}

  if (rootRaw === 'skills' || rootRaw === 'workspace') {
    const pathParts = pathRaw.replace(/\\/g, '/').split('/').filter(Boolean)
    const first = pathParts[0]
    if (first !== 'skills' && first !== 'workspace') {
      return parseFsLocation(`/${rootRaw}/${pathParts.join('/')}`, 'path')
    }
  }

  return parseFsLocation(pathRaw, 'path')
}

/** OS/host path shapes that can never be VFS paths. */
const HOST_PATH_RE = /^(\/(Users|home|tmp|var|etc|mnt|opt|private)\/|[A-Za-z]:[\\/]|~[\\/]|file:\/\/)/
const MAX_ATTACHED_FILE_BYTES = 25_000_000
const MAX_ATTACHED_TOTAL_BYTES = 50_000_000

/**
 * Normalize a model-supplied VFS path to canonical `/workspace/...` or
 * `/skills/...`. Accepts a missing leading slash and backslashes; rejects
 * host filesystem paths with a pointer to the import tools.
 */
function asVfsPath(v: JsonValue | undefined, name = 'path'): string {
  const raw = typeof v === 'string' ? v : asString(asObject(v).path, name)
  const cleaned = raw.trim().replace(/\\/g, '/')
  if (HOST_PATH_RE.test(cleaned)) {
    throw new Error(
      `${JSON.stringify(raw)} is a path outside the virtual filesystem — the sandbox only sees /workspace and /skills. Bring the file in with filesystem_import_url / api.fs.importUrl(url), or find an already-downloaded copy with api.downloads.search.`,
    )
  }
  const parts = cleaned.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`expected ${name} without "." or ".." segments, got ${JSON.stringify(raw)}`)
  }
  const root = parts[0]
  if ((root !== 'skills' && root !== 'workspace') || parts.length < 2) {
    throw new Error(`expected ${name} under /skills or /workspace (e.g. "/workspace/notes.txt"), got ${JSON.stringify(raw)}`)
  }
  return `/${parts.join('/')}`
}

function filterByPrefix(entries: VfsEntry[], prefix?: string): VfsEntry[] {
  return entries.filter((entry) => isPathUnderPrefix(entry.path, prefix))
}

function isPathUnderPrefix(path: string, prefix?: string): boolean {
  if (!prefix) return true
  const dir = prefix.endsWith('/') ? prefix : `${prefix}/`
  return path === prefix || path.startsWith(dir)
}

function mergedOptions(primary: JsonValue | undefined, secondary: JsonValue | undefined): Record<string, JsonValue> {
  return { ...asObject(primary), ...asObject(secondary) }
}

/** Round-trip through JSON so only serializable data leaves this module. */
function toJson<T>(value: T): JsonValue {
  if (value === undefined || value === null) return null
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function createApiDispatch(
  cdp: CdpService,
  vfs: VirtualFileSystemService,
  scope?: TabScope,
  signal?: AbortSignal,
  extras?: ApiDispatchExtras,
): (path: string, args: JsonValue[]) => Promise<JsonValue> {
  // Per-service-instance in-memory scratch storage (survives across exec calls
  // for the lifetime of this dispatcher; a fresh dispatcher is created per exec
  // by the host, so persist it on the closure the host reuses instead — but
  // the sandbox's own `state` is the durable store, so scratch here is a
  // best-effort convenience keyed per dispatcher).
  const scratch = storageFor(scope)
  const extensionRevisions = { ...scope?.extensionRevisions }

  /** Throw if `tabId` is outside the agent's scope. */
  function requireScope(tabId: number): void {
    if (scope?.allowedTabIds && !scope.allowedTabIds.includes(tabId)) {
      throw new Error(`tab ${tabId} not in this agent's scope`)
    }
  }

  /** Throw for operations that can affect tabs outside a subagent's scope. */
  function requireUnscoped(op: string): void {
    if (scope?.allowedTabIds) {
      throw new Error(`${op} is not available to tab-scoped subagents`)
    }
  }

  /** Resolve an optional tabId arg to a concrete, in-scope tab. */
  async function resolveTabId(v: JsonValue | undefined): Promise<number> {
    if (v === undefined || v === null) {
      const current = scope?.getCurrentTabId?.()
      if (current !== undefined) {
        requireScope(current)
        scope?.onTabObserved?.(current)
        return current
      }
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!activeTab || activeTab.id === undefined) throw new Error('no active tab to default to')
      requireScope(activeTab.id)
      scope?.onTabObserved?.(activeTab.id)
      return activeTab.id
    }
    const id = asTabId(v)
    requireScope(id)
    scope?.onTabObserved?.(id)
    return id
  }

  function requireArtifacts(): ArtifactHostService {
    if (!extras?.artifacts) {
      throw new Error('api.artifacts.* is only available to the agent runtime — write the file with api.fs.writeText and link it instead')
    }
    return extras.artifacts
  }

  function requireAutomations(): AutomationService {
    if (!extras?.automations) throw new Error('api.automations.* is only available to the main agent runtime')
    requireUnscoped('api.automations')
    return extras.automations
  }

  function requireStickies(): StickyService {
    if (!extras?.stickies) throw new Error('api.stickies.* is only available to the main agent runtime — write /workspace/stickies/<name>.md with api.fs.writeText instead')
    requireUnscoped('api.stickies')
    return extras.stickies
  }

  function stickyPatch(v: JsonValue | undefined): StickyPatch {
    const spec = asObject(v)
    const patch: StickyPatch = {}
    if (typeof spec.title === 'string') patch.title = spec.title
    const content = spec.content ?? spec.body ?? spec.markdown ?? spec.text
    if (typeof content === 'string') patch.content = content
    if (spec.pages !== undefined) patch.pages = spec.pages
    if (spec.position !== undefined) patch.position = spec.position
    if (typeof spec.open === 'boolean') patch.open = spec.open
    if (typeof spec.collapsed === 'boolean') patch.collapsed = spec.collapsed
    return patch
  }

  /**
   * `{ ref: 'e12' }` names an element from the current browser_snapshot, but
   * refs die with the snapshot — resolve it to a CSS selector the page overlay
   * can re-find on every load.
   */
  async function resolveStickyPosition(value: JsonValue | undefined): Promise<JsonValue | undefined> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const spec = value as Record<string, JsonValue>
    const ref = typeof spec.ref === 'string' ? spec.ref : typeof spec.element === 'string' ? spec.element : undefined
    if (!ref || typeof spec.selector === 'string') return value
    const tabId = await resolveTabId(spec.tabId)
    requireScope(tabId)
    const { selector, label } = await cdp.selectorForRef(tabId, ref, signal)
    const { ref: _ref, element: _element, tabId: _tabId, ...rest } = spec
    return { ...rest, selector, ...(label && typeof rest.label !== 'string' ? { label } : {}) }
  }

  async function stickyPatchAsync(v: JsonValue | undefined): Promise<StickyPatch> {
    const patch = stickyPatch(v)
    if (patch.position !== undefined) patch.position = await resolveStickyPosition(patch.position as JsonValue)
    return patch
  }

  function automationInput(v: JsonValue | undefined): AutomationInput {
    const spec = asObject(v)
    return {
      title: typeof spec.title === 'string' ? spec.title : undefined,
      prompt: typeof spec.prompt === 'string' ? spec.prompt : '',
      schedule: spec.schedule ?? null,
      timeZone: typeof spec.timeZone === 'string' ? spec.timeZone : undefined,
      chat: typeof spec.chat === 'string' ? spec.chat : typeof spec.chatId === 'string' ? spec.chatId : undefined,
      enabled: typeof spec.enabled === 'boolean' ? spec.enabled : undefined,
    }
  }

  function automationPatch(v: JsonValue | undefined): AutomationPatch {
    const spec = asObject(v)
    const patch: AutomationPatch = {}
    if (typeof spec.title === 'string') patch.title = spec.title
    if (typeof spec.prompt === 'string') patch.prompt = spec.prompt
    if (spec.schedule !== undefined) patch.schedule = spec.schedule
    if (typeof spec.timeZone === 'string') patch.timeZone = spec.timeZone
    if (typeof spec.chat === 'string') patch.chat = spec.chat
    else if (typeof spec.chatId === 'string') patch.chat = spec.chatId
    if (typeof spec.enabled === 'boolean') patch.enabled = spec.enabled
    return patch
  }

  /** `artifacts.*` accept "week", "week.html", or a full /workspace path. */
  function artifactPathArg(v: JsonValue | undefined): string {
    return normalizeArtifactPath(asString(v, 'artifact path'))
  }

  async function forgetClosedTabs(ids: number[]): Promise<void> {
    if (scope?.allowedTabIds) {
      for (const id of ids) {
        const index = scope.allowedTabIds.indexOf(id)
        if (index >= 0) scope.allowedTabIds.splice(index, 1)
      }
    }
    const current = scope?.getCurrentTabId?.()
    if (current === undefined || !ids.includes(current)) return
    const scopedFallback = scope?.allowedTabIds?.[0]
    if (scopedFallback !== undefined) {
      scope?.setCurrentTabId?.(scopedFallback)
      return
    }
    if (!scope?.allowedTabIds) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (active?.id !== undefined) scope?.setCurrentTabId?.(active.id)
    }
  }

  return async function dispatch(path: string, args: Args): Promise<JsonValue> {
    throwIfAborted(signal)
    debugLog.log('sandbox', `api ${path}`, args.length ? args : undefined)
    try {
      const result = await handle(path, args)
      throwIfAborted(signal)
      return result
    } catch (e) {
      debugLog.error('sandbox', `api ${path}`, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  async function handle(path: string, args: Args): Promise<JsonValue> {
    if (path.startsWith('extensions.')) {
      const operation = path.slice('extensions.'.length), input = asObject(args[0])
      if (!['list', 'get', 'resolve'].includes(operation)) requireUnscoped('api.extensions.' + operation)
      if (operation !== 'resolve') return toJson(await vfs.extensions(operation, input, { signal }))
      const id = asString(input.id, 'extension id')
      const saved = await vfs.extensions('resolve', { id, revision: extensionRevisions[id] }, { signal }) as ExtensionRevision & { config: Record<string, unknown> }
      const action = saved.manifest.actions[asString(input.action, 'action')]
      if (!action) throw new Error(`Unknown extension action ${id}.${input.action}`)
      extensionRevisions[id] ??= saved.revision
      const binding = asObject(input.binding)
      let tabs = await chrome.tabs.query({})
      tabs = tabs.filter((tab) => tab.id !== undefined && (!scope?.allowedTabIds || scope.allowedTabIds.includes(tab.id)) && supportsUrl(saved.manifest, tab.url ?? ''))
      const explicit = binding.tabId === undefined ? undefined : asTabId(binding.tabId)
      if (explicit !== undefined) requireScope(explicit)
      const current = scope?.getCurrentTabId?.()
      const tab = explicit !== undefined ? tabs.find((t) => t.id === explicit) : tabs.find((t) => t.id === current) ?? (tabs.length === 1 ? tabs[0] : undefined)
      if (explicit !== undefined && !tab) throw new Error('TargetChanged: bound tab no longer matches this extension')
      if (!tab && tabs.length > 1 && action.effects !== 'local') throw new Error('AmbiguousTarget: pass tabId or use apps.' + id + '.for({tabId}); candidates: ' + tabs.map((t) => t.id).join(', '))
      if (!tab && action.effects === 'browser') throw new Error('NeedsTab: open the matching site using the normal browser tools')
      const origin = tab?.url ? new URL(tab.url).origin : undefined
      const accountId = typeof binding.accountId === 'string' ? binding.accountId : ''
      return toJson({ ...saved, config: origin ? saved.config[`${origin}|${accountId}`] ?? {} : {},
        binding: { ...(tab ? { tabId: tab.id, url: tab.url, origin } : {}), ...(accountId ? { accountId } : {}) } })
    }
    switch (path) {
      /* ---------------- history ---------------- */
      case 'history.search': {
        const q = asObject(args[0])
        const results = await chrome.history.search({
          text: typeof q.text === 'string' ? q.text : '',
          maxResults: typeof q.maxResults === 'number' ? q.maxResults : undefined,
          startTime: typeof q.startTime === 'number' ? q.startTime : undefined,
          endTime: typeof q.endTime === 'number' ? q.endTime : undefined,
        })
        return toJson(results)
      }
      case 'history.getVisits': {
        const q = asObject(args[0])
        const url = typeof q.url === 'string' ? q.url : asString(args[0] as JsonValue, 'url')
        const results = await chrome.history.getVisits({ url })
        return toJson(results)
      }

      /* ---------------- browser navigation ---------------- */
      case 'navigation.recent': {
        const id = await resolveTabId(args[0])
        return toJson((await getNavigationTrail(id)) ?? null)
      }

      /* ---------------- tabs ---------------- */
      case 'tabs.list': {
        const q = asObject(args[0])
        const queryInfo: chrome.tabs.QueryInfo = {}
        if (typeof q.currentWindow === 'boolean') queryInfo.currentWindow = q.currentWindow
        if (typeof q.active === 'boolean') queryInfo.active = q.active
        if (typeof q.url === 'string') queryInfo.url = q.url
        let tabs = await chrome.tabs.query(Object.keys(queryInfo).length ? queryInfo : {})
        if (scope?.allowedTabIds) {
          const allowed = scope.allowedTabIds
          tabs = tabs.filter((t) => t.id !== undefined && allowed.includes(t.id))
        }
        return toJson(tabs.map(summarizeTab))
      }
      case 'tabs.get': {
        const id = await resolveTabId(args[0])
        const tab = await chrome.tabs.get(id)
        return toJson(summarizeTab(tab))
      }
      case 'tabs.create': {
        requireUnscoped('tabs.create')
        const opts = asObject(args[0])
        const createProps: chrome.tabs.CreateProperties = { active: false }
        if (typeof opts.url === 'string') createProps.url = opts.url
        else if (typeof args[0] === 'string') createProps.url = args[0]
        if (typeof opts.active === 'boolean') createProps.active = opts.active
        throwIfAborted(signal)
        const tab = await chrome.tabs.create(createProps)
        if (tab.id !== undefined) {
          scope?.onTabCreated?.(tab.id)
          scope?.setCurrentTabId?.(tab.id)
        }
        return toJson(summarizeTab(tab))
      }
      case 'tabs.activate': {
        requireUnscoped('tabs.activate')
        const id = await resolveTabId(args[0])
        throwIfAborted(signal)
        let tab: chrome.tabs.Tab | undefined
        const activate = async (): Promise<void> => {
          tab = await chrome.tabs.update(id, { active: true })
        }
        if (cdp.switchTabs) await cdp.switchTabs({ toTab: id, signal, activate })
        else await activate()
        scope?.setCurrentTabId?.(id)
        return toJson(tab ? summarizeTab(tab) : { id, activated: true })
      }
      case 'tabs.close': {
        requireUnscoped('tabs.close')
        if (Array.isArray(args[0])) {
          const ids = asTabIdArray(args[0])
          for (const id of ids) requireScope(id)
          throwIfAborted(signal)
          await chrome.tabs.remove(ids)
          await forgetClosedTabs(ids)
          return toJson({ ids, closed: true })
        }
        const id = await resolveTabId(args[0])
        throwIfAborted(signal)
        await chrome.tabs.remove(id)
        await forgetClosedTabs([id])
        return toJson({ id, closed: true })
      }
      case 'tabs.group': {
        requireUnscoped('tabs.group')
        // api.tabs.group({ tabIds, groupId? }) or api.tabs.group([ids]).
        const q = asObject(args[0])
        const tabIds = asTabIdArray(Array.isArray(args[0]) ? args[0] : q.tabIds)
        for (const id of tabIds) requireScope(id)
        const groupId = typeof q.groupId === 'number' ? q.groupId : undefined
        throwIfAborted(signal)
        const gid = await chrome.tabs.group({
          tabIds: tabIds as [number, ...number[]],
          ...(groupId !== undefined ? { groupId } : {}),
        })
        return toJson({ groupId: gid, tabIds })
      }
      case 'tabs.ungroup': {
        requireUnscoped('tabs.ungroup')
        const q = asObject(args[0])
        const tabIds = asTabIdArray(
          Array.isArray(args[0]) ? args[0] : typeof args[0] === 'number' ? [args[0]] : q.tabIds,
        )
        for (const id of tabIds) requireScope(id)
        throwIfAborted(signal)
        await chrome.tabs.ungroup(tabIds as [number, ...number[]])
        return toJson({ ungrouped: tabIds })
      }
      case 'tabs.move': {
        requireUnscoped('tabs.move')
        const id = await resolveTabId(args[0])
        const q = asObject(args[1])
        throwIfAborted(signal)
        const tab = await chrome.tabs.move(id, {
          index: typeof q.index === 'number' ? q.index : -1,
          ...(typeof q.windowId === 'number' ? { windowId: q.windowId } : {}),
        })
        return toJson(summarizeTab(tab))
      }

      /* ---------------- tab groups ---------------- */
      case 'tabGroups.list': {
        const q = asObject(args[0])
        const query: chrome.tabGroups.QueryInfo = {}
        if (typeof q.windowId === 'number') query.windowId = q.windowId
        if (typeof q.title === 'string') query.title = q.title
        let groups = await chrome.tabGroups.query(query)
        if (scope?.allowedTabIds) {
          const scopedTabs = await Promise.all(
            scope.allowedTabIds.map((id) => chrome.tabs.get(id).catch(() => null)),
          )
          const allowedGroups = new Set(
            scopedTabs.map((tab) => tab?.groupId).filter((id): id is number => id !== undefined && id >= 0),
          )
          groups = groups.filter((group) => allowedGroups.has(group.id))
        }
        return toJson(groups.map(summarizeGroup))
      }
      case 'tabGroups.get': {
        const gid = asGroupId(args[0])
        if (scope?.allowedTabIds) {
          const scopedTabs = await Promise.all(
            scope.allowedTabIds.map((id) => chrome.tabs.get(id).catch(() => null)),
          )
          if (!scopedTabs.some((tab) => tab?.groupId === gid)) {
            throw new Error(`tab group ${gid} is not in this agent's scope`)
          }
        }
        return toJson(summarizeGroup(await chrome.tabGroups.get(gid)))
      }
      case 'tabGroups.update': {
        // Mutating a group can affect tabs outside a subagent's scope.
        requireUnscoped('tabGroups.update')
        const gid = asGroupId(args[0])
        const q = asObject(args[1])
        const props: chrome.tabGroups.UpdateProperties = {}
        if (typeof q.title === 'string') props.title = q.title
        if (typeof q.color === 'string') props.color = q.color as chrome.tabGroups.Color
        if (typeof q.collapsed === 'boolean') props.collapsed = q.collapsed
        throwIfAborted(signal)
        const group = await chrome.tabGroups.update(gid, props)
        return toJson(group ? summarizeGroup(group) : { id: gid, updated: true })
      }
      case 'tabGroups.move': {
        requireUnscoped('tabGroups.move')
        const gid = asGroupId(args[0])
        const q = asObject(args[1])
        throwIfAborted(signal)
        const group = await chrome.tabGroups.move(gid, {
          index: typeof q.index === 'number' ? q.index : -1,
          ...(typeof q.windowId === 'number' ? { windowId: q.windowId } : {}),
        })
        return toJson(group ? summarizeGroup(group) : { id: gid, moved: true })
      }

      /* ---------------- bookmarks ---------------- */
      case 'bookmarks.search': {
        const query = typeof args[0] === 'string' ? args[0] : asObject(args[0])
        const results = await chrome.bookmarks.search(query as string | chrome.bookmarks.SearchQuery)
        return toJson(results)
      }
      case 'bookmarks.tree': {
        const results = await chrome.bookmarks.getTree()
        return toJson(results)
      }

      /* ---------------- downloads ---------------- */
      case 'downloads.search': {
        const query = asObject(args[0]) as unknown as chrome.downloads.DownloadQuery
        const results = await chrome.downloads.search(query)
        return toJson(results)
      }

      /* ---------------- storage (scratch, per session) ---------------- */
      case 'storage.get': {
        const key = asString(args[0], 'key')
        const val = scratch.get(key)
        return val === undefined ? null : val
      }
      case 'storage.set': {
        const key = asString(args[0], 'key')
        const value = args[1] === undefined ? null : args[1]
        scratch.set(key, value)
        return toJson({ key, ok: true })
      }

      /* ---------------- virtual filesystem ---------------- */
      case 'fs.list': {
        const location = fsLocationFromArg(args[0])
        return toJson(filterByPrefix(await vfs.list(location.root), location.prefix))
      }
      case 'fs.summary': {
        return toJson(await vfs.summary())
      }
      case 'fs.skills': {
        return toJson(await vfs.skills())
      }
      case 'fs.stat': {
        const pathArg = asVfsPath(args[0])
        return toJson((await vfs.getEntry(pathArg)) ?? null)
      }
      case 'fs.writeText': {
        const first = asObject(args[0])
        const pathArg = typeof args[0] === 'string' ? asVfsPath(args[0]) : asVfsPath(first.path, 'path')
        const text = typeof args[1] === 'string' ? args[1] : asString(first.text, 'text')
        const q = args[2] === undefined ? first : asObject(args[2])
        // A sticky rewritten through the plain filesystem still counts as this chat's edit.
        if (isStickyPath(pathArg)) extras?.stickies?.noteAgentWrite(pathArg, extras.chatId)
        return toJson(
          await vfs.writeText(pathArg, text, {
            mediaType: typeof q.mediaType === 'string' ? q.mediaType : undefined,
            signal,
          }),
        )
      }
      case 'fs.writeBase64': {
        const first = asObject(args[0])
        const pathArg = typeof args[0] === 'string' ? asVfsPath(args[0]) : asVfsPath(first.path, 'path')
        const base64 = typeof args[1] === 'string' ? args[1] : asString(first.base64, 'base64')
        const q = args[2] === undefined ? first : asObject(args[2])
        return toJson(
          await vfs.writeBase64(pathArg, base64, {
            mediaType: typeof q.mediaType === 'string' ? q.mediaType : undefined,
            signal,
          }),
        )
      }
      case 'fs.createSkill': {
        const q = asObject(args[0])
        const filesRaw = Array.isArray(q.files) ? q.files : []
        const files = filesRaw.map((file) => {
          const f = asObject(file)
          return {
            path: asString(f.path, 'file.path'),
            text: typeof f.text === 'string' ? f.text : undefined,
            base64: typeof f.base64 === 'string' ? f.base64 : undefined,
            mediaType: typeof f.mediaType === 'string' ? f.mediaType : undefined,
          }
        })
        return toJson(
          await vfs.createSkill({
            name: asString(q.name, 'name'),
            description: asString(q.description, 'description'),
            body: typeof q.body === 'string' ? q.body : undefined,
            files,
            signal,
          }),
        )
      }
      case 'fs.readText': {
        const pathArg = asVfsPath(args[0])
        const q = mergedOptions(args[0], args[1])
        const result = await vfs.readText(pathArg, {
          offset: typeof q.offset === 'number' ? q.offset : undefined,
          maxChars: typeof q.maxChars === 'number' ? q.maxChars : undefined,
        })
        return toJson(result.text)
      }
      case 'fs.extractText': {
        const pathArg = asVfsPath(args[0])
        const q = mergedOptions(args[0], args[1])
        return toJson(
          await vfs.readText(pathArg, {
            offset: typeof q.offset === 'number' ? q.offset : undefined,
            maxChars: typeof q.maxChars === 'number' ? q.maxChars : undefined,
          }),
        )
      }
      case 'fs.readHtml': {
        const pathArg = asVfsPath(args[0])
        return toJson(await vfs.readHtml(pathArg))
      }
      case 'fs.readLines': {
        const pathArg = asVfsPath(args[0])
        const q = mergedOptions(args[0], args[1])
        const result = await vfs.readLines(pathArg, {
          startLine: typeof q.startLine === 'number' ? q.startLine : undefined,
          count: typeof q.count === 'number' ? q.count : undefined,
        })
        // Plain string[] — models .join()/.map() this directly. Fewer lines than
        // `count` means EOF; use fs.extractText for totals/offset pagination.
        return toJson(result.lines)
      }
      case 'fs.readBytes': {
        const pathArg = asVfsPath(args[0])
        const q = mergedOptions(args[0], args[1])
        return toJson(
          await vfs.readBytes(pathArg, {
            offset: typeof q.offset === 'number' ? q.offset : undefined,
            length: typeof q.length === 'number' ? q.length : undefined,
          }),
        )
      }
      case 'fs.dataUrl': {
        const pathArg = asVfsPath(args[0])
        return toJson(await vfs.dataUrl(pathArg))
      }
      case 'fs.search': {
        const query = typeof args[0] === 'string' ? args[0] : asString(asObject(args[0]).query, 'query')
        const q = mergedOptions(args[0], args[1])
        const location = fsLocationFromArg(q)
        const maxResults = typeof q.maxResults === 'number' ? q.maxResults : undefined
        const results = await vfs.search(query, {
          root: location.root,
          maxResults: location.prefix ? Math.max(maxResults ?? 20, 200) : maxResults,
        })
        const filtered = location.prefix ? results.filter((result) => isPathUnderPrefix(result.path, location.prefix)) : results
        return toJson(filtered.slice(0, maxResults ?? filtered.length))
      }
      case 'fs.importUrl': {
        const urlArg = typeof args[0] === 'string' ? args[0] : asString(asObject(args[0]).url, 'url')
        const q = mergedOptions(args[0], args[1])
        return toJson(
          await vfs.importUrl(urlArg, {
            path: typeof q.path === 'string' ? asVfsPath(q.path) : undefined,
            maxBytes: typeof q.maxBytes === 'number' ? q.maxBytes : undefined,
            signal,
          }),
        )
      }
      case 'fs.renderPdfPage': {
        const pathArg = asVfsPath(args[0])
        const q = mergedOptions(args[0], args[1])
        return toJson(
          await vfs.renderPdfPage(pathArg, {
            page: typeof q.page === 'number' ? q.page : undefined,
            scale: typeof q.scale === 'number' ? q.scale : undefined,
          }),
        )
      }

      /* ---------------- raw CDP ---------------- */
      case 'cdp': {
        const tabId = await resolveTabId(args[0])
        const method = asString(args[1], 'method')
        const params = args[2] === undefined || args[2] === null ? undefined : asObject(args[2])
        throwIfAborted(signal)
        const result = await cdp.send(tabId, method, params, signal)
        return toJson(result)
      }

      /* ---------------- net.* (per-tab captured request log) ---------------- */
      case 'net.requests': {
        // net.requests(tabId?, { url?, types?, limit? }) — newest first.
        const hasTabId = typeof args[0] === 'number'
        const tabId = await resolveTabId(hasTabId ? args[0] : undefined)
        const q = asObject(hasTabId ? args[1] : args[0])
        const urlFilter = typeof q.url === 'string' ? q.url : undefined
        const types =
          q.types === 'all'
            ? undefined
            : Array.isArray(q.types)
              ? q.types.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase())
              : ['xhr', 'fetch']
        const limit = typeof q.limit === 'number' ? q.limit : 50
        const entries = cdp
          .networkRequests(tabId)
          .filter((e) => (types ? types.includes(e.resourceType.toLowerCase()) : true))
          .filter((e) => (urlFilter ? e.url.includes(urlFilter) : true))
          .reverse()
          .slice(0, limit)
        return toJson(
          entries.map((e) => ({
            requestId: e.requestId,
            method: e.method,
            url: e.url,
            type: e.resourceType,
            status: e.status ?? null,
            mimeType: e.mimeType ?? null,
            finished: e.finished,
            ...(e.failed ? { failed: e.failed } : {}),
            ...(e.postData ? { postData: e.postData } : e.hasPostData ? { hasPostData: true } : {}),
          })),
        )
      }
      case 'net.body': {
        // net.body(tabId?, requestId, { maxChars? })
        const hasTabId = typeof args[0] === 'number'
        const tabId = await resolveTabId(hasTabId ? args[0] : undefined)
        const requestId = asString(hasTabId ? args[1] : args[0], 'requestId')
        const q = asObject(hasTabId ? args[2] : args[1])
        const maxChars = typeof q.maxChars === 'number' ? q.maxChars : 100_000
        const res = await cdp.networkResponseBody(tabId, requestId)
        return toJson({
          requestId,
          base64Encoded: res.base64Encoded,
          totalChars: res.body.length,
          truncated: res.body.length > maxChars,
          body: res.body.slice(0, maxChars),
        })
      }

      /* ---------------- page.* (delegates to CdpService) ---------------- */
      case 'page.snapshot': {
        const tabId = await resolveTabId(args[0])
        scope?.setCurrentTabId?.(tabId)
        const snap = await cdp.snapshot(tabId, scope?.allowedTabIds)
        return toJson(snap)
      }
      case 'page.eval': {
        const tabId = await resolveTabId(args[0])
        const expr = asString(args[1], 'expression')
        throwIfAborted(signal)
        const result = await cdp.evalInPage(tabId, expr, { signal })
        if (result === undefined) {
          return 'snippet produced no value — end with a bare expression or add a top-level return'
        }
        return toJson(result)
      }
      case 'page.attachFiles': {
        // attachFiles(tabId?, path | paths, { ref?, selector?, mode? })
        const hasTabId = typeof args[0] === 'number'
        const tabId = await resolveTabId(hasTabId ? args[0] : undefined)
        const pathsArg = hasTabId ? args[1] : args[0]
        const opts = asObject(hasTabId ? args[2] : args[1])
        const rawPaths = Array.isArray(pathsArg) ? pathsArg : [pathsArg]
        if (rawPaths.length === 0) throw new Error('page.attachFiles requires at least one VFS path')
        const paths = rawPaths.map((value) => asVfsPath(value, 'file path'))
        const entries = await Promise.all(paths.map((filePath) => vfs.getEntry(filePath)))
        const missing = paths.filter((_filePath, index) => !entries[index])
        if (missing.length > 0) throw new Error(`file not found in virtual filesystem: ${missing.join(', ')}`)
        const totalBytes = entries.reduce((sum, entry) => sum + (entry?.size ?? 0), 0)
        const oversized = entries.find((entry) => entry && entry.size > MAX_ATTACHED_FILE_BYTES)
        if (oversized) {
          throw new Error(`${oversized.path} is ${oversized.size} bytes; page attachments are limited to ${MAX_ATTACHED_FILE_BYTES} bytes per file`)
        }
        if (totalBytes > MAX_ATTACHED_TOTAL_BYTES) {
          throw new Error(`attachment total is ${totalBytes} bytes; page attachments are limited to ${MAX_ATTACHED_TOTAL_BYTES} bytes per call`)
        }
        const bytes = await Promise.all(paths.map((filePath, index) => vfs.readBytes(filePath, { length: entries[index]!.size })))
        if (bytes.some((file) => file.truncated)) throw new Error('could not read complete attachment bytes from the virtual filesystem')
        const mode = opts.mode === 'input' || opts.mode === 'drop' || opts.mode === 'auto' ? opts.mode : 'auto'
        throwIfAborted(signal)
        const result = await cdp.attachFiles(
          tabId,
          {
            ref: typeof opts.ref === 'string' ? opts.ref : undefined,
            selector: typeof opts.selector === 'string' ? opts.selector : undefined,
            mode,
          },
          bytes.map((file, index) => ({
            name: entries[index]!.name,
            mediaType: entries[index]!.mediaType || file.mediaType,
            size: entries[index]!.size,
            base64: file.base64,
            lastModified: entries[index]!.updatedAt,
          })),
          signal,
        )
        scope?.setCurrentTabId?.(tabId)
        return toJson(result)
      }
      case 'page.click': {
        const tabId = await resolveTabId(args[0])
        const ref = asString(args[1], 'ref')
        throwIfAborted(signal)
        await cdp.click(tabId, ref, signal)
        return toJson({ ok: true })
      }
      case 'page.type': {
        const tabId = await resolveTabId(args[0])
        const ref = asString(args[1], 'ref')
        const text = asString(args[2], 'text')
        const opts = asObject(args[3])
        throwIfAborted(signal)
        await cdp.type(tabId, ref, text, {
          clear: typeof opts.clear === 'boolean' ? opts.clear : undefined,
          submit: typeof opts.submit === 'boolean' ? opts.submit : undefined,
          signal,
        })
        return toJson({ ok: true })
      }
      case 'page.pressKey': {
        const tabId = await resolveTabId(args[0])
        const key = asString(args[1], 'key')
        throwIfAborted(signal)
        await cdp.pressKey(tabId, key, signal)
        return toJson({ ok: true })
      }
      case 'page.scroll': {
        const tabId = await resolveTabId(args[0])
        const opts = asObject(args[1])
        throwIfAborted(signal)
        await cdp.scroll(tabId, {
          ref: typeof opts.ref === 'string' ? opts.ref : undefined,
          dy: typeof opts.dy === 'number' ? opts.dy : undefined,
          signal,
        })
        return toJson({ ok: true })
      }
      case 'page.navigate': {
        const tabId = await resolveTabId(args[0])
        const url = asString(args[1], 'url')
        throwIfAborted(signal)
        await cdp.navigate(tabId, url, signal)
        scope?.setCurrentTabId?.(tabId)
        return toJson({ ok: true })
      }
      case 'page.waitForLoad': {
        const tabId = await resolveTabId(args[0])
        const timeoutMs = typeof args[1] === 'number' ? args[1] : undefined
        const loaded = await cdp.waitForLoad(tabId, timeoutMs, signal)
        return toJson({ ok: true, loaded })
      }
      case 'page.fetch': {
        // page.fetch(tabId?, url, init?) — fetch executed INSIDE the page, so it
        // carries the page's cookies/origin exactly like the site's own JS.
        const hasTabId = typeof args[0] === 'number'
        const tabId = await resolveTabId(hasTabId ? args[0] : undefined)
        const url = asString(hasTabId ? args[1] : args[0], 'url')
        const initArg = asObject(hasTabId ? args[2] : args[1])
        const maxChars = typeof initArg.maxChars === 'number' ? initArg.maxChars : 500_000
        const requestInit = sanitizeFetchInit(initArg)
        const expr = `
          const res = await fetch(${JSON.stringify(url)}, ${JSON.stringify(requestInit)})
          const headers = {}
          res.headers.forEach((v, k) => { headers[k] = v })
          const ct = (headers['content-type'] || '').split(';')[0].trim().toLowerCase()
          const binary = ct && !ct.startsWith('text/') && !/[/+](json|xml|javascript)$/.test(ct) &&
            (ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/') || ct === 'application/pdf' || ct === 'application/zip' || ct === 'application/octet-stream' || ct.startsWith('application/vnd.'))
          if (binary) return { status: res.status, ok: res.ok, url: res.url, headers, binary: true,
            error: 'content-type ' + ct + ' is binary — page.fetch is text-only. Use api.fetch(url, {responseType:"base64"}) or api.fs.importUrl(url) instead.' }
          const text = await res.text()
          return {
            status: res.status, statusText: res.statusText, ok: res.ok, url: res.url, headers,
            truncated: text.length > ${maxChars}, totalChars: text.length,
            text: text.slice(0, ${maxChars}),
          }
        `
        throwIfAborted(signal)
        return toJson(await cdp.evalInPage(tabId, expr, { statement: true, signal }))
      }
      case 'page.screenshotToLog': {
        // Screenshots go through the dedicated browser_screenshot tool (they are
        // multimodal and can't cross the sandbox boundary as usable data).
        await resolveTabId(args[0])
        return toJson({
          note: 'Screenshots are not available inside sandbox_exec. Use the browser_screenshot tool for a visual capture.',
        })
      }

      /* ---------------- frames.* (iframes, incl. cross-origin) ---------------- */
      case 'frames.list': {
        const tabId = await resolveTabId(args[0])
        return toJson(await cdp.listFrames(tabId))
      }
      case 'frames.eval': {
        const tabId = await resolveTabId(args[0])
        const frameId = asString(args[1], 'frameId')
        const expr = asString(args[2], 'expression')
        throwIfAborted(signal)
        const result = await cdp.evalInFrame(tabId, frameId, expr, { signal })
        if (result === undefined) {
          return 'snippet produced no value — end with a bare expression or add a top-level return'
        }
        return toJson(result)
      }
      case 'frames.click': {
        const tabId = await resolveTabId(args[0])
        const frameId = asString(args[1], 'frameId')
        const selector = asString(args[2], 'selector')
        throwIfAborted(signal)
        return toJson(await cdp.clickInFrame(tabId, frameId, selector, signal))
      }

      /* ---------------- fetch (host-side → no page CORS) ---------------- */
      case 'fetch': {
        const url = asString(args[0], 'url')
        const init = args[1] === undefined || args[1] === null ? undefined : asObject(args[1])
        const responseType = typeof init?.responseType === 'string' ? init.responseType : undefined
        const requestInit = sanitizeFetchInit(init ?? {})
        requestInit.signal = signal
        // Default to the user's session cookies (same as vfs.importUrl): the
        // agent acts as the logged-in user, and <all_urls> host permission makes
        // cross-origin credentialed fetches work. Pass credentials:'omit' to opt out.
        if (requestInit.credentials === undefined) requestInit.credentials = 'include'
        throwIfAborted(signal)
        const res = await fetch(url, requestInit)
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => {
          headers[k] = v
        })
        const meta = { status: res.status, statusText: res.statusText, ok: res.ok, url: res.url, headers }
        const contentType = headers['content-type'] ?? ''
        if (responseType === 'base64' || responseType === 'arrayBuffer' || responseType === 'binary') {
          const blob = await res.blob()
          return {
            ...meta,
            base64: await blobToBase64(blob),
            mediaType: blob.type || contentType || 'application/octet-stream',
            size: blob.size,
          }
        }
        if (isBinaryContentType(contentType)) {
          throw new Error(
            `response content-type "${contentType}" is binary — reading it as text corrupts it. Retry with api.fetch(url, { responseType: 'base64' }) then api.fs.writeBase64, or save it directly with api.fs.importUrl(url).`,
          )
        }
        const text = await res.text()
        return { ...meta, text }
      }

      /* ---------------- stickies (collaborative page notes) ---------------- */
      case 'stickies.list': {
        return toJson(await requireStickies().list())
      }
      case 'stickies.get': {
        const found = await requireStickies().get(asString(args[0], 'sticky name'))
        return toJson(found ?? null)
      }
      case 'stickies.create': {
        const stickies = requireStickies()
        const spec: Record<string, JsonValue | undefined> =
          typeof args[0] === 'string' ? { ...asObject(args[2]), name: args[0], content: args[1] } : asObject(args[0])
        const input: StickyInput = {
          ...(await stickyPatchAsync(spec as Record<string, JsonValue>)),
          name: typeof spec.name === 'string' ? spec.name : typeof spec.path === 'string' ? spec.path : typeof spec.id === 'string' ? spec.id : undefined,
        }
        return toJson(await stickies.create(input, extras?.chatId))
      }
      case 'stickies.update': {
        return toJson(await requireStickies().update(asString(args[0], 'sticky name'), await stickyPatchAsync(args[1]), extras?.chatId))
      }
      case 'stickies.open': {
        const patch = { ...(await stickyPatchAsync(args[1])), open: true }
        return toJson(await requireStickies().update(asString(args[0], 'sticky name'), patch, extras?.chatId))
      }
      case 'stickies.close': {
        return toJson(await requireStickies().update(asString(args[0], 'sticky name'), { open: false }, extras?.chatId))
      }
      case 'stickies.delete': {
        return toJson({ deleted: await requireStickies().remove(asString(args[0], 'sticky name')) })
      }

      /* ---------------- artifacts (living HTML documents) ---------------- */
      case 'artifacts.list': {
        const artifacts = requireArtifacts()
        const entries = (await vfs.list('workspace')).filter((entry) => isHtmlArtifactEntry(entry))
        const viewers = artifacts.list()
        return toJson(
          entries
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((entry) => ({
              path: entry.path,
              url: artifactUrl(entry.path),
              size: entry.size,
              updatedAt: entry.updatedAt,
              inArtifactsDir: entry.path.startsWith(`${ARTIFACTS_DIR}/`),
              viewers: viewers
                .filter((viewer) => viewer.path === entry.path)
                .map((viewer) => ({ tabId: viewer.tabId ?? null, embed: viewer.embed, ready: viewer.ready })),
            })),
        )
      }
      case 'artifacts.create': {
        const artifacts = requireArtifacts()
        const spec: Record<string, JsonValue | undefined> =
          typeof args[0] === 'string' ? { ...asObject(args[2]), path: args[0], html: args[1] } : asObject(args[0])
        const pathArg = normalizeArtifactPath(asString(spec.path ?? spec.name, 'path'))
        const html = asString(spec.html, 'html')
        throwIfAborted(signal)
        const entry = await vfs.writeText(pathArg, html, { mediaType: 'text/html', signal })
        const shouldOpen = spec.open === true
        const opened = shouldOpen ? await artifacts.open(pathArg, { active: spec.active === true, signal }) : undefined
        return toJson({ ...entry, url: artifactUrl(pathArg), tabId: opened?.tabId ?? null })
      }
      case 'artifacts.open': {
        const artifacts = requireArtifacts()
        const pathArg = artifactPathArg(args[0])
        const options = asObject(args[1])
        if (!(await vfs.getEntry(pathArg))) throw new Error(`no artifact at ${pathArg} — create it first with api.artifacts.create or api.fs.writeText`)
        const result = await artifacts.open(pathArg, { active: options.active !== false, signal })
        scope?.onTabCreated?.(result.tabId)
        return toJson(result)
      }
      case 'artifacts.eval': {
        const artifacts = requireArtifacts()
        const pathArg = artifactPathArg(args[0])
        const code = asString(args[1], 'code')
        const options = asObject(args[2])
        const result = await artifacts.eval(pathArg, code, {
          timeoutMs: typeof options.timeoutMs === 'number' ? options.timeoutMs : undefined,
          signal,
        })
        return toJson(result)
      }
      case 'artifacts.save': {
        const artifacts = requireArtifacts()
        return toJson(await artifacts.save(artifactPathArg(args[0]), { signal }))
      }
      case 'artifacts.reload': {
        const artifacts = requireArtifacts()
        await artifacts.reload(artifactPathArg(args[0]), { signal })
        return toJson({ ok: true })
      }
      case 'artifacts.logs': {
        const artifacts = requireArtifacts()
        return toJson(await artifacts.logs(artifactPathArg(args[0]), { signal }))
      }
      case 'artifacts.trace': {
        const artifacts = requireArtifacts()
        const entries = await artifacts.trace(artifactPathArg(args[0]), { signal })
        return toJson(
          entries.map((entry) => ({
            at: new Date(entry.at).toISOString(),
            call: `ai.${entry.path}(${entry.args})`,
            ok: entry.ok,
            status: entry.status ?? null,
            ms: entry.ms,
            error: entry.error ?? null,
          })),
        )
      }
      case 'artifacts.reset': {
        const artifacts = requireArtifacts()
        await artifacts.reset(artifactPathArg(args[0]), { signal })
        return toJson({ ok: true, note: 'state cleared, console and trace emptied, document re-rendered as on first open' })
      }
      case 'artifacts.url': {
        return artifactUrl(artifactPathArg(args[0]))
      }
      case 'artifacts.close': {
        const artifacts = requireArtifacts()
        return toJson({ closed: await artifacts.close(artifactPathArg(args[0])) })
      }

      /* ---------------- automations (scheduled prompts) ---------------- */
      case 'automations.list': {
        const automations = requireAutomations()
        return toJson((await automations.list()).map(summarizeAutomation))
      }
      case 'automations.get': {
        const automations = requireAutomations()
        const record = await automations.get(asString(args[0], 'automation id'))
        return record ? toJson(summarizeAutomation(record)) : null
      }
      case 'automations.create': {
        const automations = requireAutomations()
        const record = await automations.create(automationInput(args[0]), { chatId: extras?.chatId })
        return toJson(summarizeAutomation(record))
      }
      case 'automations.update': {
        const automations = requireAutomations()
        const record = await automations.update(asString(args[0], 'automation id'), automationPatch(args[1]), { chatId: extras?.chatId })
        return toJson(summarizeAutomation(record))
      }
      case 'automations.delete': {
        const automations = requireAutomations()
        return toJson({ deleted: await automations.remove(asString(args[0], 'automation id')) })
      }
      case 'automations.run': {
        const automations = requireAutomations()
        return toJson(await automations.runNow(asString(args[0], 'automation id')))
      }

      /* ---------------- require.source (module text, cached per panel) ---------------- */
      case 'require.source': {
        const url = asString(args[0], 'url')
        if (!/^https:\/\//i.test(url)) {
          throw new Error(`api.require: only https:// URLs are supported, got ${JSON.stringify(url)}`)
        }
        let cached = moduleSourceCache.get(url)
        if (!cached) {
          cached = (async () => {
            const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal })
            if (!res.ok) throw new Error(`api.require: fetch ${url} failed: ${res.status} ${res.statusText}`)
            const text = await res.text()
            if (text.length > MAX_MODULE_SOURCE_CHARS) {
              throw new Error(
                `api.require: ${url} is ${text.length} chars (max ${MAX_MODULE_SOURCE_CHARS}) — use a minified build`,
              )
            }
            return text
          })()
          cached.catch(() => moduleSourceCache.delete(url)) // never cache failures
          moduleSourceCache.set(url, cached)
        }
        return await cached
      }

      default:
        throw new Error(`unknown api path "${path}"`)
    }
  }
}

/** Compact, JSON-safe view of a tab. `groupId` is null when ungrouped (-1). */
function summarizeTab(tab: chrome.tabs.Tab): JsonValue {
  return {
    id: tab.id ?? null,
    url: tab.url ?? null,
    title: tab.title ?? null,
    active: tab.active ?? false,
    status: tab.status ?? null,
    windowId: tab.windowId ?? null,
    index: tab.index ?? null,
    pinned: tab.pinned ?? false,
    groupId: tab.groupId !== undefined && tab.groupId !== -1 ? tab.groupId : null,
  }
}

/** Compact, JSON-safe view of a tab group. */
function summarizeGroup(group: chrome.tabGroups.TabGroup): JsonValue {
  return {
    id: group.id,
    title: group.title ?? null,
    color: group.color,
    collapsed: group.collapsed,
    windowId: group.windowId,
  }
}

/** Content-types that must not be read as text (silent corruption). */
function isBinaryContentType(contentType: string): boolean {
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!mime || mime.startsWith('text/')) return false
  if (/[/+](json|xml|javascript|ecmascript)$/.test(mime)) return false
  if (mime === 'application/x-www-form-urlencoded' || mime === 'application/graphql') return false
  return (
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime.startsWith('font/') ||
    mime === 'application/pdf' ||
    mime === 'application/zip' ||
    mime === 'application/gzip' ||
    mime === 'application/octet-stream' ||
    mime === 'application/msword' ||
    mime.startsWith('application/vnd.')
  )
}

/** Blob → raw base64 (no data: prefix), worker-safe and chunked. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** Extract only the structured-cloneable RequestInit fields we support. */
function sanitizeFetchInit(init: Record<string, JsonValue>): RequestInit {
  const out: RequestInit = {}
  if (typeof init.method === 'string') out.method = init.method
  if (typeof init.body === 'string') out.body = init.body
  if (init.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers as Record<string, JsonValue>)) {
      if (typeof v === 'string') headers[k] = v
    }
    out.headers = headers
  }
  if (typeof init.redirect === 'string' && (init.redirect === 'follow' || init.redirect === 'error' || init.redirect === 'manual')) {
    out.redirect = init.redirect
  }
  if (typeof init.credentials === 'string' && (init.credentials === 'omit' || init.credentials === 'same-origin' || init.credentials === 'include')) {
    out.credentials = init.credentials
  }
  return out
}

/**
 * Best-effort scratch store keyed per scope object. Dispatchers created for the
 * same scope share a store; unscoped (main-agent) dispatchers share a single
 * global store. This gives sandbox `api.storage` a stable place to stash small
 * values across exec calls without touching chrome.storage.
 */
const globalScratch = new Map<string, JsonValue>()
const scopedScratch = new WeakMap<TabScope, Map<string, JsonValue>>()

/** Fetched module source, cached by URL for the panel's lifetime (api.require). */
const moduleSourceCache = new Map<string, Promise<string>>()
const MAX_MODULE_SOURCE_CHARS = 5_000_000

function storageFor(scope?: TabScope): Map<string, JsonValue> {
  if (!scope || scope.allowedTabIds === undefined) return globalScratch
  let store = scopedScratch.get(scope)
  if (!store) {
    store = new Map<string, JsonValue>()
    scopedScratch.set(scope, store)
  }
  return store
}
