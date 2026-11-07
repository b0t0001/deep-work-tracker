/**
 * What every insight is built from: the types, the small arithmetic, and the
 * rules the user taught by cutting round-one candidates.
 *
 * The rules live here rather than inside each insight because the user stated
 * them as rules - *"apply the rule to every insight, not just the number"* -
 * and an insight written later must not be able to forget one:
 *
 * - **A comparison under 20% says nothing**, and neither does a near-zero
 *   change (`moved`). *"don't have a +0% bro that's sad"*; *"number is too
 *   low/too small for any causality"*.
 * - **Patterns of when (weekday, month, time of day) are read from flexible
 *   work only** (`flexibleRows`). *"no shit that's when i scheduled JPL to
 *   happen... keep it away from extracurricular activities that are
 *   recurring, and instead focus on the work that can be done any day"*.
 * - **A project that ended is a finished chapter, not a lapse** (`endedIn`).
 *   *"sprocket has gone quiet, because im not in high school anymore!"*
 * - **Question counts drifted in definition**, so a question rate is only
 *   compared inside a recent window (`DRIFT_UNITS`, `rateRows`).
 * - **Stops, laps and runs to zero come from app-recorded sessions only**
 *   (`isTimerRun`): an imported row was a lap of an untracked loop as often
 *   as a single run.
 */
import { median, type SessionRow } from './analytics'
import { courseFrom } from './courses'
import { formatCount, formatHours, isTimeUnit } from './facts'
import { describeSpan, type Range } from './windows'

export interface Insight {
  /** Stable across opens, so the card can avoid repeating itself. */
  id: string
  /** The headline, short and large: `9–11 PM`, `48%`, `Sundays`. */
  figure: string
  /** Read straight after the figure, completing the sentence. */
  text: string
  /** The numbers behind it, small, starting with the window it used. */
  detail: string
  /** Roughly 0-1: how far past its threshold it lands. Ranks the list. */
  strength: number
  /**
   * How often the card opens on it, relative to its strength. The user's
   * favourites carry more; "where it all started" carries less - *"put it in
   * rotation every so often"*. Set by the plan in `insights.ts`.
   */
  weight?: number
}

export interface InsightContext {
  rows: readonly SessionRow[]
  /** The window this insight reads (from `PLAN`), or null for all time. */
  range: Range | null
  /** The window's own words - `past 30 days` - for the sentence. */
  label: string
  /** Local `YYYY-MM-DD`, for the current streak. */
  today: string
  /** Projects that ended - see `endedIn`. */
  ended?: ReadonlySet<string>
}

/**
 * Everything the newer insights read, prepared once per build.
 *
 * Unlike `InsightContext` there is no window: each of these takes the windows
 * its sentence needs and names them in its detail line.
 */
export interface Kit {
  /** Every counted session, date order, then the order logged within a day. */
  rows: readonly SessionRow[]
  /** Rows that are not scheduled activities - see `flexibleRows`. */
  flexible: readonly SessionRow[]
  /** Projects treated as scheduled, named in details that leave them out. */
  scheduled: readonly string[]
  /** Projects with no session in `ENDED_AFTER_DAYS`, or named as ended. */
  ended: ReadonlySet<string>
  today: string
  /** The last complete day, where every window ends. */
  last: string
  /** The first session's date. */
  first: string
}

/** An insight that takes its own windows from the kit. */
export type KitBuilder = (kit: Kit) => Insight | Insight[] | null

/** One entry in an insight plan: the builder, and how often it opens. */
export interface KitStep {
  build: KitBuilder
  /** Multiplies its chance of opening; 1 when absent. */
  weight?: number
}

/** The user's favourites from round one open this much more often. */
export const FAVOURITE = 3
/** "where it all started": *"put it in rotation every so often"*. */
export const NOW_AND_THEN = 0.25

/** `flexible work only`, said once the same way everywhere. */
export const FLEXIBLE_ONLY = 'flexible work only'

/* ----------------------------------------------------------------------- *
 * The user's rules, as constants
 * ----------------------------------------------------------------------- */

/** The smallest relative change any comparison may report. */
export const MIN_CHANGE = 0.2

