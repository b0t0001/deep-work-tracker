/**
 * A loop is one session: drives the real TimerEngine through looped runs with
 * a fake clock, so every lap boundary is exact and repeatable.
 *
 * Run:
 *   npx esbuild scripts/loop-check.ts --bundle --platform=node --format=esm --outfile=out/checks/loop.mjs && node out/checks/loop.mjs
 *
 * Until 2026-11-06 each lap of a loop ended the session and recorded its own
 * row, which split a 2.35-hour MATH 1410 loop in two and attached the output
 * to the last lap only. These are the properties that replaced that.
 */
import { TimerEngine, type PaceEvent } from '../src/main/timer'
import {
  type TimerSnapshot,
  remainingMs,
  runningMs,
  lapsBegun,
  progress
} from '../src/shared/timer'

let clock = 1_000_000
Date.now = () => clock
let pass = 0,
  fail = 0
const eq = (label: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  ok ? pass++ : fail++
  console.log(
    (ok ? 'PASS  ' : 'FAIL  ') +
      label +
      (ok ? '' : `   expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)
  )
}
const MIN = 60_000
interface Events {
  lap: TimerSnapshot[]
  completed: TimerSnapshot[]
  expired: number
  pace: number[]
}
function rig(loop: boolean): { e: TimerEngine; ev: Events; tick: (ms: number) => void } {
  const e = new TimerEngine()
  e.setLoop(loop)
  const ev: Events = { lap: [], completed: [], expired: 0, pace: [] }
  e.on('lap', (s: TimerSnapshot) => ev.lap.push(s))
  e.on('completed', (s: TimerSnapshot) => ev.completed.push(s))
  e.on('expired', () => ev.expired++)
  e.on('pace', (p: PaceEvent) => ev.pace.push(p.loops))
  // check() is the engine's private tick; driving it directly is what makes
  // every lap boundary exact rather than at the mercy of a real interval.
  const engine = e as unknown as { check: () => void }
  const tick = (ms: number): void => {
    clock += ms
    engine.check()
  }
  return { e, ev, tick }
}

// 1. A 90-minute loop run 2 laps + 25 minutes, ticks of 100 ms with overshoot.
{
  const { e, ev, tick } = rig(true)
  e.start(90 * MIN)
  for (let i = 0; i < (90 * MIN) / 100; i++) tick(100)
  tick(37) // lap noticed 37 ms late
  eq(
    'first lap expiry is a lap, not a completed session',
    [ev.lap.length, ev.completed.length],
    [1, 0]
  )
  eq('lap snapshot banks exactly one lap... plus nothing lost', ev.lap[0].lapsCompleted, 1)
  eq('still running', e.snapshot().status, 'running')
  eq('overshoot carried into lap 2, not lost', runningMs(e.snapshot(), clock), 90 * MIN + 37)
  eq('countdown restarted for lap 2', remainingMs(e.snapshot(), clock), 90 * MIN - 37)
  eq('cue fired', ev.expired, 1)
  for (let i = 0; i < (90 * MIN) / 100; i++) tick(100)
  eq('second lap', [ev.lap.length, e.snapshot().lapsCompleted], [2, 2])
  e.pause()
  tick(10 * MIN)
  e.resume()
  for (let i = 0; i < (25 * MIN) / 100; i++) tick(100)
  eq(
    'pause does not count, does not advance the countdown',
    Math.round(remainingMs(e.snapshot(), clock) / 1000),
    Math.round((65 * MIN - 37) / 1000)
  )
  const done = e.stop()
  eq('stop is the one completed session', ev.completed.length, 1)
  eq(
    'running is the whole loop minus the pause',
    Math.round(runningMs(done, clock) / 1000),
    (180 + 25) * 60
  )
  eq('laps begun = 3', lapsBegun(done, clock), 3)
  eq('pauses kept across laps', done.pauses.length, 1)
  eq('startedAt is the loop start', done.startedAt, 1_000_000)
}

// 2. Loop off: expiry ends the session at exactly the planned length.
{
  const { e, ev, tick } = rig(false)
  e.start(30 * MIN)
  for (let i = 0; i < (30 * MIN) / 100 + 1; i++) tick(100)
  eq('loop off: one completed, no lap', [ev.completed.length, ev.lap.length], [1, 0])
  eq('recorded exactly planned', runningMs(ev.completed[0], clock), 30 * MIN)
  eq('one lap begun', lapsBegun(ev.completed[0], clock), 1)
  eq('status expired', e.snapshot().status, 'expired')
}

// 3. Loop turned off during lap 2: lap 2 ends the session; 2 laps, 2x planned.
{
  const { e, ev, tick } = rig(true)
  e.start(20 * MIN)
  for (let i = 0; i < (20 * MIN) / 100 + 1; i++) tick(100)
  e.setLoop(false)
  for (let i = 0; i < (20 * MIN) / 100 + 1; i++) tick(100)
  eq('loop switched off mid-loop ends after lap 2', [ev.lap.length, ev.completed.length], [1, 1])
  eq('whole loop recorded, exact', runningMs(ev.completed[0], clock), 40 * MIN)
  eq('2 laps', lapsBegun(ev.completed[0], clock), 2)
}

// 4. A clock jump of several laps in one check.
{
  const { e, ev, tick } = rig(true)
  e.start(10 * MIN)
  tick(35 * MIN)
  eq(
    'jump of 3.5 laps: one lap event, 3 laps banked',
    [ev.lap.length, e.snapshot().lapsCompleted],
    [1, 3]
  )
  eq('remaining in lap 4', remainingMs(e.snapshot(), clock), 5 * MIN)
  eq('progress half', progress(e.snapshot(), clock), 0.5)
}

// 5. Pace counts across laps rather than restarting each lap.
{
  const { e, ev, tick } = rig(true)
  e.setPace({ intervalMs: 20 * MIN, quantity: 100, unit: 'words' })
  e.start(30 * MIN)
  for (let i = 0; i < (61 * MIN) / 1000; i++) tick(1000)
  eq('pace cues at 20, 40, 60 min across the lap boundary', ev.pace, [1, 2, 3])
}

// 6. Undo of a stopped loop restores the lap position.
{
  const { e, tick } = rig(true)
  e.start(10 * MIN)
  for (let i = 0; i < (25 * MIN) / 1000; i++) tick(1000)
  const done = e.stop()
  e.restore(done)
  eq(
    'restored mid-lap 3',
    [e.snapshot().lapsCompleted, Math.round(remainingMs(e.snapshot(), clock) / 1000)],
    [2, 300]
  )
  e.resume()
  for (let i = 0; i < (5 * MIN) / 1000 + 1; i++) tick(1000)
  eq('and lap 3 then completes', e.snapshot().lapsCompleted, 3)
}

console.log(`\nengine: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
