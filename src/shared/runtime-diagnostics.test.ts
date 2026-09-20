import { expect, it } from 'vitest'
import { beginDiagnosticOperation, diagnosticOperations } from './runtime-diagnostics'
it('retains pending work and moves it to bounded recent history when it finishes', () => {
  const operation = beginDiagnosticOperation('api', 'page.eval', { chatId: 'trace-test', tabId: 3, detail: 'https://example.com/course?token=secret' })
  operation.update('waiting for result')
  expect(diagnosticOperations().pending.find(op => op.id === operation.id)).toMatchObject({ stage: 'waiting for result', tabId: 3 })
  operation.finish(new Error('Timed out'))
  operation.finish()
  expect(diagnosticOperations().pending.some(op => op.id === operation.id)).toBe(false)
  const recent = diagnosticOperations().recent.filter(op => op.id === operation.id)
  expect(recent).toHaveLength(1)
  expect(recent[0]?.error).toContain('Timed out')
  expect(recent[0]?.detail).not.toContain('secret')
})
