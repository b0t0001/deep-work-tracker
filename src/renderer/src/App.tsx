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
import Icon from './components/Icon'

const MINUTE_MS = 60_000

/** Muted by default: the timer is meant to be glanced at, not looked at. */
const ACCENTS = [
  { name: 'Slate', value: '#94a3b8' },
  { name: 'Bone', value: '#d8d2c6' },
  { name: 'Sage', value: '#8faa8b' },
  { name: 'Steel', value: '#7f9cc0' },
  { name: 'Amber', value: '#d6a052' },
  { name: 'Teal', value: '#5eead4' }
] as const

const ACCENT_KEY = 'dwt.accent'

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

/** Browser storage can throw or come back empty, so every access is guarded. */
function useAccent(): [string, (value: string) => void] {
  const [accent, setAccent] = useState<string>(() => {
    try {
      return localStorage.getItem(ACCENT_KEY) ?? ACCENTS[0].value
    } catch {
      return ACCENTS[0].value
    }
  })

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent)
    try {
      localStorage.setItem(ACCENT_KEY, accent)
    } catch {
      // Private window or blocked storage; the colour simply will not persist.
    }
  }, [accent])

  return [accent, setAccent]
}

const CAPTIONS: Record<TimerSnapshot['status'], string> = {
  idle: 'ready',
  running: 'running',
  paused: 'paused',
  expired: 'time is up'
}

export default function App(): React.JSX.Element {
  const { snapshot, now } = useTimer()
  const [full, setFullScreen] = useFullScreen()
  const [accent, setAccent] = useAccent()
  const [label, setLabel] = useState('')
  const [minutes, setMinutes] = useState(60)
  const [variant, setVariant] = useState<'ring' | 'bar'>('bar')
  const [palette, setPalette] = useState(false)

  const idle = snapshot.status === 'idle'
  const clockMs = idle ? minutes * MINUTE_MS : remainingMs(snapshot, now)
  const fraction = idle ? 0 : progressOf(snapshot, now)
  const caption = idle ? `${minutes} min` : CAPTIONS[snapshot.status]

  function switchVariant(): void {
    const next = variant === 'ring' ? 'bar' : 'ring'
    setVariant(next)
    void window.api.window.fitVariant(next)
  }

  // Clicking anywhere that is not a field drops focus, so typing a label ends
  // by clicking the window rather than needing Tab or Enter.
  //
  // The palette is excluded deliberately: mousedown fires before click, so
  // closing it here unmounted the swatches before their click could land,
  // which is why picking a colour appeared to do nothing.
  function releaseFocus(event: React.MouseEvent): void {
    const target = event.target as Element | null
    if (target?.closest('input')) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    if (!target?.closest('.palette, .palette-toggle')) setPalette(false)
  }

  return (
    <div className={`card${full ? ' is-full' : ''}`} onMouseDown={releaseFocus}>
      <header className="card__head">
        <div className="tools">
          <button className="icon" onClick={switchVariant} title="Switch ring / bar">
            <Icon name={variant === 'ring' ? 'bar' : 'ring'} />
          </button>
          <button
            className="icon palette-toggle"
            onClick={() => setPalette(!palette)}
            title="Accent colour"
            style={{ color: accent }}
          >
            <Icon name="palette" />
          </button>
          <button
            className="icon"
            onClick={() => setFullScreen(!full)}
            title={full ? 'Exit full screen' : 'Full screen'}
          >
            <Icon name={full ? 'collapse' : 'expand'} />
          </button>
        </div>

        <input
          className="label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          placeholder="What are you working on?"
          spellCheck={false}
        />

        <div className="tools">
          <button
            className="icon"
            onClick={() => void window.api.window.minimize()}
            title="Minimise"
          >
            <Icon name="minimize" />
          </button>
          <button
            className="icon icon--danger"
            onClick={() => void window.api.window.close()}
            title="Close"
          >
            <Icon name="close" />
          </button>
        </div>
      </header>

      {palette && (
        <div className="palette">
          {ACCENTS.map((option) => (
            <button
              key={option.value}
              className={`swatch${option.value === accent ? ' is-active' : ''}`}
              style={{ background: option.value }}
              onClick={() => setAccent(option.value)}
              title={option.name}
            />
          ))}
        </div>
      )}

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
              <button
                className="primary primary--inline"
                onClick={() => void window.api.timer.start(minutes * MINUTE_MS)}
                title="Start"
              >
                <Icon name="play" />
              </button>
            </div>
          </>
        ) : (
          <div className="controls">
            {snapshot.status === 'running' ? (
              <button
                className="primary"
                onClick={() => void window.api.timer.pause()}
                title="Pause"
              >
                <Icon name="pause" />
              </button>
            ) : (
              <button
                className="primary"
                onClick={() => {
                  if (snapshot.status === 'paused') void window.api.timer.resume()
                  else void window.api.timer.start(snapshot.plannedMs)
                }}
                title={snapshot.status === 'paused' ? 'Resume' : 'Start again'}
              >
                <Icon name="play" />
              </button>
            )}
            <button
              className="ghost ghost--danger"
              onClick={() => void window.api.timer.stop()}
              title="Stop"
            >
              <Icon name="stop" />
            </button>
          </div>
        )}
      </footer>
    </div>
  )
}
