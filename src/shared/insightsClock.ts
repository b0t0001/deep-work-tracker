/**
 * Insights about the clock: when sessions start and end, pauses, stop
 * reasons, and the breaks between sessions.
 *
 * Round one, section H. **Every one of these reads app-recorded sessions
 * only** - an imported row has no clock time and a manual one has a
 * remembered one - and **flexible work only**, because when a scheduled
 * meeting starts is its timetable, not a habit. Each stays silent until
 * `TIMED.sessions` sessions over `TIMED.days` days exist; on the history as
 * of 11/06/2026 there are two, so all of them are built and quiet, and they
 * turn themselves on as the app is used.
 */
import type { SessionRow } from './analytics'
import { formatDate } from './dates'
import { formatCount, formatHours, pluralUnit } from './facts'
import {
  byDay,
  clamp01,
  clockTime,
  FLEXIBLE_ONLY,
  formatMinutes,
  formatRate,
  lastDays,
  medianOf,
  moved,
  pct,
  plural,
  pooledRate,
  quoted,
  rateGroups,
  rateWindow,
  signedPct,
  within,
  type Insight,
  type Kit,
  type KitStep
} from './insightKit'

/** The sample a clock insight needs before it says anything. */
export const TIMED = { sessions: 20, days: 5 } as const

type Timed = SessionRow & { startMin: number; endMin: number }

/** App-recorded flexible sessions with a clock, if there are enough of them. */
function timed(kit: Kit, days?: number): Timed[] | null {
  const rows = (
    days === undefined ? kit.flexible : within(kit.flexible, lastDays(days, kit.last))
  ).filter(
    (r): r is Timed =>
      r.source === 'app' &&
      typeof r.startMin === 'number' &&
      typeof r.endMin === 'number' &&
      r.runningS > 0
  )
  if (rows.length < TIMED.sessions || new Set(rows.map((r) => r.date)).size < TIMED.days)
    return null
  return rows
}

const scope = (days?: number): string =>
  `${days === undefined ? 'all time' : `past ${days} days`}, timed by the app, ${FLEXIBLE_ONLY}`

export function earliestStart(kit: Kit): Insight | null {
  const rows = timed(kit)
  if (rows === null) return null
  const r = [...rows].sort((a, b) => a.startMin - b.startMin)[0]
  return {
    id: 'earliest-start',
    figure: clockTime(r.startMin),
    text: `is the earliest you've ever started, on ${quoted(r.task)}`,
    detail: `${scope()} · ${formatDate(r.date)} · a typical start is ${clockTime(medianOf(rows.map((x) => x.startMin)))}`,
    strength: 0.4
  }
}

export function latestEnd(kit: Kit): Insight | null {
  const rows = timed(kit)
  if (rows === null) return null
  // Past midnight counts as late, not early: an end before 5 AM is the night before's.
  const late = (m: number): number => (m < 300 ? m + 1440 : m)
  const r = [...rows].sort((a, b) => late(b.endMin) - late(a.endMin))[0]
  return {
    id: 'latest-end',
    figure: clockTime(r.endMin),
    text: `is the latest you've ever stopped, on ${quoted(r.task)}`,
    detail: `${scope()} · ${formatDate(r.date)}`,
    strength: 0.4
  }
}

export function eveningShare(kit: Kit): Insight | null {
  const rows = timed(kit, 90)
  if (rows === null) return null
  const total = rows.reduce((s, r) => s + r.runningS, 0)
  const evening =
    rows.filter((r) => r.startMin >= 18 * 60).reduce((s, r) => s + r.runningS, 0) / total
  const morning =
    rows.filter((r) => r.startMin < 12 * 60).reduce((s, r) => s + r.runningS, 0) / total
  if (!moved(Math.max(evening, morning), Math.min(evening, morning) || 0.01)) return null
  const eveningLeads = evening >= morning
  return {
    id: 'evening-share',
    figure: pct(eveningLeads ? evening : morning),
    text: `of your timed hours start ${eveningLeads ? 'after 6 PM' : 'before noon'}`,
    detail: `${scope(90)} · ${pct(eveningLeads ? morning : evening)} ${eveningLeads ? 'before noon' : 'after 6 PM'}`,
    strength: clamp01(Math.abs(evening - morning) / 0.5)
  }
}

export function lateNight(kit: Kit): Insight | null {
  const rows = timed(kit, 90)
  if (rows === null) return null
  const late = rows.filter((r) => r.startMin >= 22 * 60 || r.startMin < 4 * 60)
  if (late.length < 3) return null
  const share = late.reduce((s, r) => s + r.runningS, 0) / rows.reduce((s, r) => s + r.runningS, 0)
  return {
    id: 'late-night',
    figure: formatCount(late.length),
    text: 'sessions started after 10 PM',
    detail: `${scope(90)} · ${pct(share)} of your timed hours`,
    strength: 0.35
  }
}

