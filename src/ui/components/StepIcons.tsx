/**
 * Step glyphs for the activity timeline: one quiet 16px stroke icon per kind
 * of work, so a row says what it was at a glance and the label can drop its
 * "Ran ·" / "Read ·" prefix. Drawn on a 16-unit grid at 1.3 stroke, round caps,
 * `currentColor` — they inherit the row's tier and tint red on failure.
 */
import type { StepIconName } from '../tool-labels'

const PATHS: Record<StepIconName, React.ReactNode> = {
  code: <path d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5" />,
  globe: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M2.6 8h10.8M8 2.4c1.55 1.6 2.3 3.5 2.3 5.6S9.55 12 8 13.6M8 2.4C6.45 4 5.7 5.9 5.7 8s.75 4 2.3 5.6" />
    </>
  ),
  pointer: <path d="M4.2 2.9v9.4l2.55-2.35 1.75 3.6 1.65-.8-1.75-3.55 3.4-.3z" />,
  type: <path d="M2.8 4.2h6.4M6 4.2v8M10.2 8.2h3M11.7 8.2v4" />,
  keyboard: (
    <>
      <rect x="1.9" y="4.2" width="12.2" height="7.6" rx="1.6" />
      <path d="M4.6 6.9h.01M7 6.9h.01M9.4 6.9h.01M11.6 6.9h.01M5.2 9.3h5.6" />
    </>
  ),
  scroll: <path d="M8 2.6v10.8M5.4 5.2 8 2.6l2.6 2.6M5.4 10.8 8 13.4l2.6-2.6" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5.1v3.1l2 1.3" />
    </>
  ),
  eye: (
    <>
      <path d="M1.9 8S4.1 3.9 8 3.9 14.1 8 14.1 8 11.9 12.1 8 12.1 1.9 8 1.9 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  camera: (
    <>
      <path d="M2.4 5.4h2.3l1.1-1.6h4.4l1.1 1.6h2.3v7.1H2.4z" />
      <circle cx="8" cy="8.8" r="2.1" />
    </>
  ),
  file: (
    <>
      <path d="M4 2.4h4.9L12 5.5v8.1H4z" />
      <path d="M8.8 2.4v3.2H12M6 8.6h4M6 10.9h2.8" />
    </>
  ),
  folder: <path d="M2.4 4.4h3.9l1.3 1.5h6v6.7H2.4z" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.1 10.1 3.4 3.4" />
    </>
  ),
  history: (
    <>
      <path d="M3.1 8a4.9 4.9 0 1 0 1.45-3.5M3 2.7v2.4h2.4" />
      <path d="M8 5.4V8l1.8 1.1" />
    </>
  ),
  bookmark: <path d="M4.6 2.5h6.8v11L8 11.1l-3.4 2.4z" />,
  download: <path d="M8 2.6v7.6M5 7.3 8 10.3l3-3M3 13h10" />,
  tabs: (
    <>
      <rect x="2.4" y="5" width="9.2" height="8" rx="1.3" />
      <path d="M4.8 2.9h7.4a1.4 1.4 0 0 1 1.4 1.4v6.4" />
    </>
  ),
  network: <path d="M1.8 8.4h2.6L6 4.6l2.6 6.8L10.2 8h4" />,
  shield: <path d="M8 2.2 13 4v3.9c0 3-2.1 5.1-5 5.9-2.9-.8-5-2.9-5-5.9V4z" />,
  archive: (
    <>
      <rect x="2.3" y="2.9" width="11.4" height="3.1" rx=".9" />
      <path d="M3.4 6v7.1h9.2V6M6.5 8.5h3" />
    </>
  ),
  artifact: (
    <>
      <rect x="2.3" y="2.9" width="11.4" height="10.2" rx="1.6" />
      <path d="M2.3 6h11.4M6.4 6v7.1" />
    </>
  ),
  alarm: (
    <>
      <circle cx="8" cy="8.6" r="4.9" />
      <path d="M8 6.1v2.7l1.6 1M2.9 3.6l1.6-1.3M13.1 3.6l-1.6-1.3" />
    </>
  ),
  note: <path d="M3 2.9h10v6.6l-3.5 3.6H3zM9.5 13.1V9.5H13" />,
  box: <path d="M8 2.4 13.1 5v6L8 13.6 2.9 11V5zM2.9 5 8 7.6 13.1 5M8 7.6v6" />,
  memory: <path d="M4.6 2.4h4.9L12 5v8.6H4.6zM6.6 8h3.6M6.6 10.3h2.4" />,
  agent: (
    <>
      <circle cx="6" cy="5.4" r="2.1" />
      <path d="M2.4 12.8c.4-2.1 1.8-3.3 3.6-3.3s3.2 1.2 3.6 3.3M10.6 3.5a2.1 2.1 0 0 1 0 3.9M11.9 9.7c1 .5 1.5 1.6 1.7 3.1" />
    </>
  ),
  thought: (
    <>
      <path d="M6.2 11.6h3.6M6.6 13.6h2.8" />
      <path d="M8 2.4a4 4 0 0 0-2.35 7.25c.3.25.45.6.45.95v.2h3.8v-.2c0-.35.15-.7.45-.95A4 4 0 0 0 8 2.4z" />
    </>
  ),
  question: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M6.4 6.3a1.7 1.7 0 0 1 3.25.7c0 1.15-1.65 1.4-1.65 2.5M8 11.3h.01" />
    </>
  ),
  reload: <path d="M13 8a5 5 0 1 1-1.47-3.54M13 2.8v2.6h-2.6" />,
  tool: <path d="M10.4 2.8a3 3 0 0 0-3.55 3.95L3 10.6 5.4 13l3.85-3.85a3 3 0 0 0 3.95-3.55l-1.9 1.9-1.65-.35-.35-1.65z" />,
}

export function StepIcon({ name }: { name: StepIconName }): React.ReactElement {
  return (
    <svg
      className="step-glyph"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

/** Disclosure chevron for timeline rows and headers (points right; CSS rotates it open). */
export function StepChevron(): React.ReactElement {
  return (
    <svg className="step-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
