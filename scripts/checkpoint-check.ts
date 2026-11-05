/**
 * Checks that a write worth keeping reaches `deepwork.db` itself, not just the
 * write-ahead log beside it.
 *
 * Run:
 *   DWT_USERDATA=<tmp> npx esbuild scripts/checkpoint-check.ts --bundle \
 *     --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --external:node:sqlite --outfile=<tmp>/c.mjs && node <tmp>/c.mjs
 *
 * This reproduces the 2026-09-23 loss rather than describing it. In WAL mode a
 * committed row lives in `deepwork.db-wal` until a checkpoint copies it across.
 * SQLite reads the two as one, so the row looks present either way - right up
 * until the `-wal` is separated from the `.db` while nothing is running, when
 * the database opens perfectly and is simply missing everything since the last
 * checkpoint. No error, no corruption warning.
 *
 * So the test copies the `.db` ALONE and reads that, which is exactly what
 * losing the `-wal` looks like.
 *
 * `recordSession` and `importRows` always checkpointed. The writes below did
 * not until 2026-11-05: work quantity, stop reasons, manual sessions, every
 * edit from the Data tab, undo, and the backup directory in `app_settings`.
 * Each of those belongs to a session row that HAD been checkpointed, so the
 * failure mode was a session surviving with its output silently gone.
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { closeDatabase, databasePath, openDatabase } from '../src/main/db'
import { insertSession, setWorkQuantity, setStopReason } from '../src/main/db/sessions'
import { setSetting } from '../src/main/db/settings'

const root = process.env.DWT_USERDATA
if (!root) throw new Error('set DWT_USERDATA to a throwaway directory')
mkdirSync(root, { recursive: true })

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

/** The `.db` on its own, as it would be found if the `-wal` went missing. */
function readWithoutWal(tag: string): Record<string, unknown> | undefined {
  const copy = join(root as string, `orphan-${tag}.db`)
  copyFileSync(databasePath(), copy)
  const db = new DatabaseSync(copy, { readOnly: true })
  let row: Record<string, unknown> | undefined
  try {
    row = db
      .prepare('SELECT work_quantity, work_unit, stop_reason FROM sessions WHERE id = ?')
      .get(1) as Record<string, unknown> | undefined
  } catch {
    row = undefined
  }
  db.close()
  return row
}

openDatabase()
const id = insertSession({
  task: 'checkpoint probe',
  session_date: '2026-11-05',
  planned_duration_s: 1800,
  running_duration_s: 1500,
  source: 'app'
})
setWorkQuantity(id, 19, 'question')
setStopReason(id, 'finished_early', null)
setSetting('backup.directory', 'C:/somewhere/else')

console.log('--- immediately after the writes, before the coalesced checkpoint ---')
const before = readWithoutWal('before')
check('the .db alone does not have the quantity yet', before?.work_quantity ?? null, null)
console.log('    (so the test is measuring something: the rows really are only in the -wal)')

await new Promise((done) => setTimeout(done, 2500))

console.log('')
console.log('--- after checkpointSoon has fired ---')
const after = readWithoutWal('after')
check('the quantity survives losing the -wal', after?.work_quantity ?? null, 19)
check('the unit survives too', after?.work_unit ?? null, 'question')
check('the stop reason survives', after?.stop_reason ?? null, 'finished_early')

const settings = new DatabaseSync(join(root as string, 'orphan-after.db'), { readOnly: true })
const setting = settings
  .prepare("SELECT value FROM app_settings WHERE key = 'backup.directory'")
  .get() as { value: string } | undefined
settings.close()
check('the backup directory survives', setting?.value ?? null, 'C:/somewhere/else')

closeDatabase()
console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
