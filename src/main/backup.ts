import { app, shell } from 'electron'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from './db'

/**
 * Twice a week, expressed as an interval rather than as two named days.
 *
 * A "Monday and Thursday" schedule needs the app to be running on Monday and
 * Thursday. This one only needs it to be running at some point every few days,
 * which is how the app is actually used.
 */
export const BACKUP_INTERVAL_DAYS = 3.5
export const BACKUPS_KEPT = 8

const DAY_MS = 24 * 60 * 60 * 1000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FILE_PATTERN = /^deep-work-backup-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/

export interface BackupFile {
  name: string
  path: string
  bytes: number
  modified: string
}

export interface BackupStatus {
  directory: string
  intervalDays: number
  kept: number
  backups: BackupFile[]
  /** Null when none has been taken yet, or when there is nothing to back up. */
  nextDue: string | null
  sessions: number
}

/**
 * Backups live in Documents, not in userData.
 *
 * userData is where the database already is, so a copy beside it survives
 * neither an uninstall nor a wiped profile - the two cases a backup exists
 * for. Documents is also somewhere the file can be found without being told
 * where to look.
 */
export function backupDirectory(): string {
  return join(app.getPath('documents'), 'Deep Work Tracker', 'Backups')
}

const HEADER = [
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

/** Quote only when the value would otherwise change meaning. */
function field(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (!/[",\r\n]/.test(text) && text.trim() === text) return text
  return '"' + text.replace(/"/g, '""') + '"'
}

interface ExportRow {
  id: number
  session_date: string | null
  started_at: string | null
  ended_at: string | null
  planned_duration_s: number
  running_duration_s: number
  project: string | null
  tag: string | null
  task: string | null
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

/**
 * Everything needed to rebuild the database, as one file.
 *
 * Projects and tags are written as their names rather than their ids, because
 * ids only mean anything next to the tables that define them, and a backup
 * that needs three files to be restored is a backup with three ways to go
 * missing. Pauses are packed into a single column for the same reason -
 * `paused|resumed` pairs separated by semicolons - so `running_duration_s`
 * stays auditable against the intervals that produced it.
 */
export function buildCsv(): { csv: string; rows: number } {
  const db = openDatabase()

  const pauses = new Map<number, string[]>()
  const pauseRows = db
    .prepare('SELECT session_id, paused_at, resumed_at FROM pauses ORDER BY session_id, paused_at')
    .all() as unknown as Array<{
    session_id: number
    paused_at: string
    resumed_at: string | null
  }>
  for (const pause of pauseRows) {
    const list = pauses.get(pause.session_id) ?? []
    list.push(`${pause.paused_at}|${pause.resumed_at ?? ''}`)
    pauses.set(pause.session_id, list)
  }

  const rows = db
    .prepare(
      `SELECT s.id, s.session_date, s.started_at, s.ended_at,
              s.planned_duration_s, s.running_duration_s,
              p.name AS project, t.name AS tag, s.task,
              s.stop_reason, s.stop_reason_note,
              s.work_quantity, s.work_unit, s.unquantifiable, s.notes,
              s.pace_target_qty, s.pace_target_interval_s, s.source
         FROM sessions s
         LEFT JOIN projects p ON p.id = s.project_id
         LEFT JOIN tags t ON t.id = s.tag_id
        ORDER BY s.id`
    )
    .all() as unknown as ExportRow[]

  const lines = [HEADER.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.session_date,
        row.started_at,
        row.ended_at,
        row.planned_duration_s,
        row.running_duration_s,
        row.project,
        row.tag,
        row.task,
        row.stop_reason,
        row.stop_reason_note,
        row.work_quantity,
        row.work_unit,
        row.unquantifiable,
        row.notes,
        row.pace_target_qty,
        row.pace_target_interval_s,
        row.source,
        (pauses.get(row.id) ?? []).join(';')
      ]
        .map(field)
        .join(',')
    )
  }

  // A trailing newline, so appending or concatenating cannot join two rows.
  return { csv: lines.join('\r\n') + '\r\n', rows: rows.length }
}

function stamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  )
}

export function listBackups(): BackupFile[] {
  const directory = backupDirectory()
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  return (
    names
      .filter((name) => FILE_PATTERN.test(name))
      .map((name) => {
        const path = join(directory, name)
        const info = statSync(path)
        return { name, path, bytes: info.size, modified: info.mtime.toISOString() }
      })
      // By name, not by mtime: the name carries the moment the snapshot was
      // taken, while mtime is whatever the filesystem last did to the file.
      .sort((a, b) => b.name.localeCompare(a.name))
  )
}

/**
 * Older backups go to the Recycle Bin, not to unlink().
 *
 * Deleting a backup outright means a bug in the retention rule destroys data
 * silently. The bin holds them for 30 days, which is long enough to notice.
 */
export function staleBackups(): BackupFile[] {
  return listBackups().slice(BACKUPS_KEPT)
}

async function prune(): Promise<number> {
  const stale = staleBackups()
  let trashed = 0
  for (const file of stale) {
    try {
      await shell.trashItem(file.path)
      trashed += 1
    } catch {
      /* A locked or already-removed file is not worth failing the backup for. */
    }
  }
  return trashed
}

function sessionCount(): number {
  const row = openDatabase().prepare('SELECT COUNT(*) AS n FROM sessions').get() as
    { n: number } | undefined
  return Number(row?.n ?? 0)
}

export interface BackupOutcome {
  written: boolean
  file?: string
  rows?: number
  reason?: string
}

/**
 * An empty database is not backed up.
 *
 * Eight slots at three and a half days is a month of history. Filling one with
 * a snapshot of nothing pushes a real one out and protects nothing.
 */
export async function runBackup(): Promise<BackupOutcome> {
  const rows = sessionCount()
  if (rows === 0) return { written: false, reason: 'there are no sessions to back up yet' }

  const directory = backupDirectory()
  mkdirSync(directory, { recursive: true })

  const { csv } = buildCsv()
  const file = join(directory, `deep-work-backup-${stamp()}.csv`)
  writeFileSync(file, csv, 'utf8')
  await prune()
  return { written: true, file, rows }
}

function dueAt(): number | null {
  const [newest] = listBackups()
  if (!newest) return null
  return new Date(newest.modified).getTime() + BACKUP_INTERVAL_DAYS * DAY_MS
}

/** No backups yet counts as due, so the first launch takes one. */
export function isBackupDue(now = Date.now()): boolean {
  const due = dueAt()
  return due === null || now >= due
}

export function backupStatus(): BackupStatus {
  const due = dueAt()
  return {
    directory: backupDirectory(),
    intervalDays: BACKUP_INTERVAL_DAYS,
    kept: BACKUPS_KEPT,
    backups: listBackups(),
    nextDue: due === null ? null : new Date(due).toISOString(),
    sessions: sessionCount()
  }
}

export async function revealBackups(): Promise<void> {
  const directory = backupDirectory()
  mkdirSync(directory, { recursive: true })
  await shell.openPath(directory)
}

/**
 * Checked on a timer rather than scheduled for a moment.
 *
 * The app is closed more often than it is open, so a backup scheduled for a
 * particular time is a backup that mostly never happens. Asking "is one due?"
 * at launch and every few hours catches up whenever the app is next running,
 * and the answer comes from the files on disk rather than from remembered
 * state that can drift out of step with them.
 */
export function startBackupSchedule(): void {
  const check = (): void => {
    if (!isBackupDue()) return
    void runBackup().catch((error) => {
      console.error('Scheduled backup failed:', error)
    })
  }

  // Not during launch: the first window should paint before the main process
  // starts walking the whole sessions table.
  setTimeout(check, 10_000)
  setInterval(check, CHECK_EVERY_MS)
}
