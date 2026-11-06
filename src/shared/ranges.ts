/**
 * Re-totalling an aggregate over a shorter range than the one it arrived with.
 *
 * Every Analytics panel now carries its own range control, which means every
 * panel has to be able to answer its own question over its own period. Two
 * kinds of figure arrive from the main process and they need opposite
 * treatment:
 *
 * - **An aggregate that still carries dates** - `daily`, `ratesByUnit`,
 *   `pace` - is filtered here. The rows are already one per day or one per
 *   session, so narrowing them is exact and costs nothing. A round trip to
 *   SQL for a date comparison the renderer can do on an array it already
 *   holds would be slower and could disagree with the figure beside it.
 * - **An aggregate that has already lost its dates** - hours per project,
 *   hours per hour-of-day, planned against actual - cannot be narrowed at
 *   all. `SUM(hours) GROUP BY project` over the whole history has no "past
 *   week" hiding inside it. So the main process now also sends those three
 *   grouped one level finer, by day, and they are re-totalled here.
 *
 * That is the whole reason this file exists rather than the panels filtering
 * inline: a panel must not have to know which of the two shapes it was handed.
 *
 * **Undated rows are excluded from a range, never guessed into one.** The
 * `session_date` column arrived in a later migration, so a row can have none.
 * `CLAUDE.md` settled the same question for the Data tab's date filter, and
 * for the same reason: a row sorted before every real date is swept in by an
 * open-ended `to` and dropped by a `from`, so it appears or vanishes
 * depending on which end of the range was typed.
 */
import type { HourTotal, PlannedVsActual, ProjectTotal, UnitTotal } from './analytics'
import type { Range } from './windows'

/** Hours on one project on one day. The dated form of `ProjectTotal`. */
export interface ProjectDay {
  date: string
  name: string
  hours: number
  sessions: number
}

/** Hours in one hour of the clock on one day. The dated form of `HourTotal`. */
export interface HourDay {
  date: string
  /** Local hour, 0-23. */
  hour: number
  hours: number
  sessions: number
}

/**
 * One counted timer run's planned and actual length, with its date.
 *
 * Per session rather than pre-bucketed, because the buckets have to be
 * recomputed per range: a bucket's `actualMinutes` is a mean over the runs in
 * it, and a mean cannot be re-averaged after the fact without the counts it
 * was taken over.
 */
export interface PlannedRun {
  date: string
  /** Seconds, as stored. */
  planned: number
  actual: number
}

/** A unit's output on one day. The dated form of `UnitTotal`. */
export interface UnitDay {
  date: string
  unit: string
  quantity: number
  sessions: number
}

/**
 * Durations grouped so the chart has bars rather than a smear.
 *
 * Lives here rather than in `main/db/analytics.ts` so that the bucketing the
 * renderer does per range is the same bucketing the main process does for the
 * whole history - two copies would drift and the drift would look like a bug
 * in the range control.
 */
export function bucketMinutes(seconds: number): number {
  const minutes = seconds / 60
  if (minutes <= 15) return Math.max(5, Math.round(minutes / 5) * 5)
  if (minutes <= 60) return Math.round(minutes / 15) * 15
  return Math.round(minutes / 30) * 30
}

/**
 * The rows inside a range, or all of them when there is no range.
 *
 * A null range means "all time", which is the whole point of distinguishing
 * it from a range that happens to cover everything: `windowRange` clamps to
 * the first session, so the two are usually the same set, and relying on that
 * would make the all-time case quietly depend on the clamp being right.
 */
export function within<T extends { date: string }>(rows: readonly T[], range: Range | null): T[] {
  if (range === null) return [...rows]
  return rows.filter((row) => row.date >= range.from && row.date <= range.to)
}

/** Hours by project over a range, highest first - the shape `ByProject` draws. */
export function projectTotalsIn(
  projectDays: readonly ProjectDay[],
  range: Range | null
): ProjectTotal[] {
  const totals = new Map<string, ProjectTotal>()
  for (const row of within(projectDays, range)) {
    const found = totals.get(row.name)
    if (found) {
      found.hours += row.hours
      found.sessions += row.sessions
    } else {
      totals.set(row.name, { name: row.name, hours: row.hours, sessions: row.sessions })
    }
  }
  return [...totals.values()].sort((a, b) => b.hours - a.hours)
}

/**
 * Hours by hour of the clock over a range, all 24 present.
 *
 * Every hour is returned even when it is empty, because the heatmap draws a
 * fixed 24-cell grid and a missing hour would shift every cell after it.
 */
