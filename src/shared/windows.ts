/**
 * The time windows every Analytics panel chooses from, and the averages and
 * comparisons taken over them.
 *
 * One definition rather than one per panel. The user asked for a range
 * control three separate times - on the hours chart, per panel, and twice in
 * the stat row - and three separately grown pickers is how "the past 8 weeks"
 * ends up meaning 56 days in one place and two calendar months in another.
 *
 * Every window ends on the **last complete day**, not today. A day still in
 * progress is not a data point: it depresses an average, and in a
 * per-worked-day comparison it flatters instead, because a day with no hours
 * yet drops out of the denominator while the period before it counts in full.
 * Measured on the real history, that bias is the difference between -31% and
 * the honest -37%.
 */
import { previousDay, type DayTotal } from './analytics'

export type WindowId = '1w' | '2w' | '1m' | '8w' | '1y' | '2y' | 'all'

export interface WindowDef {
  id: WindowId
  /** Read after "Past", "Average over", and so on - so lower case. */
  label: string
  /** Calendar days, or null for the whole history. */
  days: number | null
}

/**
 * The user's list for the average tile, plus two weeks from the hours chart.
 *
 * "Past month" is thirty days rather than the calendar month, so that it
 * covers the same length whatever day it is opened on - a calendar month read
 * on the 2nd would be two days long and always look like a collapse.
 */
export const WINDOWS: readonly WindowDef[] = [
  { id: '1w', label: 'past week', days: 7 },
  { id: '2w', label: 'past 2 weeks', days: 14 },
  { id: '1m', label: 'past month', days: 30 },
  { id: '8w', label: 'past 8 weeks', days: 56 },
  { id: '1y', label: 'past year', days: 365 },
  { id: '2y', label: 'past 2 years', days: 730 },
  { id: 'all', label: 'all time', days: null }
]

export function windowDef(id: WindowId): WindowDef {
  return WINDOWS.find((w) => w.id === id) ?? WINDOWS[WINDOWS.length - 1]
}

const DAY_MS = 86_400_000

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

function dateOf(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

export interface Range {
  from: string
  to: string
  /** Calendar days in the range, inclusive. */
  days: number
}

/**
 * The dates a window covers, ending on the last complete day.
 *
 * Clamped to the first session, so "the past 2 years" on a history that is
 * eighteen months old divides by eighteen months rather than inventing six
 * months of zeroes before the user had started. Null when there is no complete
 * day to measure yet.
 */
export function windowRange(id: WindowId, today: string, firstDate: string | null): Range | null {
  if (firstDate === null) return null
  const end = dayNumber(previousDay(today))
  const first = dayNumber(firstDate)
  if (end < first) return null
  const def = windowDef(id)
  const start = def.days === null ? first : Math.max(first, end - def.days + 1)
  return { from: dateOf(start), to: dateOf(end), days: end - start + 1 }
}

export interface Average {
  hours: number
  /** Calendar days divided by, not days worked. */
  days: number
  perDay: number
}

/**
 * Hours per calendar day over a range.
 *
 * Calendar days, not worked days, and the distinction is load-bearing:
 * dividing by worked days answers "how long is a working day", which flatters
 * a fortnight off into nothing. `CLAUDE.md` settled this before the control
 * existed and the control must not unsettle it.
 */
export function averagePerDay(daily: DayTotal[], range: Range): Average {
  const from = dayNumber(range.from)
  const to = dayNumber(range.to)
  let hours = 0
  for (const day of daily) {
    const n = dayNumber(day.date)
    if (n >= from && n <= to) hours += day.hours
  }
  return { hours, days: range.days, perDay: range.days > 0 ? hours / range.days : 0 }
}

/** How long the first year is, and therefore how long the baseline is. */
export const BASELINE_DAYS = 365

/**
 * Hours per calendar day across the first year of the history.
 *
 * Fixed at the first 365 days from the first session, and that is the point.
 * A baseline that moved - "your worst year", say, or a trailing average - could
 * fall during a bad month and make progress look better than it is, which
 * would be a lie in the flattering direction. Null until a full year exists:
 * a partial first year is not a baseline, it is just the recent past.
 */
export function baseline(daily: DayTotal[], firstDate: string | null): Average | null {
  if (firstDate === null) return null
  const first = dayNumber(firstDate)
  const last = daily.reduce((max, d) => Math.max(max, dayNumber(d.date)), first)
  if (last - first + 1 < BASELINE_DAYS) return null
  return averagePerDay(daily, {
    from: firstDate,
    to: dateOf(first + BASELINE_DAYS - 1),
    days: BASELINE_DAYS
  })
}

/**
 * How far a rate sits above the baseline, as a percentage.
 *
 * `+295` means nearly four times. Null when there is no baseline yet or it is
 * zero, rather than Infinity - a first year with no hours in it is not a
 * comparison anyone can read.
 */
export function aboveBaseline(perDay: number, base: Average | null): number | null {
  if (base === null || base.perDay <= 0) return null
  return (perDay / base.perDay - 1) * 100
}
