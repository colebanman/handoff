/**
 * What a step in the activity timeline SAYS: an icon, a label, a detail.
 *
 *   Opened            school.example.edu
 *   Clicked           button “Next question”
 *   Read the syllabus  syllabus.pdf          ← sandbox_exec: intent + receipt
 *
 * - The label is the sentence; the detail is the concrete thing it touched
 *   (host, file, query). The detail is the first thing to truncate.
 * - sandbox_exec's model-written `intent` IS the label, and the code's own
 *   actions (code-actions.ts) supply the detail and the icon. A finished intent
 *   flips to past tense ("Reading the syllabus" → "Read the syllabus"); that
 *   flip is the completion cue, so rows need no "Ran ·" prefix.
 * - A step with nothing informative yet (arguments still arriving, no intent)
 *   is a `placeholder` and says "Thinking", exactly like the pause row it
 *   replaces — the row flips to real content the moment a delta provides it.
 *   "Preparing code · waiting for model" told the user nothing.
 * - Consecutive finished steps of one `family` fold into a single cluster row
 *   ("Clicked 3 elements  “Courses”, “COURSE101”, “Syllabus”").
 */
import type { ToolStatus } from '../shared/types'
import { shortId } from '../shared/ids'
import { redactSecrets } from '../shared/redact'
import { toolResultError } from '../shared/tool-results'
import { fmtDuration } from './format-duration'
import {
  ACTION_RANK,
  codeActions,
  fileTarget,
  hostTarget,
  primaryAction,
  type CodeAction,
  type CodeActionKind,
} from './code-actions'

export type StepState = 'drafting' | 'running' | 'done' | 'error'

export type StepIconName =
  | 'code' | 'globe' | 'pointer' | 'type' | 'keyboard' | 'scroll' | 'clock' | 'eye' | 'camera'
  | 'file' | 'folder' | 'search' | 'history' | 'bookmark' | 'download' | 'tabs' | 'network'
  | 'shield' | 'archive' | 'artifact' | 'alarm' | 'note' | 'box' | 'memory' | 'agent'
  | 'thought' | 'question' | 'reload' | 'tool'

export interface StepView {
  icon: StepIconName
  /** The sentence: an intent, or a verb phrase ("Opened", "Read the page"). */
  label: string
  /** The concrete thing it touched; truncates first. */
  detail?: string
  /** Detail is code-ish (host, path, key) and renders monospace. */
  mono?: boolean
  /** Full, untruncated description for the tooltip. */
  title?: string
  /** Nothing informative has arrived yet: the row reads "Thinking". */
  placeholder?: boolean
  /** Short form of the detail, listed when similar steps fold into one row. */
  target?: string
  /** Consecutive finished steps sharing a family fold into one cluster row. */
  family?: string
  /** The label is the model's streamed intent: it grows per delta, not per phase. */
  fromIntent?: boolean
}

/** The fields of a tool transcript item a step description reads. */
export interface StepSource {
  toolName: string
  status: ToolStatus
  input?: unknown
  output?: unknown
  inputStreaming?: boolean
}

export const THINKING = 'Thinking'

export function stepState(item: StepSource): StepState {
  if (item.status === 'running') return item.inputStreaming ? 'drafting' : 'running'
  if (item.status === 'error' || toolResultError(item.output)) return 'error'
  return 'done'
}

/* ---- small helpers ---------------------------------------------------- */

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

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

function quoted(s: string | undefined, max: number): string | undefined {
  const t = s ? truncate(s, max) : ''
  return t ? `“${t}”` : undefined
}

/** [running, done, failed] phrasing of one verb. */
type Verb = readonly [running: string, done: string, failed: string]

function say(state: StepState, [running, done, failed]: Verb): string {
  return state === 'done' ? done : state === 'error' ? failed : running
}

/** First line of a failed step's error, for its detail slot. */
function errorLine(output: unknown): string | undefined {
  const message = toolResultError(output)?.message ?? (typeof output === 'string' ? output : undefined)
  const line = message?.split('\n').find((l) => l.trim())
  return line ? truncate(redactSecrets(line), 90) : undefined
}

/**
 * Model-written intents are shown verbatim apart from cosmetics: collapse
 * whitespace, drop a trailing period, capitalize the first letter. Only the
 * FIRST character is touched — rewriting the rest would mangle acronyms.
 */
