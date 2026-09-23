import { openDatabase } from './index'
import { runningMs, type TimerSnapshot } from '../../shared/timer'

/** Every column, so a deleted row can be restored exactly as it was. */
export interface SessionRow {
  id: number
  project_id: number | null
  tag_id: number | null
  task: string | null
  session_date: string | null
  started_at: string | null
  ended_at: string | null
  planned_duration_s: number
  running_duration_s: number
  stop_reason: string | null
  stop_reason_note: string | null
  work_quantity: number | null
  work_unit: string | null
  unquantifiable: number
  notes: string | null
  pace_target_qty: number | null
  pace_target_interval_s: number | null
  source: string
}

export const SESSION_COLUMNS = [
  'project_id',
  'tag_id',
  'task',
  'session_date',
  'started_at',
  'ended_at',
  'planned_duration_s',
  'running_duration_s',
  'stop_reason',
  'stop_reason_note',
  'work_quantity',
  'work_unit',
  'unquantifiable',
  'notes',
  'pace_target_qty',
  'pace_target_interval_s',
  'source'
] as const

export type SessionPatch = Partial<Omit<SessionRow, 'id'>>

const iso = (epochMs: number): string => new Date(epochMs).toISOString()

function localDate(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Writes a finished run and its pauses.
 *
 * Returns null for a run with no recorded time - starting and immediately
 * stopping should leave no trace rather than a zero-length row that would drag
 * averages down.
 */
export interface PaceTarget {
  quantity: number | null
  intervalMs: number
}

export function recordSession(snapshot: TimerSnapshot, pace?: PaceTarget | null): number | null {
  const runningSeconds = Math.round(runningMs(snapshot, Date.now()) / 1000)
  if (snapshot.startedAt === null || runningSeconds < 1) return null

  const db = openDatabase()
  // Session and pauses go in together: pauses without their session would be
  // orphaned, and a session without its pauses makes running time unverifiable.
  db.exec('BEGIN')
  try {
    const result = db
      .prepare(
        `INSERT INTO sessions
           (task, session_date, started_at, ended_at,
          planned_duration_s, running_duration_s,
          pace_target_qty, pace_target_interval_s, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'app')`
      )
      .run(
        snapshot.task.trim() || null,
        // Local date, not UTC: a session at 11pm belongs to that day as lived,
        // which is how every daily total and streak is read.
        localDate(snapshot.startedAt),
        iso(snapshot.startedAt),
        iso(Date.now()),
        Math.round(snapshot.plannedMs / 1000),
        runningSeconds,
        pace?.quantity ?? null,
        pace ? Math.round(pace.intervalMs / 1000) : null
      )

    const sessionId = Number(result.lastInsertRowid)
    const insertPause = db.prepare(
      'INSERT INTO pauses (session_id, paused_at, resumed_at) VALUES (?, ?, ?)'
    )
    for (const pause of snapshot.pauses) {
      insertPause.run(sessionId, iso(pause.pausedAt), pause.resumedAt ? iso(pause.resumedAt) : null)
    }

    db.exec('COMMIT')
    return sessionId
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export interface SessionQuery {
  /** Inclusive local dates, `YYYY-MM-DD`. Null means unbounded on that side. */
  from?: string | null
  to?: string | null
  /** Substring of the task or the project name, case-insensitive. */
  search?: string | null
  /** `app` | `manual` | `import`. Null is all three. */
  source?: string | null
  projectId?: number | null
  /** Null is "show all" - SQLite reads a negative LIMIT as no limit at all. */
  limit?: number | null
  offset?: number
}

/** The project name is joined in for display; it is not a column of the row. */
export type SessionListRow = SessionRow & { project_name: string | null }

export interface SessionPage {
  rows: SessionListRow[]
  /** Rows matching the filter, not rows on this page. */
  total: number
  /** Recorded time across the whole filter, so paging cannot change the total. */
  totalRunningS: number
  offset: number
  /** The dates the table actually spans, for bounding the filter inputs. */
  earliest: string | null
  latest: string | null
}

export interface ProjectOption {
  id: number
  name: string
  sessions: number
}

const FROM = `FROM sessions s LEFT JOIN projects p ON p.id = s.project_id`
const ORDER = `ORDER BY COALESCE(s.session_date, '') DESC, COALESCE(s.started_at, '') DESC, s.id DESC`

/**
 * A date filter excludes undated rows rather than guessing where they belong.
 *
 * `session_date` arrived in a later migration, so rows written before it can be
 * null. Comparing those through COALESCE puts them before every real date,
 * which means an open-ended `to` silently sweeps them in while a `from`
 * silently drops them - the same row appearing or vanishing depending on which
 * end of the range was typed. Filtering by date only over rows that have one is
 * the only reading that stays consistent; with no filter they all show.
 */
function where(query: SessionQuery): { sql: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []

  if (query.from) {
    clauses.push('s.session_date IS NOT NULL AND s.session_date >= ?')
    params.push(query.from)
  }
  if (query.to) {
    clauses.push('s.session_date IS NOT NULL AND s.session_date <= ?')
    params.push(query.to)
  }
  if (query.source) {
    clauses.push('s.source = ?')
    params.push(query.source)
  }
  if (query.projectId != null) {
    clauses.push('s.project_id = ?')
    params.push(query.projectId)
  }
  // Task or project, because the two are used interchangeably when looking for
  // something: "the essay" is a task, "College Apps" is a project, and nobody
  // remembers which one a given label ended up in. LIKE is case-insensitive
  // for ASCII in SQLite by default, and the escapes keep a literal % or _ in
  // the search box from turning into a wildcard.
  if (query.search) {
    const term = '%' + query.search.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
    clauses.push("(s.task LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')")
    params.push(term, term)
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function querySessions(query: SessionQuery = {}): SessionPage {
  const db = openDatabase()
  const { sql, params } = where(query)
  const offset = Math.max(0, query.offset ?? 0)
  const limit = query.limit == null ? -1 : Math.max(0, query.limit)

  const rows = db
    .prepare(`SELECT s.*, p.name AS project_name ${FROM} ${sql} ${ORDER} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as SessionListRow[]

  const totals = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(s.running_duration_s), 0) AS t ${FROM} ${sql}`)
    .get(...params) as { n: number; t: number }

  const span = db
    .prepare('SELECT MIN(session_date) AS lo, MAX(session_date) AS hi FROM sessions')
    .get() as { lo: string | null; hi: string | null }

  return {
    rows,
    total: Number(totals.n),
    totalRunningS: Number(totals.t),
    offset,
    earliest: span.lo,
    latest: span.hi
  }
}

/**
 * Only projects that have sessions, and ordered by how many.
 *
 * The import leaves 66 projects, most of them a handful of rows from years
 * ago. Alphabetical would bury the nine that account for most of the recent
 * history behind a list nobody scrolls.
 */
export function listProjects(): ProjectOption[] {
  return openDatabase()
    .prepare(
      `SELECT p.id AS id, p.name AS name, COUNT(s.id) AS sessions
         FROM projects p
         JOIN sessions s ON s.project_id = p.id
        GROUP BY p.id, p.name
        ORDER BY sessions DESC, p.name ASC`
    )
    .all() as unknown as ProjectOption[]
}

export function getSession(id: number): SessionRow | null {
  const row = openDatabase().prepare('SELECT * FROM sessions WHERE id = ?').get(id)
  return (row as unknown as SessionRow) ?? null
}

export interface PauseRow {
  session_id: number
  paused_at: string
  resumed_at: string | null
}

export function getPauses(sessionId: number): PauseRow[] {
  return openDatabase()
    .prepare('SELECT session_id, paused_at, resumed_at FROM pauses WHERE session_id = ?')
    .all(sessionId) as unknown as PauseRow[]
}

/**
 * Inserts a row, optionally keeping its original id.
 *
 * Undo needs the id back: analytics and the history stack both refer to rows by
 * it, and a restored session that came back under a new id would be a different
 * session as far as anything else is concerned.
 */
export function insertSession(patch: SessionPatch, id?: number): number {
  const columns = SESSION_COLUMNS.filter((c) => patch[c] !== undefined)
  const names = id === undefined ? columns : ['id', ...columns]
  const values =
    id === undefined ? columns.map((c) => patch[c]) : [id, ...columns.map((c) => patch[c])]
  const result = openDatabase()
    .prepare(
      `INSERT INTO sessions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
    )
    .run(...(values as Array<string | number | null>))
  return id ?? Number(result.lastInsertRowid)
}

export function patchSession(id: number, patch: SessionPatch): void {
  const columns = SESSION_COLUMNS.filter((c) => patch[c] !== undefined)
  if (columns.length === 0) return
  openDatabase()
    .prepare(`UPDATE sessions SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...(columns.map((c) => patch[c]) as Array<string | number | null>), id)
}

export function insertPauses(rows: PauseRow[]): void {
  if (rows.length === 0) return
  const statement = openDatabase().prepare(
    'INSERT INTO pauses (session_id, paused_at, resumed_at) VALUES (?, ?, ?)'
  )
  for (const row of rows) statement.run(row.session_id, row.paused_at, row.resumed_at)
}

/**
 * Totals are taken over local calendar days. A day with no sessions is a real
 * zero, not missing data, so averages must run over the range, not active days.
 */
export function totalSecondsSince(isoStart: string): number {
  const row = openDatabase()
    .prepare(
      'SELECT COALESCE(SUM(running_duration_s), 0) AS total FROM sessions WHERE started_at >= ?'
    )
    .get(isoStart) as { total: number } | undefined
  return Number(row?.total ?? 0)
}

/** Reasons are optional and applied after the fact, once the stop UI is answered. */
export function setStopReason(id: number, reason: string | null, note: string | null): void {
  openDatabase()
    .prepare('UPDATE sessions SET stop_reason = ?, stop_reason_note = ? WHERE id = ?')
    .run(reason, note, id)
}

/**
 * Output for a finished run, written after the fact like the stop reason.
 *
 * Quantity is REAL rather than an integer because the history is full of
 * `1.5 question` and `0.5 question` - half a problem set counts.
 */
export function setWorkQuantity(id: number, quantity: number | null, unit: string | null): void {
  openDatabase()
    .prepare('UPDATE sessions SET work_quantity = ?, work_unit = ? WHERE id = ?')
    .run(quantity, unit, id)
}

/**
 * The unit this task was last measured in, so the field arrives pre-filled.
 *
 * Nearly every session is one of a handful of repeated shapes - a problem set
 * is always questions, an essay is always words - so the right default is
 * almost always the last answer. Falls back to the most recent unit used at
 * all, which beats an empty box on the first session of a new task.
 */
export function lastUnitFor(task: string | null): string | null {
  const db = openDatabase()
  if (task && task.trim() !== '') {
    const match = db
      .prepare(
        `SELECT work_unit FROM sessions
          WHERE work_unit IS NOT NULL AND work_unit <> '' AND task = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(task.trim()) as { work_unit: string } | undefined
    if (match?.work_unit) return match.work_unit
  }
  const recent = db
    .prepare(
      `SELECT work_unit FROM sessions
        WHERE work_unit IS NOT NULL AND work_unit <> ''
        ORDER BY id DESC LIMIT 1`
    )
    .get() as { work_unit: string } | undefined
  return recent?.work_unit ?? null
}

/** Used only by undo, which must leave no trace of the stop it reverses. */
export function deleteSession(id: number): void {
  openDatabase().prepare('DELETE FROM sessions WHERE id = ?').run(id)
}
