/**
 * Drives a real looping timer through the real write path, with the
 * coalescing checkpoint firing underneath it.
 *
 * Run:
 *   DWT_USERDATA=<tmp> npx esbuild scripts/loop-checkpoint-check.ts --bundle \
 *     --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --external:node:sqlite --outfile=<tmp>/l.mjs && node <tmp>/l.mjs
 *
 * `checkpoint-check.ts` proves a single write survives losing the `-wal`.
 * This asks the question that one cannot: `checkpointSoon()` now fires from
 * the quantity and stop-reason handlers, and on a looping timer those run
 * *while the next lap is already counting down*. A checkpoint takes an
 * exclusive lock and `node:sqlite` is synchronous, so if a coalesced TRUNCATE
 * can collide with anything, it collides here.
 *
 * Four things are checked, in the order they could break:
 *
 *   1. Every lap of a loop is recorded, and each is its own row. A dropped
 *      lap is the failure the single-path `completed` handler exists to
 *      prevent, and a checkpoint mid-loop is a new way to drop one.
 *   2. A completed run records EXACTLY its planned duration. Expiry is
 *      noticed by a 100ms tick, so recording elapsed time would inflate every
 *      completed session by up to one tick — and a blocking checkpoint makes
 *      a late tick far more likely, which is precisely when that bug would
 *      come back.
 *   3. Labels written while the next lap runs reach `deepwork.db` itself, not
 *      just the log beside it. Checked by copying the `.db` ALONE, which is
 *      what losing the `-wal` looks like.
 *   4. Rapid edits coalesce to one checkpoint and the LAST value is the one
 *      that lands. Typing `1`, `19`, `195`, `19` into the quantity box is
 *      four writes in a second; four TRUNCATEs would be the collision, and a
 *      stale winner would be silent data loss.
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { closeDatabase, databasePath, openDatabase } from '../src/main/db'
import { recordSession, setWorkQuantity, setStopReason } from '../src/main/db/sessions'
import { TimerEngine } from '../src/main/timer'
import type { TimerSnapshot } from '../src/main/timer'

const root = process.env.DWT_USERDATA
if (!root) throw new Error('set DWT_USERDATA to a throwaway directory')
mkdirSync(root, { recursive: true })

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) console.log(`       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

/**
 * Reads the database as it would be if the `-wal` went missing.
 *
 * SQLite reads the `.db` and its log as one, so a row looks present either
 * way right up until they are separated. Copying the `.db` alone is the only
 * way to see what was actually checkpointed.
 */
function readWithoutWal(tag: string): Array<Record<string, unknown>> {
  const orphan = join(root as string, `loop-${tag}.db`)
  copyFileSync(databasePath(), orphan)
  const db = new DatabaseSync(orphan, { readOnly: true })
  const rows = db
    .prepare(
      `SELECT id, planned_duration_s, running_duration_s, work_quantity, work_unit, stop_reason
         FROM sessions ORDER BY id`
    )
    .all() as Array<Record<string, unknown>>
  db.close()
  return rows
}

const LAP_MS = 700

async function main(): Promise<void> {
  openDatabase()

  console.log('A looping timer, three laps, labelled while the next lap runs')
  console.log('')

  const engine = new TimerEngine()
  engine.setLoop(true)
  engine.setTask('CIS 1200 problem set')

  const recorded: number[] = []
  let lapsSeen = 0

  engine.on('completed', (snapshot: TimerSnapshot) => {
    lapsSeen++
    const id = recordSession(snapshot)
    if (id === null) return
    recorded.push(id)
    // Exactly what the stop prompt does, and what the handlers now do: write
    // the label, then schedule a coalescing checkpoint. The engine has
    // already started the next lap by the time this runs.
    setWorkQuantity(id, 19, 'question')
    setStopReason(id, 'finished_early', null)
  })

  engine.start(LAP_MS)
  // Three laps plus a margin, then stop mid-fourth.
  await new Promise((done) => setTimeout(done, LAP_MS * 3 + 250))
  engine.stop()

  console.log('1. every lap is its own row')
  check('three laps completed', lapsSeen >= 3, true)
  check('each full lap was recorded', recorded.length, 3)
  check('the ids are distinct', new Set(recorded).size, recorded.length)
  /*
   * The fourth `completed` is the hand stop, 250ms into a lap, and it is
   * deliberately NOT recorded: `recordSession` returns null below one second
   * of running time. That is the rule that keeps a misclick from becoming a
   * zero-length session, and the loop must not quietly break it - a stop
   * path that started writing sub-second rows would put a row on every day
   * the user opened the app and touched the clock.
   */
  check('the sub-second hand stop recorded nothing', lapsSeen - recorded.length, 1)

  console.log('')
  console.log('2. a completed lap records its planned duration, not the tick overshoot')
  // Read through the live connection: this is about what was written, not
  // about what was checkpointed.
  const live = openDatabase()
    .prepare(
      `SELECT planned_duration_s AS planned, running_duration_s AS actual
         FROM sessions WHERE id IN (${recorded.slice(0, 3).join(',')}) ORDER BY id`
    )
    .all() as Array<{ planned: number; actual: number }>
  const plannedS = Math.round(LAP_MS / 1000)
  for (const [i, row] of live.entries()) {
    check(`lap ${i + 1}: actual === planned (${plannedS}s), no overshoot`, row.actual, plannedS)
  }

  console.log('')
  console.log('3. labels written during the next lap survive losing the -wal')
  await new Promise((done) => setTimeout(done, 2200))
  const settled = readWithoutWal('settled')
  check('the rows are in the .db itself', settled.length >= 3, true)
  check(
    'every recorded lap carries its quantity',
    settled.filter((r) => r.work_quantity === 19).length >= 3,
    true
  )
  check(
    'every recorded lap carries its stop reason',
    settled.filter((r) => r.stop_reason === 'finished_early').length >= 3,
    true
  )

  console.log('')
  console.log('4. rapid edits coalesce, and the last value wins')
  const target = recorded[0]
  // What typing `1`, `19`, `195`, `19` into the quantity box actually sends.
  setWorkQuantity(target, 1, 'question')
  setWorkQuantity(target, 19, 'question')
  setWorkQuantity(target, 195, 'question')
  setWorkQuantity(target, 19, 'question')
  const midFlight = readWithoutWal('mid')
  check(
    'before the timer fires, the .db alone still has the old value',
    midFlight.find((r) => r.id === target)?.work_quantity,
    19
  )
  console.log('       (the last write happens to match the settled value, so this only')
  console.log('        confirms the read works; the next check is the real one)')

  setWorkQuantity(target, 42, 'problem')
  await new Promise((done) => setTimeout(done, 2200))
  const after = readWithoutWal('after')
  check(
    'the last value is the one that landed',
    after.find((r) => r.id === target)?.work_quantity,
    42
  )
  check('and its unit came with it', after.find((r) => r.id === target)?.work_unit, 'problem')

  console.log('')
  console.log('5. closeDatabase flushes a checkpoint that has not fired yet')
  const last = recorded[recorded.length - 1]
  setWorkQuantity(last, 7, 'page')
  // Deliberately no wait: the 1.5s timer is still pending, and it is unref'd,
  // so nothing else would keep it alive. A clean close has to flush it.
  closeDatabase()
  const closed = readWithoutWal('closed')
  check('the pending write survived the close', closed.find((r) => r.id === last)?.work_quantity, 7)

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
