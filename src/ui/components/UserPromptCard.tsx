/**
 * The card a blocked turn is waiting on: it sits in the same band as the
 * step-checkpoint banner, directly above the composer, and holds the tool call
 * open until one of its actions is pressed.
 *
 * Everything it draws comes from the request (see src/shared/user-prompt.ts) —
 * ask_user renders through this component. That is the point of the
 * primitive: a new prompt shape should be a new payload, not a new component.
 *
 * The composer stays live underneath, so the card never traps the user: typing
 * an answer there settles the prompt as 'steered' (see addSteering).
 */
import { useState } from 'react'
import {
  initialFieldValues,
  requiredFieldsSatisfied,
  type UserPromptField,
  type UserPromptRequest,
} from '../../shared/user-prompt'

export interface UserPromptSubmission {
  actionId: string
  fields: Record<string, string>
  notes?: string
  always?: boolean
}

function toneClass(tone: string | undefined): string {
  if (tone === 'primary') return 'btn btn--primary'
  if (tone === 'danger') return 'btn btn--ghost user-prompt__btn--danger'
  return 'btn btn--ghost'
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: UserPromptField
  value: string
  onChange: (next: string) => void
}): React.ReactElement {
  if (field.kind === 'choice') {
    return (
      <div className="user-prompt__field" role="group" aria-label={field.label}>
        <div className="user-prompt__pills">
          {(field.options ?? []).map((option) => (
            <button
              key={option.id}
              type="button"
              className={`user-prompt__pill${value === option.id ? ' is-selected' : ''}`}
              aria-pressed={value === option.id}
              // Re-pressing the selected pill clears it: a required choice made
              // by mistake would otherwise be unrecoverable without a reload.
              onClick={() => onChange(value === option.id ? '' : option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  // A labelled row, not a bare box. Three stacked inputs distinguishable only
  // by their placeholder is what the approval card looked like before, and a
  // placeholder disappears exactly when the user starts needing it.
  const listId = field.suggestions?.length ? `up-${field.id}-list` : undefined
  return (
    <label className="user-prompt__field user-prompt__field--text">
      <span className="user-prompt__label">{field.label}</span>
      <input
        className="user-prompt__input"
        type="text"
        value={value}
        placeholder={field.placeholder}
        list={listId}
        onChange={(e) => onChange(e.target.value)}
      />
      {listId ? (
        <datalist id={listId}>
          {field.suggestions?.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
    </label>
  )
}

/**
 * `/Users/me/thing` reads as `~/thing` — the prefix is never the informative
 * part, and it is what pushes the interesting tail out of a one-line summary.
 * Windows (`C:\\Users\\me`) and Linux (`/home/me`) included: this panel runs
 * wherever Chrome does, and the daemon it talks to is on the same machine.
 */
function shorten(value: string): string {
  const posix = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(value)
  if (posix) return `~${posix[1] ?? ''}`
  const win = /^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/.exec(value)
  return win ? `~${win[1] ?? ''}` : value
}

export function UserPromptCard({
  prompt,
  onAnswer,
}: {
  prompt: UserPromptRequest
  onAnswer: (submission: UserPromptSubmission) => void
}): React.ReactElement {
  const [values, setValues] = useState<Record<string, string>>(() => initialFieldValues(prompt))
  const [notes, setNotes] = useState('')
  const [always, setAlways] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Opens by itself when a prefill is missing: a summary reading "Not set" over
  // a disabled Approve button would be a puzzle rather than a shortcut.
  const [showAdvanced, setShowAdvanced] = useState(
    () => !(prompt.fields ?? []).every((f) => !f.advanced || !f.required || Boolean(f.value?.trim())),
  )

  const fields = prompt.fields ?? []
  const plainFields = fields.filter((f) => !f.advanced)
  const advancedFields = fields.filter((f) => f.advanced)
  const summary = advancedFields
    .map((f) => values[f.id]?.trim())
    .filter(Boolean)
    .map((value) => shorten(value as string))
    .join(' · ')

  /**
   * Apply one field's change, then re-default anything linked to it. Without
   * this a card with dependent fields can hand back a combination the user
   * never chose while a stale value stays folded away behind "Change".
   */
  const change = (fieldId: string, next: string): void => {
    const updated = { ...values, [fieldId]: next }
    for (const field of fields) {
      if (field.linkedTo?.fieldId !== fieldId) continue
      const wasDefault = (values[field.id] ?? '') === (field.linkedTo.defaults[values[fieldId] ?? ''] ?? '')
      if (wasDefault) updated[field.id] = field.linkedTo.defaults[next] ?? ''
    }
    setValues(updated)
  }

  const satisfied = requiredFieldsSatisfied(prompt, values)
  const submit = (actionId: string): void =>
    onAnswer({
      actionId,
      fields: values,
      notes: notes.trim() || undefined,
      always: always || undefined,
    })

  return (
    <div className="user-prompt" role="group" aria-label={prompt.title}>
      <div className="user-prompt__title">{prompt.title}</div>

      {prompt.detail ? (
        <>
          <div className={`user-prompt__detail${expanded ? ' is-expanded' : ''}`}>{prompt.detail}</div>
          <button type="button" className="user-prompt__more" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : (prompt.detailLabel ?? 'Show more')}
          </button>
        </>
      ) : null}

      {plainFields.map((field) => (
        <FieldRow
          key={field.id}
          field={field}
          value={values[field.id] ?? ''}
          onChange={(next) => change(field.id, next)}
        />
      ))}

      {advancedFields.length > 0 ? (
        <div className="user-prompt__advanced">
          {/* The toggle heads the section rather than trailing it. Trailing, it
              sat immediately above the notes input and read as that input's
              label — "Done" over a text box is a caption, not a control. */}
          <div className="user-prompt__advanced-head">
            <div className="user-prompt__summary">{showAdvanced ? '' : summary || 'Not set'}</div>
            <button type="button" className="user-prompt__more" onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? 'Done' : 'Change'}
            </button>
          </div>
          {showAdvanced
            ? advancedFields.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  value={values[field.id] ?? ''}
                  onChange={(next) => change(field.id, next)}
                />
              ))
            : null}
        </div>
      ) : null}

      {prompt.allowNotes ? (
        <input
          className="user-prompt__input user-prompt__notes"
          type="text"
          value={notes}
          placeholder={prompt.notesPlaceholder ?? 'Add a note (optional)'}
          aria-label="Notes"
          onChange={(e) => setNotes(e.target.value)}
        />
      ) : null}

      <div className="user-prompt__footer">
        {prompt.allowAlways ? (
          <label className="user-prompt__always">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            {prompt.alwaysLabel ?? 'Always allow in this chat'}
          </label>
        ) : null}
        <div className="user-prompt__actions">
          {prompt.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`${toneClass(action.tone)} user-prompt__btn`}
              disabled={action.requiresFields && !satisfied}
              onClick={() => submit(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
