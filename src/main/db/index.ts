import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { join } from 'node:path'
import { MIGRATIONS } from './migrations'

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
  migrate(db)
  return db
}

function migrate(connection: DatabaseSync): void {
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

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue
    // Each migration is one transaction: a failure leaves the schema untouched
    // rather than half-applied, which is unrecoverable without a backup.
    connection.exec('BEGIN')
    try {
      connection.exec(migration.sql)
      connection
        .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.id, migration.name, new Date().toISOString())
      connection.exec('COMMIT')
    } catch (error) {
      connection.exec('ROLLBACK')
      throw new Error(`Migration ${migration.id} (${migration.name}) failed: ${String(error)}`)
    }
  }
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

export function closeDatabase(): void {
  db?.close()
  db = null
}