export function dayStart(kit: Kit): Insight | null {
  const rows = timed(kit, 90)
  if (rows === null) return null
  const starts = [...byDay(rows).values()].map((rs) =>
    Math.min(...rs.map((r) => (r as Timed).startMin))
  )
  if (starts.length < 10) return null
  return {
    id: 'day-start',
    figure: clockTime(medianOf(starts)),
    text: 'is when a typical day starts',
    detail: `${scope(90)} · median first start over ${plural(starts.length, 'day')}`,
    strength: 0.4
  }
}

export function clockPace(kit: Kit): Insight | null {
  const rows = timed(kit)
  if (rows === null) return null
  const ids = new Set(rows)
  for (const g of rateGroups(kit.flexible, kit.last)) {
    const t = g.rows.filter((r) => ids.has(r as Timed)) as Timed[]
    const day = t.filter((r) => r.startMin < 18 * 60)
    const night = t.filter((r) => r.startMin >= 18 * 60)
    if (day.length < 5 || night.length < 5) continue
    const a = pooledRate(day)
    const b = pooledRate(night)
    if (!moved(a, b)) continue
    const noun = pluralUnit(g.unit, 2)
    return {
      id: 'clock-pace',
      figure: signedPct(a / b - 1),
      text: `pace on ${g.course} ${noun} before 6 PM, against after`,
      detail: `${rateWindow(g.unit)}, timed by the app · ${formatRate(a, noun)} before, ${formatRate(b, noun)} after`,
      strength: clamp01(Math.abs(Math.log(a / b)) / Math.log(3))
    }
  }
  return null
}

export function projectClock(kit: Kit): Insight | null {
  const rows = timed(kit, 365)
  if (rows === null) return null
  const by = new Map<string, number[]>()
  for (const r of rows)
    if (r.project !== null) by.set(r.project, [...(by.get(r.project) ?? []), r.startMin])
  const typical = [...by.entries()]
    .filter(([, s]) => s.length >= 10)
    .map(([p, s]): [string, number] => [p, medianOf(s)])
  if (typical.length < 2) return null
  typical.sort((a, b) => a[1] - b[1])
  const [early, late] = [typical[0], typical[typical.length - 1]]
  if (late[1] - early[1] < 120) return null
  return {
    id: 'project-clock',
    figure: early[0],
    text: `is your earliest project in the day, ${late[0]} your latest`,
    detail: `${scope(365)} · typical starts ${clockTime(early[1])} and ${clockTime(late[1])}`,
    strength: 0.45
  }
}

export function clockLength(kit: Kit): Insight | null {
  const rows = timed(kit, 90)
  if (rows === null) return null
  const evening = rows.filter((r) => r.startMin >= 18 * 60).map((r) => r.runningS / 60)
  const daytime = rows.filter((r) => r.startMin < 18 * 60).map((r) => r.runningS / 60)
  if (evening.length < 10 || daytime.length < 10) return null
  const a = medianOf(evening)
  const b = medianOf(daytime)
  if (!moved(a, b)) return null
  return {
    id: 'clock-length',
    figure: formatMinutes(a),
    text: `is a typical evening session, against ${formatMinutes(b)} before 6 PM`,
    detail: `${scope(90)} · medians`,
    strength: clamp01(Math.abs(a / b - 1) / 0.8)
  }
}

/** Sessions with pauses recorded - app sessions, where pauses are kept. */
function paused(kit: Kit, days?: number): SessionRow[] | null {
  const rows = (days === undefined ? kit.rows : within(kit.rows, lastDays(days, kit.last))).filter(
    (r) => r.source === 'app'
  )
  const pauses = rows.reduce((s, r) => s + (r.pauses ?? 0), 0)
  return pauses >= 10 && rows.length >= TIMED.sessions ? rows : null
}

export function pauseHabit(kit: Kit): Insight | null {
  const rows = paused(kit, 90)
  if (rows === null) return null
  const n = rows.reduce((s, r) => s + (r.pauses ?? 0), 0)
  const each = rows.reduce((s, r) => s + (r.pausedS ?? 0), 0) / n / 60
  return {
    id: 'pause-habit',
    figure: `${(n / rows.length).toFixed(1)} pauses`,
    text: `in a typical session, about ${formatMinutes(each)} each`,
    detail: `past 90 days, timed by the app · ${plural(n, 'pause')} over ${plural(rows.length, 'session')}`,
    strength: 0.35
  }
}

