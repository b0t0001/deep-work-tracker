/**
 * Insights about timers, output, projects, milestones - and the quirky ones.
 *
 * Round one of the candidate list, sections D to G and I, as the user kept
 * them. The rules in `insightKit.ts` apply throughout; the ones that bite
 * most here:
 *
 * - **A stop, a lap or a run to zero is read from app-recorded sessions
 *   only** (`isTimerRun`). Imported rows were laps of untracked loops as
 *   often as single runs, so they say nothing about when a timer was
 *   stopped. These stay silent until `APP_RUNS` sessions exist.
 * - **A rate is compared within one unit and one course**, and a question
 *   rate only inside the past 90 days (`rateGroups`).
 * - **Milestones look forward as well as back** - the user: *"especially the
 *   forward projections. because then i want to RACE to get there"*.
 */
import type { SessionRow } from './analytics'
import { courseFrom } from './courses'
import { formatDate } from './dates'
import { formatCount, formatHours, pluralUnit, verbFor } from './facts'
import {
  clamp01,
  countDays,
  dateOf,
  dayHours,
  dayNumber,
  FAVOURITE,
  FLEXIBLE_ONLY,
  formatMinutes,
  formatRate,
  hasPlan,
  hoursOf,
  isTimerRun,
  lastDays,
  longestRun,
  medianOf,
  monthName,
  MONTHS,
  mostly,
  moved,
  NOW_AND_THEN,
  num1,
  pct,
  perDay,
  plural,
  pooledRate,
  quoted,
  ranked,
  rateGroups,
  rateWindow,
  runsOf,
  signedPct,
  sumBy,
  weekdayOf,
  WEEKDAYS,
  weekOf,
  within,
  type Insight,
  type Kit,
  type KitStep
} from './insightKit'

const YEAR = 365
/** App-recorded timer runs needed before stops and laps are spoken about. */
export const APP_RUNS = 30

function firstYear(kit: Kit): { from: string; to: string; days: number } {
  return { from: kit.first, to: dateOf(dayNumber(kit.first) + YEAR - 1), days: YEAR }
}

function spanDays(kit: Kit): number {
  return dayNumber(kit.last) - dayNumber(kit.first) + 1
}

function unitRows(kit: Kit, unit: string): SessionRow[] {
  return kit.rows.filter((r) => r.unit === unit && r.quantity !== null && r.quantity > 0)
}

function totalOf(rows: readonly SessionRow[]): number {
  return rows.reduce((s, r) => s + (r.quantity ?? 0), 0)
}

/* ---------------------------------------------------------------- D ---- */

/** The timer length set most often. Planned is what the timer was set to. */
export function favouriteLength(kit: Kit): Insight | null {
  const runs = within(kit.rows, lastDays(YEAR, kit.last)).filter(hasPlan)
  if (runs.length < 20) return null
  const top = ranked(
    sumBy(
      runs,
      (r) => String(r.plannedS),
      () => 1
    )
  )
  if (top.length < 2) return null
  return {
    id: 'favourite-length',
    figure: formatMinutes(Number(top[0][0]) / 60),
    text: `is the timer you set most: ${formatCount(top[0][1])} of ${formatCount(runs.length)} runs`,
    detail: `past 12 months · next: ${formatMinutes(Number(top[1][0]) / 60)} at ${pct(top[1][1] / runs.length)}`,
    strength: 0.4
  }
}

/** The typical timer now against in the first year. */
export function lengthThenNow(kit: Kit): Insight | null {
  if (spanDays(kit) < 2 * YEAR) return null
  const now = within(kit.rows, lastDays(YEAR, kit.last)).filter(hasPlan)
  const then = within(kit.rows, firstYear(kit)).filter(hasPlan)
  if (now.length < 20 || then.length < 20) return null
  const a = medianOf(now.map((r) => r.plannedS / 60))
  const b = medianOf(then.map((r) => r.plannedS / 60))
  if (!moved(a, b)) return null
  return {
    id: 'length-then-now',
    figure: formatMinutes(a),
    text: `is your typical timer now, against ${formatMinutes(b)} in your first year`,
    detail: 'the past 12 months against your first 12 · medians over timer runs',
    strength: clamp01(Math.abs(a / b - 1) / 0.8)
  }
}

/** Time left on the clock across every early stop. App-recorded only. */
export function handedBack(kit: Kit): Insight | null {
  const runs = kit.rows.filter(isTimerRun)
  const early = runs.filter((r) => r.runningS < r.plannedS)
  if (runs.length < APP_RUNS || early.length < 10) return null
  const left = early.reduce((s, r) => s + r.plannedS - r.runningS, 0) / 3600
  return {
    id: 'handed-back',
    figure: formatHours(left),
    text: 'left on the clock across every timer you stopped early',
    detail: `all time, app-recorded runs · ${formatCount(early.length)} early stops · a typical one leaves ${formatMinutes(medianOf(early.map((r) => (r.plannedS - r.runningS) / 60)))}`,
    strength: 0.45
  }
}

/** The timer length most often allowed to run out. App-recorded only. */
export function runOutLength(kit: Kit): Insight | null {
  const runs = kit.rows.filter(isTimerRun)
  if (runs.length < APP_RUNS) return null
  const by = new Map<number, SessionRow[]>()
  for (const r of runs) by.set(r.plannedS, [...(by.get(r.plannedS) ?? []), r])
  const share = (rs: SessionRow[]): number =>
    rs.filter((r) => r.runningS >= r.plannedS).length / rs.length
  const best = [...by.entries()]
    .filter(([, rs]) => rs.length >= 10)
    .sort((a, b) => share(b[1]) - share(a[1]))[0]
  if (best === undefined || !moved(share(best[1]), share(runs))) return null
  return {
    id: 'run-out-length',
    figure: `${formatMinutes(best[0] / 60)} timers`,
    text: `are the ones you most often let run out: ${pct(share(best[1]))}`,
    detail: `all time, app-recorded runs · ${best[1].length} runs · ${pct(share(runs))} across every length`,
    strength: 0.4
  }
}

/** The project whose timers are stopped earliest. App-recorded only. */
export function projectStops(kit: Kit): Insight | null {
  const runs = kit.rows.filter(isTimerRun)
  if (runs.length < APP_RUNS) return null
  const used = [...new Set(runs.map((r) => r.project).filter((p): p is string => p !== null))]
    .map((p): [string, number, number] => {
      const rs = runs.filter((r) => r.project === p)
      return [p, medianOf(rs.map((r) => Math.min(1, r.runningS / r.plannedS))), rs.length]
    })
    .filter(([, , n]) => n >= 10)
    .sort((a, b) => a[1] - b[1])
  if (used.length < 2) return null
  const [low, high] = [used[0], used[used.length - 1]]
  if (!moved(low[1], high[1])) return null
  return {
    id: 'project-stops',
    figure: pct(low[1]),
    text: `of the time set is what a typical ${low[0]} timer uses, the least of any project`,
    detail: `all time, app-recorded runs · most: ${high[0]} at ${pct(high[1])}`,
    strength: 0.4
  }
}

