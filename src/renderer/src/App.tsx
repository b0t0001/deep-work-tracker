import { useEffect, useRef, useState } from 'react'
import {
  IDLE_TIMER,
  PRESET_MINUTES,
  formatClock,
  progress as progressOf,
  remainingMs,
  type TimerSnapshot
} from '@shared/timer'
import TimerDial from './components/TimerDial'

const MINUTE_MS = 60_000

/**
 * Mirrors the main process's timer and drives a repaint clock.
 *
 * `now` exists only so the view can recompute from timestamps every frame.
 * A dropped frame cannot cause drift, because nothing here accumulates -
 * every value is derived from the snapshot plus the current time.
 */
function useTimer(): { snapshot: TimerSnapshot; now: number } {
  const [snapshot, setSnapshot] = useState<TimerSnapshot>(IDLE_TIMER)
  const [now, setNow] = useState<number>(() => Date.now())
  const frame = useRef<number>(0)

  useEffect(() => {
    let alive = true
    void window.api.timer.get().then((initial) => {
      if (alive) setSnapshot(initial)
    })
    const offUpdate = window.api.timer.onUpdate(setSnapshot)
    const offExpired = window.api.timer.onExpired(setSnapshot)
    return () => {
      alive = false
      offUpdate()
      offExpired()
    }
  }, [])

  useEffect(() => {
    // `now` only influences the display while the clock is running. When idle,
    // paused or expired, every derived value comes from banked time, so there
    // is nothing to refresh and no reason to setState on status change.
    if (snapshot.status !== 'running') return
    const loop = (): void => {
      setNow(Date.now())
      frame.current = requestAnimationFrame(loop)
    }
    frame.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame.current)
  }, [snapshot.status])

  return { snapshot, now }
}

function useFullScreen(): [boolean, (value: boolean) => void] {
  const [full, setFull] = useState(false)

  useEffect(() => {
    void window.api.window.isFullScreen().then(setFull)
    return window.api.window.onFullScreenChange(setFull)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void window.api.window.setFullScreen(false)
      if (event.key === 'F11') {
        event.preventDefault()
        void window.api.window.setFullScreen(!full)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [full])

  return [full, (value) => void window.api.window.setFullScreen(value)]
}

const CAPTIONS: Record<TimerSnapshot['status'], string> = {
  idle: 'ready',
  running: 'running',
  paused: 'paused',
  expired: "time's up"
}

export default function App(): React.JSX.Element {
  const { snapshot, now } = useTimer()
  const [full, setFullScreen] = useFullScreen()
  const [label, setLabel] = useState('')
  const [minutes, setMinutes] = useState(60)
  const [variant, setVariant] = useState<'ring' | 'bar'>('bar')

  const idle = snapshot.status === 'idle'
  const clockMs = idle ? minutes * MINUTE_MS : remainingMs(snapshot, now)
  const fraction = idle ? 0 : progressOf(snapshot, now)
  const caption = idle ? `${minutes} min` : CAPTIONS[snapshot.status]

  return (
    <div className={`card${full ? ' is-full' : ''}`}>
      <header className="card__head">
        <input
          className="label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="What are you working on?"
          spellCheck={false}
        />
        <div className="head__tools">
          <button
            className="icon"
            onClick={() => setVariant(variant === 'ring' ? 'bar' : 'ring')}
            title={`Switch to ${variant === 'ring' ? 'ring' : 'bar'}`}
          >
            {variant === 'ring' ? '▭' : '◯'}
          </button>
          <button
            className="icon"
            onClick={() => setFullScreen(!full)}
            title={full ? 'Exit full screen (Esc)' : 'Full screen (F11)'}
          >
            {full ? '⤡' : '⤢'}
          </button>
          {!full && (
            <button
              className="icon"
              onClick={() => void window.api.window.resetSize()}
              title="Reset to compact size"
            >
              ⧉
            </button>
          )}
        </div>
      </header>

      <TimerDial
        progress={fraction}
        clock={formatClock(clockMs)}
        caption={caption}
        variant={variant}
        dimmed={snapshot.status === 'paused'}
      />

      <footer className="card__foot">
        {idle ? (
          <>
            <div className="presets">
              {PRESET_MINUTES.map((preset) => (
                <button
                  key={preset}
                  className={`chip${preset === minutes ? ' is-active' : ''}`}
                  onClick={() => setMinutes(preset)}
                >
                  {preset}
                </button>
              ))}
              <input
                className="chip chip--input"
                type="number"
                min={1}
                max={600}
                value={minutes}
                onChange={(event) => setMinutes(Math.max(1, Number(event.target.value) || 1))}
                aria-label="Custom minutes"
              />
            </div>
            <button
              className="primary"
              onClick={() => void window.api.timer.start(minutes * MINUTE_MS)}
            >
              Start
            </button>
          </>
        ) : (
          <div className="controls">
            {snapshot.status === 'running' && (
              <button className="primary" onClick={() => void window.api.timer.pause()}>
                Pause
              </button>
            )}
            {snapshot.status === 'paused' && (
              <button className="primary" onClick={() => void window.api.timer.resume()}>
                Resume
              </button>
            )}
            {snapshot.status === 'expired' && (
              <button
                className="primary"
                onClick={() => void window.api.timer.start(snapshot.plannedMs)}
              >
                Again
              </button>
            )}
            <button className="ghost" onClick={() => void window.api.timer.stop()}>
              Stop
            </button>
          </div>
        )}
      </footer>
    </div>
  )
}
