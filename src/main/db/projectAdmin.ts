/**
 * Curating the project list: rename, merge, hide, delete.
 *
 * *"i should be able to manually adjust what projects the app recognizes"*
 * (11/09/2026). What prompted it was a project called `Entre` with no
 * sessions sitting in the timer's suggestions, left behind by the bug fixed
 * in de53a3e where picking a suggestion kept the typed text. A row could be
 * created by a typo and there was no way to remove it.
 *
 * **The timer still creates projects by typing**, which CLAUDE.md gives the
 * reason for: a step between deciding to work and starting is a reason not to
 * label. This is the other half of that bargain - creating stays free, and
 * tidying up afterwards is now possible. It is in Settings, not in the way.
 *
 * ## Why these four and not an editor
 *
 * The drift this app exists to prevent is `College Apps` / `College
 * Applications` / `College` as three rows. Each operation here is one of the
 * ways that gets repaired or avoided:
 *
 * - **Rename fixes history**, because sessions point at the row rather than
 *   carrying the string. Renaming onto a name that already exists is not an
 *   error to report, it is a merge to offer - that is the drift being
 *   repaired, and failing on `UNIQUE` would leave the user to work out what
 *   happened.
 * - **Merge moves the sessions and tags and deletes the source**, which is
 *   how sixty-six categories became thirty-six and the only way to do it by
 *   hand.
 * - **Hiding keeps the sessions.** A project that is over - Sprocket, after
 *   leaving high school - should stop being offered without its three years
 *   of history leaving the analytics. That is `archived`, which has been in
 *   the schema since migration 1 and unused until now.
 * - **Delete is refused while anything points at it.** A project with
 *   sessions is history; losing it would orphan them. The UI offers merge or
 *   hide instead, which is why the refusal names them.
 */
import { openDatabase, checkpoint, checkpointSoon } from './index'

export interface ProjectAdminRow {
  id: number
  name: string
  archived: boolean
  sessions: number
  hours: number
  tags: number
  /** The most recent session's date, or null if it has none. */
  lastUsed: string | null
}

/**
 * Every project, most-used first, with what points at it.
 *
 * `listProjects` (the Data tab's filter) inner-joins sessions, so a project
 * with none is invisible to it - which is exactly the row this screen exists
 * to let the user remove. This one left-joins, and counts tags as well,
 * because both decide whether Delete is allowed.
 */
export function listProjectsForAdmin(): ProjectAdminRow[] {
  const rows = openDatabase()
    .prepare(
      `SELECT p.id                                  AS id,
              p.name                                AS name,
              p.archived                            AS archived,
              COUNT(s.id)                           AS sessions,
              COALESCE(SUM(s.running_duration_s), 0) AS seconds,
              MAX(s.session_date)                   AS lastUsed,
              (SELECT COUNT(*) FROM tags t WHERE t.project_id = p.id) AS tags
         FROM projects p
         LEFT JOIN sessions s ON s.project_id = p.id
        GROUP BY p.id, p.name, p.archived
        ORDER BY sessions DESC, p.name ASC`
    )
    .all() as unknown as Array<{
    id: number
    name: string
    archived: number
    sessions: number
    seconds: number
    lastUsed: string | null
    tags: number
  }>
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    archived: row.archived !== 0,
    sessions: Number(row.sessions),
    hours: Number(row.seconds) / 3600,
    tags: Number(row.tags),
    lastUsed: row.lastUsed
  }))
}

export type ProjectResult =
  | { ok: true }
  /** The new name is already a project. The UI offers to merge into it. */
  | { ok: false; conflict: { id: number; name: string; sessions: number } }
  | { ok: false; reason: string }

/**
 * Rename in place, so every session that points at the row follows.
 *
 * A name that already belongs to another project comes back as a conflict
 * rather than an error: that is the drift case, and the answer to it is a
 * merge the user confirms, not a message saying no.
 *
 * The comparison is case-insensitive even though `UNIQUE` is not, because
 * `hw` beside `HW` is the exact mess this app was built to undo - SQLite
 * would accept the pair and the user would have made the drift by hand.
 * Changing only the capitalisation of a project's own name is a rename, not
 * a conflict with itself.
 */
export function renameProject(id: number, rawName: string): ProjectResult {
  const name = rawName.trim()
  if (name === '') return { ok: false, reason: 'A project needs a name.' }
  const db = openDatabase()
  const self = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as
    { name: string } | undefined
  if (self === undefined) return { ok: false, reason: 'That project no longer exists.' }
  if (self.name === name) return { ok: true }

  const clash = db
    .prepare('SELECT id, name FROM projects WHERE lower(name) = lower(?) AND id <> ?')
    .get(name, id) as { id: number; name: string } | undefined
  if (clash !== undefined) {
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?')
      .get(clash.id) as { n: number }
    return {
      ok: false,
      conflict: { id: Number(clash.id), name: clash.name, sessions: Number(count.n) }
    }
  }

  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
  checkpointSoon()
  return { ok: true }
}

