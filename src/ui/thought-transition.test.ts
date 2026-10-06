import { expect, it } from 'vitest'
import { thoughtLabel, thoughtLabelKey } from './tool-labels'

const key = (text: string) => thoughtLabelKey(text, thoughtLabel(text, true).label)

it('keeps a streamed ATX heading in one animation phase', () => {
  expect(key('# Checking the layout')).toBe(key('# Checking'))
  expect(key('# Checking the layout\n\nBody text')).toBe(key('# Checking'))
})

it('crossfades when a new heading arrives, including a repeated title', () => {
  expect(key('# Checking\n\nBody\n\n# Checking')).not.toBe(key('# Checking'))
})

it('does not treat headings inside a code fence as new phases', () => {
  expect(key('# Checking\n\n```\n# Example\n```')).toBe(key('# Checking'))
})

it('changes phase when the current complete prose sentence changes', () => {
  expect(key('Checking the page.')).not.toBe(key('Checking the page. Found it.'))
})
