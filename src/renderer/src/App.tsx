import { useEffect, useRef, useState } from 'react'
import {
  formatClock,
  idleTimer,
  progress as progressOf,
  remainingMs,
  type TimerSnapshot
} from '@shared/timer'
import { formatDurationInput, parseDurationMs } from '@shared/duration'
import { ACCENT_KEY, DEFAULT_ACCENT, isKnownAccent } from '@shared/accents'
import TimerDial from './components/TimerDial'
import { expiryCue, paceCue, primeAudio } from './lib/sounds'
import Icon from './components/Icon'

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

/**
 * Browser storage can throw or come back empty, so every access is guarded.
 * The `storage` event is what keeps this window in step with the settings
 * panel, which lives in a separate window sharing the same origin.
 */
function useAccent(): string {
  const [accent, setAccent] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(ACCENT_KEY)
      return isKnownAccent(stored) ? stored : DEFAULT_ACCENT
    } catch {
      return DEFAULT_ACCENT
    }
  })

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent)
  }, [accent])

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === ACCENT_KEY && isKnownAccent(event.newValue)) setAccent(event.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return accent
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
  useAccent()
  const [label, setLabel] = useState('')
  const [labelFocused, setLabelFocused] = useState(false)
  const [draft, setDraft] = useState('60:00')
  const [variant, setVariant] = useState<'ring' | 'bar'>('bar')
  const [flashing, setFlashing] = useState(false)
  const [paceNotice, setPaceNotice] = useState<string | null>(null)
  const [pace, setPace] = useState<{
    intervalMs: number
    quantity: number | null
    unit: string | null
  } | null>(null)

  const [paceOpen, setPaceOpen] = useState(false)
  const [paceEvery, setPaceEvery] = useState('')
  const [paceQty, setPaceQty] = useState('')
  const [paceUnit, setPaceUnit] = useState('')

  // The pace loop belongs to this window, so it is read back on mount in case
  // the renderer reloaded while one was running.
  useEffect(() => {
    void window.api.timer.getPace().then((config) => {
      if (!config) return
      setPace(config)
      setPaceEvery(String(Math.round(config.intervalMs / 60_000)))
      setPaceQty(config.quantity === null ? '' : String(config.quantity))
      setPaceUnit(config.unit ?? '')
    })
  }, [])

  /** An interval with no number is not a pace loop, so it switches off. */
  function applyPace(every: string, quantity: string, unit: string): void {
    const intervalMs = parseDurationMs(every)
    const config =
      intervalMs === null
        ? null
        : {
            intervalMs,
            quantity: quantity.trim() === '' ? null : Number(quantity),
            unit: unit.trim() === '' ? null : unit.trim()
          }
    setPace(config)
    void window.api.timer.setPace(config)
  }
  const [stopPrompt, setStopPrompt] = useState(false)
  const clockRef = useRef<HTMLInputElement>(null)

  // The pace loop cues and shows what should be done by now. It never asks for
  // anything: quantity is entered once, at stop, not mid-essay.
  useEffect(() => {
    return window.api.timer.onPace((event) => {
      paceCue()
      setPaceNotice(
        event.cumulativeTarget === null
          ? `pace ${event.loops}`
          : `target ${event.cumulativeTarget}${event.unit ? ` ${event.unit}` : ''}`
      )
      window.setTimeout(() => setPaceNotice(null), 4000)
    })
  }, [])

  // Expiry cue: sound plus a flash, matching Hourglass - three flashes at 0.2s.
  // Both matter, because either one alone is missable: the flash if the window
  // is buried, the sound if the room is loud.
  useEffect(() => {
    return window.api.timer.onExpired(() => {
      expiryCue()
      setFlashing(true)
      window.setTimeout(() => setFlashing(false), 620)
    })
  }, [])

  const idle = snapshot.status === 'idle'
  const plannedMs = parseDurationMs(draft)

  // While a field is focused the card stops being a drag region. Electron drag
  // regions swallow mouse events outright, so without this a click on the card
  // body never reaches the handler that drops focus.
  const editing = labelFocused || paceOpen

  const canonical = plannedMs === null ? null : formatDurationInput(plannedMs)

  const clockMs = idle ? (plannedMs ?? 0) : remainingMs(snapshot, now)
  const fraction = idle ? 0 : progressOf(snapshot, now)
  // While typing, the caption shows how the input was read, so `one hour`
  // confirms itself as 1:00:00 before you commit to it.
  const paceLabel =
    pace === null
      ? null
      : `${pace.quantity ?? ''}${pace.unit ? ` ${pace.unit}` : ''}`.trim() +
        `/${Math.round(pace.intervalMs / 60_000)}m`

  const caption = idle
    ? canonical === null
      ? 'enter a time'
      : canonical !== draft.trim()
        ? canonical
        : (paceLabel ?? 'ready')
    : CAPTIONS[snapshot.status]

  /** Rewrites the field into canonical form, so what was typed visibly took. */
  function normalizeDraft(): void {
    if (canonical !== null) setDraft(canonical)
  }

  function start(): void {
    if (plannedMs === null) return
    normalizeDraft()
    setStopPrompt(false)
    void window.api.timer.start(plannedMs)
  }

  /** Stopping opens a short window to undo it or say why - never a blocking one. */
  function stop(): void {
    void window.api.timer.stop()
    setStopPrompt(true)
    window.setTimeout(() => setStopPrompt(false), 30_000)
  }

  function answerStop(reason: string | null): void {
    if (reason) void window.api.timer.setStopReason(reason, null)
    setStopPrompt(false)
  }

  function undoStop(): void {
    void window.api.timer.undoStop()
    setStopPrompt(false)
  }

  function releaseFocus(event: React.MouseEvent): void {
    const target = event.target as Element | null
    if (target?.closest('input')) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  const controls = (
    <div className="controls">
      {snapshot.status === 'running' ? (
        <button className="primary" onClick={() => void window.api.timer.pause()} title="Pause">
          <Icon name="pause" />
        </button>
      ) : (
        <button
          className="primary"
          disabled={idle && plannedMs === null}
          onClick={() => {
            if (idle) start()
            else if (snapshot.status === 'paused') void window.api.timer.resume()
            else void window.api.timer.start(snapshot.plannedMs)
          }}
          title={idle ? 'Start' : snapshot.status === 'paused' ? 'Resume' : 'Start again'}
        >
          <Icon name="play" />
        </button>
      )}
      {!idle && (
        <button className="ghost ghost--danger" onClick={stop} title="Stop">
          <Icon name="stop" />
        </button>
      )}
    </div>
  )

  return (
    <div
      className={`card${full ? ' is-full' : ''}${variant === 'ring' ? ' is-ring' : ''}${
        editing ? ' is-editing' : ''
      }${flashing ? ' is-flashing' : ''}`}
      onMouseDown={(event) => {
        primeAudio()
        releaseFocus(event)
      }}
    >
      {/* The dial is declared before the chrome and reordered with flexbox.
          Electron supports no-drag nested inside drag but not the reverse, and
          resolves overlapping regions by document order rather than z-index, so
          this is what lets the chrome receive hover while the dial still drags. */}
      <TimerDial
        progress={fraction}
        clock={formatClock(clockMs)}
        caption={paceNotice ?? caption}
        variant={variant}
        dimmed={snapshot.status === 'paused'}
        editable={idle}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={start}
        onNormalize={normalizeDraft}
        inputRef={clockRef}
        controls={controls}
      />

      {paceOpen && (
        <div className="pace-panel">
          <div className="pace-panel__row">
            <span>every</span>
            <input
              value={paceEvery}
              placeholder="20"
              onChange={(event) => {
                setPaceEvery(event.target.value)
                applyPace(event.target.value, paceQty, paceUnit)
              }}
              aria-label="Pace interval"
            />
            <span>do</span>
            <input
              value={paceQty}
              placeholder="100"
              inputMode="numeric"
              onChange={(event) => {
                setPaceQty(event.target.value)
                applyPace(paceEvery, event.target.value, paceUnit)
              }}
              aria-label="Pace target"
            />
            <input
              value={paceUnit}
              placeholder="words"
              onChange={(event) => {
                setPaceUnit(event.target.value)
                applyPace(paceEvery, paceQty, event.target.value)
              }}
              aria-label="Pace unit"
            />
          </div>
          <button className="pace-panel__close" onClick={() => setPaceOpen(false)} title="Done">
            &times;
          </button>
        </div>
      )}

      {stopPrompt && (
        <div className="stop-prompt">
          <button className="stop-prompt__undo" onClick={undoStop} title="Resume the session">
            Undo
          </button>
          <button onClick={() => answerStop('finished_early')}>done</button>
          <button onClick={() => answerStop('tired')}>tired</button>
          <button onClick={() => answerStop('interrupted')}>cut off</button>
          <button className="stop-prompt__skip" onClick={() => answerStop(null)} title="Skip">
            &times;
          </button>
        </div>
      )}

      <header className="card__head">
        <div className="tools">
          <button
            className="icon"
            onClick={() => setVariant(variant === 'ring' ? 'bar' : 'ring')}
            title="Switch ring / bar"
          >
            <Icon name={variant === 'ring' ? 'bar' : 'ring'} />
          </button>
          <button
            className="icon"
            onClick={() => void window.api.window.newTimer()}
            title="New timer window"
          >
            <Icon name="plus" />
          </button>
          <button
            className="icon"
            onClick={() => void window.api.window.openDashboard()}
            title="Settings and data"
          >
            <Icon name="settings" />
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
            // Tab goes to the duration, not the window buttons: labelling the
            // session then setting its length is the actual sequence.
            if (event.key === 'Tab' && !event.shiftKey && clockRef.current) {
              event.preventDefault()
              clockRef.current.focus()
            }
          }}
          placeholder="What are you working on?"
          spellCheck={false}
        />

        <div className="tools">
          <button
            className={`icon${pace ? ' is-on' : ''}`}
            onClick={() => setPaceOpen(!paceOpen)}
            title={pace ? 'Pace loop (on)' : 'Add a pace loop'}
          >
            <Icon name="pace" />
          </button>
          <button
            className="icon"
            onClick={() => setFullScreen(!full)}
            title={full ? 'Exit full screen' : 'Full screen'}
          >
            <Icon name={full ? 'collapse' : 'expand'} />
          </button>
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
    </div>
  )
}
