import { EventEmitter } from 'node:events'
import { hasExpired, idleTimer, runningMs, type TimerSnapshot } from '../shared/timer'

/**
 * More laps than this in one check means the clock jumped - a machine that
 * slept without the suspend event arriving - not that hours of laps ran
 * unnoticed. Capped so one bad reading cannot spin.
 */
const MAX_LAPS_PER_CHECK = 1000

/**
 * How often the main process checks the clock. Display smoothness is the
 * renderer's job; this bounds how late expiry is noticed, and so how late the
 * cue sounds.
 */
const TICK_MS = 100

/** Three hours: long enough that only a forgotten pause reaches it. */
const DEFAULT_AUTO_END_MINUTES = 180

/** The second timer: a repeating interval expressing a target rate. */
export interface PaceConfig {
  intervalMs: number
  quantity: number | null
  unit: string | null
}

export interface PaceEvent {
  loops: number
  /** quantity x loops - what should be done by now, if a target was set. */
  cumulativeTarget: number | null
  unit: string | null
}

/**
 * The single source of truth for both timers.
 *
 * Nothing here decrements: remaining time is planned minus running, and running
 * is banked segments plus the live one measured from an absolute timestamp. A
 * dropped tick, a hidden window or a sleeping machine cannot cause drift
 * because there is no accumulator to corrupt.
 */
export class TimerEngine extends EventEmitter {
  private state: TimerSnapshot = idleTimer()
  private ticker: NodeJS.Timeout | null = null
  private loop = true
  private pace: PaceConfig | null = null
  private paceLoopsFired = 0
  private autoEndMs = DEFAULT_AUTO_END_MINUTES * 60_000

  snapshot(): TimerSnapshot {
    return { ...this.state, pauses: this.state.pauses.map((p) => ({ ...p })) }
  }

  /** The label is held here so every stop path can record it, auto-end included. */
  setTask(task: string): void {
    this.state.task = task
  }

  /** Same reasoning as the task: every stop path must be able to record it. */
  setProject(project: string): void {
    this.state.project = project
  }

  isLooping(): boolean {
    return this.loop
  }

  setLoop(value: boolean): void {
    this.loop = value
  }

  paceConfig(): PaceConfig | null {
    return this.pace
  }

  setPace(config: PaceConfig | null): void {
    this.pace = config
    this.paceLoopsFired = config
      ? Math.floor(runningMs(this.state, Date.now()) / config.intervalMs)
      : 0
  }

  autoEndMinutes(): number {
    return Math.round(this.autoEndMs / 60_000)
  }

  setAutoEndMinutes(minutes: number): void {
    this.autoEndMs = Math.max(0, minutes) * 60_000
  }

  start(plannedMs: number): TimerSnapshot {
    const now = Date.now()
    this.state = {
      ...idleTimer(),
      status: 'running',
      plannedMs,
      segmentStartedAt: now,
      startedAt: now,
      task: this.state.task,
      // Carried into the next session: consecutive sessions of the same work
      // are the norm, and re-picking the project each time would be the tedium
      // this is meant to remove.
      project: this.state.project
    }
    this.paceLoopsFired = 0
    this.startTicker()
    return this.emitUpdate()
  }

  pause(): TimerSnapshot {
    if (this.state.status !== 'running') return this.snapshot()
    this.bankSegment()
    this.state.status = 'paused'
    this.state.pauseCount += 1
    this.state.pauses.push({ pausedAt: Date.now(), resumedAt: null })
    // The ticker keeps running while paused: it is what notices a pause that has
    // gone on long enough to end the session.
    return this.emitUpdate()
  }

  resume(): TimerSnapshot {
    if (this.state.status !== 'paused') return this.snapshot()
    this.closeOpenPause()
    this.state.segmentStartedAt = Date.now()
    this.state.status = 'running'
    this.startTicker()
    return this.emitUpdate()
  }

  /**
   * Ends the run. Every path that finishes a session goes through here -
   * manual stop, expiry, auto-end - so `completed` is the one place a session
   * is recorded, and none of them can be forgotten.
   */
  stop(): TimerSnapshot {
    if (this.state.status === 'idle') return this.snapshot()
    this.bankSegment()
    this.closeOpenPause()
    const finished = { ...this.snapshot(), status: 'idle' as const }
    this.stopTicker()
    this.state = { ...idleTimer(), task: finished.task, project: finished.project }
    this.paceLoopsFired = 0
    this.emit('completed', finished)
    this.emitUpdate()
    return finished
  }

  /**
   * Puts a stopped run back, paused, for undo. Timing is restored exactly:
   * hitting stop instead of pause must never cost recorded time.
   */
  restore(finished: TimerSnapshot): TimerSnapshot {
    this.state = {
      ...finished,
      pauses: finished.pauses.map((p) => ({ ...p })),
      status: 'paused',
      segmentStartedAt: null
    }
    this.paceLoopsFired = this.pace
      ? Math.floor(this.state.bankedRunningMs / this.pace.intervalMs)
      : 0
    this.startTicker()
    return this.emitUpdate()
  }