/** Timers that ran all the way to zero. App-recorded only. */
export function toZero(kit: Kit): Insight | null {
  const runs = kit.rows.filter(isTimerRun)
  const full = runs.filter((r) => r.runningS >= r.plannedS).sort((a, b) => b.runningS - a.runningS)
  if (runs.length < APP_RUNS || full.length < 5) return null
  return {
    id: 'to-zero',
    figure: formatCount(full.length),
    text: 'timers ran all the way to zero',
    detail: `all time, app-recorded runs · longest: ${formatMinutes(full[0].runningS / 60)} on ${quoted(full[0].task)}, ${formatDate(full[0].date)}`,
    strength: 0.35
  }
}

/** Sessions under five minutes. */
export function shortSessions(kit: Kit): Insight | null {
  const short = kit.rows.filter((r) => r.runningS > 0 && r.runningS < 300)
  if (short.length < 5) return null
  return {
    id: 'short-sessions',
    figure: formatCount(short.length),
    text: 'sessions lasted under five minutes',
    detail: `all time · ${pct(short.length / kit.rows.length)} of all sessions · ${formatHours(hoursOf(short))} between them`,
    strength: 0.3
  }
}

/** Share of time in sessions of an hour or more, now against the first year. */
export function hourPlusShare(kit: Kit): Insight | null {
  if (spanDays(kit) < 2 * YEAR) return null
  const share = (rows: SessionRow[]): number =>
    hoursOf(rows.filter((r) => r.runningS >= 3600)) / hoursOf(rows)
  const now = within(kit.rows, lastDays(YEAR, kit.last))
  const then = within(kit.rows, firstYear(kit))
  if (hoursOf(now) < 20 || hoursOf(then) < 20) return null
  const a = share(now)
  const b = share(then)
  if (!moved(a, b)) return null
  return {
    id: 'hour-plus-share',
    figure: pct(a),
    text: `of your time is in sessions of an hour or more, against ${pct(b)} in your first year`,
    detail: 'the past 12 months against your first 12',
    strength: clamp01(Math.abs(a / b - 1) / 0.8)
  }
}

/** The project with the longest typical session, flexible work only. */
export function longestSittingProject(kit: Kit): Insight | null {
  const typical = [
    ...new Set(kit.flexible.map((r) => r.project).filter((p): p is string => p !== null))
  ]
    .map((p): [string, number, number] => {
      const rs = kit.flexible.filter((r) => r.project === p && r.runningS > 0)
      return [p, medianOf(rs.map((r) => r.runningS / 60)), rs.length]
    })
    .filter(([, , n]) => n >= 20)
    .sort((a, b) => b[1] - a[1])
  if (typical.length < 2) return null
  const [top, low] = [typical[0], typical[typical.length - 1]]
  return {
    id: 'longest-sitting',
    figure: formatMinutes(top[1]),
    text: `is a typical ${top[0]} session, your longest-sitting project`,
    detail: `all time, ${FLEXIBLE_ONLY} · shortest: ${low[0]} at ${formatMinutes(low[1])} · medians`,
    strength: 0.35
  }
}

/** The go-to timer for the year's top project. */
export function goToTimer(kit: Kit): Insight | null {
  const year = within(kit.rows, lastDays(YEAR, kit.last))
  const project = mostly(year)
  const runs = year.filter((r) => r.project === project && hasPlan(r))
  if (project === null || runs.length < 20) return null
  const top = ranked(
    sumBy(
      runs,
      (r) => String(r.plannedS),
      () => 1
    )
  )[0]
  return {
    id: 'go-to-timer',
    figure: formatMinutes(Number(top[0]) / 60),
    text: `is your go-to timer for ${project}`,
    detail: `past 12 months · ${top[1]} of ${runs.length} ${project} runs`,
    strength: 0.35
  }
}

/** Early stops that came within five minutes of the end. App-recorded only. */
export function closeStops(kit: Kit): Insight | null {
  const runs = kit.rows.filter(isTimerRun)
  const early = runs.filter((r) => r.runningS < r.plannedS)
  if (runs.length < APP_RUNS || early.length < 10) return null
  const close = early.filter((r) => r.plannedS - r.runningS <= 300).length
  return {
    id: 'close-stops',
    figure: pct(close / early.length),
    text: 'of your early stops came within five minutes of the end',
    detail: `all time, app-recorded runs · ${close} of ${formatCount(early.length)}`,
    strength: 0.35
  }
}

/** Runs kept going past the time set. App-recorded only. */
export function overruns(kit: Kit): Insight | null {
  const runs = kit.rows.filter(isTimerRun)
  const over = runs.filter((r) => r.runningS > r.plannedS + 60)
  if (runs.length < APP_RUNS || over.length < 5) return null
  return {
    id: 'overruns',
    figure: formatCount(over.length),
    text: 'runs went past the time you set',
    detail: `all time, app-recorded runs · a typical overrun is ${formatMinutes(medianOf(over.map((r) => (r.runningS - r.plannedS) / 60)))}`,
    strength: 0.35
  }
}

/* ---------------------------------------------------------------- E ---- */

/** The fastest session within the unit-and-course pair with the most sessions. */
export function fastestSession(kit: Kit): Insight | null {
  const g = rateGroups(kit.rows, kit.last)[0]
  if (g === undefined || g.rows.length < 10) return null
  const best = [...g.rows].sort(
    (a, b) => (b.quantity as number) / b.runningS - (a.quantity as number) / a.runningS
  )[0]
  const noun = pluralUnit(g.unit, 2)
  return {
    id: 'fastest-session',
    figure: `${formatCount(best.quantity as number)} in ${formatMinutes(best.runningS / 60)}`,
    text: `${g.course} ${noun} on ${quoted(best.task)}, your fastest session in that course`,
    detail: `${rateWindow(g.unit)} · ${formatDate(best.date)} · ${formatRate((best.quantity as number) / (best.runningS / 60), noun)}, against ${formatRate(pooledRate(g.rows), noun)} usually`,
    strength: 0.4
  }
}

/** The most words in one session. */
export function mostWordsSession(kit: Kit): Insight | null {
  const rows = unitRows(kit, 'word')
  if (rows.length < 5) return null
  const best = [...rows].sort((a, b) => (b.quantity as number) - (a.quantity as number))[0]
  return {
    id: 'most-words-session',
    figure: `${formatCount(best.quantity as number)} words`,
    text: `in one session on ${quoted(best.task)}, your most in a sitting`,
    detail: `all time · ${formatDate(best.date)} · ${formatMinutes(best.runningS / 60)}`,
    strength: 0.45
  }
}

/** The most words in one day - unless that day was the record sitting. */
export function biggestWritingDay(kit: Kit): Insight | null {
  const rows = unitRows(kit, 'word')
  if (rows.length < 5) return null
  const [date, words] = ranked(
    sumBy(
      rows,
      (r) => r.date,
      (r) => r.quantity as number
    )
  )[0]
  const that = rows.filter((r) => r.date === date)
  // A day that was one session is the record sitting told twice.
  if (that.length < 2) return null
  return {
    id: 'biggest-writing-day',
    figure: `${formatCount(words)} words`,
    text: `on ${formatDate(date)}, your biggest writing day`,
    detail: `all time · ${plural(that.length, 'session')}, mostly ${mostly(that)}`,
    strength: 0.45
  }
}

