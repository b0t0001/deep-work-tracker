interface TimerDialProps {
  /** 0..1 fraction of the planned duration consumed. */
  progress: number
  /** Pre-formatted countdown, e.g. "19:43". */
  clock: string
  /** Small line under the clock: status or preset. */
  caption: string
  variant: 'ring' | 'bar'
  dimmed: boolean
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
  dimmed
}: TimerDialProps): React.JSX.Element {
  const remaining = 1 - Math.min(1, Math.max(0, progress))

  if (variant === 'bar') {
    // Hourglass renders progress as a translucent panel sweeping behind the
    // text rather than a separate bar beneath it, which reads at a glance
    // without costing a row of height.
    return (
      <div className={`dial dial--bar${dimmed ? ' is-dimmed' : ''}`}>
        <div className="fill" style={{ transform: `scaleX(${remaining})` }} />
        <div className="dial__inner">
          <div className="dial__clock">{clock}</div>
          <div className="dial__caption">{caption}</div>
        </div>
      </div>
    )
  }

  return (
    <div className={`dial dial--ring${dimmed ? ' is-dimmed' : ''}`}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
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
      <div className="dial__inner">
        <div className="dial__clock">{clock}</div>
        <div className="dial__caption">{caption}</div>
      </div>
    </div>
  )
}
