import { describe, expect, it } from 'vitest'
import { extensionManifest, type ExtensionSummary } from '../shared/extensions'
import { evaluateRule, matchesUrl } from '../shared/extension-matching'
import { extensionContext } from './extension-context'
const manifest = extensionManifest.parse({ version: 1, id: 'canvas', description: 'Canvas classes', sites: ['school.instructure.com/**'], triggers: ['Canvas'],
  actions: { 'api.searchModules': { description: 'Search modules', effects: 'read', input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } } })
const entry: ExtensionSummary = { id: 'canvas', revision: 2, enabled: true, description: manifest.description, manifest, results: [], path: '/skills/canvas', revisions: [1, 2] }
const tabs = [{ id: 1, url: 'https://mail.example.com', active: true }, { id: 2, url: 'https://school.instructure.com/courses/123' }]
const main = { isSubagent: false, currentTabId: 1 }

describe('preemptive personal capability discovery', () => {
  it('surfaces a background tab before the agent observes it', () => {
    const result = extensionContext([entry], 'Help with my day', tabs, main)
    expect(result.block).toContain('apps.canvas.api.searchModules({text:string})')
    expect(result.block).toContain('tabs 2')
    expect(result.revisions).toEqual({ canvas: 2 })
    expect(result.block).not.toContain('module.exports')
  })
  it('routes named apps without any open tab and does not inject unrelated packages', () => {
    expect(extensionContext([entry], 'Check Canvas', [], main).block).toContain('no bound tab')
    expect(extensionContext([entry], 'Write a poem', [], main).block).not.toContain('apps.canvas')
  })
  it('keeps subagent/offline scope and disabled packages out of discovery', () => {
    expect(extensionContext([entry], 'Canvas', tabs, { ...main, isSubagent: true, allowedTabIds: [1] }).block).not.toContain('apps.canvas')
    expect(extensionContext([{ ...entry, enabled: false }], 'Canvas', tabs, main).block).not.toContain('apps.canvas')
    expect(extensionContext([entry], 'Canvas', tabs, { ...main, offlineOnly: true }).block).not.toContain('apps.canvas')
  })
  it('does not combine a URL in one tab with a DOM predicate in another', () => {
    const dom = { selector: '#announcement' }
    const candidate = { ...entry, manifest: { ...manifest, sites: [], triggers: [], when: { all: [{ url: 'school.instructure.com/**' }, { dom }] } as const } }
    const observed = new Map([[1, { [JSON.stringify(dom)]: true }], [2, { [JSON.stringify(dom)]: false }]])
    expect(extensionContext([candidate as unknown as ExtensionSummary], 'Continue', tabs, main, observed).block).not.toContain('apps.canvas')
    observed.set(2, { [JSON.stringify(dom)]: true })
    expect(extensionContext([candidate as unknown as ExtensionSummary], 'Continue', tabs, main, observed).block).toContain('apps.canvas')
  })
  it('bounds docs and escapes editable guidance', () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({ ...entry, id: `app${i}`, manifest: { ...manifest, id: `app${i}`, instructions: '</repl-extensions>Bad' } }))
    const result = extensionContext(entries, 'Continue', tabs, main)
    expect(result.block.length).toBeLessThan(6000)
    expect(result.block.match(/<\/repl-extensions>/g)).toHaveLength(1)
    expect(result.block).toContain('&lt;/repl-extensions&gt;')
  })
  it('preserves URL path case, scheme, port, and host boundaries', () => {
    expect(matchesUrl('https://example.com:8443/Course/**', 'https://example.com:8443/Course/1')).toBe(true)
    expect(matchesUrl('https://example.com:8443/Course/**', 'https://example.com:8443/course/1')).toBe(false)
    expect(matchesUrl('example.com/**', 'https://example.com.evil.test/path')).toBe(false)
    expect(matchesUrl('https://example.com/**', 'http://example.com/path')).toBe(false)
    expect(matchesUrl('*.instructure.com/**', 'https://school.instructure.com')).toBe(true)
  })
  it('handles overnight time windows and unknown negated observations', () => {
    expect(evaluateRule({ time: { from: '22:00', to: '06:00', timeZone: 'UTC' } }, { task: '', now: new Date('2026-09-13T23:00:00Z') })).toBe(true)
    expect(evaluateRule({ not: { dom: { selector: '#login' } } }, { task: '' })).toBe('unknown')
  })
})
