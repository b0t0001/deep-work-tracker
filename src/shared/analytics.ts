/**
 * The shape of everything the Analytics tab shows, and the pure maths behind
 * the parts SQL cannot express.
 *
 * Aggregation happens in SQL (`main/db/analytics.ts`) because the history is
 * thousands of rows and the database is better at summing them. What lives
 * here is the arithmetic that is awkward in SQL and worth testing on its own:
 * streaks, week-over-week, and grouping consecutive runs into sittings.
 */

import type { StarRow } from './constellation'
import type { HourDay, PlannedRun, ProjectDay, UnitDay } from './ranges'

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
  /**
   * The task it was recorded against, for `shared/courses.ts` to read a
   * course code out of.
   *
   * A rate is only comparable within one unit *and* one subject, and the
   * subject is not stored anywhere else yet: `tags` exists for course codes
   * and nothing writes to it. So the task rides along and the code is parsed
   * in the renderer. When tags are real this field stops being needed.
   */
  task: string | null
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

/** Everything recorded in one unit, across the whole history. Feeds the fun facts. */
export interface UnitTotal {
  unit: string
  quantity: number
  sessions: number
}

/** The single longest run on record. */
export interface LongestSession {
  date: string | null
  task: string | null
  project: string | null
  hours: number
}

/**
 * One counted session, cut down to what the insights card reads.
 *
 * Per session rather than per day, unlike every other dated field here,
 * because the insights are mostly about the shape of individual sessions - a
 * median session length, the longest one in a range, which course a task was
 * for, a rate within one unit and one course. None of those survive being
 * summed by day. It is about 2,500 small rows, which is nothing on the wire.
 */
export interface SessionRow {
  /** Local `YYYY-MM-DD`. Rows with no date are not sent. */
  date: string
  project: string | null
  task: string | null
  /** One lap, as stored - see CLAUDE.md on `planned_duration_s`. */
  plannedS: number
  runningS: number
  laps: number
  source: string
  /**
   * The local hour the session started, 0-23, for app-recorded rows only.
   * Imported and manual rows are null whatever they hold: an imported row has
   * no clock time, and a manual one has a remembered one.
   */
  hour: number | null
  unit: string | null
  /** Null when absent or marked unquantifiable - never zero for "unknown". */
  quantity: number | null
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
   * Output per unit over the whole history, most-used first. Units are typed
   * by the user and keep arriving, so the fun facts are built from whatever is
   * here rather than from a list someone wrote down.
   */
  unitTotals: UnitTotal[]
  longestSession: LongestSession | null
  /**
   * Hours on tasks whose name contains "edit" as a word - so "Edit MEAM 1010
   * Video" and "editing" count and "credit" does not. The user's own example
   * of a fun fact, and honest only because the fact says how it was counted.
   */
  editingHours: number
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
  /**
   * The three aggregates above, sent again grouped one level finer - by day.
   *
   * Every panel carries its own range control, and `byProject`, `byHour` and
   * `plannedVsActual` are the only figures here that have already thrown their
   * dates away: `SUM(hours) GROUP BY project` over the whole history has no
   * "past week" hiding inside it, so a renderer holding only the total cannot
   * narrow it. These carry the date, and `shared/ranges.ts` re-totals them for
   * whatever range a panel is set to.
   *
   * The aggregate forms are kept rather than replaced because other things
   * read them - the fun facts, the planned-length fit - and because they are
   * the all-time answer, which is what most panels open on.
   *
   * Grouped by day rather than sent per session: the finest grain any range
   * control can ask for is a date, so a row per session would be more data for
   * no more resolution. `plannedRuns` is the exception and has to be per run -
   * a bucket's `actualMinutes` is a mean, and a mean cannot be re-averaged
   * without the count it was taken over.
   */
  projectDays: ProjectDay[]
  hourDays: HourDay[]
  plannedRuns: PlannedRun[]
  /** Output by unit by day, so the fun fact can follow its own range control. */
  unitDays: UnitDay[]
  /**
   * A handful of the task names each unit was recorded against.
   *
   * The fun fact says what was *done*, not just how much of it there was -
   * "285 components CADded", not "285 components" - and for some units the
   * verb is only decidable from the work. `page` is the case: the real
   * history has pages of a novel read in Chinese and pages of a lab workbook
   * worked through, and guessing one verb for both would make the card lie
   * about half of them. A sample rather than every task: the rule only needs
   * to see which kind of work dominates, and the whole list of 2,475 task
   * strings would be on the wire for nothing.
   */
  unitTasks: Record<string, string[]>
  /** Every counted dated session, for `shared/insights.ts`. See `SessionRow`. */
  sessionRows: SessionRow[]
  /**
   * Every counted dated session again, for the Constellation panel, carrying
   * what `sessionRows` deliberately does not: the row id (the cloud's jitter
   * is seeded from it, and it is the import order within a day) and clock
   * times for app-recorded rows, which decide what was one sitting. A second
   * array rather than more fields on `SessionRow`, so the insights card and
   * its fixtures are untouched. See `shared/constellation.ts`.
   */
  stars: StarRow[]
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
  return periodOverPeriod(daily, today, 7)
}