/** Words written as double-spaced pages. A user favourite. */
export function pagesWritten(kit: Kit): Insight | null {
  const words = totalOf(unitRows(kit, 'word'))
  if (words < 1000) return null
  return {
    id: 'pages-written',
    figure: `${formatCount(Math.round(words / 250))} pages`,
    text: "double-spaced: everything you've written here",
    detail: `all time · ${formatCount(words)} words at 250 a page`,
    strength: 0.5
  }
}

/** A typical drafting session. */
export function draftingSession(kit: Kit): Insight | null {
  const rows = unitRows(kit, 'word').filter((r) => /draft/i.test(r.task ?? ''))
  if (rows.length < 5) return null
  return {
    id: 'drafting-session',
    figure: `${formatCount(Math.round(medianOf(rows.map((r) => r.quantity as number))))} words`,
    text: 'is a typical drafting session',
    detail: `all time · median over ${formatCount(rows.length)} sessions with "draft" in the task`,
    strength: 0.35
  }
}

/** The highest draft number of any piece. */
export function furthestDraft(kit: Kit): Insight | null {
  let best: { n: number; row: SessionRow } | null = null
  for (const r of kit.rows) {
    const m = /draft ([0-9]+)/i.exec(r.task ?? '')
    if (m !== null && (best === null || Number(m[1]) > best.n)) best = { n: Number(m[1]), row: r }
  }
  if (best === null || best.n < 3) return null
  const piece = (best.row.task as string).replace(/ ?draft [0-9.]+/i, '').trim()
  return {
    id: 'furthest-draft',
    figure: `Draft ${best.n}`,
    text: `of ${quoted(piece)} is the furthest you've taken one piece`,
    detail: `all time · ${formatDate(best.row.date)}`,
    strength: clamp01(best.n / 20)
  }
}

/** Pages, as books at 300 pages a book. */
export function pageBooks(kit: Kit): Insight | null {
  const rows = unitRows(kit, 'page')
  const pages = totalOf(rows)
  if (pages < 100) return null
  return {
    id: 'page-books',
    figure: `${formatCount(pages)} pages`,
    text: `${verbFor(
      'page',
      rows.map((r) => r.task).filter((t): t is string => t !== null)
    )}: about ${num1(pages / 300)} books' worth`,
    detail: `all time · at 300 pages a book · ${plural(rows.length, 'session')}`,
    strength: 0.4
  }
}

/** How many different things output has been counted in, and the newest. */
export function unitsCounted(kit: Kit): Insight | null {
  const first = new Map<string, string>()
  for (const r of kit.rows) if (r.unit && !first.has(r.unit)) first.set(r.unit, r.date)
  if (first.size < 10) return null
  const [unit, date] = [...first.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1))[0]
  return {
    id: 'units-counted',
    figure: formatCount(first.size),
    text: "different things you've counted your output in",
    detail: `all time · the newest: ${quoted(unit)}, first used ${formatDate(date)}`,
    strength: 0.35
  }
}

/** The unit counted most now against in the first year. */
export function unitThenNow(kit: Kit): Insight | null {
  if (spanDays(kit) < 2 * YEAR) return null
  const top = (rows: SessionRow[]): [string, number] | undefined =>
    ranked(
      sumBy(
        rows,
        (r) => r.unit,
        () => 1
      )
    )[0]
  const a = top(within(kit.rows, lastDays(YEAR, kit.last)))
  const b = top(within(kit.rows, firstYear(kit)))
  if (a === undefined || b === undefined || a[0] === b[0] || a[1] < 10 || b[1] < 10) return null
  const now = pluralUnit(a[0], 2)
  return {
    id: 'unit-then-now',
    figure: now[0].toUpperCase() + now.slice(1),
    text: `are what you count most now; in your first year it was ${pluralUnit(b[0], 2)}`,
    detail: `the past 12 months (${a[1]} sessions) against your first 12 (${b[1]})`,
    strength: 0.35
  }
}

/** Sessions marked unquantifiable. */
export function unquantifiable(kit: Kit): Insight | null {
  const rows = kit.rows.filter((r) => r.unquantifiable === true)
  if (rows.length === 0) return null
  return {
    id: 'unquantifiable',
    figure: formatCount(rows.length),
    text: `session${rows.length === 1 ? ' was' : 's were'} marked unquantifiable`,
    detail: `all time · ${formatHours(hoursOf(rows))} of work with no number on it`,
    strength: 0.25
  }
}

/** Pace in sessions over an hour against shorter ones, within one unit and course. */
export function longSessionPace(kit: Kit): Insight | null {
  const found = rateGroups(kit.rows, kit.last)
    .map((g) => {
      const long = g.rows.filter((r) => r.runningS >= 3600)
      const short = g.rows.filter((r) => r.runningS < 3600)
      return { g, long, short, a: pooledRate(long), b: pooledRate(short) }
    })
    .filter((x) => x.long.length >= 5 && x.short.length >= 5 && moved(x.a, x.b))
    .sort((x, y) => Math.abs(Math.log(y.a / y.b)) - Math.abs(Math.log(x.a / x.b)))[0]
  if (found === undefined) return null
  const noun = pluralUnit(found.g.unit, 2)
  return {
    id: 'long-session-pace',
    figure: signedPct(found.a / found.b - 1),
    text: `pace on ${found.g.course} ${noun} in sessions over an hour, against shorter ones`,
    detail: `${rateWindow(found.g.unit)} · ${formatRate(found.a, noun)} in long sessions, ${formatRate(found.b, noun)} in short · ${found.long.length} and ${found.short.length} sessions`,
    strength: clamp01(Math.abs(Math.log(found.a / found.b)) / Math.log(3))
  }
}

/** The fastest weekday within the busiest unit-and-course pair. */
export function weekdayPace(kit: Kit): Insight | null {
  const g = rateGroups(kit.flexible, kit.last)[0]
  if (g === undefined) return null
  const days = [0, 1, 2, 3, 4, 5, 6]
    .map((w): [number, SessionRow[]] => [w, g.rows.filter((r) => weekdayOf(r.date) === w)])
    .filter(([, rs]) => rs.length >= 5)
  if (days.length < 3) return null
  const best = [...days].sort((a, b) => pooledRate(b[1]) - pooledRate(a[1]))[0]
  const a = pooledRate(best[1])
  const all = pooledRate(g.rows)
  if (!moved(a, all)) return null
  const noun = pluralUnit(g.unit, 2)
  return {
    id: 'weekday-pace',
    figure: `${WEEKDAYS[best[0]]}s`,
    text: `are your fastest day on ${g.course} ${noun}: ${pct(a / all - 1)} above your usual pace`,
    detail: `${rateWindow(g.unit)}, ${FLEXIBLE_ONLY} · ${formatRate(a, noun)} on ${WEEKDAYS[best[0]]}s, ${formatRate(all, noun)} overall`,
    strength: clamp01((a / all - 1) / 0.8)
  }
}

