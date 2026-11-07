import { openDatabase } from './index'
import {
  fillDays,
  type Analytics,
  type DayTotal,
  type HourTotal,
  type PacePoint,
  type PlannedVsActual,
  type RatePoint,
  type SessionRow
} from '../../shared/analytics'
import {
  bucketMinutes,
  type HourDay,
  type PlannedRun,
  type ProjectDay,
  type UnitDay
} from '../../shared/ranges'
import type { StarRow } from '../../shared/constellation'
/**
 * Every figure the Analytics tab shows, aggregated in SQL.
 *
 * One call rather than one per chart: the tab shows all of it at once, and a
 * dozen round trips that each re-scan thousands of rows would be slower and
 * could disagree with each other if a session landed between two of them.
 */
/**
 * The rows analytics may count: everything except `test`.
 *
 * `test` marks a row written by an unpackaged build or a session testing the
 * app. One three-second row does not move a total, but test data anywhere in
 * the statistics is what makes the statistics untrustworthy, and the rule
 * should not depend on the rows happening to be small. Every query below reads
 * through this rather than repeating the clause, so a new chart cannot forget
 * it. SQLite flattens the subquery, so the indexes on `sessions` still apply.
 */
const COUNTED = `(SELECT * FROM sessions WHERE source <> 'test')`

/** Above this, an imported run that went exactly to term is an event, not a timer. */
const EVENT_THRESHOLD_S = 3 * 60 * 60

/** Rates are per-unit, and a unit with a handful of rows is noise not a trend. */
const MIN_SESSIONS_FOR_A_UNIT = 10
/** Enough to cover questions, words, slides, pages and the rest of the real tail. */
const MAX_UNITS = 12
/*
 * `bucketMinutes` used to live here. It moved to `shared/ranges.ts` when every
 * panel got its own range: the renderer has to re-bucket the planned-length
 * chart for whatever range it is set to, and two copies of the thresholds
 * would drift - with the drift showing up as the range control appearing to
 * change the shape of the chart.
 *
 * 97% of runs were set to a multiple of five minutes, so the raw values are
 * already clustered; the bucketing only tidies the stragglers.
 */