/**
 * The last `days` days against the `days` before them.
 *
 * The general form of `weekOverWeek`, which the stat row needs once the user
 * can choose the window: "X hours a day this week, up Y% from last week" has
 * to mean the same shape at a month or a year. The field names keep `Week`
 * because the comparison type is shared and every existing caller reads them;
 * read them as "this period" and "the period before".
 */
export function periodOverPeriod(daily: DayTotal[], today: string, days: number): WeekComparison {
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
    if (n > end - days) {
      thisWeek += day.hours
      if (isDayWorked(day)) thisWeekDays += 1
    } else if (n > end - 2 * days) {
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

/**
 * The question the planned-versus-actual chart exists to answer: are the
 * durations being set realistic, or should they be shorter?
 *
 * One length, not a trend across them. The chart draws every bucket; what a
 * reader can act on is the length they reach for most often, because that is
 * the setting a change would alter most sessions. A statement about the shape
 * of the whole series would be more impressive and less useful - nobody sets
 * "the average of all my durations".
 *
 * The mean, because the mean is what `PlannedVsActual` carries - and that is a
 * real limit on what may be claimed from this. A mean says where the weight
 * sits, not what share of runs reach any particular length, so a sentence
 * built on it may compare distances and must not promise that a shorter timer
 * would usually run to the end. On the real history it would not: 52% of
 * 60-minute runs reach 45 minutes, against 20% reaching the full 60. Saying
 * otherwise is the kind of claim that gets a number checked once and the panel
 * never trusted again.
 */
export interface PlannedFit {
  /** The duration set more often than any other, in minutes. */
  plannedMinutes: number
  /** Runs set to that duration. */
  sessions: number
  /** Their mean running time, in minutes. */
  actualMinutes: number
  /** The nearest five minutes to that mean - a length someone would type. */
  suggestedMinutes: number
}

/** Timer lengths are set in round numbers, so a suggested one has to be. */
const SUGGEST_STEP_MINUTES = 5

export function plannedFit(data: PlannedVsActual[], minRuns: number): PlannedFit | null {
  // Only the buckets the chart itself draws. A suggestion resting on three
  // runs is worse than no suggestion, and it would also disagree with the bars
  // underneath it, which is how a panel loses its reader.
  const eligible = data.filter((row) => row.sessions >= minRuns && row.plannedMinutes > 0)
  if (eligible.length === 0) return null
  // Ties go to the shorter length. The evidence either side is equal, so the
  // tie-break may as well be the advice that asks less; what matters is that
  // it is decided here rather than by input order.
  const busiest = eligible.reduce((best, row) =>
    row.sessions > best.sessions ||
    (row.sessions === best.sessions && row.plannedMinutes < best.plannedMinutes)
      ? row
      : best
  )
  return {
    plannedMinutes: busiest.plannedMinutes,
    sessions: busiest.sessions,
    actualMinutes: busiest.actualMinutes,
    suggestedMinutes: Math.max(
      SUGGEST_STEP_MINUTES,
      Math.round(busiest.actualMinutes / SUGGEST_STEP_MINUTES) * SUGGEST_STEP_MINUTES
    )
  }
}

/* ----------------------------------------------------------------------- *
 * The stats table: averages and medians per day, week and month.
 *
 * This is the part of their spreadsheet they said they look at most, so the
 * figures have to match what that sheet would have told them, and the reasons
 * for each choice are written down rather than left to be re-derived.
 * ----------------------------------------------------------------------- */

/** One row of the table: how many periods, and the two figures over them. */
export interface PeriodFigures {
  /** Whole periods inside the window. Zero means there is nothing to say. */
  count: number
  /** Hours per period. Null only when `count` is zero. */
  mean: number | null
  /** The middle period, or the mean of the middle two. Null with no periods. */
  median: number | null
}

export interface PeriodStats {
  from: string
  to: string
  totalHours: number
  day: PeriodFigures
  week: PeriodFigures
  month: PeriodFigures
}

/** A week and a month, as lengths rather than as calendar objects - see below. */
export const WEEK_DAYS = 7
export const MONTH_DAYS = 30

const STATS_DAY_MS = 86_400_000

function epochDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / STATS_DAY_MS)
}

