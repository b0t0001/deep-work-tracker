/**
 * Insights: the card in the At a glance row that used to be the fun fact.
 *
 * The user, on what the fun fact should become: *"It doesn't just have to be
 * about the total amount of work. It could also be about the efficiency...
 * The fun fact should help me make sense of the data. It shouldn't just be
 * raw data. There should be some... jumping around that you have to do... I
 * want you to basically just have insights."*
 *
 * So each entry here is a statement the user would otherwise have to work out
 * from two or three panels - a share, a comparison, a median, a change - plus
 * one line of the numbers it rests on, so it can be checked rather than
 * taken on trust. A raw total on its own is not an insight; where a total
 * survives (words written, hours), it is carried by a comparison.
 *
 * Rules every insight follows, because each was a complaint once:
 *
 * - **Rules over the user's own data, never a model.** LLM insights are
 *   deferred in `CLAUDE.md`; these are arithmetic with thresholds.
 * - **Every insight declares a minimum sample and is skipped below it.** A
 *   claim about "when you are most active" from two timed sessions is noise
 *   presented as a pattern. The thresholds are in `INSIGHT_MIN` so the check
 *   script can test the edge of each one.
 * - **Weak ones are skipped, not shown quietly.** A weekday 3% above average
 *   is not a strongest day. Each comparison has a floor below which it says
 *   nothing, and `strength` ranks the rest.
 * - **Time of day uses app-timed rows only.** Imported rows have no clock time
 *   and manual ones a remembered one; `SessionRow.hour` is already null for
 *   both, and this file checks `source` as well rather than trusting that.
 * - **A rate is compared only within one unit and one course** - the rule the
 *   rate panel was rebuilt around. Never across either.
 * - **Averages run over calendar days**, days off included, as everywhere
 *   else in the tab.
 * - **Numbers are exact** where they are figures from the data: 292,358, not
 *   "nearly 300k". Ratios and medians are rounded to what can be read.
 * - **Each insight picks its own window and says which.** The card has no
 *   range control (see `PLAN`): records and totals are all time, "now" is the
 *   past 30 days, habits are the recent stretch, and a comparison takes a
 *   period against the one of equal length before it. The detail line names
 *   the window every time.
 *
 * `test` rows never arrive here: `main/db/analytics.ts` reads through its
 * `COUNTED` view.
 */
import { median, type SessionRow } from './analytics'
import { courseFrom } from './courses'
import { formatDate } from './dates'
import { formatCount, formatHours, isTimeUnit, pluralUnit, verbFor } from './facts'
import {
  boundsOf,
  clamp01,
  dateOf,
  DAY_MS,
  dayNumber,
  drifts,
  endedIn,
  flexibleRows,
  foldUnits,
  FLEXIBLE_ONLY,
  formatMinutes,
  formatRate,
  hourWindow,
  isRateRow,
  isTimerRun,
  num1,
  pct,
  perDay,
  periodPair,
  plural,
  scheduledProjects,
  WEEKDAYS,
  within,
  workedDays,
  type Insight,
  type InsightContext,
  type Kit,
  type KitStep
} from './insightKit'
import { CLOCK_PLAN } from './insightsClock'
import { DAYS_PLAN } from './insightsDays'
import { WORK_PLAN } from './insightsWork'
import { windowDef, windowRange, type Range, type WindowId } from './windows'

export type { Insight, InsightContext } from './insightKit'
export { formatMinutes, formatRate, hourWindow, periodPair } from './insightKit'

export const INSIGHT_MIN = {
  /** Time of day: app-timed sessions, and the days they span. */
  timedSessions: 20,
  timedDays: 5,
  /** The peak two hours must hold this share of timed hours. A flat day says nothing. */
  peakShare: 0.25,
  /** Typical working day, biggest day: days with work. */
  workedDays: 10,
  recordDays: 5,
  /** Weekday comparison: calendar days in the range, and hours in it. */
  weekdayDays: 56,
  weekdayHours: 10,
  /** How far above average a weekday or the weekend must be to be named. */
  weekdayLift: 0.2,
  /** Top course: its sessions and hours; and there must be a second course. */
  courseSessions: 3,
  courseHours: 2,
  /** Top project: hours in range, and the share that makes it worth saying. */
  projectHours: 10,
  projectShare: 0.25,
  /** Project shift: hours in each period, a project's hours, and the change. */
  shiftHours: 20,
  shiftProjectHours: 5,
  shiftPoints: 0.1,
  /** Pace: sessions on each side of the comparison, and the change. */
  rateSide: 5,
  rateChange: 0.2,
  /**
   * Timers stopped early: single-lap runs **recorded by this app**. Imported
   * runs were often laps of untracked loops - see `isTimerRun`.
   */
  timerRuns: 30,
  /** Looped sessions, which only this app records. */
  loops: 5,
  /** Longest streak worth naming, in days. */
  streak: 3,
  /** Share of days worked: calendar days in range. */
  consistencyDays: 14,
  /** Output: a unit's sessions and quantity (the old fun-fact thresholds). */
  unitSessions: 5,
  unitQuantity: 50,
  /** Editing: sessions and hours. */
  editSessions: 3,
  editHours: 1,
  /** Session length trend: sessions in each period, and the change. */
  trendSessions: 15,
  trendChange: 0.2
} as const