/** Pace this month against the rest of the group's window. */
export function recentPace(kit: Kit): Insight | null {
  const since = lastDays(30, kit.last).from
  const found = rateGroups(kit.rows, kit.last)
    .map((g) => {
      const now = g.rows.filter((r) => r.date >= since)
      const before = g.rows.filter((r) => r.date < since)
      return { g, now, before, a: pooledRate(now), b: pooledRate(before) }
    })
    .filter((x) => x.now.length >= 5 && x.before.length >= 5 && moved(x.a, x.b))
    .sort((x, y) => Math.abs(Math.log(y.a / y.b)) - Math.abs(Math.log(x.a / x.b)))[0]
  if (found === undefined) return null
  const noun = pluralUnit(found.g.unit, 2)
  return {
    id: 'recent-pace',
    figure: signedPct(found.a / found.b - 1),
    text: `pace on ${found.g.course} ${noun} this month, against before`,
    detail: `past 30 days against the rest of the ${rateWindow(found.g.unit)} · ${formatRate(found.a, noun)} lately, ${formatRate(found.b, noun)} before`,
    strength: clamp01(Math.abs(Math.log(found.a / found.b)) / Math.log(3))
  }
}

/** The course with the most questions. */
export function courseQuestions(kit: Kit): Insight | null {
  const top = ranked(
    sumBy(
      unitRows(kit, 'question'),
      (r) => courseFrom(r.task),
      (r) => r.quantity as number
    )
  )
  if (top.length < 2) return null
  return {
    id: 'course-questions',
    figure: formatCount(top[0][1]),
    text: `${top[0][0]} questions answered, more than any other course`,
    detail: `all time · next: ${top[1][0]} at ${formatCount(top[1][1])}`,
    strength: 0.35
  }
}

/** The biggest writing week. */
export function writingWeek(kit: Kit): Insight | null {
  const rows = unitRows(kit, 'word')
  if (rows.length < 5) return null
  const [week, words] = ranked(
    sumBy(
      rows,
      (r) => weekOf(r.date),
      (r) => r.quantity as number
    )
  )[0]
  return {
    id: 'writing-week',
    figure: `${formatCount(words)} words`,
    text: `in the week of ${formatDate(week)}, your biggest writing week`,
    detail: `all time · mostly ${mostly(within(rows, { from: week, to: dateOf(dayNumber(week) + 6), days: 7 }))}`,
    strength: 0.4
  }
}

/** Slides as decks. A user favourite. */
export function slideDecks(kit: Kit): Insight | null {
  const slides = totalOf(unitRows(kit, 'slide'))
  if (slides < 50) return null
  return {
    id: 'slide-decks',
    figure: `${formatCount(Math.round(slides / 15))} decks`,
    text: 'worth of slides made',
    detail: `all time · ${formatCount(slides)} slides at 15 a deck`,
    strength: 0.5
  }
}

/** The longest run of days with words written. */
export function wordsStreak(kit: Kit): Insight | null {
  const rows = unitRows(kit, 'word')
  const run = longestRun(runsOf(rows.map((r) => r.date)))
  if (run === null || run.length < 3) return null
  return {
    id: 'words-streak',
    figure: `${run.length} days`,
    text: `in a row with words written, ending ${formatDate(run.to)}`,
    detail: `all time · ${formatCount(totalOf(within(rows, { from: run.from, to: run.to, days: run.length })))} words across them`,
    strength: clamp01(run.length / 20)
  }
}

/** The project that got the most words. */
export function wordsProject(kit: Kit): Insight | null {
  const top = ranked(
    sumBy(
      unitRows(kit, 'word'),
      (r) => r.project,
      (r) => r.quantity as number
    )
  )
  const total = top.reduce((s, [, w]) => s + w, 0)
  if (top.length < 2 || total < 1000) return null
  return {
    id: 'words-project',
    figure: pct(top[0][1] / total),
    text: `of your words went to ${top[0][0]}`,
    detail: `all time · ${formatCount(top[0][1])} of ${formatCount(total)} · next: ${top[1][0]}`,
    strength: 0.35
  }
}

/** Share of sessions with their output recorded. */
export function measuredShare(kit: Kit): Insight | null {
  if (kit.rows.length < 20) return null
  const share = (rows: readonly SessionRow[]): number =>
    rows.filter((r) => r.quantity !== null || r.unquantifiable === true).length / rows.length
  const year = within(kit.rows, lastDays(YEAR, kit.last))
  return {
    id: 'measured-share',
    figure: pct(share(kit.rows)),
    text: 'of your sessions have their output recorded',
    detail: `all time · ${year.length > 0 ? `${pct(share(year))} in the past 12 months` : 'none in the past 12 months'}`,
    strength: 0.3
  }
}

/** The most questions in a day. */
export function questionsDay(kit: Kit): Insight | null {
  const rows = unitRows(kit, 'question')
  if (rows.length < 5) return null
  const [date, n] = ranked(
    sumBy(
      rows,
      (r) => r.date,
      (r) => r.quantity as number
    )
  )[0]
  return {
    id: 'questions-day',
    figure: `${formatCount(n)} questions`,
    text: `on ${formatDate(date)}, your most in a day`,
    detail: `all time · mostly ${mostly(rows.filter((r) => r.date === date))}`,
    strength: 0.4
  }
}

/** How often a pace target was met. App-recorded only, by construction. */
export function paceTargets(kit: Kit): Insight | null {
  const paced = kit.rows.filter(
    (r) =>
      (r.paceQty ?? 0) > 0 && (r.paceIntervalS ?? 0) > 0 && r.quantity !== null && r.runningS > 0
  )
  if (paced.length < 5) return null
  const target = (r: SessionRow): number =>
    ((r.paceQty as number) * r.runningS) / (r.paceIntervalS as number)
  const hit = paced.filter((r) => (r.quantity as number) >= target(r))
  return {
    id: 'pace-targets',
    figure: pct(hit.length / paced.length),
    text: 'of your paced sessions hit their target',
    detail: `all time · ${hit.length} of ${paced.length} · the target is the pace set times the minutes run`,
    strength: 0.45
  }
}

/* ---------------------------------------------------------------- F ---- */

/** The all-time top project. */
export function allTimeTopProject(kit: Kit): Insight | null {
  const top = ranked(sumBy(kit.rows, (r) => r.project))
  const total = hoursOf(kit.rows)
  if (top.length < 2 || total < 10) return null
  return {
    id: 'all-time-top-project',
    figure: pct(top[0][1] / total),
    text: `of all your time has gone to ${top[0][0]}`,
    detail: `all time · ${formatHours(top[0][1])} of ${formatHours(total)} · next: ${top[1][0]} at ${pct(top[1][1] / total)}`,
    strength: 0.35
  }
}

