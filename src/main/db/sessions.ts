import { openDatabase } from './index'
import { runningMs, type TimerSnapshot } from '../../shared/timer'

export interface SessionRow {
  id: number
  task: string | null
  started_at: string | null
  ended_at: string | null
  planned_duration_s: number
  running_duration_s: number
  source: string
}

const iso = (epochMs: number): string => new Date(epochMs).toISOString()

/**
 * Writes a finished run and its pauses.
 *
 * Returns null for a run with no recorded time - starting and immediately
 * stopping should leave no trace rather than a zero-length row that would drag
 * averages down.
 */
export function recordSession(snapshot: TimerSnapshot): number | null {
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
           (task, started_at, ended_at, planned_duration_s, running_duration_s, source)
         VALUES (?, ?, ?, ?, ?, 'app')`
      )
      .run(
        snapshot.task.trim() || null,
        iso(snapshot.startedAt),
        iso(Date.now()),
        Math.round(snapshot.plannedMs / 1000),
        runningSeconds
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

export function recentSessions(limit = 20): SessionRow[] {
  return openDatabase()
    .prepare(
      `SELECT id, task, started_at, ended_at, planned_duration_s, running_duration_s, source
         FROM sessions
        ORDER BY COALESCE(started_at, '') DESC, id DESC
        LIMIT ?`
    )
    .all(limit) as unknown as SessionRow[]
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