/** A novel, for the words comparison. Stated in the detail line every time. */
export const NOVEL_WORDS = 90_000
/** A full-time work week, for the hours comparison. */
export const WORK_WEEK_HOURS = 40
/** How many output units, most-used first, may each become an insight. */
const MAX_UNIT_INSIGHTS = 6
/** How many unit-and-course pace comparisons may each become an insight. */
const MAX_RATE_INSIGHTS = 3

/* ----------------------------------------------------------------------- *
 * The insights
 * ----------------------------------------------------------------------- */

/** When you work. App-timed sessions only - see the file comment. */
export function peakHours(ctx: InsightContext): Insight | null {
  const timed = within(ctx.rows, ctx.range).filter(
    (r) => r.source === 'app' && r.hour !== null && r.runningS > 0
  )
  if (timed.length < INSIGHT_MIN.timedSessions) return null
  if (new Set(timed.map((r) => r.date)).size < INSIGHT_MIN.timedDays) return null

  const byHour = new Array<number>(24).fill(0)
  for (const r of timed) byHour[r.hour as number] += r.runningS / 3600
  const total = byHour.reduce((a, b) => a + b, 0)
  if (total <= 0) return null

  // Two hours rather than one: a single hour splits a habit that straddles
  // the hour mark into two half-strength bars. Wraps past midnight.
  let start = 0
  let best = -1
  for (let h = 0; h < 24; h += 1) {
    const sum = byHour[h] + byHour[(h + 1) % 24]
    if (sum > best) {
      best = sum
      start = h
    }
  }
  const share = best / total
  if (share < INSIGHT_MIN.peakShare) return null
  return {
    id: 'peak-hours',
    figure: hourWindow(start),
    text: `is when you're most active`,
    detail: `${pct(share)} of your timed hours start then · ${plural(timed.length, 'timed session')}, imported and manual left out`,
    strength: clamp01((share - 2 / 24) / 0.35)
  }
}

/** What a working day usually looks like. Medians, over days with work. */
export function typicalDay(ctx: InsightContext): Insight | null {
  const rows = within(ctx.rows, ctx.range)
  const days = workedDays(rows)
  if (days.size < INSIGHT_MIN.workedDays) return null
  const values = [...days.values()]
  const sessions = median(values.map((d) => d.sessions)) as number
  const hours = median(values.map((d) => d.hours)) as number
  const session = median(rows.filter((r) => r.runningS > 0).map((r) => r.runningS / 60)) as number
  return {
    id: 'typical-day',
    figure: `${num1(sessions)} session${sessions === 1 ? '' : 's'}`,
    text: `and ${formatHours(hours)} make a typical working day`,
    detail: `medians over ${plural(days.size, 'day')} with work · the middle session runs ${formatMinutes(session)}`,
    strength: 0.45
  }
}

/**
 * The strongest day of the week, or the weekend when that is the story.
 *
 * Per calendar day of that weekday, days off included - a Sunday with no work
 * is still a Sunday. Weekend and weekday are one insight rather than two,
 * because when Sunday leads they are the same observation told twice.
 */
