/**
 * Checks that a backup and a restore together are the identity: what comes
 * back is exactly what went out, down to project names, hidden flags, empty
 * projects, settings and the spaces in a task.
 *
 * Run:
 *   DWT_USERDATA=<tmp> npx esbuild scripts/backup-fidelity-check.ts --bundle \
 *     --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --external:node:sqlite --outfile=<tmp>/f.mjs && node <tmp>/f.mjs
 *
 * Written 11/16/2026 after a restore / back up / restore round trip in the
 * preview passed while six ways to lose or alter data were still open - the
 * round trip compared analytics, and none of these show in analytics:
 *
 * 1. a restore renamed or merged projects: "Gen 2" became "Gen", "Tutor" became "Job";
 * 2. a hidden project came back unhidden, and one with no sessions not at all;
 * 3. Undo after a restore replayed steps against a database that was gone;
 * 4. a backup cut short mid-write had a real backup's name;
 * 5. a restore trimmed the spaces off free text;
 * 6. the app's settings were in no backup.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildCsv, countRows, runBackup } from '../src/main/backup'
import { restoreFromCsv } from '../src/main/restore'
import { openDatabase } from '../src/main/db'
import { clearHistory, createSession, historyState } from '../src/main/db/history'

const root = process.env.DWT_USERDATA
if (!root) throw new Error('set DWT_USERDATA to a throwaway directory')

let pass = 0
let fail = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) {
    console.log('        expected ' + JSON.stringify(expected).slice(0, 400))
    console.log('        actual   ' + JSON.stringify(actual).slice(0, 400))
  }
}

const LF = String.fromCharCode(10)
const db = openDatabase()

// ---------------------------------------------------------------- fixture --
db.exec('DELETE FROM pauses; DELETE FROM sessions; DELETE FROM tags; DELETE FROM projects')
db.exec('DELETE FROM app_settings')
const project = (name: string, archived = 0, color: string | null = null): number =>
  Number(
    db
      .prepare('INSERT INTO projects (name, archived, color) VALUES (?, ?, ?)')
      .run(name, archived, color).lastInsertRowid
  )
const hw = project('HW', 0, '#d92b4b')
const gen = project('Gen 2')
const tutor = project('Tutor')
const sprocket = project('Sprocket', 1)
project('Entre')
const session = db.prepare(
  `INSERT INTO sessions (project_id, task, session_date, started_at, ended_at,
     planned_duration_s, running_duration_s, work_quantity, work_unit, unquantifiable,
     notes, source, laps, stop_reason, stop_reason_note)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
)
const s1 = Number(
  session.run(
    hw,
    '  spaced task  ',
    '2026-11-01',
    '2026-11-01T15:00:00.000Z',
    '2026-11-01T16:00:00.000Z',
    3600,
    3000,
    12.5,
    'questions',
    'said "hi", then' + LF + 'left',
    'app',
    2,
    'other',
    ' a reason '
  ).lastInsertRowid
)
session.run(
  gen,
  'Gen work',
  '2026-11-02',
  null,
  null,
  1800,
  1800,
  null,
  null,
  null,
  'manual',
  1,
  null,
  null
)
session.run(
  tutor,
  'Tutor Jo',
  '2026-11-03',
  null,
  null,
  5400,
  5400,
  null,
  null,
  null,
  'import',
  1,
  null,
  null
)
session.run(
  sprocket,
  'CAD',
  '2026-11-04',
  null,
  null,
  3600,
  2000,
  5,
  'components',
  null,
  'import',
  1,
  'tired',
  null
)
session.run(
  null,
  'unlabelled',
  '2026-11-05',
  null,
  null,
  600,
  600,
  null,
  null,
  null,
  'test',
  1,
  null,
  null
)
db.prepare('INSERT INTO pauses (session_id, paused_at, resumed_at) VALUES (?, ?, ?)').run(
  s1,
  '2026-11-01T15:20:00.000Z',
  '2026-11-01T15:30:00.000Z'
)
const setting = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
setting.run('analytics.layout', JSON.stringify({ order: ['a', 'b'], ranges: { hours: '1y' } }))
setting.run('timers.saved', '[]')
setting.run('backup.directory', 'D:\\somewhere\\only\\here')

function dump(): unknown {
  return {
    projects: db.prepare('SELECT name, archived, color FROM projects ORDER BY name').all(),
    sessions: db
      .prepare(
        `SELECT s.id, p.name AS project, s.task, s.session_date, s.started_at, s.ended_at,
                s.planned_duration_s, s.running_duration_s, s.work_quantity, s.work_unit,
                s.unquantifiable, s.notes, s.source, s.laps, s.stop_reason, s.stop_reason_note
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.id`
      )
      .all(),
    pauses: db.prepare('SELECT session_id, paused_at, resumed_at FROM pauses ORDER BY 1, 2').all(),
    settings: db
      .prepare("SELECT key, value FROM app_settings WHERE key <> 'backup.directory' ORDER BY key")
      .all()
  }
}

// ------------------------------------------------------------- round trip --
console.log('--- a backup and a restore are the identity ---')
const before = dump()
const { csv, rows } = buildCsv()
check('the guard counts sessions, not the sections after them', countRows(csv), rows)
check('and that is every session', rows, 5)
check('the backup folder is not in the backup', csv.includes('somewhere'), false)

// Wipe what a restore is meant to bring back, and change the local-only key.
db.exec('UPDATE projects SET archived = 0')
db.exec("DELETE FROM app_settings WHERE key = 'analytics.layout'")
db.prepare("UPDATE app_settings SET value = 'E:\\kept' WHERE key = 'backup.directory'").run()
restoreFromCsv(csv)
const after = dump() as { projects: Array<{ name: string; archived: number }> }
check('everything comes back exactly', after, before)
check(
  '"Gen 2" keeps its number and "Tutor" is not merged into "Job"',
  after.projects
    .map((p) => p.name)
    .filter((n) => n === 'Gen 2' || n === 'Tutor' || n === 'Job' || n === 'Gen'),
  ['Gen 2', 'Tutor']
)
check(
  'the hidden project is still hidden',
  after.projects.find((p) => p.name === 'Sprocket')?.archived,
  1
)
check(
  'the project with no sessions survives',
  after.projects.some((p) => p.name === 'Entre'),
  true
)
check(
  'the local backup folder is left as this machine has it',
  (
    db.prepare("SELECT value FROM app_settings WHERE key = 'backup.directory'").get() as {
      value: string
    }
  ).value,
  'E:\\kept'
)

// ------------------------------------------------- an older backup format --
console.log('')
console.log('--- a backup from before the sections still restores as it did ---')
const legacy = csv.slice(0, csv.indexOf('#projects'))
restoreFromCsv(legacy)
const legacyNames = (
  db.prepare('SELECT name FROM projects ORDER BY name').all() as Array<{ name: string }>
).map((p) => p.name)
check('its names are cleaned up as before ("Gen 2" -> "Gen", "Tutor" -> "Job")', legacyNames, [
  'Gen',
  'HW',
  'Job',
  'Sprocket'
])
check('its sessions all come back', countRows(legacy), 5)
restoreFromCsv(csv)

// ------------------------------------------------------------------- undo --
console.log('')
console.log('--- undo is forgotten after a restore ---')
createSession(
  {
    session_date: '2026-11-06',
    project_id: hw,
    task: 'to undo',
    planned_duration_s: 60,
    running_duration_s: 60,
    laps: 1
  },
  'add session'
)
check('a fresh edit can be undone', historyState().canUndo, true)
clearHistory()
check('after the restore path clears it, there is nothing to undo', historyState().canUndo, false)

// --------------------------------------------------------- written whole --
console.log('')
console.log('--- backups are written whole and never over each other ---')
// The fake folder above was only there to prove a restore leaves it alone.
db.exec("DELETE FROM app_settings WHERE key = 'backup.directory'")
const dir = join(root, 'Backups')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const a = await runBackup({ force: true })
const b = await runBackup({ force: true })
check(
  'two backups in the same second are two files',
  a.file !== b.file && !!a.file && !!b.file,
  true
)
const names = readdirSync(dir)
check(
  'no partial file is left behind',
  names.some((n) => n.endsWith('.partial')),
  false
)
check(
  'both are complete',
  [a.file, b.file].map((f) => countRows(readFileSync(f as string, 'utf8'))),
  [6, 6]
)
check(
  'and both exist',
  [a.file, b.file].every((f) => existsSync(f as string)),
  true
)

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
