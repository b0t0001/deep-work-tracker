/**
 * Proves migration 4 - the `test` source - on a copy of the real history, and
 * that everything downstream of it treats `test` rows as test rows.
 *
 * Run (never against the real profile - pass a COPY, and point DWT_USERDATA at
 * a throwaway folder; the script copies the database in and works only there):
 *
 *   DWT_USERDATA=<tmp> npx esbuild scripts/source-test-check.ts --bundle \
 *     --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --external:node:sqlite --outfile=<tmp>/s.mjs && node <tmp>/s.mjs <copy>/deepwork.db
 *
 * The migration rebuilds `sessions`, because SQLite cannot alter a CHECK
 * constraint. That is the one change in this app that touches every row of
 * 3.5 years of history at once, so "it ran" is not the bar. The bar is that
 * the table afterwards is the same table: same rows, byte for byte, same ids,
 * same pauses, same indexes, and the pause cascade still wired to it.
 *
 * Pauses are the trap. The connection runs with foreign_keys ON, which cannot
 * be turned off inside the migration's transaction, and DROP TABLE sessions
 * then deletes every row first - cascading into pauses. The check below that
 * catches it is the pause hash, not the count of sessions.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { closeDatabase, databasePath, openDatabase } from '../src/main/db'
import { MIGRATIONS } from '../src/main/db/migrations'
import {
  insertSession,
  lastProjectName,
  querySessions,
  recordSession
} from '../src/main/db/sessions'
import { createSession } from '../src/main/db/history'
import { analytics } from '../src/main/db/analytics'
import { buildCsv } from '../src/main/backup'
import { restoreFromCsv } from '../src/main/restore'
import type { TimerSnapshot } from '../src/shared/timer'

const source = process.argv[2]
const root = process.env.DWT_USERDATA
if (!source) throw new Error('pass the path of a COPY of deepwork.db')
if (!root) throw new Error('set DWT_USERDATA to a throwaway directory')

// Both the input and the working folder are refused if they are a real
// profile. The input because it should already be a copy - opening the live
// file is how `database is locked` and `malformed` both arrived - and the
// working folder because this script writes test rows and runs a restore.
const roaming = process.env.APPDATA ? resolve(process.env.APPDATA).toLowerCase() : null
for (const [label, path] of [
  ['input', source],
  ['DWT_USERDATA', root]
] as const) {
  const full = resolve(path).toLowerCase()
  if (roaming && full.startsWith(join(roaming, 'deep-work-tracker'))) {
    throw new Error(`${label} is inside a real profile (${path}); copy it out first`)
  }
}

mkdirSync(root, { recursive: true })
for (const suffix of ['', '-wal', '-shm']) {
  const target = join(root, 'deepwork.db' + suffix)
  rmSync(target, { force: true })
  // The -wal travels with the .db or the copy is a stale file. See AGENTS.md.
  if (existsSync(source + suffix)) copyFileSync(source + suffix, target)
}

let pass = 0
let fail = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok)
    console.log(
      '        expected ' + JSON.stringify(expected) + '  actual ' + JSON.stringify(actual)
    )
}

const COLUMNS = [
  'id',
  'project_id',
  'tag_id',
  'task',
  'started_at',
  'ended_at',
  'planned_duration_s',
  'running_duration_s',
  'stop_reason',
  'stop_reason_note',
  'work_quantity',
  'work_unit',
  'unquantifiable',
  'notes',
  'pace_target_qty',
  'pace_target_interval_s',
  'source',
  'session_date'
]

interface Shape {
  sessions: number
  pauses: number
  runningSeconds: number
  maxId: number
  quickCheck: string
  foreignKeyProblems: number
  bySource: Record<string, number>
  sessionsHash: string
  pausesHash: string
  columns: string[]
  indexes: string[]
}

function hash(rows: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)
}

function shape(db: DatabaseSync): Shape {
  const one = (sql: string): Record<string, unknown> =>
    db.prepare(sql).get() as Record<string, unknown>
  const bySource: Record<string, number> = {}
  for (const row of db
    .prepare('SELECT source, COUNT(*) AS n FROM sessions GROUP BY source ORDER BY source')
    .all() as Array<{ source: string; n: number }>) {
    bySource[row.source] = Number(row.n)
  }
  return {
    sessions: Number(one('SELECT COUNT(*) AS n FROM sessions').n),
    pauses: Number(one('SELECT COUNT(*) AS n FROM pauses').n),
    runningSeconds: Number(one('SELECT COALESCE(SUM(running_duration_s), 0) AS t FROM sessions').t),
    maxId: Number(one('SELECT COALESCE(MAX(id), 0) AS m FROM sessions').m),
    quickCheck: String(one('PRAGMA quick_check').quick_check),
    foreignKeyProblems: db.prepare('PRAGMA foreign_key_check').all().length,
    bySource,
    // Every column of every row, by id - a count can survive a rebuild that
    // shifted a value into the wrong column; a hash cannot.
    sessionsHash: hash(db.prepare(`SELECT ${COLUMNS.join(', ')} FROM sessions ORDER BY id`).all()),
    pausesHash: hash(
      db.prepare('SELECT id, session_id, paused_at, resumed_at FROM pauses ORDER BY id').all()
    ),
    columns: (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
      (c) => c.name
    ),
    indexes: (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
  }
}

function applied(db: DatabaseSync): number[] {
  return (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{
      id: number
    }>
  ).map((r) => Number(r.id))
}

// ------------------------------------------------------------------ before --

const raw = new DatabaseSync(databasePath())
const before = shape(raw)
const migrationsBefore = applied(raw)
raw.close()

console.log('--- before ---')
console.log(JSON.stringify(before))
console.log('migrations applied: ' + migrationsBefore.join(','))
check('the copy is not already migrated', migrationsBefore.includes(4), false)
check('the copy starts healthy', before.quickCheck, 'ok')
check('the copy has no orphaned pauses', before.foreignKeyProblems, 0)

// ----------------------------------------------------------------- migrate --

const db = openDatabase()
const after = shape(db)
console.log('')
console.log('--- after migration 4 ---')
console.log(JSON.stringify(after))

check('migration 4 is recorded', applied(db).includes(4), true)
check('session count unchanged', after.sessions, before.sessions)
check('pause count unchanged', after.pauses, before.pauses)
check('SUM(running_duration_s) unchanged', after.runningSeconds, before.runningSeconds)
check('max id unchanged', after.maxId, before.maxId)
check('per-source counts unchanged', after.bySource, before.bySource)
check('every session column of every row unchanged', after.sessionsHash, before.sessionsHash)
check('every pause unchanged, ids included', after.pausesHash, before.pausesHash)
check('column order unchanged', after.columns, before.columns)
check('indexes unchanged', after.indexes, before.indexes)
check('quick_check ok', after.quickCheck, 'ok')
check('foreign_key_check clean', after.foreignKeyProblems, 0)
check(
  'no scaffolding left behind',
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('sessions_new') UNION SELECT name FROM sqlite_temp_master WHERE name = 'pauses_keep'"
    )
    .all().length,
  0
)

const fk = db.prepare('PRAGMA foreign_key_list(pauses)').all() as Array<{
  table: string
  on_delete: string
}>
check(
  'pauses still cascade from sessions',
  fk.map((f) => `${f.table}:${f.on_delete}`),
  ['sessions:CASCADE']
)

// The cascade itself, not just its declaration, inside a transaction that is
// rolled back so the copy is left as the migration made it.
const withPauses = db
  .prepare('SELECT session_id AS id, COUNT(*) AS n FROM pauses GROUP BY session_id LIMIT 1')
  .get() as { id: number; n: number } | undefined
if (withPauses) {
  db.exec('BEGIN')
  db.prepare('DELETE FROM sessions WHERE id = ?').run(withPauses.id)
  const left = db
    .prepare('SELECT COUNT(*) AS n FROM pauses WHERE session_id = ?')
    .get(withPauses.id) as { n: number }
  db.exec('ROLLBACK')
  check('deleting a session still takes its pauses', Number(left.n), 0)
} else {
  console.log('SKIP  cascade - the copy has no pauses to delete')
}

// Committed is not the same as safe: the .db alone, without its -wal, must
// already carry the rebuilt table.
const orphan = join(root, 'without-wal.db')
copyFileSync(databasePath(), orphan)
const alone = new DatabaseSync(orphan, { readOnly: true })
check('the .db alone has migration 4 (checkpointed)', applied(alone).includes(4), true)
check(
  'the .db alone accepts test (the new CHECK)',
  String(
    (
      alone.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get() as {
        sql: string
      }
    ).sql
  ).includes("'test'"),
  true
)
check('the .db alone has every row', shape(alone).sessionsHash, before.sessionsHash)
alone.close()

closeDatabase()
openDatabase()
check(
  'reopening applies nothing twice',
  applied(openDatabase()),
  [...MIGRATIONS.map((m) => m.id)].sort((a, b) => a - b)
)

// ---------------------------------------------------------- the constraint --

let rejected = false
try {
  insertSession({ planned_duration_s: 60, running_duration_s: 60, source: 'bogus' })
} catch {
  rejected = true
}
check('an unknown source is still refused', rejected, true)

// ----------------------------------------------------------------- writers --

const analyticsBefore = analytics()
const now = Date.now()
const snapshot: TimerSnapshot = {
  status: 'running',
  plannedMs: 25 * 60_000,
  bankedRunningMs: 5_000,
  segmentStartedAt: null,
  startedAt: now - 9_000,
  pauseCount: 1,
  pauses: [{ pausedAt: now - 4_000, resumedAt: now - 1_000 }],
  task: 'source-test-check',
  project: 'Source Test Check'
}

check('the stub is an unpackaged build', app.isPackaged, false)
const timedId = recordSession(snapshot, null)
const manualId = createSession(
  { session_date: '2026-11-05', planned_duration_s: 60, running_duration_s: 60, source: 'manual' },
  'add session'
)
const sourceOf = (id: number | null): unknown =>
  (
    openDatabase().prepare('SELECT source FROM sessions WHERE id = ?').get(id) as {
      source: string
    }
  )?.source
check('unpackaged: a timed run is recorded as test', sourceOf(timedId), 'test')
check('unpackaged: a manual entry is recorded as test', sourceOf(manualId), 'test')
check(
  'unpackaged: the next run defaults to the test run project',
  lastProjectName(),
  'Source Test Check'
)

const testPage = querySessions({ source: 'test' })
check('the Test filter finds exactly the test rows', testPage.total, 2)
check(
  'the Test filter returns only test rows',
  [...new Set(testPage.rows.map((r) => r.source))],
  ['test']
)
check('no filter shows them alongside the rest', querySessions({}).total, before.sessions + 2)

const analyticsAfter = analytics()
check(
  'analytics: total sessions ignore test rows',
  analyticsAfter.totalSessions,
  analyticsBefore.totalSessions
)
check(
  'analytics: total hours ignore test rows',
  analyticsAfter.totalHours,
  analyticsBefore.totalHours
)
check(
  'analytics: daily series ignores test rows',
  hash(analyticsAfter.daily),
  hash(analyticsBefore.daily)
)
check(
  'analytics: no project bucket is made of test rows',
  analyticsAfter.byProject.some((p) => p.name === 'Source Test Check'),
  false
)
check(
  'analytics: longest session unchanged',
  analyticsAfter.longestSession,
  analyticsBefore.longestSession
)

// ------------------------------------------------------ backup and restore --

const { csv } = buildCsv()
const header = csv.split(/\r?\n/)[0].split(',')
const sourceColumn = header.indexOf('source')
const csvTest = csv
  .split(/\r?\n/)
  .slice(1)
  .filter((line) => line.split(',')[sourceColumn] === 'test').length
check('the backup CSV carries both test rows as test', csvTest, 2)

const beforeRestore = shape(openDatabase())
const restored = restoreFromCsv(csv)
const afterRestore = shape(openDatabase())
check('restore: every row back', restored.sessions, beforeRestore.sessions)
check(
  'restore: per-source counts identical, test included',
  afterRestore.bySource,
  beforeRestore.bySource
)
check('restore: test rows were not laundered into app', sourceOf(timedId), 'test')
check(
  'restore: SUM(running_duration_s) identical',
  afterRestore.runningSeconds,
  beforeRestore.runningSeconds
)
check('restore: max id identical', afterRestore.maxId, beforeRestore.maxId)
check('restore: pauses identical', afterRestore.pauses, beforeRestore.pauses)

// -------------------------------------------------------- packaged builds --

// The stub's `app` is a plain object, so this is the same flag the real
// module reads. The packaged path must be exactly what it was before.
;(app as { isPackaged: boolean }).isPackaged = true
check(
  'packaged: the default project never comes from a test row',
  lastProjectName() === 'Source Test Check',
  false
)
const packagedTimed = recordSession({ ...snapshot, startedAt: Date.now() - 9_000 }, null)
const packagedManual = createSession(
  { session_date: '2026-11-05', planned_duration_s: 60, running_duration_s: 60, source: 'manual' },
  'add session'
)
check('packaged: a timed run is still app', sourceOf(packagedTimed), 'app')
check('packaged: a manual entry is still manual', sourceOf(packagedManual), 'manual')
;(app as { isPackaged: boolean }).isPackaged = false

closeDatabase()

console.log('')
console.log('--- numbers for the commit ---')
console.log(
  `sessions ${before.sessions} -> ${after.sessions}, pauses ${before.pauses} -> ${after.pauses}, ` +
    `SUM(running_duration_s) ${before.runningSeconds} -> ${after.runningSeconds}, ` +
    `max id ${before.maxId} -> ${after.maxId}, quick_check ${before.quickCheck} -> ${after.quickCheck}, ` +
    `foreign_key_check ${before.foreignKeyProblems} -> ${after.foreignKeyProblems} problems, ` +
    `row hash ${before.sessionsHash} -> ${after.sessionsHash}, pause hash ${before.pausesHash} -> ${after.pausesHash}`
)
console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
