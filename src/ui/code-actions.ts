/**
 * Code → actions: a static read of a sandbox_exec snippet that names what the
 * code actually touches ("school.example.edu", "syllabus.pdf", "clicked in
 * the page"), so a code step can say more than "Ran code".
 *
 * The model's `intent` stays the headline; these actions are the receipt beside
 * it, and they become the headline for calls that carry no intent (older
 * transcripts, or a model that skipped it). They also pick the step's icon.
 *
 * Built for STREAMING input: the row re-reads the snippet as it arrives, and
 * only complete literals count, so a half-typed URL never shows. An api call
 * whose arguments are still arriving still counts (its kind is known from the
 * name alone), which is what lets a code row pick up "fetch" or "click" while
 * the model is still writing it.
 *
 * A scanner, not a parser. ~6.5k real snippets are dominated by a few shapes
 * (api.cdp Runtime.evaluate / Input.*, api.page.eval, api.fetch,
 * api.fs.readText), and a bracket walk that skips string, template, comment and
 * regex literals reads all of them. Anything it can't resolve stays unnamed
 * rather than guessed.
 */

export type CodeActionKind =
  | 'navigate' | 'fetch' | 'send' | 'click' | 'type' | 'key' | 'fill' | 'select' | 'submit'
  | 'scroll' | 'read-page' | 'script' | 'screenshot' | 'reload' | 'back' | 'viewport'
  | 'read-file' | 'write-file' | 'list-files' | 'search-files' | 'import' | 'attach'
  | 'history' | 'bookmarks' | 'downloads'
  | 'tabs-list' | 'tabs-open' | 'tabs-close' | 'tabs-switch' | 'tabs-group'
  | 'network' | 'cookies' | 'clear-data' | 'pdf' | 'print-pdf' | 'zip'
  | 'artifact-build' | 'artifact-check' | 'artifact-open'
  | 'automation' | 'sticky' | 'app' | 'extension' | 'library' | 'wait'

export interface CodeAction {
  kind: CodeActionKind
  /** What it acted on, display-ready: a host, a file name, a quoted query. */
  target?: string
  /** Long form of the target (whole URL / path) for tooltips. */
  full?: string
}

/**
 * How much an action says about what the snippet DID: mutations outrank
 * reads, reads outrank plumbing. The top-ranked action names a step that has
 * no intent and picks every code step's icon.
 */
export const ACTION_RANK: Record<CodeActionKind, number> = {
  navigate: 90, 'tabs-open': 86, submit: 84, click: 82, type: 80, fill: 80, select: 79, key: 78,
  attach: 77, send: 72, 'write-file': 70, 'artifact-build': 69, automation: 68, sticky: 67,
  app: 66, extension: 65, 'clear-data': 64, 'tabs-close': 62, 'tabs-group': 60, 'tabs-switch': 59,
  import: 58, fetch: 56, 'print-pdf': 55, pdf: 54, zip: 53, history: 52, bookmarks: 51,
  'search-files': 50, downloads: 49, 'read-file': 47, 'artifact-open': 46, 'artifact-check': 45,
  'list-files': 42, screenshot: 40, network: 38, cookies: 37, reload: 36, back: 36, viewport: 34,
  scroll: 32, 'read-page': 26, 'tabs-list': 24, library: 20, script: 12, wait: 4,
}

/** Past this, the snippet is mostly inline data (an essay being typed, a
 * base64 blob); the calls that matter sit in the first few kilobytes. */
const MAX_SCAN = 80_000
const MAX_CALLS = 200

/* ---- scanner ---------------------------------------------------------- */

/** Characters after which a `/` opens a regex literal rather than dividing. */
const REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''))

function isSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9
}