function normalizeIntent(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim().replace(/\.$/, '')
  if (!t) return ''
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/* ---- tense ------------------------------------------------------------ *
 * Intents are present-participle phrases ("Reading the syllabus"). When the
 * step finishes, the leading verb flips to past tense. Regular verbs need no
 * lexicon: dropping "-ing" and adding "-ed" is right for doubled consonants
 * (mapping → mapped, adding → added) and silent e alike (locating → located),
 * so only irregulars and y-verbs are special. Checked against the ~180 distinct
 * leading verbs in 2.5k real intents.
 * ----------------------------------------------------------------------- */

const IRREGULAR_PAST: Record<string, string> = {
  reading: 'read', rereading: 'reread', misreading: 'misread', proofreading: 'proofread',
  finding: 'found', setting: 'set', resetting: 'reset', offsetting: 'offset', upsetting: 'upset',
  building: 'built', rebuilding: 'rebuilt', writing: 'wrote', rewriting: 'rewrote',
  overwriting: 'overwrote', sending: 'sent', resending: 'resent', running: 'ran', rerunning: 'reran',
  bringing: 'brought', choosing: 'chose', keeping: 'kept', getting: 'got', making: 'made',
  remaking: 'remade', taking: 'took', retaking: 'retook', seeing: 'saw', giving: 'gave',
  forgiving: 'forgave', putting: 'put', cutting: 'cut', letting: 'let', holding: 'held',
  leaving: 'left', telling: 'told', thinking: 'thought', rethinking: 'rethought', buying: 'bought',
  paying: 'paid', saying: 'said', laying: 'laid', spending: 'spent', understanding: 'understood',
  doing: 'did', redoing: 'redid', undoing: 'undid', going: 'went', coming: 'came',
  becoming: 'became', drawing: 'drew', redrawing: 'redrew', beginning: 'began', splitting: 'split',
  hitting: 'hit', spinning: 'spun', winning: 'won', sitting: 'sat', standing: 'stood',
  feeling: 'felt', meeting: 'met', selling: 'sold', teaching: 'taught', catching: 'caught',
  seeking: 'sought', fighting: 'fought', sleeping: 'slept', sweeping: 'swept', feeding: 'fed',
  leading: 'led', speaking: 'spoke', breaking: 'broke', freezing: 'froze', hiding: 'hid',
  riding: 'rode', overriding: 'overrode', driving: 'drove', rising: 'rose', shaking: 'shook',
  waking: 'woke', wearing: 'wore', tearing: 'tore', throwing: 'threw', growing: 'grew',
  knowing: 'knew', blowing: 'blew', flying: 'flew', hanging: 'hung', sticking: 'stuck',
  striking: 'struck', digging: 'dug', swinging: 'swung', ringing: 'rang', singing: 'sang',
  sinking: 'sank', drinking: 'drank', shrinking: 'shrank', forgetting: 'forgot',
  outputting: 'output', inputting: 'input', broadcasting: 'broadcast', forecasting: 'forecast',
  casting: 'cast', spreading: 'spread', shedding: 'shed', bidding: 'bid', quitting: 'quit',
  lighting: 'lit', binding: 'bound', rebinding: 'rebound', grinding: 'ground', winding: 'wound',
  lending: 'lent', bending: 'bent', shutting: 'shut', dealing: 'dealt', meaning: 'meant',
  hearing: 'heard', stealing: 'stole', losing: 'lost', shooting: 'shot', sliding: 'slid',
  fleeing: 'fled', swimming: 'swam', mistaking: 'mistook', withdrawing: 'withdrew',
}

/** Leading "-ing" words that are nouns or adjectives, not the step's verb. */
const NOT_A_VERB = new Set([
  'being', 'morning', 'evening', 'nothing', 'something', 'everything', 'anything', 'during',
  'ceiling', 'wedding', 'pudding', 'clothing', 'heading', 'earring', 'sibling', 'lightning',
  'housing', 'billing', 'shipping', 'pricing', 'parking', 'banking', 'marketing', 'training',
  'timing', 'awning', 'pending', 'missing', 'remaining', 'upcoming', 'existing', 'outstanding',
  'incoming', 'trending', 'interesting', 'amazing', 'boring', 'ongoing',
])

function matchCase(original: string, word: string): string {
  if (original === original.toUpperCase() && original.length > 1) return word.toUpperCase()
  return original[0] === original[0]!.toUpperCase() ? word[0]!.toUpperCase() + word.slice(1) : word
}

function pastOfWord(word: string): string | undefined {
  // "Cross-checking" → "Cross-checked": only the last segment is the verb.
  const dash = word.lastIndexOf('-')
  if (dash > 0) {
    const tail = pastOfWord(word.slice(dash + 1))
    return tail ? `${word.slice(0, dash + 1)}${tail}` : undefined
  }
  const lower = word.toLowerCase()
  if (lower.length < 5 || !lower.endsWith('ing') || NOT_A_VERB.has(lower)) return undefined
  const irregular = IRREGULAR_PAST[lower]
  if (irregular) return matchCase(word, irregular)
  const stem = lower.slice(0, -3)
  // "String", "Bring": no vowel before "-ing" means the word isn't a participle.
  if (!/[aeiouy]/.test(stem)) return undefined
  const past = /[^aeiou]y$/.test(stem) ? `${stem.slice(0, -1)}ied` : stem.endsWith('e') ? `${stem}d` : `${stem}ed`
  return matchCase(word, past)
}

/**
 * "Reading the syllabus" → "Read the syllabus". Anything it can't flip
 * confidently — a compound ("Reading X and saving Y"), a leading word that
 * isn't a participle — comes back unchanged: a finished step reading
 * "Reading X" is merely present tense, a mangled one looks broken.
 */
export function pastTense(phrase: string): string {
  const m = /^(\S+)(.*)$/s.exec(phrase)
  if (!m) return phrase
  const [, first, rest] = m
  // A second participle after "and"/","/"then" means two verbs; flipping only
  // the first would read "Read the file and listing tabs".
  if (/(?:\band|\bthen|,)\s+\S+ing\b/i.test(rest!)) return phrase
  const past = pastOfWord(first!)
  return past ? past + rest : phrase
}

/* ---- sandbox_exec ----------------------------------------------------- */

/** Icon for each code action: what the step "looks like" once done. */
const ACTION_ICON: Record<CodeActionKind, StepIconName> = {
  navigate: 'globe', fetch: 'globe', send: 'globe', click: 'pointer', type: 'type', key: 'keyboard',
  fill: 'type', select: 'pointer', submit: 'pointer', scroll: 'scroll', 'read-page': 'eye',
  script: 'code', screenshot: 'camera', reload: 'reload', back: 'reload', viewport: 'artifact',
  'read-file': 'file', 'write-file': 'file', 'list-files': 'folder', 'search-files': 'search',
  import: 'download', attach: 'file', history: 'history', bookmarks: 'bookmark',
  downloads: 'download', 'tabs-list': 'tabs', 'tabs-open': 'tabs', 'tabs-close': 'tabs',
  'tabs-switch': 'tabs', 'tabs-group': 'tabs', network: 'network', cookies: 'shield',
  'clear-data': 'shield', pdf: 'file', 'print-pdf': 'file', zip: 'archive',
  'artifact-build': 'artifact', 'artifact-check': 'artifact', 'artifact-open': 'artifact',
  automation: 'alarm', sticky: 'note', app: 'box', extension: 'box', library: 'box', wait: 'clock',
}

/**
 * How a code action reads as a whole row, for calls without an intent:
 * `withTarget` precedes the target ("Fetched  canvas.edu"), `bare` stands alone.
 */
const ACTION_VERBS: Record<CodeActionKind, { withTarget?: Verb; bare: Verb }> = {
  navigate: { withTarget: ['Opening', 'Opened', 'Couldn’t open'], bare: ['Opening a page', 'Opened a page', 'Couldn’t open a page'] },
  fetch: { withTarget: ['Fetching', 'Fetched', 'Couldn’t fetch'], bare: ['Fetching data', 'Fetched data', 'Couldn’t fetch data'] },
  send: { withTarget: ['Sending a request to', 'Sent a request to', 'Couldn’t send a request to'], bare: ['Sending a request', 'Sent a request', 'Couldn’t send a request'] },
  click: { withTarget: ['Clicking', 'Clicked', 'Couldn’t click'], bare: ['Clicking in the page', 'Clicked in the page', 'Couldn’t click in the page'] },
  type: { withTarget: ['Typing', 'Typed', 'Couldn’t type'], bare: ['Typing into the page', 'Typed into the page', 'Couldn’t type into the page'] },
  key: { withTarget: ['Pressing', 'Pressed', 'Couldn’t press'], bare: ['Pressing a key', 'Pressed a key', 'Couldn’t press a key'] },
  fill: { withTarget: ['Filling', 'Filled', 'Couldn’t fill'], bare: ['Filling a form', 'Filled a form', 'Couldn’t fill a form'] },
  select: { withTarget: ['Selecting', 'Selected', 'Couldn’t select'], bare: ['Selecting an option', 'Selected an option', 'Couldn’t select an option'] },
  submit: { bare: ['Submitting a form', 'Submitted a form', 'Couldn’t submit a form'] },
  scroll: { bare: ['Scrolling the page', 'Scrolled the page', 'Couldn’t scroll the page'] },
  'read-page': { bare: ['Reading the page', 'Read the page', 'Couldn’t read the page'] },
  script: { bare: ['Running a page script', 'Ran a page script', 'Page script failed'] },
  screenshot: { bare: ['Taking a screenshot', 'Took a screenshot', 'Couldn’t take a screenshot'] },
  reload: { bare: ['Reloading the page', 'Reloaded the page', 'Couldn’t reload the page'] },
  back: { bare: ['Going back', 'Went back', 'Couldn’t go back'] },
  viewport: { bare: ['Resizing the viewport', 'Resized the viewport', 'Couldn’t resize the viewport'] },
  'read-file': { withTarget: ['Reading', 'Read', 'Couldn’t read'], bare: ['Reading a file', 'Read a file', 'Couldn’t read a file'] },
  'write-file': { withTarget: ['Saving', 'Saved', 'Couldn’t save'], bare: ['Saving a file', 'Saved a file', 'Couldn’t save a file'] },
  'list-files': { withTarget: ['Listing', 'Listed', 'Couldn’t list'], bare: ['Listing files', 'Listed files', 'Couldn’t list files'] },
  'search-files': { withTarget: ['Searching files for', 'Searched files for', 'Couldn’t search files for'], bare: ['Searching files', 'Searched files', 'Couldn’t search files'] },
  import: { withTarget: ['Importing from', 'Imported from', 'Couldn’t import from'], bare: ['Importing a file', 'Imported a file', 'Couldn’t import a file'] },
  attach: { withTarget: ['Attaching', 'Attached', 'Couldn’t attach'], bare: ['Attaching a file', 'Attached a file', 'Couldn’t attach a file'] },
  history: { withTarget: ['Searching history for', 'Searched history for', 'Couldn’t search history for'], bare: ['Checking history', 'Checked history', 'Couldn’t check history'] },
  bookmarks: { withTarget: ['Searching bookmarks for', 'Searched bookmarks for', 'Couldn’t search bookmarks for'], bare: ['Checking bookmarks', 'Checked bookmarks', 'Couldn’t check bookmarks'] },
  downloads: { bare: ['Checking downloads', 'Checked downloads', 'Couldn’t check downloads'] },
  'tabs-list': { bare: ['Listing tabs', 'Listed tabs', 'Couldn’t list tabs'] },
  'tabs-open': { withTarget: ['Opening', 'Opened', 'Couldn’t open'], bare: ['Opening a tab', 'Opened a tab', 'Couldn’t open a tab'] },
  'tabs-close': { bare: ['Closing tabs', 'Closed tabs', 'Couldn’t close tabs'] },
  'tabs-switch': { bare: ['Switching tabs', 'Switched tabs', 'Couldn’t switch tabs'] },
  'tabs-group': { withTarget: ['Grouping tabs into', 'Grouped tabs into', 'Couldn’t group tabs into'], bare: ['Organizing tabs', 'Organized tabs', 'Couldn’t organize tabs'] },
  network: { bare: ['Inspecting network traffic', 'Inspected network traffic', 'Couldn’t inspect network traffic'] },
  cookies: { bare: ['Reading cookies', 'Read cookies', 'Couldn’t read cookies'] },
  'clear-data': { bare: ['Clearing site data', 'Cleared site data', 'Couldn’t clear site data'] },
  pdf: { bare: ['Building a PDF', 'Built a PDF', 'Couldn’t build a PDF'] },
  'print-pdf': { bare: ['Saving the page as PDF', 'Saved the page as PDF', 'Couldn’t save the page as PDF'] },
  zip: { bare: ['Reading an archive', 'Read an archive', 'Couldn’t read an archive'] },
  'artifact-build': { withTarget: ['Building', 'Built', 'Couldn’t build'], bare: ['Building an artifact', 'Built an artifact', 'Couldn’t build an artifact'] },
  'artifact-check': { withTarget: ['Checking', 'Checked', 'Couldn’t check'], bare: ['Checking an artifact', 'Checked an artifact', 'Couldn’t check an artifact'] },
  'artifact-open': { withTarget: ['Opening', 'Opened', 'Couldn’t open'], bare: ['Opening an artifact', 'Opened an artifact', 'Couldn’t open an artifact'] },
  automation: { withTarget: ['Scheduling', 'Scheduled', 'Couldn’t schedule'], bare: ['Updating automations', 'Updated automations', 'Couldn’t update automations'] },
  sticky: { withTarget: ['Updating sticky', 'Updated sticky', 'Couldn’t update sticky'], bare: ['Updating a sticky', 'Updated a sticky', 'Couldn’t update a sticky'] },
  app: { withTarget: ['Using', 'Used', 'Couldn’t use'], bare: ['Using an app', 'Used an app', 'Couldn’t use an app'] },
  extension: { bare: ['Updating a saved function', 'Updated a saved function', 'Couldn’t update a saved function'] },
  library: { withTarget: ['Loading a library from', 'Loaded a library from', 'Couldn’t load a library from'], bare: ['Loading a library', 'Loaded a library', 'Couldn’t load a library'] },
  wait: { bare: ['Waiting', 'Waited', 'Stopped waiting'] },
}

/** Targets worth listing, strongest action first, each named once. */
function actionTargets(actions: readonly CodeAction[], skipIn = ''): { targets: string[]; full: string[] } {
  const ranked = actions
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.target)
    .sort((x, y) => ACTION_RANK[y.a.kind] - ACTION_RANK[x.a.kind] || x.i - y.i)
  const skip = skipIn.toLowerCase()
  const seen = new Set<string>()
  const targets: string[] = []
  const full: string[] = []
  for (const { a } of ranked) {
    const t = a.target!
    const plain = t.replace(/[“”]/g, '').toLowerCase()
    // The intent already names it ("Reading syllabus.pdf" + "syllabus.pdf").
    if (seen.has(t) || (skip && skip.includes(plain))) continue
    seen.add(t)
    targets.push(t)
    full.push(a.full ?? t)
  }
  return { targets, full }
}

