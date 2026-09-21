import type { RefObject } from 'react'

interface TimerDialProps {
  /** 0..1 fraction of the planned duration consumed. */
  progress: number
  /** Pre-formatted countdown, shown when the clock is not editable. */
  clock: string
  caption: string
  variant: 'ring' | 'bar'
  dimmed: boolean
  /** Idle: the clock itself is the duration field, as in Hourglass. */
  editable: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: () => void
  inputRef: RefObject<HTMLInputElement | null>
  /** Pause / stop / start, rendered directly beneath the clock in both dials. */
  controls: React.ReactNode
}

const SIZE = 196
const STROKE = 12
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export default function TimerDial({
  progress,
  clock,
  caption,
  variant,
  dimmed,
  editable,
  draft,
  onDraftChange,
  onSubmit,
  inputRef,
  controls
}: TimerDialProps): React.JSX.Element {
  const remaining = 1 - Math.min(1, Math.max(0, progress))

  const face = (
    <div className="dial__inner">
      {editable ? (
        <input
          ref={inputRef}
          className="dial__clock dial__clock--input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit()
          }}
          spellCheck={false}
          aria-label="Duration"
        />
      ) : (
        <div className="dial__clock">{clock}</div>
      )}
      <div className="dial__caption">{caption}</div>
      {controls}
    </div>
  )

  if (variant === 'bar') {
    // Hourglass renders progress as a translucent panel sweeping behind the
    // text rather than a separate bar beneath it: readable at a glance, and it
    // costs no height.
    return (
      <div className={`dial dial--bar${dimmed ? ' is-dimmed' : ''}`}>
        <div className="fill" style={{ transform: `scaleX(${remaining})` }} />
        {face}
      </div>
    )
  }

  return (
    <div className={`dial dial--ring${dimmed ? ' is-dimmed' : ''}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        {/* Rotated so the arc starts at twelve o'clock rather than three. */}
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          <circle
            className="ring__track"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            strokeWidth={STROKE}
          />
          <circle
            className="ring__value"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            strokeWidth={STROKE}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - remaining)}
          />
        </g>
      </svg>
      {face}
    </div>
  )
}
