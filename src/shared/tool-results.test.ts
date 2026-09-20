import { expect, it } from 'vitest'
import { toolResultError, toolResultImage } from './tool-results'

it('recognizes native and browser failures without discarding native codes', () => {
  expect(toolResultError('Error: timeout')).toEqual({ message: 'timeout' })
  expect(toolResultError('Error [user_interrupted] User took control')).toEqual({ code: 'user_interrupted', message: 'User took control' })
  expect(toolResultError('Error[stale_reference]: refresh')).toEqual({ code: 'stale_reference', message: 'refresh' })
  expect(toolResultError({ ok: false, error: { code: 'denied', message: 'App is out of scope' } })).toEqual({ code: 'denied', message: 'App is out of scope' })
  expect(toolResultError({ error: 'Native call failed', code: 'timeout' })).toEqual({ code: 'timeout', message: 'Native call failed' })
  expect(toolResultError('No errors found')).toBeUndefined()
  expect(toolResultError({ ok: true, error: null })).toBeUndefined()
})

it('renders both existing browser and persisted native image formats', () => {
  expect(toolResultImage({ base64: 'abc', mediaType: 'image/png' })).toBe('data:image/png;base64,abc')
  expect(toolResultImage({ data: 'abc', mimeType: 'image/jpeg', target: { pid: 12 } })).toBe('data:image/jpeg;base64,abc')
  expect(toolResultImage({ base64: 'data:image/png;base64,abc' })).toBe('data:image/png;base64,abc')
  expect(toolResultImage({ data: 'a normal data result' })).toBeUndefined()
  expect(toolResultImage({ data: 'abc', mimeType: 'application/pdf' })).toBeUndefined()
})
