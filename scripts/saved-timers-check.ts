/**
 * Closing a timer mid-session records it and keeps it reopenable.
 *
 * Run against a throwaway copy - never the real profile:
 *   DWT_USERDATA=<tmp holding a copy of deepwork.db> npx esbuild scripts/saved-timers-check.ts \
 *     --bundle --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --outfile=<tmp>/s.mjs && node <tmp>/s.mjs
 */
import { openDatabase } from '../src/main/db'
import { getSession, recordSession } from '../src/main/db/sessions'
import { setSetting } from '../src/main/db/settings'
import { TimerEngine } from '../src/main/timer'
import {
  MAX_SAVED,
  addSaved,
  clearSaved,
  listSaved,
  reopenSaved,
  saveRunning
} from '../src/main/savedTimers'
import { remainingMs, type TimerSnapshot } from '../src/shared/timer'

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

let clock = Date.parse('2026-11-06T15:00:00.000Z')
Date.now = () => clock
const MIN = 60_000
const db = openDatabase()
const count = (): number => (db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n
const pauses = (id: number): Array<{ paused_at: string; resumed_at: string | null }> =>
  db
    .prepare('SELECT paused_at, resumed_at FROM pauses WHERE session_id = ? ORDER BY paused_at')
    .all(id) as never
function engineFor(loop: boolean): { e: TimerEngine; tick: (ms: number) => void } {
  const e = new TimerEngine()
  e.setLoop(loop)
  const inner = e as unknown as { check: () => void }
  return {
    e,
    tick: (ms: number): void => {
      for (let t = 0; t < ms; t += 1000) {
        clock += 1000
        inner.check()
      }
    }
  }
}

clearSaved()
const before = count()

// 1. Running when closed: paused, recorded, listed.
const a = engineFor(false)
a.e.setTask('Study for CIS 1200 Midterm')
a.e.setProject('HW')
a.e.start(90 * MIN)
a.tick(20 * MIN)
const closedAt = clock
const id = saveRunning(a.e, null)!
a.e.dispose()
eq('closing a running timer records one row', count(), before + 1)
eq('with the 20 minutes it ran', getSession(id)?.running_duration_s, 1200)
eq(
  'filed under its project and task',
  [getSession(id)?.task, getSession(id)?.project_id !== null],
  ['Study for CIS 1200 Midterm', true]
)
eq(
  'the closed stretch starts as an open pause',
  pauses(id).map((p) => p.resumed_at),
  [null]
)
eq(
  'and it is in the saved list',
  listSaved().map((s) => s.sessionId),
  [id]
)

// 2. Reopened two hours later, run 30 more minutes, stopped.
clock += 120 * MIN
const b = engineFor(false)
const reopened = reopenSaved(b.e, id)
eq('reopening hands back the same row', reopened, id)
eq('and takes it off the list', listSaved().length, 0)
eq(
  'paused, where it was left',
  [b.e.snapshot().status, remainingMs(b.e.snapshot(), clock) / MIN],
  ['paused', 70]
)
eq(
  'with its task and project',
  [b.e.snapshot().task, b.e.snapshot().project],
  ['Study for CIS 1200 Midterm', 'HW']
)
b.e.resume()
b.tick(30 * MIN)
const done = b.e.stop()
const finalId = recordSession(done, null, reopened)
eq('stopping finishes the same row, not a new one', [finalId, count()], [id, before + 1])
eq(
  'running is 20 + 30 minutes; the two hours closed are not counted',
  getSession(id)?.running_duration_s,
  3000
)
const p = pauses(id)
eq(
  'the closed stretch is recorded as a pause',
  [p.length, p[0]?.paused_at, p[0]?.resumed_at],
  [1, new Date(closedAt).toISOString(), new Date(closedAt + 120 * MIN).toISOString()]
)

// 3. Paused when closed: no second pause, nothing extra counted.
const c = engineFor(false)
c.e.start(30 * MIN)
c.tick(5 * MIN)
c.e.pause()
clock += 10 * MIN
const cid = saveRunning(c.e, null)!
eq('a paused timer closes without adding a pause', pauses(cid).length, 1)
eq('and records only its running time', getSession(cid)?.running_duration_s, 300)

// 4. Closed, reopened, closed again: one row, one entry.
const d = engineFor(false)
reopenSaved(d.e, cid)
d.e.resume()
d.tick(5 * MIN)
const cid2 = saveRunning(d.e, cid)
eq(
  'closing a reopened timer updates its row',
  [cid2, getSession(cid)?.running_duration_s],
  [cid, 600]
)
eq('and lists it once', listSaved().filter((s) => s.sessionId === cid).length, 1)

// 5. A loop closed mid-lap: the row its laps were saved to.
const f = engineFor(true)
let loopId: number | null = null
f.e.on('lap', (s: TimerSnapshot) => {
  loopId = recordSession(s, null, loopId)
})
f.e.start(10 * MIN)
f.tick(25 * MIN)
const rowsBefore = count()
const fid = saveRunning(f.e, loopId)
eq('a loop closed mid-lap updates the row its laps went to', [fid, count()], [loopId, rowsBefore])
eq(
  'with 3 laps begun and 25 minutes run',
  [getSession(fid!)?.laps, getSession(fid!)?.running_duration_s],
  [3, 1500]
)

// 6. Nothing to keep.
const g = engineFor(false)
eq('an idle timer saves nothing', saveRunning(g.e, null), null)
g.e.start(MIN)
g.tick(MIN + 1000)
eq('a timer that already finished saves nothing more', saveRunning(g.e, null), null)

// 7. The list itself.
clearSaved()
for (let i = 0; i < MAX_SAVED + 3; i++) {
  addSaved({ sessionId: 100000 + i, snapshot: done, pace: null, savedAt: clock + i })
}
const list = listSaved()
eq(
  'kept to ten, newest first',
  [list.length, list[0].sessionId],
  [MAX_SAVED, 100000 + MAX_SAVED + 2]
)
setSetting('timers.saved', '{not json')
eq('a damaged list reads as empty rather than throwing', listSaved(), [])
setSetting(
  'timers.saved',
  JSON.stringify([{ sessionId: 'x' }, { sessionId: 7, savedAt: 1, snapshot: done, pace: null }])
)
eq(
  'and a malformed entry is skipped',
  listSaved().map((s) => s.sessionId),
  [7]
)
clearSaved()
eq('clearing the list never deletes a recorded session', getSession(id)?.running_duration_s, 3000)

console.log('')
console.log(`saved-timers: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
