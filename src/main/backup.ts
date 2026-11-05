import { app, shell } from 'electron'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { openDatabase } from './db'
import { clearSetting, getSetting, setSetting } from './db/settings'

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
  /** False when the folder was chosen by hand, so the UI can offer a reset. */
  isDefault: boolean
  /** True when Documents is redirected into OneDrive and was stepped around. */
  avoidedOneDrive: boolean
  intervalDays: number
  kept: number
  backups: BackupFile[]
  /** Null when none has been taken yet, or when there is nothing to back up. */
  nextDue: string | null
  sessions: number
  /**
   * Why the schedule is currently refusing to write, or null when it is not.
   *
   * Surfaced rather than swallowed: a backup that has quietly stopped happening
   * is indistinguishable from one that is working until the day it is needed.
   */
  blocked: string | null
}

const DIRECTORY_KEY = 'backup.directory'

function isInside(child: string, parent: string): boolean {
  const a = resolve(child).toLowerCase()
  const b = resolve(parent).toLowerCase()
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * The roots of every OneDrive the shell knows about.
 *
 * Both variables are checked because a machine can have a personal OneDrive
 * and a work one at the same time, under different names.
 */
function oneDriveRoots(): string[] {
  return [
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
}

/**
 * Documents, unless Documents is really OneDrive.
 *
 * `app.getPath('documents')` resolves the Documents known folder, and with
 * OneDrive's Folder Backup switched on that folder is redirected into the
 * OneDrive tree - so the obvious call quietly puts a gigabyte of history into
 * cloud sync that nobody asked for. When the redirect is in force, the local
 * profile folder is used instead, which is the Documents the user meant.
 *
 * userData is not a candidate either way: the database already lives there, so
 * a copy beside it survives neither an uninstall nor a wiped profile, which
 * are the two cases a backup exists for.
 */
export function defaultBackupDirectory(): string {
  // The dev build keeps its backups with its own data, never in Documents.
  // Splitting the database but not the backups left a worse hole than before:
  // a dev run writes a snapshot of its throwaway rows into the real backup
  // folder, and with eight retention slots enough of them would push the real
  // history out. One such file - a single test session beside a 2,363-row
  // backup - was created this way before this was noticed.
  if (!app.isPackaged) return join(app.getPath('userData'), 'Backups')

  const documents = app.getPath('documents')
  const redirected = oneDriveRoots().some((root) => isInside(documents, root))
  const base = redirected ? join(app.getPath('home'), 'Documents') : documents
  return join(base, 'Deep Work Tracker', 'Backups')
}

export function backupDirectory(): string {
  return getSetting(DIRECTORY_KEY) ?? defaultBackupDirectory()
}

/**
 * Only future backups move. Files already written stay where they are - this
 * chooses a destination, it does not relocate a history that is the whole
 * point of having been written down.
 */
export function setBackupDirectory(directory: string | null): void {
  if (directory === null) clearSetting(DIRECTORY_KEY)
  else setSetting(DIRECTORY_KEY, directory)
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
  const all = listBackups()
  const stale = all.slice(BACKUPS_KEPT)

  // The largest backup is never evicted, whatever its age.
  //
  // `backupBlockedReason` already refuses to *write* a snapshot smaller than
  // the biggest retained one, which is the stronger guard and the one that
  // counts rows exactly. This is the second half of the same protection, and
  // it is deliberately a different mechanism: it covers the files already on
  // disk rather than the next write, so a snapshot that got through by force
  // still cannot push the real history out. Bytes rather than rows here
  // because this runs on every prune and must not read eight files or be able
  // to throw - the two checks failing independently is the point of having
  // both.
  //
  // Not hypothetical: on 2026-10-02 a 356-byte backup of three test rows sat
  // beside a 220 KB backup of 2,363 real sessions, and eight more of the
  // small kind would have binned the only copy of 3.5 years on a schedule,
  // with nothing on screen about it.
  const largest = all.reduce<BackupFile | null>(
    (best, file) => (best === null || file.bytes > best.bytes ? file : best),
    null
  )
  return largest === null ? stale : stale.filter((file) => file.path !== largest.path)
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

/**
 * Data rows in a backup CSV.
 *
 * Counts only the newlines that fall outside a quoted field, because `notes`
 * is free text and `field()` quotes anything containing a line break - so
 * splitting on newlines would count one session several times. Every line ends
 * in CRLF including the last, so the raw count includes the header row.
 */
const DOUBLE_QUOTE = 34
const LINE_FEED = 10
const CARRIAGE_RETURN = 13

export function countRows(csv: string): number {
  let lines = 0
  // Whether anything has been seen since the last line break. It is what makes
  // a file with no trailing newline count its final row, and what keeps a
  // blank line from counting as one.
  let pending = false
  let quoted = false

  for (let i = 0; i < csv.length; i += 1) {
    const code = csv.charCodeAt(i)
    if (quoted) {
      pending = true
      if (code === DOUBLE_QUOTE) {
        if (csv.charCodeAt(i + 1) === DOUBLE_QUOTE) i += 1
        else quoted = false
      }
      continue
    }
    if (code === DOUBLE_QUOTE) {
      quoted = true
      pending = true
    } else if (code === LINE_FEED) {
      if (pending) lines += 1
      pending = false
    } else if (code !== CARRIAGE_RETURN) {
      pending = true
    }
  }
  if (pending) lines += 1

  // The first line is the header.
  return Math.max(0, lines - 1)
}

/**
 * The *largest* retained backup, not the newest.
 *
 * Newest is the obvious choice and it is wrong. The junk snapshots this guard
 * exists to stop are themselves the newest files, so comparing against the
 * newest lets the second one through, and the third - each one only has to beat
 * the previous piece of junk. What has to be protected is the biggest real
 * snapshot in the retained set, because that is the one retention will
 * eventually push out.
 *
 * Only the kept files are considered: one already queued for the Recycle Bin
 * should not veto a backup.
 */
function largestBackup(): { file: BackupFile; rows: number } | null {
  let best: { file: BackupFile; rows: number } | null = null
  for (const file of listBackups().slice(0, BACKUPS_KEPT)) {
    let rows: number
    try {
      rows = countRows(readFileSync(file.path, 'utf8'))
    } catch {
      // An unreadable backup must not be able to stop the next one being taken.
      continue
    }
    if (best === null || rows > best.rows) best = { file, rows }
  }
  return best
}

export interface BackupOutcome {
  written: boolean
  file?: string
  rows?: number
  reason?: string
  /** Set when a scheduled backup was refused because the history shrank. */
  blocked?: boolean
}

/**
 * Why a backup can be refused, and why `rows === 0` was not enough.
 *
 * The original guard only declined to back up an *empty* database. On
 * 2026-11-05 the live database was found holding three throwaway rows where
 * 2,363 sessions had been, and three is not zero - so the schedule had been
 * writing ~360-byte snapshots of nothing every three and a half days, and with
 * eight retention slots seven more of them would have pushed the last real
 * backup into the Recycle Bin. The series would have recorded the loss and
 * then destroyed the evidence of it.
 *
 * So the test is comparative: never write a snapshot smaller than the largest
 * backup still being kept. Either the database has lost rows - in which case
 * that larger backup is the only copy and must not be crowded out - or they
 * were deleted deliberately, which is what `force` is for. Shrinking is rare
 * and losing data is not, so the refusal is the safe default.
 *
 * There is deliberately no fraction of tolerance. Half a history disappearing
 * is the case this exists to catch, not a case to wave through; a deliberate
 * deletion is one `force` away, and the user is the one who knows which it
 * was.
 *
 * It is returned rather than thrown, and carried in `backupStatus()`, because
 * a backup that has silently stopped happening looks exactly like one that is
 * working right up to the moment it is needed.
 */
export async function runBackup(options: { force?: boolean } = {}): Promise<BackupOutcome> {
  const rows = sessionCount()
  if (rows === 0) return { written: false, reason: 'there are no sessions to back up yet' }

  const refusal = options.force ? null : backupBlockedReason(rows)
  if (refusal !== null) return { written: false, reason: refusal, blocked: true }

  const directory = backupDirectory()
  mkdirSync(directory, { recursive: true })

  const { csv } = buildCsv()
  const file = join(directory, `deep-work-backup-${stamp()}.csv`)
  writeFileSync(file, csv, 'utf8')
  await prune()
  return { written: true, file, rows }
}

/**
 * The refusal above, as a sentence, so Settings can show the same words.
 * Null when nothing is wrong.
 */
export function backupBlockedReason(rows = sessionCount()): string | null {
  const largest = largestBackup()
  if (largest === null || rows >= largest.rows) return null
  return (
    `the database holds ${rows} session${rows === 1 ? '' : 's'} but ${largest.file.name} holds ` +
    `${largest.rows}. Refusing to write a smaller snapshot, because ${BACKUPS_KEPT} retention ` +
    `slots would push the larger one out. Restore from that backup, or force a backup if the ` +
    `rows were removed on purpose.`
  )
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
    isDefault: getSetting(DIRECTORY_KEY) === null,
    avoidedOneDrive: oneDriveRoots().some((root) => isInside(app.getPath('documents'), root)),
    intervalDays: BACKUP_INTERVAL_DAYS,
    kept: BACKUPS_KEPT,
    backups: listBackups(),
    nextDue: due === null ? null : new Date(due).toISOString(),
    sessions: sessionCount(),
    blocked: backupBlockedReason()
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
  // Each distinct reason once. The check runs every six hours, and repeating
  // the same line forever is how a log stops being read.
  const reported = new Set<string>()

  const check = (): void => {
    if (!isBackupDue()) return
    void runBackup()
      .then((outcome) => {
        if (outcome.written || !outcome.reason) return
        if (reported.has(outcome.reason)) return
        reported.add(outcome.reason)
        console.warn('Scheduled backup declined:', outcome.reason)
      })
      .catch((error) => {
        console.error('Scheduled backup failed:', error)
      })
  }

  // Not during launch: the first window should paint before the main process
  // starts walking the whole sessions table.
  setTimeout(check, 10_000)
  setInterval(check, CHECK_EVERY_MS)
}
