/**
 * Copies what was done in a preview into the real history.
 *
 * ## Why the preview saves at all
 *
 * The preview was built as a disposable copy: everything written there was
 * marked `test` and thrown away by the next `npm run preview`. A banner said
 * so. On 2026-11-06 the user logged three real MATH 1410 sessions in it anyway
 * - to them, a window showing their history *is* the app - and they survived
 * only because they were noticed and copied across by hand. A build that looks
 * exactly like the real one and quietly discards what is entered into it is a
 * data-loss trap whatever its banner says, so the preview now keeps what it is
 * given.
 *
 * ## A three-way comparison, not a copy
 *
 * The installed app may be used while a preview is open, so neither side can
 * simply overwrite the other. `scripts/preview.ts` keeps the snapshot the
 * preview started from as a **baseline**, and every session is judged against
 * it:
 *
 * - **Added** in the preview (an id the baseline does not have): inserted into
 *   the real history under a fresh id, since the real one may have used the
 *   preview's id for something else in the meantime.
 * - **Edited** in the preview: applied only if the real row still matches the
 *   baseline. If the real row was changed too, neither version is chosen - it
 *   is reported as a conflict and both survive, the preview's in the archived
 *   copy.
 * - **Deleted** in the preview: applied under the same condition.
 *
 * Rows are compared by **project and tag name, not id**. The two databases
 * create projects independently, so the same id can name different projects
 * in each, and comparing ids would call that an edit.
 *
 * ## What it refuses to do
 *
 * More than `MAX_CHANGES` edits and deletes, or more than `MAX_ADDED` new
 * rows, is not something a person does by hand in a preview - it is a restore
 * or an import - and is refused rather than applied. The preview database is
 * left exactly where it is, so nothing is lost by refusing.
 *
 * Everything is one transaction against the real database: it all lands or
 * none of it does. A copy of the real database is written before it, and the
 * write is checkpointed after, for the reasons CLAUDE.md gives under
 * "Committed is not the same as safe".
 */
import { DatabaseSync } from 'node:sqlite'

export const MAX_CHANGES = 50
export const MAX_ADDED = 200

type Value = string | number | null
type Row = Record<string, Value>

export interface SyncLine {
  /** The session as the preview has it - or, for a delete, as it was. */
  previewId: number
  realId: number | null
  date: string | null
  project: string | null
  task: string | null
  hours: number
  note?: string
}

export interface SyncReport {
  added: SyncLine[]
  edited: SyncLine[]
  deleted: SyncLine[]
  /** Already in the real history - a re-run, or the same row entered twice. */
  alreadyThere: SyncLine[]
  /** Changed on both sides, or changed in the preview and gone from the real one. */
  conflicts: SyncLine[]
  /** No baseline: a preview from before baselines existed. Only additions are found. */
  legacy: boolean
  /** Where the real database was copied before writing, if anything was written. */
  backup: string | null
}

export class SyncRefused extends Error {}

export interface SyncOptions {
  /** The snapshot the preview started from. Null for a preview older than baselines. */
  baseline: string | null
  preview: string
  real: string
  /** Written with VACUUM INTO before the first change; required to write anything. */
  backupTo: string
}

function sqlString(path: string): string {
  if (path.includes("'")) throw new SyncRefused(`Refusing a path with a quote in it: ${path}`)
  return `'${path.replace(/\\/g, '/')}'`
}

