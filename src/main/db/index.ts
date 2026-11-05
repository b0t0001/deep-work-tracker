import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { join } from 'node:path'
import { MIGRATIONS, type Migration } from './migrations'
import { mkdirSync } from 'node:fs'

let db: DatabaseSync | null = null

/**
 * The database lives in userData, not the project folder: the project folder is
 * code and syncs to GitHub, and session data should never leave the machine.
 */
export function databasePath(): string {
  return join(app.getPath('userData'), 'deepwork.db')
}

export function openDatabase(): DatabaseSync {
  if (db) return db

  db = new DatabaseSync(databasePath())
  // WAL survives a crash mid-write far better than the rollback journal, and
  // foreign keys are off by default in SQLite, which would silently orphan pauses.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // Without this the default is zero: a write while any other connection holds
  // the lock fails instantly with `database is locked` rather than waiting.
  // Two copies of the app - the installed one and a `npm run dev`, say - then
  // throw on every session they try to record, and the throw lands in an event
  // handler where Electron turns it into a crash dialog. Verified across two
  // real processes: without it the second writer threw immediately; with it the
  // write waited 1,087 ms for the lock and succeeded.
  db.exec('PRAGMA busy_timeout = 5000')
  // A migration can rewrite every row - migration 4 rebuilds the whole
  // sessions table - and committed is not the same as safe: until a checkpoint
  // the rebuilt table lives only in the -wal. Same rule as every other write.
  if (migrate(db) > 0) checkpoint()
  return db
}

/**
 * A whole copy of the database, taken before any schema change touches it.
 *
 * Each migration is one transaction, so a migration that *fails* leaves
 * nothing behind. That does not cover one that succeeds and is wrong - and
 * migration 4's first draft was exactly that: it rebuilt `sessions`, committed
 * cleanly, passed `quick_check` and `foreign_key_check`, and had silently
 * cascaded every pause away. Only a check written to look for it noticed.
 * A test cannot cover the user's real file before it is run on it, so the
 * real file is copied first.
 *
 * `VACUUM INTO` rather than a file copy: it reads through the connection, so
 * it includes rows still in the `-wal`, and the result is one self-contained
 * file. Skipped for a fresh database, where there is nothing to lose. If the
 * copy cannot be made, the migration does not run - an app that refuses to
 * open is recoverable, a history altered without a copy may not be.
 */
function snapshotBeforeMigrating(connection: DatabaseSync, pending: Migration[]): void {
  const hasHistory = connection
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get()
  if (!hasHistory) return
  const rows = connection.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
  if (Number(rows.n) === 0) return

  const dir = join(app.getPath('userData'), 'pre-migration')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14)
  const ids = pending.map((m) => m.id).join('-')
  const target = join(dir, `deepwork-before-migration-${ids}-${stamp}.db`)
  // VACUUM INTO refuses an existing file, so a name collision fails loudly
  // rather than overwriting an earlier snapshot.
  connection.prepare('VACUUM INTO ?').run(target)
}

/** Applies what has not run yet, and says how many that was. */
function migrate(connection: DatabaseSync): number {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  const applied = new Set(
    connection
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => Number((row as { id: number }).id))
  )

  const pending = MIGRATIONS.filter((m) => !applied.has(m.id))
  if (pending.length > 0) snapshotBeforeMigrating(connection, pending)

  let count = 0
  for (const migration of pending) {
    // Each migration is one transaction: a failure leaves the schema untouched
    // rather than half-applied, which is unrecoverable without a backup.
    connection.exec('BEGIN')
    try {
      connection.exec(migration.sql)
      connection
        .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.id, migration.name, new Date().toISOString())
      connection.exec('COMMIT')
      count += 1
    } catch (error) {
      connection.exec('ROLLBACK')
      throw new Error(`Migration ${migration.id} (${migration.name}) failed: ${String(error)}`)
    }
  }
  return count
}

/**
 * Forces the write-ahead log into the database file.
 *
 * In WAL mode a committed row lives in `deepwork.db-wal` until a checkpoint
 * copies it across. That is normally invisible - SQLite reads both files as
 * one, and checkpoints on the last clean close. But if the `-wal` is ever
 * separated from the `.db` while nothing is running, the database opens fine
 * and is simply missing everything since the last checkpoint: no error, no
 * corruption, just rows that are gone. That is the shape of the loss seen on
 * 2026-09-23, where the main file had never grown past an empty schema while a
 * backup proved 2,363 rows had existed.
 *
 * So anything that writes rows worth keeping calls this immediately after
 * committing. It costs milliseconds and removes the window entirely. TRUNCATE
 * rather than PASSIVE because the point is to leave nothing behind; a reader
 * can refuse it, which is why it is allowed to fail quietly - the next write
 * will try again, and a clean close still checkpoints.
 */
export function checkpoint(): void {
  try {
    db?.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* a concurrent reader can block it; the next attempt or a clean close wins */
  }
}

/**
 * Whether the file is readable, checked once at startup.
 *
 * `quick_check` is the cheap half of `integrity_check` - it verifies page
 * structure and indexes without the full cross-reference - and it is run once
 * rather than on every open so a large history does not pay for it repeatedly.
 * A database that fails this will throw `database disk image is malformed`
 * from whichever query happens to touch the damaged page first, which reads
 * like a bug in that query rather than a damaged file.
 */
export function healthCheck(): string | null {
  try {
    const rows = openDatabase().prepare('PRAGMA quick_check').all() as Array<{
      quick_check: string
    }>
    const first = rows[0]?.quick_check ?? 'no result'
    return first === 'ok' ? null : first
  } catch (error) {
    return String(error)
  }
}

let pendingCheckpoint: NodeJS.Timeout | null = null

/**
 * A checkpoint for writes that arrive in bursts, coalesced into one.
 *
 * `checkpoint()` takes an exclusive lock, so calling it on every write is the
 * wrong shape for the writes that are not one-shot: work quantity is written
 * as the user types it, and an edit in the Data tab is a field at a time. A
 * TRUNCATE per keystroke would thrash the lock for no benefit, since what
 * matters is that the rows are in the `.db` shortly after the user stops, not
 * within a millisecond of each one.
 *
 * The window this leaves open is the delay below - a kill inside it can still
 * strand those frames. That is a far smaller window than the one it closes,
 * which was unbounded: before this, work quantity, stop reasons, manual
 * sessions, every edit, undo, and the backup directory could sit in the `-wal`
 * indefinitely, and the session row they belonged to had already been
 * checkpointed without them.
 */
export function checkpointSoon(delayMs = 1500): void {
  if (pendingCheckpoint) clearTimeout(pendingCheckpoint)
  pendingCheckpoint = setTimeout(() => {
    pendingCheckpoint = null
    checkpoint()
  }, delayMs)
  // Never a reason to hold the process open; a clean close checkpoints anyway.
  pendingCheckpoint.unref?.()
}

export function closeDatabase(): void {
  if (pendingCheckpoint) {
    clearTimeout(pendingCheckpoint)
    pendingCheckpoint = null
    checkpoint()
  }
  db?.close()
  db = null
}