export interface MergePlan {
  from: string
  into: string
  sessions: number
  tags: number
}

/** What a merge would move, for the confirmation to state before it happens. */
export function planMerge(sourceId: number, targetId: number): MergePlan | null {
  const db = openDatabase()
  const from = db.prepare('SELECT name FROM projects WHERE id = ?').get(sourceId) as
    { name: string } | undefined
  const into = db.prepare('SELECT name FROM projects WHERE id = ?').get(targetId) as
    { name: string } | undefined
  if (from === undefined || into === undefined) return null
  const sessions = db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?')
    .get(sourceId) as { n: number }
  const tags = db.prepare('SELECT COUNT(*) AS n FROM tags WHERE project_id = ?').get(sourceId) as {
    n: number
  }
  return {
    from: from.name,
    into: into.name,
    sessions: Number(sessions.n),
    tags: Number(tags.n)
  }
}

/**
 * Move everything to the target and delete the source.
 *
 * In one transaction, because a half-merged project - sessions moved, row
 * still there, or worse the other way round - is a state nobody could
 * describe and the user would have to repair by hand. `checkpoint()` rather
 * than `checkpointSoon()`: this is one decisive write that rewrites hundreds
 * of session rows, which is the shape the immediate form exists for.
 *
 * A tag whose name already exists on the target cannot move - `tags` is
 * `UNIQUE (name, project_id)` - so it is deleted rather than moved. Nothing
 * writes to `tags` yet, and when something does, two tags with one name on
 * one project would be the same tag.
 */
export function mergeProjects(sourceId: number, targetId: number): ProjectResult {
  if (sourceId === targetId) return { ok: false, reason: 'A project cannot merge into itself.' }
  const db = openDatabase()
  const plan = planMerge(sourceId, targetId)
  if (plan === null) return { ok: false, reason: 'One of those projects no longer exists.' }

  db.exec('BEGIN')
  try {
    db.prepare('UPDATE sessions SET project_id = ? WHERE project_id = ?').run(targetId, sourceId)
    db.prepare(
      `DELETE FROM tags
        WHERE project_id = ?
          AND name IN (SELECT name FROM tags WHERE project_id = ?)`
    ).run(sourceId, targetId)
    db.prepare('UPDATE tags SET project_id = ? WHERE project_id = ?').run(targetId, sourceId)
    db.prepare('DELETE FROM projects WHERE id = ?').run(sourceId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  checkpoint()
  return { ok: true }
}

/**
 * Hide from the suggestions, or bring back.
 *
 * Sessions are untouched and every analytic still counts them, which is the
 * whole point: a finished project should stop being offered without its
 * history leaving. See `findOrCreateProject` for what happens if the name is
 * typed again.
 */
export function setProjectArchived(id: number, archived: boolean): ProjectResult {
  const db = openDatabase()
  const done = db.prepare('UPDATE projects SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
  if (done.changes === 0) return { ok: false, reason: 'That project no longer exists.' }
  checkpointSoon()
  return { ok: true }
}

/**
 * Delete, but only a project nothing points at.
 *
 * `sessions.project_id` is `ON DELETE SET NULL`, so deleting a project in use
 * would not fail - it would quietly unlabel every session that belonged to
 * it, which is the one outcome this screen must not make easy. The refusal
 * names the counts and the alternatives, because "cannot delete" without them
 * is a dead end.
 */
export function deleteProject(id: number): ProjectResult {
  const db = openDatabase()
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as
    { name: string } | undefined
  if (row === undefined) return { ok: false, reason: 'That project no longer exists.' }
  const sessions = db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?')
    .get(id) as { n: number }
  const tags = db.prepare('SELECT COUNT(*) AS n FROM tags WHERE project_id = ?').get(id) as {
    n: number
  }
  if (Number(sessions.n) > 0 || Number(tags.n) > 0) {
    const parts: string[] = []
    if (Number(sessions.n) > 0) parts.push(`${sessions.n} session${sessions.n === 1 ? '' : 's'}`)
    if (Number(tags.n) > 0) parts.push(`${tags.n} tag${tags.n === 1 ? '' : 's'}`)
    return {
      ok: false,
      reason: `${row.name} still has ${parts.join(' and ')}. Merge it into another project to keep them, or hide it to stop it being suggested.`
    }
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  checkpointSoon()
  return { ok: true }
}
