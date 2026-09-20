/**
 * Compact ring-buffer debug log. Every subsystem pushes one-liners here;
 * the UI's "Copy debug log" button dumps it as markdown for pasting into
 * a coding-agent session. Intentionally small: 300 entries, data payloads
 * truncated to 400 chars on export. Full payloads are retained for verbose export.
 */

import { formatErrorWithStack } from './errors'
import { redactSecrets } from './redact'
import { publishTap, tapEnabled } from './stream-tap'

export type LogCat = 'agent' | 'cdp' | 'sandbox' | 'ui' | 'net' | 'storage' | 'error' | 'artifact'

export interface LogEntry {
  at: number
  cat: LogCat
  msg: string
  data?: string
}

const MAX_ENTRIES = 300
const MAX_DATA = 400

class DebugLog {
  private entries: LogEntry[] = []
  private startedAt = Date.now()

  log(cat: LogCat, msg: string, data?: unknown): void {
    let dataStr: string | undefined
    if (data !== undefined) {
      try {
        dataStr = typeof data === 'string' ? data : JSON.stringify(data)
      } catch {
        dataStr = String(data)
      }
    }
    this.entries.push({ at: Date.now(), cat, msg, data: dataStr })
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    // Mirror onto the stream inspector's timeline when it is armed, so local
    // decisions sit next to the wire traffic they caused. stream-tap imports
    // nothing from here, so this edge cannot recurse.
    if (__DEV_BUILD__ && tapEnabled()) {
      publishTap({ kind: 'log', label: `${cat} · ${msg}`, text: dataStr ?? '' })
    }
  }

  error(cat: LogCat, msg: string, err: unknown): void {
    this.log(cat, `ERROR ${msg}`, formatErrorWithStack(err))
  }

  /** Markdown dump for copy-paste debugging. */
  dump(extra?: Record<string, unknown>, verbose = false): string {
    const lines: string[] = []
    lines.push('```')
    lines.push(`handoff debug log — ${new Date().toISOString()} (session ${Math.round((Date.now() - this.startedAt) / 1000)}s)`)
    if (extra) {
      for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
    lines.push('---')
    for (const e of this.entries) {
      const t = new Date(e.at).toISOString().slice(11, 23)
      const data = !verbose && e.data && e.data.length > MAX_DATA ? e.data.slice(0, MAX_DATA) + `…(+${e.data.length - MAX_DATA})` : e.data
      lines.push(`${t} [${e.cat}] ${e.msg}${data ? ' | ' + data : ''}`)
    }
    lines.push('```')
    return redactSecrets(lines.join('\n'))
  }

  clear(): void {
    this.entries = []
  }
}

export const debugLog = new DebugLog()

/** Install window-level error hooks (call once from UI main). */
export function installErrorHooks(): void {
  window.addEventListener('error', (e) => debugLog.log('error', `window.onerror: ${e.message}`, `${e.filename}:${e.lineno}`))
  window.addEventListener('unhandledrejection', (e) => debugLog.error('error', 'unhandledrejection', e.reason))
}