/**
 * The middle value, or the mean of the middle two.
 *
 * Takes the array as given and sorts a copy: a median that reorders its input
 * would quietly corrupt the day series it was handed.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function figures(totals: number[]): PeriodFigures {
  if (totals.length === 0) return { count: 0, mean: null, median: null }
  const sum = totals.reduce((a, b) => a + b, 0)
  return { count: totals.length, mean: sum / totals.length, median: median(totals) }
}

/**
 * Hours per day, per week and per month across a span, as mean and median.
 *
 * **Empty periods count.** A day with no hours is a day, and a week off is a
 * week - this is the same rule `averagePerDay` follows and for the same
 * reason: dividing by worked days answers "how long is a working day", which
 * turns a fortnight away from the desk into no change at all. It matters more
 * for the median than for the mean, because dropping the zeroes does not just
 * raise the figure, it moves which observation sits in the middle. On the real
 * history the daily median over all time is 1.50 h counting every day and
 * 2.22 h counting only worked ones - the second is a true statement about
 * something nobody asked.
 *
 * **A week is seven days and a month is thirty, counted back from the end.**
 * Not calendar weeks and months, and the reason is that the window is already
 * a rolling span: `WINDOWS` defines "past month" as thirty days precisely so
 * it covers the same length whatever day it is opened on. Aligning the periods
 * to Mondays and to the first of the month inside a rolling window makes the
 * two fight - "the past week" would contain a whole calendar week only one day
 * in seven, so the weekly row would be empty most of the time.
 *
 * **The part-period at the old edge is dropped, not scaled.** Blocks are laid
 * out from `to` backwards, so the most recent is always whole and any
 * remainder falls at the far end, where it is the oldest days in the window. A
 * three-day stub counted as a week would read as a terrible week and drag the
 * median down; scaled up to seven it would be a projection rather than an
 * observation, and a median of projections is not a median of anything. Where
 * the span is shorter than the period, the count is zero and the row says so
 * rather than inventing one.
 *
 * `totalHours` ignores the blocks and sums the whole span, so the total always
 * covers every day shown in the day row.
 */
export function periodStats(daily: DayTotal[], from: string, to: string): PeriodStats {
  const first = epochDay(from)
  const last = epochDay(to)
  const span = last - first + 1

  const hoursByDay = new Map<number, number>()
  for (const row of daily) {
    const n = epochDay(row.date)
    if (n >= first && n <= last) hoursByDay.set(n, (hoursByDay.get(n) ?? 0) + row.hours)
  }

  const days: number[] = []
  for (let n = first; n <= last; n += 1) days.push(hoursByDay.get(n) ?? 0)

  // Blocks run backwards from the end, so `days` is read from its tail. The
  // leftover at the head is the dropped part-period.
  function blocks(length: number): number[] {
    const whole = Math.floor(days.length / length)
    const out: number[] = []
    for (let i = 0; i < whole; i += 1) {
      const end = days.length - i * length
      out.push(days.slice(end - length, end).reduce((a, b) => a + b, 0))
    }
    return out.reverse()
  }

  return {
    from,
    to,
    totalHours: days.reduce((a, b) => a + b, 0),
    day: span > 0 ? figures(days) : { count: 0, mean: null, median: null },
    week: figures(blocks(WEEK_DAYS)),
    month: figures(blocks(MONTH_DAYS))
  }
}
