/**
 * Blocking user-prompt primitive: a tool call that does not return until the
 * user answers a card rendered above the composer.
 *
 * The `ask_user` tool uses a declarative request shape. Adding a new kind of prompt must not
 * require touching the card component, so everything renderable (fields,
 * actions, notes, "always") lives in the request rather than in a per-consumer
 * React branch.
 *
 * The channel lives here rather than in the store because it is pure — no
 * chrome, no React — which is also what makes the three interesting paths
 * (answer, steer, cancel) testable without a browser.
 */

import { uid } from './ids'

export interface UserPromptField {
  id: string
  kind: 'text' | 'choice'
  label: string
  placeholder?: string
  /** kind: 'choice' — rendered as a row of small selectable pills. */
  options?: Array<{ id: string; label: string }>
  /** Prefill (a remembered preference). For 'choice', an option id. */
  value?: string
  required?: boolean
  /**
   * Fold this field behind a "Change" disclosure, with its value shown in a
   * one-line summary instead. For anything the caller could already work out
   * on the user's behalf: visible when they want it, out of the way when the
   * prefill is right — which is the common case, or it should not be a prefill.
   */
  advanced?: boolean
  /** kind: 'text' — offered as an autocomplete list, not as a restriction. */
  suggestions?: string[]
  /**
   * This field's default depends on another field's choice — e.g. the model
   * name follows the agent. When `fieldId` changes, the value is re-defaulted,
   * but ONLY if the user has not typed over it: a hand-entered value is an
   * instruction and must survive a change elsewhere on the card.
   */
  linkedTo?: { fieldId: string; defaults: Record<string, string> }
}

export interface UserPromptAction {
  id: string
  label: string
  tone?: 'primary' | 'neutral' | 'danger'
  /** Block this action until every `required` field has a value. */
  requiresFields?: boolean
}

export interface UserPromptRequest {
  id: string
  kind: 'question' | 'approval'
  /** One-line headline, e.g. "What firmness do you sleep on?" */
  title: string
  /** Longer body (may be long — e.g. a full prompt). Card shows a clamped
   *  preview with a clean affordance to view the whole thing. */
  detail?: string
  /** Label for the expand affordance, e.g. "View full prompt". */
  detailLabel?: string
  fields?: UserPromptField[]
  actions: UserPromptAction[]
  allowNotes?: boolean
  notesPlaceholder?: string
  /** Render an "Always allow in this chat" checkbox; echoed back as `always`. */
  allowAlways?: boolean
  alwaysLabel?: string
}

export type UserPromptAnswer =
  | { status: 'answered'; actionId: string; fields: Record<string, string>; notes?: string; always?: boolean }
  | { status: 'steered'; text: string }
  | { status: 'cancelled'; reason: 'stopped' | 'error' }

/** Injected from the store down to the tool layer. Main agent only. */
export type AskUserFn = (req: Omit<UserPromptRequest, 'id'>) => Promise<UserPromptAnswer>

/**
 * Per-chat pending prompts. One at a time per chat: the tool blocks, so a
 * second raise on the same chat can only mean the first was orphaned (a turn
 * that died without settling), and stranding its promise would hang that turn
 * forever — it is cancelled as an error instead.
 */
export interface UserPromptChannel {
  raise(chatId: string, req: Omit<UserPromptRequest, 'id'>): { request: UserPromptRequest; answer: Promise<UserPromptAnswer> }
  /** The chat's pending request, for the render mirror. */
  peek(chatId: string): UserPromptRequest | undefined
  /** Settle the chat's pending prompt. False when there was nothing pending. */
  resolve(chatId: string, answer: UserPromptAnswer): boolean
}

export function createUserPromptChannel(): UserPromptChannel {
  const pending = new Map<string, { request: UserPromptRequest; resolve: (a: UserPromptAnswer) => void }>()

  const resolve = (chatId: string, answer: UserPromptAnswer): boolean => {
    const entry = pending.get(chatId)
    if (!entry) return false
    pending.delete(chatId)
    entry.resolve(answer)
    return true
  }

  return {
    raise(chatId, req) {
      resolve(chatId, { status: 'cancelled', reason: 'error' })
      const request: UserPromptRequest = { ...req, id: uid('prompt') }
      const answer = new Promise<UserPromptAnswer>((res) => {
        pending.set(chatId, { request, resolve: res })
      })
      return { request, answer }
    },
    peek: (chatId) => pending.get(chatId)?.request,
    resolve,
  }
}

function fieldValueLabel(field: UserPromptField, value: string): string {
  if (field.kind !== 'choice') return value
  return field.options?.find((o) => o.id === value)?.label ?? value
}

/**
 * Render an answer for the model. Choice ids are resolved back to their labels
 * — the model wrote the labels and never saw the ids, so echoing ids would make
 * it re-derive the mapping from its own tool input.
 */
export function formatUserPromptAnswer(
  request: Omit<UserPromptRequest, 'id'>,
  answer: UserPromptAnswer,
): string {
  if (answer.status === 'steered') {
    return (
      'The user did not answer. They replied in the chat instead — their message is coming as a steering message. ' +
      'Read it before acting, and do not ask again.'
    )
  }
  if (answer.status === 'cancelled') {
    return answer.reason === 'stopped'
      ? 'The user stopped the turn without answering. Do not ask again; wind down and stop.'
      : 'The prompt was dismissed without an answer. Proceed with your best judgement, or state what you still need.'
  }

  const action = request.actions.find((a) => a.id === answer.actionId)
  const lines: string[] = []
  const fieldLines: string[] = []
  for (const field of request.fields ?? []) {
    const value = answer.fields[field.id]
    if (!value) continue
    fieldLines.push(`- ${field.label}: ${fieldValueLabel(field, value)}`)
  }
  // Fields the request never declared (a caller free-forming extra answers)
  // still reach the model rather than being silently dropped.
  for (const [id, value] of Object.entries(answer.fields)) {
    if (!value) continue
    if ((request.fields ?? []).some((f) => f.id === id)) continue
    fieldLines.push(`- ${id}: ${value}`)
  }
  // A single-action request (ask_user's "Send") carries no decision in the
  // button itself — naming it would just tell the model what it already knows.
  const soleAction = request.actions.length === 1
  lines.push(soleAction && fieldLines.length > 0 ? 'The user answered:' : `The user chose "${action?.label ?? answer.actionId}".`)
  lines.push(...fieldLines)
  if (answer.notes?.trim()) lines.push(`- Notes: ${answer.notes.trim()}`)
  if (answer.always) lines.push('- The user asked not to be prompted about this again in this chat.')
  return lines.join('\n')
}

/** Whether every `required` field has a non-empty value (gates `requiresFields` actions). */
export function requiredFieldsSatisfied(request: UserPromptRequest, values: Record<string, string>): boolean {
  return (request.fields ?? []).every((f) => !f.required || Boolean(values[f.id]?.trim()))
}

/** Initial field values for the card: the request's prefills. */
export function initialFieldValues(request: UserPromptRequest): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of request.fields ?? []) {
    if (field.value !== undefined) values[field.id] = field.value
  }
  return values
}