/**
 * Projects the user named as scheduled - a job, an internship, a club, a
 * competition. When they happen is a timetable, not a habit. `flexibleRows`
 * also catches others by their shape; this list is the ones that must never
 * slip through on a technicality.
 */
export const SCHEDULED_PROJECTS: readonly string[] = [
  'JPL',
  'PER',
  'Scioly',
  'Job',
  'Internship',
  'Boeing',
  'Sprocket'
]

/**
 * High-school-era projects the user named as finished. `endedIn` also treats
 * any project idle for `ENDED_AFTER_DAYS` as ended; this list holds the ones
 * that ended for a known reason, so a stray late session cannot revive them.
 */
export const ENDED_PROJECTS: readonly string[] = [
  'Sprocket',
  'Scioly',
  'College Apps',
  'SAT',
  'JPL',
  'Scholarships',
  'Study for APs'
]

/** A project idle this long is treated as a chapter that ended. */
export const ENDED_AFTER_DAYS = 90

/**
 * Units whose definition drifted. *"inaccurate bc i think i changed how i
 * count question completion"* - a question rate from 2024 and one from 2026
 * are not the same measurement, so a rate in these units is only ever taken
 * from the past `DRIFT_WINDOW_DAYS`. Lower case, singular.
 */
export const DRIFT_UNITS: readonly string[] = ['question', 'problem']
export const DRIFT_WINDOW_DAYS = 90

/** Rates exclude runs under five minutes, as the rate panel does. */
export const MIN_RATE_S = 300
/** Above this, an imported run that went exactly to term is an event, not a timer. */
export const EVENT_S = 3 * 60 * 60

/* ----------------------------------------------------------------------- *
 * Dates
 * ----------------------------------------------------------------------- */

export const DAY_MS = 86_400_000
export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]
export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

export function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

