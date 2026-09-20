interface TimerDialProps {
  /** 0..1 fraction of the planned duration consumed. */
  progress: number
  /** Pre-formatted countdown, e.g. "19:43". */
  clock: string
  /** Small line under the clock: status or preset. */
  caption: string
  variant: 'ring' | 'bar'
  dimmed: boolean
  /**
   * Lift the text when controls occupy the lower half of the ring. Without it
   * the clock stays centred while the buttons hang below, so the group as a
   * whole reads as bottom-heavy even though the clock itself is centred.
   */
  liftText: boolean
}

const SIZE = 196
const STROKE = 12
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const CENTRE = SIZE / 2

/** Clear space between the inside of the stroke and anything drawn within it. */
const BUFFER = 10
/** Radius the text must stay inside: inner edge of the stroke, less the buffer. */
const SAFE_RADIUS = RADIUS - STROKE / 2 - BUFFER

const CAPTION_SIZE = 13

/**
 * Largest font size whose text box still fits inside SAFE_RADIUS.
 *
 * Drawing the text inside the SVG rather than layering HTML over it means the
 * fit is geometric: both scale with the same viewBox, so the digits can never
 * collide with the ring at any window size. Ratios are for tabular figures -
 * digits run about 0.58em, colons about 0.30em.
 */
function fitFontSize(text: string): number {
  const digits = (text.match(/\d/g) ?? []).length
  const colons = text.length - digits
  const widthPerEm = digits * 0.58 + colons * 0.3
  const halfWidth = widthPerEm / 2
  const halfHeight = 0.36
  // (halfWidth * F)^2 + (halfHeight * F)^2 <= SAFE_RADIUS^2
  const limit = SAFE_RADIUS / Math.hypot(halfWidth, halfHeight)
  return Math.floor(limit)
}

export default function TimerDial({
  progress,
  clock,
  caption,
  variant,
  dimmed,
  liftText
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

  const clockSize = fitFontSize(clock)
  const clockY = CENTRE - CAPTION_SIZE * 0.6 - (liftText ? 14 : 0)
  const captionY = clockY + clockSize * 0.5 + CAPTION_SIZE

  return (
    <div className={`dial dial--ring${dimmed ? ' is-dimmed' : ''}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${clock} ${caption}`}>
        {/* Rotated so the arc starts at twelve o'clock rather than three. */}
        <g transform={`rotate(-90 ${CENTRE} ${CENTRE})`}>
          <circle className="ring__track" cx={CENTRE} cy={CENTRE} r={RADIUS} strokeWidth={STROKE} />
          <circle
            className="ring__value"
            cx={CENTRE}
            cy={CENTRE}
            r={RADIUS}
            strokeWidth={STROKE}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - remaining)}
          />
        </g>
        <text
          className="ring__clock"
          x={CENTRE}
          y={clockY}
          fontSize={clockSize}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {clock}
        </text>
        <text
          className="ring__caption"
          x={CENTRE}
          y={captionY}
          fontSize={CAPTION_SIZE}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {caption}
        </text>
      </svg>
    </div>
  )
}
