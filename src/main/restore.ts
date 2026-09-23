import { checkpoint, openDatabase } from './db'
import { parseCsv } from './import/csv'

/**
 * Rebuilding the database from a backup CSV.
 *
 * The backup is a whole-history snapshot, so restoring reproduces that history
 * rather than merging into what is already there - a half-restored database
 * would be worse than either state. The caller takes a fresh backup of the
 * current rows first, so choosing the wrong file is recoverable.
 */

/** The column order `buildCsv` writes. A file that disagrees is not ours. */
const EXPECTED = [
  'id',
  'session_date',
  'started_at',
  'ended_at',
  'planned_duration_s',
  'running_duration_s',
  'project',
  'tag',
  'task',
  'stop_reason',
  'stop_reason_note',
  'work_quantity',
  'work_unit',
  'unquantifiable',
  'notes',
  'pace_target_qty',
  'pace_target_interval_s',
  'source',
  'pauses'
]

export interface RestorePreview {
  ok: boolean
  problem: string | null
  rows: number
  hours: number
  firstDate: string
  lastDate: string
  projects: number
  /** What restoring would discard. */
  replaces: number
}

const text = (value: string | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

const num = (value: string | undefined): number | null => {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

interface Parsed {
  header: string[]
  body: string[][]
}

function read(csv: string): { parsed: Parsed | null; problem: string | null } {
  const table = parseCsv(csv).filter((row) => row.length > 1 || (row[0] ?? '').trim() !== '')
  if (table.length === 0) return { parsed: null, problem: 'the file is empty' }
  const header = table[0].map((h) => h.trim())
  const missing = EXPECTED.filter((column) => !header.includes(column))
  if (missing.length > 0) {
    return {
      parsed: null,
      problem: `this does not look like a Deep Work backup - it is missing ${missing.slice(0, 3).join(', ')}`
    }
  }
  return { parsed: { header, body: table.slice(1) }, problem: null }
}

function currentSessionCount(): number {
  const row = openDatabase().prepare('SELECT COUNT(*) AS n FROM sessions').get() as
    { n: number } | undefined
  return Number(row?.n ?? 0)
}

export function previewRestore(csv: string): RestorePreview {
  const empty: RestorePreview = {
    ok: false,
    problem: null,
    rows: 0,
    hours: 0,
    firstDate: '',
    lastDate: '',
    projects: 0,
    replaces: currentSessionCount()
  }
  const { parsed, problem } = read(csv)
  if (!parsed) return { ...empty, problem }

  const at = (row: string[], column: string): string | undefined =>
    row[parsed.header.indexOf(column)]
  const dates: string[] = []
  const projects = new Set<string>()
  let seconds = 0
  for (const row of parsed.body) {
    seconds += num(at(row, 'running_duration_s')) ?? 0
    const date = text(at(row, 'session_date'))
    if (date) dates.push(date)
    const project = text(at(row, 'project'))
    if (project) projects.add(project)
  }
  dates.sort()

  return {
    ...empty,
    ok: parsed.body.length > 0,
    problem: parsed.body.length === 0 ? 'the file has a header but no sessions' : null,
    rows: parsed.body.length,
    hours: seconds / 3600,
    firstDate: dates[0] ?? '',
    lastDate: dates[dates.length - 1] ?? '',
    projects: projects.size
  }
}

export interface RestoreResult {
  sessions: number
  projects: number
  pauses: number
  replaced: number
}

export function restoreFromCsv(csv: string): RestoreResult {
  const { parsed, problem } = read(csv)
  if (!parsed) throw new Error(problem ?? 'unreadable backup')

  const db = openDatabase()
  const at = (row: string[], column: string): string | undefined =>
    row[parsed.header.indexOf(column)]

  const replaced = currentSessionCount()
  db.exec('BEGIN')
  try {
    // Order matters: pauses reference sessions, sessions reference projects and
    // tags. Clearing children first avoids leaning on cascade behaviour.
    db.exec('DELETE FROM pauses')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM tags')
    db.exec('DELETE FROM projects')

    const findProject = db.prepare('SELECT id FROM projects WHERE name = ?')
    const addProject = db.prepare('INSERT INTO projects (name) VALUES (?)')
    const findTag = db.prepare('SELECT id FROM tags WHERE name = ? AND project_id IS ?')
    const addTag = db.prepare('INSERT INTO tags (name, project_id) VALUES (?, ?)')
    const addSession = db.prepare(
      `INSERT INTO sessions
         (id, project_id, tag_id, task, session_date, started_at, ended_at,
          planned_duration_s, running_duration_s, stop_reason, stop_reason_note,
          work_quantity, work_unit, unquantifiable, notes,
          pace_target_qty, pace_target_interval_s, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const addPause = db.prepare(
      'INSERT INTO pauses (session_id, paused_at, resumed_at) VALUES (?, ?, ?)'
    )

    const projectIds = new Map<string, number>()
    let pauseCount = 0

    for (const row of parsed.body) {
      const projectName = text(at(row, 'project'))
      let projectId: number | null = null
      if (projectName) {
        const cached = projectIds.get(projectName)
        if (cached !== undefined) projectId = cached
        else {
          const existing = findProject.get(projectName) as { id: number } | undefined
          projectId = existing
            ? Number(existing.id)
            : Number(addProject.run(projectName).lastInsertRowid)
          projectIds.set(projectName, projectId)
        }
      }

      const tagName = text(at(row, 'tag'))
      let tagId: number | null = null
      if (tagName) {
        const existing = findTag.get(tagName, projectId) as { id: number } | undefined
        tagId = existing
          ? Number(existing.id)
          : Number(addTag.run(tagName, projectId).lastInsertRowid)
      }

      // The id is kept so a restored database is the same database, not a copy
      // of it with everything renumbered.
      const id = num(at(row, 'id'))
      addSession.run(
        id,
        projectId,
        tagId,
        text(at(row, 'task')),
        text(at(row, 'session_date')),
        text(at(row, 'started_at')),
        text(at(row, 'ended_at')),
        num(at(row, 'planned_duration_s')) ?? 0,
        num(at(row, 'running_duration_s')) ?? 0,
        text(at(row, 'stop_reason')),
        text(at(row, 'stop_reason_note')),
        num(at(row, 'work_quantity')),
        text(at(row, 'work_unit')),
        num(at(row, 'unquantifiable')) ?? 0,
        text(at(row, 'notes')),
        num(at(row, 'pace_target_qty')),
        num(at(row, 'pace_target_interval_s')),
        text(at(row, 'source')) ?? 'import'
      )

      // `paused|resumed` pairs separated by semicolons; an open pause has an
      // empty resumed half.
      const packed = text(at(row, 'pauses'))
      if (packed && id !== null) {
        for (const pair of packed.split(';')) {
          const [pausedAt, resumedAt] = pair.split('|')
          if (!pausedAt || pausedAt.trim() === '') continue
          addPause.run(
            id,
            pausedAt.trim(),
            resumedAt && resumedAt.trim() !== '' ? resumedAt.trim() : null
          )
          pauseCount += 1
        }
      }
    }

    db.exec('COMMIT')
    checkpoint()
    return {
      sessions: parsed.body.length,
      projects: projectIds.size,
      pauses: pauseCount,
      replaced
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