export function weekdayPattern(ctx: InsightContext): Insight | null {
  const b = boundsOf(ctx.rows, ctx.range)
  if (b === null || b.days < INSIGHT_MIN.weekdayDays) return null
  const counts = new Array<number>(7).fill(0)
  const first = dayNumber(b.from)
  for (let n = first; n < first + b.days; n += 1) counts[new Date(n * DAY_MS).getUTCDay()] += 1
  const hours = new Array<number>(7).fill(0)
  for (const r of within(ctx.rows, b))
    hours[new Date(dayNumber(r.date) * DAY_MS).getUTCDay()] += r.runningS / 3600
  const total = hours.reduce((a, c) => a + c, 0)
  if (total < INSIGHT_MIN.weekdayHours) return null

  const avg = total / b.days
  const per = hours.map((h, i) => (counts[i] === 0 ? 0 : h / counts[i]))
  let top = 0
  let low = 0
  for (let i = 1; i < 7; i += 1) {
    if (per[i] > per[top]) top = i
    if (per[i] < per[low]) low = i
  }
  const lightest = `${WEEKDAYS[low]}s are lightest at ${perDay(per[low])}`

  if (top === 0 || top === 6) {
    const weekend = (hours[0] + hours[6]) / (counts[0] + counts[6])
    const weekdays = (total - hours[0] - hours[6]) / (b.days - counts[0] - counts[6])
    const lift = weekdays > 0 ? weekend / weekdays - 1 : 0
    if (lift >= INSIGHT_MIN.weekdayLift) {
      return {
        id: 'weekday',
        figure: 'Weekends',
        text: `are when you do the most: ${pct(lift)} more a day than weekdays`,
        detail: `${perDay(weekend)} a weekend day, ${perDay(weekdays)} a weekday · ${lightest} · days off counted`,
        strength: clamp01(lift / 0.6)
      }
    }
  }
  const lift = avg > 0 ? per[top] / avg - 1 : 0
  if (lift < INSIGHT_MIN.weekdayLift) return null
  return {
    id: 'weekday',
    figure: `${WEEKDAYS[top]}s`,
    text: `are your strongest day, ${pct(lift)} above your average day`,
    detail: `${perDay(per[top])} on an average ${WEEKDAYS[top]}, ${perDay(avg)} across all days · ${lightest}`,
    strength: clamp01(lift / 0.6)
  }
}

/**
 * Which course is taking the time. Courses come from the task text through
 * `shared/courses.ts`, the same reading the rate panel's picker uses.
 */
export function topCourse(ctx: InsightContext): Insight | null {
  const totals = new Map<string, { hours: number; sessions: number }>()
  for (const r of within(ctx.rows, ctx.range)) {
    const course = courseFrom(r.task)
    if (course === null || r.runningS <= 0) continue
    const t = totals.get(course) ?? { hours: 0, sessions: 0 }
    t.hours += r.runningS / 3600
    t.sessions += 1
    totals.set(course, t)
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1].hours - a[1].hours)
  if (ranked.length < 2) return null
  const [name, top] = ranked[0]
  const [nextName, next] = ranked[1]
  if (top.sessions < INSIGHT_MIN.courseSessions || top.hours < INSIGHT_MIN.courseHours) return null
  const lead = next.hours > 0 ? top.hours / next.hours - 1 : 1
  // What is taking time *now* is the version the user asked for, so a short
  // range ranks it higher than the all-time answer.
  const recent = ctx.range !== null && ctx.range.days <= 120 ? 0.2 : 0
  return {
    id: 'top-course',
    figure: name,
    text: `has taken the most time of your courses`,
    detail: `${formatHours(top.hours)} across ${plural(top.sessions, 'session')} · next is ${nextName} at ${formatHours(next.hours)}`,
    strength: clamp01(0.35 + recent + 0.3 * clamp01(lead))
  }
}

/** Where the time went, as a share - the project that dominates the range. */
export function topProject(ctx: InsightContext): Insight | null {
  const totals = projectHours(within(ctx.rows, ctx.range))
  let total = 0
  for (const h of totals.values()) total += h
  if (total < INSIGHT_MIN.projectHours) return null
  const named = [...totals.entries()].filter(([n]) => n !== '').sort((a, b) => b[1] - a[1])
  if (named.length < 2) return null
  const share = named[0][1] / total
  if (share < INSIGHT_MIN.projectShare) return null
  return {
    id: 'top-project',
    figure: pct(share),
    text: `of your time went to ${named[0][0]}`,
    detail: `${formatHours(named[0][1])} of ${formatHours(total)} · next is ${named[1][0]} at ${pct(named[1][1] / total)}`,
    strength: clamp01((share - 0.2) / 0.5)
  }
}

/** Hours by project name; unlabelled sessions under ''. */
function projectHours(rows: readonly SessionRow[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const r of rows) {
    const key = r.project ?? ''
    totals.set(key, (totals.get(key) ?? 0) + r.runningS / 3600)
  }
  return totals
}