/** Index just past the string/template literal opening at `i`, or -1 if it never closes. */
function skipLiteral(src: string, i: number): number {
  const quote = src.charCodeAt(i)
  let j = i + 1
  while (j < src.length) {
    const c = src.charCodeAt(j)
    if (c === 92 /* \ */) {
      j += 2
      continue
    }
    if (c === quote) return j + 1
    if (quote === 96 /* ` */ && c === 36 /* $ */ && src.charCodeAt(j + 1) === 123 /* { */) {
      const close = boundary(src, j + 2, false)
      if (close < 0) return -1
      j = close + 1
      continue
    }
    // A quote string can't span lines; one that tries is still streaming.
    if (quote !== 96 && c === 10) return -1
    j++
  }
  return -1
}

/** Index just past the regex literal opening at `i`; `i + 1` when it is really a division. */
function skipRegex(src: string, i: number): number {
  let inClass = false
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]!
    if (c === '\\') {
      j++
      continue
    }
    if (c === '\n') return i + 1
    if (inClass) {
      if (c === ']') inClass = false
    } else if (c === '[') inClass = true
    else if (c === '/') return j + 1
  }
  return i + 1
}

/**
 * Walk from `i` to the first `,` at bracket depth 0 (when `stopAtComma`) or the
 * bracket that closes the enclosing run. String, template, comment and regex
 * literals are skipped whole. Returns that index, or -1 when the input ends
 * first — a snippet that is still streaming in.
 */
function boundary(src: string, i: number, stopAtComma: boolean): number {
  let depth = 0
  let prev = '('
  for (let j = i; j < src.length; j++) {
    const ch = src[j]!
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipLiteral(src, j)
      if (end < 0) return -1
      j = end - 1
      prev = 'a'
      continue
    }
    if (ch === '/') {
      const next = src[j + 1]
      if (next === '/') {
        const nl = src.indexOf('\n', j)
        if (nl < 0) return -1
        j = nl
        continue
      }
      if (next === '*') {
        const end = src.indexOf('*/', j + 2)
        if (end < 0) return -1
        j = end + 1
        continue
      }
      if (REGEX_PREV.has(prev)) {
        j = skipRegex(src, j) - 1
        prev = 'a'
        continue
      }
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return j
      depth--
    } else if (ch === ',' && depth === 0 && stopAtComma) return j
    if (!isSpace(src.charCodeAt(j))) prev = ch
  }
  return -1
}

type Arg =
  | { type: 'string'; value: string }
  /** A template with `${}` holes: static text kept, each hole shown as "…". */
  | { type: 'template'; value: string }
  | { type: 'object'; text: string }
  | { type: 'array'; text: string }
  | { type: 'ident'; name: string }
  /** An argument still streaming in (its closing quote/bracket hasn't arrived). */
  | { type: 'partial'; text: string }
  | { type: 'other'; text: string }

function unescape(body: string): string {
  return body.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
}

/** A complete template's static text with every `${}` hole replaced by "…". */
function templateStatic(body: string): string {
  let out = ''
  let i = 0
  while (i < body.length) {
    const hole = body.indexOf('${', i)
    if (hole < 0) {
      out += body.slice(i)
      break
    }
    out += body.slice(i, hole) + '…'
    const close = boundary(body, hole + 2, false)
    if (close < 0) break
    i = close + 1
  }
  return unescape(out)
}

function classify(raw: string, complete: boolean): Arg {
  const c = raw[0]
  if (c === '"' || c === "'" || c === '`') {
    const end = skipLiteral(raw, 0)
    if (end !== raw.length) return { type: 'partial', text: raw.slice(1) }
    const body = raw.slice(1, -1)
    if (c === '`' && body.includes('${')) return { type: 'template', value: templateStatic(body) }
    return { type: 'string', value: unescape(body) }
  }
  if (!complete) return { type: 'partial', text: raw }
  if (c === '{') return { type: 'object', text: raw }
  if (c === '[') return { type: 'array', text: raw }
  if (/^[A-Za-z_$][\w$]*$/.test(raw)) return { type: 'ident', name: raw }
  return { type: 'other', text: raw }
}

