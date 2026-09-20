/**
 * Tool set for the agent core.
 *
 * Every tool is defined with a zod `inputSchema` and an `execute` that returns
 * a string (or, for the screenshot tool, an object with `toModelOutput`). All
 * errors are caught inside `execute` and returned as `"Error: <msg>"` strings so
 * the streamText loop keeps running and the model can recover.
 *
 * Omitted `tabId` resolves to the agent's current tab. For subagents
 * (`ctx.allowedTabIds` defined) every tabId is validated against the scope and
 * the subagent/task tools are omitted.
 */

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { CdpService, SandboxService, TabScope, AgentEvent, VirtualFileSystemService } from '../shared/types'
import { debugLog } from '../shared/debug-log'
import { formatError } from '../shared/errors'
import { MAX_TOOL_OUTPUT, deepToWellFormed, sliceWellFormed } from '../shared/text'
import { SANDBOX_DEFAULT_TIMEOUT_MS, SANDBOX_MAX_TIMEOUT_MS } from '../shared/rpc'
import { formatNavigationTrail, getNavigationTrail } from '../shared/browser-events'
import { MEMORY_PATH, applyMemoryWrite } from './memory'
import {
  SITE_MEMORY_PATH,
  applySiteMemoryWrite,
  normalizeGuidePath,
  describeCombinedMemoryWrite,
} from './site-memory'
import type { AgentTabGroups } from './tab-groups'
import { sharedSurfaceAssignments, tabSurface, type AgentSurface } from './surfaces'
import { formatUserPromptAnswer, type AskUserFn, type UserPromptRequest } from '../shared/user-prompt'
import { abortableDelay, throwIfAborted } from '../shared/abort'
import { isHtmlArtifactEntry, type ArtifactHostService } from '../shared/artifacts'
import { verifyExtraction, type TypeSafeSession } from './typesafe'

/** Per-agent mutable context: identity + tracked current tab + scope. */
export interface AgentContext {
  extensionRevisions?: Record<string, number>
  agentId: string
  /** The tab used when a tool call omits `tabId`. */
  currentTabId: number
  /** Defined for subagents (tab-scoped); undefined for the main agent. */
  allowedTabIds?: number[]
  /** True when a subagent was spawned without a prepared, nonblank page. */
  offlineOnly?: boolean
  /** Tabs opened by this agent; lets the main agent avoid replacing the user's starting tab. */
  createdTabIds?: Set<number>
}

/** Signature the tools use to spawn a subagent (implemented in subagents.ts).
 * Subagents always run on the parent's model — there is no per-spawn override. */
export type SpawnSubagentFn = (args: {
  task: string
  tabIds?: number[]
  background?: boolean
  /** Leave tabs the subagent opened in place when it finishes (default: they are closed). */
  keepTabs?: boolean
  parentToolCallId: string
  /** Workflow ownership metadata; absent for ordinary subagent_spawn calls. */
  workflowRunId?: string
  workflowCallId?: string
  /** Internal observer used by the workflow coordinator. */
  onEvent?: (event: AgentEvent) => void
  /** Internal cancellation scope (workflow controller for workflow children). */
  signal?: AbortSignal
}) => Promise<string>

export interface WorkflowRunInput {
  title?: string
  description?: string
  phases?: import('../shared/types').WorkflowPhaseDefinition[]
  script?: string
  scriptPath?: string
  args?: import('../shared/rpc').JsonValue
  background?: boolean
  parentToolCallId: string
}

export type RunWorkflowFn = (input: WorkflowRunInput) => Promise<string>

/** Steer a running background subagent, or resume a cancelled one from its
 * saved context; resolves to the tool-result string. */
export type MessageSubagentFn = (taskId: string, message: string) => Promise<string>

/** Minimal task-management surface the task_* tools need. */
export interface TaskAccess {
  get(id: string): import('../shared/types').TaskInfo | undefined
  list(): import('../shared/types').TaskInfo[]
  cancel(id: string): void
  signal(id: string): AbortSignal | undefined
  /** Queue a steering message for a running task's subagent; false if not deliverable. */
  steer(id: string, text: string): boolean
  /** Whether a task has saved context that subagent_message can resume from. */
  canResume(id: string): boolean
  /** Mark a failed task as surfaced in a tool result (stops it being re-announced). */
  markFailureReported(id: string): void
}

export interface BuildToolsArgs {
  typeSafe?: TypeSafeSession
  cdp: CdpService
  sandbox: SandboxService
  vfs: VirtualFileSystemService
  ctx: AgentContext
  emit: (e: AgentEvent) => void
  spawnSubagent: SpawnSubagentFn
  tasks: TaskAccess
  signal: AbortSignal
  /** Sandbox session id (one per agent). */
  sandboxSessionId: string
  /** Cosmetic Chrome tab-group ownership labels for subagents. */
  tabGroups?: AgentTabGroups
  /** Non-consuming check for pending mid-turn user steering (main agent only);
   * lets blocking tools (task_wait) return early so the model can react. */
  steeringPending?: () => boolean
  /** Steer-or-resume for subagent_message (main agent only). */
  messageSubagent?: MessageSubagentFn
  runWorkflow?: RunWorkflowFn
  /** Optional provider-specific ceiling; complete oversized output is spilled. */
  maxToolOutputChars?: number
  /** Blocking user-prompt card (main agent only); absent = no ask_user tool. */
  askUser?: AskUserFn
  operationTracker?: ToolOperationTracker
  onTabObserved?: (tabId: number) => void
  /** Live artifact viewers; absent outside the service-worker host. */
  artifacts?: ArtifactHostService
  /** Chat this agent runs in (main agent); scheduling defaults to it. */
  chatId?: string
}

/** Keeps turn/task cancellation non-terminal until every started tool settles. */
export class ToolOperationTracker {
  private readonly active = new Set<Promise<unknown>>()

  constructor(private readonly onStart?: () => (() => void) | undefined) {}

  track<T>(operation: Promise<T>): Promise<T> {
    const endActivity = this.onStart?.()
    this.active.add(operation)
    void operation.finally(() => {
      this.active.delete(operation)
      endActivity?.()
    }).catch(() => {})
    return operation
  }

  async settle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active])
  }
}

const SPILL_DIR = '/workspace/.tool-output'
const SPILL_TTL_MS = 60 * 60 * 1000
const SPILL_KEEP = 12

/** Best-effort GC: drop spills older than the TTL, cap the count. */
async function gcSpills(vfs: VirtualFileSystemService): Promise<void> {
  const entries = (await vfs.list('workspace')).filter((e) => e.path.startsWith(`${SPILL_DIR}/`))
  // Filenames start with Date.now(); lexicographic sort ≈ chronological.
  const sorted = entries.sort((a, b) => (a.path < b.path ? -1 : 1))
  const cutoff = Date.now() - SPILL_TTL_MS
  for (const [i, entry] of sorted.entries()) {
    const stamp = Number(entry.path.slice(SPILL_DIR.length + 1).split('-')[0])
    const expired = Number.isFinite(stamp) && stamp < cutoff
    const excess = sorted.length - i > SPILL_KEEP
    if (expired || excess) await vfs.delete(entry.path)
  }
}

/**
 * truncate(), but the full text is saved to a temporary VFS file the model
 * can page through — so oversized results never force a risky re-call.
 */
async function spillTruncate(
  vfs: VirtualFileSystemService,
  toolName: string,
  text: string,
  maxChars = MAX_TOOL_OUTPUT,
): Promise<string> {
  if (text.length <= maxChars) return text
  const kept = sliceWellFormed(text, maxChars)
  try {
    await gcSpills(vfs)
    const infix = Math.random().toString(36).slice(2, 6)
    const path = `${SPILL_DIR}/${Date.now()}-${infix}-${toolName}.txt`
    await vfs.writeText(path, text, { mediaType: 'text/plain' })
    return (
      kept +
      `\n\n[Truncated ${text.length - maxChars} chars — full ${text.length}-char output saved to ${path} ` +
      `(temporary, auto-deleted after ~1h). Read it with api.fs.readText(path, {offset, maxChars}) or ` +
      `api.fs.readLines(path, {startLine, count}), or filter it in one sandbox_exec. ` +
      `Copy it elsewhere under /workspace to keep it.]`
    )
  } catch (err) {
    debugLog.error('agent', 'spillTruncate', err)
    return kept + `\n\n[Truncated ${text.length - maxChars} chars — use sandbox_exec to filter/aggregate and return only what you need.]`
  }
}

function errStr(err: unknown): string {
  return `Error: ${formatError(err)}`
}

/** A CDP attach failure meaning the tab no longer exists (closed, or never existed). */
function isMissingTabError(err: unknown): boolean {
  return /no tab with that id/i.test(formatError(err))
}

/** Result of the multimodal screenshot tool (image data, or an error). */
interface ScreenshotOutput {
  base64?: string
  mediaType?: string
  error?: string
}

interface FilesystemViewOutput {
  path?: string
  filename?: string
  mediaType?: string
  base64?: string
  mode?: 'text' | 'image' | 'file' | 'pdf-page' | 'live'
  page?: number
  size?: number
  text?: string
  error?: string
}

const MAX_MODEL_FILE_BYTES = 20_000_000