function columns(db: DatabaseSync, schema: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(sessions)`).all() as Array<{ name: string }>).map(
    (c) => c.name
  )
}

/**
 * The columns all three databases have, minus the ones compared by name.
 *
 * The preview build may be a migration ahead of the installed one, so a column
 * only the preview has cannot be written, and one only the real database has
 * is left at whatever it holds.
 */
function sharedColumns(db: DatabaseSync, schemas: string[]): string[] {
  const sets = schemas.map((s) => new Set(columns(db, s)))
  return [...sets[0]].filter(
    (c) => c !== 'id' && c !== 'project_id' && c !== 'tag_id' && sets.every((set) => set.has(c))
  )
}

export function syncPreview(options: SyncOptions): SyncReport {
  const report: SyncReport = {
    added: [],
    edited: [],
    deleted: [],
    alreadyThere: [],
    conflicts: [],
    legacy: options.baseline === null,
    backup: null
  }

  const db = new DatabaseSync(options.real)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`ATTACH ${sqlString(options.preview)} AS prev`)
    if (options.baseline !== null) db.exec(`ATTACH ${sqlString(options.baseline)} AS base`)

    const schemas = options.baseline === null ? ['main', 'prev'] : ['main', 'prev', 'base']
    const cols = sharedColumns(db, schemas)

    /** A session as comparable data: shared columns, names for ids, its pauses. */
    const readers = new Map<string, (id: number) => Row | null>()
    for (const schema of schemas) {
      const rowStmt = db.prepare(
        `SELECT ${cols.map((c) => `s.${c}`).join(', ')},
                p.name AS project, t.name AS tag
           FROM ${schema}.sessions s
           LEFT JOIN ${schema}.projects p ON p.id = s.project_id
           LEFT JOIN ${schema}.tags t ON t.id = s.tag_id
          WHERE s.id = ?`
      )
      const pauseStmt = db.prepare(
        `SELECT paused_at, resumed_at FROM ${schema}.pauses WHERE session_id = ? ORDER BY paused_at, id`
      )
      readers.set(schema, (id) => {
        const row = rowStmt.get(id) as Row | undefined
        if (row === undefined) return null
        const pauses = (
          pauseStmt.all(id) as Array<{ paused_at: string; resumed_at: string | null }>
        )
          .map((p) => `${p.paused_at}|${p.resumed_at ?? ''}`)
          .join(';')
        return { ...row, pauses }
      })
    }
    const read = (schema: string, id: number): Row | null => readers.get(schema)!(id)
    const same = (a: Row | null, b: Row | null): boolean => JSON.stringify(a) === JSON.stringify(b)

    const ids = (schema: string): number[] =>
      (
        db.prepare(`SELECT id FROM ${schema}.sessions ORDER BY id`).all() as Array<{ id: number }>
      ).map((r) => r.id)

    const line = (previewId: number, row: Row, realId: number | null, note?: string): SyncLine => ({
      previewId,
      realId,
      date: (row['session_date'] as string | null) ?? null,
      project: (row['project'] as string | null) ?? null,
      task: (row['task'] as string | null) ?? null,
      hours: Math.round(((row['running_duration_s'] as number | null) ?? 0) / 36) / 100,
      ...(note === undefined ? {} : { note })
    })

    // ---- Work out what changed, before writing anything.
    const prevIds = ids('prev')
    let added: number[]
    let edited: number[] = []
    let deleted: number[] = []
    if (options.baseline === null) {
      // Without a baseline the only safe reading is the old preview's own
      // marker: everything it wrote was `test`, and the real history holds no
      // `test` rows. Edits and deletes cannot be told apart from changes made
      // in the installed app, so they are not guessed at.
      const realIds = new Set(ids('main'))
      added = (
        db
          .prepare(`SELECT id FROM prev.sessions WHERE source = 'test' ORDER BY id`)
          .all() as Array<{
          id: number
        }>
      )
        .map((r) => r.id)
        .filter((id) => !realIds.has(id) || !same(read('main', id), read('prev', id)))
    } else {
      const baseIds = ids('base')
      const inBase = new Set(baseIds)
      const inPrev = new Set(prevIds)
      added = prevIds.filter((id) => !inBase.has(id))
      deleted = baseIds.filter((id) => !inPrev.has(id))
      edited = prevIds.filter((id) => inBase.has(id) && !same(read('base', id), read('prev', id)))
    }

    if (edited.length + deleted.length > MAX_CHANGES || added.length > MAX_ADDED) {
      throw new SyncRefused(
        `The preview has ${added.length} added, ${edited.length} edited and ${deleted.length} ` +
          'deleted sessions - more than anyone changes by hand, so probably a restore or an ' +
          'import. Not copying any of it. The preview database has been left as it is.'
      )
    }
    if (added.length + edited.length + deleted.length === 0) return report

    // ---- A copy of the real history before the first write.
    db.exec(`VACUUM main INTO ${sqlString(options.backupTo)}`)
    report.backup = options.backupTo

    const findProject = db.prepare('SELECT id FROM main.projects WHERE name = ?')
    const prevProject = db.prepare('SELECT color FROM prev.projects WHERE name = ?')
    const makeProject = db.prepare('INSERT INTO main.projects (name, color) VALUES (?, ?)')
    const findTag = db.prepare(
      `SELECT t.id FROM main.tags t LEFT JOIN main.projects p ON p.id = t.project_id
        WHERE t.name = ? AND p.name IS ?`
    )
    const projectId = (name: Value): number | null => {
      if (name === null) return null
      const hit = findProject.get(name) as { id: number } | undefined
      if (hit) return hit.id
      // Created by exact name: the preview already resolved what was typed
      // against the same project list, so this is a genuinely new project.
      const color = (prevProject.get(name) as { color: string | null } | undefined)?.color ?? null
      return Number(makeProject.run(name, color).lastInsertRowid)
    }
    // Tags are unused so far; if one ever is, a tag the real history lacks is
    // dropped from the row and said so, rather than invented.
    const tagId = (row: Row): { id: number | null; missing: boolean } => {
      if (row['tag'] === null) return { id: null, missing: false }
      const hit = findTag.get(row['tag'], row['project']) as { id: number } | undefined
      return hit ? { id: hit.id, missing: false } : { id: null, missing: true }
    }

    const setPauses = (realId: number, pauses: Value): void => {
      db.prepare('DELETE FROM main.pauses WHERE session_id = ?').run(realId)
      const insert = db.prepare(
        'INSERT INTO main.pauses (session_id, paused_at, resumed_at) VALUES (?, ?, ?)'
      )
      for (const pair of String(pauses ?? '')
        .split(';')
        .filter(Boolean)) {
        const [pausedAt, resumedAt] = pair.split('|')
        insert.run(realId, pausedAt, resumedAt === '' ? null : resumedAt)
      }
    }

    // Any real row identical to this one, so a run interrupted between writing
    // and archiving cannot add the same session twice when it is re-run.
    const realIdsNow = (): number[] => ids('main')

    db.exec('BEGIN')
    try {
      const existing = realIdsNow()
      for (const id of added) {
        const row = read('prev', id)!
        // A preview from before this change wrote everything as `test`. What it
        // meant is recoverable: the timer stamps a start time, the form does not.
        if (row['source'] === 'test') row['source'] = row['started_at'] === null ? 'manual' : 'app'
        const twin = existing.find((realId) => same(read('main', realId), row))
        if (twin !== undefined) {
          report.alreadyThere.push(line(id, row, twin))
          continue
        }
        const tag = tagId(row)
        const result = db
          .prepare(
            `INSERT INTO main.sessions (project_id, tag_id, ${cols.join(', ')})
             VALUES (?, ?, ${cols.map(() => '?').join(', ')})`
          )
          .run(projectId(row['project']), tag.id, ...cols.map((c) => row[c]))
        const realId = Number(result.lastInsertRowid)
        setPauses(realId, row['pauses'])
        report.added.push(
          line(id, row, realId, tag.missing ? `tag ${row['tag']} dropped` : undefined)
        )
      }

      for (const id of edited) {
        const base = read('base', id)!
        const prev = read('prev', id)!
        const real = read('main', id)
        if (same(real, prev)) {
          report.alreadyThere.push(line(id, prev, id))
          continue
        }
        if (real === null) {
          report.conflicts.push(line(id, prev, null, 'deleted in the desktop app since'))
          continue
        }
        if (!same(real, base)) {
          report.conflicts.push(line(id, prev, id, 'also changed in the desktop app'))
          continue
        }
        const tag = tagId(prev)
        db.prepare(
          `UPDATE main.sessions SET project_id = ?, tag_id = ?, ${cols.map((c) => `${c} = ?`).join(', ')}
            WHERE id = ?`
        ).run(projectId(prev['project']), tag.id, ...cols.map((c) => prev[c]), id)
        if (prev['pauses'] !== base['pauses']) setPauses(id, prev['pauses'])
        report.edited.push(
          line(id, prev, id, tag.missing ? `tag ${prev['tag']} dropped` : undefined)
        )
      }

      for (const id of deleted) {
        const base = read('base', id)!
        const real = read('main', id)
        if (real === null) {
          report.alreadyThere.push(line(id, base, null))
          continue
        }
        if (!same(real, base)) {
          report.conflicts.push(
            line(id, base, id, 'deleted in the preview, changed in the desktop app')
          )
          continue
        }
        // Pauses go with it by ON DELETE CASCADE, as they do in the app.
        db.prepare('DELETE FROM main.sessions WHERE id = ?').run(id)
        report.deleted.push(line(id, base, id))
      }

      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    // Allowed to fail: a reader in the installed app can refuse it, and the
    // app's own next write checkpoints again.
    try {
      db.prepare('PRAGMA main.wal_checkpoint(TRUNCATE)').get()
    } catch {
      /* the next write in the app retries it */
    }
    return report
  } finally {
    db.close()
  }
}

/** The report as lines a person reads, for the console and the archive. */
export function describe(report: SyncReport): string[] {
  const out: string[] = []
  const fmt = (l: SyncLine): string =>
    `  ${l.date ?? '(no date)'}  ${l.project ?? 'Unlabeled'}  ${l.task ?? '(no task)'}  ${l.hours.toFixed(2)} h` +
    (l.note ? `  - ${l.note}` : '')
  const section = (title: string, lines: SyncLine[]): void => {
    if (lines.length === 0) return
    out.push(`${title} (${lines.length}):`)
    for (const l of lines) out.push(fmt(l))
  }
  section('Added to your real history', report.added)
  section('Edited in your real history', report.edited)
  section('Deleted from your real history', report.deleted)
  section('NOT copied - changed on both sides', report.conflicts)
  section('Already in your real history', report.alreadyThere)
  if (out.length === 0) out.push('Nothing was changed in the preview.')
  if (report.legacy)
    out.push('(An older preview: only sessions it added could be found, not edits or deletes.)')
  return out
}
