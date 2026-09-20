import { describe, expect, it } from 'vitest'
import { buildMessage, MAX_FEEDBACK_SAMPLES, sanitize, MAX_SUGGESTION_CHARS } from './next-prompt'

/**
 * The sanitizer is what stops a wrong-register suggestion reaching the composer.
 * The prompt already asks for the user's voice; these cases cover what happens
 * when the model ignores it, which it will.
 */
describe('next-prompt sanitize', () => {
  it('passes a plain suggestion through untouched, preserving the user’s style', () => {
    // Deliberately lowercase and abbreviated: "correcting" this would defeat the
    // entire point of feeding the model voice samples.
    expect(sanitize('can u check my example college assignments too')).toBe(
      'can u check my example college assignments too',
    )
  })

  it('returns undefined for the explicit NONE escape', () => {
    expect(sanitize('NONE')).toBeUndefined()
    expect(sanitize('  none  ')).toBeUndefined()
  })

  it('returns undefined for empty or whitespace-only output', () => {
    expect(sanitize('')).toBeUndefined()
    expect(sanitize('   \n  ')).toBeUndefined()
  })

  it('strips code fences and takes the first line with content', () => {
    expect(sanitize('```\nnow do the same for my Example College english class\n```')).toBe(
      'now do the same for my Example College english class',
    )
    expect(sanitize('\n\nopen the supabase sql editor\nsecond line ignored')).toBe(
      'open the supabase sql editor',
    )
  })

  it('strips self-added quotes and list markers', () => {
    expect(sanitize('"summarize the anth final project"')).toBe('summarize the anth final project')
    expect(sanitize('“check my example university canvas”')).toBe('check my example university canvas')
    expect(sanitize('- push that to a file')).toBe('push that to a file')
    expect(sanitize('> push that to a file')).toBe('push that to a file')
  })

  it('rejects assistant-voice openers even when well formed', () => {
    for (const text of [
      'Would you like me to check the other course?',
      'Shall I open the assignment page?',
      'Do you want a summary of that?',
      "I'll check the other classes next",
      'I can also export it to a file',
      "Here's what I found",
      'Let me know if you want more',
      'Anything else you need?',
    ]) {
      expect(sanitize(text), text).toBeUndefined()
    }
  })

  it('rejects output longer than the composer can show', () => {
    expect(sanitize('x'.repeat(MAX_SUGGESTION_CHARS + 1))).toBeUndefined()
    expect(sanitize('x'.repeat(MAX_SUGGESTION_CHARS))).toHaveLength(MAX_SUGGESTION_CHARS)
  })

  it('does not mistake a legitimate first-person request for assistant voice', () => {
    // "I" alone must not trip the filter — users say "i need", "i want".
    expect(sanitize('i need the due dates in a file')).toBe('i need the due dates in a file')
    expect(sanitize('can i get that as a csv')).toBe('can i get that as a csv')
  })
})

describe('next-prompt feedback context', () => {
  it('labels rejected guesses separately from what the user actually sent', () => {
    const prompt = buildMessage(
      {
        userMessages: ['give me three options'],
        feedback: [
          {
            suggested: 'yes i like option one',
            sentInstead: 'I like option three because it is simpler',
          },
        ],
        finalText: 'Here are the revised options with the third one simplified.',
      },
      'Here are the revised options with the third one simplified.',
    )

    expect(prompt).toContain('Rejected auto-suggestion: yes i like option one')
    expect(prompt).toContain('User sent instead: I like option three because it is simpler')
  })

  it('includes only the most recent bounded set of rewrites', () => {
    const feedback = Array.from({ length: MAX_FEEDBACK_SAMPLES + 2 }, (_, index) => ({
      suggested: `guess ${index}`,
      sentInstead: `actual ${index}`,
    }))
    const prompt = buildMessage(
      { userMessages: [], feedback, finalText: 'A sufficiently long final response for prediction.' },
      'A sufficiently long final response for prediction.',
    )

    expect(prompt).not.toContain('Rejected auto-suggestion: guess 0\n')
    expect(prompt).not.toContain('Rejected auto-suggestion: guess 1\n')
    expect(prompt).toContain('Rejected auto-suggestion: guess 2\n')
  })

  it('includes the complete memory snapshot as delimited data', () => {
    const memory = JSON.stringify([
      {
        title: '[Current] Example College — school and Canvas context',
        body: 'Verified Canvas: https://school.instructure.com.',
        updated: '2026-08-06',
      },
    ])
    const prompt = buildMessage(
      { userMessages: ['can u check canvas'], finalText: 'I found the course dashboard and its upcoming work.' },
      'I found the course dashboard and its upcoming work.',
      memory,
    )

    expect(prompt).toContain('<memories>\n')
    expect(prompt).toContain(memory)
    expect(prompt).toContain('\n</memories>')
  })

  it('keeps missing memory backward-compatible as an empty data array', () => {
    const prompt = buildMessage(
      { userMessages: ['continue'], finalText: 'The current task is complete and ready for review.' },
      'The current task is complete and ready for review.',
    )
    expect(prompt).toContain('<memories>\n[]\n</memories>')
  })
})
