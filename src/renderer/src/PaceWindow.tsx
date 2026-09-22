import { useEffect, useRef, useState } from 'react'
import { formatClock, idleTimer, runningMs, type TimerSnapshot } from '@shared/timer'
import { paceCue, primeAudio } from './lib/sounds'
import { useAccentSync } from './lib/accent'

interface PaceConfig {
  intervalMs: number
  quantity: number | null
  unit: string | null
}

const SIZE = 120
const STROKE = 9
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * The pace loop's own window: a small circle beside the timer it belongs to.
 *
 * It is a view onto the parent's clock, not a second one. Everything shown is
 * derived from the parent's snapshot, so the two can never drift apart, and it
 * records nothing - the session it paces is the only thing written.
 */
export default function PaceWindow(): React.JSX.Element {
  useAccentSync()
  const [snapshot, setSnapshot] = useState<TimerSnapshot>(idleTimer)
  const [config, setConfig] = useState<PaceConfig | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())
  const [flashing, setFlashing] = useState(false)
  const frame = useRef<number>(0)

  useEffect(() => {
    void window.api.pace.state().then((state) => {
      if (!state) return
      setSnapshot(state.snapshot)
      setConfig(state.config)
    })
    const offUpdate = window.api.timer.onUpdate(setSnapshot)
    const offConfig = window.api.pace.onConfig(setConfig)
    const offPace = window.api.timer.onPace(() => {
      paceCue()
      setFlashing(true)
      window.setTimeout(() => setFlashing(false), 620)
    })
    return () => {
      offUpdate()
      offConfig()
      offPace()
    }
  }, [])

  useEffect(() => {
    if (snapshot.status !== 'running') return
    const loop = (): void => {
      setNow(Date.now())
      frame.current = requestAnimationFrame(loop)
    }
    frame.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame.current)
  }, [snapshot.status])

  const interval = config?.intervalMs ?? 0
  const running = runningMs(snapshot, now)
  // Position within the current lap, so the ring restarts every interval while
  // the parent's own countdown keeps running underneath it.
  const elapsedInLap = interval > 0 ? running % interval : 0
  const remaining = interval > 0 ? interval - elapsedInLap : 0
  const laps = interval > 0 ? Math.floor(running / interval) : 0
  const fraction = interval > 0 ? elapsedInLap / interval : 0
  const target = config?.quantity == null ? null : config.quantity * (laps + 1)

  return (
    <div
      className={`pace-card${flashing ? ' is-flashing' : ''}${
        snapshot.status === 'paused' ? ' is-dimmed' : ''
      }`}
      onMouseDown={primeAudio}
    >
      <button
        className="pace-card__close"
        onClick={() => void window.api.pace.close()}
        title="Remove the pace loop"
      >
        &times;
      </button>

      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
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
            strokeDashoffset={CIRCUMFERENCE * fraction}
          />
        </g>
      </svg>

      <div className="pace-card__face">
        <div className="pace-card__clock">{formatClock(remaining)}</div>
        <div className="pace-card__target">
          {target === null
            ? `lap ${laps + 1}`
            : `${target}${config?.unit ? ` ${config.unit}` : ''}`}
        </div>
      </div>
    </div>
  )
}
