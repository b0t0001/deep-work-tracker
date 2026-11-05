import { openDatabase } from './index'
import {
  fillDays,
  type Analytics,
  type DayTotal,
  type HourTotal,
  type PacePoint,
  type PlannedVsActual,
  type RatePoint
} from '../../shared/analytics'
/**
 * Every figure the Analytics tab shows, aggregated in SQL.
 *
 * One call rather than one per chart: the tab shows all of it at once, and a
 * dozen round trips that each re-scan thousands of rows would be slower and
 * could disagree with each other if a session landed between two of them.
 */
/** Rates are per-unit, and a unit with a handful of rows is noise not a trend. */
const MIN_SESSIONS_FOR_A_UNIT = 10
/** Enough to cover questions, words, slides, pages and the rest of the real tail. */
const MAX_UNITS = 12
/**
 * Durations are grouped so the chart has bars rather than a smear.
 *
 * 97% of runs were set to a multiple of five minutes, so the raw values are
 * already clustered; this only tidies the stragglers.
 */
function bucketMinutes(seconds: number): number {
  const minutes = seconds / 60
  if (minutes <= 15) return Math.max(5, Math.round(minutes / 5) * 5)
  if (minutes <= 60) return Math.round(minutes / 15) * 15
  return Math.round(minutes / 30) * 30
}
export function analytics(): Analytics {
  const db = openDatabase()
  const span = db
    .prepare(
      `SELECT MIN(session_date) AS first, MAX(session_date) AS last,
              COUNT(*) AS sessions,
              COALESCE(SUM(running_duration_s), 0) AS seconds,
              COUNT(DISTINCT session_date) AS activeDays
         FROM sessions`
    )
    .get() as {
    first: string | null
    last: string | null
    sessions: number
    seconds: number
    activeDays: number
  }
  const empty: Analytics = {
    firstDate: null,
    lastDate: null,
    totalHours: 0,
    totalSessions: 0,
    activeDays: 0,
    calendarDays: 0,
    daily: [],
    byProject: [],
    byHour: [],
    timedSessions: 0,
    timedFirst: null,
    timedLast: null,
    plannedVsActual: [],
    units: [],
    ratesByUnit: {},
    pace: []
  }
  if (span.first === null || span.last === null || Number(span.sessions) === 0) return empty
  const rawDaily = (
    db
      .prepare(
        `SELECT session_date AS date,
                SUM(running_duration_s) / 3600.0 AS hours,
                COUNT(*) AS sessions
           FROM sessions
          WHERE session_date IS NOT NULL
          GROUP BY session_date
          ORDER BY session_date`
      )
      .all() as Array<{ date: string; hours: number; sessions: number }>
  ).map((row) => ({ date: row.date, hours: Number(row.hours), sessions: Number(row.sessions) }))
  // Gap-filled here rather than in the components: a heatmap and a trend line
  // both need real zeroes for days off, and neither should have to know how to
  // walk a calendar.
  const daily: DayTotal[] = fillDays(rawDaily, span.first, span.last)
  const byProject = (
    db
      .prepare(
        `SELECT COALESCE(p.name, 'Unlabelled') AS name,
                SUM(s.running_duration_s) / 3600.0 AS hours,
                COUNT(*) AS sessions
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
          GROUP BY COALESCE(p.name, 'Unlabelled')
          ORDER BY hours DESC`
      )
      .all() as Array<{ name: string; hours: number; sessions: number }>
  ).map((row) => ({ name: row.name, hours: Number(row.hours), sessions: Number(row.sessions) }))
  /**
   * Time of day can only ever describe app-recorded rows.
   *
   * Imported sessions carry a date but no clock time - countdown readings
   * cannot become timestamps - so including them would invent a working
   * pattern out of nothing. `localtime` because a session belongs to the hour
   * it was lived in, not its UTC equivalent.
   */
  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', started_at, 'localtime') AS INTEGER) AS hour,
              SUM(running_duration_s) / 3600.0 AS hours,
              COUNT(*) AS sessions
         FROM sessions
        WHERE source = 'app' AND started_at IS NOT NULL
        GROUP BY hour`
    )
    .all() as Array<{ hour: number | null; hours: number; sessions: number }>
  const hourMap = new Map(hourRows.filter((r) => r.hour !== null).map((r) => [Number(r.hour), r]))
  const byHour: HourTotal[] = Array.from({ length: 24 }, (_, hour) => {
    const found = hourMap.get(hour)
    return {
      hour,
      hours: found ? Number(found.hours) : 0,
      sessions: found ? Number(found.sessions) : 0
    }
  })
  // Count and span come from one statement so they cannot disagree about which
  // rows the time-of-day chart is drawn from. `session_date` rather than
  // `started_at` because it is the local calendar date, and a session at 11pm
  // belongs to the day as lived.
  const timedSpan = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(session_date) AS first, MAX(session_date) AS last
         FROM sessions
        WHERE source = 'app' AND started_at IS NOT NULL`
    )
    .get() as { n: number; first: string | null; last: string | null }
  const timedSessions = Number(timedSpan.n)
  const timedFirst = timedSpan.first ?? null
  const timedLast = timedSpan.last ?? null
  const plannedRows = db
    .prepare(
      `SELECT planned_duration_s AS planned, running_duration_s AS actual
         FROM sessions
        WHERE planned_duration_s > 0 AND running_duration_s > 0`
    )
    .all() as Array<{ planned: number; actual: number }>
  const buckets = new Map<number, { sessions: number; actualSeconds: number }>()
  for (const row of plannedRows) {
    const key = bucketMinutes(Number(row.planned))
    const entry = buckets.get(key) ?? { sessions: 0, actualSeconds: 0 }
    entry.sessions += 1
    entry.actualSeconds += Number(row.actual)
    buckets.set(key, entry)
  }
  const plannedVsActual: PlannedVsActual[] = [...buckets.entries()]
    .map(([plannedMinutes, v]) => ({
      plannedMinutes,
      sessions: v.sessions,
      actualMinutes: v.actualSeconds / 60 / v.sessions
    }))
    .sort((a, b) => a.plannedMinutes - b.plannedMinutes)
  const unitRows = db
    .prepare(
      `SELECT work_unit AS unit, COUNT(*) AS n
         FROM sessions
        WHERE work_unit IS NOT NULL AND work_unit <> ''
          AND work_quantity > 0 AND running_duration_s > 0
          AND unquantifiable = 0
        GROUP BY work_unit
       HAVING n >= ?
        ORDER BY n DESC
        LIMIT ?`
    )
    .all(MIN_SESSIONS_FOR_A_UNIT, MAX_UNITS) as Array<{ unit: string; n: number }>
  const units = unitRows.map((r) => r.unit)
  const ratePoints = db.prepare(
    `SELECT session_date AS date,
            work_quantity AS quantity,
            running_duration_s / 60.0 AS minutes
       FROM sessions
      WHERE work_unit = ? AND work_quantity > 0 AND running_duration_s > 0
        AND unquantifiable = 0 AND session_date IS NOT NULL
      ORDER BY session_date`
  )
  const ratesByUnit: Record<string, RatePoint[]> = {}
  for (const unit of units) {
    ratesByUnit[unit] = (
      ratePoints.all(unit) as Array<{ date: string; quantity: number; minutes: number }>
    ).map((row) => ({
      date: row.date,
      quantity: Number(row.quantity),
      minutes: Number(row.minutes),
      rate: Number(row.quantity) / Number(row.minutes)
    }))
  }
  /**
   * How good the user's own predictions are.
   *
   * The target is the pace quantity scaled to how long the session actually
   * ran - a 100-words-per-20-minutes loop over 50 minutes was aiming at 250,
   * not 100 - which is the only comparison that means anything against what
   * was produced.
   */
  const pace: PacePoint[] = (
    db
      .prepare(
        `SELECT session_date AS date,
                pace_target_qty AS target,
                pace_target_interval_s AS interval,
                running_duration_s AS seconds,
                work_quantity AS actual,
                work_unit AS unit
           FROM sessions
          WHERE pace_target_qty > 0 AND pace_target_interval_s > 0
            AND work_quantity IS NOT NULL AND session_date IS NOT NULL
          ORDER BY session_date`
      )
      .all() as Array<{
      date: string
      target: number
      interval: number
      seconds: number
      actual: number
      unit: string | null
    }>
  )
    .map((row) => {
      const target = (Number(row.target) * Number(row.seconds)) / Number(row.interval)
      return {
        date: row.date,
        target,
        actual: Number(row.actual),
        unit: row.unit ?? '',
        // Dimensionless, so sessions measured in words and in questions belong
        // in the same series. See PacePoint.
        ratio: target > 0 ? Number(row.actual) / target : 0
      }
    })
    .filter((point) => point.target > 0)
  const dayMs = 86_400_000
  const calendarDays =
    Math.round(
      (Date.parse(span.last + 'T00:00:00Z') - Date.parse(span.first + 'T00:00:00Z')) / dayMs
    ) + 1
  return {
    firstDate: span.first,
    lastDate: span.last,
    totalHours: Number(span.seconds) / 3600,
    totalSessions: Number(span.sessions),
    activeDays: Number(span.activeDays),
    calendarDays,
    daily,
    byProject,
    byHour,
    timedSessions,
    timedFirst,
    timedLast,
    plannedVsActual,
    units,
    ratesByUnit,
    pace
  }
}