/** Exact return shapes for the most-used api.* calls (mirrors src/sandbox/api-dispatch.ts). */
const SANDBOX_API_CHEATSHEET = `API SHAPES (exact — no probing needed):
- state persists across sandbox_exec calls this chat; api.storage.get/set(key, value) is scratch KV.
- api.fs paths live under /workspace and /skills (leading slash optional). Host paths like /Users/... do not exist here — import with api.fs.importUrl(url).
- api.fs.readText(path, {offset?, maxChars?}) -> string (plain text; also extracts PDF/DOCX text)
- api.fs.readLines(path, {startLine?, count?}) -> string[] (fewer than count lines = EOF)
- api.fs.extractText(path, {offset?, maxChars?}) -> {path, text, truncated, totalChars} (use for pagination)
- api.fs.readBytes(path, {offset?, length?}) -> {path, base64, mediaType, size, truncated}
- api.fs.list(rootOrPath?) -> array of entries {path, name, mediaType, size, ...}; api.fs.stat(path) -> entry | null
- api.fs.writeText(path, text) / api.fs.writeBase64(path, base64) -> the written entry
- api.fs.importUrl(url, {path?}) -> entry; downloads with session cookies into /workspace/imports/
- api.tabs.list() -> [{id, url, title, active, windowId, groupId, ...}]; api.tabs.close(id | [ids])
- api.fetch(url, init?) -> {status, ok, url, headers, text}; for binaries pass {responseType:'base64'} -> {status, ok, url, headers, base64, mediaType, size}. Sends session cookies by default.
- api.page.attachFiles(tabId?, pathOrPaths, {ref?, selector?, mode?}) -> attaches VFS files to an input or drop target; mode is "auto" (default), "input", or "drop"
- api.page.eval(tabId, expr) -> the expression's JSON value; api.page.waitForLoad(tabId?, timeoutMs?) -> {ok:true, loaded:boolean}; api.cdp(tabId, method, params) -> raw CDP result
- api.artifacts.create({path:'week.html', html, open?}) -> entry + url (files live in /workspace/artifacts/, open views live-reload on rewrite); api.artifacts.eval(path, code) -> {value, logs} runs async JS INSIDE the live document (ai/document/window in scope; bare expression auto-returned; DOM nodes -> outerHTML); api.artifacts.save(path) persists the live DOM; api.artifacts.logs(path) -> console/error lines; api.artifacts.trace(path) -> every ai.* call the page made [{at, call, ok, status, ms, error}]; api.artifacts.reset(path) -> clear ai.state + console + trace and re-render like a first open; api.artifacts.open(path, {active?}) -> {tabId, url}; api.artifacts.reload(path); api.artifacts.close(path); api.artifacts.list(). Inside eval: await ai.waitFor(() => document.querySelector('.row'), {timeoutMs}) for async content. Screenshot the rendered page with filesystem_view(path).
- api.automations.create({ title?, prompt, schedule, timeZone?, chat? }) -> summary with id + nextRun. schedule: { daily: "08:00" } | { weekdays: "9am" } | { weekly: { on: ["mon","thu"], at: "09:00" } } | { monthly: { day: 1, at: "09:00" } } | { every: "2h" } (min 5m) | { once: "2026-09-12T08:00" }. chat: "this" (default: the current chat) | "new" | a chatId. api.automations.update(id, { prompt?, schedule?, timeZone?, chat?, enabled?, title? }); api.automations.list(); api.automations.get(id); api.automations.run(id); api.automations.delete(id).
- api.stickies.create({ name, title?, content, pages?, position?, open? }) -> summary (a small collaborative Markdown note at /workspace/stickies/<name>.md, floating on the user's pages while open; body delivered to chats as <stickies>); api.stickies.update(name, { content?, title?, pages?, position?, open?, collapsed? }); api.stickies.open(name, { pages?, position? }); api.stickies.close(name); api.stickies.get(name); api.stickies.list(); api.stickies.delete(name). pages: "all" | ["mail.google.com/**", "calendar.google.com"]; position: top-right | top-left | bottom-right | bottom-left.
Failed api.* calls THROW inside your snippet — try/catch to continue.`

