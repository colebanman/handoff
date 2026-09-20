import { probe } from './extension-context-probe'
export { probe } from './extension-context-probe'
import type { ExtensionSummary } from '../shared/extensions'
import { schemaSignature } from '../shared/extensions'
import { domRules, evaluateRule, matchesTask, supportsUrl, type Match } from '../shared/extension-matching'
import { contextText } from '../shared/context-blocks'
import type { ContextTab, RuntimeContextOptions } from './runtime-context'

const MAX_DOC_CHARS = 5000
const observations = new Map<number, { url: string; key: string; at: number; value: Record<string, Match> }>()
const pending = new Map<number, Promise<void>>()
let listening = false


export async function observeExtensionContext(entries: ExtensionSummary[], tabs: ContextTab[]): Promise<Map<number, Record<string, Match>>> {
  if (!listening && typeof chrome !== 'undefined') {
    const invalidate = (id: number) => observations.delete(id)
    chrome.tabs?.onUpdated?.addListener(invalidate)
    chrome.tabs?.onRemoved?.addListener(invalidate)
    chrome.webNavigation?.onHistoryStateUpdated?.addListener((event) => invalidate(event.tabId))
    listening = true
  }
  const jobs: Promise<void>[] = []
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url || !/^https?:/.test(tab.url)) continue
    const rules = entries.filter((e) => e.enabled && supportsUrl(e.manifest, tab.url!)).flatMap((e) => domRules(e.manifest.when))
    const specs = [...new Map(rules.map((r) => [JSON.stringify(r.dom), r.dom])).values()].slice(0, 32)
    if (!specs.length) continue
    const key = JSON.stringify(specs), cached = observations.get(tab.id)
    if (cached && cached.url === tab.url && cached.key === key && Date.now() - cached.at < 1500) continue
    if (pending.has(tab.id)) { jobs.push(pending.get(tab.id)!); continue }
    if (pending.size >= 4 || !chrome.scripting?.executeScript) continue
    const id = tab.id, url = tab.url
    const job = chrome.scripting.executeScript({ target: { tabId: id, allFrames: specs.some((s) => s.frame === 'any') }, world: 'ISOLATED', func: probe, args: [specs] })
      .then((frames) => {
        const value: Record<string, Match> = {}
        for (const spec of specs) {
          const k = JSON.stringify(spec), results = frames.map((f) => f.result?.[k]).filter((v) => v !== undefined)
          value[k] = results.includes(true) ? true : results.length && !results.includes('unknown') ? false : 'unknown'
        }
        observations.set(id, { url, key, at: Date.now(), value })
      }).catch(() => { observations.delete(id) }).finally(() => { pending.delete(id) })
    pending.set(id, job); jobs.push(job)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.all(jobs), new Promise((resolve) => { timer = setTimeout(resolve, 250) })])
  clearTimeout(timer)
  return new Map(tabs.flatMap((tab) => {
    const value = tab.id !== undefined ? observations.get(tab.id) : undefined
    return value && value.url === tab.url && Date.now() - value.at < 1500 ? [[tab.id!, value.value] as const] : []
  }))
}

