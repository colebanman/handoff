/**
 * Maps raw agent tool names to friendly Cursor-Glass-style verbs, and extracts
 * the "bright payload" for a tool row per the prominence rule: dim verb + bright
 * payload (e.g. Clicked button “Sign in”, Navigated canvas.edu).
 *
 * toolLabel returns { verb, payload }. The verb morphs running -> done based on
 * `status`. The payload is derived from the tool input (while running / for
 * identity) and enriched with the output once done (counts, results).
 *
 * sandbox_exec is the exception: its model-written `intent` replaces the verb
 * entirely ("Parsing the syllabus PDF" → "Ran · parsing the syllabus PDF") and
 * carries no payload — code size is not information the user can act on.
 */
import type { ToolStatus } from '../shared/types'
import { shortId } from '../shared/ids'

export interface ToolLabelParts {
  verb: string
  payload: string
}

interface VerbPair {
  running: string
  done: string
}

/** Raw tool name -> present-participle / past-tense verbs. */
const VERBS: Record<string, VerbPair> = {
  browser_navigate: { running: 'Navigating', done: 'Navigated' },
  browser_click: { running: 'Clicking', done: 'Clicked' },
  browser_type: { running: 'Typing', done: 'Typed' },
  browser_fill: { running: 'Filling form', done: 'Filled form' },
  browser_press_key: { running: 'Pressing', done: 'Pressed' },
  browser_snapshot: { running: 'Reading page', done: 'Read page' },
  browser_scroll: { running: 'Scrolling', done: 'Scrolled' },
  browser_wait: { running: 'Waiting', done: 'Waited' },
  browser_screenshot: { running: 'Screenshotting', done: 'Screenshot' },
  browser_tabs: { running: 'Tabs', done: 'Tabs' },
  filesystem_view: { running: 'Viewing file', done: 'Viewed file' },
  filesystem_import_url: { running: 'Importing file', done: 'Imported file' },
  sandbox_exec: { running: 'Running code', done: 'Ran code' },
  workflow_run: { running: 'Running workflow', done: 'Ran workflow' },
  subagent_spawn: { running: 'Delegating', done: 'Delegated' },
  subagent_message: { running: 'Steering subagent', done: 'Steered subagent' },
  task_status: { running: 'Checking on', done: 'Checked on' },
  task_wait: { running: 'Waiting on', done: 'Waited on' },
  task_cancel: { running: 'Cancelling', done: 'Cancelled' },
  memory_write: { running: 'Saving memory', done: 'Remembered' },
  verify_extraction: { running: 'Checking extracted facts', done: 'Checked extracted facts' },
}

function friendlyVerb(toolName: string, status: ToolStatus): string {
  const pair = VERBS[toolName]
  if (!pair) {
    // Fallback: never show a raw snake_case name. Title-case it.
    const nice = toolName
      .split('_')
      .map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(' ')
    return status === 'running' ? nice : nice
  }
  if (status === 'error') return pair.done
  return status === 'running' ? pair.running : pair.done
}

/** Safely read a string field from an unknown record. */
function str(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  }
  return undefined
}

function num(obj: unknown, key: string): number | undefined {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'number') return v
  }
  return undefined
}

/** URL -> bare hostname (fallback to the raw string). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function truncateQuote(s: string, max = 40): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * sandbox_exec's model-written `intent` becomes the whole row label, so it is
 * shown verbatim apart from cosmetics: collapse whitespace, drop a trailing
 * period, capitalize the first letter. Only the FIRST character is touched —
 * rewriting the rest would mangle acronyms ("Parsing the PDF").
 */