/** Up to `max` arguments of the call whose `(` ends just before `open`. */
function readArgs(src: string, open: number, max: number): Arg[] {
  const args: Arg[] = []
  let i = open
  while (args.length < max) {
    const end = boundary(src, i, true)
    const raw = src.slice(i, end < 0 ? src.length : end).trim()
    if (raw) args.push(classify(raw, end >= 0))
    if (end < 0 || src[end] !== ',') break
    i = end + 1
  }
  return args
}

/** Snippet-local scope for resolving `const url = '…'` style indirection. */
class Scope {
  private cache = new Map<string, string | undefined>()
  constructor(readonly src: string) {}

  /**
   * The string a `const/let/var NAME = <literal>` binding holds, or — for a
   * member path like `state.clickSave` — what this snippet assigned to it.
   */
  resolve(name: string): string | undefined {
    if (this.cache.has(name)) return this.cache.get(name)
    let value: string | undefined
    const escaped = name.replace(/[$.]/g, (c) => `\\${c}`)
    const binding = name.includes('.') ? `(?<![\\w$.])${escaped}` : `(?:const|let|var)\\s+${escaped}`
    const m = new RegExp(`${binding}\\s*=\\s*(?=['"\`])`).exec(this.src)
    if (m) {
      const start = m.index + m[0].length
      const end = skipLiteral(this.src, start)
      if (end > 0) {
        const arg = classify(this.src.slice(start, end), true)
        if (arg.type === 'string' || arg.type === 'template') value = arg.value
      }
    }
    this.cache.set(name, value)
    return value
  }

  /** A literal or resolvable identifier argument as a string. */
  value(arg: Arg | undefined): string | undefined {
    if (!arg) return undefined
    if (arg.type === 'string' || arg.type === 'template') return arg.value
    if (arg.type === 'ident') return this.resolve(arg.name)
    return undefined
  }

  /** Every string-valued argument, in order (numbers and unresolved names drop out). */
  strings(args: Arg[]): string[] {
    const out: string[] = []
    for (const a of args) {
      const v = this.value(a)
      if (v !== undefined) out.push(v)
    }
    return out
  }

  /** `key: <literal>` (or `key: name` / shorthand `{ key }`) inside an object literal's text. */
  field(text: string | undefined, keys: string[]): string | undefined {
    if (!text) return undefined
    for (const key of keys) {
      const re = new RegExp(`(?:^|[{,\\s])['"]?${key}['"]?\\s*(:\\s*)?`, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const at = m.index + m[0].length
        if (!m[1]) {
          // Shorthand `{ key }` (or `{ key, … }`): the value is the same-named binding.
          if (/^\s*[,}]/.test(text.slice(at))) {
            const v = this.resolve(key)
            if (v !== undefined) return v
          }
          continue
        }
        const ch = text[at]
        if (ch === '"' || ch === "'" || ch === '`') {
          const end = skipLiteral(text, at)
          if (end < 0) return undefined
          const v = this.value(classify(text.slice(at, end), true))
          if (v !== undefined) return v
          continue
        }
        const ident = /^[A-Za-z_$][\w$]*/.exec(text.slice(at))
        if (ident) {
          const v = this.resolve(ident[0])
          if (v !== undefined) return v
        }
      }
    }
    return undefined
  }

  /** The object-literal argument's field, looked up across every object arg. */
  objField(args: Arg[], keys: string[]): string | undefined {
    for (const a of args) {
      if (a.type !== 'object' && a.type !== 'partial') continue
      const v = this.field(a.text, keys)
      if (v !== undefined) return v
    }
    return undefined
  }
}

/* ---- targets ---------------------------------------------------------- */

type Target = Pick<CodeAction, 'target' | 'full'>

