/**
 * Checks the per-panel range arithmetic.
 *
 * Run:
 *   DWT_USERDATA=<tmp> npx esbuild scripts/ranges-check.ts --bundle \
 *     --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --external:node:sqlite --outfile=<tmp>/r.mjs && node <tmp>/r.mjs [--db <copy>]
 *
 * Two halves, and the second is the one worth having.
 *
 * The unit tests below cover the edges of the three re-totalling functions.
 * They are cheap and they would catch a bucket boundary moving, but they
 * cannot catch the failure this feature is actually exposed to: that the
 * renderer's re-totalling and the main process's SQL quietly answer the same
 * question differently. Those are two implementations of one aggregate, which
 * is the shape that drifts. So the second half opens a real database and
 * asserts that re-totalling the per-day rows over "all time" reproduces, to
 * the penny, what `GROUP BY` produced in SQL.
 *
 * Without a `--db` the second half is skipped and says so, rather than
 * passing on nothing.
 */
import {
  bucketMinutes,
  hourTotalsIn,
  plannedVsActualIn,
  projectTotalsIn,
  within,
  type HourDay,
  type PlannedRun,
  type ProjectDay
} from '../src/shared/ranges'
import type { Range } from '../src/shared/windows'
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
let fail = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) {
    console.log(
      '        expected ' + JSON.stringify(expected) + '  actual ' + JSON.stringify(actual)
    )
  }
}

const range = (from: string, to: string): Range => ({ from, to, days: 0 })

console.log('--- filtering ---')
{
  const rows = [{ date: '2026-01-01' }, { date: '2026-01-15' }, { date: '2026-02-01' }]
  eq('a null range is everything', within(rows, null).length, 3)
  eq('both ends are inclusive', within(rows, range('2026-01-01', '2026-02-01')).length, 3)
  eq('and they really do bound it', within(rows, range('2026-01-02', '2026-01-31')).length, 1)
  eq('an empty range yields nothing', within(rows, range('2025-01-01', '2025-12-31')).length, 0)
}

console.log('')
console.log('--- hours by project ---')
{
  const days: ProjectDay[] = [
    { date: '2025-06-01', name: 'HW', hours: 20, sessions: 5 },
    { date: '2025-06-01', name: 'Startup', hours: 9, sessions: 4 },
    { date: '2026-01-01', name: 'HW', hours: 2, sessions: 2 },
    { date: '2026-01-02', name: 'HW', hours: 3, sessions: 1 },
    { date: '2026-01-02', name: 'Startup', hours: 6, sessions: 1 }
  ]
  eq('all time sums every day of a project', projectTotalsIn(days, null), [
    { name: 'HW', hours: 25, sessions: 8 },
    { name: 'Startup', hours: 15, sessions: 5 }
  ])
  eq(
    'a range re-sorts, because the leader can change with the period',
    projectTotalsIn(days, range('2026-01-01', '2026-01-02')).map((p) => p.name),
    ['Startup', 'HW']
  )
  eq(
    'and a project with nothing in the range drops out entirely',
    projectTotalsIn(days, range('2026-01-01', '2026-01-01')),
    [{ name: 'HW', hours: 2, sessions: 2 }]
  )
}

console.log('')
console.log('--- hours by hour of the day ---')
{
  const days: HourDay[] = [
    { date: '2026-01-01', hour: 9, hours: 1, sessions: 1 },
    { date: '2026-01-02', hour: 9, hours: 2, sessions: 1 },
    { date: '2026-01-02', hour: 23, hours: 0.5, sessions: 1 }
  ]
  const all = hourTotalsIn(days, null)
  // All 24 even when empty: the heatmap draws a fixed grid, so a missing hour
  // would shift every cell after it rather than leaving a gap.
  eq('always 24 buckets', all.length, 24)
  eq('and they are in clock order', [all[0].hour, all[23].hour], [0, 23])
  eq('the same hour on two days is summed', all[9], { hour: 9, hours: 3, sessions: 2 })
  eq('an hour nothing happened in is zero, not absent', all[3], {
    hour: 3,
    hours: 0,
    sessions: 0
  })
  eq('a range still returns 24', hourTotalsIn(days, range('2026-01-01', '2026-01-01')).length, 24)
  eq(
    'and drops what falls outside it',
    hourTotalsIn(days, range('2026-01-01', '2026-01-01'))[9].hours,
    1
  )
}

