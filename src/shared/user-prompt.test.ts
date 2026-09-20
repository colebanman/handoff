import { describe, expect, it } from 'vitest'
import {
  createUserPromptChannel,
  formatUserPromptAnswer,
  initialFieldValues,
  requiredFieldsSatisfied,
  type UserPromptAnswer,
  type UserPromptRequest,
} from './user-prompt'

function question(over: Partial<UserPromptRequest> = {}): Omit<UserPromptRequest, 'id'> {
  return {
    kind: 'question',
    title: 'What firmness do you sleep on?',
    fields: [
      {
        id: 'answer',
        kind: 'choice',
        label: 'Answer',
        required: true,
        options: [
          { id: 'opt-1', label: 'Firm' },
          { id: 'opt-2', label: 'Medium' },
        ],
      },
    ],
    actions: [{ id: 'send', label: 'Send', tone: 'primary', requiresFields: true }],
    allowNotes: true,
    ...over,
  }
}

/** Nothing settles the promise until the user acts — the tool call blocks. */
async function settled(promise: Promise<UserPromptAnswer>): Promise<UserPromptAnswer | 'pending'> {
  return Promise.race([promise, Promise.resolve<'pending'>('pending')])
}

describe('user prompt channel', () => {
  it('blocks until the user answers, then hands back exactly what they chose', async () => {
    const channel = createUserPromptChannel()
    const { request, answer } = channel.raise('chat-1', question())

    expect(await settled(answer)).toBe('pending')
    expect(channel.peek('chat-1')).toBe(request)

    channel.resolve('chat-1', { status: 'answered', actionId: 'send', fields: { answer: 'opt-1' }, notes: 'nothing hot' })

    expect(await answer).toEqual({
      status: 'answered',
      actionId: 'send',
      fields: { answer: 'opt-1' },
      notes: 'nothing hot',
    })
    expect(channel.peek('chat-1')).toBeUndefined()
  })

  it('resolves as steered when the user replies in the composer instead', async () => {
    const channel = createUserPromptChannel()
    const { answer } = channel.raise('chat-1', question())

    expect(channel.resolve('chat-1', { status: 'steered', text: 'actually medium, and under $1200' })).toBe(true)

    expect(await answer).toEqual({ status: 'steered', text: 'actually medium, and under $1200' })
    // A second settle (e.g. Stop right after steering) is a no-op, not a throw.
    expect(channel.resolve('chat-1', { status: 'cancelled', reason: 'stopped' })).toBe(false)
  })

  it('cancels on stop, and leaves other chats parked', async () => {
    const channel = createUserPromptChannel()
    const one = channel.raise('chat-1', question())
    const two = channel.raise('chat-2', question())

    channel.resolve('chat-1', { status: 'cancelled', reason: 'stopped' })

    expect(await one.answer).toEqual({ status: 'cancelled', reason: 'stopped' })
    expect(await settled(two.answer)).toBe('pending')
    expect(channel.peek('chat-2')).toBeDefined()
  })

  it('never strands an orphaned prompt when a chat raises a second one', async () => {
    const channel = createUserPromptChannel()
    const first = channel.raise('chat-1', question())
    const second = channel.raise('chat-1', question({ title: 'Budget?' }))

    expect(await first.answer).toEqual({ status: 'cancelled', reason: 'error' })
    expect(channel.peek('chat-1')).toBe(second.request)
  })
})

describe('answer formatting for the model', () => {
  it('resolves choice ids back to the labels the model wrote', () => {
    expect(
      formatUserPromptAnswer(question(), {
        status: 'answered',
        actionId: 'send',
        fields: { answer: 'opt-2' },
        notes: 'side sleeper',
      }),
    ).toBe('The user answered:\n- Answer: Medium\n- Notes: side sleeper')
  })

  it('names the action when there was a real decision, and echoes "always"', () => {
    const approval = question({
      kind: 'approval',
      title: 'Run this migration?',
      fields: [],
      actions: [
        { id: 'approve', label: 'Approve', tone: 'primary' },
        { id: 'reject', label: 'Reject', tone: 'danger' },
      ],
    })
    const text = formatUserPromptAnswer(approval, {
      status: 'answered',
      actionId: 'approve',
      fields: {},
      always: true,
    })
    expect(text).toContain('The user chose "Approve".')
    expect(text).toContain('not to be prompted about this again')
  })

  it('tells the model the steer text is coming, without repeating it', () => {
    const text = formatUserPromptAnswer(question(), { status: 'steered', text: 'medium, under $1200' })
    expect(text).toContain('steering message')
    expect(text).not.toContain('$1200')
  })

  it('gives a recoverable line for each cancellation reason', () => {
    expect(formatUserPromptAnswer(question(), { status: 'cancelled', reason: 'stopped' })).toContain('stopped the turn')
    expect(formatUserPromptAnswer(question(), { status: 'cancelled', reason: 'error' })).toContain('best judgement')
  })
})

describe('field gating', () => {
  const req: UserPromptRequest = { ...question(), id: 'p1' }

  it('holds a requiresFields action until every required field has a value', () => {
    expect(requiredFieldsSatisfied(req, {})).toBe(false)
    expect(requiredFieldsSatisfied(req, { answer: '   ' })).toBe(false)
    expect(requiredFieldsSatisfied(req, { answer: 'opt-1' })).toBe(true)
  })

  it('seeds the card from remembered prefills only', () => {
    const prefilled: UserPromptRequest = {
      ...req,
      fields: [
        { id: 'answer', kind: 'choice', label: 'Answer', value: 'opt-2', options: [] },
        { id: 'budget', kind: 'text', label: 'Budget' },
      ],
    }
    expect(initialFieldValues(prefilled)).toEqual({ answer: 'opt-2' })
  })
})
