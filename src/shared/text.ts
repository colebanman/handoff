/**
 * Well-formed UTF-16 helpers.
 *
 * Page text (CDP snapshots, innerText, localStorage) can contain unpaired
 * surrogate code points, and slicing a string mid–surrogate-pair creates one.
 * OpenAI rejects any request payload containing a lone surrogate ("string
 * contains an unpaired UTF-16 surrogate code point"), which kills the whole
 * agent turn — so every string headed for the model must pass through here.
 */

const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

interface WellFormedApi {
  isWellFormed?(): boolean
  toWellFormed?(): string
}

/** Replace unpaired surrogates with U+FFFD. Returns the same string when clean. */
export function toWellFormed(text: string): string {
  const s = text as string & WellFormedApi
  if (typeof s.isWellFormed === 'function' && typeof s.toWellFormed === 'function') {
    return s.isWellFormed() ? text : s.toWellFormed()
  }
  return text.replace(LONE_SURROGATES, '�')
}

/** `text.slice(0, end)` that never cuts a surrogate pair in half. */
export function sliceWellFormed(text: string, end: number): string {
  const out = text.slice(0, end)
  const last = out.charCodeAt(out.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out
}

/**
 * Cap on every tool-output string sent to the model (see truncate() in
 * src/agent/tools.ts). Referenced by tool descriptions and the system prompt
 * so the numbers the model reads always match the enforced cap.
 */
export const MAX_TOOL_OUTPUT = 15_000

/** Deep-copy a value with every string made well-formed (arrays + plain objects). */
export function deepToWellFormed<T>(value: T): T {
  if (typeof value === 'string') return toWellFormed(value) as T
  if (Array.isArray(value)) return value.map((item) => deepToWellFormed(item)) as T
  if (typeof value === 'object' && value !== null && (value.constructor === Object || value.constructor === undefined)) {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value)) out[key] = deepToWellFormed(raw)
    return out as T
  }
  return value
}