/** Projects on the go this month against a year ago. */
export function projectsOnTheGo(kit: Kit): Insight | null {
  if (spanDays(kit) < YEAR + 30) return null
  const names = (end: string): string[] => [
    ...new Set(
      within(kit.rows, lastDays(30, end))
        .map((r) => r.project)
        .filter((p): p is string => p !== null)
    )
  ]
  const now = names(kit.last)
  const then = names(dateOf(dayNumber(kit.last) - YEAR))
  if (!moved(now.length, then.length)) return null
  return {
    id: 'projects-on-the-go',
    figure: plural(now.length, 'project'),
    text: `on the go this month, against ${then.length} a year ago`,
    detail: `past 30 days · ${now.join(', ')}`,
    strength: 0.3
  }
}

function firstSeen(
  rows: readonly SessionRow[],
  key: (r: SessionRow) => string | null
): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of rows) {
    const k = key(r)
    if (k !== null && !out.has(k)) out.set(k, r.date)
  }
  return out
}

/** The newest project. */
export function newestProject(kit: Kit): Insight | null {
  const first = [...firstSeen(kit.rows, (r) => r.project).entries()].sort((a, b) =>
    a[1] < b[1] ? 1 : -1
  )
  if (first.length < 2) return null
  const [p, d] = first[0]
  return {
    id: 'newest-project',
    figure: p,
    text: `is your newest project, started ${formatDate(d)}`,
    detail: `all time · ${formatHours(hoursOf(kit.rows.filter((r) => r.project === p)))} on it since`,
    strength: 0.35
  }
}

/** The longest-running project still active. */
export function longestActiveProject(kit: Kit): Insight | null {
  const active = new Set(within(kit.rows, lastDays(30, kit.last)).map((r) => r.project))
  const first = kit.rows.find((r) => r.project !== null && active.has(r.project))
  if (first === undefined) return null
  const p = first.project as string
  return {
    id: 'longest-active-project',
    figure: p,
    text: `is your longest-running active project, since ${formatDate(first.date)}`,
    detail: `all time · ${formatHours(hoursOf(kit.rows.filter((r) => r.project === p)))} in all · still worked on in the past 30 days`,
    strength: 0.35
  }
}

/** The project that grew most, quarter on quarter. */
export function growingProject(kit: Kit): Insight | null {
  const now = sumBy(within(kit.rows, lastDays(90, kit.last)), (r) => r.project)
  const then = sumBy(
    within(kit.rows, lastDays(90, dateOf(dayNumber(kit.last) - 90))),
    (r) => r.project
  )
  const best = [...now.entries()]
    .map(([p, h]): [string, number, number] => [p, h, then.get(p) ?? 0])
    .sort((a, b) => b[1] - b[2] - (a[1] - a[2]))[0]
  if (
    best === undefined ||
    best[1] < 5 ||
    best[1] - best[2] < 5 ||
    (best[2] > 0 && !moved(best[1], best[2]))
  )
    return null
  return {
    id: 'growing-project',
    figure: `+${formatHours(best[1] - best[2])}`,
    text: `on ${best[0]}, your fastest-growing project`,
    detail: `the past 90 days against the 90 before · ${formatHours(best[1])} now, ${formatHours(best[2])} then`,
    strength: clamp01((best[1] - best[2]) / 80)
  }
}

/** The task name used most. */
export function repeatedTask(kit: Kit): Insight | null {
  const top = ranked(
    sumBy(
      kit.rows,
      (r) => r.task,
      () => 1
    )
  )[0]
  if (top === undefined || top[1] < 5) return null
  return {
    id: 'repeated-task',
    figure: plural(top[1], 'session'),
    text: `of ${quoted(top[0])}, your most repeated task`,
    detail: `all time · ${formatHours(hoursOf(kit.rows.filter((r) => r.task === top[0])))} in all`,
    strength: 0.3
  }
}

const STOP_WORDS = new Set('the and for with from into your you of to in on at an my hw'.split(' '))