/** The project whose share of the time moved most against the period before. */
export function projectShift(ctx: InsightContext): Insight | null {
  const pair = periodPair(ctx.rows, ctx.range, ctx.label)
  if (pair === null) return null
  const now = projectHours(within(ctx.rows, pair.now))
  const then = projectHours(within(ctx.rows, pair.then))
  const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0)
  const nowTotal = sum(now)
  const thenTotal = sum(then)
  if (nowTotal < INSIGHT_MIN.shiftHours || thenTotal < INSIGHT_MIN.shiftHours) return null

  let best: { name: string; delta: number; nowH: number; thenH: number } | null = null
  for (const name of new Set([...now.keys(), ...then.keys()])) {
    if (name === '') continue
    // A project that ended is a chapter that closed, not a share that fell:
    // *"sprocket has gone quiet, because im not in high school anymore!"*
    if (ctx.ended?.has(name) === true) continue
    const nowH = now.get(name) ?? 0
    const thenH = then.get(name) ?? 0
    if (Math.max(nowH, thenH) < INSIGHT_MIN.shiftProjectHours) continue
    const delta = nowH / nowTotal - thenH / thenTotal
    if (best === null || Math.abs(delta) > Math.abs(best.delta)) best = { name, delta, nowH, thenH }
  }
  if (best === null || Math.abs(best.delta) < INSIGHT_MIN.shiftPoints) return null

  const nowShare = best.nowH / nowTotal
  const thenShare = best.thenH / thenTotal
  const points = Math.round(Math.abs(best.delta) * 100)
  const text =
    best.thenH === 0
      ? `${best.name} went from none of your time to ${pct(nowShare)}`
      : best.nowH === 0
        ? `${best.name} went from ${pct(thenShare)} of your time to none`
        : `${best.name}'s share of your time ${best.delta > 0 ? 'rose' : 'fell'} from ${pct(thenShare)} to ${pct(nowShare)}`
  return {
    id: 'project-shift',
    figure: `${best.delta > 0 ? '+' : '−'}${points} pts`,
    text,
    detail: `the ${pair.nowLabel} against the ${pair.thenLabel} · ${formatHours(best.nowH)} now, ${formatHours(best.thenH)} then`,
    strength: clamp01(Math.abs(best.delta) / 0.3)
  }
}

/**
 * Whether a pace is moving, within one unit and one course.
 *
 * The sessions for one pair are split in half by date, and the pooled rate
 * of the latest half compared with the earliest - total quantity over total
 * minutes, as the rate panel pools, not a mean of per-session rates. The
 * sentence says "pace", not "better": a course getting harder is the usual
 * reason a rate falls, and the card cannot tell the difference.
 */
