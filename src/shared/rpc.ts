/**
 * postMessage protocol between the side panel (host) and the sandboxed
 * eval page (sandbox.html iframe). The sandbox has no chrome.* access —
 * every `api.*` call inside user code round-trips to the host over this
 * protocol. All payloads must be structured-cloneable.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

/**
 * sandbox_exec timeout policy, shared by the host (clamping + hard ceiling),
 * the sandbox (script-execution deadline + error text), and the tool schema.
 * `timeoutMs` bounds continuous SCRIPT execution — time spent awaiting a host
 * api.* call is not counted. Total wall time is capped by the host at
 * SANDBOX_MAX_TIMEOUT_MS + its margin.
 */
export const SANDBOX_DEFAULT_TIMEOUT_MS = 60_000
export const SANDBOX_MAX_TIMEOUT_MS = 300_000
/** Workflow scripts spend most of their lifetime awaiting subagents. */
export const WORKFLOW_MAX_WALL_TIMEOUT_MS = 60 * 60 * 1000

/* host -> sandbox */
export type HostToSandbox =
  | {
      kind: 'exec'
      execId: string
      sessionId: string
      code: string
      timeoutMs: number
    }
  | {
      /** Revoke an exec's authority to issue any more api.* calls. */
      kind: 'cancel'
      execId: string
      reason?: string
    }
  | {
      kind: 'api-result'
      execId: string
      callId: string
      ok: boolean
      value?: JsonValue
      error?: string
    }

/* sandbox -> host */
export type SandboxToHost =
  | { kind: 'ready' }
  | {
      kind: 'api-call'
      execId: string
      callId: string
      /** Dot path into the host API, e.g. 'history.search', 'page.click', 'cdp'. */
      path: string
      args: JsonValue[]
    }
  | { kind: 'console'; execId: string; level: 'log' | 'warn' | 'error'; text: string }
  | {
      kind: 'exec-result'
      execId: string
      ok: boolean
      /** Serialized (JSON.stringify, 2-space) completion value. */
      value?: string
      error?: string
      logs: string[]
    }

/**
 * API paths the host implements. Kept as a const list so the host dispatcher,
 * the sandbox proxy builder, and the system prompt stay in sync.
 */
export const SANDBOX_API_PATHS = [
  'extensions.list', 'extensions.get', 'extensions.stage', 'extensions.draft', 'extensions.recordTest',
  'extensions.publish', 'extensions.resolve', 'extensions.disable', 'extensions.remove', 'extensions.rollback',
  'extensions.configure', 'extensions.settings',
  'history.search',
  'history.getVisits',
  'navigation.recent',
  'tabs.list',
  'tabs.get',
  'tabs.create',
  'tabs.activate',
  'tabs.close',
  'tabs.group',
  'tabs.ungroup',
  'tabs.move',
  'tabGroups.list',
  'tabGroups.get',
  'tabGroups.update',
  'tabGroups.move',
  'bookmarks.search',
  'bookmarks.tree',
  'downloads.search',
  'storage.get',
  'storage.set',
  'fs.list',
  'fs.summary',
  'fs.skills',
  'fs.stat',
  'fs.writeText',
  'fs.writeBase64',
  'fs.createSkill',
  'fs.readText',
  'fs.readHtml',
  'fs.readLines',
  'fs.readBytes',
  'fs.dataUrl',
  'fs.extractText',
  'fs.search',
  'fs.renderPdfPage',
  'fs.importUrl',
  'cdp',
  'net.requests',
  'net.body',
  'page.snapshot',
  'page.eval',
  'page.attachFiles',
  'page.fetch',
  'page.click',
  'page.type',
  'page.pressKey',
  'page.scroll',
  'page.navigate',
  'page.waitForLoad',
  'page.screenshotToLog',
  'frames.list',
  'frames.eval',
  'frames.click',
  'fetch',
  // Living HTML documents (see shared/artifacts.ts). Implemented by the
  // background dispatcher, which can reach open viewer tabs.
  'artifacts.list',
  'artifacts.create',
  'artifacts.open',
  'artifacts.eval',
  'artifacts.save',
  'artifacts.reload',
  'artifacts.logs',
  'artifacts.trace',
  'artifacts.reset',
  'artifacts.url',
  'artifacts.close',
  // Scheduled prompts (see shared/automations.ts). Background dispatcher only.
  'automations.list',
  'automations.get',
  'automations.create',
  'automations.update',
  'automations.delete',
  'automations.run',
  // Collaborative page notes (see shared/stickies.ts). Background dispatcher only.
  'stickies.list',
  'stickies.get',
  'stickies.create',
  'stickies.update',
  'stickies.open',
  'stickies.close',
  'stickies.delete',
  // Implemented only by the restricted workflow dispatcher.
  'workflow.agent',
  'workflow.phase',
  'workflow.log',
] as const

export type SandboxApiPath = (typeof SANDBOX_API_PATHS)[number]