export function analytics(): Analytics {
  const db = openDatabase()
  const span = db
    .prepare(
      `SELECT MIN(session_date) AS first, MAX(session_date) AS last,
              COUNT(*) AS sessions,
              COALESCE(SUM(running_duration_s), 0) AS seconds,
              COUNT(DISTINCT session_date) AS activeDays
         FROM ${COUNTED} AS sessions`
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
    pace: [],
    unitTotals: [],
    longestSession: null,
    editingHours: 0,
    projectDays: [],
    hourDays: [],
    plannedRuns: [],
    unitDays: [],
    unitTasks: {},
    sessionRows: [],
    stars: []
  }
  if (span.first === null || span.last === null || Number(span.sessions) === 0) return empty
  const rawDaily = (
    db
      .prepare(
        `SELECT session_date AS date,
                SUM(running_duration_s) / 3600.0 AS hours,
                COUNT(*) AS sessions
           FROM ${COUNTED} AS sessions
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
        `SELECT COALESCE(p.name, 'Unlabeled') AS name,
                SUM(s.running_duration_s) / 3600.0 AS hours,
                COUNT(*) AS sessions
           FROM ${COUNTED} s LEFT JOIN projects p ON p.id = s.project_id
          GROUP BY COALESCE(p.name, 'Unlabeled')
          ORDER BY hours DESC`
      )
      .all() as Array<{ name: string; hours: number; sessions: number }>
  ).map((row) => ({ name: row.name, hours: Number(row.hours), sessions: Number(row.sessions) }))
  /*
   * The same totals grouped by day as well, so a panel can re-total them over
   * its own range. See `Analytics.projectDays`: a total that has thrown its
   * dates away cannot be narrowed in the renderer, and this is the finest
   * grain any range control can ask for.
   *
   * Rows with no `session_date` are left out rather than given one. A date
   * filter must not guess - `CLAUDE.md` settles the same question for the Data
   * tab - and a row with no date cannot belong to a range. They stay in
   * `byProject`, which is the all-time figure and counts everything.
   */
  const projectDays: ProjectDay[] = (
    db
      .prepare(
        `SELECT s.session_date AS date,
                COALESCE(p.name, 'Unlabeled') AS name,
                SUM(s.running_duration_s) / 3600.0 AS hours,
                COUNT(*) AS sessions
           FROM ${COUNTED} s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.session_date IS NOT NULL
          GROUP BY s.session_date, COALESCE(p.name, 'Unlabeled')
          ORDER BY s.session_date`
      )
      .all() as Array<{ date: string; name: string; hours: number; sessions: number }>
  ).map((row) => ({
    date: row.date,
    name: row.name,
    hours: Number(row.hours),
    sessions: Number(row.sessions)
  }))
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
         FROM ${COUNTED} AS sessions
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
  // By day as well, for the panel's own range control. The same `source` and
  // `started_at` conditions, so a ranged reading can never include a row the
  // all-time one excludes.
  const hourDays: HourDay[] = (
    db
      .prepare(
        `SELECT session_date AS date,
                CAST(strftime('%H', started_at, 'localtime') AS INTEGER) AS hour,
                SUM(running_duration_s) / 3600.0 AS hours,
                COUNT(*) AS sessions
           FROM ${COUNTED} AS sessions
          WHERE source = 'app' AND started_at IS NOT NULL AND session_date IS NOT NULL
          GROUP BY session_date, hour
          ORDER BY session_date`
      )
      .all() as Array<{ date: string; hour: number | null; hours: number; sessions: number }>
  )
    .filter((row) => row.hour !== null)
    .map((row) => ({
      date: row.date,
      hour: Number(row.hour),
      hours: Number(row.hours),
      sessions: Number(row.sessions)
    }))
  // Count and span come from one statement so they cannot disagree about which
  // rows the time-of-day chart is drawn from. `session_date` rather than
  // `started_at` because it is the local calendar date, and a session at 11pm
  // belongs to the day as lived.
  const timedSpan = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(session_date) AS first, MAX(session_date) AS last
         FROM ${COUNTED} AS sessions
        WHERE source = 'app' AND started_at IS NOT NULL`
    )
    .get() as { n: number; first: string | null; last: string | null }
  const timedSessions = Number(timedSpan.n)
  const timedFirst = timedSpan.first ?? null
  const timedLast = timedSpan.last ?? null
  /*
   * Timer runs only - not events typed in afterwards.
   *
   * Above three hours the history stops behaving like a timer: 115 of 123
   * imported rows planned over 3 h "ran" exactly to zero, against 16-26% at
   * every ordinary length. They are Scioly competitions, hackathons and
   * internship days, entered as an event's length with a 0:00:00 end typed by
   * hand. Kept, they put 17 near-100% bars on the chart and lift the headline
   * by about five points, answering "how long was the event" in a panel that
   * asks "are my timers the right length". Measured 2026-11-05: 80.2% over
   * 2,475 runs becomes 75.5% over 2,360.
   *
   * Manual rows go for the same reason: Add session sets planned equal to
   * actual when no plan is given, so every after-the-fact entry would land at
   * exactly 100%.
   *
   * This chart only. Those rows are 653 h of real work and stay in every
   * total, average and the calendar.
   */
  const plannedRows = db
    .prepare(
      `SELECT session_date AS date, planned_duration_s AS planned, running_duration_s AS actual
         FROM ${COUNTED} AS sessions
        WHERE planned_duration_s > 0 AND running_duration_s > 0
          AND source <> 'manual'
          AND NOT (source = 'import'
                   AND planned_duration_s > ${EVENT_THRESHOLD_S}
                   AND running_duration_s = planned_duration_s)`
    )
    .all() as Array<{ date: string | null; planned: number; actual: number }>
  /*
   * The runs themselves, for the panel's range control, taken from the rows
   * this chart has already decided it may count rather than from a second
   * query. The exclusions above are subtle - events typed in with a 0:00:00
   * end, manual rows whose planned equals their actual - and a separate
   * statement would be a second place for them to be stated and a second
   * place to get them wrong.
   */
  const plannedRuns: PlannedRun[] = plannedRows
    .filter((row): row is { date: string; planned: number; actual: number } => row.date !== null)
    .map((row) => ({ date: row.date, planned: Number(row.planned), actual: Number(row.actual) }))
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
         FROM ${COUNTED} AS sessions
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
  /*
   * Two exclusions beyond "has a quantity", both of which distort a rate
   * rather than merely adding noise to it.
   *
   * A **manual** row is entered from memory afterwards - a six-hour club
   * meeting recalled as "about six hours" - so its minutes are an estimate
   * and its quantity usually absent. `CLAUDE.md` already says manual rows
   * carry approximate times and should be weighted or excluded wherever
   * timing is the point; a rate is minutes in the denominator, so it is
   * exactly that case.
   *
   * A run **under five minutes** divides by a very small number, so one
   * question finished in the last ninety seconds of a session reads as 0.67
   * a minute against a real pace nearer 0.05. Measured on the history, those
   * runs are where every impossible-looking rate comes from.
   */
  const MIN_RATE_SECONDS = 300
  const ratePoints = db.prepare(
    `SELECT session_date AS date,
            task,
            work_quantity AS quantity,
            running_duration_s / 60.0 AS minutes
       FROM ${COUNTED} AS sessions
      WHERE work_unit = ? AND work_quantity > 0
        AND running_duration_s >= ${MIN_RATE_SECONDS}
        AND source <> 'manual'
        AND unquantifiable = 0 AND session_date IS NOT NULL
      ORDER BY session_date`
  )
  const ratesByUnit: Record<string, RatePoint[]> = {}
  for (const unit of units) {
    ratesByUnit[unit] = (
      ratePoints.all(unit) as Array<{
        date: string
        task: string | null
        quantity: number
        minutes: number
      }>
    ).map((row) => ({
      date: row.date,
      task: row.task,
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
           FROM ${COUNTED} AS sessions
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
  // Fun-fact aggregates. Unquantifiable rows carry no number and are left out
  // rather than counted as zero, which would understate every total they sit in.
  const unitTotals = (
    db
      .prepare(
        `SELECT work_unit AS unit, SUM(work_quantity) AS quantity, COUNT(*) AS sessions
           FROM ${COUNTED} AS sessions
          WHERE work_unit IS NOT NULL AND work_unit <> ''
            AND work_quantity IS NOT NULL AND unquantifiable = 0
          GROUP BY work_unit
          ORDER BY sessions DESC, quantity DESC
          LIMIT 20`
      )
      .all() as Array<{ unit: string; quantity: number; sessions: number }>
  ).map((r) => ({ unit: r.unit, quantity: Number(r.quantity), sessions: Number(r.sessions) }))

  // By day as well, so the fun fact can follow its own range control, and a
  // sample of the tasks each unit was recorded against, so it can say what
  // was done rather than only how much. Same conditions as `unitTotals`, so
  // a ranged reading can never include a row the all-time one excludes.
  const unitDays: UnitDay[] = (
    db
      .prepare(
        `SELECT session_date AS date, work_unit AS unit,
                SUM(work_quantity) AS quantity, COUNT(*) AS sessions
           FROM ${COUNTED} AS sessions
          WHERE work_unit IS NOT NULL AND work_unit <> ''
            AND work_quantity IS NOT NULL AND unquantifiable = 0
            AND session_date IS NOT NULL
          GROUP BY session_date, work_unit
          ORDER BY session_date`
      )
      .all() as Array<{ date: string; unit: string; quantity: number; sessions: number }>
  ).map((row) => ({
    date: row.date,
    unit: row.unit,
    quantity: Number(row.quantity),
    sessions: Number(row.sessions)
  }))

  const taskRows = db.prepare(
    `SELECT DISTINCT task FROM ${COUNTED} AS sessions
      WHERE work_unit = ? AND task IS NOT NULL AND task <> ''
      LIMIT 12`
  )
  const unitTasks: Record<string, string[]> = {}
  for (const row of unitTotals) {
    unitTasks[row.unit] = (taskRows.all(row.unit) as Array<{ task: string }>).map((t) => t.task)
  }

  const longestRow = db
    .prepare(
      `SELECT s.session_date AS date, s.task AS task, p.name AS project,
              s.running_duration_s AS seconds
         FROM ${COUNTED} s LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY s.running_duration_s DESC
        LIMIT 1`
    )
    .get() as
    | { date: string | null; task: string | null; project: string | null; seconds: number }
    | undefined
  const longestSession = longestRow
    ? {
        date: longestRow.date,
        task: longestRow.task,
        project: longestRow.project,
        hours: Number(longestRow.seconds) / 3600
      }
    : null

  // LIKE narrows it in SQL; the word test below is the real one. A letter in
  // front of "edit" means it is part of another word - "credit" - and the
  // character class rather than a word-boundary escape is deliberate: an
  // escape has collapsed in transit in this repo more than once.
  const editRows = db
    .prepare(
      `SELECT task, running_duration_s AS seconds FROM ${COUNTED} AS sessions WHERE lower(task) LIKE '%edit%'`
    )
    .all() as Array<{ task: string; seconds: number }>
  const editingHours =
    editRows
      .filter((r) => /(^|[^a-z])edit/.test(r.task.toLowerCase()))
      .reduce((sum, r) => sum + Number(r.seconds), 0) / 3600

  /*
   * Every counted session with a date, for the insights card. The hour is
   * taken only where it means something - app-recorded rows - so no consumer
   * can build a time-of-day claim out of an imported or remembered row by
   * forgetting a filter. Same for quantity: an unquantifiable row sends null.
   */
  const sessionRows: SessionRow[] = (
    db
      .prepare(
        `SELECT s.session_date AS date, p.name AS project, s.task AS task,
                s.planned_duration_s AS planned, s.running_duration_s AS running,
                s.laps AS laps, s.source AS source,
                CASE WHEN s.source = 'app' AND s.started_at IS NOT NULL
                     THEN CAST(strftime('%H', s.started_at, 'localtime') AS INTEGER) END AS hour,
                NULLIF(s.work_unit, '') AS unit,
                CASE WHEN s.unquantifiable = 0 THEN s.work_quantity END AS quantity
           FROM ${COUNTED} s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.session_date IS NOT NULL
          ORDER BY s.session_date, s.started_at`
      )
      .all() as Array<{
      date: string
      project: string | null
      task: string | null
      planned: number | null
      running: number | null
      laps: number | null
      source: string
      hour: number | null
      unit: string | null
      quantity: number | null
    }>
  ).map((row) => ({
    date: row.date,
    project: row.project,
    task: row.task,
    plannedS: Number(row.planned ?? 0),
    runningS: Number(row.running ?? 0),
    laps: Math.max(1, Number(row.laps ?? 1)),
    source: row.source,
    hour: row.hour === null ? null : Number(row.hour),
    unit: row.unit,
    quantity: row.quantity === null ? null : Number(row.quantity)
  }))

  /*
   * The Constellation panel's rows. Clock times only for app-recorded rows,
   * for the same reason `hour` is: an imported row has none, and a manual
   * one has a remembered one, which must not decide whether two sessions
   * were one sitting. Ordered by id, which within a day is the order the
   * spreadsheet logged them in.
   */
  const stars: StarRow[] = (
    db
      .prepare(
        `SELECT s.id AS id, s.session_date AS date, p.name AS project, s.task AS task,
                s.running_duration_s AS running, s.source AS source,
                NULLIF(s.work_unit, '') AS unit,
                CASE WHEN s.unquantifiable = 0 THEN s.work_quantity END AS quantity,
                CASE WHEN s.source = 'app' THEN s.started_at END AS startedAt,
                CASE WHEN s.source = 'app' THEN s.ended_at END AS endedAt
           FROM ${COUNTED} s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.session_date IS NOT NULL
          ORDER BY s.id`
      )
      .all() as Array<{
      id: number
      date: string
      project: string | null
      task: string | null
      running: number | null
      source: string
      unit: string | null
      quantity: number | null
      startedAt: string | null
      endedAt: string | null
    }>
  ).map((row) => {
    const start = row.startedAt === null ? NaN : Date.parse(row.startedAt)
    const end = row.endedAt === null ? NaN : Date.parse(row.endedAt)
    const timed = Number.isFinite(start) && Number.isFinite(end)
    return {
      id: Number(row.id),
      date: row.date,
      project: row.project,
      task: row.task,
      runningS: Number(row.running ?? 0),
      unit: row.unit,
      quantity: row.quantity === null ? null : Number(row.quantity),
      source: row.source,
      startMs: timed ? start : null,
      endMs: timed ? end : null
    }
  })

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
    pace,
    unitTotals,
    longestSession,
    editingHours,
    projectDays,
    hourDays,
    plannedRuns,
    unitDays,
    unitTasks,
    sessionRows,
    stars
  }
}
