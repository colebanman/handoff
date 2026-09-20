import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/types'
import {
  answerUserPrompt,
  appendNextPromptFeedback,
  hasOnboardingSetupCredential,
  latestCompletedMainResponse,
  requestUserPrompt,
  shouldBootstrapExistingUserMemory,
  shouldOfferNextPrompt,
} from './store'

/** A turn that finished cleanly with an answer worth continuing from. */
function cleanTurn(over: Partial<Parameters<typeof shouldOfferNextPrompt>[0]> = {}): Parameters<
  typeof shouldOfferNextPrompt
>[0] {
  return {
    settings: {},
    hadError: false,
    aborted: false,
    deadTurn: false,
    finalText: 'Pulled the three prices into /workspace/prices.md — Best Buy was cheapest.',
    followUpPending: false,
    credentialReady: true,
    ...over,
  }
}

describe('next-prompt offer gate', () => {
  it('offers after a clean turn, and treats the absent toggle as ON', () => {
    expect(shouldOfferNextPrompt(cleanTurn())).toBe(true)
    expect(shouldOfferNextPrompt(cleanTurn({ settings: { suggestNextPrompt: true } }))).toBe(true)
  })

  it('respects the opt-out', () => {
    expect(shouldOfferNextPrompt(cleanTurn({ settings: { suggestNextPrompt: false } }))).toBe(false)
  })

  it('stays quiet on turns that did not end well', () => {
    expect(shouldOfferNextPrompt(cleanTurn({ hadError: true }))).toBe(false)
    expect(shouldOfferNextPrompt(cleanTurn({ aborted: true }))).toBe(false)
    expect(shouldOfferNextPrompt(cleanTurn({ deadTurn: true }))).toBe(false)
  })

  it('stays quiet when there is nothing to continue from', () => {
    expect(shouldOfferNextPrompt(cleanTurn({ finalText: '' }))).toBe(false)
    expect(shouldOfferNextPrompt(cleanTurn({ finalText: '   \n ' }))).toBe(false)
  })

  it('stays quiet when another turn is already queued behind this one', () => {
    expect(shouldOfferNextPrompt(cleanTurn({ followUpPending: true }))).toBe(false)
  })

  it('stays quiet without a credential the cheap model can run on', () => {
    expect(shouldOfferNextPrompt(cleanTurn({ credentialReady: false }))).toBe(false)
  })
})

describe('next-prompt feedback capture', () => {
  it('records a different message as a rejected suggestion rewrite', () => {
    expect(appendNextPromptFeedback([], 'yes i like option one', 'I like option three')).toEqual([
      { suggested: 'yes i like option one', sentInstead: 'I like option three' },
    ])
  })

  it('does not record an accepted suggestion', () => {
    const existing = [{ suggested: 'old guess', sentInstead: 'old rewrite' }]
    expect(appendNextPromptFeedback(existing, 'send this', '  send this  ')).toBe(existing)
  })

  it('keeps only the six latest rewrites', () => {
    let feedback: NonNullable<import('../shared/types').ChatRecord['nextPromptFeedback']> = []
    for (let index = 0; index < 8; index += 1) {
      feedback = appendNextPromptFeedback(feedback, `guess ${index}`, `rewrite ${index}`)
    }
    expect(feedback).toHaveLength(6)
    expect(feedback[0]).toEqual({ suggested: 'guess 2', sentInstead: 'rewrite 2' })
  })
})