export function hourTotalsIn(hourDays: readonly HourDay[], range: Range | null): HourTotal[] {
  const hours: HourTotal[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    hours: 0,
    sessions: 0
  }))
  for (const row of within(hourDays, range)) {
    if (row.hour < 0 || row.hour > 23) continue
    hours[row.hour].hours += row.hours
    hours[row.hour].sessions += row.sessions
  }
  return hours
}

/** Planned against actual over a range, bucketed by planned length. */
export function plannedVsActualIn(
  runs: readonly PlannedRun[],
  range: Range | null
): PlannedVsActual[] {
  const buckets = new Map<number, { sessions: number; actualSeconds: number }>()
  for (const run of within(runs, range)) {
    const key = bucketMinutes(run.planned)
    const entry = buckets.get(key) ?? { sessions: 0, actualSeconds: 0 }
    entry.sessions += 1
    entry.actualSeconds += run.actual
    buckets.set(key, entry)
  }
  return [...buckets.entries()]
    .map(([plannedMinutes, v]) => ({
      plannedMinutes,
      sessions: v.sessions,
      actualMinutes: v.actualSeconds / 60 / v.sessions
    }))
    .sort((a, b) => a.plannedMinutes - b.plannedMinutes)
}

/** Output by unit over a range, most sessions first - the shape the fun fact reads. */
export function unitTotalsIn(unitDays: readonly UnitDay[], range: Range | null): UnitTotal[] {
  const totals = new Map<string, UnitTotal>()
  for (const row of within(unitDays, range)) {
    const found = totals.get(row.unit)
    if (found) {
      found.quantity += row.quantity
      found.sessions += row.sessions
    } else {
      totals.set(row.unit, { unit: row.unit, quantity: row.quantity, sessions: row.sessions })
    }
  }
  return [...totals.values()].sort((a, b) => b.sessions - a.sessions || b.quantity - a.quantity)
}

/**
 * A rate over one bucket of time: the question "how fast was I at this, then".
 *
 * `rate` is the **pooled** rate - total quantity over total minutes - not the
 * mean of each session's rate. Those are different numbers and only the first
 * is the one being asked for: a ten-minute session at 2 a minute and a
 * two-hour session at 0.5 a minute average to 1.25 if you average the rates,
 * and to 0.58 if you ask how many you got through per minute of work. The
 * second is what "average across the entire section" means.
 */
export interface RateBar {
  /** First day of the bucket, `YYYY-MM-DD`. */
  from: string
  /** Last day of the bucket, inclusive. */
  to: string
  rate: number
  quantity: number
  minutes: number
  sessions: number
}

/** Weekly buckets up to a quarter, monthly beyond it. */
export type RateGrain = 'week' | 'month'

function monthKey(date: string): string {
  return date.slice(0, 7)
}

function weekKey(date: string): string {
  // Monday-anchored, matching the hours chart, so "a week" is one thing in
  // this app rather than two.
  const [y, m, d] = date.split('-').map(Number)
  const at = Date.UTC(y, m - 1, d)
  const weekday = (new Date(at).getUTCDay() + 6) % 7
  return new Date(at - weekday * 86_400_000).toISOString().slice(0, 10)
}

function lastDayOfMonth(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/**
 * Sessions pooled into weekly or monthly bars.
 *
 * **Empty buckets are left out, not drawn as zero.** The hours chart does the
 * opposite and is right to: a week with no work really is zero hours. A week
 * with no sessions has no *rate* at all - it is not "zero questions a minute",
 * it is a week the question does not apply to - and a bar at zero would read
 * as a collapse in pace. This is the same distinction as a missing session
 * versus a zero-length one in the import.
 */
export function rateBars(
  points: readonly { date: string; quantity: number; minutes: number }[],
  grain: RateGrain
): RateBar[] {
  const buckets = new Map<string, { quantity: number; minutes: number; sessions: number }>()
  for (const point of points) {
    if (point.minutes <= 0) continue
    const key = grain === 'month' ? monthKey(point.date) : weekKey(point.date)
    const found = buckets.get(key) ?? { quantity: 0, minutes: 0, sessions: 0 }
    found.quantity += point.quantity
    found.minutes += point.minutes
    found.sessions += 1
    buckets.set(key, found)
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => {
      const from = grain === 'month' ? `${key}-01` : key
      const to =
        grain === 'month'
          ? lastDayOfMonth(key)
          : new Date(Date.parse(`${key}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10)
      return {
        from,
        to,
        rate: v.quantity / v.minutes,
        quantity: v.quantity,
        minutes: v.minutes,
        sessions: v.sessions
      }
    })
}