export function buildTools(args: BuildToolsArgs): ToolSet {
  const {
    cdp: rawCdp,
    sandbox,
    vfs: rawVfs,
    ctx,
    emit,
    spawnSubagent,
    tasks,
    signal,
    sandboxSessionId,
    tabGroups,
    steeringPending,
    messageSubagent,
    runWorkflow,
    maxToolOutputChars,
    askUser,
    operationTracker,
    artifacts,
    chatId,
  } = args

  // Services are guarded centrally so an abort that happens during argument
  // resolution or a preceding await cannot dispatch a later CDP/VFS action.
  // Mutating VFS calls also receive the signal so multi-await operations (URL
  // import, createSkill, memory writes) stop before their next write.
  const cdp = abortGuardCdp(rawCdp, signal)
  const vfs = abortGuardVfs(rawVfs, signal)

  const visibleToolOutputChars = Math.max(1_000, maxToolOutputChars ?? MAX_TOOL_OUTPUT)
  const spillToolOutput = (toolName: string, text: string): Promise<string> =>
    spillTruncate(vfs, toolName, text, visibleToolOutputChars)

  const isSubagent = ctx.allowedTabIds !== undefined
  // Surface ownership is an IDENTITY question, not a scope question: the main
  // agent takes soft claims too (see ./surfaces.ts) and must not be demoted by
  // holding them, so the soft-claim path keys off agentId rather than scope.
  const isMainAgent = ctx.agentId === 'main'
  const isOfflineSubagent = isSubagent && ctx.offlineOnly === true
  const surfaceClaims = sharedSurfaceAssignments()

  /**
   * The main agent's automatic, yielding, expiring claim on a surface it is
   * actually working on. It cannot fail and never displaces a subagent; it only
   * stops a later `subagent_spawn` handing that surface away mid-task.
   */
  function noteMainSurface(surface: AgentSurface): void {
    if (!isMainAgent) return
    surfaceClaims.softClaim(ctx.agentId, [surface])
  }

  /**
   * Resolve an optional tabId to the current tab, and validate it against the
   * scope for subagents. Throws a readable Error if out of scope (caught by the
   * caller and returned as an "Error: ..." string).
   */
  function resolveTab(tabId?: number): number {
    const resolved = tabId ?? ctx.currentTabId
    if (ctx.allowedTabIds !== undefined && !ctx.allowedTabIds.includes(resolved)) {
      throw new Error(
        `tab ${resolved} is out of this subagent's scope [${ctx.allowedTabIds.join(', ')}]. You may only act on the tabs assigned to you.`,
      )
    }
    noteMainSurface(tabSurface(resolved))
    args.onTabObserved?.(resolved)
    return resolved
  }

  /** The tab scope passed to sandbox exec. `allowedTabIds` undefined => unrestricted main agent. */
  const scope: TabScope = {
    get extensionRevisions() { return ctx.extensionRevisions },
    onTabObserved: args.onTabObserved,
    agentId: ctx.agentId,
    allowedTabIds: ctx.allowedTabIds,
    offlineOnly: ctx.offlineOnly,
    getCurrentTabId: () => ctx.currentTabId,
    setCurrentTabId: (tabId: number) => {
      ctx.currentTabId = tabId
    },
    onTabCreated: (tabId: number) => {
      // A scoped tabs.create inside the sandbox joins the subagent's scope.
      if (ctx.allowedTabIds && !ctx.allowedTabIds.includes(tabId)) {
        ctx.allowedTabIds.push(tabId)
      }
      markCreatedTab(tabId)
      if (!signal.aborted) void addGroupedTabs([tabId])
    },
  }

  function currentScopeTabs(): number[] {
    return ctx.allowedTabIds && ctx.allowedTabIds.length > 0 ? [...ctx.allowedTabIds] : [ctx.currentTabId]
  }

  async function addGroupedTabs(tabIds: Array<number | undefined>): Promise<void> {
    throwIfAborted(signal)
    if (!isSubagent) return
    const ids = tabIds.filter((id): id is number => typeof id === 'number')
    if (ids.length === 0) return
    try {
      await tabGroups?.addTabs(ctx.agentId, ids)
    } catch (err) {
      debugLog.error('agent', 'tab group addTabs', err)
    }
  }

  async function withGroupedTabs<T>(tabIds: number[] | undefined, fn: () => Promise<T>): Promise<T> {
    await addGroupedTabs(tabIds ?? [])
    throwIfAborted(signal)
    return await fn()
  }

  function markCreatedTab(tabId: number): void {
    if (!ctx.createdTabIds) ctx.createdTabIds = new Set()
    ctx.createdTabIds.add(tabId)
  }

  /**
   * Interaction tools append a fresh snapshot to their result so the model
   * doesn't spend a follow-up round-trip on browser_snapshot. A short settle
   * delay lets same-page DOM updates (menus, SPA transitions) land and
   * waitForLoad covers full navigations; both are best-effort — on failure the
   * action still reports success and the model falls back to browser_snapshot.
   */
  const SETTLE_DELAY_MS = 400
  const SETTLE_LOAD_TIMEOUT_MS = 5_000
  const AUTH_REDIRECT_QUIET_MS = 900
  const AUTH_REDIRECT_MAX_WAIT_MS = 6_000

  /**
   * OAuth providers often report a fully loaded intermediate page and then
   * immediately redirect again. Once Chrome has recognized an auth chain,
   * wait for its committed-navigation trail to stay quiet briefly before
   * snapshotting so the model sees the current step, not a stale callback.
   */
  async function settleAuthRedirects(id: number): Promise<Awaited<ReturnType<typeof getNavigationTrail>>> {
    let trail = await getNavigationTrail(id)
    if (!trail?.authLikely) return trail
    const deadline = Date.now() + AUTH_REDIRECT_MAX_WAIT_MS
    let lastNavigationAt = trail.updatedAt
    while (!signal.aborted && Date.now() < deadline && Date.now() - lastNavigationAt < AUTH_REDIRECT_QUIET_MS) {
      await abortableDelay(200, signal)
      const next = await getNavigationTrail(id)
      if (next) {
        trail = next
        lastNavigationAt = Math.max(lastNavigationAt, next.updatedAt)
      }
    }
    return trail
  }
  // NOTE: the "Fresh browser observation:" marker
  // below is parsed by history-pruning.ts — change both files together.
  async function withFreshSnapshot(id: number, message: string, toolName: string): Promise<string> {
    if (signal.aborted) return `${message}\n\n(Automatic snapshot skipped because the turn was stopped.)`
    try {
      await abortableDelay(SETTLE_DELAY_MS, signal)
      let loaded = await cdp.waitForLoad(id, SETTLE_LOAD_TIMEOUT_MS)
      const navigationTrail = await settleAuthRedirects(id)
      if (navigationTrail?.authLikely) loaded = (await cdp.waitForLoad(id, SETTLE_LOAD_TIMEOUT_MS)) || loaded
      const snap = await cdp.snapshot(id, ctx.allowedTabIds)
      const header = `Tab ${snap.tabId}: ${snap.title || '(untitled)'}\nURL: ${snap.url}`
      const navigation = formatNavigationTrail(navigationTrail ?? await getNavigationTrail(id))
      const navigationBlock = navigation ? `\n\n${navigation}` : ''
      const loadNote = loaded ? '' : '\n\n(Load completion was not confirmed before the wait deadline; this snapshot shows the current page state.)'
      return await spillToolOutput(toolName, `${message}${loadNote}${navigationBlock}\n\nFresh browser observation:\n${header}\n\n${snap.text}`)
    } catch (err) {
      debugLog.error('agent', 'auto-snapshot', err)
      return `${message}\n\n(Automatic snapshot failed: ${formatError(err)}. Call browser_snapshot to see the page.)`
    }
  }

  /** CDP errors from a stale backend-node ref: the accessible node a click/type ref
   * pointed to detached from the DOM (SPA re-render) between the last snapshot and
   * this action. Exact Chrome wording can shift by version; match loosely on the
   * known families, including maps lost after a debugger/worker restart. */
  const STALE_REF_ERROR = /box model|no node.*(backend|given id)|unknown element ref/i

  /**
   * Run a ref-based interaction; on a stale-ref CDP error, retake the snapshot and
   * return it without retrying. A new snapshot reassigns refs, so replaying the same
   * ref could act on a different element. The caller appends the replacement snapshot
   * so the model can select the intended element again.
   */
  async function withStaleRefRecovery(
    id: number,
    action: () => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; error: unknown; snapshotText?: string }> {
    try {
      await action()
      return { ok: true }
    } catch (err) {
      if (!STALE_REF_ERROR.test(formatError(err))) return { ok: false, error: err }
      debugLog.log('agent', 'stale-ref recovery', { tabId: id })
      try {
        const snap = await cdp.snapshot(id, ctx.allowedTabIds)
        const header = `Tab ${snap.tabId}: ${snap.title || '(untitled)'}\nURL: ${snap.url}`
        const snapshotText = `Fresh browser observation:\n${header}\n\n${snap.text}`
        return {
          ok: false,
          error: new Error(`element ref became stale before the action; the action was not retried. Select a new ref from the replacement snapshot. Original error: ${formatError(err)}`),
          snapshotText,
        }
      } catch {
        // Couldn't even retake the snapshot; report the original error with nothing appended.
        return { ok: false, error: err }
      }
    }
  }

  async function createWorkingTab(url?: string): Promise<chrome.tabs.Tab> {
    const created = await chrome.tabs.create({ url, active: false })
    throwIfAborted(signal)
    if (created.id !== undefined) {
      ctx.currentTabId = created.id
      markCreatedTab(created.id)
      if (ctx.allowedTabIds && !ctx.allowedTabIds.includes(created.id)) ctx.allowedTabIds.push(created.id)
      await addGroupedTabs([created.id])
    }
    return created
  }

  const tools: ToolSet = {
    browser_snapshot: tool({
      description:
        `Get an accessibility-tree observation of a tab. Interactive refs start with e; n IDs label context nodes. Unchanged refs stay valid. Results may be changes against an earlier full observation; full:true requests a complete tree. Lists tabs visible to this agent's scope. Large pages are shortened at ${visibleToolOutputChars} chars; the marker says whether and where the complete tree was saved.`,
      inputSchema: z.object({
        full: z.boolean().optional().describe('Request a full tree instead of changes, for reorientation.'),
        tabId: z.number().int().optional().describe('Tab to snapshot; defaults to the current tab.'),
      }),
      execute: async ({ tabId }) => {
        try {
          const id = resolveTab(tabId)
          return await withGroupedTabs([id], async () => {
            const snap = await cdp.snapshot(id, ctx.allowedTabIds)
            ctx.currentTabId = id
            const header = `Tab ${snap.tabId}: ${snap.title || '(untitled)'}\nURL: ${snap.url}\n\n`
            const navigation = formatNavigationTrail(await getNavigationTrail(id))
            debugLog.log('agent', 'browser_snapshot', { agentId: ctx.agentId, tabId: id })
            return await spillToolOutput('browser_snapshot', `${navigation ? `${navigation}\n\n` : ''}${header}${snap.text}`)
          })
        } catch (err) {
          debugLog.error('agent', 'browser_snapshot', err)
          return errStr(err)
        }
      },
    }),

    browser_navigate: tool({
      description:
        'Navigate a tab to a URL and wait briefly for loading. If tabId is omitted for the main agent before it has opened a working tab, this opens a background tab so the user’s current tab is not replaced. The result includes the current page snapshot and says when load completion could not be confirmed.',
      inputSchema: z.object({
        url: z.string().describe('Absolute URL to navigate to.'),
        tabId: z.number().int().optional().describe('Tab to navigate; omit to use or create the agent working tab.'),
      }),
      execute: async ({ url, tabId }) => {
        let id: number | undefined
        try {
          if (ctx.allowedTabIds === undefined && tabId === undefined && !ctx.createdTabIds?.has(ctx.currentTabId)) {
            const created = await createWorkingTab(url)
            debugLog.log('agent', 'browser_navigate create-working-tab', { agentId: ctx.agentId, tabId: created.id, url })
            if (created.id === undefined) return `Opened new tab${url ? ` at ${url}` : ''}.`
            return await withFreshSnapshot(created.id, `Opened new tab ${created.id}${url ? ` at ${url}` : ''}.`, 'browser_navigate')
          }
          id = resolveTab(tabId)
          return await withGroupedTabs([id], async () => {
            await cdp.navigate(id!, url)
            ctx.currentTabId = id!
            debugLog.log('agent', 'browser_navigate', { agentId: ctx.agentId, tabId: id, url })
            return await withFreshSnapshot(id!, `Navigated tab ${id} to ${url}.`, 'browser_navigate')
          })
        } catch (err) {
          debugLog.error('agent', 'browser_navigate', err)
          if (id !== undefined && isMissingTabError(err) && ctx.createdTabIds?.has(id)) {
            return `Tab ${id} triggered a download and closed — check api.downloads for the file.`
          }
          return errStr(err)
        }
      },
    }),

    browser_click: tool({
      description:
        'Click the element with the given ref from the latest snapshot. The tool attempts to return a fresh post-click snapshot; if the ref went stale, it does not replay the click and instead returns replacement refs.',
      inputSchema: z.object({
        ref: z.string().describe('Element ref from the latest snapshot, e.g. "e12".'),
        tabId: z.number().int().optional().describe('Tab containing the element; defaults to the current tab.'),
      }),
      execute: async ({ ref, tabId }) => {
        try {
          const id = resolveTab(tabId)
          return await withGroupedTabs([id], async () => {
            const result = await withStaleRefRecovery(id, () => cdp.click(id, ref))
            if (!result.ok) {
              debugLog.error('agent', 'browser_click', result.error)
              return await spillToolOutput(
                'browser_click',
                `${errStr(result.error)}${result.snapshotText ? `\n\n${result.snapshotText}` : ''}`,
              )
            }
            debugLog.log('agent', 'browser_click', { agentId: ctx.agentId, tabId: id, ref })
            return await withFreshSnapshot(id, `Clicked ${ref} in tab ${id}.`, 'browser_click')
          })
        } catch (err) {
          debugLog.error('agent', 'browser_click', err)
          return errStr(err)
        }
      },
    }),

    browser_type: tool({
      description:
        'Focus an input by ref and type text. Set clear:true to empty the field first, submit:true to press Enter after. The tool attempts to return a fresh snapshot; if the ref went stale, it does not type and instead returns replacement refs.',
      inputSchema: z.object({
        ref: z.string().describe('Element ref of the input/textarea, e.g. "e12".'),
        text: z.string().describe('Text to type into the element.'),
        clear: z.boolean().optional().describe('Clear the field before typing.'),
        submit: z.boolean().optional().describe('Press Enter after typing.'),
        tabId: z.number().int().optional().describe('Tab containing the element; defaults to the current tab.'),
      }),
      execute: async ({ ref, text, clear, submit, tabId }) => {
        try {
          const id = resolveTab(tabId)
          return await withGroupedTabs([id], async () => {
            const result = await withStaleRefRecovery(id, () => cdp.type(id, ref, text, { clear, submit }))
            if (!result.ok) {
              debugLog.error('agent', 'browser_type', result.error)
              return await spillToolOutput(
                'browser_type',
                `${errStr(result.error)}${result.snapshotText ? `\n\n${result.snapshotText}` : ''}`,
              )
            }
            debugLog.log('agent', 'browser_type', { agentId: ctx.agentId, tabId: id, ref, submit: !!submit })
            return await withFreshSnapshot(id, `Typed into ${ref} in tab ${id}${submit ? ' and pressed Enter' : ''}.`, 'browser_type')
          })
        } catch (err) {
          debugLog.error('agent', 'browser_type', err)
          return errStr(err)
        }
      },
    }),

    browser_fill: tool({
      description:
        'Fill several independent text fields from ONE current snapshot, in order, using the same keyboard events as browser_type. Clear defaults to true per field. No intermediate snapshots or per-field settle waits; returns one fresh snapshot to verify all values. Use for stable form sections, not fields that reveal/rebuild other fields or trigger navigation. Stops on the first error, reports completed/uncertain/unattempted fields, and never retries or submits. Do not run other actions or snapshots on this tab concurrently.',
      inputSchema: z.object({
        fields: z.array(z.object({
          ref: z.string().describe('Input/textarea ref from the latest snapshot.'),
          text: z.string().describe('Text to enter.'),
          clear: z.boolean().optional().describe('Replace existing text (default true); false appends at the caret.'),
        })).min(1).max(50).refine(
          (fields) => new Set(fields.map((field) => field.ref)).size === fields.length,
          'Each field ref must appear only once.',
        ),
        tabId: z.number().int().optional().describe('Tab containing every field; defaults to the current tab.'),
      }),
      execute: async ({ fields, tabId }) => {
        try {
          const id = resolveTab(tabId)
          return await withGroupedTabs([id], async () => {
            const completed: string[] = []
            let failure = ''
            for (const field of fields) {
              try {
                throwIfAborted(signal)
                await cdp.type(id, field.ref, field.text, { clear: field.clear ?? true, signal })
                completed.push(field.ref)
              } catch (err) {
                const remaining = fields.slice(completed.length + 1).map((item) => item.ref)
                failure = `\nStopped at ${field.ref}: ${formatError(err)}. This field may be partially changed; inspect it before retrying. No actions were replayed. Not attempted: ${remaining.join(', ') || 'none'}.`
                break
              }
            }
            const message = `Typing completed for ${completed.length}/${fields.length} fields in tab ${id}: ${completed.join(', ') || 'none'}.${failure}\nVerify the resulting values in the snapshot before continuing; typing completion is not a value-validation result.`
            return await withFreshSnapshot(id, message, 'browser_fill')
          })
        } catch (err) {
          debugLog.error('agent', 'browser_fill', err)
          return errStr(err)
        }
      },
    }),

    browser_press_key: tool({
      description:
        'Press a single key or chord on the tab, e.g. "Enter", "Tab", "Escape", "ArrowDown", "ctrl+a". Use for keyboard-driven UIs and shortcuts.',
      inputSchema: z.object({
        key: z.string().describe('Key or chord, e.g. "Enter" or "ctrl+a".'),
        tabId: z.number().int().optional().describe('Target tab; defaults to the current tab.'),
      }),
      execute: async ({ key, tabId }) => {
        try {
          const id = resolveTab(tabId)
          return await withGroupedTabs([id], async () => {
            await cdp.pressKey(id, key)
            debugLog.log('agent', 'browser_press_key', { agentId: ctx.agentId, tabId: id, key })
            return await withFreshSnapshot(id, `Pressed ${key} in tab ${id}.`, 'browser_press_key')
          })
        } catch (err) {
          debugLog.error('agent', 'browser_press_key', err)
          return errStr(err)
        }
      },
    }),

    browser_scroll: tool({
      description:
        'Scroll the page, or a scrollable element by ref, to reveal off-screen content. Positive dy scrolls down, negative up. The tool attempts to return a fresh snapshot showing the current state.',
      inputSchema: z.object({
        dy: z.number().optional().describe('Vertical pixels to scroll; positive = down. Defaults to about one viewport.'),
        ref: z.string().optional().describe('Scroll within this element instead of the page.'),
        tabId: z.number().int().optional().describe('Target tab; defaults to the current tab.'),
      }),
      execute: async ({ dy, ref, tabId }) => {
        try {
          const id = resolveTab(tabId)
          return await withGroupedTabs([id], async () => {
            await cdp.scroll(id, { ref, dy })
            debugLog.log('agent', 'browser_scroll', { agentId: ctx.agentId, tabId: id, dy, ref })
            return await withFreshSnapshot(id, `Scrolled tab ${id}${ref ? ` within ${ref}` : ''}.`, 'browser_scroll')
          })
        } catch (err) {
          debugLog.error('agent', 'browser_scroll', err)
          return errStr(err)
        }
      },
    }),

    browser_wait: tool({
      description:
        'Wait for the tab to settle. With forLoad:true, wait up to the deadline and report whether completion was confirmed; otherwise wait ms milliseconds. Use before snapshotting a page that is still loading.',
      inputSchema: z.object({
        ms: z.number().int().optional().describe('Milliseconds to wait when not waiting for load. Defaults to 1000.'),
        forLoad: z.boolean().optional().describe('Wait for the page load to complete instead of a fixed delay.'),
        tabId: z.number().int().optional().describe('Target tab; defaults to the current tab.'),
      }),
      execute: async ({ ms, forLoad, tabId }) => {
        let id: number | undefined
        try {
          id = resolveTab(tabId)
          return await withGroupedTabs([id], async () => {
            if (forLoad) {
              const loaded = await cdp.waitForLoad(id!, ms)
              return loaded
                ? `Tab ${id} finished loading.`
                : `Waited for tab ${id}, but load completion was not confirmed before the deadline. Inspect the current state or wait again.`
            }
            const delay = ms ?? 1000
            await new Promise<void>((resolve, reject) => {
              if (signal.aborted) return reject(new Error('aborted'))
              const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort)
                resolve()
              }, delay)
              const onAbort = () => {
                clearTimeout(timer)
                reject(new Error('aborted'))
              }
              signal.addEventListener('abort', onAbort, { once: true })
            })
            return `Waited ${delay}ms.`
          })
        } catch (err) {
          debugLog.error('agent', 'browser_wait', err)
          if (id !== undefined && isMissingTabError(err) && ctx.createdTabIds?.has(id)) {
            return `Tab ${id} triggered a download and closed — check api.downloads for the file; there's nothing left to wait for on this tab.`
          }
          return errStr(err)
        }
      },
    }),

    browser_screenshot: tool({
      description:
        'Capture a PNG screenshot of a tab. Use ONLY when the accessibility snapshot is insufficient: canvas, charts, images, or a purely visual layout question. For text and structure, prefer browser_snapshot.',
      inputSchema: z.object({
        tabId: z.number().int().optional().describe('Target tab; defaults to the current tab.'),
      }),
      execute: async ({ tabId }: { tabId?: number }): Promise<ScreenshotOutput> => {
        try {
          const id = resolveTab(tabId)
          return await withGroupedTabs([id], async () => {
            const shot = await cdp.screenshot(id)
            debugLog.log('agent', 'browser_screenshot', { agentId: ctx.agentId, tabId: id })
            return { base64: shot.base64, mediaType: shot.mediaType }
          })
        } catch (err) {
          debugLog.error('agent', 'browser_screenshot', err)
          return { error: formatError(err) }
        }
      },
      // NOTE: In ai@6.0.218 `toModelOutput` receives the tool-call options object
      // (with `output`), not the raw output — the verified doc showed the bare
      // output. We destructure `output` here to match the installed signature.
      toModelOutput: ({ output }: { output: ScreenshotOutput }) => {
        if (output.error !== undefined || output.base64 === undefined || output.mediaType === undefined) {
          return { type: 'error-text' as const, value: `Error: ${output.error ?? 'screenshot failed'}` }
        }
        return {
          type: 'content' as const,
          value: [{ type: 'media' as const, data: output.base64, mediaType: output.mediaType }],
        }
      },
    }),

    browser_tabs: tool({
      description:
        'Manage tabs. action:"list" lists open tabs; "create" opens a background tab (becomes the agent current tab without stealing browser focus, and returns a current snapshot); "activate" visibly focuses tabId; "close" closes tabId.',
      inputSchema: z.object({
        action: z.enum(['list', 'create', 'activate', 'close']),
        url: z.string().optional().describe('URL for action:"create".'),
        tabId: z.number().int().optional().describe('Target tab for activate/close; defaults to current where applicable.'),
      }),
      execute: async ({ action, url, tabId }) => {
        try {
          switch (action) {
            case 'list': {
              const tabs = await chrome.tabs.query({})
              const visible =
                ctx.allowedTabIds === undefined
                  ? tabs
                  : tabs.filter((t) => t.id !== undefined && ctx.allowedTabIds!.includes(t.id))
              const lines = visible.map(
                (t) =>
                  `- [${t.id}]${t.active ? ' (active)' : ''} ${t.title || '(untitled)'} — ${t.url || ''}`,
              )
              debugLog.log('agent', 'browser_tabs list', { agentId: ctx.agentId, count: visible.length })
              return await spillToolOutput('browser_tabs', `Open tabs (current: ${ctx.currentTabId}):\n${lines.join('\n')}`)
            }
            case 'create': {
              const created = await createWorkingTab(url)
              debugLog.log('agent', 'browser_tabs create', { agentId: ctx.agentId, tabId: created.id, url })
              const scoped = ctx.allowedTabIds !== undefined ? ' (added to your scope)' : ''
              const message = `Created tab ${created.id}${scoped}${url ? ` at ${url}` : ''}. It is now the current tab.`
              if (created.id !== undefined) return await withFreshSnapshot(created.id, message, 'browser_tabs')
              return message
            }
            case 'activate': {
              const id = resolveTab(tabId)
              return await withGroupedTabs([id], async () => {
                const activate = async (): Promise<void> => {
                  await chrome.tabs.update(id, { active: true })
                }
                if (cdp.switchTabs) await cdp.switchTabs({ toTab: id, signal, activate })
                else await activate()
                ctx.currentTabId = id
                debugLog.log('agent', 'browser_tabs activate', { agentId: ctx.agentId, tabId: id })
                return `Activated tab ${id}. It is now the current tab.`
              })
            }
            case 'close': {
              const id = resolveTab(tabId)
              return await withGroupedTabs([id], async () => {
                await chrome.tabs.remove(id)
                if (ctx.allowedTabIds) {
                  const index = ctx.allowedTabIds.indexOf(id)
                  if (index >= 0) ctx.allowedTabIds.splice(index, 1)
                }
                if (ctx.currentTabId === id) {
                  const fallback = ctx.allowedTabIds?.[0]
                  if (fallback !== undefined) ctx.currentTabId = fallback
                  else if (ctx.allowedTabIds === undefined) {
                    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
                    if (active?.id !== undefined) ctx.currentTabId = active.id
                  }
                }
                debugLog.log('agent', 'browser_tabs close', { agentId: ctx.agentId, tabId: id })
                return `Closed tab ${id}.`
              })
            }
            default: {
              const never: never = action
              return `Error: unknown action ${String(never)}`
            }
          }
        } catch (err) {
          debugLog.error('agent', 'browser_tabs', err)
          return errStr(err)
        }
      },
    }),

    filesystem_view: tool({
      description:
        `View a file from the persistent virtual filesystem. Use for images, PDFs, DOCX, Markdown, and other workspace/skill files. Returns extracted text when possible and sends image/PDF content to the model in multimodal form. For PDFs, mode:"pdf-page" renders a page as an image. For .html artifacts, mode:"auto" returns a LIVE SCREENSHOT of the rendered page (use it to verify an artifact before presenting it); mode:"text" returns the HTML source.`,
      inputSchema: z.object({
        path: z.string().describe('Virtual file path, e.g. "/workspace/report.pdf" or "/skills/my-skill/SKILL.md".'),
        mode: z.enum(['auto', 'text', 'file', 'pdf-page']).optional().describe('auto chooses text/image/PDF behavior; pdf-page renders a PDF page image.'),
        page: z.number().int().optional().describe('PDF page number for mode:"pdf-page" (1-based, default 1).'),
        maxChars: z.number().int().optional().describe('Max extracted text chars to include (default 30000).'),
      }),
      execute: async ({ path, mode, page, maxChars }): Promise<FilesystemViewOutput> => {
        try {
          const entry = await vfs.getEntry(path)
          if (!entry) return { error: `no file at ${path}` }

          const requested = mode ?? 'auto'
          if (artifacts && isHtmlArtifactEntry(entry) && (requested === 'auto' || requested === 'file')) {
            try {
              const shot = await artifacts.screenshot(path, { signal })
              return {
                path,
                filename: entry.name,
                mediaType: shot.mediaType,
                base64: shot.base64,
                mode: 'live',
                size: entry.size,
                text: `Live screenshot of the rendered artifact ${path} (tab ${shot.tabId}). Check it like a user would — layout, empty states, overflow, truncated text. Use api.artifacts.eval(path, code) to inspect or patch the DOM, api.artifacts.logs(path) for console errors, and mode:"text" for the HTML source.`,
              }
            } catch (err) {
              debugLog.error('agent', 'filesystem_view artifact screenshot', err)
              const source = await vfs.readText(path, { maxChars: maxChars ?? 30_000 })
              return {
                path,
                filename: entry.name,
                mediaType: entry.mediaType,
                mode: 'text',
                size: entry.size,
                text: `Could not screenshot the rendered artifact (${formatError(err)}). HTML source follows:\n\n${source.text}${source.truncated ? `\n\n[Truncated at ${source.text.length}/${source.totalChars} chars]` : ''}`,
              }
            }
          }
          const isImage = entry.mediaType.startsWith('image/')
          const isPdf = entry.mediaType === 'application/pdf' || entry.path.toLowerCase().endsWith('.pdf')
          const isDocx =
            entry.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            entry.path.toLowerCase().endsWith('.docx')

          if (requested === 'pdf-page') {
            if (!isPdf) return { error: `${path} is not a PDF` }
            const rendered = await vfs.renderPdfPage(path, { page: Math.max(1, page ?? 1) })
            return {
              path,
              filename: entry.name,
              mediaType: rendered.mediaType,
              base64: rendered.base64,
              mode: 'pdf-page',
              page: Math.max(1, page ?? 1),
              size: entry.size,
              text: `Rendered ${path} page ${Math.max(1, page ?? 1)} as an image.`,
            }
          }

          if (requested === 'file' || (requested === 'auto' && (isImage || isPdf))) {
            if (entry.size > MAX_MODEL_FILE_BYTES) {
              return {
                path,
                filename: entry.name,
                mediaType: entry.mediaType,
                mode: isImage ? 'image' : 'file',
                size: entry.size,
                text: `${path} is ${Math.round(entry.size / 1024 / 102.4) / 10} MB, above the ${Math.round(
                  MAX_MODEL_FILE_BYTES / 1024 / 102.4,
                ) / 10} MB model-view limit. Use api.fs.readBytes/readLines/extractText to inspect slices.`,
              }
            }
            let text: string | undefined
            if (isPdf) {
              try {
                text = (await vfs.readText(path, { maxChars: maxChars ?? 30_000 })).text
              } catch {
                text = `Loaded ${path} as a PDF file.`
              }
            } else {
              text = `Loaded ${path} as ${entry.mediaType}.`
            }
            const bytes = isImage || isPdf ? await vfs.readBytes(path, { length: entry.size }) : undefined
            return {
              path,
              filename: entry.name,
              mediaType: entry.mediaType,
              base64: bytes?.base64,
              mode: isImage ? 'image' : 'file',
              size: entry.size,
              text,
            }
          }

          if (requested === 'text' || requested === 'auto' || isDocx) {
            const result = await vfs.readText(path, { maxChars: maxChars ?? 30_000 })
            return {
              path,
              filename: entry.name,
              mediaType: entry.mediaType,
              mode: 'text',
              size: entry.size,
              // The marker doubles as the continuation recipe: without the offset hint
              // models re-view the same head instead of paging forward.
              text: result.truncated
                ? `${result.text}\n\n[Truncated at ${result.text.length}/${result.totalChars} chars — continue with api.fs.readText(${JSON.stringify(path)}, {offset: ${result.text.length}}) in sandbox_exec.]`
                : result.text,
            }
          }

          return {
            path,
            filename: entry.name,
            mediaType: entry.mediaType,
            mode: 'file',
            size: entry.size,
            text: `Loaded ${path}.`,
          }
        } catch (err) {
          debugLog.error('agent', 'filesystem_view', err)
          return { path, error: formatError(err) }
        }
      },
      toModelOutput: async ({ output }: { output: FilesystemViewOutput }) => {
        if (output.error || !output.path) {
          return { type: 'error-text' as const, value: `Error: ${output.error ?? 'filesystem_view failed'}` }
        }

        const text = output.text ?? `Viewed ${output.path}.`
        if (output.base64 && output.mediaType) {
          return {
            type: 'content' as const,
            value: [
              { type: 'text' as const, text },
              { type: 'media' as const, data: output.base64, mediaType: output.mediaType },
            ],
          }
        }
        return { type: 'text' as const, value: text }
      },
    }),

    filesystem_import_url: tool({
      description:
        'Download a file from an http(s) URL (e.g. a PDF/DOCX linked on a page) into the virtual filesystem instead of the user\'s disk, then read it with filesystem_view. Sends the browser\'s session cookies, so login-gated files usually work. Use this instead of navigating to a file URL — navigating triggers a disk download you cannot access.',
      inputSchema: z.object({
        url: z.string().describe('Absolute http(s) URL of the file to download.'),
        path: z.string().optional().describe('Destination virtual path, e.g. "/workspace/report.pdf". Defaults to /workspace/imports/<filename>.'),
      }),
      execute: async ({ url, path }) => {
        try {
          const entry = await vfs.importUrl(url, { path, signal })
          debugLog.log('agent', 'filesystem_import_url', { agentId: ctx.agentId, url, path: entry.path, size: entry.size })
          return `Imported ${url} → ${entry.path} (${entry.mediaType}, ${entry.size} bytes). Read it with filesystem_view or api.fs.*.`
        } catch (err) {
          debugLog.error('agent', 'filesystem_import_url', err)
          return errStr(err)
        }
      },
    }),

    sandbox_exec: tool({
      description:
        'Persistent personal functions use apps.<id>.<method>(input); inspect source/contracts with api.extensions.get({id}) or discover with api.extensions.list({query}). Read /skills/repl-extensions/SKILL.md before creating/editing one. API handles are scoped to ONE execution. Saved helpers must accept the current api as an argument (state.get = (client, url) => client.fetch(url); await state.get(api, url)); do not retain api, api.fetch, or functions closing over api across calls. Data and pure functions may persist in state. ' +
        '`intent` is shown to the user while the code runs — make it accurate. Run async JavaScript in a sandbox with top-level await, a persistent `state` object (survives across calls), and an injected `api` (api.history, api.bookmarks, api.tabs, api.downloads, api.fs, api.cdp(tabId,method,params), api.page.*, api.fetch, api.require, plus bundled-locally api.pdf (pdf-lib), api.zip (JSZip), api.bytes (base64/Uint8Array helpers — no Node Buffer)). Top-level const/let lasts only for ONE call — persist values with `state.foo = …` or `globalThis.foo = …`, never by redeclaring. `await api.require(url)` fetches + evaluates a UMD/IIFE library build (e.g. pdf-lib) ONCE per session and caches it by URL — use it instead of re-fetching/new Function every call (dynamic import() is blocked). USE THIS for searching history/bookmarks/files, reading uploaded files, loading skills, bulk or filtered operations, or anything that would otherwise take many tool calls. Filter and aggregate INSIDE the snippet and return only what matters — output is truncated at ' +
        `${MAX_TOOL_OUTPUT} chars in the visible result; when the VFS spill succeeds, the marker names the file holding the complete returned value, and otherwise says recovery is unavailable. Console arguments are summarized before collection, so return recoverable data instead of only logging it. A single trailing expression is auto-returned.\n\n${SANDBOX_API_CHEATSHEET}`,
      inputSchema: z.object({
        // First property on purpose: it streams before `code`, so the UI can label
        // the call from the intent alone while the snippet is still arriving.
        intent: z
          .string()
          .describe(
            'Short present-participle phrase (3–8 words) describing what this code is doing, shown to the user in place of the code, e.g. "Parsing the syllabus PDF" or "Taking a screenshot of the article". Specific, no trailing period.',
          ),
        code: z.string().describe('Async JavaScript to run. Use `await`, `api.*`, `state`, and `console`. Return only what you need.'),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe(
            `Script-execution timeout in ms (default ${SANDBOX_DEFAULT_TIMEOUT_MS}, max ${SANDBOX_MAX_TIMEOUT_MS}). Time spent awaiting api.* calls does not count. On timeout, console output produced so far is still returned.`,
          ),
      }),
      execute: async ({ intent, code, timeoutMs }) => {
        void intent // UI label only — never reaches the sandbox, so execution is unchanged.
        try {
          return await withGroupedTabs(currentScopeTabs(), async () => {
            const result = await sandbox.exec({
              code,
              sessionId: sandboxSessionId,
              timeoutMs,
              scope,
              signal,
              chatId,
            })
            debugLog.log('agent', 'sandbox_exec', {
              agentId: ctx.agentId,
              ok: result.ok,
              ms: result.durationMs,
            })
            const parts: string[] = []
            if (result.logs.length > 0) {
              parts.push('Console output:\n' + result.logs.join('\n'))
            }
            if (result.ok) {
              parts.push(
                result.value !== undefined
                  ? `[return value]\n${result.value}`
                  : 'Code executed (no return value).',
              )
            } else {
              const errText = result.error ?? 'unknown sandbox error'
              parts.push(errText.startsWith('Error: ') ? errText : `Error: ${errText}`)
            }
            return await spillToolOutput('sandbox_exec', parts.join('\n\n'))
          })
        } catch (err) {
          debugLog.error('agent', 'sandbox_exec', err)
          return errStr(err)
        }
      },
      toModelOutput: ({ output }: { output: string }) => {
        return output.startsWith('Error:')
          ? { type: 'error-text' as const, value: output }
          : { type: 'text' as const, value: output }
      },
    }),
  }

  // Subagents are assigned to existing tabs; only the main agent may create,
  // activate, close, move, or group Chrome tabs.
  if (isSubagent) delete tools.browser_tabs

  // A subagent without a prepared page is genuinely offline-only. Removing
  // these tools is the runtime backstop: it cannot navigate a New Tab through
  // direct browser tools, tab creation, sandbox browser APIs, or URL imports.
  if (isOfflineSubagent) {
    for (const name of [
      'browser_snapshot',
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_fill',
      'browser_press_key',
      'browser_scroll',
      'browser_wait',
      'browser_screenshot',
      'filesystem_import_url',
      'sandbox_exec',
    ]) {
      delete tools[name]
    }
  }

  // Subagent, task, and memory tools are only available to the main agent.
  if (!isSubagent) {
    tools.workflow_run = tool({
      description:
        'Run a dynamic JavaScript workflow when a hard task benefits from 3+ coordinated subagents, prompt reuse, fan-out/fan-in, or feeding one result into another. The restricted script has args plus agent(prompt, options), parallel([...thunks]), pipeline(items, mapper), phase(id), and log(message). It has NO direct api.* browser/filesystem access. At most 10 agents may be started. Inline scripts are persisted and their returned source path can be rerun with scriptPath. Workflows run synchronously unless background:true; background workflows use task_wait/task_status/task_cancel. Workflow messaging is not supported.',
      inputSchema: z.object({
        title: z.string().optional().describe('Short user-facing workflow title. Required with inline script; omitted with scriptPath.'),
        description: z.string().optional().describe('One-sentence workflow purpose. Required with inline script; omitted with scriptPath.'),
        phases: z
          .array(
            z.object({
              id: z.string().describe('Stable phase id used by phase(id).'),
              title: z.string().describe('User-facing phase title.'),
              description: z.string().optional(),
            }),
          )
          .optional()
          .describe('Optional ordered phase definitions for the workflow overview.'),
        script: z.string().optional().describe('JavaScript workflow body with top-level await/return. Provide exactly one of script or scriptPath.'),
        scriptPath: z.string().optional().describe('Previously persisted /workspace/workflows/*.js path. Provide exactly one of scriptPath or script.'),
        args: z.any().optional().describe('JSON value exposed to the script as the read-only global args.'),
        background: z.boolean().optional().describe('Launch as one background workflow task and return immediately.'),
      }),
      execute: async ({ title, description, phases, script, scriptPath, args: workflowArgs, background }, { toolCallId }) => {
        try {
          if (!runWorkflow) return 'Error: dynamic workflows are unavailable in this context.'
          const result = await runWorkflow({
            title,
            description,
            phases,
            script,
            scriptPath,
            args: workflowArgs,
            background,
            parentToolCallId: toolCallId,
          })
          return await spillToolOutput('workflow_run', result)
        } catch (err) {
          debugLog.error('agent', 'workflow_run', err)
          return errStr(err)
        }
      },
      toModelOutput: ({ output }: { output: string }) =>
        output.startsWith('Error:')
          ? { type: 'error-text' as const, value: output }
          : { type: 'text' as const, value: output },
    })

    tools.subagent_spawn = tool({
      description:
        'Delegate a self-contained sub-task to a subagent. It starts fresh with only the task string and assigned tabs, and cannot spawn subagents. Browser work requires a prepared tab already at a nonblank URL. Passing tabIds:[] creates an offline-only subagent with no browser access. With background:true it returns a task id for task_status/task_wait.',
      inputSchema: z.object({
        task: z.string().describe('The focused sub-task for the subagent to accomplish.'),
        tabIds: z
          .array(z.number().int())
          .optional()
          .describe('Prepared nonblank tabs the subagent may touch. Defaults to the current tab. Pass [] only for offline work; the subagent will have no browser access.'),
        background: z.boolean().optional().describe('Run detached and return a task id immediately.'),
        keepTabs: z
          .boolean()
          .optional()
          .describe('Keep tabs the subagent opened after it finishes, instead of auto-closing them. Use when the deliverable is an open page.'),
      }),
      execute: async ({ task, tabIds, background, keepTabs }, { toolCallId }) => {
        try {
          // Explicit [] is offline-only, so there are no tabs to group.
          const actionTabIds = tabIds ? tabIds : currentScopeTabs()
          return await withGroupedTabs(actionTabIds, async () => {
            const result = await spawnSubagent({
              task,
              tabIds,
              background,
              keepTabs,
              parentToolCallId: toolCallId,
            })
            return await spillToolOutput('subagent_spawn', result)
          })
        } catch (err) {
          debugLog.error('agent', 'subagent_spawn', err)
          return errStr(err)
        }
      },
    })

    tools.subagent_message = tool({
      description:
        'Send a message to a background subagent (one you started with background:true). A running subagent sees it right after its current tool call finishes — use it to redirect, correct, or add information without restarting the task. A cancelled subagent (e.g. the user clicked Stop) is RESUMED from its saved context with your message attached — e.g. subagent_message(taskId, "Continue") picks up exactly where it left off. It does not return a reply; keep collecting the result via task_wait/task_status.',
      inputSchema: z.object({
        taskId: z.string().describe('The background task id of the subagent to message.'),
        message: z.string().describe('The steering message, e.g. a correction, updated instruction, or "Continue" to resume a cancelled subagent.'),
      }),
      execute: async ({ taskId, message }) => {
        try {
          if (!messageSubagent) return 'Error: subagent messaging is not available in this context.'
          const result = await messageSubagent(taskId, message)
          debugLog.log('agent', 'subagent_message', { agentId: ctx.agentId, taskId })
          return result
        } catch (err) {
          debugLog.error('agent', 'subagent_message', err)
          return errStr(err)
        }
      },
    })

    tools.task_status = tool({
      description:
        'Check the status of background tasks (subagents started with background:true). With taskId, report that one; without, list all tasks.',
      inputSchema: z.object({
        taskId: z.string().optional().describe('A specific task id; omit to list all tasks.'),
      }),
      execute: async ({ taskId }) => {
        try {
          if (taskId) {
            const info = tasks.get(taskId)
            if (!info) return `Error: no task with id ${taskId}.`
            if (info.status === 'error') tasks.markFailureReported(taskId)
            return formatTask(info, tasks.canResume(taskId))
          }
          const all = tasks.list()
          if (all.length === 0) return 'No background tasks.'
          for (const t of all) if (t.status === 'error') tasks.markFailureReported(t.id)
          return all.map((t) => formatTask(t, tasks.canResume(t.id))).join('\n')
        } catch (err) {
          debugLog.error('agent', 'task_status', err)
          return errStr(err)
        }
      },
    })

    tools.task_wait = tool({
      description:
        'Wait for background tasks to finish and return their statuses and results. Pass ALL the task ids you are waiting on in ONE call via taskIds — with mode "any" (default) it returns as soon as the first one finishes, listing the others’ statuses; with mode "all" it waits for every one. Do NOT poll tasks one at a time in separate calls. Returns early if a new user message arrives so you can react to it.',
      inputSchema: z.object({
        taskId: z.string().optional().describe('A single task id to wait for (prefer taskIds).'),
        taskIds: z.array(z.string()).optional().describe('All the task ids to wait on together, in one call.'),
        mode: z
          .enum(['any', 'all'])
          .optional()
          .describe('"any" (default): return as soon as the first task finishes. "all": return when every task has finished.'),
        timeoutMs: z.number().int().optional().describe('Max time to wait in ms (default 300000, max 600000).'),
      }),
      execute: async ({ taskId, taskIds, mode, timeoutMs }) => {
        try {
          const ids = [...new Set([...(taskIds ?? []), ...(taskId ? [taskId] : [])])]
          if (ids.length === 0) return 'Error: pass taskIds (or taskId) — at least one task id to wait for.'
          const unknown = ids.filter((id) => !tasks.get(id))
          if (unknown.length > 0) return `Error: no task with id ${unknown.join(', ')}.`
          const waitAll = mode === 'all'
          const deadline = Date.now() + Math.min(Math.max(timeoutMs ?? 300_000, 1_000), 600_000)
          const report = (header: string): string => {
            const lines = ids.map((id) => {
              const cur = tasks.get(id)
              if (cur?.status === 'error') tasks.markFailureReported(id)
              return cur ? formatTask(cur, tasks.canResume(id)) : `Task ${id} disappeared.`
            })
            return header ? `${header}\n${lines.join('\n')}` : lines.join('\n')
          }
          // Poll the registry; detached runs update their records on completion.
          for (;;) {
            const settled = ids.filter((id) => {
              const cur = tasks.get(id)
              return !cur || (cur.status !== 'running' && cur.status !== 'cancelling')
            }).length
            if (waitAll ? settled === ids.length : settled > 0) return report('')
            if (signal.aborted) return 'Error: turn aborted while waiting.'
            // A user message arrived mid-wait: return early so the model can
            // react to it (e.g. relay it via subagent_message) — the message
            // attaches at the next step boundary, right after this result.
            if (steeringPending?.()) {
              return report(
                'Stopped waiting early: a new user message just arrived (attached next). Handle it, then resume with task_wait. Current statuses:',
              )
            }
            if (Date.now() >= deadline) {
              return report('Timed out waiting. Current statuses (task_wait again to keep waiting):')
            }
            await abortableDelay(300, signal)
          }
        } catch (err) {
          debugLog.error('agent', 'task_wait', err)
          return errStr(err)
        }
      },
    })

    tools.task_cancel = tool({
      description: 'Request cancellation of a running background task by id. The task remains cancelling until in-flight operations settle.',
      inputSchema: z.object({
        taskId: z.string().describe('The task id to cancel.'),
      }),
      execute: async ({ taskId }) => {
        try {
          const info = tasks.get(taskId)
          if (!info) return `Error: no task with id ${taskId}.`
          tasks.cancel(taskId)
          return `Cancellation requested for task ${taskId}. Check task_status/task_wait for terminal cancellation.`
        } catch (err) {
          debugLog.error('agent', 'task_cancel', err)
          return errStr(err)
        }
      },
    })

    // The write policy for long-term memory lives HERE, in this description —
    // the static system prompt only explains the mechanism (see the header
    // comment in system-prompt.ts: one canonical home per rule).
    if (askUser) {
      tools.ask_user = tool({
        description:
          "Ask the user one question and WAIT for their answer. Use this only when you are genuinely blocked on a preference, constraint, or decision that is theirs to make and that you cannot infer from the conversation, the page, or memory — e.g. which of several equally valid directions they want. Do NOT use it to confirm a step you should just take, to ask permission for ordinary work, to check in on progress, or to hand back work you could have done. Prefer making a reasonable choice and saying what you assumed. One question per call, phrased so a one-tap answer is possible; give options when the answer is a small closed set. The user may reply in the chat instead, in which case you get their message as steering.",
        inputSchema: z.object({
          question: z.string().describe('The single question, as one short line the user can answer at a glance.'),
          options: z
            .array(z.string())
            .optional()
            .describe('2-5 short answer choices shown as one-tap pills. Omit for an open-ended answer.'),
          detail: z
            .string()
            .optional()
            .describe('Optional context shown under the question (why you are asking, what differs between the options).'),
          allow_notes: z
            .boolean()
            .optional()
            .describe('Also offer a free-text notes box alongside the choices. Default true when options are given.'),
        }),
        execute: async ({ question, options, detail, allow_notes }) => {
          try {
            const choices = (options ?? []).map((label, index) => ({ id: `opt-${index + 1}`, label }))
            // Options become a single choice FIELD rather than one action per
            // option: the answer then carries both the pick and any notes, and
            // "Send" stays the one commit point whether or not options exist.
            const request: Omit<UserPromptRequest, 'id'> = {
              kind: 'question',
              title: question,
              detail,
              detailLabel: 'Show more',
              fields:
                choices.length > 0
                  ? [{ id: 'answer', kind: 'choice', label: 'Answer', options: choices, required: true }]
                  : [{ id: 'answer', kind: 'text', label: 'Answer', placeholder: 'Your answer…', required: true }],
              actions: [{ id: 'send', label: 'Send', tone: 'primary', requiresFields: true }],
              allowNotes: allow_notes ?? choices.length > 0,
              notesPlaceholder: 'Anything else worth knowing?',
            }
            const answer = await askUser(request)
            debugLog.log('agent', 'ask_user answered', { status: answer.status })
            return formatUserPromptAnswer(request, answer)
          } catch (err) {
            debugLog.error('agent', 'ask_user', err)
            return errStr(err)
          }
        },
      })
    }

    tools.memory_write = tool({
      description:
        'Save a small amount of reusable context to long-term memory. Two kinds, chosen per entry by whether "scopes" is set. ' +
        `(1) USER memory (no scopes) → ${MEMORY_PATH}: context that applies everywhere — identity, school or work context, tools and ` +
        'services, standing preferences, stable identifiers, canonical URLs, or a genuinely ongoing course/project. Never save a turn log ' +
        'here: individual emails or people mentioned only to find one, assignments, searches, orders, page state, or what you just did. ' +
        `(2) SITE memory (with scopes) → ${SITE_MEMORY_PATH}: verified shortcuts, reusable methods, or context the user asks you to ` +
        'remember for a particular site, course, or project. Short summaries appear automatically in context; longer procedures live ' +
        'in Markdown field guides under /workspace/sites/. Prefer methods that combine related records and produce useful artifacts ' +
        'over click-by-click transcripts. For an API method, document the supported access method (never credentials), required inputs ' +
        'and identifiers, pagination, relevant response fields, joins between records, attachment retrieval, VFS saving/viewing, and ' +
        'observed limitations. Use documented APIs and normal authorized access for the current user. Include a concise working snippet when useful. ' +
        'Distinguish steps actually verified from assumptions; an update date alone does not establish verification. Save changing data ' +
        'in task artifacts with source URLs and retrieval dates, and fetch it freshly next time. A memory is not a scheduled reminder. ' +
        'SCOPES are host/path globs: "*" matches one host label or path segment, "**" matches the rest; scheme/query/fragment are ignored. ' +
        'Use the narrowest scopes covering where the guidance applies; application-wide methods and course-specific rules are separate ' +
        'entries. Include both UI and API paths when appropriate. For a detailed method, first write/update its Markdown guide with ' +
        'api.fs.writeText, then pass its path in "guide" and an actionable summary in "body". Optional "triggers" are explicit app/site ' +
        'names (e.g. ["Canvas"]), not generic words like "assignments"; they surface a guide when the user names that site before navigation. ' +
        'Do not store patient/customer records in a reusable application guide. User corrections and successful reusable discoveries ' +
        'are strong signals to save. Finish the task and relevant exploration, then consolidate useful learning in one memory_write call. ' +
        'Do not perform unrelated exploration just to generate memories. If nothing reusable was learned, write nothing. ' +
        'TITLE is a retrieval cue explaining when the entry helps; BODY is a concise immediately useful summary, not just a file pointer. ' +
        'Update an existing title/guide when it changes instead of making near-duplicates. Omitted guide/triggers preserve existing ' +
        'metadata; use guide:"" or triggers:[] to clear it. Forget obsolete entries. Never store passwords, tokens, or other secrets.',
      inputSchema: z.object({
        memories: z
          .array(
            z.object({
              title: z
                .string()
                .min(1)
                .describe(
                  'A retrieval cue, e.g. "[Current] Example College — school and Canvas context" or "COURSE 101 — class rules for examples".',
                ),
              body: z
                .string()
                .min(1)
                .describe('Verified, immediately useful summary; at most 600 characters for site memories. Keep the detailed procedure in guide.'),
              guide: z.string().optional().describe('SITE memory only: existing Markdown procedure under /workspace/sites/, written with api.fs.writeText. Empty string removes its link.'),
              triggers: z.array(z.string().min(3).max(60)).max(8).optional().describe('SITE guide only: explicit site/app names that activate this guide from a task before navigation; [] clears them.'),
              scopes: z
                .array(z.string().min(1))
                .optional()
                .describe(
                  'Set to make this a SITE memory: host/path globs where it applies, e.g. ["school.instructure.com/courses/123/**"]. Omit for user memory.',
                ),
            }),
          )
          .optional()
          .describe('Context bundles to remember. Reusing an existing title updates that entry in place.'),
        forget: z
          .array(z.string())
          .optional()
          .describe('Titles of memories (either kind) to delete, e.g. a fact that is now wrong. Matched loosely against existing titles.'),
      }),
      execute: async (input) => {
        try {
          const all = input.memories ?? []
          // Validate every guide before changing either index; a typo must not
          // create an apparently usable workflow with a broken file reference.
          for (const entry of all) {
            if ((entry.guide || entry.triggers?.length) && !entry.scopes?.length) {
              throw new Error('guide and triggers require site scopes')
            }
            if (entry.guide && normalizeGuidePath(entry.guide) !== entry.guide) {
              throw new Error('guide must be an absolute Markdown path under /workspace/sites/')
            }
            if (entry.guide && !(await vfs.getEntry(entry.guide))) {
              throw new Error(`Guide ${entry.guide} does not exist. Write it with api.fs.writeText before saving the memory.`)
            }
          }
          const userMemories = all
            .filter((m) => !m.scopes || m.scopes.length === 0)
            .map(({ title, body }) => ({ title, body }))
          const siteMemories = all
            .filter((m) => m.scopes && m.scopes.length > 0)
            .map(({ title, body, scopes, guide, triggers }) => ({ title, body, scopes: scopes ?? [], guide, triggers }))
          const forget = input.forget ?? []

          // `forget` runs against both files: the model addresses entries by
          // title and should not need to know which file holds one.
          const userResult =
            userMemories.length > 0 || forget.length > 0
              ? await applyMemoryWrite(vfs, { memories: userMemories, forget })
              : undefined
          const siteResult =
            siteMemories.length > 0 || forget.length > 0
              ? await applySiteMemoryWrite(vfs, { memories: siteMemories, forget })
              : undefined

          const titles = [
            ...(userResult ? [...userResult.addedTitles, ...userResult.updatedTitles] : []),
            ...(siteResult ? [...siteResult.addedTitles, ...siteResult.updatedTitles] : []),
          ]
          const forgotten = [...(userResult?.forgottenTitles ?? []), ...(siteResult?.forgottenTitles ?? [])]
          // Only announce real changes: a no-op write shouldn't surface a chip.
          if (titles.length > 0 || forgotten.length > 0) {
            // Point the receipt chip at the file that changed; MEMORY.md wins when both did.
            const userChanged =
              (userResult?.addedTitles.length ?? 0) + (userResult?.updatedTitles.length ?? 0) + (userResult?.forgottenTitles.length ?? 0) > 0
            emit({
              type: 'memory-saved',
              agentId: ctx.agentId,
              titles,
              forgotten,
              file: userChanged ? MEMORY_PATH : SITE_MEMORY_PATH,
            })
          }
          debugLog.log('agent', 'memory_write', {
            agentId: ctx.agentId,
            added: (userResult?.addedTitles.length ?? 0) + (siteResult?.addedTitles.length ?? 0),
            updated: (userResult?.updatedTitles.length ?? 0) + (siteResult?.updatedTitles.length ?? 0),
            forgotten: forgotten.length,
            user: userResult?.entries.length,
            site: siteResult?.entries.length,
          })
          return describeCombinedMemoryWrite(userResult, siteResult, forgotten, siteMemories.length > 0)
        } catch (err) {
          debugLog.error('agent', 'memory_write', err)
          return errStr(err)
        }
      },
    })
  }

  if (args.typeSafe) {
    tools.verify_extraction = tool({
      description: 'Check extracted facts against their ORIGINAL source with TypeSafe. After extracting structured facts from pages or files, batch the important fields here before relying on them in a final answer or write. Provide verbatim source text, not your summary or the proposed values alone. Each meaning must identify the exact entity/event, requested fact, and relevant units or dates. This checks factual support and entity association; it does not extract new values. Re-read and correct unsupported/uncertain values. An unavailable check is not a pass.',
      inputSchema: z.object({
        source: z.string().min(1).max(60_000).describe('Verbatim original evidence, including context needed to identify the entity and interpret the values.'),
        fields: z.array(z.object({ field: z.string().min(1).max(120), value: z.string().max(2000),
          meaning: z.string().min(1).max(1000).describe('The entity/event and exact fact this field is intended to represent.') })).min(1).max(24),
      }),
      execute: async ({ source, fields }) => JSON.stringify(await verifyExtraction(args.typeSafe!, source, fields)),
    })
  }
  return withWellFormedOutputs(tools, signal, operationTracker)
}