/** URL → bare host ("school.example.edu"); a same-origin path stays a short path. */
export function hostTarget(url: string | undefined): Target {
  if (!url) return {}
  const u = url.trim()
  const m = /^(?:[a-z][\w+.-]*:)?\/\/([^/?#\s]+)/i.exec(u)
  if (m) {
    const host = m[1]!.replace(/^www\./i, '').toLowerCase()
    if (host.includes('…') || host.includes('$')) return {}
    return { target: host, full: u }
  }
  if (u.startsWith('/') && !u.startsWith('/workspace') && !u.startsWith('/skills')) {
    const path = u.replace(/[?#].*$/, '')
    return { target: path.length > 32 ? `${path.slice(0, 31)}…` : path, full: u }
  }
  return {}
}

/** Names too generic to stand alone keep their folder ("repl-extensions/SKILL.md"). */
const GENERIC_FILE_NAMES = new Set(['skill.md', 'index.html', 'readme.md', 'index.md', 'index.json'])

/** VFS path → file name; a name that is entirely a `${}` hole says nothing. */
export function fileTarget(path: string | undefined): Target {
  if (!path) return {}
  const clean = path.trim().replace(/[?#].*$/, '')
  // A truncated tool result the model is paging back through: plumbing, not a file anyone named.
  if (clean.includes('/.tool-output/')) return {}
  const parts = clean.split('/').filter(Boolean)
  let name = parts.pop()
  if (!name || name === '…' || !/[A-Za-z0-9]/.test(name.replace(/…/g, ''))) return {}
  if (GENERIC_FILE_NAMES.has(name.toLowerCase()) && parts.length) name = `${parts.pop()}/${name}`
  return { target: name, full: clean }
}

/** Free text (a query, typed text, a title) → a short quoted target. */
export function quoteTarget(text: string | undefined, max = 32): Target {
  if (!text) return {}
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || t === '…') return {}
  return { target: `“${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}”`, full: t }
}

/**
 * First absolute URL literal anywhere in the snippet: the target of a fetch in
 * a loop. The host must already be followed by a path, quote or `${` — a URL
 * still streaming in ("https://canv") is not a host yet.
 */
function firstUrl(src: string): string | undefined {
  const m = /['"`](https?:\/\/[^/'"`\s$?#]+)(?=[/'"`$?#])([^'"`\s]*)/.exec(src)
  return m ? m[1]! + m[2]! : undefined
}

/* ---- page scripts ----------------------------------------------------- */

const CLICK_RE = /\.click\s*\(\s*\)|dispatchEvent\(\s*new\s+(?:Mouse|Pointer)Event\(\s*['"](?:click|mousedown|mouseup|pointerdown|pointerup)['"]/
const TYPE_RE =
  /\.value\s*=[^=]|getOwnPropertyDescriptor\([^)]*?['"]value['"]|execCommand\(\s*['"]insertText['"]|new\s+(?:Input)?Event\(\s*['"](?:input|beforeinput)['"]|\.(?:textContent|innerText)\s*=[^=]/
const FILL_RE = /\.(?:checked|selectedIndex)\s*=[^=]/
const SUBMIT_RE = /\.submit\s*\(\s*\)|\.requestSubmit\s*\(/
const SCROLL_RE = /scrollIntoView|\bscroll(?:To|By)?\s*\(|scrollTop\s*[+-]?=[^=]/
const NAV_RE = /location\s*\.\s*(?:href\s*=[^=]|assign\s*\(|replace\s*\()|window\s*\.\s*open\s*\(/
const BACK_RE = /history\s*\.\s*(?:back|go)\s*\(/
const READ_RE =
  /innerText|textContent|querySelector|getElementsBy|getElementById|getAttribute|innerHTML|outerHTML|document\s*\.\s*title|getBoundingClientRect|getComputedStyle|\.value\b|\.href\b|\bdocument\s*\.\s*body|location\s*\.\s*href|\.checked\b|\.options\b|\.children\b/

/** Text a script matched its click target by: `.includes('Submit')`, `aria-label="Send"`, `=== 'Next'`. */
function clickLabel(js: string): string | undefined {
  const patterns = [
    /(?:innerText|textContent)(?:\s*\.\s*trim\(\s*\))?\s*={2,3}\s*(['"`])([^'"`\n]{2,40})\1/,
    /\.includes\(\s*(['"`])([^'"`\n]{2,40})\1\s*\)/,
    /aria-label\s*[*^$|~]?=\s*\\?(['"])([^'"\\\n]{2,40})\\?\1/,
  ]
  for (const re of patterns) {
    const label = re.exec(js)?.[2]?.trim()
    // CSS-ish or code-ish strings aren't something a person would call a
    // button, and a lone lowercase word is a class name ("primary", "active").
    if (label && /[A-Za-z]/.test(label) && !/[[\]{}<>#=]|^\.|\$\{/.test(label) && /[A-Z\s\d]/.test(label)) return label
  }
  return undefined
}

/** Text a script typed: `setter.call(el, 'COURSE 101')`, `el.value = 'hello'`. */
function typedText(js: string): string | undefined {
  const m =
    /\.call\(\s*[\w$.]+\s*,\s*(['"`])([^'"`\n]{1,80})\1/.exec(js) ??
    /\.value\s*=\s*(['"`])([^'"`\n]{1,80})\1/.exec(js) ??
    /execCommand\(\s*['"]insertText['"]\s*,\s*\w+\s*,\s*(['"`])([^'"`\n]{1,80})\1/.exec(js)
  return m?.[2]
}

/** What a page-evaluated script does, strongest first. */
function pageScriptActions(js: string): CodeAction[] {
  const out: CodeAction[] = []
  if (NAV_RE.test(js)) out.push({ kind: 'navigate', ...hostTarget(firstUrl(js.slice(js.search(NAV_RE)))) })
  if (BACK_RE.test(js)) out.push({ kind: 'back' })
  if (SUBMIT_RE.test(js)) out.push({ kind: 'submit' })
  if (CLICK_RE.test(js)) out.push({ kind: 'click', ...quoteTarget(clickLabel(js)) })
  if (TYPE_RE.test(js)) out.push({ kind: 'type', ...quoteTarget(typedText(js)) })
  if (FILL_RE.test(js)) out.push({ kind: 'fill' })
  if (SCROLL_RE.test(js)) out.push({ kind: 'scroll' })
  if (out.length === 0) out.push({ kind: READ_RE.test(js) ? 'read-page' : 'script' })
  return out
}

/* ---- CDP -------------------------------------------------------------- */

const NAMED_KEY = /^(?:Enter|Tab|Escape|Esc|Backspace|Delete|Space|Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Home|End|F\d{1,2})$/

function cdpActions(method: string | undefined, params: Arg | undefined, scope: Scope): CodeAction[] {
  const p = params && (params.type === 'object' || params.type === 'partial') ? params.text : undefined
  const field = (...keys: string[]): string | undefined => scope.field(p, keys)
  switch (method) {
    case 'Runtime.evaluate':
      return pageScriptActions(field('expression') ?? p ?? '')
    case 'Runtime.callFunctionOn':
      return pageScriptActions(field('functionDeclaration') ?? p ?? '')
    case 'Input.dispatchMouseEvent': {
      const type = field('type')
      if (type === 'mouseWheel') return [{ kind: 'scroll' }]
      if (type === 'mouseMoved') return []
      return [{ kind: 'click' }]
    }
    case 'Input.dispatchTouchEvent':
      return [{ kind: 'click' }]
    case 'Input.dispatchKeyEvent': {
      const key = field('key', 'code')
      if (key && NAMED_KEY.test(key)) return [{ kind: 'key', target: key === 'Esc' ? 'Escape' : key }]
      return [{ kind: 'type' }]
    }
    case 'Input.insertText':
      return [{ kind: 'type', ...quoteTarget(field('text')) }]
    case 'Page.navigate':
      return [{ kind: 'navigate', ...hostTarget(field('url')) }]
    case 'Page.reload':
      return [{ kind: 'reload' }]
    case 'Page.navigateToHistoryEntry':
      return [{ kind: 'back' }]
    case 'Page.captureScreenshot':
      return [{ kind: 'screenshot' }]
    case 'Page.printToPDF':
      return [{ kind: 'print-pdf' }]
    case 'Page.addScriptToEvaluateOnNewDocument':
      return [{ kind: 'script' }]
    case 'Accessibility.getFullAXTree':
    case 'Accessibility.queryAXTree':
    case 'DOMSnapshot.captureSnapshot':
    case 'DOM.getDocument':
    case 'DOM.performSearch':
    case 'DOM.getSearchResults':
    case 'DOM.querySelector':
    case 'DOM.querySelectorAll':
    case 'DOM.getOuterHTML':
    case 'DOM.describeNode':
    case 'DOMDebugger.getEventListeners':
      return [{ kind: 'read-page' }]
    case 'Network.getAllCookies':
    case 'Network.getCookies':
    case 'Storage.getCookies':
      return [{ kind: 'cookies' }]
    case 'Network.deleteCookies':
    case 'Network.clearBrowserCookies':
    case 'Network.clearBrowserCache':
    case 'Storage.clearDataForOrigin':
    case 'Storage.clearCookies':
      return [{ kind: 'clear-data' }]
    case 'Network.setBlockedURLs':
    case 'Network.getResponseBody':
    case 'Fetch.enable':
      return [{ kind: 'network' }]
    case 'Emulation.setDeviceMetricsOverride':
    case 'Emulation.setVisibleSize':
      return [{ kind: 'viewport' }]
    default:
      // Plumbing (enable, getBoxModel, createIsolatedWorld, getFrameTree…):
      // real work, but never what a person would say the code did.
      return []
  }
}

/* ---- api calls -------------------------------------------------------- */

const FS_READS = new Set(['readText', 'readHtml', 'readLines', 'readBytes', 'dataUrl', 'extractText', 'renderPdfPage', 'stat'])
const FS_WRITES = new Set(['writeText', 'writeBase64', 'createSkill'])
const FS_LISTS = new Set(['list', 'summary', 'skills'])

/** The argument that holds a page script: the last one that isn't a tab id. */
function scriptArg(args: Arg[], scope: Scope): string {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i]!
    if (a.type === 'string' || a.type === 'template') return a.value
    if (a.type === 'partial') return a.text
    if (a.type === 'ident') {
      const v = scope.resolve(a.name)
      if (v !== undefined) return v
      continue
    }
    if (a.type === 'other' && !/^\d+$/.test(a.text)) {
      // `state.clickText + \`return clickText(…)\`` — fold in any helper
      // string this snippet defined, so the click inside it still counts.
      const refs = a.text.match(/(?<![\w$.])(?:state|globalThis|window)\.[A-Za-z_$][\w$]*/g) ?? []
      return [a.text, ...refs.map((r) => scope.resolve(r) ?? '')].join('\n')
    }
  }
  return ''
}

/** String literals inside an array literal's text (`['a.pdf', 'b.pdf']`). */
function arrayStrings(text: string): string[] {
  const out: string[] = []
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(unescape(m[2]!))
  return out
}

function callActions(path: string, args: Arg[], scope: Scope): CodeAction[] {
  const first = (): string | undefined => scope.strings(args)[0]
  const last = (): string | undefined => scope.strings(args).at(-1)
  const [, ns, method] = path.split('.')
  switch (path) {
    case 'api.fetch': {
      const verb = scope.objField(args.slice(1), ['method'])
      const kind = /^(?:post|put|patch|delete)$/i.test(verb ?? '') ? 'send' : 'fetch'
      return [{ kind, ...hostTarget(scope.value(args[0]) ?? firstUrl(scope.src)) }]
    }
    case 'api.page.fetch':
      return [{ kind: 'fetch', ...hostTarget(first() ?? firstUrl(scope.src)) }]
    case 'api.page.navigate':
      return [{ kind: 'navigate', ...hostTarget(first() ?? firstUrl(scope.src)) }]
    case 'api.page.snapshot':
    case 'api.frames.list':
      return [{ kind: 'read-page' }]
    case 'api.page.eval':
    case 'api.frames.eval':
      return pageScriptActions(scriptArg(args, scope))
    case 'api.page.click':
    case 'api.frames.click':
      return [{ kind: 'click' }]
    case 'api.page.type':
    case 'api.page.typeHuman': {
      const values = scope.strings(args)
      // A lone string that looks like an element ref ("e12") is the target, not the text.
      const text = values.length === 1 && /^e\d+$/.test(values[0]!) ? undefined : values.at(-1)
      return [{ kind: 'type', ...quoteTarget(text) }]
    }
    case 'api.page.fill': {
      const list = args.find((a) => a.type === 'array' || a.type === 'partial')
      const n = list && 'text' in list ? (list.text.match(/\bref\s*:/g) ?? []).length : 0
      return [{ kind: 'fill', ...(n > 0 ? { target: `${n} field${n === 1 ? '' : 's'}` } : {}) }]
    }
    case 'api.page.select':
      return [{ kind: 'select', ...quoteTarget(last()) }]
    case 'api.page.pressKey':
      return [{ kind: 'key', ...(last() ? { target: last() } : {}) }]
    case 'api.page.scroll':
      return [{ kind: 'scroll' }]
    case 'api.page.waitForLoad':
      return [{ kind: 'wait' }]
    case 'api.page.screenshotToLog':
      return [{ kind: 'screenshot' }]
    case 'api.page.attachFiles': {
      const list = args.find((a) => a.type === 'array')
      const paths = list && list.type === 'array' ? arrayStrings(list.text) : scope.strings(args)
      const files = paths.map((p) => fileTarget(p)).filter((t) => t.target)
      return files.length ? files.map((t) => ({ kind: 'attach' as const, ...t })) : [{ kind: 'attach' }]
    }
    case 'api.cdp':
      return cdpActions(scope.value(args[1]), args[2], scope)
    case 'api.history.search':
      return [{ kind: 'history', ...quoteTarget(scope.value(args[0]) ?? scope.objField(args, ['text', 'query'])) }]
    case 'api.history.getVisits':
    case 'api.navigation.recent':
      return [{ kind: 'history' }]
    case 'api.bookmarks.search':
      return [{ kind: 'bookmarks', ...quoteTarget(scope.value(args[0]) ?? scope.objField(args, ['query', 'title'])) }]
    case 'api.bookmarks.tree':
      return [{ kind: 'bookmarks' }]
    case 'api.downloads.search':
      return [{ kind: 'downloads' }]
    case 'api.tabs.list':
    case 'api.tabs.get':
    case 'api.tabGroups.list':
    case 'api.tabGroups.get':
      return [{ kind: 'tabs-list' }]
    case 'api.tabs.create':
      return [{ kind: 'tabs-open', ...hostTarget(scope.objField(args, ['url']) ?? first() ?? firstUrl(scope.src)) }]
    case 'api.tabs.close':
      return [{ kind: 'tabs-close' }]
    case 'api.tabs.activate':
      return [{ kind: 'tabs-switch' }]
    case 'api.tabs.group':
    case 'api.tabs.ungroup':
    case 'api.tabs.move':
    case 'api.tabGroups.update':
    case 'api.tabGroups.move':
      return [{ kind: 'tabs-group', ...quoteTarget(scope.objField(args, ['title'])) }]
    case 'api.fs.search':
      return [{ kind: 'search-files', ...quoteTarget(scope.value(args[0]) ?? scope.objField(args, ['query', 'text'])) }]
    case 'api.fs.importUrl':
      return [{ kind: 'import', ...hostTarget(first()) }]
    case 'api.net.requests':
    case 'api.net.body':
      return [{ kind: 'network' }]
    case 'api.artifacts.create':
      return [{ kind: 'artifact-build', ...fileTarget(scope.objField(args, ['path']) ?? scope.value(args[0])) }]
    case 'api.artifacts.save':
      return [{ kind: 'artifact-build', ...fileTarget(scope.value(args[0])) }]
    case 'api.artifacts.open':
    case 'api.artifacts.url':
      return [{ kind: 'artifact-open', ...fileTarget(scope.value(args[0])) }]
    case 'api.automations.create':
      return [{ kind: 'automation', ...quoteTarget(scope.objField(args, ['title'])) }]
    case 'api.stickies.create':
      return [{ kind: 'sticky', ...quoteTarget(scope.objField(args, ['title', 'name'])) }]
    case 'api.require':
      return [{ kind: 'library', ...hostTarget(first()) }]
  }
  // The path is always the first argument; any other string (the text being
  // written, an eval body) must never pass for a file name.
  const path0 = (): string | undefined => scope.value(args[0])
  if (path.startsWith('apps.')) return [{ kind: 'app', target: `${ns}.${method}` }]
  if (ns === 'fs' && method && FS_READS.has(method)) return [{ kind: 'read-file', ...fileTarget(path0()) }]
  if (ns === 'fs' && method && FS_WRITES.has(method)) return [{ kind: 'write-file', ...fileTarget(path0()) }]
  if (ns === 'fs' && method && FS_LISTS.has(method)) return [{ kind: 'list-files', ...fileTarget(path0()) }]
  if (ns === 'artifacts') return [{ kind: 'artifact-check', ...fileTarget(path0()) }]
  if (ns === 'automations') return [{ kind: 'automation' }]
  if (ns === 'stickies') return [{ kind: 'sticky', ...quoteTarget(first()) }]
  if (ns === 'extensions') return [{ kind: 'extension' }]
  if (ns === 'pdf') return [{ kind: 'pdf' }]
  if (ns === 'zip') return [{ kind: 'zip' }]
  // storage, bytes, cdp.getEvents…: bookkeeping, not an action.
  return []
}

/* ---- entry point ------------------------------------------------------ */

/** `api.x.y(` / `apps.id.method(` call sites, not preceded by a member access or a URL. */
const CALL_RE = /(?<![\w$./])(api(?:\s*\.\s*[A-Za-z_$][\w$]*)+|apps\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*)\s*\(/g
const SLEEP_RE = /\bsetTimeout\s*\(|\bsleep\s*\(/

/**
 * Recent results by snippet. Rows re-describe themselves on every render, and
 * a streaming snippet over 1KB is only re-parsed every ~12% of growth (see the
 * reducer), so the same string comes back many times in a row.
 */
const cache = new Map<string, CodeAction[]>()
const CACHE_SIZE = 64

/**
 * Everything a snippet does, in first-seen order, one entry per distinct
 * (kind, target). Safe on partial input: incomplete literals are ignored.
 */
export function codeActions(code: string): CodeAction[] {
  if (!code) return []
  const hit = cache.get(code)
  if (hit) return hit
  const out = scan(code)
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!)
  cache.set(code, out)
  return out
}

function scan(code: string): CodeAction[] {
  const src = code.length > MAX_SCAN ? code.slice(0, MAX_SCAN) : code
  const scope = new Scope(src)
  const found: CodeAction[] = []
  CALL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  let calls = 0
  while ((m = CALL_RE.exec(src)) && calls++ < MAX_CALLS) {
    const path = m[1]!.replace(/\s+/g, '')
    const args = readArgs(src, m.index + m[0].length, 3)
    found.push(...callActions(path, args, scope))
  }
  if (SLEEP_RE.test(src)) found.push({ kind: 'wait' })

  // One entry per (kind, target); a bare entry is dropped when the same kind
  // also appears with a target — "clicked" adds nothing next to "clicked Send".
  const targeted = new Set(found.filter((a) => a.target).map((a) => a.kind))
  const seen = new Set<string>()
  const out: CodeAction[] = []
  for (const a of found) {
    if (!a.target && targeted.has(a.kind)) continue
    const key = `${a.kind}\u0000${a.target ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

/** The action that best names the snippet (highest rank, earliest on ties). */
export function primaryAction(actions: readonly CodeAction[]): CodeAction | undefined {
  let best: CodeAction | undefined
  for (const a of actions) if (!best || ACTION_RANK[a.kind] > ACTION_RANK[best.kind]) best = a
  return best
}