console.log('')
console.log('--- planned against actual ---')
{
  eq('under 15 minutes rounds to 5s, with a floor of 5', bucketMinutes(60), 5)
  eq('and 13 minutes lands on 15', bucketMinutes(13 * 60), 15)
  eq('up to an hour rounds to 15s', bucketMinutes(50 * 60), 45)
  eq('above an hour rounds to 30s', bucketMinutes(100 * 60), 90)

  const runs: PlannedRun[] = [
    { date: '2026-01-01', planned: 1800, actual: 1800 },
    { date: '2026-01-02', planned: 1800, actual: 900 },
    { date: '2025-01-01', planned: 1800, actual: 0 },
    { date: '2026-01-02', planned: 3600, actual: 1800 }
  ]
  /*
   * The reason `plannedRuns` is per session rather than pre-bucketed.
   *
   * `actualMinutes` is a mean over the runs in a bucket, and a mean cannot be
   * re-averaged for a shorter range without the count it was taken over. Over
   * all time the 30-minute bucket averages 30, 15 and 0 to 15; over 2026 only
   * it averages 30 and 15 to 22.5. Neither is derivable from the other.
   */
  eq('all time averages every run in a bucket', plannedVsActualIn(runs, null), [
    { plannedMinutes: 30, sessions: 3, actualMinutes: 15 },
    { plannedMinutes: 60, sessions: 1, actualMinutes: 30 }
  ])
  eq(
    'a range re-averages rather than rescaling the old mean',
    plannedVsActualIn(runs, range('2026-01-01', '2026-12-31'))[0],
    { plannedMinutes: 30, sessions: 2, actualMinutes: 22.5 }
  )
  eq(
    'buckets come back in order of planned length',
    plannedVsActualIn(runs, null).map((b) => b.plannedMinutes),
    [30, 60]
  )
}

/*
 * The halves have to agree.
 *
 * `--db` points at a COPY of a database - never the live profile. Only reads
 * happen here, but a check that opens the real file is one that can be run
 * carelessly once.
 */
function argument(name: string): string | null {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}

const dbPath = argument('--db')
console.log('')
console.log('--- the renderer and SQL agree, on real data ---')
if (dbPath === null) {
  console.log('SKIP  no --db given, so nothing was compared against SQL')
} else {
  /*
   * Copied into the throwaway profile rather than opened where it lies.
   *
   * `openDatabase` resolves `DWT_USERDATA/deepwork.db` and runs any pending
   * migration on what it finds, so pointing it at the file given here would
   * mean a read-only check writing to whatever was passed. The `-wal` comes
   * too: rows committed since the last checkpoint live only there, and a copy
   * without it is a database missing its most recent days.
   */
  const target = process.env['DWT_USERDATA']
  if (!target) {
    console.log('FAIL  set DWT_USERDATA to a throwaway directory')
    process.exit(1)
  }
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) {
      copyFileSync(dbPath + suffix, join(target, `deepwork.db${suffix}`))
    }
  }
  const { analytics } = await import('../src/main/db/analytics')
  const { closeDatabase } = await import('../src/main/db')
  const data = analytics()

  const round = <T>(rows: T[]): string =>
    JSON.stringify(rows, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))

  eq('sanity: the database has something in it', data.totalSessions > 0, true)
  eq(
    'hours by project, re-totalled, equals the GROUP BY',
    round(projectTotalsIn(data.projectDays, null)),
    round(data.byProject)
  )
  eq(
    'hours by hour of the day likewise',
    round(hourTotalsIn(data.hourDays, null)),
    round(data.byHour)
  )
  eq(
    'and the planned buckets, including their means',
    round(plannedVsActualIn(data.plannedRuns, null)),
    round(data.plannedVsActual)
  )
  closeDatabase()
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
