/**
 * Schema migrations, applied in order at startup and recorded in
 * `schema_migrations`. Never edit one that has already run - add a new entry.
 */
export interface Migration {
  id: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE projects (
        id       INTEGER PRIMARY KEY,
        name     TEXT NOT NULL UNIQUE,
        color    TEXT,
        archived INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE tags (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        UNIQUE (name, project_id)
      );

      CREATE TABLE presets (
        id              INTEGER PRIMARY KEY,
        name            TEXT,
        duration_s      INTEGER,
        pace_interval_s INTEGER
      );

      -- One row per timer run. started_at/ended_at are null for imported rows,
      -- whose countdown readings cannot be converted to clock times.
      CREATE TABLE sessions (
        id                     INTEGER PRIMARY KEY,
        project_id             INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        tag_id                 INTEGER REFERENCES tags(id) ON DELETE SET NULL,
        task                   TEXT,
        started_at             TEXT,
        ended_at               TEXT,
        planned_duration_s     INTEGER NOT NULL,
        running_duration_s     INTEGER NOT NULL,
        stop_reason            TEXT,
        stop_reason_note       TEXT,
        work_quantity          REAL,
        work_unit              TEXT,
        unquantifiable         INTEGER NOT NULL DEFAULT 0,
        notes                  TEXT,
        pace_target_qty        REAL,
        pace_target_interval_s INTEGER,
        source                 TEXT NOT NULL DEFAULT 'app'
                               CHECK (source IN ('app', 'manual', 'import'))
      );

      CREATE INDEX idx_sessions_started_at ON sessions (started_at);
      CREATE INDEX idx_sessions_project    ON sessions (project_id);

      -- Makes running_duration_s auditable rather than a number nobody can check.
      CREATE TABLE pauses (
        id         INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        paused_at  TEXT NOT NULL,
        resumed_at TEXT
      );

      CREATE INDEX idx_pauses_session ON pauses (session_id);
    `
  },
  {
    id: 2,
    name: 'session_date for day-level analytics',
    sql: `
      -- Imported rows know their calendar date but not their time of day, so
      -- started_at stays null while the date remains usable for trends.
      ALTER TABLE sessions ADD COLUMN session_date TEXT;
      CREATE INDEX idx_sessions_date ON sessions (session_date);
    `
  }
]
