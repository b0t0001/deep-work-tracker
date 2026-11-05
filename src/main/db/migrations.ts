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
  },
  {
    id: 3,
    name: 'app_settings for choices that must survive a restart',
    sql: `
      -- App settings have lived in a plain object in the main process, which
      -- means every one of them resets when the app closes. That is tolerable
      -- for the loop toggle; it is not tolerable for a backup folder, where
      -- forgetting the choice sends the next backup somewhere else entirely.
      CREATE TABLE app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    id: 4,
    name: "source 'test' for rows written while testing",
    sql: `
      -- SQLite cannot alter a CHECK constraint, so allowing a fourth source
      -- means rebuilding the table. This is 3.5 years of real history, so
      -- every step below is about what could silently go missing.
      --
      -- Pauses first, and not by renaming. The connection runs with
      -- foreign_keys = ON, and that cannot be switched off from inside the
      -- transaction this runs in - SQLite ignores the pragma there. With it
      -- on, DROP TABLE sessions performs an implicit DELETE FROM sessions, and
      -- ON DELETE CASCADE would take every pause with it. Renaming pauses does
      -- not help either: its foreign key would still point at sessions. So the
      -- pauses are held in a temp table with no constraints at all, pauses is
      -- dropped, and nothing references sessions by the time it goes.
      CREATE TEMP TABLE pauses_keep AS SELECT id, session_id, paused_at, resumed_at FROM pauses;
      DROP TABLE pauses;

      -- Same columns in the same order as migrations 1 and 2 left them, so
      -- SELECT * and anything positional read exactly what they read before.
      CREATE TABLE sessions_new (
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
                               CHECK (source IN ('app', 'manual', 'import', 'test')),
        session_date           TEXT
      );

      -- Ids copied, not renumbered: the history stack, backups and restores
      -- all refer to rows by id.
      INSERT INTO sessions_new
        (id, project_id, tag_id, task, started_at, ended_at,
         planned_duration_s, running_duration_s, stop_reason, stop_reason_note,
         work_quantity, work_unit, unquantifiable, notes,
         pace_target_qty, pace_target_interval_s, source, session_date)
      SELECT
         id, project_id, tag_id, task, started_at, ended_at,
         planned_duration_s, running_duration_s, stop_reason, stop_reason_note,
         work_quantity, work_unit, unquantifiable, notes,
         pace_target_qty, pace_target_interval_s, source, session_date
        FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;

      CREATE INDEX idx_sessions_started_at ON sessions (started_at);
      CREATE INDEX idx_sessions_project    ON sessions (project_id);
      CREATE INDEX idx_sessions_date       ON sessions (session_date);

      CREATE TABLE pauses (
        id         INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        paused_at  TEXT NOT NULL,
        resumed_at TEXT
      );
      INSERT INTO pauses (id, session_id, paused_at, resumed_at)
        SELECT id, session_id, paused_at, resumed_at FROM pauses_keep;
      CREATE INDEX idx_pauses_session ON pauses (session_id);

      DROP TABLE pauses_keep;
    `
  }
]
