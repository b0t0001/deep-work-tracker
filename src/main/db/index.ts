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

export function closeDatabase(): void {
  db?.close()
  db = null
}
