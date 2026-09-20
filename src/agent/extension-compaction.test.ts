import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { OpenAICompaction } from './compaction'
import { replContextMessage } from '../shared/repl-context'

const docs = '<repl-extensions>\napps.canvas.search({text:string}) — Search classes\n</repl-extensions>'
const opaque = { type: 'compaction', encrypted_content: 'opaque-state' }
const item = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] })
const count = (value: unknown) => JSON.stringify(value).match(/<repl-extensions>/g)?.length ?? 0

describe('custom REPL docs in the actual post-compaction request', () => {
  it.each([false, true])('restores dropped docs and never duplicates retained docs (retained=%s)', async (retained) => {
    const compaction = new OpenAICompaction({ modelId: 'test', contextWindow: 1000, agentId: 'main', signal: new AbortController().signal, emit: () => {}, replContext: () => docs })
    let checkpoint: ModelMessage | undefined
    compaction.prepare([], (saved) => { checkpoint = saved })
    const bodies: any[] = []
    const fetcher: typeof fetch = async (url, init) => {
      const body = JSON.parse(init!.body as string); bodies.push(body)
      return String(url).endsWith('/compact') ? Response.json({ output: retained ? [opaque, item(replContextMessage(docs))] : [opaque], usage: { output_tokens: 5 } }) : Response.json({})
    }
    await compaction.wrapFetch(fetcher)('https://test/responses', { body: JSON.stringify({ input: [item('history '.repeat(500)), item(replContextMessage(docs))] }) })
    expect(bodies).toHaveLength(2)
    expect(count(bodies[1].input)).toBe(1)
    expect(bodies[1].input).toContainEqual(opaque)
    expect(JSON.stringify(bodies[1])).toContain('apps.canvas.search')
    const next = compaction.prepare([checkpoint!, { role: 'user', content: 'Continue' }], () => {})
    await compaction.wrapFetch(fetcher)('https://test/responses', { body: JSON.stringify({ input: next }) })
    expect(count(bodies.at(-1).input)).toBe(1)
  })
  it('deduplicates docs restored by the general post-compaction context callback', async () => {
    const compaction = new OpenAICompaction({ modelId: 'test', contextWindow: 1000, agentId: 'main', signal: new AbortController().signal, emit: () => {}, replContext: () => docs })
    compaction.prepare([], async () => ({ role: 'user', content: `<context source="harness">\n<active-task>Continue the task</active-task>\n${docs}\n</context>` }))
    let sent: any
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/compact')) return Response.json({ output: [opaque] })
      sent = JSON.parse(init!.body as string); return Response.json({})
    }
    await compaction.wrapFetch(fetcher)('https://test/responses', { body: JSON.stringify({ input: [item('x'.repeat(2000))] }) })
    expect(count(sent.input)).toBe(1)
    expect(JSON.stringify(sent)).toContain('Continue the task')
  })
  it('persists readable docs beside streamed compaction and updates revisions on resume', async () => {
    let current = docs
    const compaction = new OpenAICompaction({ modelId: 'test', contextWindow: 1000, agentId: 'main', signal: new AbortController().signal, emit: () => {}, serverSide: true, replContext: () => current })
    compaction.prepare([], () => {})
    const streamFetch: typeof fetch = async () => new Response(`data: ${JSON.stringify({ type: 'response.output_item.done', item: opaque })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`)
    await (await compaction.wrapFetch(streamFetch)('https://test/responses', { body: JSON.stringify({ input: [item('history')] }) })).text()
    const saved = compaction.takeCheckpoint()!
    expect(count(saved)).toBe(1)
    current = docs.replace('search(', 'searchModules(')
    const suffix = compaction.prepare([saved, { role: 'user', content: 'Next task' }], () => {})
    let sent: any
    await compaction.wrapFetch(async (_url, init) => { sent = JSON.parse(init!.body as string); return Response.json({}) })('https://test/responses', { body: JSON.stringify({ input: suffix }) })
    expect(count(sent.input)).toBe(1)
    expect(JSON.stringify(sent)).toContain('searchModules')
    expect(JSON.stringify(sent)).not.toContain('canvas.search(')
    expect(sent.context_management[0].compact_threshold).toBe(400)
  })
})