function abortGuardCdp(cdp: CdpService, signal: AbortSignal): CdpService {
  return new Proxy(cdp, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...rawArgs: unknown[]) => {
        throwIfAborted(signal)
        const args = [...rawArgs]
        if (property === 'send') args[3] = signal
        else if (property === 'click' || property === 'pressKey' || property === 'navigate') args[2] = signal
        else if (property === 'type' || property === 'evalInFrame') {
          args[3] = { ...((args[3] as object | undefined) ?? {}), signal }
        } else if (property === 'scroll' || property === 'evalInPage') {
          args[1] = property === 'scroll'
            ? { ...((args[1] as object | undefined) ?? {}), signal }
            : args[1]
          if (property === 'evalInPage') args[2] = { ...((args[2] as object | undefined) ?? {}), signal }
        } else if (property === 'attachFiles' || property === 'clickInFrame') args[3] = signal
        else if (property === 'waitForLoad') args[2] = signal
        return Reflect.apply(value, target, args)
      }
    },
  }) as CdpService
}

function abortGuardVfs(vfs: VirtualFileSystemService, signal: AbortSignal): VirtualFileSystemService {
  return new Proxy(vfs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...rawArgs: unknown[]) => {
        throwIfAborted(signal)
        const args = [...rawArgs]
        if (property === 'writeText' || property === 'writeBase64' || property === 'importUrl') {
          args[2] = property === 'writeText' || property === 'writeBase64'
            ? { ...((args[2] as object | undefined) ?? {}), signal }
            : args[2]
          if (property === 'importUrl') args[1] = { ...((args[1] as object | undefined) ?? {}), signal }
        } else if (property === 'createSkill') {
          args[0] = { ...((args[0] as object | undefined) ?? {}), signal }
        } else if (property === 'delete' || property === 'renderPdfPage') {
          args[1] = { ...((args[1] as object | undefined) ?? {}), signal }
        }
        return Reflect.apply(value, target, args)
      }
    },
  }) as VirtualFileSystemService
}

