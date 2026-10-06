import { describe, expect, it } from 'vitest'
import { canResumeExecution, recordForResume } from './execution-recovery'
import type { ExecutionSnapshot } from './execution-protocol'

function snapshot(tail: ExecutionSnapshot['record']['transcript']): ExecutionSnapshot {
  return {
    runId: 'run', ownerId: 'host', chatId: 'chat', status: 'interrupted',
    startedAt: 1, updatedAt: 2, eventSeq: 0, committedTranscriptLength: 1,
    record: { id: 'chat', title: 'Task', createdAt: 1, updatedAt: 2, modelId: 'gpt-6-sol',
      messages: [{ role: 'user', content: 'Do the task' }], checkpoints: [],
      transcript: [{ kind: 'user', id: 'user', text: 'Do the task', at: 1 }, ...tail] },
  }
}

describe('execution recovery boundary', () => {
  it('allows a partial model response to resume from the saved step', () => {
    const interrupted = snapshot([{ kind: 'text', id: 'part', agentId: 'main', text: 'Partial', streaming: true }])
    expect(canResumeExecution(interrupted)).toBe(true)
    expect(recordForResume(interrupted.record, interrupted.committedTranscriptLength).transcript)
      .toEqual(interrupted.record.transcript.slice(0, 1))
    expect(recordForResume(interrupted.record, 1).messages).toBe(interrupted.record.messages)
  })

  it('refuses to replay a step after a tool may have changed state', () => {
    expect(canResumeExecution(snapshot([{ kind: 'tool', id: 'write', agentId: 'main', toolName: 'browser_click', inputText: '{}', status: 'done', at: 2 }]))).toBe(false)
  })
})
