/**
 * One figure, chosen three ways, with the two comparisons that make it mean
 * something.
 *
 * This replaces three readings of the same number. The tab used to show
 * "3.21 h a day over the past week", "3.75 h a day worked in the past week"
 * and a Stats table whose first row was 3.21 again - and the user, fairly,
 * could not tell them apart: *"look at how much redundant data there is. im
 * not sure what the difference is between the 3.21h measure, the 3.75h
 * measure, and what the table below is trying to tell me... I want ONE
 * general box that i can quickly do comparisons on."*
 *
 * The difference, for the record, was that 3.21 divided 22.5 hours by 7
 * calendar days and 3.75 divided the same 22.5 by the 6 days that had any
 * work on them. Both are defensible and showing both without saying which is
 * which is not. Only the calendar-day reading survives, because `CLAUDE.md`
 * settled that one before either card existed: dividing by worked days
 * answers "how long is a working day", which flatters a fortnight off into
 * nothing.
 *
 * The arithmetic itself is `periodStats` from `analytics.ts`, unchanged. What
 * is here is the choosing and the comparing.
 */
import { periodStats, type DayTotal } from './analytics'
import type { Range } from './windows'

/** Mean or median. Median is the one that survives a single enormous day. */
export type Statistic = 'mean' | 'median'

/** Hours per what. */
export type Grain = 'day' | 'week' | 'month'

export const STATISTICS: readonly { id: Statistic; label: string }[] = [
  { id: 'mean', label: 'Average' },
  { id: 'median', label: 'Median' }
]

export const GRAINS: readonly { id: Grain; label: string; days: number }[] = [
  { id: 'day', label: 'day', days: 1 },
  { id: 'week', label: 'week', days: 7 },
  { id: 'month', label: 'month', days: 30 }
]

/**
 * The grains a range is long enough to answer in.
 *
 * `periodStats` counts whole periods measured back from the end and drops the
 * part-period at the start, so a 7-day range holds one week and no months.
 * Offering "per month over the past week" would produce the em dash the old
 * table printed, and an option that can only answer "—" is an option that
 * should not be in the list. Day is always available: a range is at least a
 * day or it is not a range.
 */
export function grainsFor(days: number | null): Grain[] {
  if (days === null) return ['day', 'week', 'month']
  return GRAINS.filter((grain) => days >= grain.days).map((grain) => grain.id)
}

/**
 * The grain to actually use, which is not always the one that was stored.
 *
 * A choice made on a long range stays stored when the range is shortened -
 * deliberately, so widening it again returns to what the user picked - but it
 * cannot be *shown*. Falling back to the longest grain that fits keeps the
 * box answering, and keeps it answering with the most informative figure it
 * can rather than dropping all the way to days.
 */
export function usableGrain(stored: Grain, days: number | null): Grain {
  const allowed = grainsFor(days)
  if (allowed.includes(stored)) return stored
  return allowed[allowed.length - 1] ?? 'day'
}

const DAY_MS = 86_400_000

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

function dateOf(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The equally long stretch immediately before a range.
 *
 * Equal length rather than "the previous calendar month", because the figure
 * it is compared against is a mean over a number of days - comparing 30 days
 * to 31 moves the answer by three percent for no reason anybody could see.
 * It is allowed to run back before the first session: those days really were
 * days with no work, and clamping the start would divide by fewer days and
 * flatter the earlier period.
 */
export function previousRange(range: Range): Range {
  const from = dayNumber(range.from)
  return { from: dateOf(from - range.days), to: dateOf(from - 1), days: range.days }
}

export interface Comparison {
  /** The chosen statistic over the chosen range, or null when there is nothing to average. */
  value: number | null
  /** The same statistic over the equally long stretch before it. */
  previous: number | null
  /** Percent change against `previous`; null when either end is missing or zero. */
  changePercent: number | null
  /** The same statistic over the whole history. */
  allTime: number | null
  /** The grain actually used, which may not be the one asked for. */
  grain: Grain
  /** Whole periods the figure is a mean or median of. */
  periods: number
  /** Calendar days in the range, which is what the figure divides by. */
  days: number
}

function pick(
  figures: { count: number; mean: number | null; median: number | null },
  statistic: Statistic
): number | null {
  return statistic === 'mean' ? figures.mean : figures.median
}

/**
 * The figure, its previous period and its all-time counterpart, in one call.
 *
 * `allRange` is passed in rather than derived so that "all time" means the
 * same span here as everywhere else on the tab - the caller already has it
 * from `windowRange`, and a second definition of the history's extent is a
 * second thing that can disagree.
 */
export function compare(
  daily: DayTotal[],
  range: Range,
  allRange: Range,
  statistic: Statistic,
  grain: Grain
): Comparison {
  const used = usableGrain(grain, range.days)
  const now = periodStats(daily, range.from, range.to)
  const value = pick(now[used], statistic)

  /*
   * No previous period when the range already covers everything.
   *
   * Comparing all time against the equally long stretch before the first
   * session would be comparing it against zero, and reporting "up 100%"
   * against a period that predates the data is a number with no content.
   */
  const coversEverything = range.from <= allRange.from
  const before = coversEverything ? null : previousRange(range)
  const previous =
    before === null ? null : pick(periodStats(daily, before.from, before.to)[used], statistic)

  const all = pick(periodStats(daily, allRange.from, allRange.to)[used], statistic)

  const changePercent =
    value === null || previous === null || previous === 0 ? null : (value / previous - 1) * 100

  return {
    value,
    previous,
    changePercent,
    allTime: all,
    grain: used,
    periods: now[used].count,
    days: range.days
  }
}
