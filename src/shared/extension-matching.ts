import type { ExtensionManifest, MatchRule } from './extensions'

export type Match = true | false | 'unknown'
export function matchesUrl(pattern: string, raw: string): boolean {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const p = pattern.replace(/^https?:\/\//, '')
    const slash = p.indexOf('/'), host = (slash < 0 ? p : p.slice(0, slash)).toLowerCase(), path = slash < 0 ? '/**' : p.slice(slash)
    const glob = (v: string) => v.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')
    if (/^https?:\/\//.test(pattern) && !raw.startsWith(pattern.slice(0, pattern.indexOf('://') + 3))) return false
    const hostPattern = host.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^./]*')
    const pathPattern = path.endsWith('/**') ? `${glob(path.slice(0, -3))}(?:/.*)?` : glob(path)
    return new RegExp(`^${hostPattern}$`, 'i').test(url.host) && new RegExp(`^${pathPattern}$`).test(url.pathname + (path.includes('?') ? url.search : '') + (path.includes('#') ? url.hash : ''))
  } catch { return false }
}
export function matchesTask(alias: string, task: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(task)
}
export function domRules(rule?: MatchRule): Extract<MatchRule, { dom: unknown }>[] {
  if (!rule) return []
  if ('dom' in rule) return [rule]
  if ('all' in rule) return rule.all.flatMap(domRules)
  if ('any' in rule) return rule.any.flatMap(domRules)
  return 'not' in rule ? domRules(rule.not) : []
}
export function evaluateRule(rule: MatchRule, input: { url?: string; task: string; now?: Date; observations?: Record<string, Match> }): Match {
  if ('all' in rule || 'any' in rule) {
    const values = ('all' in rule ? rule.all : rule.any).map((r) => evaluateRule(r, input))
    if ('all' in rule) return values.includes(false) ? false : values.includes('unknown') ? 'unknown' : true
    return values.includes(true) ? true : values.includes('unknown') ? 'unknown' : false
  }
  if ('not' in rule) { const value = evaluateRule(rule.not, input); return value === 'unknown' ? value : !value }
  if ('url' in rule) return input.url ? matchesUrl(rule.url, input.url) : false
  if ('task' in rule) return matchesTask(rule.task, input.task)
  if ('dom' in rule) return input.observations?.[JSON.stringify(rule.dom)] ?? 'unknown'
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: rule.time.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(input.now ?? new Date())
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const time = `${get('hour')}:${get('minute')}`, day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  const { from, to, days } = rule.time
  return (!days?.length || days.includes(day)) && (from === to || (from < to ? time >= from && time < to : time >= from || time < to))
}

export function supportsUrl(manifest: ExtensionManifest, url: string): boolean {
  return manifest.sites.length === 0 || manifest.sites.some((pattern) => matchesUrl(pattern, url))
}
