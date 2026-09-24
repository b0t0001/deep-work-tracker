import { useEffect, useRef, useState } from 'react'
import {
  formatClock,
  idleTimer,
  progress as progressOf,
  remainingMs,
  type TimerSnapshot
} from '@shared/timer'
import { formatDurationInput, parseDurationMs } from '@shared/duration'
import { canonicalProjectName, rankProjects } from '@shared/projects'
import TimerDial from './components/TimerDial'
import { expiryCue, primeAudio } from './lib/sounds'
import { useAccentSync } from './lib/accent'
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

export default function App(): React.JSX.Element {
  const { snapshot, now } = useTimer()
  const [full, setFullScreen] = useFullScreen()
  useAccentSync()
  const [label, setLabel] = useState('')
  const [labelFocused, setLabelFocused] = useState(false)
  const [project, setProject] = useState('')
  const [projectFocused, setProjectFocused] = useState(false)
  const [projectNames, setProjectNames] = useState<string[]>([])
  const [projectOpen, setProjectOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [draft, setDraft] = useState('1:00:00')
  const [variant, setVariant] = useState<'ring' | 'bar'>('bar')
  const [flashing, setFlashing] = useState(false)
  const [pace, setPace] = useState<{
    intervalMs: number
    quantity: number | null
    unit: string | null
  } | null>(null)

  const [paceOpen, setPaceOpen] = useState(false)
  const paceEveryRef = useRef<HTMLInputElement>(null)
  const paceQtyRef = useRef<HTMLInputElement>(null)
  const paceUnitRef = useRef<HTMLInputElement>(null)
  const [paceEvery, setPaceEvery] = useState('')
  const [paceQty, setPaceQty] = useState('')
  const [paceUnit, setPaceUnit] = useState('')

  // The pace loop belongs to this window, so it is read back on mount in case
  // the renderer reloaded while one was running.
  // Opening the panel puts the caret in the first field, so it can be filled
  // without reaching for the mouse.
  useEffect(() => {
    if (paceOpen) paceEveryRef.current?.focus()
  }, [paceOpen])

  useEffect(() => {
    void window.api.timer.getPace().then((config) => {
      if (!config) return
      setPace(config)
      setPaceEvery(String(Math.round(config.intervalMs / 60_000)))
      setPaceQty(config.quantity === null ? '' : String(config.quantity))
      setPaceUnit(config.unit ?? '')
    })
  }, [])

  function closePace(): void {
    setPaceOpen(false)
    clockRef.current?.focus()
  }

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
  /**
   * The project defaults to whatever the last session was filed under, because
   * work comes in runs - several HW sessions, then several on the essay - so
   * the previous answer is nearly always this one too. The list feeds a
   * ranked suggestion list rather than a plain dropdown: it both offers what
   * exists and accepts a name that does not, and it matches on more than a
   * literal prefix so `hw`, `HW 2` and a typo all find the same project.
   */
  useEffect(() => {
    void window.api.timer.projectNames().then(setProjectNames)
    void window.api.timer.lastProject().then((name) => {
      if (!name) return
      setProject(name)
      void window.api.timer.setProject(name)
    })
  }, [])

  /**
   * Ranked suggestions for what is in the field, best first.
   *
   * Recomputed every keystroke rather than debounced: the list is at most a
   * few dozen names and the match runs in microseconds, so the lag of a
   * debounce would be the only thing you could feel.
   */
  const matches = rankProjects(project, projectNames, 4)

  /** Committing snaps to an existing name when one plainly means the same. */
  function commitProject(value: string): void {
    const canonical = canonicalProjectName(value, projectNames) ?? value
    setProject(canonical)
    void window.api.timer.setProject(canonical)
    setProjectOpen(false)
  }

  function chooseProject(name: string): void {
    setProject(name)
    void window.api.timer.setProject(name)
    setProjectOpen(false)
  }

  const [stopPrompt, setStopPrompt] = useState(false)
  const [qty, setQty] = useState('')
  const [qtyUnit, setQtyUnit] = useState('')
  const qtyRef = useRef<HTMLInputElement>(null)
  const qtyUnitRef = useRef<HTMLInputElement>(null)
  const dismissRef = useRef<number | null>(null)
  const clockRef = useRef<HTMLInputElement>(null)

  // Closing the pace window means "remove this", so the fields clear with it.
  useEffect(() => {
    return window.api.pace.onCleared(() => {
      setPace(null)
      setPaceEvery('')
      setPaceQty('')
      setPaceUnit('')
    })
  }, [])

  // Ending with the session means "that one is over" - the values stay, so the
  // same pace can be re-armed for the next run with one click.
  useEffect(() => {
    return window.api.pace.onEnded(() => setPace(null))
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
  const editing = labelFocused || projectFocused || paceOpen

  const canonical = plannedMs === null ? null : formatDurationInput(plannedMs)

  const paceLabel =
    pace === null
      ? null
      : `${pace.quantity ?? ''}${pace.unit ? ` ${pace.unit}` : ''}`.trim() +
        `/${Math.round(pace.intervalMs / 60_000)}m`

  const clockMs = idle ? (plannedMs ?? 0) : remainingMs(snapshot, now)
  const fraction = idle ? 0 : progressOf(snapshot, now)
  /**
   * The line under the clock is the project, not the status.
   *
   * `ready` / `running` told the user something the clock already says - the
   * digits are counting or they are not - while the thing they actually need
   * to see, and the thing that belongs on camera, is what the session is for.
   *
   * It yields only while a duration is being typed, because the echo that
   * confirms `one hour` as `1:00:00` before it is committed is load-bearing
   * and has nowhere else to go.
   */
  const typingDuration = idle && (canonical === null || canonical !== draft.trim())
  const caption: React.ReactNode = typingDuration ? (
    (canonical ?? 'enter a time')
  ) : (
    <div className="project-box">
      <input
        className="dial__project"
        value={project}
        placeholder="project"
        spellCheck={false}
        autoComplete="off"
        title="Which category this session counts towards"
        onChange={(event) => {
          setProject(event.target.value)
          setProjectOpen(true)
          setHighlight(0)
          // Main owns it for the same reason it owns the task: auto-end can
          // record a session this window never sees stop.
          void window.api.timer.setProject(event.target.value)
        }}
        onFocus={() => {
          setProjectFocused(true)
          setProjectOpen(true)
          setHighlight(0)
        }}
        onBlur={() => {
          setProjectFocused(false)
          // A click on a suggestion fires blur first, so closing is deferred
          // by a tick or the mousedown never lands.
          window.setTimeout(() => setProjectOpen(false), 120)
          commitProject(project)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setProjectOpen(true)
            setHighlight((h) => Math.min(h + 1, matches.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlight((h) => Math.max(h - 1, 0))
          } else if (event.key === 'Escape') {
            setProjectOpen(false)
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            // Enter takes the highlighted suggestion when the list is open -
            // that is what makes it behave like a dropdown - and otherwise
            // just commits what was typed.
            const pick = projectOpen ? matches[highlight] : undefined
            if (pick) {
              event.preventDefault()
              chooseProject(pick.name)
            } else {
              commitProject(project)
            }
            if (event.key === 'Enter') event.currentTarget.blur()
          }
        }}
      />
      {projectOpen && matches.length > 0 && (
        <ul className="project-menu">
          {matches.map((match, index) => (
            <li key={match.name}>
              <button
                className={index === highlight ? 'is-active' : ''}
                // mousedown, not click: blur would close the list first.
                onMouseDown={(event) => {
                  event.preventDefault()
                  chooseProject(match.name)
                }}
                onMouseEnter={() => setHighlight(index)}
              >
                {match.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

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

  function closeStopPrompt(): void {
    if (dismissRef.current !== null) window.clearTimeout(dismissRef.current)
    dismissRef.current = null
    setStopPrompt(false)
  }

  /**
   * Stopping opens a short window to undo it, record what got done, or say why
   * it ended - never a blocking one.
   */
  function stop(): void {
    const task = snapshot.task
    void window.api.timer.stop()
    setQty('')
    // Almost every session is one of a few repeated shapes, so the unit this
    // task was last measured in is nearly always the right answer.
    void window.api.timer.lastUnit(task).then((unit) => setQtyUnit(unit ?? ''))
    setStopPrompt(true)
    dismissRef.current = window.setTimeout(() => setStopPrompt(false), 30_000)
  }

  /**
   * The countdown to auto-dismiss stops the moment the output fields are
   * touched. A prompt that vanishes mid-word while you are typing into it is
   * one you stop bothering with.
   */
  function holdStopPrompt(): void {
    if (dismissRef.current === null) return
    window.clearTimeout(dismissRef.current)
    dismissRef.current = null
  }

  /**
   * Written as it is typed rather than behind a confirm button, matching the
   * pace panel. There is no moment where what is on screen is not what is
   * stored, so dismissing the prompt can never lose an entry.
   */
  function saveQuantity(nextQty: string, nextUnit: string): void {
    const amount = nextQty.trim() === '' ? null : Number(nextQty)
    void window.api.timer.setQuantity(
      amount !== null && Number.isFinite(amount) ? amount : null,
      nextUnit.trim() === '' ? null : nextUnit.trim()
    )
  }

  function answerStop(reason: string | null): void {
    if (reason) void window.api.timer.setStopReason(reason, null)
    closeStopPrompt()
  }

  function undoStop(): void {
    void window.api.timer.undoStop().then(() => {
      // Undo may have brought a pace loop back with the session.
      void window.api.timer.getPace().then(setPace)
    })
    // The row it was written to is gone, so the fields must not carry over to
    // whatever is stopped next.
    setQty('')
    setQtyUnit('')
    closeStopPrompt()
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
      <button
        className={`ghost ghost--pace${pace ? ' is-on' : ''}`}
        onClick={() => {
          const opening = !paceOpen
          setPaceOpen(opening)
          // Re-arm from whatever the fields already hold. A pace that ended
          // with its session leaves its values behind, and requiring an edit to
          // bring it back meant retyping a value that was already on screen.
          if (opening) applyPace(paceEvery, paceQty, paceUnit)
        }}
        title={pace ? `Pace loop: ${paceLabel}` : 'Add a pace loop'}
      >
        <Icon name="pace" />
      </button>
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
        caption={caption}
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
              ref={paceEveryRef}
              value={paceEvery}
              placeholder="20"
              onChange={(event) => {
                setPaceEvery(event.target.value)
                applyPace(event.target.value, paceQty, paceUnit)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') paceQtyRef.current?.focus()
              }}
              aria-label="Pace interval"
            />
            <span>do</span>
            <input
              ref={paceQtyRef}
              value={paceQty}
              placeholder="100"
              inputMode="numeric"
              onChange={(event) => {
                const next = event.target.value
                // A count, so only digits and at most one decimal point. The
                // partial forms `1.` and `` have to be allowed or the field
                // cannot be typed into or cleared.
                if (!/^\d{0,6}(\.\d{0,2})?$/.test(next)) return
                setPaceQty(next)
                applyPace(paceEvery, next, paceUnit)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') paceUnitRef.current?.focus()
              }}
              aria-label="Pace target"
            />
            <input
              ref={paceUnitRef}
              value={paceUnit}
              placeholder="words"
              onChange={(event) => {
                // Digits here are always meant for the field beside this one,
                // so they are dropped rather than rejected - the rest of what
                // was typed still lands.
                const next = event.target.value.replace(/\d/g, '')
                setPaceUnit(next)
                applyPace(paceEvery, paceQty, next)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') closePace()
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
        <div className="stop-output">
          <input
            ref={qtyRef}
            className="stop-output__qty"
            value={qty}
            placeholder="340"
            inputMode="decimal"
            title="How much got done"
            onFocus={holdStopPrompt}
            onChange={(event) => {
              // Decimals allowed: half a problem set is `0.5 question`.
              if (!/^\d{0,7}(\.\d{0,2})?$/.test(event.target.value)) return
              holdStopPrompt()
              setQty(event.target.value)
              saveQuantity(event.target.value, qtyUnit)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') qtyUnitRef.current?.focus()
            }}
          />
          <input
            ref={qtyUnitRef}
            className="stop-output__unit"
            value={qtyUnit}
            placeholder="words"
            title="Measured in"
            onFocus={holdStopPrompt}
            onChange={(event) => {
              // A digit here was always meant for the box beside it, so it is
              // dropped rather than rejected - the rest of the word still lands.
              const next = event.target.value.replace(/[0-9]/g, '')
              holdStopPrompt()
              setQtyUnit(next)
              saveQuantity(qty, next)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
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
