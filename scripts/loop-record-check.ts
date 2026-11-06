/**
 * A loop is written as one row: saved at each lap, finished at stop, with its
 * lap count surviving a backup and a restore.
 *
 * Run against a throwaway copy - never the real profile:
 *   DWT_USERDATA=<tmp holding a copy of deepwork.db> npx esbuild scripts/loop-record-check.ts \
 *     --bundle --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --outfile=<tmp>/l.mjs && node <tmp>/l.mjs
 */
import { openDatabase } from '../src/main/db'
import { getSession, recordSession, deleteSession } from '../src/main/db/sessions'
import { buildCsv } from '../src/main/backup'
import { previewRestore, restoreFromCsv } from '../src/main/restore'
import { idleTimer, type TimerSnapshot } from '../src/shared/timer'

let pass = 0
let fail = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok)
    console.log(
      '        expected ' + JSON.stringify(expected) + '  actual ' + JSON.stringify(actual)
    )
}

let clock = Date.parse('2026-11-05T02:27:47.000Z')
Date.now = () => clock

const db = openDatabase()
const count = (): number => (db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n
const migrations = (db.prepare('SELECT MAX(id) m FROM schema_migrations').get() as { m: number }).m
eq('migrations through 6 applied', migrations, 6)
eq(
  'every existing row is one lap',
  (db.prepare('SELECT COUNT(*) n FROM sessions WHERE laps <> 1').get() as { n: number }).n,
  0
)

const LAP = 90 * 60_000
const start = clock
const snap = (
  lapsCompleted: number,
  banked: number,
  extra: Partial<TimerSnapshot> = {}
): TimerSnapshot => ({
  ...idleTimer(),
  status: 'running',
  plannedMs: LAP,
  bankedRunningMs: banked,
  segmentStartedAt: null,
  startedAt: start,
  lapsCompleted,
  task: 'MATH 1410',
  project: 'hw',
  ...extra
})

const before = count()
clock = start + LAP
const id = recordSession(snap(1, LAP), null, null)!
eq('lap 1 saves one row', count(), before + 1)
let row = getSession(id)!
eq(
  'after lap 1: 1 lap, 1.5 h planned and run',
  [row.laps, row.planned_duration_s, row.running_duration_s],
  [1, 5400, 5400]
)

// Lap 2 is under way; the user pauses 27 minutes, then stops 51 minutes in.
const pause = { pausedAt: start + LAP + 49 * 60_000, resumedAt: start + LAP + 76 * 60_000 }
clock = start + LAP + 78 * 60_000
const finalId = recordSession(
  snap(1, LAP + 51 * 60_000, { pauses: [pause], status: 'idle' }),
  null,
  id
)
eq('stop finishes the same row', [finalId, count()], [id, before + 1])
row = getSession(id)!
eq(
  'whole loop: 2 laps of a 1.5 h goal, 2.35 h run',
  [row.laps, row.planned_duration_s, row.running_duration_s],
  [2, 5400, 8460]
)
eq(
  'filed under HW, not a new project',
  (db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id) as { name: string })
    .name,
  'HW'
)
eq(
  'pause recorded once',
  (db.prepare('SELECT COUNT(*) n FROM pauses WHERE session_id = ?').get(id) as { n: number }).n,
  1
)

db.prepare('UPDATE sessions SET work_quantity = 4, work_unit = ? WHERE id = ?').run('questions', id)
recordSession(snap(1, LAP + 51 * 60_000, { pauses: [pause], status: 'idle' }), null, id)
row = getSession(id)!
eq(
  'an update never touches the stop prompt fields',
  [row.work_quantity, row.work_unit],
  [4, 'questions']
)
eq(
  'nor duplicates pauses',
  (db.prepare('SELECT COUNT(*) n FROM pauses WHERE session_id = ?').get(id) as { n: number }).n,
  1
)

deleteSession(id)
eq('deleted from the Data tab mid-loop', getSession(id), null)
// SQLite may hand the same id back - it reuses the highest one once that row
// is gone - so what is checked is that a row exists again, not its number.
const again = recordSession(snap(2, 2 * LAP), null, id)!
eq(
  'is written afresh at the next lap, not dropped',
  [count(), getSession(again)?.laps],
  [before + 1, 2]
)

const { csv } = buildCsv()
const header = csv.split(/\r?\n/)[0].split(',')
eq('backup carries laps, last', header[header.length - 1], 'laps')
const total = count()
const preview = previewRestore(csv) as { ok: boolean }
eq('restore accepts the new backup', preview.ok, true)
restoreFromCsv(csv)
eq('restore keeps every row', count(), total)
eq('and the lap count', getSession(again)?.laps, 2)

const old = csv
  .split(/\r?\n/)
  .map((line) => line.replace(/,[^,]*$/, ''))
  .join('\n')
eq('an old backup without laps still restores', (previewRestore(old) as { ok: boolean }).ok, true)
restoreFromCsv(old)
eq('as single runs', getSession(again)?.laps, 1)

console.log('')
console.log(`loop-record: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
