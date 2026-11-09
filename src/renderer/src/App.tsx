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
  /**
   * The field's value as of the last thing that set it, ahead of the render.
   *
   * Picking a suggestion sets the name and then the field loses focus in the
   * same event - the card's mousedown blurs it, and Enter blurs it on purpose.
   * The blur commits the field, and read from state it committed the text from
   * the render *before* the pick, which then won: type "Ent", click
   * Entrepreneurship, keep "Ent". The blur reads this instead.
   */
  const projectNow = useRef('')
  useEffect(() => {
    projectNow.current = project
  }, [project])
  const [projectFocused, setProjectFocused] = useState(false)
  const [projectNames, setProjectNames] = useState<string[]>([])
  const projectRef = useRef<HTMLInputElement>(null)
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
   * A newly opened window's project defaults to whatever the last session
   * was filed under (finishing a session clears it - see `onCompleted`), because
   * work comes in runs - several HW sessions, then several on the essay - so
   * the previous answer is nearly always this one too. The list feeds a
   * ranked suggestion list rather than a plain dropdown: it both offers what
   * exists and accepts a name that does not, and it matches on more than a
   * literal prefix so `hw`, `HW 2` and a typo all find the same project.
   */
  useEffect(() => {
    // Suggestions are a convenience. If they cannot be read the field still
    // works as free text, so a failure here must not become an unhandled
    // rejection that looks like the timer breaking.
    void window.api.timer
      .projectNames()
      .then(setProjectNames)
      .catch(() => setProjectNames([]))
    // A window can open onto a session already under way - a saved timer
    // reopened from the tray or the right-click menu. Its project and task are
    // the session's, and pushing the last-used project into it would quietly
    // refile the session; so the default applies only to an idle timer.
    void window.api.timer
      .get()
      .then(async (current) => {
        if (current && current.status !== 'idle') {
          setProject(current.project)
          setLabel(current.task)
          return
        }
        const name = await window.api.timer.lastProject()
        if (!name) return
        setProject(name)
        void window.api.timer.setProject(name)
      })
      .catch(() => undefined)
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
    projectNow.current = canonical
    setProject(canonical)
    void window.api.timer.setProject(canonical)
    setProjectOpen(false)
  }

  function chooseProject(name: string): void {
    projectNow.current = name
    setProject(name)
    void window.api.timer.setProject(name)
    setProjectOpen(false)
  }

  const [stopPrompt, setStopPrompt] = useState(false)
  /**
   * Set when a run could not be written, or when a write from the stop prompt
   * is refused. It replaces the prompt rather than sitting beside it: the
   * window is 250px, and asking for a quantity that cannot be stored is worse
   * than asking for nothing.
   *
   * It never auto-dismisses. Everything else here clears itself after thirty
   * seconds because missing it costs a label; missing this one means not
   * knowing a session was lost.
   */
  const [recordError, setRecordError] = useState<string | null>(null)
  /** Set by `recordFailed`, read once by the `completed` that follows it. */
  const recordFailedRef = useRef(false)
  const [qty, setQty] = useState('')
  const [qtyUnit, setQtyUnit] = useState('')
  const qtyRef = useRef<HTMLInputElement>(null)
  const qtyUnitRef = useRef<HTMLInputElement>(null)
  const dismissRef = useRef<number | null>(null)
  const clockRef = useRef<HTMLInputElement>(null)
  /**
   * The most recent `setQuantity`, so confirming can wait for the write
   * rather than for the keystroke that started it.
   *
   * The quantity is already stored by the time the user reaches for the
   * checkmark - it writes as they type. That is exactly why the confirmation
   * has to await this: a control that only closed the strip would be
   * reporting that a key was pressed, which is not the thing being claimed.
   *
   * It carries its own `catch` so a failure while typing still surfaces, and
   * that also marks the promise handled - `confirmOutput` awaits the same
   * promise again and handles the rejection a second time, which is fine and
   * is what lets it keep the strip open.
   */
  const quantityWrite = useRef<Promise<void> | null>(null)
  /** What was stored, shown back on confirm. Null while nothing is saved. */
  const [savedNote, setSavedNote] = useState<string | null>(null)
  /** Second beat of the three: held, then faded, then the rows collapse. */
  const [fadingNote, setFadingNote] = useState(false)
  const [confirming, setConfirming] = useState(false)

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

  /*
   * The session could not be written.
   *
   * Main catches the throw so the clock still stops cleanly, which is right -
   * a crash dialog over a timer that will not stop is worse - but it means
   * nothing else on screen looks wrong. Without this subscription the run
   * vanished in silence while the stop prompt went on accepting a quantity
   * for a row that was never created.
   *
   * The prompt is closed as well as replaced, so there is no field left to
   * type into.
   */
  useEffect(() => {
    return window.api.timer.onRecordFailed((reason) => {
      recordFailedRef.current = true
      setRecordError(reason)
      setStopPrompt(false)
    })
  }, [])

  /*
   * A finished session clears the task, the duration and the project, so the
   * next one starts from empty fields. The user's rule, 11/07/2026: "when i
   * finish a session you should clear whatever i put in the 'what are you
   * working on', time, and project name fields".
   *
   * `completed` arrives after the row is written, and every finish path -
   * stop, expiry without loop, auto-end - sends it, so none of them can leave
   * the fields behind. A lap of a loop does not: the session is still going.
   * Main's copy is cleared too, because main owns what the next stop records.
   * Undo gets its values back from the snapshot main kept, not from these.
   *
   * Except when the row could not be written. Main sends `recordFailed`
   * before `completed`, in order, and then the fields are the only record of
   * what the session was - kept so it can be entered by hand.
   */
  useEffect(() => {
    return window.api.timer.onCompleted(() => {
      if (recordFailedRef.current) {
        recordFailedRef.current = false
        return
      }
      setLabel('')
      setProject('')
      setDraft('')
      void window.api.timer.setTask('')
      void window.api.timer.setProject('')
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
   * The line under the clock is the project. Nothing else ever goes there.
   *
   * It used to show the status - `ready`, `running` - which restated what the
   * digits already said, and then the echo of how a typed duration had been
   * read. Both are gone at the user's request: the clock rewrites itself into
   * canonical form on Enter and on leaving the field, so `30 min` visibly
   * becomes `30:00` in the field itself, and a second copy of that in grey
   * underneath was noise sitting where the useful answer belongs.
   */
  const caption: React.ReactNode = (
    <div className="project-box">
      <input
        ref={projectRef}
        className="dial__project"
        value={project}
        placeholder="project"
        spellCheck={false}
        autoComplete="off"
        title="Which category this session counts towards"
        onChange={(event) => {
          projectNow.current = event.target.value
          setProject(event.target.value)
          setProjectOpen(true)
          setHighlight(0)
          // Main owns it for the same reason it owns the task: auto-end can
          // record a session this window never sees stop.
          void window.api.timer.setProject(event.target.value)
        }}
        onFocus={(event) => {
          // Selected whole, as the clock is. The field arrives holding the
          // last session's project, so clicking it is nearly always to put a
          // different one there; a caret dropped mid-word made the new name
          // land inside the old one (`H|W` + `Job` = `HJobW`).
          event.currentTarget.select()
          setProjectFocused(true)
          setProjectOpen(true)
          setHighlight(0)
        }}
        onBlur={() => {
          setProjectFocused(false)
          // A click on a suggestion fires blur first, so closing is deferred
          // by a tick or the mousedown never lands.
          window.setTimeout(() => setProjectOpen(false), 120)
          // Not `project`: a pick made in this same event is not in it yet.
          commitProject(projectNow.current)
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
    // The warning is about the run that just failed, not the one starting. It
    // persists until something replaces it precisely so it cannot be missed,
    // but leaving it over a running clock would make it look like this session
    // is the broken one.
    setRecordError(null)
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
   *
   * That guarantee is only true if a refused write says so. `void` silences
   * the floating-promise lint; it does not handle a rejection, so without the
   * catch the sentence above was simply false whenever the row was missing or
   * the database refused the update.
   */
  function saveQuantity(nextQty: string, nextUnit: string): void {
    const amount = nextQty.trim() === '' ? null : Number(nextQty)
    const write = window.api.timer.setQuantity(
      amount !== null && Number.isFinite(amount) ? amount : null,
      nextUnit.trim() === '' ? null : nextUnit.trim()
    )
    quantityWrite.current = write
    write.catch((error: unknown) => setRecordError(String(error)))
  }

  /**
   * How the strip describes what it stored.
   *
   * Names the value rather than saying "Saved", because the user is
   * confirming a number they typed and the useful acknowledgement is that
   * *that* number is the one in the database. Null when there is nothing to
   * claim - confirming an empty quantity closes the strip without pretending
   * anything was recorded.
   */
  function storedSummary(): string | null {
    const amount = qty.trim()
    if (amount === '') return null
    const unit = qtyUnit.trim()
    return `Saved · ${amount}${unit === '' ? '' : ` ${unit}`}`
  }

  /**
   * Confirms the output and closes the strip.
   *
   * Waits for the outstanding write before claiming anything. On a rejection
   * it reports the failure and **leaves the strip open**, because at that
   * moment what the user typed exists nowhere else - closing would discard
   * the only copy while telling them it was saved.
   */
  async function confirmOutput(): Promise<void> {
    if (confirming) return
    setConfirming(true)
    try {
      await quantityWrite.current
    } catch (error) {
      setConfirming(false)
      setRecordError(String(error))
      return
    }
    setConfirming(false)

    finishWithNote()
  }

  /**
   * Ends the strip, saying what was stored if anything was.
   *
   * Three beats, which is how the user described it: hold the message, fade
   * it, then let the rows collapse. A strip that vanished the instant they
   * clicked would answer a different question from the one they asked.
   *
   * Every exit that writes goes through here, so picking a reason and
   * pressing the checkmark cannot drift apart - the reason click is the
   * common path and was the silent one.
   */
  function finishWithNote(): void {
    const summary = storedSummary()
    if (summary === null) {
      closeStopPrompt()
      return
    }
    setSavedNote(summary)
    setFadingNote(false)
    if (dismissRef.current !== null) window.clearTimeout(dismissRef.current)
    dismissRef.current = window.setTimeout(() => {
      setFadingNote(true)
      dismissRef.current = window.setTimeout(() => {
        setSavedNote(null)
        setFadingNote(false)
        closeStopPrompt()
      }, 260)
    }, 1000)
  }

  /**
   * Picking a reason also exits the strip, so it carries the same guarantee
   * as the checkmark: wait for the outstanding quantity write, and if it
   * failed, report it and stay open rather than closing over a lost number.
   * The promise is the same one `confirmOutput` awaits - there is one write
   * in flight, not one per exit path.
   */
  async function answerStop(reason: string | null): Promise<void> {
    try {
      await quantityWrite.current
      // Awaited, not fired and forgotten. This was a `.catch()` with no
      // `await`, so the strip closed before the reason had been stored and
      // a note shown after it would have been claiming something unverified
      // - the exact fault this whole change exists to fix, in the one write
      // nobody thought to check.
      if (reason) await window.api.timer.setStopReason(reason, null)
    } catch (error) {
      setRecordError(String(error))
      return
    }
    finishWithNote()
  }

  function undoStop(): void {
    window.api.timer
      .undoStop()
      .then((restored) => {
        // Finishing cleared the fields; the session they described is back,
        // so they come back with it, from the snapshot main kept.
        if (restored) {
          setLabel(restored.task)
          setProject(restored.project)
          setDraft(formatDurationInput(restored.plannedMs))
        }
        // Undo may have brought a pace loop back with the session.
        void window.api.timer.getPace().then(setPace)
      })
      .catch((error: unknown) => setRecordError(String(error)))
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
        onTabForward={() => projectRef.current?.focus()}
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

      {/* `&& recordError === null`: when the write failed there is no row to
          attach anything to, so a field that accepts a quantity is a field
          that throws it away. The error replaces the prompt rather than
          sitting beside it - at 250px there is no room for both, and only one
          of them is true. */}
      {stopPrompt && recordError === null && savedNote === null && (
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
              // Enter walks quantity -> unit -> confirm, so a session can be
              // stopped and its output recorded without the mouse, the same
              // sequence the pace panel uses.
              if (event.key === 'Enter') void confirmOutput()
            }}
          />
        </div>
      )}

      {/* Rendered where the reason buttons were, not where the fields were.
          The user asked for it to "cover those labels", and the strip is
          absolutely positioned from the bottom - putting the note in the
          fields' row left the whole thing reflowing under the cursor between
          the click and the collapse.

          The inline transition is a placeholder so the fade exists today;
          it belongs in `main.css` with the rest of the strip, and the class
          is here for it. */}
      {savedNote !== null && (
        <div
          className="stop-prompt stop-prompt--saved"
          role="status"
          style={{ opacity: fadingNote ? 0 : 1, transition: 'opacity 240ms ease' }}
        >
          {savedNote}
        </div>
      )}

      {stopPrompt && recordError === null && savedNote === null && (
        <div className="stop-prompt">
          <button className="stop-prompt__undo" onClick={undoStop} title="Resume the session">
            Undo
          </button>
          <button onClick={() => answerStop('finished_early')}>done</button>
          <button onClick={() => answerStop('tired')}>tired</button>
          <button onClick={() => answerStop('interrupted')}>cut off</button>
          {/* A checkmark, not an X, and the glyph is the whole change.

              This control has always ended the strip without a reason, and
              the quantity and unit have always written as they were typed -
              so it has never dismissed unsaved work, because there is no
              such thing here. Labelling it with an X said otherwise, which
              is why the user asked to be told their output had been added:
              the one control that finished the interaction looked like the
              one that threw it away.

              The pace panel settled this already and CLAUDE.md records it:
              "The confirm button is a checkmark, not an X. Settings apply as
              they are typed, so it confirms rather than dismisses." Same
              reasoning, same strip, zero extra width.

              It is the secondary path, not the primary one: the user
              finishes on a reason button, and this is for when none of
              them fits. So it should read quieter than the reasons beside
              it, which is the opposite of what I first told the artist. */}
          <button
            className="stop-prompt__confirm"
            onClick={() => void confirmOutput()}
            disabled={confirming}
            title="Save and close"
            aria-label="Save and close"
          >
            &#10003;
          </button>
        </div>
      )}

      {/* Declared after the dial, like the rest of the chrome: Electron
          resolves overlapping drag regions by document order, so a control
          declared before the surface it covers renders, highlights in
          devtools, and never receives a click.

          The inline styles are a placeholder so this is legible today without
          reaching into `main.css`, which the artist owns. They belong in a
          `.card__error` rule — the markup is already classed for it. */}
      {recordError !== null && (
        <div className="card__error" role="alert">
          <span className="card__error-body">
            <b>This session was not saved.</b>
            The timer stopped normally, but writing it to the database failed, so nothing you typed
            about it was stored either. The run&apos;s timing is lost.
            {/* The raw reason, kept but set apart. Running it into the prose
                read as a sentence that trailed off into jargon; on its own
                line it is what it is - the detail to quote when asking why. */}
            <span className="card__error-reason">{recordError}</span>
          </span>
          <button
            className="card__error-dismiss"
            onClick={() => setRecordError(null)}
            title="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      <header className="card__head">
        {/* Settings first, in the top-left corner, then ring / bar, then a
            new timer - the order the user asked for. All three are siblings in
            this one container, so reordering them cannot change which sits on
            top of a drag region (see CLAUDE.md, drag regions). */}
        <div className="tools">
          <button
            className="icon"
            onClick={() => void window.api.window.openDashboard()}
            title="Settings and data"
          >
            <Icon name="settings" />
          </button>
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
          placeholder="Working on…"
          spellCheck={false}
        />

        <div className="tools">
          {/* Minimise, then full screen, then close - the order every Windows
              title bar uses. These three are siblings in one flex row and none
              overlaps another, so swapping them is a plain markup move: the
              drag-region rule is about a control overlapping a draggable
              surface, and the whole `.tools` group already sits after the dial
              in document order. No `order` needed, and no CSS depends on their
              positions - nothing in main.css selects them by :first-child,
              :last-child or :nth-. */}
          <button
            className="icon"
            onClick={() => void window.api.window.minimize()}
            title="Minimize"
          >
            <Icon name="minimize" />
          </button>
          <button
            className="icon"
            onClick={() => setFullScreen(!full)}
            title={full ? 'Exit full screen' : 'Full screen'}
          >
            <Icon name={full ? 'collapse' : 'expand'} />
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
