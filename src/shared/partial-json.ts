/**
 * Sync best-effort parser for a *streaming* JSON document — i.e. a prefix of
 * valid JSON, as produced by tool-input token streams. Closes unterminated
 * strings, completes dangling keys/literals, drops trailing commas, and closes
 * open containers so the prefix parses.
 *
 * The transcript reducer calls this on every tool-input-delta so tool rows can
 * render live inputs while args stream; the `ai` package's parsePartialJson is
 * async and unusable inside a sync reducer.
 */

/** Parse a possibly-truncated JSON text. Returns undefined when nothing meaningful parses yet. */
export function parsePartialJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // Truncated mid-stream: repair the prefix below.
  }
  const repaired = completeJsonPrefix(trimmed)
  if (repaired === undefined) return undefined
  try {
    return JSON.parse(repaired)
  } catch {
    return undefined
  }
}

const NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/
const LITERALS = ['true', 'false', 'null']

/** Complete a truncated JSON prefix into parseable JSON, or undefined when it can't be. */
function completeJsonPrefix(text: string): string | undefined {
  /** Pending close chars, in open order (stack). */
  const closers: string[] = []
  let inString = false
  let escaped = false
  /** The currently open string is an object key. */
  let stringIsKey = false
  /** A completed key string whose ':' hasn't arrived yet. */
  let danglingKey = false
  /** Start index of an in-progress bare literal/number token, or -1. */
  let literalStart = -1
  /** Last significant structural char seen outside strings/literals. */
  let lastSig = ''

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (c === '\\') {
        escaped = true
      } else if (c === '"') {
        inString = false
        if (stringIsKey) danglingKey = true
        lastSig = '"'
      }
      continue
    }
    if (literalStart !== -1) {
      if (/[-+.\w]/.test(c)) continue
      literalStart = -1
      lastSig = 'v'
      // fall through: c is a structural char that still needs handling
    }
    if (c === '"') {
      inString = true
      escaped = false
      stringIsKey = closers[closers.length - 1] === '}' && (lastSig === '{' || lastSig === ',')
    } else if (c === '{') {
      closers.push('}')
      lastSig = c
    } else if (c === '[') {
      closers.push(']')
      lastSig = c
    } else if (c === '}' || c === ']') {
      if (closers.pop() !== c) return undefined // malformed, not just truncated
      lastSig = c
    } else if (c === ':' || c === ',') {
      danglingKey = false
      lastSig = c
    } else if (!/\s/.test(c)) {
      literalStart = i
    }
  }

  let out = text
  if (inString) {
    if (escaped) out = out.slice(0, -1) // trailing lone backslash
    out = out.replace(/\\u[0-9a-fA-F]{0,3}$/, '') // incomplete \uXXXX escape
    out += '"'
    if (stringIsKey) out += ': null' // truncated key: give it a value
  } else if (literalStart !== -1) {
    const token = text.slice(literalStart)
    const literal = LITERALS.find((l) => l.startsWith(token))
    if (literal) {
      out = text.slice(0, literalStart) + literal
    } else {
      // Number truncated mid-token: keep the longest valid prefix.
      let num = token
      while (num && !NUMBER_RE.test(num)) num = num.slice(0, -1)
      out = text.slice(0, literalStart) + (num || 'null')
    }
  } else {
    out = out.trimEnd()
    if (out.endsWith(',')) out = out.slice(0, -1)
    else if (out.endsWith(':')) out += ' null'
    else if (danglingKey) out += ': null'
  }
  for (let i = closers.length - 1; i >= 0; i--) out += closers[i]
  return out
}
