/**
 * High-precision secret detection for UI/export/debug boundaries only.
 * Never applied to model-facing tool results mid-conversation — the model
 * may legitimately need to reuse a token the user gave it. Precision over
 * recall: a missed secret is better than mangled ordinary prose, so every
 * pattern here is a well-known, high-signal credential shape.
 */

export interface SecretMatch {
  /** Short machine-readable label, e.g. "openai-key", "bearer-token". */
  kind: string
  /** Index into the ORIGINAL string where the secret span starts. */
  start: number
  /** Index into the ORIGINAL string where the secret span ends (exclusive). */
  end: number
  /** Last 4 chars of the secret span, for a "…AB12" style label. */
  last4: string
}

interface PatternDef {
  kind: string
  re: RegExp
  /** 1-based capture group that IS the secret; surrounding match text (e.g. "Bearer ", "code=") stays visible. Omit to redact the whole match. */
  group?: number
  /** Minimum length of the whole match to accept (guards against short false positives). */
  minLen?: number
}

const PATTERNS: PatternDef[] = [
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'xai-key', re: /\bxai-[A-Za-z0-9]{20,}\b/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[po]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, minLen: 40 },
  { kind: 'bearer-token', re: /\bBearer\s+([A-Za-z0-9\-._~+/]{20,}=*)/g, group: 1 },
  { kind: 'oauth-code', re: /[?&]code=([A-Za-z0-9\-._~%]{20,})/g, group: 1 },
]

/** Find non-overlapping secret spans in `text`, indices relative to `text` itself. */
export function findSecrets(text: string): SecretMatch[] {
  const raw: SecretMatch[] = []
  for (const { kind, re, group, minLen } of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const whole = m[0]
      const span = group ? m[group] : whole
      if (span && !(minLen && whole.length < minLen)) {
        const start = group ? m.index + whole.indexOf(span) : m.index
        raw.push({ kind, start, end: start + span.length, last4: span.slice(-4) })
      }
      if (re.lastIndex === m.index) re.lastIndex += 1 // guard against zero-length matches
    }
  }
  // Sort by start asc, longest-first on ties, then drop anything overlapping an already-kept span.
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: SecretMatch[] = []
  let lastEnd = -1
  for (const m of raw) {
    if (m.start < lastEnd) continue
    out.push(m)
    lastEnd = m.end
  }
  return out
}

/** Replace every detected secret span with a `[redacted:kind…last4]` placeholder. */
export function redactSecrets(text: string): string {
  const matches = findSecrets(text)
  if (matches.length === 0) return text
  let out = ''
  let cursor = 0
  for (const m of matches) {
    out += text.slice(cursor, m.start)
    out += `[redacted:${m.kind}…${m.last4}]`
    cursor = m.end
  }
  out += text.slice(cursor)
  return out
}
