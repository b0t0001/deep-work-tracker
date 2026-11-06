/**
 * Timer state and the pure functions that derive everything from it.
 *
 * The invariant that matters: this module never stores "remaining time" as a
 * number that something decrements. Remaining is always *derived* from absolute
 * timestamps, so it stays correct across sleep, hidden windows, and throttled
 * intervals. See CLAUDE.md -> Timer correctness.
 */

export type TimerStatus = 'idle' | 'running' | 'paused' | 'expired'

/** One paused stretch. `resumedAt` is null while the timer is still paused. */
export interface PauseInterval {
  pausedAt: number
  resumedAt: number | null
}

export interface TimerSnapshot {
  status: TimerStatus
  /** What the timer was set to, in ms. */
  plannedMs: number
  /** Running time banked from segments that have already ended, in ms. */
  bankedRunningMs: number
  /** Epoch ms when the current running segment began. Null unless running. */
  segmentStartedAt: number | null
  /** Epoch ms of the first start of this run. Null when idle. */
  startedAt: number | null
  /**
   * Laps of a loop already run to zero. A loop is one session, not one per lap:
   * the user's output is entered once at stop and read as a rate across the
   * whole loop, so splitting it gave each lap a share of nothing. The countdown
   * shows the current lap; running time is the whole loop.
   */
  lapsCompleted: number
  /** How many times this run has been paused. */
  pauseCount: number
  /** Every paused stretch, so running time can be audited rather than trusted. */
  pauses: PauseInterval[]
  /** What the user is working on. Held here so any stop path can record it. */
  task: string
  /**
   * The category, by name rather than id.
   *
   * A name survives a project being created after the timer started, and keeps
   * the engine ignorant of the database - it is resolved to a row only at the
   * moment the session is written.
   */
  project: string
}

/**
 * A factory rather than a shared constant: a shared object would hand every
 * caller the same `pauses` array, and a shallow copy would not detach it.
 */
export function idleTimer(): TimerSnapshot {
  return {
    status: 'idle',
    plannedMs: 0,
    bankedRunningMs: 0,
    segmentStartedAt: null,
    startedAt: null,
    lapsCompleted: 0,
    pauseCount: 0,
    pauses: [],
    task: '',
    project: ''
  }
}

/**
 * Time the clock has actually been running, excluding every paused stretch.
 * This - not the span from startedAt to now - is what a session records.
 */
export function runningMs(s: TimerSnapshot, now: number): number {
  const live =
    s.status === 'running' && s.segmentStartedAt !== null
      ? Math.max(0, now - s.segmentStartedAt)
      : 0
  return s.bankedRunningMs + live
}

/**
 * Running time within the current lap. `plannedMs` is one lap's length, so the
 * countdown, the dial and expiry all read against this rather than the whole
 * loop's running time.
 */
export function lapRunningMs(s: TimerSnapshot, now: number): number {
  return Math.max(0, runningMs(s, now) - s.lapsCompleted * s.plannedMs)
}

/** Time left on the current lap's countdown, clamped at zero. */
export function remainingMs(s: TimerSnapshot, now: number): number {
  return Math.max(0, s.plannedMs - lapRunningMs(s, now))
}

/** Fraction of the current lap consumed, 0..1. */
export function progress(s: TimerSnapshot, now: number): number {
  if (s.plannedMs <= 0) return 0
  return Math.min(1, lapRunningMs(s, now) / s.plannedMs)
}

export function hasExpired(s: TimerSnapshot, now: number): boolean {
  return s.plannedMs > 0 && lapRunningMs(s, now) >= s.plannedMs
}

/**
 * Laps begun: the ones run to zero, plus the one in progress if any of it ran.
 * Stopped ten minutes into a second 90-minute lap is two laps and three planned
 * hours - what the user set out to do when that lap started.
 */
export function lapsBegun(s: TimerSnapshot, now: number): number {
  return s.lapsCompleted + (lapRunningMs(s, now) > 0 ? 1 : 0)
}

/**
 * H:MM:SS above an hour, MM:SS below it.
 * Rounds up so a freshly started 20-minute timer reads 20:00, not 19:59.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Preset durations in minutes, ascending. Any other length goes in the custom field. */
export const PRESET_MINUTES = [30, 60, 90, 120] as const
