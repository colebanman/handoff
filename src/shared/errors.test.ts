import { describe, expect, it } from 'vitest'
import { formatErrorWithStack } from './errors'
import { LOCAL_SNAPSHOT_REPLAY_BUDGET_CHARS, snapshotBudgetForModel } from './types'

/** Stand-in for the AI SDK's APICallError, which we duck-type. */
function apiCallError(statusCode: number, responseBody: string): Error {
  return Object.assign(new Error('Bad Request'), {
    name: 'AI_APICallError',
    statusCode,
    responseBody,
  })
}

describe('formatErrorWithStack', () => {
  it("surfaces a FastAPI `detail` that the SDK message throws away", () => {
    // Example of a local model server context-overflow response. Without this
    // the debug log shows only "Bad Request" and the cause is unrecoverable.
    const body = JSON.stringify({
      detail: 'prompt is 45231 tokens, over the served limit of 32768',
    })

    const text = formatErrorWithStack(apiCallError(400, body))

    expect(text).toContain('Bad Request')
    expect(text).toContain('HTTP 400')
    expect(text).toContain('over the served limit of 32768')
  })

  it('surfaces an OpenAI-shaped error.message', () => {
    const body = JSON.stringify({ error: { message: 'context_length_exceeded' } })
    expect(formatErrorWithStack(apiCallError(400, body))).toContain('context_length_exceeded')
  })

  it('falls back to the raw body when it is not JSON', () => {
    expect(formatErrorWithStack(apiCallError(502, 'upstream timed out'))).toContain('upstream timed out')
  })

  it('caps a long body so one error cannot flood the log', () => {
    const text = formatErrorWithStack(apiCallError(500, 'y'.repeat(5_000)))
    expect(text).toContain('[+4400 chars]')
    expect(text.length).toBeLessThan(2_000)
  })

  it('leaves an ordinary Error untouched', () => {
    const text = formatErrorWithStack(new Error('plain failure'))
    expect(text).toContain('plain failure')
    expect(text).not.toContain('HTTP')
  })

  it('handles an aborted turn, which carries no HTTP fields', () => {
    const text = formatErrorWithStack(Object.assign(new Error('Aborted'), { name: 'DOMException' }))
    expect(text).toContain('Aborted')
    expect(text).not.toContain('HTTP')
  })
})

describe('snapshotBudgetForModel', () => {
  it('budgets the locally served Qwen adapters', () => {
    expect(snapshotBudgetForModel('handoff-qwen3.5-4b-secondary')).toBe(
      LOCAL_SNAPSHOT_REPLAY_BUDGET_CHARS,
    )
    expect(snapshotBudgetForModel('handoff-qwen3.5-4b')).toBe(
      LOCAL_SNAPSHOT_REPLAY_BUDGET_CHARS,
    )
  })

  it('leaves every hosted model unbudgeted', () => {
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-luna', 'grok-4.6', 'grok-4.6-fast', 'openai/gpt-5.6-sol']) {
      expect(snapshotBudgetForModel(id)).toBeUndefined()
    }
  })

  it('leaves a custom openai-compatible id unbudgeted', () => {
    // A user's own proxy may serve anything; only the curated local entries
    // are known to be 32K.
    expect(snapshotBudgetForModel('my-own-llama')).toBeUndefined()
  })
})
