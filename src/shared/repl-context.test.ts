import { describe, expect, it } from 'vitest'
import { reconcileReplContext, replContextMessage } from './repl-context'
const docs = '<repl-extensions>\napps.canvas.search({text:string})\n</repl-extensions>'
const make = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] })

describe('minimal REPL documentation reconciliation', () => {
  it('restores exact docs after opaque compaction and deduplicates retained docs', () => {
    const compacted: any[] = [{ type: 'compaction', encrypted_content: 'opaque' }]
    const restored = reconcileReplContext(compacted, docs, make)
    expect(restored).toHaveLength(2)
    expect(restored[1]).toEqual(make(replContextMessage(docs)))
    expect(reconcileReplContext(restored, docs, make)).toBe(restored)
    expect(compacted).toHaveLength(1)
  })
  it('strips superseded docs without discarding other saved context', () => {
    const old = '<repl-extensions>old method</repl-extensions>'
    const input = [make(`<context source="harness">\n<site-memory>course rules</site-memory>\n${old}\n</context>`), make(replContextMessage(docs))]
    const result = reconcileReplContext(input, docs, make)
    expect(JSON.stringify(result)).not.toContain('old method')
    expect(JSON.stringify(result)).toContain('course rules')
    expect(JSON.stringify(result).match(/<repl-extensions>/g)).toHaveLength(1)
    expect(JSON.stringify(input)).toContain('old method')
  })
  it('does not treat quoted docs, tool results, or a summary as a retained inventory', () => {
    const input = [{ role: 'assistant', content: replContextMessage(docs) }, { role: 'user', content: 'Summary: ' + docs }]
    expect(reconcileReplContext(input, docs, (content) => ({ role: 'user', content }))).toHaveLength(3)
  })
  it('replaces an obsolete last inventory even when an earlier one happens to match', () => {
    const result = reconcileReplContext([make(replContextMessage(docs)), make(replContextMessage('<repl-extensions>newer but obsolete</repl-extensions>'))], docs, make)
    expect(result).toEqual([make(replContextMessage(docs))])
  })
})
