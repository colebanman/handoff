/**
 * Banner shown while the running turn is paused at a step checkpoint (every
 * STEP_CHECKPOINT steps — there is no hard step cap). The agent is holding
 * between requests until the user decides: Continue grants another
 * checkpoint's worth of steps, Stop ends the turn gracefully with what it has.
 * Typing a message instead also counts as Continue (see addSteering).
 */
import type { StepPrompt } from '../store'

export function StepPromptBanner({
  prompt,
  onAnswer,
}: {
  prompt: StepPrompt
  onAnswer: (keepGoing: boolean) => void
}): React.ReactElement {
  return (
    <div className="step-prompt" role="status">
      <span className="step-prompt__dot" aria-hidden="true" />
      <span className="step-prompt__text">
        This task is taking a while — {prompt.steps} steps so far. Continue?
      </span>
      <button type="button" className="btn btn--ghost step-prompt__btn" onClick={() => onAnswer(false)}>
        Stop
      </button>
      <button type="button" className="btn btn--primary step-prompt__btn" onClick={() => onAnswer(true)}>
        Continue
      </button>
    </div>
  )
}
