/**
 * Insights about the calendar, streaks and the shape of a day.
 *
 * Round one of the candidate list, sections A to C, as the user kept them.
 * Every one takes its own windows and names them at the start of its detail
 * line. Patterns of *when* - month of the year, weekday, the end of a month -
 * read flexible work only (see `flexibleRows`); records and streaks read
 * everything, because a record set at a competition is still a record.
 */
import type { SessionRow } from './analytics'
import { formatDate } from './dates'
import { formatCount, formatHours } from './facts'
import {
  byDay,
  clamp01,
  countDays,
  dateOf,
  dayHours,
  dayNumber,
  FAVOURITE,
  FLEXIBLE_ONLY,
  formatMinutes,
  formatRate,
  hoursOf,
  lastDays,
  longestRun,
  medianOf,
  monthName,
  MONTHS,
  mostly,
  moved,
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
import { pluralUnit } from './facts'

const YEAR = 365

function span(kit: Kit): number {
  return dayNumber(kit.last) - dayNumber(kit.first) + 1
}

/** Hours per calendar day over the days for which `keep` holds, all time. */
function perCalendarDay(
  kit: Kit,
  rows: readonly SessionRow[],
  keep: (d: string) => boolean
): { hours: number; days: number; per: number } {
  const days = countDays(kit.first, kit.last, keep)
  const hours = hoursOf(rows.filter((r) => r.date <= kit.last && keep(r.date)))
  return { hours, days, per: days > 0 ? hours / days : 0 }
}

const month = (d: string): number => Number(d.slice(5, 7))

/* ---------------------------------------------------------------- A ---- */

/** The month of the year with the most hours a day, flexible work only. */
export function monthOfYear(kit: Kit): Insight | null {
  if (span(kit) < YEAR) return null
  const per = MONTHS.map((_, i) => perCalendarDay(kit, kit.flexible, (d) => month(d) === i + 1).per)
  const avg = perCalendarDay(kit, kit.flexible, () => true).per
  const order = [...per.keys()].sort((a, b) => per[b] - per[a])
  const [top, low] = [order[0], order[11]]
  if (!moved(per[top], avg)) return null
  return {
    id: 'month-of-year',
    figure: MONTHS[top],
    text: `is your busiest month of the year, ${pct(per[top] / avg - 1)} above your average day`,
    detail: `all time, ${FLEXIBLE_ONLY} · ${perDay(per[top])} a day in ${MONTHS[top]}, ${perDay(avg)} overall · ${MONTHS[low]} is quietest at ${perDay(per[low])}`,
    strength: clamp01((per[top] / avg - 1) / 0.8)
  }
}

/** Summer against the school year, flexible work only. */
export function summer(kit: Kit): Insight | null {
  if (span(kit) < YEAR) return null
  const isSummer = (d: string): boolean => [6, 7, 8].includes(month(d))
  const a = perCalendarDay(kit, kit.flexible, isSummer).per
  const b = perCalendarDay(kit, kit.flexible, (d) => !isSummer(d)).per
  if (!moved(a, b)) return null
  return {
    id: 'summer',
    figure: signedPct(a / b - 1),
    text: 'a day in summer (June–August) against the school year',
    detail: `all time, ${FLEXIBLE_ONLY} · ${perDay(a)} a summer day, ${perDay(b)} a school-year day · days off counted`,
    strength: clamp01(Math.abs(a / b - 1) / 0.6)
  }
}

/** The biggest Monday-to-Sunday week. */
export function biggestWeek(kit: Kit): Insight | null {
  const weeks = new Map<string, number>()
  for (let n = dayNumber(weekOf(kit.first)); n <= dayNumber(kit.today); n += 7)
    weeks.set(dateOf(n), 0)
  for (const r of kit.rows)
    weeks.set(weekOf(r.date), (weeks.get(weekOf(r.date)) ?? 0) + r.runningS / 3600)
  if (weeks.size < 8) return null
  const [week, hours] = ranked(weeks)[0]
  const rows = within(kit.rows, { from: week, to: dateOf(dayNumber(week) + 6), days: 7 })
  return {
    id: 'biggest-week',
    figure: formatHours(hours),
    text: `in the week of ${formatDate(week)}, your biggest week`,
    detail: `all time · ${plural(rows.length, 'session')}, mostly ${mostly(rows)} · a typical week is ${formatHours(medianOf([...weeks.values()]))}`,
    strength: 0.45
  }
}

/** The biggest whole calendar month. */
export function biggestMonth(kit: Kit): Insight | null {
  const firstMonth = kit.first.slice(0, 7)
  const thisMonth = kit.today.slice(0, 7)
  const months = sumBy(
    kit.rows.filter((r) => r.date.slice(0, 7) > firstMonth && r.date.slice(0, 7) < thisMonth),
    (r) => r.date.slice(0, 7)
  )
  if (months.size < 6) return null
  const [key, hours] = ranked(months)[0]
  return {
    id: 'biggest-month',
    figure: monthName(key),
    text: `was your biggest month: ${formatHours(hours)}`,
    detail: `all time · mostly ${mostly(kit.rows.filter((r) => r.date.startsWith(key)))} · a typical month is ${formatHours(medianOf([...months.values()]))}`,
    strength: 0.45
  }
}

/** Hours a day in each calendar year; the biggest. */
export function biggestYear(kit: Kit): Insight | null {
  const years = [...new Set(kit.rows.map((r) => r.date.slice(0, 4)))].sort()
  if (years.length < 2) return null
  const per = years.map((y): [string, number] => {
    const from = `${y}-01-01` < kit.first ? kit.first : `${y}-01-01`
    const to = `${y}-12-31` > kit.last ? kit.last : `${y}-12-31`
    const days = dayNumber(to) - dayNumber(from) + 1
    return [y, days > 0 ? hoursOf(within(kit.rows, { from, to, days })) / days : 0]
  })
  const best = [...per].sort((a, b) => b[1] - a[1])[0]
  return {
    id: 'biggest-year',
    figure: best[0],
    text: `was your biggest year, at ${perDay(best[1])} a day`,
    detail: `all time · ${per.map(([y, p]) => `${y}: ${p.toFixed(2)} h`).join(' · ')} a day`,
    strength: 0.4
  }
}

/** The past 30 days against the same 30 days a year earlier. */
export function monthAgainstYearAgo(kit: Kit): Insight | null {
  if (span(kit) < YEAR + 30) return null
  const now = lastDays(30, kit.last)
  const then = lastDays(30, dateOf(dayNumber(kit.last) - YEAR))
  const a = hoursOf(within(kit.rows, now))
  const b = hoursOf(within(kit.rows, then))
  if (a < 10 || b < 10 || !moved(a, b)) return null
  return {
    id: 'month-vs-year-ago',
    figure: signedPct(a / b - 1),
    text: 'hours over the past month, against the same month a year ago',
    detail: `past 30 days against ${formatDate(then.from)}–${formatDate(then.to)} · ${formatHours(a)} now, ${formatHours(b)} then`,
    strength: clamp01(Math.abs(a / b - 1) / 0.8)
  }
}

/** Hours per calendar day on each weekday, over `days` ending on `end`. */
function weekdayRates(rows: readonly SessionRow[], end: string, days: number): number[] {
  const hours = new Array<number>(7).fill(0)
  const count = new Array<number>(7).fill(0)
  for (let n = dayNumber(end) - days + 1; n <= dayNumber(end); n += 1)
    count[weekdayOf(dateOf(n))] += 1
  for (const r of within(rows, lastDays(days, end))) hours[weekdayOf(r.date)] += r.runningS / 3600
  return hours.map((h, i) => (count[i] > 0 ? h / count[i] : 0))
}

/** The weekday that changed most, year on year, flexible work only. */
export function weekdayShift(kit: Kit): Insight | null {
  if (span(kit) < 2 * YEAR) return null
  const now = weekdayRates(kit.flexible, kit.last, YEAR)
  const then = weekdayRates(kit.flexible, dateOf(dayNumber(kit.last) - YEAR), YEAR)
  let k = 0
  for (let i = 1; i < 7; i += 1) if (Math.abs(now[i] - then[i]) > Math.abs(now[k] - then[k])) k = i
  if (Math.abs(now[k] - then[k]) < 0.5 || !moved(now[k], then[k])) return null
  return {
    id: 'weekday-shift',
    figure: `${WEEKDAYS[k]}s`,
    text: `changed most: ${now[k] > then[k] ? 'up' : 'down'} from ${perDay(then[k])} to ${perDay(now[k])} a day`,
    detail: `the past 12 months against the 12 before, ${FLEXIBLE_ONLY} · days off counted`,
    strength: clamp01(Math.abs(now[k] / then[k] - 1) / 0.8)
  }
}

/** The weekday the top flexible project of the year leans on. */
export function projectWeekday(kit: Kit): Insight | null {
  const year = within(kit.flexible, lastDays(YEAR, kit.last))
  const project = mostly(year)
  if (project === null) return null
  const rows = year.filter((r) => r.project === project)
  const total = hoursOf(rows)
  if (total < 20) return null
  const hours = new Array<number>(7).fill(0)
  for (const r of rows) hours[weekdayOf(r.date)] += r.runningS / 3600
  const avg = total / 7
  let k = 0
  for (let i = 1; i < 7; i += 1) if (hours[i] > hours[k]) k = i
  if (!moved(hours[k], avg, 0.25)) return null
  return {
    id: 'project-weekday',
    figure: `${WEEKDAYS[k]}s`,
    text: `are ${project}'s day: ${pct(hours[k] / avg - 1)} above its average`,
    detail: `past 12 months · ${formatHours(hours[k])} of ${project} on ${WEEKDAYS[k]}s, ${formatHours(avg)} on an average day of the week`,
    strength: clamp01((hours[k] / avg - 1) / 0.8)
  }
}

/** The US holidays in a year, as dates. */
function holidaysOf(year: number): Array<[string, string]> {
  const nov1 = weekdayOf(`${year}-11-01`)
  const thanksgiving = 1 + ((4 - nov1 + 7) % 7) + 21
  return [
    [`${year}-01-01`, `New Year's Day ${year}`],
    [`${year}-07-04`, `July 4, ${year}`],
    [`${year}-11-${String(thanksgiving).padStart(2, '0')}`, `Thanksgiving ${year}`],
    [`${year}-12-25`, `Christmas ${year}`]
  ]
}

/** Holidays that had work in them. A user favourite. */
export function holidays(kit: Kit): Insight | null {
  const list: Array<[string, string]> = []
  for (let y = Number(kit.first.slice(0, 4)); y <= Number(kit.today.slice(0, 4)); y += 1)
    for (const h of holidaysOf(y)) if (h[0] >= kit.first && h[0] <= kit.today) list.push(h)
  if (list.length < 4) return null
  const hours = dayHours(kit.rows)
  const worked = list.filter(([d]) => hours.has(d))
  if (worked.length === 0) return null
  const best = [...worked].sort((a, b) => (hours.get(b[0]) ?? 0) - (hours.get(a[0]) ?? 0))[0]
  return {
    id: 'holidays',
    figure: `${worked.length} of ${list.length}`,
    text: 'holidays had some work in them',
    detail: `all time · New Year's, July 4, Thanksgiving, Christmas · most: ${best[1]} at ${formatHours(hours.get(best[0]) ?? 0)}`,
    strength: 0.6
  }
}

/** What was worked on a year ago today. A user favourite. */
export function onThisDay(kit: Kit): Insight | null {
  const date = dateOf(dayNumber(kit.today) - YEAR)
  if (date < kit.first) return null
  const rows = kit.rows.filter((r) => r.date === date && r.runningS > 0)
  if (rows.length === 0) return null
  const main = [...rows].sort((a, b) => b.runningS - a.runningS)[0]
  return {
    id: 'on-this-day',
    figure: formatHours(hoursOf(rows)),
    text: `a year ago today, mostly ${mostly(rows)}: ${quoted(main.task)}`,
    detail: `${formatDate(date)} · ${plural(rows.length, 'session')}`,
    strength: 0.6
  }
}

/** The weekday most and least often worked, flexible work only. */
export function reliableWeekday(kit: Kit): Insight | null {
  const range = lastDays(YEAR, kit.last)
  if (span(kit) < 56) return null
  const hours = dayHours(within(kit.flexible, range))
  const total = new Array<number>(7).fill(0)
  const worked = new Array<number>(7).fill(0)
  for (let n = dayNumber(range.from); n <= dayNumber(range.to); n += 1) {
    const d = dateOf(n)
    if (d < kit.first) continue
    total[weekdayOf(d)] += 1
    if (hours.has(d)) worked[weekdayOf(d)] += 1
  }
  const share = worked.map((w, i) => (total[i] > 0 ? w / total[i] : 0))
  const order = [...share.keys()].sort((a, b) => share[b] - share[a])
  const [top, low] = [order[0], order[6]]
  if (!moved(share[top], share[low])) return null
  return {
    id: 'reliable-weekday',
    figure: `${WEEKDAYS[top]}s`,
    text: `are your most reliable day: worked on ${worked[top]} of ${total[top]}`,
    detail: `past 12 months, ${FLEXIBLE_ONLY} · least reliable: ${WEEKDAYS[low]}s, ${worked[low]} of ${total[low]}`,
    strength: clamp01((share[top] / share[low] - 1) / 0.8)
  }
}

/** The last ten days of a month against the first ten, flexible work only. */
export function monthEnds(kit: Kit): Insight | null {
  if (span(kit) < 180) return null
  const a = perCalendarDay(kit, kit.flexible, (d) => Number(d.slice(8)) >= 22).per
  const b = perCalendarDay(kit, kit.flexible, (d) => Number(d.slice(8)) <= 10).per
  if (!moved(a, b)) return null
  return {
    id: 'month-ends',
    figure: signedPct(a / b - 1),
    text: 'a day in the last ten days of a month, against the first ten',
    detail: `all time, ${FLEXIBLE_ONLY} · ${perDay(a)} against ${perDay(b)} · days off counted`,
    strength: clamp01(Math.abs(a / b - 1) / 0.6)
  }
}

/* ---------------------------------------------------------------- B ---- */

/** The longest break, and what came after it. */
export function longestBreak(kit: Kit): Insight | null {
  const days = [...dayHours(kit.rows).keys()].sort()
  let best: { gap: number; back: string } | null = null
  let weekPlus = 0
  for (let i = 1; i < days.length; i += 1) {
    const gap = dayNumber(days[i]) - dayNumber(days[i - 1]) - 1
    if (gap >= 7) weekPlus += 1
    if (best === null || gap > best.gap) best = { gap, back: days[i] }
  }
  if (best === null || best.gap < 3) return null
  const back = kit.rows.find((r) => r.date === best.back) as SessionRow
  return {
    id: 'longest-break',
    figure: `${best.gap} days`,
    text: `off, your longest break, ending ${formatDate(best.back)}`,
    detail: `all time · you came back to ${back.project ?? 'unlabelled work'}: ${quoted(back.task)} · ${plural(weekPlus, 'break')} of a week or more`,
    strength: 0.4
  }
}

/** The calendar year with the largest share of days worked. */
export function consistentYear(kit: Kit): Insight | null {
  const hours = dayHours(kit.rows)
  const years = [...new Set(kit.rows.map((r) => r.date.slice(0, 4)))].sort()
  const shares = years
    .map((y): [string, number, number] => {
      const from = `${y}-01-01` < kit.first ? kit.first : `${y}-01-01`
      const to = `${y}-12-31` > kit.last ? kit.last : `${y}-12-31`
      const days = countDays(from, to)
      return [y, days > 0 ? countDays(from, to, (d) => hours.has(d)) / days : 0, days]
    })
    .filter(([, , days]) => days >= 60)
  if (shares.length < 2) return null
  const best = [...shares].sort((a, b) => b[1] - a[1])[0]
  return {
    id: 'consistent-year',
    figure: best[0],
    text: `was your most consistent year: work on ${pct(best[1])} of days`,
    detail: `all time · ${shares.map(([y, s]) => `${y}: ${pct(s)}`).join(' · ')}`,
    strength: 0.4
  }
}

/** The longest run of consecutive days on one project. */
export function projectStreak(kit: Kit): Insight | null {
  const projects = [
    ...new Set(kit.rows.map((r) => r.project).filter((p): p is string => p !== null))
  ]
  const best = projects
    .map((p) => ({
      p,
      run: longestRun(runsOf(kit.rows.filter((r) => r.project === p).map((r) => r.date)))
    }))
    .filter((x): x is { p: string; run: NonNullable<typeof x.run> } => x.run !== null)
    .sort((a, b) => b.run.length - a.run.length)
  if (best.length < 2 || best[0].run.length < 5) return null
  return {
    id: 'project-streak',
    figure: `${best[0].run.length} days`,
    text: `in a row on ${best[0].p}, your longest run on one project`,
    detail: `all time · ${formatDate(best[0].run.from)} to ${formatDate(best[0].run.to)} · next: ${best[1].p} at ${best[1].run.length} days`,
    strength: clamp01(best[0].run.length / 30)
  }
}

/** The longest run of weeks with any work, and the current one. */
export function weekStreak(kit: Kit): Insight | null {
  const weeks = [...new Set(kit.rows.map((r) => weekOf(r.date)))].sort().map(dayNumber)
  if (weeks.length === 0) return null
  let best = 1
  let current = 1
  let bestEnd = weeks[0]
  for (let i = 1; i < weeks.length; i += 1) {
    current = weeks[i] - weeks[i - 1] === 7 ? current + 1 : 1
    if (current > best) {
      best = current
      bestEnd = weeks[i]
    }
  }
  if (best < 4) return null
  return {
    id: 'week-streak',
    figure: `${best} weeks`,
    text: 'in a row with some work, your longest run of weeks',
    detail: `all time · ending the week of ${formatDate(dateOf(bestEnd))} · ${current === best ? 'still going' : `current run: ${current} weeks`}`,
    strength: clamp01(best / 100)
  }
}

/** Days of four hours or more, year on year. */
export function bigDays(kit: Kit): Insight | null {
  if (span(kit) < 2 * YEAR) return null
  const count = (end: string): number =>
    [...dayHours(within(kit.rows, lastDays(YEAR, end))).values()].filter((h) => h >= 4).length
  const a = count(kit.last)
  const b = count(dateOf(dayNumber(kit.last) - YEAR))
  if (Math.max(a, b) < 10 || !moved(a, b)) return null
  return {
    id: 'big-days',
    figure: formatCount(a),
    text: `days of 4 hours or more, ${a > b ? 'up' : 'down'} from ${formatCount(b)}`,
    detail: 'the past 12 months against the 12 before',
    strength: clamp01(Math.abs(a / b - 1) / 0.8)
  }
}

/** The longest run of days with three hours or more. */
export function threeHourStreak(kit: Kit): Insight | null {
  const run = longestRun(
    runsOf([...dayHours(kit.rows).entries()].filter(([, h]) => h >= 3).map(([d]) => d))
  )
  if (run === null || run.length < 3) return null
  return {
    id: 'three-hour-streak',
    figure: `${run.length} days`,
    text: `in a row of 3 hours or more, ending ${formatDate(run.to)}`,
    detail: `all time · ${formatHours(hoursOf(within(kit.rows, { from: run.from, to: run.to, days: run.length })))} across them`,
    strength: clamp01(run.length / 20)
  }
}

/** Days off, year on year. */
export function daysOff(kit: Kit): Insight | null {
  if (span(kit) < 2 * YEAR) return null
  const off = (end: string): number => YEAR - dayHours(within(kit.rows, lastDays(YEAR, end))).size
  const a = off(kit.last)
  const b = off(dateOf(dayNumber(kit.last) - YEAR))
  if (!moved(a, b)) return null
  return {
    id: 'days-off',
    figure: formatCount(a),
    text: `days off, against ${formatCount(b)} the year before`,
    detail: 'the past 12 months against the 12 before',
    strength: clamp01(Math.abs(a / b - 1) / 0.8)
  }
}

/** A first day back after three or more days off, against a typical day. */
export function comeback(kit: Kit): Insight | null {
  const hours = dayHours(kit.rows)
  const days = [...hours.keys()].sort()
  const back = days.filter((d, i) => i > 0 && dayNumber(d) - dayNumber(days[i - 1]) - 1 >= 3)
  if (back.length < 5) return null
  const a = medianOf(back.map((d) => hours.get(d) ?? 0))
  const b = medianOf([...hours.values()])
  if (!moved(a, b)) return null
  return {
    id: 'comeback',
    figure: formatHours(a),
    text: `is a typical first day back after 3+ days off, against ${formatHours(b)} on a typical day`,
    detail: `all time · medians over ${plural(back.length, 'return')}`,
    strength: clamp01(Math.abs(a / b - 1) / 0.8)
  }
}

/** The longest run of consecutive days with the same task text. */
export function taskStreak(kit: Kit): Insight | null {
  const tasks = [...new Set(kit.rows.map((r) => r.task).filter((t): t is string => t !== null))]
  let best: { task: string; from: string; to: string; length: number } | null = null
  for (const task of tasks) {
    const run = longestRun(runsOf(kit.rows.filter((r) => r.task === task).map((r) => r.date)))
    if (run !== null && (best === null || run.length > best.length)) best = { task, ...run }
  }
  if (best === null || best.length < 3) return null
  return {
    id: 'task-streak',
    figure: `${best.length} days`,
    text: `in a row on ${quoted(best.task)}`,
    detail: `all time · ${formatDate(best.from)} to ${formatDate(best.to)}`,
    strength: clamp01(best.length / 14)
  }
}

/** How many streaks of a week or longer. */
export function weekLongStreaks(kit: Kit): Insight | null {
  const runs = runsOf(dayHours(kit.rows).keys()).filter((r) => r.length >= 7)
  if (runs.length === 0) return null
  const since = lastDays(YEAR, kit.last).from
  return {
    id: 'week-long-streaks',
    figure: formatCount(runs.length),
    text: 'streaks of a week or longer',
    detail: `all time · ${runs.filter((r) => r.to >= since).length} of them in the past 12 months`,
    strength: 0.35
  }
}

/** How long a run of working days usually lasts. */
export function typicalRun(kit: Kit): Insight | null {
  const runs = runsOf(dayHours(kit.rows).keys())
  if (runs.length < 10) return null
  return {
    id: 'typical-run',
    figure: `${num1(medianOf(runs.map((r) => r.length)))} days`,
    text: 'is a typical run of working days before a day off',
    detail: `all time · median over ${plural(runs.length, 'run')} · longest ${Math.max(...runs.map((r) => r.length))}`,
    strength: 0.3
  }
}

/* ---------------------------------------------------------------- C ---- */

/** The day with the most sessions. */
export function busiestDayByCount(kit: Kit): Insight | null {
  const days = [...byDay(kit.rows).entries()]
  if (days.length < 5) return null
  const [date, rows] = [...days].sort((a, b) => b[1].length - a[1].length)[0]
  return {
    id: 'busiest-count',
    figure: plural(rows.length, 'session'),
    text: `on ${formatDate(date)}, your busiest day by count`,
    detail: `all time · ${formatHours(hoursOf(rows))} across ${plural(new Set(rows.map((r) => r.project)).size, 'project')} · a typical day has ${num1(medianOf(days.map(([, r]) => r.length)))}`,
    strength: 0.35
  }
}

/** The day with the most different projects. */
export function variedDay(kit: Kit): Insight | null {
  const days = [...byDay(kit.rows).entries()]
  if (days.length < 5) return null
  const count = (rows: SessionRow[]): number => new Set(rows.map((r) => r.project)).size
  const [date, rows] = [...days].sort((a, b) => count(b[1]) - count(a[1]))[0]
  if (count(rows) < 3) return null
  return {
    id: 'varied-day',
    figure: plural(count(rows), 'project'),
    text: `on ${formatDate(date)}, your most varied day`,
    detail: `all time · ${[...new Set(rows.map((r) => r.project ?? 'unlabelled'))].join(', ')}`,
    strength: 0.35
  }
}

/** The day with the most switches between projects, in the order logged. */
export function scatteredDay(kit: Kit): Insight | null {
  const switches = [...byDay(kit.rows).entries()].map(([d, rows]): [string, number] => [
    d,
    rows.filter((r, i) => i > 0 && r.project !== rows[i - 1].project).length
  ])
  if (switches.length < 5) return null
  const [date, n] = [...switches].sort((a, b) => b[1] - a[1])[0]
  if (n < 3) return null
  return {
    id: 'scattered-day',
    figure: `${n} switches`,
    text: `between projects on ${formatDate(date)}, your most scattered day`,
    detail: `all time · in the order sessions were logged · a typical day has ${num1(medianOf(switches.map(([, s]) => s)))}`,
    strength: 0.35
  }
}

/** What opens or closes the day most often. A user favourite. */
function dayEnd(kit: Kit, opening: boolean): Insight | null {
  const days = [...byDay(within(kit.rows, lastDays(YEAR, kit.last))).values()]
  if (days.length < 20) return null
  const counts = new Map<string, number>()
  for (const rows of days) {
    const p = (opening ? rows[0] : rows[rows.length - 1]).project ?? 'Unlabelled'
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  const top = ranked(counts)
  if (top.length < 2 || top[0][1] / days.length < 0.25) return null
  return {
    id: opening ? 'day-opener' : 'day-closer',
    figure: top[0][0],
    text: `${opening ? 'opens' : 'closes'} your day most often: ${pct(top[0][1] / days.length)} of working days`,
    detail: `past 12 months · by the order sessions were logged · next: ${top[1][0]} at ${pct(top[1][1] / days.length)}`,
    strength: 0.5
  }
}

export const dayOpener = (kit: Kit): Insight | null => dayEnd(kit, true)
export const dayCloser = (kit: Kit): Insight | null => dayEnd(kit, false)

/** The first session of the day against the ones after it. */
export function firstSessionLength(kit: Kit): Insight | null {
  const first: number[] = []
  const later: number[] = []
  for (const rows of byDay(within(kit.rows, lastDays(YEAR, kit.last))).values())
    rows.forEach((r, i) => (i === 0 ? first : later).push(r.runningS / 60))
  if (first.length < 20 || later.length < 20) return null
  const a = medianOf(first)
  const b = medianOf(later)
  if (!moved(a, b)) return null
  return {
    id: 'first-session',
    figure: formatMinutes(a),
    text: `is your typical first session of the day, against ${formatMinutes(b)} for the ones after it`,
    detail: `past 12 months · medians over ${formatCount(first.length)} first and ${formatCount(later.length)} later sessions`,
    strength: clamp01(Math.abs(a / b - 1) / 0.8)
  }
}

/** Pace first thing in the day against later, within one unit and course. */
export function firstOfDayPace(kit: Kit): Insight | null {
  const firsts = new Set<SessionRow>()
  for (const rows of byDay(kit.rows).values()) firsts.add(rows[0])
  for (const g of rateGroups(kit.rows, kit.last)) {
    const a = g.rows.filter((r) => firsts.has(r))
    const b = g.rows.filter((r) => !firsts.has(r))
    if (a.length < 5 || b.length < 5) continue
    const ra = pooledRate(a)
    const rb = pooledRate(b)
    if (!moved(ra, rb)) continue
    const noun = pluralUnit(g.unit, 2)
    return {
      id: 'first-of-day-pace',
      figure: signedPct(ra / rb - 1),
      text: `pace on ${g.course} ${noun} when it's the first thing you do that day`,
      detail: `${rateWindow(g.unit)} · ${formatRate(ra, noun)} first thing, ${formatRate(rb, noun)} later · ${a.length} and ${b.length} sessions`,
      strength: clamp01(Math.abs(Math.log(ra / rb)) / Math.log(3))
    }
  }
  return null
}

/** Share of working days spent on one project. */
export function singleProjectDays(kit: Kit): Insight | null {
  const days = [...byDay(within(kit.rows, lastDays(YEAR, kit.last))).values()]
  if (days.length < 20) return null
  const one = days.filter((rows) => new Set(rows.map((r) => r.project)).size === 1).length
  return {
    id: 'single-project-days',
    figure: pct(one / days.length),
    text: 'of your working days were spent on one project',
    detail: `past 12 months · ${one} of ${days.length} days`,
    strength: 0.3
  }
}

/** The longest run of back-to-back sessions on one task within a day. */
export function sameTaskRun(kit: Kit): Insight | null {
  let best: { n: number; date: string; task: string | null; hours: number } | null = null
  for (const [date, rows] of byDay(kit.rows)) {
    let run = 1
    for (let i = 1; i <= rows.length; i += 1) {
      if (i < rows.length && rows[i].task !== null && rows[i].task === rows[i - 1].task) {
        run += 1
        continue
      }
      if (best === null || run > best.n)
        best = { n: run, date, task: rows[i - 1].task, hours: hoursOf(rows.slice(i - run, i)) }
      run = 1
    }
  }
  if (best === null || best.n < 3) return null
  return {
    id: 'same-task-run',
    figure: `${best.n} sessions`,
    text: `in a row on ${quoted(best.task)}, on ${formatDate(best.date)}`,
    detail: `all time · ${formatHours(best.hours)} in all`,
    strength: 0.35
  }
}

/** Share of working days that were one session. */
export function oneSessionDays(kit: Kit): Insight | null {
  const days = [...byDay(within(kit.rows, lastDays(YEAR, kit.last))).values()]
  if (days.length < 20) return null
  const one = days.filter((rows) => rows.length === 1).length
  return {
    id: 'one-session-days',
    figure: pct(one / days.length),
    text: 'of your working days were one session and done',
    detail: `past 12 months · ${one} of ${days.length} days`,
    strength: 0.3
  }
}

/** The project that takes a bigger share of the biggest days. */
export function bigDayProject(kit: Kit): Insight | null {
  const hours = dayHours(kit.rows)
  const big = kit.rows.filter((r) => (hours.get(r.date) ?? 0) >= 5)
  const rest = kit.rows.filter((r) => (hours.get(r.date) ?? 0) < 5)
  const bigDayCount = [...hours.values()].filter((h) => h >= 5).length
  if (bigDayCount < 10) return null
  const a = sumBy(big, (r) => r.project)
  const b = sumBy(rest, (r) => r.project)
  const ta = hoursOf(big)
  const tb = hoursOf(rest)
  const best = [...a.keys()]
    .map((p): [string, number, number] => [p, (a.get(p) ?? 0) / ta, (b.get(p) ?? 0) / tb])
    .sort((x, y) => y[1] - y[2] - (x[1] - x[2]))[0]
  if (best === undefined || best[1] - best[2] < 0.1) return null
  return {
    id: 'big-day-project',
    figure: best[0],
    text: `takes ${pct(best[1])} of your biggest days, against ${pct(best[2])} of the rest`,
    detail: `all time · ${bigDayCount} days of 5 h or more`,
    strength: clamp01((best[1] - best[2]) / 0.3)
  }
}

/** Days of ten hours or more. */
export function tenHourDays(kit: Kit): Insight | null {
  const days = [...dayHours(kit.rows).entries()]
    .filter(([, h]) => h >= 10)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
  if (days.length === 0) return null
  const [date, h] = days[0]
  return {
    id: 'ten-hour-days',
    figure: formatCount(days.length),
    text: `day${days.length === 1 ? '' : 's'} of 10 hours or more`,
    detail: `all time · latest: ${formatDate(date)}, ${formatHours(h)} of ${mostly(kit.rows.filter((r) => r.date === date))}`,
    strength: 0.4
  }
}

/** A typical working day now against in the first year. */
export function dayLengthThenNow(kit: Kit): Insight | null {
  if (span(kit) < 2 * YEAR) return null
  const firstYear = { from: kit.first, to: dateOf(dayNumber(kit.first) + YEAR - 1), days: YEAR }
  const a = medianOf([...dayHours(within(kit.rows, lastDays(YEAR, kit.last))).values()])
  const b = medianOf([...dayHours(within(kit.rows, firstYear)).values()])
  if (!moved(a, b)) return null
  return {
    id: 'day-length-then-now',
    figure: formatHours(a),
    text: `is a typical working day now, against ${formatHours(b)} in your first year`,
    detail: `the past 12 months against ${formatDate(firstYear.from)}–${formatDate(firstYear.to)} · medians over worked days`,
    strength: clamp01(Math.abs(a / b - 1) / 1.5)
  }
}

/** Sections A to C, in the order they were listed to the user. */
export const DAYS_PLAN: readonly KitStep[] = [
  { build: monthOfYear },
  { build: summer },
  { build: biggestWeek },
  { build: biggestMonth },
  { build: biggestYear },
  { build: monthAgainstYearAgo },
  { build: weekdayShift },
  { build: projectWeekday },
  { build: holidays, weight: FAVOURITE },
  { build: onThisDay, weight: FAVOURITE },
  { build: reliableWeekday },
  { build: monthEnds },
  { build: longestBreak },
  { build: consistentYear },
  { build: projectStreak },
  { build: weekStreak },
  { build: bigDays },
  { build: threeHourStreak },
  { build: daysOff },
  { build: comeback },
  { build: taskStreak },
  { build: weekLongStreaks },
  { build: typicalRun },
  { build: busiestDayByCount },
  { build: variedDay },
  { build: scatteredDay },
  { build: dayOpener, weight: FAVOURITE },
  { build: dayCloser, weight: FAVOURITE },
  { build: firstSessionLength },
  { build: firstOfDayPace },
  { build: singleProjectDays },
  { build: sameTaskRun },
  { build: oneSessionDays },
  { build: bigDayProject },
  { build: tenHourDays },
  { build: dayLengthThenNow }
]