export function longestPause(kit: Kit): Insight | null {
  const rows = paused(kit)
  if (rows === null) return null
  const r = [...rows].sort((a, b) => (b.longestPauseS ?? 0) - (a.longestPauseS ?? 0))[0]
  return {
    id: 'longest-pause',
    figure: formatMinutes((r.longestPauseS ?? 0) / 60),
    text: `paused on ${quoted(r.task)} before carrying on`,
    detail: `all time, timed by the app · ${formatDate(r.date)}`,
    strength: 0.3
  }
}

const REASONS: Record<string, string> = {
  finished_early: 'you finished',
  tired: 'you were tired',
  interrupted: 'you were interrupted',
  other: 'something else'
}

export function stopReasons(kit: Kit): Insight | null {
  const rows = within(kit.rows, lastDays(90, kit.last)).filter(
    (r) => r.stop != null && r.stop in REASONS
  )
  if (rows.length < 20) return null
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.stop as string, (counts.get(r.stop as string) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return {
    id: 'stop-reasons',
    figure: pct(top[0][1] / rows.length),
    text: `of your early stops were because ${REASONS[top[0][0]]}`,
    detail: `past 90 days · ${top
      .slice(1)
      .map(([k, n]) => `${k.replace('_', ' ')} ${pct(n / rows.length)}`)
      .join(', ')}`,
    strength: 0.4
  }
}

export function tiredClock(kit: Kit): Insight | null {
  const rows = timed(kit, 90)
  if (rows === null) return null
  const tired = rows.filter((r) => r.stop === 'tired')
  if (tired.length < 10) return null
  const late = tired.filter((r) => r.endMin >= 23 * 60 || r.endMin < 4 * 60).length / tired.length
  const others = rows.filter((r) => r.stop !== 'tired')
  const lateOthers =
    others.length > 0
      ? others.filter((r) => r.endMin >= 23 * 60 || r.endMin < 4 * 60).length / others.length
      : 0
  if (late < 0.4 || !moved(late, lateOthers || 0.01)) return null
  return {
    id: 'tired-clock',
    figure: 'After 11 PM',
    text: `is when "tired" stops cluster: ${pct(late)} of them`,
    detail: `${scope(90)} · ${pct(lateOthers)} of other stops end that late · ${plural(tired.length, 'tired stop')}`,
    strength: 0.45
  }
}

/** Sittings: sessions less than 15 minutes apart by the clock. */
function sittings(rows: Timed[]): Array<{ date: string; sessions: number; hours: number }> {
  const out: Array<{ date: string; sessions: number; hours: number }> = []
  for (const [date, list] of byDay(rows)) {
    const sorted = [...(list as Timed[])].sort((a, b) => a.startMin - b.startMin)
    let cur = { date, sessions: 1, hours: sorted[0].runningS / 3600 }
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].startMin - sorted[i - 1].endMin <= 15) {
        cur.sessions += 1
        cur.hours += sorted[i].runningS / 3600
      } else {
        out.push(cur)
        cur = { date, sessions: 1, hours: sorted[i].runningS / 3600 }
      }
    }
    out.push(cur)
  }
  return out
}

export function longestSitting(kit: Kit): Insight | null {
  const rows = timed(kit)
  if (rows === null) return null
  const all = sittings(rows)
  const best = [...all].sort((a, b) => b.hours - a.hours)[0]
  if (best.sessions < 2) return null
  return {
    id: 'longest-sitting-clock',
    figure: formatHours(best.hours),
    text: `in one sitting of ${best.sessions} sessions on ${formatDate(best.date)}`,
    detail: `${scope()} · sessions under 15 min apart · a typical sitting is ${formatHours(medianOf(all.map((s) => s.hours)))}`,
    strength: 0.45
  }
}

export function typicalGap(kit: Kit): Insight | null {
  const rows = timed(kit, 90)
  if (rows === null) return null
  const gaps: number[] = []
  for (const list of byDay(rows).values()) {
    const sorted = [...(list as Timed[])].sort((a, b) => a.startMin - b.startMin)
    for (let i = 1; i < sorted.length; i += 1) {
      const g = sorted[i].startMin - sorted[i - 1].endMin
      if (g >= 0) gaps.push(g)
    }
  }
  if (gaps.length < 20) return null
  return {
    id: 'typical-gap',
    figure: formatMinutes(medianOf(gaps)),
    text: 'is your typical break between sessions',
    detail: `${scope(90)} · median over ${plural(gaps.length, 'gap')}`,
    strength: 0.35
  }
}

export const CLOCK_PLAN: readonly KitStep[] = [
  { build: earliestStart },
  { build: latestEnd },
  { build: eveningShare },
  { build: lateNight },
  { build: dayStart },
  { build: clockPace },
  { build: projectClock },
  { build: clockLength },
  { build: pauseHabit },
  { build: longestPause },
  { build: stopReasons },
  { build: tiredClock },
  { build: longestSitting },
  { build: typicalGap }
]
