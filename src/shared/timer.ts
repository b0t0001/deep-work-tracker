/**
 * Timer state and the pure functions that derive everything from it.
 *
 * The invariant that matters: this module never stores "remaining time" as a
 * number that something decrements. Remaining is always *derived* from absolute
 * timestamps, so it stays correct across sleep, hidden windows, and throttled
 * intervals. See CLAUDE.md -> Timer correctness.
 */

export type TimerStatus = 'idle' | 'running' | 'paused' | 'expired'

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
  /** How many times this run has been paused. */
  pauseCount: number
}

export const IDLE_TIMER: TimerSnapshot = {
  status: 'idle',
  plannedMs: 0,
  bankedRunningMs: 0,
  segmentStartedAt: null,
  startedAt: null,
  pauseCount: 0
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

/** Time left on the countdown, clamped at zero. */
export function remainingMs(s: TimerSnapshot, now: number): number {
  return Math.max(0, s.plannedMs - runningMs(s, now))
}

/** Fraction of the planned duration consumed, 0..1. */
export function progress(s: TimerSnapshot, now: number): number {
  if (s.plannedMs <= 0) return 0
  return Math.min(1, runningMs(s, now) / s.plannedMs)
}

export function hasExpired(s: TimerSnapshot, now: number): boolean {
  return s.plannedMs > 0 && runningMs(s, now) >= s.plannedMs
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