describe('next-prompt context restored on chat open', () => {
  it('recovers the latest completed main-agent reply after the latest user message', () => {
    expect(
      latestCompletedMainResponse({
        checkpoints: [],
        turns: [],
        transcript: [
          { kind: 'user', id: 'u1', text: 'check this', at: 1 },
          { kind: 'text', id: 'a1', agentId: 'main', text: 'Earlier response', streaming: false },
          { kind: 'user', id: 'u2', text: 'now compare them', at: 2 },
          { kind: 'reasoning', id: 'r2', agentId: 'main', text: 'Done thinking', streaming: false },
          { kind: 'text', id: 'a2', agentId: 'main', text: 'The second option is cheaper.', streaming: false },
          { kind: 'memory', id: 'm2', agentId: 'main', titles: ['Preference'], forgotten: [], at: 3 },
        ],
      }),
    ).toBe('The second option is cheaper.')
  })

  it('does not reuse an older response when the latest user turn has no completed answer', () => {
    expect(
      latestCompletedMainResponse({
        checkpoints: [],
        turns: [],
        transcript: [
          { kind: 'user', id: 'u1', text: 'first', at: 1 },
          { kind: 'text', id: 'a1', agentId: 'main', text: 'First answer', streaming: false },
          { kind: 'user', id: 'u2', text: 'second', at: 2 },
        ],
      }),
    ).toBeUndefined()
  })

  it('ignores unfinished streamed text after a restart', () => {
    expect(
      latestCompletedMainResponse({
        checkpoints: [{ id: 'cp1', userItemId: 'u1', userText: 'check this', at: 2, transcriptIndexBefore: 0, messageCountBefore: 0 }],
        turns: [],
        transcript: [
          { kind: 'user', id: 'u1', text: 'check this', at: 1 },
          { kind: 'text', id: 'a1', agentId: 'main', text: 'Partial answer', streaming: true },
        ],
      }),
    ).toBeUndefined()
  })

  it('accepts settled text when completion metadata covers the latest checkpoint', () => {
    expect(
      latestCompletedMainResponse({
        checkpoints: [{ id: 'cp1', userItemId: 'u1', userText: 'check this', at: 2, transcriptIndexBefore: 0, messageCountBefore: 0 }],
        turns: [{ at: 3, wallMs: 10, modelId: 'test', provider: 'openai' }],
        transcript: [
          { kind: 'user', id: 'u1', text: 'check this', at: 2 },
          { kind: 'text', id: 'a1', agentId: 'main', text: 'Completed answer', streaming: false },
        ],
      }),
    ).toBe('Completed answer')
  })
})

describe('existing-user memory bootstrap', () => {
  it('runs once for a profile that is past onboarding', () => {
    expect(shouldBootstrapExistingUserMemory(false, 0)).toBe(true)
    expect(shouldBootstrapExistingUserMemory(false, 1)).toBe(false)
  })

  it('does not race first-run onboarding', () => {
    expect(shouldBootstrapExistingUserMemory(true, 0)).toBe(false)
  })

  it('recognizes both OpenAI API-key and connected ChatGPT profiles', () => {
    expect(
      hasOnboardingSetupCredential(
        { ...DEFAULT_SETTINGS, provider: 'openai', openaiAuthMode: 'api-key', apiKey: 'sk-test' },
        false,
      ),
    ).toBe(true)
    expect(
      hasOnboardingSetupCredential(
        { ...DEFAULT_SETTINGS, provider: 'openai', openaiAuthMode: 'chatgpt', apiKey: '' },
        true,
      ),
    ).toBe(true)
    expect(
      hasOnboardingSetupCredential(
        { ...DEFAULT_SETTINGS, provider: 'openai', openaiAuthMode: 'chatgpt', apiKey: '' },
        false,
      ),
    ).toBe(false)
  })

  it('can use a vaulted OpenAI key while another direct provider is active', () => {
    expect(
      hasOnboardingSetupCredential(
        {
          ...DEFAULT_SETTINGS,
          provider: 'xai',
          modelId: 'grok-4.3',
          apiKey: 'xai-key',
          apiKeys: { xai: 'xai-key', openai: 'sk-test' },
        },
        false,
      ),
    ).toBe(true)
  })

  it('can use the active non-OpenAI model while ChatGPT is signed out', () => {
    expect(
      hasOnboardingSetupCredential(
        {
          ...DEFAULT_SETTINGS,
          provider: 'xai',
          modelId: 'grok-4.6',
          openaiAuthMode: 'chatgpt',
          apiKey: 'xai-key',
          apiKeys: { xai: 'xai-key' },
        },
        false,
      ),
    ).toBe(true)
  })
})

describe('blocking user prompts (store wiring)', () => {
  it('parks the turn until the answer arrives on that chat', async () => {
    const pending = requestUserPrompt('chat-a', {
      kind: 'question',
      title: 'Firm or soft?',
      actions: [{ id: 'send', label: 'Send' }],
    })

    // Another chat's card must not settle this one — prompts are chat-scoped.
    answerUserPrompt('chat-b', { actionId: 'send', fields: {} })
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending')

    answerUserPrompt('chat-a', { actionId: 'send', fields: { answer: 'firm' } })
    await expect(pending).resolves.toEqual({ status: 'answered', actionId: 'send', fields: { answer: 'firm' } })
  })
})