export function dateOf(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

export function weekdayOf(date: string): number {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay()
}

/** The Monday of the week a date falls in. */
export function weekOf(date: string): string {
  return dateOf(dayNumber(date) - ((weekdayOf(date) + 6) % 7))
}

/** `January 2026`. */
export function monthName(yyyyMm: string): string {
  return `${MONTHS[Number(yyyyMm.slice(5, 7)) - 1]} ${yyyyMm.slice(0, 4)}`
}

/** Calendar days from `from` to `to` inclusive for which `keep` holds. */
export function countDays(
  from: string,
  to: string,
  keep: (d: string) => boolean = () => true
): number {
  let n = 0
  for (let d = dayNumber(from); d <= dayNumber(to); d += 1) if (keep(dateOf(d))) n += 1
  return n
}

/** The `days` days ending on `end`, inclusive. */
export function lastDays(days: number, end: string): Range {
  return { from: dateOf(dayNumber(end) - days + 1), to: end, days }
}

/** The rows inside a range, or every row. */
export function within(rows: readonly SessionRow[], range: Range | null): SessionRow[] {
  if (range === null) return [...rows]
  return rows.filter((r) => r.date >= range.from && r.date <= range.to)
}

/** The span the rows cover, or the range itself. */
export function boundsOf(rows: readonly SessionRow[], range: Range | null): Range | null {
  if (range !== null) return range
  if (rows.length === 0) return null
  let from = rows[0].date
  let to = rows[0].date
  for (const r of rows) {
    if (r.date < from) from = r.date
    if (r.date > to) to = r.date
  }
  return { from, to, days: dayNumber(to) - dayNumber(from) + 1 }
}

export interface Run {
  from: string
  to: string
  length: number
}

/** Runs of consecutive dates, in date order. */
export function runsOf(dates: Iterable<string>): Run[] {
  const sorted = [...new Set(dates)].sort()
  const out: Run[] = []
  let start = -1
  let prev = -1
  for (const d of sorted) {
    const n = dayNumber(d)
    if (start !== -1 && n === prev + 1) {
      prev = n
      continue
    }
    if (start !== -1) out.push({ from: dateOf(start), to: dateOf(prev), length: prev - start + 1 })
    start = n
    prev = n
  }
  if (start !== -1) out.push({ from: dateOf(start), to: dateOf(prev), length: prev - start + 1 })
  return out
}

/** The longest run, the earliest on a tie. */
export function longestRun(runs: readonly Run[]): Run | null {
  let best: Run | null = null
  for (const r of runs) if (best === null || r.length > best.length) best = r
  return best
}

/* ----------------------------------------------------------------------- *
 * Numbers and words
 * ----------------------------------------------------------------------- */

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

/** `+54%`, `−32%` - a true minus sign, as the other figures use. */
export function signedPct(x: number): string {
  return `${x >= 0 ? '+' : '−'}${pct(Math.abs(x))}`
}

/** One decimal at most, trailing zero trimmed: `3`, `2.5`. */
export function num1(x: number): string {
  return (Math.round(x * 10) / 10).toLocaleString('en-US')
}

/** Hours a day, to two places, as the baseline tile writes them. */
export function perDay(h: number): string {
  return `${h.toFixed(2)} h`
}

/** `52 min` under an hour and a half, hours after that. */
export function formatMinutes(m: number): string {
  return m < 90 ? `${Math.round(m)} min` : formatHours(m / 60)
}

/** `22.5 words a minute`, or `one every 5.2 min` when it is slower than that. */
export function formatRate(perMinute: number, noun: string): string {
  if (perMinute <= 0) return `no ${noun}`
  if (perMinute >= 1) {
    const shown = perMinute >= 10 ? num1(perMinute) : (Math.round(perMinute * 100) / 100).toString()
    return `${shown} ${noun} a minute`
  }
  const every = 1 / perMinute
  // Past an hour apiece "one every 221.7 min" is a sum to do in your head;
  // a meeting that takes 3.7 h is the same fact said plainly.
  if (every >= 60) return `${formatHours(every / 60)} each`
  return `one every ${num1(every)} min`
}

export function plural(n: number, word: string): string {
  return `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`
}

/** A task name as quoted in a sentence. */
export function quoted(s: string | null): string {
  return `"${s ?? 'untitled'}"`
}

/** `9 PM`, `12 AM`. */
function clockHour(h: number): { n: number; half: 'AM' | 'PM' } {
  const hour = ((h % 24) + 24) % 24
  return { n: hour % 12 === 0 ? 12 : hour % 12, half: hour < 12 ? 'AM' : 'PM' }
}

/** A two-hour window: `9–11 PM`, `11 AM–1 PM`. */
export function hourWindow(start: number): string {
  const a = clockHour(start)
  const b = clockHour(start + 2)
  return a.half === b.half ? `${a.n}–${b.n} ${b.half}` : `${a.n} ${a.half}–${b.n} ${b.half}`
}

/** Minutes after local midnight as a clock time: `6:42 AM`. */
export function clockTime(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  const { n, half } = clockHour(Math.floor(m / 60))
  return `${n}:${String(m % 60).padStart(2, '0')} ${half}`
}

/**
 * Whether a comparison moved enough to say anything: at least `MIN_CHANGE`
 * either way, from two positive numbers. A change of nothing is never news.
 */
export function moved(now: number, then: number, floor = MIN_CHANGE): boolean {
  return now > 0 && then > 0 && Math.abs(now / then - 1) >= floor
}

/* ----------------------------------------------------------------------- *
 * Rows
 * ----------------------------------------------------------------------- */

export function hoursOf(rows: readonly SessionRow[]): number {
  let s = 0
  for (const r of rows) s += r.runningS
  return s / 3600
}

/** A total per key; rows whose key is null or empty are left out. */
export function sumBy(
  rows: readonly SessionRow[],
  key: (r: SessionRow) => string | null,
  value: (r: SessionRow) => number = (r) => r.runningS / 3600
): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    const k = key(r)
    if (k === null || k === '') continue
    out.set(k, (out.get(k) ?? 0) + value(r))
  }
  return out
}

/** Entries largest first; ties by key, so the order is stable. */
export function ranked(m: Map<string, number>): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

/** The rows of each date, in the order they were logged. */
export function byDay(rows: readonly SessionRow[]): Map<string, SessionRow[]> {
  const out = new Map<string, SessionRow[]>()
  for (const r of rows) {
    const list = out.get(r.date)
    if (list) list.push(r)
    else out.set(r.date, [r])
  }
  return out
}

