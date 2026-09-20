import { describe, expect, it } from 'vitest'
import {
  buildMessage,
  padStarterPrompts,
  parseCompletedPromptStrings,
  parsePrompts,
  STARTER_PROMPT_COUNT,
} from './starter-prompts'

describe('starter-prompts context', () => {
  it('includes complete memory data before recent browsing evidence', () => {
    const memory = JSON.stringify([
      {
        title: '[Stable] Writing preferences — tone and formatting',
        body: 'Prefers direct language and minimal formatting.',
        updated: '2026-08-06',
      },
    ])
    const prompt = buildMessage('- 2m ago — Canvas — school.instructure.com', 'Browser digest', memory)

    expect(prompt).toContain(`<memories>\n${memory}\n</memories>`)
    expect(prompt.indexOf(memory)).toBeLessThan(prompt.indexOf('## Most recent browsing'))
  })

  it('handles a profile with no memory without changing the prompt shape', () => {
    expect(buildMessage('', 'Browser digest')).toContain('<memories>\n[]\n</memories>')
  })
})

describe('starter-prompts padStarterPrompts', () => {
  const fallbacks = ['Fall one', 'Fall two', 'Fall three']

  it('tops a short set up to a full row, grounded suggestions first', () => {
    expect(padStarterPrompts(['Real one', 'Real two'], fallbacks)).toEqual([
      'Real one',
      'Real two',
      'Fall one',
      'Fall two',
    ])
  })

  it('leaves a full set alone and trims an over-long one', () => {
    const four = ['a', 'b', 'c', 'd']
    expect(padStarterPrompts(four, fallbacks)).toEqual(four)
    expect(padStarterPrompts([...four, 'e'], fallbacks)).toHaveLength(STARTER_PROMPT_COUNT)
  })

  it('does not pad an empty result — that means "keep what you had"', () => {
    expect(padStarterPrompts([], fallbacks)).toEqual([])
  })

  it('skips a fallback that duplicates a real suggestion, case-insensitively', () => {
    expect(padStarterPrompts(['fall ONE', 'Real'], fallbacks)).toEqual([
      'fall ONE',
      'Real',
      'Fall two',
      'Fall three',
    ])
  })
})

/**
 * A refresh that fails to parse silently keeps the previous prompts, so a broken
 * parser looks like "the feature does nothing". These cover the shapes the model
 * actually returns when it ignores "JSON only".
 */
describe('starter-prompts parsePrompts', () => {
  it('parses a clean object', () => {
    expect(parsePrompts('{"prompts":["Check my Example College assignments","Open my Supabase SQL editor"]}')).toEqual([
      'Check my Example College assignments',
      'Open my Supabase SQL editor',
    ])
  })

  it('tolerates code fences and surrounding prose', () => {
    expect(parsePrompts('```json\n{"prompts":["Summarize the ANTH module page"]}\n```')).toEqual([
      'Summarize the ANTH module page',
    ])
    expect(parsePrompts('Sure — here you go:\n{"prompts":["Open my Example University Canvas"]}\nHope that helps!')).toEqual([
      'Open my Example University Canvas',
    ])
  })

  it('survives a brace inside a prompt string', () => {
    expect(parsePrompts('{"prompts":["Fix the {id} route in my repo"]}')).toEqual(['Fix the {id} route in my repo'])
  })

  it('drops entries that are too long, empty, or the wrong type', () => {
    const out = parsePrompts(
      JSON.stringify({ prompts: ['ok one', '', 'x'.repeat(61), 42, null, 'ok two'] }),
    )
    expect(out).toEqual(['ok one', 'ok two'])
  })

  it('strips trailing periods and collapses whitespace', () => {
    expect(parsePrompts('{"prompts":["Check   my  grades."]}')).toEqual(['Check my grades'])
  })

  it('de-duplicates case-insensitively and caps at four', () => {
    const out = parsePrompts(
      JSON.stringify({ prompts: ['One', 'one', 'Two', 'Three', 'Four', 'Five'] }),
    )
    expect(out).toEqual(['One', 'Two', 'Three', 'Four'])
  })

  it('returns nothing for malformed or empty output', () => {
    expect(parsePrompts('')).toEqual([])
    expect(parsePrompts('NONE')).toEqual([])
    expect(parsePrompts('{"prompts":')).toEqual([])
    expect(parsePrompts('{"other":["nope"]}')).toEqual([])
  })
})

describe('starter-prompts parseCompletedPromptStrings', () => {
  it('keeps an incomplete first prompt hidden', () => {
    expect(parseCompletedPromptStrings('{"prompts":["Resume my product comp')).toEqual([])
  })

  it('reveals a prompt as soon as its closing quote arrives', () => {
    expect(parseCompletedPromptStrings('{"prompts":["Resume my product comparison"')).toEqual([
      'Resume my product comparison',
    ])
  })

  it('keeps a later incomplete prompt hidden while preserving the completed prefix', () => {
    expect(parseCompletedPromptStrings('{"prompts":["Resume my product comparison","Check my cour')).toEqual([
      'Resume my product comparison',
    ])
  })

  it('waits until the prompts field has begun', () => {
    expect(parseCompletedPromptStrings('{"prom')).toEqual([])
  })

  it('handles whitespace plus escaped quotes and backslashes', () => {
    expect(
      parseCompletedPromptStrings('prefix { "prompts" : [ "Open the \\"saved\\" list", "Check C:\\\\Users"'),
    ).toEqual(['Open the "saved" list', 'Check C:\\Users'])
  })
})
