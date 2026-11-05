/**
 * The shape of everything the Analytics tab shows, and the pure maths behind
 * the parts SQL cannot express.
 *
 * Aggregation happens in SQL (`main/db/analytics.ts`) because the history is
 * thousands of rows and the database is better at summing them. What lives
 * here is the arithmetic that is awkward in SQL and worth testing on its own:
 * streaks, week-over-week, and grouping consecutive runs into sittings.
 */

/** One calendar day. `hours` is running time, never wall-clock span. */
export interface DayTotal {
  /** Local `YYYY-MM-DD`. */
  date: string
  hours: number
  sessions: number
}

export interface ProjectTotal {
  name: string
  hours: number
  sessions: number
}

/** Hour of the local day, 0-23. App-recorded sessions only. */
export interface HourTotal {
  hour: number
  hours: number
  sessions: number
}

export interface PlannedVsActual {
  /** The duration the timer was set to, in minutes, rounded to a bucket. */
  plannedMinutes: number
  sessions: number
  /** Mean running time for runs set to this length, in minutes. */
  actualMinutes: number
}

/** A rate series is only ever for one unit - see CLAUDE.md. */
export interface RatePoint {
  date: string
  /** Quantity per minute of running time. */
  rate: number
  quantity: number
  minutes: number
}

/**
 * How close a session came to the pace it was set.
 *
 * **Chart `ratio`, never `target` and `actual`.** Those are absolute amounts in
 * whatever unit the session used, so plotting them in one series puts
 * `250 words` beside `19 questions` on a shared axis - the same category error
 * that the rates rule exists to prevent. The ratio is dimensionless, which is
 * what makes "how good are my predictions" answerable across every unit at
 * once. `target`, `actual` and `unit` are kept for a tooltip, where they are
 * read one at a time and the unit is visible beside them.
 */
export interface PacePoint {
  date: string
  /** What the pace loop was aiming at over the whole session, in units. */
  target: number
  /** What was actually produced, in the same unit. */
  actual: number
  unit: string
  /** `actual / target`. 1 means the prediction landed. Unit-free. */
  ratio: number
}

export interface Analytics {
  /** Null when the database is empty. */
  firstDate: string | null
  lastDate: string | null
  totalHours: number
  totalSessions: number
  /** Days with at least one session. */
  activeDays: number
  /** Calendar days spanned, so averages can run over the range not the days worked. */
  calendarDays: number
  daily: DayTotal[]
  byProject: ProjectTotal[]
  /** App-recorded only. Imported rows have no clock time. */
  byHour: HourTotal[]
  /** How many rows the time-of-day chart is actually based on. */
  timedSessions: number
  /**
   * The span those rows actually cover, as local `YYYY-MM-DD`, or null when
   * there are none.
   *
   * Separate from `firstDate`/`lastDate`, which span every row including
   * imports - the wrong range for a chart that deliberately excludes them.
   * A count on its own is misread: "3 sessions" over three and a half years
   * sounds like a thin pattern, while "3 sessions, all on 2026-10-02" is
   * plainly not a pattern at all. The second reading is the true one and the
   * chart has no way to say so without these.
   */
  timedFirst: string | null
  timedLast: string | null
  plannedVsActual: PlannedVsActual[]
  /** Units that appear often enough to trend, most-used first. */
  units: string[]
  /** Keyed by unit; only units in `units` are present. */
  ratesByUnit: Record<string, RatePoint[]>
  /**
   * How close the pace loop's prediction came, per session.
   *
   * Empty until the app is in daily use: only an app-recorded session can
   * carry `pace_target_qty` and `pace_target_interval_s`, so no imported row
   * will ever contribute one. **The chart still renders**, with an empty state
   * that says what fills it.
   *
   * That was argued the other way first and the user overruled it, rightly.
   * A chart that hides itself until it has data cannot teach anyone the
   * feature exists - the user would have had to already know the pace loop is
   * recorded before they would ever see the chart that proves it. An empty
   * state is a prompt; a missing chart is invisible. The same project had
   * already settled this for the time-of-day heatmap, which renders on three
   * rows with an honest caption.
   *
   * Plot `ratio`, never `target` against `actual` - `250 words` and
   * `19 questions` on one axis is the same category error as trending rates
   * across units.
   */
  pace: PacePoint[]
}

export interface Streaks {
  current: number
  best: number
  /** The day the current streak started, or null when it is zero. */
  currentSince: string | null
}

/**
 * Consecutive days with work, counted back from the most recent day in range.
 *
 * Today not being worked yet does not break a streak - it is not over until
 * the day is. So the count starts from yesterday when today is empty, which is
 * what every habit tracker does and what the user will expect at 9am.
 */
export function streaks(daily: DayTotal[], today: string): Streaks {
  const worked = new Set(daily.filter(isDayWorked).map((d) => d.date))
  if (worked.size === 0) return { current: 0, best: 0, currentSince: null }

  const step = (date: string, days: number): string => {
    const [y, m, d] = date.split('-').map(Number)
    const next = new Date(Date.UTC(y, m - 1, d + days))
    return next.toISOString().slice(0, 10)
  }

  let cursor = worked.has(today) ? today : step(today, -1)
  let current = 0
  let currentSince: string | null = null
  while (worked.has(cursor)) {
    current += 1
    currentSince = cursor
    cursor = step(cursor, -1)
  }

  const sorted = [...worked].sort()
  let best = 0
  let run = 0
  let previous: string | null = null
  for (const day of sorted) {
    run = previous !== null && step(previous, 1) === day ? run + 1 : 1
    if (run > best) best = run
    previous = day
  }

  return { current, best, currentSince }
}