/** Hours per worked date. */
export function dayHours(rows: readonly SessionRow[]): Map<string, number> {
  return sumBy(
    rows.filter((r) => r.runningS > 0),
    (r) => r.date
  )
}

/** Hours per worked day, with the session count. */
export function workedDays(
  rows: readonly SessionRow[]
): Map<string, { hours: number; sessions: number }> {
  const days = new Map<string, { hours: number; sessions: number }>()
  for (const r of rows) {
    if (r.runningS <= 0) continue
    const d = days.get(r.date) ?? { hours: 0, sessions: 0 }
    d.hours += r.runningS / 3600
    d.sessions += 1
    days.set(r.date, d)
  }
  return days
}

/** The project with the most hours in some rows. */
export function mostly(rows: readonly SessionRow[]): string | null {
  const top = ranked(sumBy(rows, (r) => r.project))
  return top.length > 0 ? top[0][0] : null
}

export function medianOf(values: readonly number[]): number {
  return (median([...values]) as number | null) ?? 0
}

/**
 * A timer run whose stop means something: **recorded by this app**, one lap,
 * with a plan.
 *
 * Imported rows are not: *"imported runs are all counted as single-lap though
 * most really looped untracked"* - Hourglass looped without anyone writing
 * the laps down, so an imported row that "ran out" may have been one lap of
 * five, and one "stopped early" may have been the last lap of a long loop.
 * Manual rows have no timer at all.
 */
export function isTimerRun(r: SessionRow): boolean {
  return r.source === 'app' && r.plannedS > 0 && r.runningS > 0 && r.laps <= 1
}

/** A row whose planned length is what a timer was set to - stops aside. */
export function hasPlan(r: SessionRow): boolean {
  if (r.source === 'manual' || r.plannedS <= 0 || r.runningS <= 0) return false
  return !(r.source === 'import' && r.plannedS > EVENT_S && r.runningS === r.plannedS)
}

/** A session a rate may be taken from - the rate panel's own exclusions. */
export function isRateRow(r: SessionRow): boolean {
  return (
    r.source !== 'manual' &&
    r.runningS >= MIN_RATE_S &&
    r.quantity !== null &&
    r.quantity > 0 &&
    r.unit !== null &&
    r.unit.trim() !== '' &&
    !isTimeUnit(r.unit)
  )
}

/** Pooled rate: total quantity over total minutes. */
export function pooledRate(rows: readonly SessionRow[]): number {
  let q = 0
  let m = 0
  for (const r of rows) {
    q += r.quantity ?? 0
    m += r.runningS / 60
  }
  return m > 0 ? q / m : 0
}

export interface RateGroup {
  unit: string
  course: string
  rows: SessionRow[]
}

/**
 * Rate rows grouped by unit and course, most sessions first - the only way
 * rates are ever compared. A drifting unit only contributes its past
 * `DRIFT_WINDOW_DAYS`.
 */
export function rateGroups(rows: readonly SessionRow[], last: string): RateGroup[] {
  const since = dateOf(dayNumber(last) - DRIFT_WINDOW_DAYS + 1)
  const groups = new Map<string, RateGroup>()
  for (const r of rows) {
    if (!isRateRow(r)) continue
    const course = courseFrom(r.task)
    if (course === null) continue
    const unit = (r.unit as string).trim()
    if (DRIFT_UNITS.includes(unit.toLowerCase()) && r.date < since) continue
    const key = `${unit}|${course}`
    const g = groups.get(key) ?? { unit, course, rows: [] }
    g.rows.push(r)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length)
}

/** Whether a unit's rates may only be read from a recent window. */
export function drifts(unit: string): boolean {
  return DRIFT_UNITS.includes(unit.trim().toLowerCase())
}

/** The window a rate group was read over, for its detail line. */
export function rateWindow(unit: string): string {
  return drifts(unit) ? `past ${DRIFT_WINDOW_DAYS} days` : 'all time'
}