function words(task: string | null): string[] {
  return (task ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
}

/** The word typed into the most task names. */
export function commonWord(kit: Kit): Insight | null {
  if (kit.rows.length < 100) return null
  const counts = new Map<string, number>()
  for (const r of kit.rows)
    for (const w of new Set(words(r.task))) counts.set(w, (counts.get(w) ?? 0) + 1)
  const top = ranked(counts)
  if (top.length < 4) return null
  return {
    id: 'common-word',
    figure: quoted(top[0][0]),
    text: `is the word you've typed into the most task names: ${formatCount(top[0][1])}`,
    detail: `all time · then ${top
      .slice(1, 4)
      .map(([w, n]) => `${quoted(w)} ${n}`)
      .join(', ')}`,
    strength: 0.3
  }
}

/** The project that most recently crossed 100 hours. A user favourite. */
export function projectHundred(kit: Kit): Insight | null {
  const totals = new Map<string, number>()
  let latest: { p: string; d: string } | null = null
  for (const r of kit.rows) {
    if (r.project === null) continue
    const before = totals.get(r.project) ?? 0
    const after = before + r.runningS / 3600
    totals.set(r.project, after)
    if (before < 100 && after >= 100) latest = { p: r.project, d: r.date }
  }
  if (latest === null) return null
  return {
    id: 'project-hundred',
    figure: latest.p,
    text: `crossed 100 hours on ${formatDate(latest.d)}, the latest project to get there`,
    detail: `all time · ${[...totals.values()].filter((h) => h >= 100).length} projects past 100 h`,
    strength: 0.5
  }
}

/** The project with the longest life, first session to last. */
export function projectLifespan(kit: Kit): Insight | null {
  const first = firstSeen(kit.rows, (r) => r.project)
  const last = new Map<string, string>()
  const count = new Map<string, number>()
  for (const r of kit.rows)
    if (r.project !== null) {
      last.set(r.project, r.date)
      count.set(r.project, (count.get(r.project) ?? 0) + 1)
    }
  const best = [...first.keys()]
    .filter((p) => (count.get(p) ?? 0) >= 10)
    .map((p): [string, number] => [
      p,
      dayNumber(last.get(p) as string) - dayNumber(first.get(p) as string)
    ])
    .sort((a, b) => b[1] - a[1])[0]
  if (best === undefined || best[1] < 60) return null
  return {
    id: 'project-lifespan',
    figure: `${num1(best[1] / YEAR)} years`,
    text: `of ${best[0]}, your longest-lived project`,
    detail: `all time · ${formatDate(first.get(best[0]) as string)} to ${formatDate(last.get(best[0]) as string)}`,
    strength: 0.3
  }
}

/** How many projects make up 80% of the time. */
export function eightyPercent(kit: Kit): Insight | null {
  const count = (rows: SessionRow[]): [number, number] => {
    const top = ranked(sumBy(rows, (r) => r.project))
    const total = hoursOf(rows)
    let sum = 0
    let i = 0
    while (sum < 0.8 * total && i < top.length) sum += top[i++][1]
    return [i, top.length]
  }
  const [a, an] = count(within(kit.rows, lastDays(YEAR, kit.last)))
  const [b, bn] = count([...kit.rows])
  if (an < 5) return null
  return {
    id: 'eighty-percent',
    figure: plural(a, 'project'),
    text: 'account for 80% of your time this past year',
    detail: `past 12 months, of ${an} projects · all time it takes ${b} of ${bn}`,
    strength: 0.3
  }
}

/** Distinct projects in each calendar year. */
export function projectsPerYear(kit: Kit): Insight | null {
  const years = [...new Set(kit.rows.map((r) => r.date.slice(0, 4)))].sort()
  if (years.length < 2) return null
  const counts = years.map((y): [string, number] => [
    y,
    new Set(
      kit.rows.filter((r) => r.date.startsWith(y) && r.project !== null).map((r) => r.project)
    ).size
  ])
  const [y, n] = counts[counts.length - 1]
  return {
    id: 'projects-per-year',
    figure: plural(n, 'project'),
    text: `so far in ${y}`,
    detail: `all time · ${counts.map(([yy, nn]) => `${yy}: ${nn}`).join(' · ')}`,
    strength: 0.25
  }
}

/** The first word that starts the most tasks. */
export function firstWord(kit: Kit): Insight | null {
  if (kit.rows.length < 100) return null
  const top = ranked(
    sumBy(
      kit.rows,
      (r) => (r.task ?? '').trim().split(/ +/)[0].toLowerCase() || null,
      () => 1
    )
  )
  if (top.length < 4) return null
  const word =
    top[0][0].length <= 3
      ? top[0][0].toUpperCase()
      : top[0][0][0].toUpperCase() + top[0][0].slice(1)
  return {
    id: 'first-word',
    figure: quoted(word),
    text: `starts more of your tasks than any other word: ${pct(top[0][1] / kit.rows.length)}`,
    detail: `all time · then ${top
      .slice(1, 4)
      .map(([w, n]) => `${quoted(w)} ${pct(n / kit.rows.length)}`)
      .join(', ')}`,
    strength: 0.3
  }
}

/** The newest course code. */
export function newestCourse(kit: Kit): Insight | null {
  const first = [...firstSeen(kit.rows, (r) => courseFrom(r.task)).entries()].sort((a, b) =>
    a[1] < b[1] ? 1 : -1
  )
  if (first.length < 2) return null
  const [c, d] = first[0]
  return {
    id: 'newest-course',
    figure: c,
    text: `is your newest course, first seen ${formatDate(d)}`,
    detail: `all time · ${formatHours(hoursOf(kit.rows.filter((r) => courseFrom(r.task) === c)))} on it since`,
    strength: 0.3
  }
}

/** Sessions that carry a note. */
export function notes(kit: Kit): Insight | null {
  const rows = kit.rows.filter((r) => r.note === true)
  if (rows.length < 10) return null
  return {
    id: 'notes',
    figure: formatCount(rows.length),
    text: 'sessions carry a note',
    detail: `all time · ${pct(rows.length / kit.rows.length)} of sessions · most on ${mostly(rows)}`,
    strength: 0.25
  }
}

/* ---------------------------------------------------------------- G ---- */

/** Where each thousand hours was crossed. User favourites. */
export function hourCrossings(kit: Kit): Insight[] {
  const out: Insight[] = []
  let sum = 0
  let next = 1000
  for (const r of kit.rows) {
    sum += r.runningS / 3600
    while (sum >= next) {
      out.push({
        id: `hours-${next}`,
        figure: formatDate(r.date),
        text: `is when you crossed ${formatCount(next)} hours, on ${quoted(r.task)}`,
        detail: `all time · ${r.project ?? 'unlabelled'} · ${formatCount(dayNumber(r.date) - dayNumber(kit.first))} days after your first session`,
        strength: 0.5
      })
      next += 1000
    }
  }
  return out
}

/** When the next 500 hours land at the recent pace. A user favourite. */
export function nextHours(kit: Kit): Insight | null {
  const total = hoursOf(kit.rows)
  const pace = hoursOf(within(kit.rows, lastDays(90, kit.last))) / 90
  if (pace * 90 < 20) return null
  const mark = Math.floor(total / 500) * 500 + 500
  const days = Math.ceil((mark - total) / pace)
  return {
    id: 'next-hours',
    figure: formatDate(dateOf(dayNumber(kit.last) + days)),
    text: `is when you'll reach ${formatCount(mark)} hours at your current pace`,
    detail: `past 90 days' pace · ${formatHours(mark - total)} to go at ${perDay(pace)} a day`,
    strength: 0.55
  }
}

/** The thousandth sessions. A user favourite. */
export function sessionNumbers(kit: Kit): Insight | null {
  if (kit.rows.length < 1000) return null
  const k = Math.floor(kit.rows.length / 1000) * 1000
  const row = kit.rows[k - 1]
  const earlier = k > 1000 ? kit.rows[999] : null
  return {
    id: 'session-numbers',
    figure: formatDate(row.date),
    text: `was your ${formatCount(k)}th session: ${quoted(row.task)}`,
    detail: `all time${earlier ? ` · the 1,000th was ${formatDate(earlier.date)}, ${quoted(earlier.task)}` : ''}`,
    strength: 0.45
  }
}

/** When the next 500th session lands at the recent pace. A user favourite. */
export function nextSessionMark(kit: Kit): Insight | null {
  const recent = within(kit.rows, lastDays(90, kit.last)).length
  if (recent < 10) return null
  const mark = Math.floor(kit.rows.length / 500) * 500 + 500
  const pace = recent / 90
  return {
    id: 'next-session-mark',
    figure: formatDate(dateOf(dayNumber(kit.last) + Math.ceil((mark - kit.rows.length) / pace))),
    text: `is when you'll log session ${formatCount(mark)}`,
    detail: `past 90 days' pace · ${mark - kit.rows.length} to go at ${num1(pace)} a day`,
    strength: 0.45
  }
}

/** Every hour back to back. A user favourite. */
export function nonstop(kit: Kit): Insight | null {
  const hours = hoursOf(kit.rows)
  if (hours < 24) return null
  return {
    id: 'nonstop',
    figure: `${num1(hours / 24)} days`,
    text: 'of nonstop work, if every session ran back to back around the clock',
    detail: `all time · ${formatHours(hours)} ÷ 24`,
    strength: 0.45
  }
}

/** Days with any work since the first. A user favourite. */
export function daysWithWork(kit: Kit): Insight | null {
  const days = dayHours(kit.rows).size
  if (days < 10) return null
  const span = dayNumber(kit.today) - dayNumber(kit.first) + 1
  return {
    id: 'days-with-work',
    figure: formatCount(days),
    text: 'days with work since you started',
    detail: `all time · ${pct(days / span)} of ${formatCount(span)} days`,
    strength: 0.4
  }
}

/** Which all-time records fell in the past year. A user favourite. */
export function recentRecords(kit: Kit): Insight | null {
  const day = ranked(dayHours(kit.rows))[0]
  const week = ranked(sumBy(kit.rows, (r) => weekOf(r.date)))[0]
  const month = ranked(sumBy(kit.rows, (r) => r.date.slice(0, 7)))[0]
  if (day === undefined || week === undefined || month === undefined) return null
  const since = lastDays(YEAR, kit.last).from
  const records: Array<[string, string, string]> = [
    ['biggest day', day[0], formatDate(day[0])],
    ['biggest week', week[0], `week of ${formatDate(week[0])}`],
    ['biggest month', `${month[0]}-01`, monthName(month[0])]
  ]
  const recent = records.filter(([, d]) => d >= since).length
  if (recent === 0) return null
  return {
    id: 'recent-records',
    figure: `${recent} of 3`,
    text: 'all-time records (biggest day, week and month) were set in the past year',
    detail: `all time · ${records.map(([n, , shown]) => `${n}: ${shown}`).join(' · ')}`,
    strength: 0.3 + 0.15 * recent
  }
}

/** Where it all started. Shown now and then. */
export function whereItStarted(kit: Kit): Insight | null {
  const r = kit.rows[0]
  if (r === undefined) return null
  return {
    id: 'where-it-started',
    figure: formatDate(r.date),
    text: `is where it starts: ${quoted(r.task)}${r.project ? `, ${r.project}` : ''}`,
    detail: `all time · ${formatMinutes(r.runningS / 60)}`,
    strength: 0.3
  }
}

/** How long the latest 100 hours took against the first 100. A user favourite. */
export function hundredSpeed(kit: Kit): Insight | null {
  if (hoursOf(kit.rows) < 200) return null
  let sum = 0
  let firstEnd = kit.first
  for (const r of kit.rows) {
    sum += r.runningS / 3600
    if (sum >= 100) {
      firstEnd = r.date
      break
    }
  }
  sum = 0
  let latestStart = kit.today
  for (let i = kit.rows.length - 1; i >= 0; i -= 1) {
    sum += kit.rows[i].runningS / 3600
    if (sum >= 100) {
      latestStart = kit.rows[i].date
      break
    }
  }
  const lastDay = kit.rows[kit.rows.length - 1].date
  const a = dayNumber(lastDay) - dayNumber(latestStart) + 1
  const b = dayNumber(firstEnd) - dayNumber(kit.first) + 1
  if (!moved(a, b)) return null
  return {
    id: 'hundred-speed',
    figure: `${a} days`,
    text: `for your latest 100 hours; the first 100 took ${b}`,
    detail: `all time · ${formatDate(kit.first)}–${formatDate(firstEnd)} against ${formatDate(latestStart)}–${formatDate(lastDay)}`,
    strength: clamp01(Math.abs(Math.log(b / a)) / Math.log(5))
  }
}

/** The top project's latest hundred-hour mark. */
export function projectMark(kit: Kit): Insight | null {
  const project = mostly(kit.rows)
  if (project === null) return null
  let sum = 0
  let mark: { h: number; d: string } | null = null
  for (const r of kit.rows) {
    if (r.project !== project) continue
    const before = sum
    sum += r.runningS / 3600
    if (Math.floor(sum / 100) > Math.floor(before / 100))
      mark = { h: Math.floor(sum / 100) * 100, d: r.date }
  }
  if (mark === null) return null
  return {
    id: 'project-mark',
    figure: `${formatCount(mark.h)} h`,
    text: `of ${project}, crossed on ${formatDate(mark.d)}`,
    detail: `all time · ${formatHours(sum)} in all`,
    strength: 0.4
  }
}

/* ---------------------------------------------------------------- I ---- */

/** Work on Fridays the 13th. */
export function fridayThirteenth(kit: Kit): Insight | null {
  const fridays: string[] = []
  for (let n = dayNumber(kit.first); n <= dayNumber(kit.today); n += 1) {
    const d = dateOf(n)
    if (d.endsWith('-13') && weekdayOf(d) === 5) fridays.push(d)
  }
  const hours = dayHours(kit.rows)
  const worked = fridays.filter((d) => hours.has(d))
  if (worked.length === 0) return null
  return {
    id: 'friday-13th',
    figure: `${worked.length} of ${fridays.length}`,
    text: 'Fridays the 13th had work in them',
    detail: `all time · ${formatHours(worked.reduce((s, d) => s + (hours.get(d) ?? 0), 0))} in all`,
    strength: 0.3
  }
}

/** Hours as months of a full-time job. */
export function fullTimeMonths(kit: Kit): Insight | null {
  const hours = hoursOf(kit.rows)
  const month = (40 * 52) / 12
  if (hours < month) return null
  return {
    id: 'full-time-months',
    figure: `${num1(hours / month)} months`,
    text: 'of a full-time job, in hours',
    detail: `all time · ${formatHours(hours)} at 173 h a month (40 h × 52 weeks ÷ 12)`,
    strength: 0.35
  }
}

/** One session every so many hours of calendar time. */
export function sessionEvery(kit: Kit): Insight | null {
  if (kit.rows.length < 10) return null
  const days = dayNumber(kit.today) - dayNumber(kit.first) + 1
  return {
    id: 'session-every',
    figure: `Every ${num1((days * 24) / kit.rows.length)} h`,
    text: "you've started another session, on average, since day one",
    detail: `all time · ${formatCount(kit.rows.length)} sessions over ${formatCount(days)} days`,
    strength: 0.3
  }
}

/** Timers set to a round five minutes. */
export function roundTimers(kit: Kit): Insight | null {
  const runs = kit.rows.filter(hasPlan)
  if (runs.length < 20) return null
  const round = runs.filter((r) => r.plannedS % 300 === 0).length
  return {
    id: 'round-timers',
    figure: pct(round / runs.length),
    text: 'of your timers were set to a round five minutes',
    detail: `all time · ${formatCount(runs.length - round)} odd ones out`,
    strength: 0.3
  }
}

/** The quantity recorded most often. */
export function luckyNumber(kit: Kit): Insight | null {
  const top = ranked(
    sumBy(
      kit.rows.filter((r) => r.quantity !== null),
      (r) => String(r.quantity),
      () => 1
    )
  )
  if (top.length < 3 || top[0][1] < 10) return null
  return {
    id: 'lucky-number',
    figure: top[0][0],
    text: "is your lucky number: the output you've recorded most often",
    detail: `all time · ${top[0][1]} times · then ${top[1][0]} (${top[1][1]}), ${top[2][0]} (${top[2][1]})`,
    strength: 0.3
  }
}

/** Work on Pi Day. */
export function piDay(kit: Kit): Insight | null {
  const hours = dayHours(kit.rows)
  const days: string[] = []
  for (let y = Number(kit.first.slice(0, 4)); y <= Number(kit.today.slice(0, 4)); y += 1) {
    const d = `${y}-03-14`
    if (d >= kit.first && d <= kit.today) days.push(d)
  }
  const worked = days.filter((d) => hours.has(d))
  if (worked.length === 0) return null
  return {
    id: 'pi-day',
    figure: formatHours(worked.reduce((s, d) => s + (hours.get(d) ?? 0), 0)),
    text: 'on Pi Days',
    detail: `all time · ${worked.length} of ${days.length} March 14ths worked`,
    strength: 0.25
  }
}

/** Work on a leap day. */
export function leapDay(kit: Kit): Insight | null {
  const rows = kit.rows.filter((r) => r.date.endsWith('-02-29') && r.runningS > 0)
  if (rows.length === 0) return null
  return {
    id: 'leap-day',
    figure: formatHours(hoursOf(rows)),
    text: `on leap day${new Set(rows.map((r) => r.date)).size === 1 ? '' : 's'}, mostly ${mostly(rows)}`,
    detail: `all time · ${[...new Set(rows.map((r) => formatDate(r.date)))].join(', ')} · a day that comes every four years`,
    strength: 0.3
  }
}

/** The longest task name. */
export function longestTaskName(kit: Kit): Insight | null {
  const r = [...kit.rows].sort((a, b) => (b.task ?? '').length - (a.task ?? '').length)[0]
  if (r === undefined || (r.task ?? '').length < 40) return null
  return {
    id: 'longest-task-name',
    figure: `${(r.task as string).length} characters`,
    text: `in your longest task name: ${quoted(r.task)}`,
    detail: `all time · ${formatDate(r.date)}`,
    strength: 0.25
  }
}

/** Calendar dates worked in every year they came round. */
export function everyYearDates(kit: Kit): Insight | null {
  const years = [...new Set(kit.rows.map((r) => r.date.slice(0, 4)))]
  const seen = new Map<string, Set<string>>()
  for (const d of dayHours(kit.rows).keys()) {
    const md = d.slice(5)
    seen.set(md, (seen.get(md) ?? new Set<string>()).add(d.slice(0, 4)))
  }
  const covering = (md: string): string[] =>
    years.filter((y) => `${y}-${md}` >= kit.first && `${y}-${md}` <= kit.today)
  const all = [...seen.entries()]
    .filter(([md, ys]) => covering(md).length >= 3 && covering(md).every((y) => ys.has(y)))
    .map(([md]) => md)
    .sort()
  if (all.length === 0) return null
  return {
    id: 'every-year-dates',
    figure: formatCount(all.length),
    text: "dates you've worked on in every year they came round",
    detail: `all time · e.g. ${all
      .slice(0, 3)
      .map((md) => `${MONTHS[Number(md.slice(0, 2)) - 1]} ${Number(md.slice(3))}`)
      .join(', ')}`,
    strength: 0.3
  }
}

/** The shortest session. */
export function shortestSession(kit: Kit): Insight | null {
  const r = kit.rows.filter((x) => x.runningS > 0).sort((a, b) => a.runningS - b.runningS)[0]
  if (r === undefined || kit.rows.length < 10) return null
  return {
    id: 'shortest-session',
    figure: r.runningS < 60 ? `${r.runningS} s` : formatMinutes(r.runningS / 60),
    text: `on ${quoted(r.task)}, your shortest session`,
    detail: `all time · ${formatDate(r.date)}`,
    strength: 0.25
  }
}

/** How many different task names. */
export function taskNames(kit: Kit): Insight | null {
  const n = new Set(kit.rows.map((r) => r.task).filter((t) => t !== null)).size
  if (kit.rows.length < 10 || n === 0) return null
  return {
    id: 'task-names',
    figure: formatCount(n),
    text: `different task names across ${formatCount(kit.rows.length)} sessions`,
    detail: `all time · a new name every ${num1(kit.rows.length / n)} sessions`,
    strength: 0.3
  }
}

function hasHan(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0x4e00 && c <= 0x9fff) return true
  }
  return false
}