export interface WeekComparison {
  /** Total running hours in each window. */
  thisWeek: number
  lastWeek: number
  /**
   * Days in each window that were actually worked.
   *
   * `isDayWorked` rather than a second inline `hours > 0`, so this and
   * `streaks()` cannot drift apart about what a worked day is.
   */
  thisWeekDays: number
  lastWeekDays: number
  /**
   * Hours per worked day - the fair comparison, and the one to show.
   *
   * Comparing totals punishes the *shape* of a week rather than the work in
   * it: five working days against seven reads as a collapse even when each
   * day was as long. Measured on the real history at 2026-11-05, totals said
   * -51% and this said -37%. Zero when no day in the window was worked.
   */
  thisWeekPerDay: number
  lastWeekPerDay: number
  /** Change in total hours. Null when last week was empty. */
  changePercent: number | null
  /** Change in hours per worked day. Null when no day was worked last week. */
  perDayChangePercent: number | null
}

/**
 * Whether a day counts as worked.
 *
 * One definition, used by everything that asks. A run stopped at zero seconds
 * is a misclick rather than a day's work, and `recordSession` already declines
 * to write anything under a second for the same reason.
 */
export function isDayWorked(day: DayTotal): boolean {
  return day.hours > 0
}

/**
 * The day before `date`, as local `YYYY-MM-DD`.
 *
 * Exported because the caller usually wants it: a week ending *today* is
 * comparing a day still in progress against seven finished ones, which makes
 * the current window look worse than it is - and worse, excludes today from a
 * per-worked-day denominator, so the figure is flattered instead. Ending the
 * window on the last complete day fixes both. That is a product decision and
 * so lives with the caller, but the date arithmetic belongs here.
 */
export function previousDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/**
 * The last seven days against the seven before them.
 *
 * Rolling rather than calendar weeks: on a Tuesday a calendar week compares
 * two days against seven and always reads as a collapse. CLAUDE.md settled on
 * rolling windows for exactly this reason.
 */
export function weekOverWeek(daily: DayTotal[], today: string): WeekComparison {
  const [y, m, d] = today.split('-').map(Number)
  const dayNumber = (date: string): number => {
    const [yy, mm, dd] = date.split('-').map(Number)
    return Math.round(Date.UTC(yy, mm - 1, dd) / 86_400_000)
  }
  const end = Math.round(Date.UTC(y, m - 1, d) / 86_400_000)

  let thisWeek = 0
  let lastWeek = 0
  let thisWeekDays = 0
  let lastWeekDays = 0
  for (const day of daily) {
    const n = dayNumber(day.date)
    if (n > end) continue
    if (n > end - 7) {
      thisWeek += day.hours
      if (isDayWorked(day)) thisWeekDays += 1
    } else if (n > end - 14) {
      lastWeek += day.hours
      if (isDayWorked(day)) lastWeekDays += 1
    }
  }

  const thisWeekPerDay = thisWeekDays === 0 ? 0 : thisWeek / thisWeekDays
  const lastWeekPerDay = lastWeekDays === 0 ? 0 : lastWeek / lastWeekDays

  return {
    thisWeek,
    lastWeek,
    thisWeekDays,
    lastWeekDays,
    thisWeekPerDay,
    lastWeekPerDay,
    changePercent: lastWeek === 0 ? null : ((thisWeek - lastWeek) / lastWeek) * 100,
    perDayChangePercent:
      lastWeekPerDay === 0 ? null : ((thisWeekPerDay - lastWeekPerDay) / lastWeekPerDay) * 100
  }
}

export interface Sitting {
  startedAt: string
  endedAt: string
  sessions: number
  hours: number
}

/**
 * Consecutive runs collapsed into one sitting.
 *
 * This is the old `HW 1` / `HW 2` grouping, inferred from wall-clock gaps
 * rather than typed by hand - the user confirmed the ordinal never meant
 * anything. Only app-recorded rows can take part, since imported ones have no
 * clock time to measure a gap with.
 */
export function sittings(
  rows: Array<{ startedAt: string; endedAt: string; seconds: number }>,
  gapMinutes = 30
): Sitting[] {
  const ordered = [...rows].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const out: Sitting[] = []
  for (const row of ordered) {
    const last = out[out.length - 1]
    const gap = last ? (Date.parse(row.startedAt) - Date.parse(last.endedAt)) / 60_000 : Infinity
    if (last && gap <= gapMinutes) {
      // The later end of the two, not simply this row's. Two timer windows can
      // run at once by design, so a short session nested inside a longer one is
      // expected input - and assigning its end would move the boundary
      // backwards, under-reporting the sitting and making the next row's gap
      // look bigger than it was, which can split a sitting that never broke.
      last.endedAt = row.endedAt > last.endedAt ? row.endedAt : last.endedAt
      last.sessions += 1
      last.hours += row.seconds / 3600
    } else {
      out.push({
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        sessions: 1,
        hours: row.seconds / 3600
      })
    }
  }
  return out
}

/** Every date from `from` to `to` inclusive, so gaps render as real zeroes. */
export function fillDays(daily: DayTotal[], from: string, to: string): DayTotal[] {
  const found = new Map(daily.map((d) => [d.date, d]))
  const out: DayTotal[] = []
  const [y, m, d] = from.split('-').map(Number)
  const cursor = new Date(Date.UTC(y, m - 1, d))
  const end = Date.parse(to + 'T00:00:00Z')
  while (cursor.getTime() <= end) {
    const key = cursor.toISOString().slice(0, 10)
    out.push(found.get(key) ?? { date: key, hours: 0, sessions: 0 })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}