export function extensionContext(entries: ExtensionSummary[], task: string, tabs: ContextTab[], options: RuntimeContextOptions,
  sensed = new Map<number, Record<string, Match>>(), learningEnabled = true, semantic?: Map<string, number>): { block: string; revisions: Record<string, number> } {
  const available = options.offlineOnly ? [] : tabs.filter((t) => t.id !== undefined && (!options.isSubagent || options.allowedTabIds?.includes(t.id)))
  const scored = entries.filter((e) => e.enabled).flatMap((entry) => {
    const { manifest } = entry
    const local = Object.values(manifest.actions).every((a) => a.effects === 'local')
    if (options.offlineOnly && !local) return []
    const explicit = !options.isSubagent && [entry.id, ...manifest.triggers].some((t) => matchesTask(t, task))
    const targets = available.filter((tab) => {
      if (!supportsUrl(manifest, tab.url ?? tab.pendingUrl ?? '')) return false
      return manifest.sites.length > 0 || (manifest.when && evaluateRule(manifest.when, { url: tab.url, task, observations: sensed.get(tab.id!) }) === true)
    })
    const conditional = manifest.when ? available.some((tab) => evaluateRule(manifest.when!, { url: tab.url, task, observations: sensed.get(tab.id!) }) === true)
      || evaluateRule(manifest.when, { task }) === true : false
    const relevance = Math.max(0, ...Object.keys(manifest.actions).map((path) => semantic?.get(`${entry.id}.${path}@${entry.revision}`) ?? 0))
    if (!explicit && !targets.length && !conditional && !(local && relevance >= 0.65)) return []
    if (options.isSubagent && !local && !targets.length) return []
    const focused = targets.some((t) => t.id === options.currentTabId || task.includes(`@tab(${t.id}`))
    return [{ entry, targets, score: explicit ? 100 : semantic ? relevance * 70 + (focused ? 10 : 0) : focused ? 60 : conditional ? 30 : 20 }]
  }).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
  const lines: string[] = [], revisions: Record<string, number> = Object.create(null)
  const index = contextText(scored.slice(0, 12).map(({entry}) => `${entry.id}@${entry.revision}`).join(', '))
  if (index) lines.push(`Available: ${index}${scored.length > 12 ? `; ${scored.length - 12} more via api.extensions.list()` : ''}`)
  let remaining = MAX_DOC_CHARS - (lines[0]?.length ?? 0)
  for (const { entry, targets, score: relevance } of scored) {
    revisions[entry.id] = entry.revision
    const header = contextText(`${entry.id}@${entry.revision}: ${entry.description} (${targets.length ? `tabs ${targets.slice(0, 8).map((t) => t.id).join(',')}${targets.length > 8 ? ',…' : ''}` : 'no bound tab; inspect setup'})`)
    const actions = Object.entries(entry.manifest.actions).sort(([a], [b]) => {
      const score = (v: string) => v.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/\W/).filter((w) => w.length > 3 && task.toLowerCase().includes(w)).length
      return (semantic ? (semantic.get(`${entry.id}.${b}@${entry.revision}`) ?? 0) - (semantic.get(`${entry.id}.${a}@${entry.revision}`) ?? 0) : 0) || score(b) - score(a) || a.localeCompare(b)
    }).map(([path, spec]) => {
      const signature = schemaSignature(spec.input)
      return contextText(`apps.${entry.id}.${path}(${signature.length <= 300 ? signature : 'input'}) — ${spec.description} [${spec.effects}; ${entry.results.some((r) => r.action === path && r.mode === 'live' && r.ok) ? 'live-tested' : 'fixture-tested'}]`)
    })
    const selected: string[] = []
    if (remaining < header.length + 40) break
    remaining -= header.length + 20
    for (const action of actions.slice(0, relevance >= 100 ? 8 : 3)) { if (action.length > remaining) break; selected.push(action); remaining -= action.length + 1 }
    const instructions = entry.manifest.instructions ? contextText(entry.manifest.instructions) : undefined
    if (instructions && instructions.length < remaining) { selected.push(`Saved guidance: ${instructions}`); remaining -= instructions.length }
    if (selected.length < actions.length) selected.push('More: api.extensions.get({id:"' + entry.id + '"})')
    lines.push([header, ...selected].join('\n'))
  }
  if (!entries.length && learningEnabled) return { block: '', revisions }
  const intro = learningEnabled ? 'Saved functions; use when useful. Inspect source/contracts with api.extensions.get({id}).' : 'Learning is disabled. Existing saved functions remain usable.'
  const body = lines.join('\n\n') || 'No saved functions match. api.extensions.list({query}) discovers others.'
  return { block: `<repl-extensions>\n${intro}\n${body}\n</repl-extensions>`, revisions }
}