function normalizeIntent(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim().replace(/\.$/, '')
  if (!t) return ''
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/**
 * Lowercase the leading character for use after "Ran · " / "Failed · ", but only
 * when the second character is itself lowercase — otherwise the word is an
 * acronym or all-caps ("PDF export") and must stay as written.
 */
function lowerFirst(s: string): string {
  if (!s) return ''
  const second = s.charAt(1)
  if (second && second !== second.toLowerCase()) return s
  return s.charAt(0).toLowerCase() + s.slice(1)
}

/**
 * Compute the { verb, payload } for a tool row.
 * @param toolName raw tool name (never shown to the user directly)
 * @param status   running | done | error
 * @param input    parsed tool input (may be undefined while args still stream)
 * @param output   tool result (present once done)
 */
export function toolLabel(
  toolName: string,
  status: ToolStatus,
  input: unknown,
  output: unknown,
): ToolLabelParts {
  const verb = friendlyVerb(toolName, status)

  switch (toolName) {
    case 'browser_navigate': {
      const url = str(input, 'url')
      return { verb, payload: url ? hostOf(url) : '' }
    }
    case 'browser_click': {
      const target = input && typeof input === 'object' && '__target' in input ? input.__target : undefined
      const roles: Record<string, string> = { button: 'button', link: 'link', checkbox: 'checkbox', radio: 'option', menuitem: 'menu item', tab: 'tab', textbox: 'text field', searchbox: 'search field', combobox: 'dropdown', switch: 'switch' }
      const role = roles[str(target, 'role') ?? ''] ?? 'element'
      const name = str(target, 'name')?.trim()
      return { verb: status === 'error' ? 'Couldn’t click' : verb, payload: name ? `${role} “${truncateQuote(name, 50)}”` : role }
    }
    case 'browser_type': {
      const ref = str(input, 'ref')
      const text = str(input, 'text')
      const refPart = ref ? `[${ref}]` : ''
      const textPart = text ? ` "${truncateQuote(text)}"` : ''
      return { verb, payload: `${refPart}${textPart}`.trim() }
    }
    case 'browser_fill': {
      const fields = input && typeof input === 'object' && 'fields' in input ? input.fields : undefined
      const count = Array.isArray(fields) ? fields.length : 0
      return { verb, payload: count ? `${count} fields` : '' }
    }
    case 'browser_press_key': {
      const key = str(input, 'key')
      return { verb, payload: key ?? '' }
    }
    case 'browser_snapshot': {
      return { verb: status === 'error' ? 'Couldn’t read page' : verb, payload: '' }
    }
    case 'browser_scroll': {
      const dy = num(input, 'dy')
      const ref = str(input, 'ref')
      if (ref) return { verb, payload: `[${ref}]` }
      if (dy !== undefined) return { verb, payload: `${dy > 0 ? '↓' : '↑'} ${Math.abs(dy)}px` }
      return { verb, payload: '' }
    }
    case 'browser_wait': {
      const ms = num(input, 'ms')
      const forLoad = input && typeof input === 'object' && 'forLoad' in input && (input as { forLoad?: unknown }).forLoad
      if (forLoad) return { verb, payload: 'for load' }
      return { verb, payload: ms !== undefined ? `${ms}ms` : '' }
    }
    case 'browser_screenshot': {
      const tabId = num(input, 'tabId')
      return { verb, payload: tabId !== undefined ? `tab ${tabId}` : 'page' }
    }
    case 'browser_tabs': {
      const action = str(input, 'action')
      const url = str(input, 'url')
      if (action === 'create' && url) return { verb, payload: `create ${hostOf(url)}` }
      return { verb, payload: action ?? '' }
    }
    case 'filesystem_view': {
      const path = str(input, 'path')
      const mode = str(input, 'mode')
      return { verb, payload: [mode, path].filter(Boolean).join(' ') }
    }
    case 'filesystem_import_url': {
      return { verb, payload: str(input, 'url') ?? '' }
    }
    case 'sandbox_exec': {
      // The intent IS the label: no code preview and no char count (a char count
      // tells the user nothing). `intent` streams before `code`, so it is usually
      // present from the first frame; fall back to the generic verb when it is
      // not (older transcripts, or args still arriving).
      const intent = normalizeIntent(str(input, 'intent') ?? '')
      if (!intent) return { verb, payload: '' }
      if (status === 'running') return { verb: intent, payload: '' }
      const tail = lowerFirst(intent)
      return { verb: `${status === 'error' ? 'Failed' : 'Ran'} · ${tail}`, payload: '' }
    }
    case 'subagent_spawn': {
      const task = str(input, 'task')
      return { verb, payload: task ? `"${truncateQuote(task, 48)}"` : '' }
    }
    case 'workflow_run': {
      return { verb, payload: str(input, 'title') ?? str(input, 'scriptPath') ?? '' }
    }
    case 'subagent_message': {
      const message = str(input, 'message')
      return { verb, payload: message ? `"${truncateQuote(message, 48)}"` : '' }
    }
    case 'task_status':
    case 'task_wait':
    case 'task_cancel': {
      // People know these by the subagent doing the work, not by the task record.
      const raw = input && typeof input === 'object' && Array.isArray((input as { taskIds?: unknown }).taskIds)
        ? ((input as { taskIds: unknown[] }).taskIds.filter((id): id is string => typeof id === 'string'))
        : [str(input, 'taskId') ?? str(input, 'taskIds')].filter((id): id is string => !!id)
      const ids = raw.map(shortId)
      if (!ids.length) return { verb, payload: 'subagents' }
      return { verb, payload: ids.length > 1 ? `${ids.length} subagents` : `subagent ${ids[0]}` }
    }
    case 'memory_write': {
      // No payload: the input carries the memory bodies, and the default JSON
      // preview would spill them into the row. The MemoryChip shows the titles.
      return { verb, payload: '' }
    }
    default: {
      // Unknown tool: show a compact JSON preview of the input as payload.
      if (input && typeof input === 'object') {
        try {
          const preview = JSON.stringify(input)
          return { verb, payload: preview.length > 48 ? preview.slice(0, 48) + '…' : preview }
        } catch {
          return { verb, payload: '' }
        }
      }
      return { verb, payload: '' }
    }
  }
}

/* ---- Tool-group summaries ------------------------------------------ *
 * A run of consecutive tool calls collapses to a human one-liner like
 * "Read 6 files, ran code ×2, visited a page". Tools bucket into coarse
 * categories; segments keep first-occurrence order.
 * -------------------------------------------------------------------- */

/**
 * Sentinel "tool name" the feed passes for thinking parts inside an activity
 * group, so summaries count them alongside tools ("Thought ×3, ran code ×2").
 */
export const GROUP_THOUGHT = '__thought__'

function groupCategory(toolName: string): string {
  if (toolName === GROUP_THOUGHT) return 'thought'
  switch (toolName) {
    case 'filesystem_view':
      return 'read'
    case 'filesystem_import_url':
      return 'import'
    case 'sandbox_exec':
      return 'code'
    case 'browser_navigate':
      return 'nav'
    case 'browser_click':
    case 'browser_type':
    case 'browser_fill':
    case 'browser_press_key':
    case 'browser_scroll':
      return 'act'
    case 'browser_snapshot':
    case 'browser_screenshot':
      return 'capture'
    case 'browser_wait':
      return 'wait'
    case 'browser_tabs':
      return 'tabs'
    case 'memory_write':
      return 'memory'
    default:
      if (toolName.startsWith('task_')) return 'tasks'
      if (toolName.startsWith('subagent')) return 'agents'
      return 'other'
  }
}

function groupPhrase(category: string, n: number): string {
  switch (category) {
    case 'thought':
      return n === 1 ? 'thought' : `thought ×${n}`
    case 'read':
      return n === 1 ? 'read a file' : `read ${n} files`
    case 'import':
      return n === 1 ? 'imported a file' : `imported ${n} files`
    case 'code':
      return n === 1 ? 'ran code' : `ran code ×${n}`
    case 'nav':
      return n === 1 ? 'visited a page' : `visited ${n} pages`
    case 'act':
      return n === 1 ? '1 page action' : `${n} page actions`
    case 'capture':
      return n === 1 ? 'captured the page' : `captured ${n} snapshots`
    case 'wait':
      return 'waited'
    case 'tabs':
      return 'managed tabs'
    case 'memory':
      return 'saved a memory'
    case 'tasks':
      return 'checked tasks'
    case 'agents':
      return 'messaged subagents'
    default:
      return n === 1 ? '1 tool call' : `${n} tool calls`
  }
}

/** One-liner for a collapsed run of tool calls, e.g. "Read 6 files, ran code ×2". */
export function toolGroupSummary(calls: ReadonlyArray<{ toolName: string }>): string {
  const counts = new Map<string, number>()
  for (const c of calls) {
    const k = groupCategory(c.toolName)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([k, n]) => groupPhrase(k, n))
  let out = parts.slice(0, 3).join(', ')
  if (parts.length > 3) out += `, +${parts.length - 3} more`
  return out.charAt(0).toUpperCase() + out.slice(1)
}
