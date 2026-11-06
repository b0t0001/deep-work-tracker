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

export type WindowId =
  '1w' | '2w' | '4w' | '1m' | '60d' | '8w' | '3m' | '6m' | '1y' | '2y' | 'all' | 'custom'

export interface WindowDef {
  id: WindowId
  /** Read after "Past", "Average over", and so on - so lower case. */
  label: string
  /** Calendar days, or null for the whole history. */
  days: number | null
}

/**
 * Every dropdown's list, in the user's own order.
 *
 * *"every timescale dropdown should have the same presets. go with past week,
 * 2 weeks, 4 weeks, 30 days, 60 days 8 weeks, 90 days, 6 months, 12 months,
 * 24 months, all time, and then a custom field where i can insert anything"*.
 *
 * Panels used to narrow this list - the calendar dropped the two shortest
 * windows, the comparison box offered five, the baseline tile four - each for
 * a defensible local reason. Together they meant no two dropdowns looked
 * alike, and the user noticed before anyone else did. The rule now is that
 * **every dropdown shows every option**; where one genuinely cannot apply it
 * is drawn disabled with the reason as its tooltip, so the list is still the
 * same list and the exception is visible rather than silently missing.
 *
 * **The order is theirs and is deliberately not monotonic.** 60 days sits
 * before 8 weeks although 56 is shorter, and 30 days after 4 weeks although
 * 30 is longer. Those pairs are near-duplicates that mean different things to
 * the person choosing - a month versus four weeks of work - and sorting them
 * by length would scatter the pairs. Do not "fix" the order.
 *
 * **How a month is defined, since the list now names months and days
 * separately.** A month-denominated window is a twelfth of a 365-day year,
 * rounded: 6 months is 183 days, 12 months is 365, 24 months is 730. That
 * keeps `1y` at exactly the 365 it has always been, so the baseline tile's
 * figures and every stored choice are unchanged. `1m` is **not** a month
 * window - it is the 30-day one, which is why the list can carry "past 4
 * weeks" (28) and "past 30 days" (30) as separate entries without either
 * being a rounding of the other. `periodStats` separately buckets by
 * 30-day months when it divides a range into whole months; that is a
 * different question and is documented there.
 *
 * Ids are unchanged for every window that already existed, so a stored
 * layout needs no migration.
 */
export const WINDOWS: readonly WindowDef[] = [
  { id: '1w', label: 'past week', days: 7 },
  { id: '2w', label: 'past 2 weeks', days: 14 },
  { id: '4w', label: 'past 4 weeks', days: 28 },
  { id: '1m', label: 'past 30 days', days: 30 },
  { id: '60d', label: 'past 60 days', days: 60 },
  { id: '8w', label: 'past 8 weeks', days: 56 },
  { id: '3m', label: 'past 90 days', days: 90 },
  { id: '6m', label: 'past 6 months', days: 183 },
  { id: '1y', label: 'past 12 months', days: 365 },
  { id: '2y', label: 'past 24 months', days: 730 },
  { id: 'all', label: 'all time', days: null },
  /**
   * The typed span. `days` is null here only because the list is static -
   * the real length comes from `customDays` on the layout and is applied by
   * `windowDefFor`, never read from this entry. Anything resolving a window
   * without a custom span in hand will treat it as all time, which is the
   * safe direction: it shows more than was asked for rather than silently
   * showing a week.
   */
  { id: 'custom', label: 'custom', days: null }
]

/** The id the custom entry carries, so callers need not spell it. */
export const CUSTOM_WINDOW: WindowId = 'custom'

export function windowDef(id: WindowId): WindowDef {
  // The fallback is "all time" rather than the last entry: `custom` is last
  // now, and falling back to a window whose length lives somewhere else
  // would resolve an unknown id to a span nobody chose.
  return WINDOWS.find((w) => w.id === id) ?? { id: 'all', label: 'all time', days: null }
}

/**
 * The window a target is actually showing, with a typed span applied.
 *
 * Everything that needs a length or a label goes through this rather than
 * `windowDef`, because for `custom` the length is not in `WINDOWS` - it is
 * whatever the user typed, stored per target. A custom window with no span
 * yet reads as all time, so a half-typed entry shows more than was asked for
 * rather than a week nobody chose.
 */
export function windowDefFor(id: WindowId, customDays: number | null): WindowDef {
  if (id !== 'custom') return windowDef(id)
  if (customDays === null || !Number.isFinite(customDays) || customDays < 1) {
    return { id: 'custom', label: 'all time', days: null }
  }
  const days = Math.round(customDays)
  return { id: 'custom', label: `past ${describeSpan(days)}`, days }
}

/**
 * `45 days` back from a day count, for a label.
 *
 * Says it in the unit the span divides into cleanly, so someone who typed
 * "3 weeks" reads "past 3 weeks" back rather than "past 21 days". Exact
 * divisions only - 20 days is 20 days, not "2.9 weeks".
 */
export function describeSpan(days: number): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  if (days % 365 === 0) return plural(days / 365, 'year')
  if (days % 30 === 0 && days >= 60) return plural(days / 30, 'month')
  if (days % 7 === 0) return plural(days / 7, 'week')
  return plural(days, 'day')
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
  return rangeOf(windowDef(id), today, firstDate)
}

/**
 * The same, from a resolved definition rather than an id.
 *
 * A custom window's length is not in `WINDOWS` - it is whatever the user
 * typed - so `windowDefFor` resolves it first and this takes the result.
 * Everything else goes through `windowRange`, which is this with the lookup
 * in front, so the two cannot define a window differently.
 */
export function rangeOf(def: WindowDef, today: string, firstDate: string | null): Range | null {
  if (firstDate === null) return null
  const end = dayNumber(previousDay(today))
  const first = dayNumber(firstDate)
  if (end < first) return null
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