function listTargets(targets: readonly string[], max = 2): string | undefined {
  if (targets.length === 0) return undefined
  const shown = targets.slice(0, max).join(', ')
  return targets.length > max ? `${shown} +${targets.length - max}` : shown
}

function describeCode(input: unknown, state: StepState, output: unknown): StepView {
  const intent = normalizeIntent(str(input, 'intent') ?? '')
  const actions = codeActions(str(input, 'code') ?? '')
  const primary = primaryAction(actions)
  const icon = primary ? ACTION_ICON[primary.kind] : 'code'
  const failure = state === 'error' ? errorLine(output) : undefined

  if (intent) {
    const { targets, full } = actionTargets(actions, intent)
    const detail = failure ?? listTargets(targets)
    return {
      icon,
      label: state === 'done' ? pastTense(intent) : intent,
      detail,
      mono: !failure && !!detail,
      title: [intent, ...full].join('\n'),
      fromIntent: true,
    }
  }

  if (primary) {
    const verbs = ACTION_VERBS[primary.kind]
    const { targets, full } = actionTargets(actions)
    const named = !!primary.target && !!verbs.withTarget
    // With a target the verb leads and the targets follow; bare, the verb
    // phrase stands alone and any other targets become the receipt.
    const rest = named ? [primary.target!, ...targets.filter((t) => t !== primary.target)] : targets
    const detail = failure ?? listTargets(rest)
    return {
      icon,
      label: say(state, named ? verbs.withTarget! : verbs.bare),
      detail,
      mono: !failure && !!detail && primary.kind !== 'type' && primary.kind !== 'click',
      title: full.length ? full.join('\n') : undefined,
      target: primary.target,
      family: `code:${primary.kind}`,
    }
  }

  if (state === 'drafting') return { icon: 'code', label: THINKING, placeholder: true }
  return { icon: 'code', label: say(state, ['Running code', 'Ran code', 'Code failed']), detail: failure }
}

