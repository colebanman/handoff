/** Elapsed-time formatting for transcript rows. */
export function fmtDuration(ms?: number): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return `${s >= 10 ? Math.round(s) : s.toFixed(1)}s`
}