/** Sessions named in Chinese. */
export function chineseTasks(kit: Kit): Insight | null {
  const rows = kit.rows.filter((r) => r.task !== null && hasHan(r.task))
  if (rows.length < 3) return null
  return {
    id: 'chinese-tasks',
    figure: formatCount(rows.length),
    text: 'sessions named in Chinese',
    detail: `all time · ${formatHours(hoursOf(rows))} · e.g. ${quoted(rows[0].task)}`,
    strength: 0.3
  }
}

/** Time as seconds. */
export function seconds(kit: Kit): Insight | null {
  const s = kit.rows.reduce((a, r) => a + r.runningS, 0)
  if (s < 3600) return null
  return {
    id: 'seconds',
    figure: formatCount(s),
    text: 'seconds on the clock',
    detail: `all time · ${formatHours(s / 3600)}`,
    strength: 0.2
  }
}

/** The first month's project against this month's. */
export function firstMonthNow(kit: Kit): Insight | null {
  if (countDays(kit.first, kit.last) < 60) return null
  const then = mostly(kit.rows.filter((r) => r.date.slice(0, 7) === kit.first.slice(0, 7)))
  const now = mostly(within(kit.rows, lastDays(30, kit.last)))
  if (then === null || now === null) return null
  return {
    id: 'first-month-now',
    figure: now,
    text:
      then === now
        ? "is still what you're mostly doing, as it was in your first month"
        : `is what you're mostly doing now; in your first month it was ${then}`,
    detail: `${monthName(kit.first.slice(0, 7))} against the past 30 days`,
    strength: 0.3
  }
}