  /** Sleeping the machine is not working, so suspend pauses rather than
      letting the countdown burn through a closed lid. */
  handleSuspend(): void {
    if (this.state.status === 'running') this.pause()
  }

  handleResume(): void {
    this.check()
  }

  dispose(): void {
    this.stopTicker()
    this.removeAllListeners()
  }

  private closeOpenPause(): void {
    const open = this.state.pauses[this.state.pauses.length - 1]
    if (open && open.resumedAt === null) open.resumedAt = Date.now()
  }

  /** Banks the live segment and stops it accruing. */
  private bankSegment(): void {
    this.state.bankedRunningMs = runningMs(this.state, Date.now())
    this.state.segmentStartedAt = null
  }

  private startTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => this.check(), TICK_MS)
  }

  private stopTicker(): void {
    if (!this.ticker) return
    clearInterval(this.ticker)
    this.ticker = null
  }

  /**
   * Runs on a short interval and on power-resume. Because every value is
   * derived from timestamps, waking after hours of sleep is noticed on the very
   * next check rather than drifting silently.
   */
  private check(): void {
    const now = Date.now()

    if (this.state.status === 'paused') {
      this.checkAutoEnd(now)
      return
    }
    if (this.state.status !== 'running') return

    this.checkPace(now)
    if (hasExpired(this.state, now)) this.handleExpiry()
  }

  /**
   * The pace loop counts *running* time, so a pause suspends it along with the
   * session rather than firing cues at an empty desk.
   */
  private checkPace(now: number): void {
    if (!this.pace) return
    const loops = Math.floor(runningMs(this.state, now) / this.pace.intervalMs)
    if (loops <= this.paceLoopsFired) return
    this.paceLoopsFired = loops
    const event: PaceEvent = {
      loops,
      cumulativeTarget: this.pace.quantity === null ? null : this.pace.quantity * loops,
      unit: this.pace.unit
    }
    this.emit('pace', event)
  }

  /**
   * The user's habit is to pause and close the window rather than stop, so a
   * pause left running past the threshold ends the session at the moment it was
   * paused - never counting the time spent away.
   */
  private checkAutoEnd(now: number): void {
    if (this.autoEndMs <= 0) return
    const open = this.state.pauses[this.state.pauses.length - 1]
    if (!open || open.resumedAt !== null) return
    if (now - open.pausedAt < this.autoEndMs) return
    this.emit('autoEnded')
    this.stop()
  }

  /**
   * A lap reached zero.
   *
   * **With loop on, the session does not end.** It cues, the countdown starts
   * the next lap, and running time, pauses and pace carry straight on. A loop
   * is one session because that is how the user reads it: one stretch of work,
   * one quantity entered at stop, one rate across the whole of it. Recording a
   * row per lap - as this did until 2026-11-06 - split a 2.35-hour MATH 1410
   * loop into two rows and attached the output to whichever lap was last.
   *
   * `lap` is emitted so main can save the loop so far: a session that is only
   * written at stop is lost whole if the app dies in hour five.
   *
   * Each lap still ends on exactly its planned length. The tick notices expiry
   * up to 100 ms late, and the next lap is started *at the moment of expiry*
   * rather than at the moment of noticing, so the overshoot belongs to the next
   * lap instead of being counted twice or lost.
   */
  private handleExpiry(): void {
    const now = Date.now()
    const plannedMs = this.state.plannedMs

    if (!this.loop) {
      this.bankSegment()
      this.closeOpenPause()
      // A run that reaches zero ran for exactly what it was set to. Recording
      // the polling overshoot would inflate every completed session by up to
      // one tick, and those are the sessions whose duration is most certain.
      this.state.lapsCompleted += 1
      this.state.bankedRunningMs = this.state.lapsCompleted * plannedMs

      const finished = { ...this.snapshot(), status: 'idle' as const }
      this.emit('completed', finished)
      this.emit('expired', finished)
      this.state.status = 'expired'
      this.stopTicker()
      this.emitUpdate()
      return
    }

    let laps = 0
    while (hasExpired(this.state, now) && laps < MAX_LAPS_PER_CHECK) {
      const lapEnd = (this.state.lapsCompleted + 1) * plannedMs
      const overshoot = runningMs(this.state, now) - lapEnd
      this.state.lapsCompleted += 1
      // Banked to the exact boundary; the live segment restarts at the instant
      // the lap ran out, so nothing is gained or dropped between laps.
      this.state.bankedRunningMs = lapEnd
      this.state.segmentStartedAt = now - overshoot
      laps += 1
    }

    const lap = this.snapshot()
    this.emit('lap', lap)
    this.emit('expired', lap)
    this.emitUpdate()
  }

  private emitUpdate(): TimerSnapshot {
    const snap = this.snapshot()
    this.emit('update', snap)
    return snap
  }
}
