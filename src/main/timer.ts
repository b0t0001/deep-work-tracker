import { EventEmitter } from 'node:events'
import { hasExpired, idleTimer, runningMs, type TimerSnapshot } from '../shared/timer'

/** How often the main process checks for expiry. Display smoothness is the renderer's job. */
const TICK_MS = 250

/**
 * The single source of truth for the session timer.
 *
 * State transitions bank running time into `bankedRunningMs` and clear
 * `segmentStartedAt`, so pausing is simply "stop accruing". Nothing is ever
 * decremented on an interval; the ticker only watches for expiry.
 */
export class TimerEngine extends EventEmitter {
  private state: TimerSnapshot = idleTimer()
  private ticker: NodeJS.Timeout | null = null

  snapshot(): TimerSnapshot {
    return { ...this.state, pauses: this.state.pauses.map((p) => ({ ...p })) }
  }

  /** The label is held here so every stop path can record it, including auto-end. */
  setTask(task: string): void {
    this.state.task = task
  }

  start(plannedMs: number): TimerSnapshot {
    const now = Date.now()
    this.state = {
      ...idleTimer(),
      status: 'running',
      plannedMs,
      segmentStartedAt: now,
      startedAt: now,
      task: this.state.task
    }
    this.startTicker()
    return this.emitUpdate()
  }

  pause(): TimerSnapshot {
    if (this.state.status !== 'running') return this.snapshot()
    this.bankSegment()
    this.state.status = 'paused'
    this.state.pauseCount += 1
    this.state.pauses.push({ pausedAt: Date.now(), resumedAt: null })
    this.stopTicker()
    return this.emitUpdate()
  }

  resume(): TimerSnapshot {
    if (this.state.status !== 'paused') return this.snapshot()
    const open = this.state.pauses[this.state.pauses.length - 1]
    if (open && open.resumedAt === null) open.resumedAt = Date.now()
    this.state.segmentStartedAt = Date.now()
    this.state.status = 'running'
    this.startTicker()
    return this.emitUpdate()
  }

  /** Ends the run and returns the final snapshot, so the caller can record it. */
  stop(): TimerSnapshot {
    if (this.state.status === 'idle') return this.snapshot()
    this.bankSegment()
    // Close any pause still open, so a session stopped while paused records a
    // complete history rather than a dangling interval.
    const stillOpen = this.state.pauses[this.state.pauses.length - 1]
    if (stillOpen && stillOpen.resumedAt === null) stillOpen.resumedAt = Date.now()
    const finished = { ...this.snapshot(), status: 'idle' as const }
    this.stopTicker()
    this.state = { ...idleTimer(), task: finished.task }
    this.emitUpdate()
    return finished
  }

  /** Banks the live segment into bankedRunningMs and stops it accruing. */
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
   * Called on a short interval and on power-resume. Because remaining time is
   * derived from timestamps, a wake-up after hours of sleep is detected on the
   * very next check rather than drifting silently.
   */
  private check(): void {
    if (this.state.status !== 'running') return
    if (!hasExpired(this.state, Date.now())) return
    this.bankSegment()
    this.state.status = 'expired'
    this.stopTicker()
    this.emitUpdate()
    this.emit('expired', this.snapshot())
  }

  /**
   * Sleeping the machine is not working. Suspend auto-pauses rather than
   * letting the countdown burn through a closed lid.
   */
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

  private emitUpdate(): TimerSnapshot {
    const snap = this.snapshot()
    this.emit('update', snap)
    return snap
  }
}