/** Sections D to G and I. */
export const WORK_PLAN: readonly KitStep[] = [
  { build: favouriteLength },
  { build: lengthThenNow },
  { build: handedBack },
  { build: runOutLength },
  { build: projectStops },
  { build: toZero },
  { build: shortSessions },
  { build: hourPlusShare },
  { build: longestSittingProject },
  { build: goToTimer },
  { build: closeStops },
  { build: overruns },
  { build: fastestSession },
  { build: mostWordsSession },
  { build: biggestWritingDay },
  { build: pagesWritten, weight: FAVOURITE },
  { build: draftingSession },
  { build: furthestDraft },
  { build: pageBooks },
  { build: unitsCounted },
  { build: unitThenNow },
  { build: unquantifiable },
  { build: longSessionPace },
  { build: weekdayPace },
  { build: recentPace },
  { build: courseQuestions },
  { build: writingWeek },
  { build: slideDecks, weight: FAVOURITE },
  { build: wordsStreak },
  { build: wordsProject },
  { build: measuredShare },
  { build: questionsDay },
  { build: paceTargets },
  { build: allTimeTopProject },
  { build: projectsOnTheGo },
  { build: newestProject },
  { build: longestActiveProject },
  { build: growingProject },
  { build: repeatedTask },
  { build: commonWord },
  { build: projectHundred, weight: FAVOURITE },
  { build: projectLifespan },
  { build: eightyPercent },
  { build: projectsPerYear },
  { build: firstWord },
  { build: newestCourse },
  { build: notes },
  { build: hourCrossings, weight: FAVOURITE },
  { build: nextHours, weight: FAVOURITE },
  { build: sessionNumbers, weight: FAVOURITE },
  { build: nextSessionMark, weight: FAVOURITE },
  { build: nonstop, weight: FAVOURITE },
  { build: daysWithWork, weight: FAVOURITE },
  { build: recentRecords, weight: FAVOURITE },
  { build: whereItStarted, weight: NOW_AND_THEN },
  { build: hundredSpeed, weight: FAVOURITE },
  { build: projectMark },
  { build: fridayThirteenth },
  { build: fullTimeMonths },
  { build: sessionEvery },
  { build: roundTimers },
  { build: luckyNumber },
  { build: piDay },
  { build: leapDay },
  { build: longestTaskName },
  { build: everyYearDates },
  { build: shortestSession },
  { build: taskNames },
  { build: chineseTasks },
  { build: seconds },
  { build: firstMonthNow }
]
