import { checkpoint, openDatabase } from './index'
import type { ImportRow } from '../import/csv'

export interface ImportResult {
  sessions: number
  projectsCreated: number
  replaced: number
}

export function importedSessionCount(): number {
  const row = openDatabase()
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE source = 'import'")
    .get() as { n: number } | undefined
  return Number(row?.n ?? 0)
}

/**
 * Writes imported rows, replacing any previous import.
 *
 * Re-importing is expected - the sheet keeps growing - so the safe behaviour is
 * to replace rather than append, which would otherwise double every historical
 * hour. Only `source = 'import'` rows are touched; app-recorded sessions are
 * never at risk.
 */
export function importRows(rows: ImportRow[]): ImportResult {
  const db = openDatabase()
  db.exec('BEGIN')
  try {
    const replaced = db.prepare("DELETE FROM sessions WHERE source = 'import'").run().changes

    const findProject = db.prepare('SELECT id FROM projects WHERE name = ?')
    const insertProject = db.prepare('INSERT INTO projects (name) VALUES (?)')
    const insertSession = db.prepare(
      `INSERT INTO sessions
         (project_id, task, session_date, started_at, ended_at,
          planned_duration_s, running_duration_s,
          work_quantity, work_unit, unquantifiable, notes, source)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'import')`
    )

    const projectIds = new Map<string, number>()
    let projectsCreated = 0

    for (const row of rows) {
      // A null project is stored as a null `project_id`, not as a project
      // literally called "Unlabelled". Unlabelled is the absence of a row in
      // `projects`, which is what `querySessions`'s -1 sentinel filters on; a
      // real project by that name would be a 37th category that the user never
      // created and would have to maintain.
      let projectId: number | null = null
      if (row.project !== null) {
        projectId = projectIds.get(row.project) ?? null
        if (projectId === null) {
          const existing = findProject.get(row.project) as { id: number } | undefined
          if (existing) {
            projectId = Number(existing.id)
          } else {
            projectId = Number(insertProject.run(row.project).lastInsertRowid)
            projectsCreated += 1
          }
          projectIds.set(row.project, projectId)
        }
      }

      insertSession.run(
        projectId,
        row.task,
        row.date,
        row.plannedS,
        row.actualS,
        row.quantity,
        row.unit,
        row.unquantifiable ? 1 : 0,
        row.notes
      )
    }

    db.exec('COMMIT')
    // Thousands of rows is exactly the case that must not sit in the -wal.
    checkpoint()
    return { sessions: rows.length, projectsCreated, replaced: Number(replaced) }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