/* ---- every other tool ------------------------------------------------- */

const CLICK_ROLES: Record<string, string> = {
  button: 'button', link: 'link', checkbox: 'checkbox', radio: 'option', menuitem: 'menu item', tab: 'tab',
  textbox: 'text field', searchbox: 'search field', combobox: 'dropdown', switch: 'switch', option: 'option',
}

/** The subagents a task_* call is about: people know them by agent, not task record. */
function subagentPhrase(input: unknown): string {
  const raw = input && typeof input === 'object' && Array.isArray((input as { taskIds?: unknown }).taskIds)
    ? (input as { taskIds: unknown[] }).taskIds.filter((id): id is string => typeof id === 'string')
    : [str(input, 'taskId') ?? str(input, 'taskIds')].filter((id): id is string => !!id)
  const ids = raw.map(shortId)
  if (!ids.length) return 'subagents'
  return ids.length > 1 ? `${ids.length} subagents` : `subagent ${ids[0]}`
}

function titleCase(toolName: string): string {
  return toolName
    .split('_')
    .map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** Describe one tool call for its timeline row. */
export function describeStep(item: StepSource, state: StepState = stepState(item)): StepView {
  const { input } = item
  const failure = state === 'error' ? errorLine(item.output) : undefined
  switch (item.toolName) {
    case 'sandbox_exec':
      return describeCode(input, state, item.output)
    case 'browser_navigate': {
      const url = str(input, 'url')
      const { target } = hostTarget(url)
      return { icon: 'globe', label: say(state, ['Opening', 'Opened', 'Couldn’t open']), detail: target, mono: true, title: url, target, family: 'visit' }
    }
    case 'browser_click': {
      const t = input && typeof input === 'object' && '__target' in input ? (input as { __target?: unknown }).__target : undefined
      const role = CLICK_ROLES[str(t, 'role') ?? ''] ?? 'element'
      const name = str(t, 'name')?.trim()
      return {
        icon: 'pointer',
        label: say(state, ['Clicking', 'Clicked', 'Couldn’t click']),
        detail: name ? `${role} ${quoted(name, 48)}` : role,
        title: name,
        target: quoted(name, 24),
        family: 'click',
      }
    }
    case 'browser_type': {
      const text = redactSecrets(str(input, 'text') ?? '')
      return { icon: 'type', label: say(state, ['Typing', 'Typed', 'Couldn’t type']), detail: quoted(text, 40), target: quoted(text, 20), family: 'type' }
    }
    case 'browser_fill': {
      const fields = input && typeof input === 'object' && 'fields' in input ? (input as { fields?: unknown }).fields : undefined
      const n = Array.isArray(fields) ? fields.length : 0
      return { icon: 'type', label: say(state, ['Filling', 'Filled', 'Couldn’t fill']), detail: n ? `${n} field${n === 1 ? '' : 's'}` : 'a form', family: 'fill' }
    }
    case 'browser_press_key': {
      const key = str(input, 'key')
      return { icon: 'keyboard', label: say(state, ['Pressing', 'Pressed', 'Couldn’t press']), detail: key, mono: true, target: key, family: 'key' }
    }
    case 'browser_snapshot':
      return { icon: 'eye', label: say(state, ['Reading the page', 'Read the page', 'Couldn’t read the page']), detail: failure, family: 'look' }
    case 'browser_screenshot':
      return { icon: 'camera', label: say(state, ['Taking a screenshot', 'Took a screenshot', 'Couldn’t take a screenshot']), detail: failure, family: 'shot' }
    case 'browser_scroll': {
      const dy = num(input, 'dy')
      const detail = str(input, 'ref') ? 'to an element' : dy !== undefined ? `${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px` : undefined
      return { icon: 'scroll', label: say(state, ['Scrolling', 'Scrolled', 'Couldn’t scroll']), detail, family: 'scroll' }
    }
    case 'browser_wait': {
      const forLoad = input && typeof input === 'object' && (input as { forLoad?: unknown }).forLoad
      if (forLoad) return { icon: 'clock', label: say(state, ['Waiting for the page', 'Waited for the page', 'Stopped waiting for the page']), family: 'wait' }
      const ms = num(input, 'ms')
      return { icon: 'clock', label: say(state, ['Waiting', 'Waited', 'Stopped waiting']), detail: ms !== undefined ? fmtDuration(ms) : undefined, family: 'wait' }
    }
    case 'browser_tabs': {
      const action = str(input, 'action')
      if (action === 'create') {
        const url = str(input, 'url')
        const { target } = hostTarget(url)
        return { icon: 'tabs', label: say(state, target ? ['Opening', 'Opened', 'Couldn’t open'] : ['Opening a tab', 'Opened a tab', 'Couldn’t open a tab']), detail: target, mono: true, title: url, target, family: 'tabs' }
      }
      const verb: Verb =
        action === 'list' ? ['Listing tabs', 'Listed tabs', 'Couldn’t list tabs']
        : action === 'activate' ? ['Switching tabs', 'Switched tabs', 'Couldn’t switch tabs']
        : action === 'close' ? ['Closing a tab', 'Closed a tab', 'Couldn’t close a tab']
        : ['Updating tabs', 'Updated tabs', 'Couldn’t update tabs']
      return { icon: 'tabs', label: say(state, verb), detail: failure, family: 'tabs' }
    }
    case 'filesystem_view': {
      const path = str(input, 'path')
      const name = path?.split('/').filter(Boolean).pop()
      return { icon: 'file', label: say(state, ['Viewing', 'Viewed', 'Couldn’t view']), detail: name, mono: true, title: path, target: name, family: 'view' }
    }
    case 'filesystem_import_url': {
      const url = str(input, 'url')
      const target = hostTarget(url).target ?? fileTarget(url).target
      return { icon: 'download', label: say(state, ['Importing', 'Imported', 'Couldn’t import']), detail: target, mono: true, title: url, target, family: 'import' }
    }
    case 'memory_write':
      // No detail: the input carries the memory bodies; the MemoryChip names them.
      return { icon: 'memory', label: say(state, ['Saving to memory', 'Saved to memory', 'Couldn’t save to memory']), family: 'memory' }
    case 'subagent_message': {
      const message = str(input, 'message')
      return { icon: 'agent', label: say(state, ['Messaging a subagent', 'Messaged a subagent', 'Couldn’t message a subagent']), detail: quoted(message, 48), family: 'steer' }
    }
    case 'task_status':
      return { icon: 'agent', label: say(state, ['Checking on', 'Checked on', 'Couldn’t check on']), detail: subagentPhrase(input), family: 'tasks' }
    case 'task_wait':
      return { icon: 'agent', label: say(state, ['Waiting on', 'Waited on', 'Stopped waiting on']), detail: subagentPhrase(input), family: 'tasks' }
    case 'task_cancel':
      return { icon: 'agent', label: say(state, ['Cancelling', 'Cancelled', 'Couldn’t cancel']), detail: subagentPhrase(input), family: 'tasks' }
    case 'ask_user':
      return { icon: 'question', label: say(state, ['Asking you', 'Asked you', 'Couldn’t ask you']), detail: quoted(str(input, 'question'), 60) }
    case 'subagent_spawn':
      return { icon: 'agent', label: say(state, ['Delegating', 'Delegated', 'Couldn’t delegate']), detail: quoted(str(input, 'task'), 48) }
    case 'workflow_run':
      return { icon: 'agent', label: say(state, ['Running workflow', 'Ran workflow', 'Workflow failed']), detail: str(input, 'title') ?? str(input, 'scriptPath') }
    default: {
      // Unknown tool: never a raw snake_case name; a compact JSON preview as detail.
      let detail: string | undefined
      if (input && typeof input === 'object') {
        try {
          const preview = JSON.stringify(input)
          detail = preview.length > 48 ? `${preview.slice(0, 48)}…` : preview
        } catch {
          detail = undefined
        }
      }
      return { icon: 'tool', label: item.toolName ? titleCase(item.toolName) : THINKING, placeholder: !item.toolName, detail: failure ?? detail, mono: !failure }
    }
  }
}

/* ---- clusters --------------------------------------------------------- */

/** Nouns for folded runs of code steps that carry no intent. */
const CODE_CLUSTER: Partial<Record<CodeActionKind, (n: number) => string>> = {
  fetch: (n) => `Fetched ${n} URLs`,
  'read-file': (n) => `Read ${n} files`,
  'write-file': (n) => `Saved ${n} files`,
  'read-page': (n) => `Read the page ${n} times`,
  click: (n) => `Clicked ${n} times`,
  type: (n) => `Typed ${n} times`,
  navigate: (n) => `Opened ${n} pages`,
  history: (n) => `Searched history ${n} times`,
  'search-files': (n) => `Searched files ${n} times`,
  script: (n) => `Ran ${n} page scripts`,
}

/**
 * One label for a run of finished steps of the same family, e.g. "Clicked 3
 * elements" — the reference pattern "Ran 2 searches", folded to one row.
 */
export function clusterLabel(family: string, sources: readonly StepSource[]): string {
  const n = sources.length
  const tools = new Set(sources.map((s) => s.toolName))
  switch (family) {
    case 'visit': return `Opened ${n} pages`
    case 'click': return `Clicked ${n} elements`
    case 'type': return `Typed into ${n} fields`
    case 'fill': return `Filled ${n} forms`
    case 'key': return `Pressed ${n} keys`
    case 'look': return `Read the page ${n} times`
    case 'shot': return `Took ${n} screenshots`
    case 'scroll': return `Scrolled ${n} times`
    case 'wait': return `Waited ${n} times`
    case 'view': return `Viewed ${n} files`
    case 'import': return `Imported ${n} files`
    case 'memory': return `Saved ${n} memories`
    case 'steer': return `Messaged subagents ${n} times`
    case 'tasks':
      if (tools.size === 1 && tools.has('task_wait')) return `Waited on subagents ${n} times`
      if (tools.size === 1 && tools.has('task_cancel')) return `Cancelled subagents ${n} times`
      return `Checked on subagents ${n} times`
    case 'tabs': {
      const actions = new Set(sources.map((s) => str(s.input, 'action')))
      if (actions.size === 1 && actions.has('create')) return `Opened ${n} tabs`
      if (actions.size === 1 && actions.has('close')) return `Closed ${n} tabs`
      return `Managed tabs ${n} times`
    }
  }
  if (family.startsWith('code:')) {
    const phrase = CODE_CLUSTER[family.slice(5) as CodeActionKind]
    return phrase ? phrase(n) : `Ran ${n} scripts`
  }
  return `${n} steps`
}

/** The cluster row's detail: each child's target, once, in order. */
export function clusterDetail(views: readonly StepView[], max = 3): string | undefined {
  const seen = new Set<string>()
  const targets: string[] = []
  for (const v of views) {
    const t = v.target ?? v.detail
    if (!t || seen.has(t)) continue
    seen.add(t)
    targets.push(t)
  }
  return listTargets(targets, max)
}

/* ---- thoughts --------------------------------------------------------- */

/**
 * Clean a reasoning summary for a one-line label: PAIRED emphasis/code
 * markers stripped (a global [*_`] delete would corrupt snake_case
 * identifiers), a trailing period dropped, casing left as the model wrote it.
 */
function cleanSummary(text: string): string {
  let t = plainSummary(text)
  if (t.endsWith('.')) t = t.slice(0, -1).trimEnd()
  return t
}

function plainSummary(text: string): string {
  return redactSecrets(text)
    .replace(/\[([^\]]+)\]\([^\s)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' })
const SUMMARY_LABEL_LIMIT = 90

/** Only standalone headings are titles. Bold numbers/prose and code are not. */
function thoughtHeadlines(text: string): Array<{ title: string; line: number }> {
  const headlines: Array<{ title: string; line: number }> = []
  let fence: { marker: string; length: number } | undefined
  for (const [index, line] of text.split('\n').entries()) {
    const boundary = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (boundary) {
      const marker = boundary[1]!
      if (!fence) fence = { marker: marker[0]!, length: marker.length }
      else if (fence.marker === marker[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence) continue
    const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line)
      ?? /^\s*(?:\*\*([^*\n]+?)\*\*|__([^_\n]+?)__)\s*$/.exec(line)
    const title = heading?.[1] ?? heading?.[2]
    // A paragraph that happens to be bold is still prose, not a concise title.
    if (title && cleanSummary(title).length <= SUMMARY_LABEL_LIMIT) headlines.push({ title, line: index })
  }
  return headlines
}

/** Prose-only summaries need room while live; explicit headline summaries
 * already have a compact progress display. Also works for saved transcripts. */
export function isVerboseReasoning(text: string): boolean {
  return plainSummary(text).length > SUMMARY_LABEL_LIMIT && thoughtHeadlines(text).length === 0
}

/** A growing heading is one phase; only a new heading/sentence should crossfade. */
export function thoughtLabelKey(text: string, label: string): string {
  const heading = thoughtHeadlines(text.trim()).at(-1)
  return heading ? `heading:${heading.line}` : `thought:${label}`
}

/**
 * The one line a thought row shows. Summaries with bold headlines (OpenAI)
 * show the LATEST headline — while streaming that's the current topic, and it
 * stays put when the thought ends, so the row doesn't jump at completion.
 * Plain prose uses its latest complete sentence only when that sentence fits
 * a compact label. Verbose paragraphs use a neutral disclosure title instead
 * of an arbitrary clipped fragment. Unicode sentence boundaries preserve
 * decimals (1.5–2x), versions, filenames, and URLs.
 */
export function thoughtLabel(text: string, streaming: boolean, durationMs?: number): { label: string; placeholder: boolean; more: boolean } {
  const trimmed = text.trim()
  if (!trimmed) {
    if (streaming) return { label: THINKING, placeholder: true, more: false }
    return { label: durationMs ? `Thought for ${fmtDuration(durationMs)}` : 'Thought', placeholder: false, more: false }
  }
  const plain = plainSummary(trimmed)
  const flat = plain.replace(/\.$/, '').trimEnd()
  const headlines = thoughtHeadlines(trimmed)
  if (headlines.length) {
    const label = cleanSummary(headlines[headlines.length - 1]!.title)
    return { label, placeholder: false, more: trimmed.includes('\n') && flat !== label }
  }
  if (!streaming && flat.length <= SUMMARY_LABEL_LIMIT && !trimmed.includes('\n')) return { label: flat, placeholder: false, more: false }
  // Complete sentences only while streaming: a half-written one would flicker.
  const sentences = [...SENTENCES.segment(plain)]
    .map((s) => s.segment.trim())
    .filter(Boolean)
  const complete = streaming && !/[.!?。！？…]["”’')\]]*\s*$/.test(plain) ? sentences.slice(0, -1) : sentences
  const last = complete.at(-1)
  if (!last || cleanSummary(last).length > SUMMARY_LABEL_LIMIT) {
    return { label: streaming ? THINKING : 'Reasoning summary', placeholder: streaming, more: true }
  }
  const label = cleanSummary(last)
  return { label, placeholder: false, more: flat !== label }
}