/**
 * The projects treated as scheduled: the named ones, plus any whose shape
 * says it runs to a timetable.
 *
 * Shape, measured on the real history (10 sessions or more):
 *
 * - **one weekday holds 40% of its sessions** - Scioly 43%, JPL 42%, against
 *   21-25% for HW, College Apps and Entrepreneurship;
 * - **or a third of its tasks are meetings** - Sprocket 78%, JPL 44%;
 * - **or its typical session is a long block** of 2.5 h or more - Sprocket
 *   4.5 h, JPL 3 h, where homework is 30 min.
 *
 * A task called a meeting is scheduled whatever its project, which is how a
 * Startup meeting is kept out while Startup's own work stays in.
 */
export function scheduledProjects(rows: readonly SessionRow[]): string[] {
  const by = new Map<string, SessionRow[]>()
  for (const r of rows) {
    if (r.project === null) continue
    const list = by.get(r.project)
    if (list) list.push(r)
    else by.set(r.project, [r])
  }
  const out = new Set(SCHEDULED_PROJECTS)
  for (const [project, list] of by) {
    if (list.length < 10) continue
    const days = new Array<number>(7).fill(0)
    for (const r of list) days[weekdayOf(r.date)] += 1
    const topDay = Math.max(...days) / list.length
    const meetings = list.filter((r) => isMeeting(r)).length / list.length
    const typical = medianOf(list.map((r) => r.runningS)) / 3600
    if (topDay >= 0.4 || meetings >= 1 / 3 || typical >= 2.5) out.add(project)
  }
  return [...out].sort()
}

export function isMeeting(r: SessionRow): boolean {
  // The character class rather than a word-boundary escape - see CLAUDE.md.
  return r.task !== null && /(^|[^a-z])meeting/.test(r.task.toLowerCase())
}

/** Work that could have happened any day: not a scheduled project, not a meeting. */
export function flexibleRows(
  rows: readonly SessionRow[],
  scheduled: readonly string[]
): SessionRow[] {
  const set = new Set(scheduled)
  return rows.filter((r) => !(r.project !== null && set.has(r.project)) && !isMeeting(r))
}

/** Projects that ended: named, or idle for `ENDED_AFTER_DAYS` before `last`. */
export function endedIn(rows: readonly SessionRow[], last: string): Set<string> {
  const latest = new Map<string, string>()
  for (const r of rows) if (r.project !== null) latest.set(r.project, r.date)
  const out = new Set(ENDED_PROJECTS)
  for (const [p, d] of latest) if (dayNumber(last) - dayNumber(d) >= ENDED_AFTER_DAYS) out.add(p)
  return out
}

/**
 * Fold a plural unit onto its singular where both were typed, so `questions`
 * and `question` are one unit. Only where the singular exists in the data: a
 * unit typed only as `cells` stays `cells`.
 */
export function foldUnits(rows: readonly SessionRow[]): SessionRow[] {
  const units = new Set<string>()
  for (const r of rows) if (r.unit) units.add(r.unit.trim())
  const single = (u: string): string => {
    for (const c of [u.replace(/ies$/, 'y'), u.replace(/es$/, ''), u.replace(/s$/, '')])
      if (c !== u && units.has(c)) return c
    return u
  }
  return rows.map((r) => (r.unit ? { ...r, unit: single(r.unit.trim()) } : r))
}

/**
 * The period being looked at and the one of equal length before it.
 *
 * All time has no "before", so the comparison insights fall back to the past
 * year against the year before and say so. Null when the history does not
 * reach back far enough to fill the earlier period - comparing against a
 * stretch that is half before the first session is comparing against zero.
 */
export function periodPair(
  rows: readonly SessionRow[],
  range: Range | null,
  label: string
): { now: Range; then: Range; nowLabel: string; thenLabel: string } | null {
  const all = boundsOf(rows, null)
  if (all === null) return null
  const now: Range = range ?? lastDays(365, all.to)
  const start = dayNumber(now.from)
  const then: Range = { from: dateOf(start - now.days), to: dateOf(start - 1), days: now.days }
  if (then.from < all.from) return null
  const span = describeSpan(now.days).replace(/^1 /, '')
  return {
    now,
    then,
    nowLabel: range === null ? 'past 12 months' : label,
    thenLabel: `${span} before`
  }
}
