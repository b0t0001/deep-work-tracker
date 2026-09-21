import { useEffect, useRef, useState } from 'react'
import {
  formatClock,
  progress as progressOf,
  remainingMs,
  idleTimer,
  type TimerSnapshot
} from '@shared/timer'
import TimerDial from './components/TimerDial'
import Icon from './components/Icon'

const MINUTE_MS = 60_000

/** Windows blue by default: familiar, and calm enough not to pull focus. */
const ACCENTS = [
  { name: 'Blue', value: '#0a84ff' },
  { name: 'Ruby', value: '#d92b4b' },
  { name: 'Purple', value: '#7c4dff' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Green', value: '#2eb85c' },
  { name: 'Orange', value: '#f28c28' },
  { name: 'Graphite', value: '#9aa0a6' }
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
  const [snapshot, setSnapshot] = useState<TimerSnapshot>(idleTimer)
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
      const stored = localStorage.getItem(ACCENT_KEY)
      // A colour saved before the palette changed is no longer selectable, so
      // it would apply with no swatch shown as active. Fall back instead.
      return ACCENTS.some((option) => option.value === stored) ? stored! : ACCENTS[0].value
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
  // The field holds text, not a number. Coercing on every keystroke meant
  // clearing it snapped straight back to 1, so it could never be emptied to
  // type a new value. Empty is a legitimate intermediate state; it just is not
  // a startable one.
  const [minutesInput, setMinutesInput] = useState('60')
  const customRef = useRef<HTMLInputElement>(null)

  const parsedMinutes = Number(minutesInput)
  const minutes =
    minutesInput !== '' && Number.isFinite(parsedMinutes) && parsedMinutes >= 1
      ? Math.min(600, Math.floor(parsedMinutes))
      : null
  const [variant, setVariant] = useState<'ring' | 'bar'>('bar')
  const [palette, setPalette] = useState(false)
  const [labelFocused, setLabelFocused] = useState(false)

  // While a field or the palette is open the card stops being a drag region.
  // Electron drag regions swallow mouse events outright, so without this a
  // click on the card body never reaches the handler that dismisses them -
  // which is why editing felt impossible to exit.
  const editing = labelFocused || palette

  const idle = snapshot.status === 'idle'
  const clockMs = idle ? (minutes ?? 0) * MINUTE_MS : remainingMs(snapshot, now)
  const fraction = idle ? 0 : progressOf(snapshot, now)
  const caption = idle ? (minutes ? `${minutes} min` : 'set a duration') : CAPTIONS[snapshot.status]

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

  const controlsNode = (
    <div className="controls">
      {snapshot.status === 'running' ? (
        <button className="primary" onClick={() => void window.api.timer.pause()} title="Pause">
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
  )

  return (
    <div
      className={`card${full ? ' is-full' : ''}${variant === 'ring' ? ' is-ring' : ''}${
        editing ? ' is-editing' : ''
      }`}
      onMouseDown={releaseFocus}
    >
      {/* The dial is rendered first and reordered visually with flexbox.
          Electron supports no-drag nested inside drag, but not the reverse, and
          it resolves overlapping regions by document order rather than z-index.
          Declaring the chrome after the dial is therefore what lets it receive
          hover, while the card stays draggable by the dial itself. */}
      <TimerDial
        progress={fraction}
        clock={formatClock(clockMs)}
        caption={caption}
        variant={variant}
        dimmed={snapshot.status === 'paused'}
        liftText={!idle}
        controls={!idle && variant === 'bar' ? controlsNode : undefined}
      />

      <header className="card__head">
        <div className="tools">
          <button
            className="icon"
            onClick={() => {
              const next = variant === 'ring' ? 'bar' : 'ring'
              setVariant(next)
              void window.api.window.setVariant(next)
            }}
            title="Switch ring / bar"
          >
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
          onChange={(event) => {
            setLabel(event.target.value)
            // Main owns the label so any stop path can record it, including
            // the auto-end that fires when a pause runs long.
            void window.api.timer.setTask(event.target.value)
          }}
          onFocus={() => setLabelFocused(true)}
          onBlur={() => setLabelFocused(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            // Tab goes to the duration, not to the window buttons. Labelling
            // then setting a time is the actual sequence; DOM order is not.
            if (event.key === 'Tab' && !event.shiftKey && customRef.current) {
              event.preventDefault()
              customRef.current.focus()
            }
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

      {(idle || variant === 'ring') && (
        <footer className="card__foot">
          {idle ? (
            <div className="presets">
              <input
                ref={customRef}
                className="chip chip--input"
                type="text"
                inputMode="numeric"
                value={minutesInput}
                onChange={(event) => {
                  const next = event.target.value
                  if (next === '' || /^\d{1,3}$/.test(next)) setMinutesInput(next)
                }}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && minutes !== null) {
                    void window.api.timer.start(minutes * MINUTE_MS)
                  }
                }}
                aria-label="Minutes"
              />
              <button
                className="primary primary--inline"
                disabled={minutes === null}
                onClick={() => {
                  if (minutes !== null) void window.api.timer.start(minutes * MINUTE_MS)
                }}
                title="Start"
              >
                <Icon name="play" />
              </button>
            </div>
          ) : (
            controlsNode
          )}
        </footer>
      )}
    </div>
  )
}