/**
 * Backstop: page-derived tool outputs can carry unpaired UTF-16 surrogates
 * (broken page text, or upstream slicing), and one lone surrogate anywhere in
 * the request makes OpenAI reject the whole turn. Scrub every tool output.
 */
function withWellFormedOutputs(tools: ToolSet, signal: AbortSignal, tracker?: ToolOperationTracker): ToolSet {
  for (const t of Object.values(tools)) {
    const execute = t.execute?.bind(t)
    if (!execute) continue
    t.execute = async (input, options) => {
      // One boundary for every tool, including future tools: once a turn is
      // cancelled no fresh browser/network/filesystem side effect may start.
      throwIfAborted(signal)
      const operation = Promise.resolve(execute(input, options))
      const output = await (tracker ? tracker.track(operation) : operation)
      throwIfAborted(signal)
      return deepToWellFormed(output)
    }
  }
  return tools
}

function formatTask(info: import('../shared/types').TaskInfo, canResume = false): string {
  const dur = info.endedAt ? `${Math.round((info.endedAt - info.startedAt) / 1000)}s` : 'running'
  const progress =
    info.kind === 'workflow' && info.workflowProgress
      ? ` — ${info.workflowProgress.completedAgents}/${info.workflowProgress.totalAgents} agents, ${info.workflowProgress.totalTokens} tokens${info.workflowProgress.currentPhaseId ? `, phase ${info.workflowProgress.currentPhaseId}` : ''}`
      : ''
  const head = `Task ${info.id} [${info.status}] (${dur}, ${info.kind}): ${info.description}${progress}`
  const body = info.result ? `${head}\n  result: ${info.result}` : head
  if (info.status === 'orphaned' && info.kind === 'subagent') {
    return canResume
      ? `${body}\n  Resume with subagent_message(${JSON.stringify(info.id)}, "Continue") — it picks up from its last saved step.`
      : `${body}\n  Its saved context was lost; spawn a new subagent for this work.`
  }
  if (info.status === 'orphaned') return `${body}\n  Workflow context was lost and cannot be resumed; run a fresh workflow.`
  return body
}