export function paceChanges(ctx: InsightContext): Insight[] {
  const groups = new Map<string, { unit: string; course: string; rows: SessionRow[] }>()
  for (const r of within(ctx.rows, ctx.range)) {
    if (!isRateRow(r)) continue
    const course = courseFrom(r.task)
    if (course === null) continue
    const unit = (r.unit as string).trim()
    // *"i changed how i count question completion"*: a trend across that
    // change measures the definition, not the pace.
    if (drifts(unit)) continue
    const key = `${unit}|${course}`
    const g = groups.get(key) ?? { unit, course, rows: [] }
    g.rows.push(r)
    groups.set(key, g)
  }

  const out: Insight[] = []
  for (const [key, g] of groups) {
    const side = Math.floor(g.rows.length / 2)
    if (side < INSIGHT_MIN.rateSide) continue
    const ordered = [...g.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const rate = (rs: SessionRow[]): number =>
      rs.reduce((s, r) => s + (r.quantity as number), 0) /
      rs.reduce((s, r) => s + r.runningS / 60, 0)
    const early = rate(ordered.slice(0, side))
    const late = rate(ordered.slice(ordered.length - side))
    if (!(early > 0) || !(late > 0)) continue
    const change = late / early - 1
    if (Math.abs(change) < INSIGHT_MIN.rateChange) continue
    const noun = pluralUnit(g.unit, 2)
    out.push({
      id: `pace:${key}`,
      figure: `${change > 0 ? '+' : '−'}${pct(Math.abs(change))}`,
      text: `pace on ${g.course} ${noun}, your latest ${side} sessions against your first ${side}`,
      detail: `${formatRate(late, noun)} lately, ${formatRate(early, noun)} at first · one unit, one course, runs under 5 min left out`,
      strength: clamp01(0.1 + Math.abs(Math.log(late / early)) / Math.log(3))
    })
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, MAX_RATE_INSIGHTS)
}

/**
 * How often a timer is stopped before it runs out.
 *
 * Neutral on purpose. The user sets timers slightly short to rush
 * themselves, and `CLAUDE.md` is explicit that stopping early is usually
 * success or good judgement - so this reports a habit, not a failure rate.
 */
export function stoppedEarly(ctx: InsightContext): Insight | null {
  const runs = within(ctx.rows, ctx.range).filter(isTimerRun)
  if (runs.length < INSIGHT_MIN.timerRuns) return null
  const early = runs.filter((r) => r.runningS < r.plannedS).length
  const used = median(runs.map((r) => r.runningS / r.plannedS)) as number
  return {
    id: 'stopped-early',
    figure: pct(early / runs.length),
    text: `of your timers were stopped before they ran out`,
    detail: `a typical run used ${pct(Math.min(used, 1))} of the time set · ${formatCount(early)} of ${formatCount(runs.length)} single-lap runs timed by the app, loops counted separately`,
    strength: 0.5
  }
}

/** How far a looped session typically runs past one lap. */
export function loopLength(ctx: InsightContext): Insight | null {
  // Laps exist only for sessions this app recorded.
  const loops = within(ctx.rows, ctx.range).filter(
    (r) => r.source === 'app' && r.laps > 1 && r.plannedS > 0
  )
  if (loops.length < INSIGHT_MIN.loops) return null
  const ratios = loops.map((r) => r.runningS / r.plannedS)
  const typical = median(ratios) as number
  let longest = loops[0]
  for (const r of loops)
    if (r.runningS / r.plannedS > longest.runningS / longest.plannedS) longest = r
  const what = longest.task ?? longest.project
  return {
    id: 'loops',
    figure: `${num1(typical)} laps`,
    text: `is how long a looped session typically runs`,
    detail: `laps of the length set, median over ${plural(loops.length, 'loop')} · longest ${num1(longest.runningS / longest.plannedS)} laps${what ? ` on "${what}"` : ''}`,
    strength: 0.5
  }
}

export interface StreakInfo {
  best: number
  bestEnd: string | null
  current: number
  currentSince: string | null
}

/**
 * Longest run of worked days, with where it ended, and the current one.
 *
 * Today not being worked yet does not break the current streak - the same
 * rule as `streaks()` in `analytics.ts`.
 */
export function streakInfo(dates: Iterable<string>, today: string): StreakInfo {
  const worked = new Set(dates)
  const sorted = [...worked].sort()
  let best = 0
  let bestEnd: string | null = null
  let run = 0
  let prev: number | null = null
  for (const d of sorted) {
    const n = dayNumber(d)
    run = prev !== null && n === prev + 1 ? run + 1 : 1
    if (run > best) {
      best = run
      bestEnd = d
    }
    prev = n
  }
  let cursor = worked.has(today) ? dayNumber(today) : dayNumber(today) - 1
  let current = 0
  let currentSince: string | null = null
  while (worked.has(dateOf(cursor))) {
    current += 1
    currentSince = dateOf(cursor)
    cursor -= 1
  }
  return { best, bestEnd, current, currentSince }
}

export function streak(ctx: InsightContext): Insight | null {
  const days = workedDays(within(ctx.rows, ctx.range))
  const s = streakInfo(days.keys(), ctx.today)
  if (s.best < INSIGHT_MIN.streak || s.bestEnd === null) return null
  if (s.current === s.best) {
    return {
      id: 'streak',
      figure: `${formatCount(s.best)} days`,
      text: `in a row and counting: your longest streak`,
      detail: `every day since ${formatDate(s.currentSince)}`,
      strength: 0.8
    }
  }
  return {
    id: 'streak',
    figure: `${formatCount(s.best)} days`,
    text: `in a row is your longest streak, ending ${formatDate(s.bestEnd)}`,
    detail:
      s.current > 0
        ? `you're on day ${formatCount(s.current)} of the current one`
        : 'no streak running right now',
    strength: clamp01(0.2 + (s.best / 30) * 0.5)
  }
}

/** The share of calendar days with any work, and the longest break. */
export function consistency(ctx: InsightContext): Insight | null {
  const b = boundsOf(ctx.rows, ctx.range)
  if (b === null || b.days < INSIGHT_MIN.consistencyDays) return null
  const worked = [...workedDays(within(ctx.rows, b)).keys()].map(dayNumber).sort((x, y) => x - y)
  if (worked.length === 0) return null
  // Breaks are runs of days off between two worked days, plus any at either
  // end of the range - a range that opens on a fortnight off had one.
  let gap = 0
  let gapEnd = 0
  let prev = dayNumber(b.from) - 1
  for (const n of [...worked, dayNumber(b.to) + 1]) {
    const off = n - prev - 1
    if (off > gap) {
      gap = off
      gapEnd = n - 1
    }
    prev = n
  }
  const share = worked.length / b.days
  const breakLine = gap >= 2 ? ` · longest break ${gap} days, to ${formatDate(dateOf(gapEnd))}` : ''
  return {
    id: 'consistency',
    figure: pct(share),
    text:
      ctx.range === null
        ? 'of days since you started had some work in them'
        : 'of days had some work in them',
    detail: `${formatCount(worked.length)} of ${formatCount(b.days)} days${breakLine}`,
    strength: 0.4
  }
}

/** The biggest day, against a typical working day. */
export function biggestDay(ctx: InsightContext): Insight | null {
  const rows = within(ctx.rows, ctx.range)
  const days = workedDays(rows)
  if (days.size < INSIGHT_MIN.recordDays) return null
  let date = ''
  let hours = 0
  for (const [d, v] of days) {
    if (v.hours > hours) {
      hours = v.hours
      date = d
    }
  }
  const typical = median([...days.values()].map((d) => d.hours)) as number
  const onDay = projectHours(rows.filter((r) => r.date === date))
  const mostly = [...onDay.entries()].filter(([n]) => n !== '').sort((a, b) => b[1] - a[1])[0]
  return {
    id: 'biggest-day',
    figure: formatHours(hours),
    text: `on ${formatDate(date)}, your biggest day`,
    detail: `${num1(hours / typical)}× a typical working day of ${formatHours(typical)}${mostly ? ` · mostly ${mostly[0]}` : ''}`,
    strength: 0.45
  }
}

/** The longest single session - unless it is the biggest day again. */
export function longestSession(ctx: InsightContext): Insight | null {
  const rows = within(ctx.rows, ctx.range).filter((r) => r.runningS > 0)
  if (rows.length < INSIGHT_MIN.recordDays) return null
  let top = rows[0]
  for (const r of rows) if (r.runningS > top.runningS) top = r
  const dayHours = workedDays(rows).get(top.date)?.hours ?? 0
  // A day that was one session is one fact, already told by the biggest day.
  if (Math.abs(dayHours - top.runningS / 3600) < 0.05 && isBiggest(rows, top.date)) return null
  const typical = median(rows.map((r) => r.runningS / 60)) as number
  const what = top.task ?? top.project ?? 'untitled'
  return {
    id: 'longest',
    figure: formatHours(top.runningS / 3600),
    text: `on "${what}", your longest single session`,
    detail: `${formatDate(top.date)}${top.project ? ` · ${top.project}` : ''} · a typical session runs ${formatMinutes(typical)}`,
    strength: 0.4
  }
}

function isBiggest(rows: readonly SessionRow[], date: string): boolean {
  const days = workedDays(rows)
  const target = days.get(date)?.hours ?? 0
  for (const v of days.values()) if (v.hours > target) return false
  return true
}

/**
 * What was produced, with a comparison that makes the figure mean something.
 *
 * Words become novels, stated at 90,000 a novel. Every other unit gets its
 * pace - one rate per unit, which is never compared with another unit's.
 */
export function outputs(ctx: InsightContext): Insight[] {
  const rows = within(ctx.rows, ctx.range)
  const units = new Map<string, { quantity: number; sessions: number; tasks: string[] }>()
  for (const r of rows) {
    if (r.unit === null || r.quantity === null || r.unit.trim() === '') continue
    const u = units.get(r.unit) ?? { quantity: 0, sessions: 0, tasks: [] }
    u.quantity += r.quantity
    u.sessions += 1
    if (r.task && u.tasks.length < 40) u.tasks.push(r.task)
    units.set(r.unit, u)
  }
  const ranked = [...units.entries()]
    .filter(
      ([unit, u]) =>
        u.sessions >= INSIGHT_MIN.unitSessions &&
        u.quantity >= INSIGHT_MIN.unitQuantity &&
        !isTimeUnit(unit)
    )
    .sort((a, b) => b[1].sessions - a[1].sessions || b[1].quantity - a[1].quantity)
    .slice(0, MAX_UNIT_INSIGHTS)

  return ranked.map(([unit, u], rank) => {
    const noun = pluralUnit(unit, u.quantity)
    const verb = verbFor(unit, u.tasks)
    const label = verb === '' ? noun : `${noun} ${verb}`
    const sessions = `across ${plural(u.sessions, 'session')}`
    if (unit.trim().toLowerCase() === 'word') {
      const novels = u.quantity / NOVEL_WORDS
      return {
        id: `unit:${unit}`,
        figure: formatCount(u.quantity),
        text: `${label}: ${novels >= 1 ? `${num1(novels)} novels' worth` : `${pct(novels)} of a novel`}`,
        detail: `at ${formatCount(NOVEL_WORDS)} words a novel · ${sessions}`,
        strength: 0.5
      }
    }
    const paced = rows.filter((r) => r.unit === unit && isRateRow(r))
    const minutes = paced.reduce((s, r) => s + r.runningS / 60, 0)
    const done = paced.reduce((s, r) => s + (r.quantity as number), 0)
    const pace =
      minutes > 0 && done > 0 ? `, ${paceWords(done / minutes, pluralUnit(unit, 2))}` : ''
    return {
      id: `unit:${unit}`,
      figure: formatCount(u.quantity),
      text: `${label}${pace}`,
      detail: minutes > 0 ? `${sessions} · ${formatHours(minutes / 60)} spent on them` : sessions,
      strength: clamp01(0.35 - rank * 0.03)
    }
  })
}

/** A unit's pace as the end of a sentence: `one every 2 min of work on them`, `3.7 h each`. */
function paceWords(perMinute: number, noun: string): string {
  const said = formatRate(perMinute, noun)
  return said.endsWith(' each') ? said : `${said} of work on them`
}

/** Total hours, in forty-hour work weeks. */
export function hoursTotal(ctx: InsightContext): Insight | null {
  const rows = within(ctx.rows, ctx.range)
  const hours = rows.reduce((s, r) => s + r.runningS / 3600, 0)
  if (hours < 1) return null
  const weeks = hours / WORK_WEEK_HOURS
  const b = boundsOf(ctx.rows, ctx.range) as Range
  return {
    id: 'total',
    figure: formatHours(hours),
    text: `of deep work: ${weeks >= 1.5 ? `${num1(weeks)} forty-hour work weeks` : `${pct(weeks)} of a forty-hour work week`}`,
    detail:
      ctx.range === null
        ? `since ${formatDate(b.from)} · ${plural(rows.length, 'session')}`
        : `${plural(rows.length, 'session')} · ${perDay(hours / b.days)} a day`,
    strength: 0.3
  }
}

/** Hours on tasks with "edit" as a word - the user's own example of a fun fact. */
export function editing(ctx: InsightContext): Insight | null {
  const rows = within(ctx.rows, ctx.range)
  const total = rows.reduce((s, r) => s + r.runningS, 0) / 3600
  // The character class rather than a word-boundary escape - see CLAUDE.md.
  const edits = rows.filter((r) => r.task !== null && /(^|[^a-z])edit/.test(r.task.toLowerCase()))
  const hours = edits.reduce((s, r) => s + r.runningS, 0) / 3600
  if (edits.length < INSIGHT_MIN.editSessions || hours < INSIGHT_MIN.editHours) return null
  return {
    id: 'editing',
    figure: formatHours(hours),
    text: `spent editing, ${pct(hours / total)} of all your time`,
    detail: `${plural(edits.length, 'session')} with "edit" in the task`,
    strength: 0.3
  }
}

/** Whether sessions are getting longer or shorter. Medians, manual rows left out. */
export function sessionTrend(ctx: InsightContext): Insight | null {
  const pair = periodPair(ctx.rows, ctx.range, ctx.label)
  if (pair === null) return null
  const lengths = (range: Range): number[] =>
    within(ctx.rows, range)
      .filter((r) => r.source !== 'manual' && r.runningS > 0)
      .map((r) => r.runningS / 60)
  const now = lengths(pair.now)
  const then = lengths(pair.then)
  if (now.length < INSIGHT_MIN.trendSessions || then.length < INSIGHT_MIN.trendSessions) return null
  const a = median(now) as number
  const b = median(then) as number
  if (!(a > 0) || !(b > 0)) return null
  if (Math.abs(a / b - 1) < INSIGHT_MIN.trendChange) return null
  return {
    id: 'session-trend',
    figure: formatMinutes(a),
    text: `is your typical session lately, ${a > b ? 'up' : 'down'} from ${formatMinutes(b)}`,
    detail: `medians, the ${pair.nowLabel} (${plural(now.length, 'session')}) against the ${pair.thenLabel} (${formatCount(then.length)})`,
    strength: clamp01(Math.abs(Math.log(a / b)) / Math.log(2))
  }
}

/* ----------------------------------------------------------------------- *
 * The list and the choosing
 * ----------------------------------------------------------------------- */

/** What `buildInsights` reads: the counted history, and today. */
export interface InsightInput {
  rows: readonly SessionRow[]
  /** Local `YYYY-MM-DD`. Windows end the day before, as every window does. */
  today: string
}

type Builder = (ctx: InsightContext) => Insight | Insight[] | null

/**
 * The first insights, each with the window its sentence needs.
 *
 * The card has no range control - the user's call: *"only that panel should
 * NOT have a timescale button"*. Records, streaks, totals and output are all
 * time, because a record over the past month is not a record. What is taking
 * your time now is the past 30 days. Habits are the recent stretch. A
 * comparison takes a period against the one of equal length before it.
 *
 * The detail line starts with the window. `named` marks the ones whose detail
 * already says it; `flexible` the patterns of *when*, which read flexible
 * work only (see `flexibleRows`).
 */
const PLAN: ReadonlyArray<{
  build: Builder
  window: WindowId
  named?: true
  flexible?: true
}> = [
  { build: peakHours, window: 'all', flexible: true },
  { build: typicalDay, window: '3m' },
  { build: weekdayPattern, window: '1y', flexible: true },
  { build: topCourse, window: '1m' },
  { build: topProject, window: '1m' },
  { build: projectShift, window: '1y', named: true },
  { build: paceChanges, window: 'all' },
  { build: stoppedEarly, window: '1y' },
  { build: loopLength, window: 'all' },
  { build: streak, window: 'all' },
  { build: consistency, window: '1y' },
  { build: biggestDay, window: 'all' },
  { build: longestSession, window: 'all' },
  { build: outputs, window: 'all' },
  { build: hoursTotal, window: 'all', named: true },
  { build: editing, window: 'all' },
  { build: sessionTrend, window: '3m', named: true }
]

/**
 * Everything kept from the candidate lists, in three files by subject. Each
 * takes its own windows and names them, so they need no `PLAN` entry above.
 */
const KIT_PLAN: readonly KitStep[] = [...DAYS_PLAN, ...WORK_PLAN, ...CLOCK_PLAN]

/** The kit every newer insight reads, built once. */
export function kitFor(input: InsightInput): Kit | null {
  if (input.rows.length === 0) return null
  // Date order, keeping the order logged within a day: `sort` is stable.
  const rows = foldUnits(
    [...input.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  )
  const last = dateOf(dayNumber(input.today) - 1)
  const scheduled = scheduledProjects(rows)
  return {
    rows,
    flexible: flexibleRows(rows, scheduled),
    scheduled,
    ended: endedIn(rows, last),
    today: input.today,
    last,
    first: rows[0].date
  }
}

/**
 * Every insight the history supports, each over its own window, strongest
 * first. Empty when there is nothing worth saying.
 */
export function buildInsights(input: InsightInput): Insight[] {
  const kit = kitFor(input)
  if (kit === null) return []
  const out: Insight[] = []
  for (const step of PLAN) {
    const def = windowDef(step.window)
    // All time is no filter, not `windowRange('all')`: the latter ends
    // yesterday, which would drop today's session from a total or a streak.
    const range = step.window === 'all' ? null : windowRange(step.window, input.today, kit.first)
    if (step.window !== 'all' && range === null) continue
    const ctx: InsightContext = {
      rows: step.flexible ? kit.flexible : kit.rows,
      range,
      label: def.label,
      today: input.today,
      ended: kit.ended
    }
    const built = step.build(ctx)
    const list = built === null ? [] : Array.isArray(built) ? built : [built]
    const prefix = step.flexible ? `${def.label}, ${FLEXIBLE_ONLY}` : def.label
    for (const i of list) out.push(step.named ? i : { ...i, detail: `${prefix} · ${i.detail}` })
  }
  for (const step of KIT_PLAN) {
    const built = step.build(kit)
    const list = built === null ? [] : Array.isArray(built) ? built : [built]
    for (const i of list) out.push(step.weight === undefined ? i : { ...i, weight: step.weight })
  }
  // *"don't have a +0% bro that's sad"*. Said once here rather than in each
  // insight, so one written later cannot forget it: a headline of nothing -
  // 0%, +0%, 0 pts, a count of 0 - is never shown.
  return out
    .filter((i) => !ZERO.test(i.figure))
    .sort((a, b) => b.strength - a.strength || (a.id < b.id ? -1 : 1))
}

/** A figure that says nothing happened. */
const ZERO = /^[+−]?0( ?%| pts| [a-z]+)?$/

/**
 * The one to open on, chosen by `random` in [0, 1) and weighted by strength
 * and by the insight's own weight, so the strong ones and the user's
 * favourites come up more often without the rest never coming up. `avoid` is
 * the one shown last time; with a choice, it is not repeated.
 */
export function pickInsight(
  insights: readonly Insight[],
  random: number,
  avoid?: string | null
): Insight | null {
  if (insights.length === 0) return null
  const pool = insights.length > 1 && avoid ? insights.filter((i) => i.id !== avoid) : [...insights]
  const choices = pool.length > 0 ? pool : [...insights]
  const weights = choices.map((i) => (0.1 + Math.max(0, i.strength)) * (i.weight ?? 1))
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.min(Math.max(random, 0), 0.999999) * total
  for (let i = 0; i < choices.length; i += 1) {
    r -= weights[i]
    if (r < 0) return choices[i]
  }
  return choices[choices.length - 1]
}
