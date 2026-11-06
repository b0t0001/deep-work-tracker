/**
 * Checks the comparison box's arithmetic.
 *
 * Run:
 *   npx esbuild scripts/compare-check.ts --bundle --platform=node --format=esm \
 *     --outfile=<tmp>/c.mjs && node <tmp>/c.mjs
 *
 * The box replaced two tiles and a table that were three readings of one
 * number, so the thing worth testing is that each reading it offers is a
 * genuinely different question with a predictable answer - and that the two
 * cases the old table got wrong cannot come back: an em dash where a period
 * does not fit, and a comparison against a period that is not there.
 *
 * Fixtures are built by hand with known totals, so a wrong answer names the
 * arithmetic rather than the data.
 */
import { compare, grainsFor, previousRange, usableGrain } from '../src/shared/compare'
import type { DayTotal } from '../src/shared/analytics'
import type { Range } from '../src/shared/windows'

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

const DAY_MS = 86_400_000
function dateOf(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

/** `hours[i]` is the hours on the i-th day starting at `from`. */
function days(from: string, hours: number[]): DayTotal[] {
  const first = dayNumber(from)
  return hours.map((h, i) => ({ date: dateOf(first + i), hours: h, sessions: h > 0 ? 1 : 0 }))
}

function range(from: string, to: string): Range {
  return { from, to, days: dayNumber(to) - dayNumber(from) + 1 }
}

console.log('--- which grains a range can answer in ---')
/*
 * `periodStats` counts whole periods back from the end and drops the
 * part-period at the start, so these thresholds are not arbitrary: a 6-day
 * range holds no whole week, and offering "per week" over it would print the
 * em dash the old table printed.
 */
eq('a week-long range cannot answer per month', grainsFor(7), ['day', 'week'])
eq('nor can six days answer per week', grainsFor(6), ['day'])
eq('thirty days can answer all three', grainsFor(30), ['day', 'week', 'month'])
eq('all time can answer all three', grainsFor(null), ['day', 'week', 'month'])
eq('a grain that fits is used as chosen', usableGrain('month', 90), 'month')
eq(
  'a grain that no longer fits falls back to the longest that does, not to days',
  usableGrain('month', 7),
  'week'
)

console.log('')
console.log('--- the period before this one ---')
eq('is equally long and ends the day before', previousRange(range('2026-01-08', '2026-01-14')), {
  from: '2026-01-01',
  to: '2026-01-07',
  days: 7
})
eq(
  'and it is allowed to predate the first session, because those were days with no work',
  previousRange(range('2026-01-01', '2026-01-07')).from,
  '2025-12-25'
)

console.log('')
console.log('--- the figure, and what it is compared against ---')
{
  // Two weeks: the first averaging 1 h a day, the second 2 h a day.
  const daily = days('2026-01-01', [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2])
  const all = range('2026-01-01', '2026-01-14')
  const second = range('2026-01-08', '2026-01-14')

  const mean = compare(daily, second, all, 'mean', 'day')
  eq('the mean over the chosen range', mean.value, 2)
  eq('the same statistic over the period before it', mean.previous, 1)
  eq('and the change between them', Math.round(mean.changePercent ?? 0), 100)
  eq('with all time as the third figure', mean.allTime, 1.5)
  eq('the grain actually used is reported', mean.grain, 'day')

  // Per week over a week is one whole week, which is the total.
  const weekly = compare(daily, second, all, 'mean', 'week')
  eq('per week over one week is that week total', weekly.value, 14)
  eq('and its periods count says how many it averaged', weekly.periods, 1)
}

console.log('')
console.log('--- median is a different question, not a second spelling of mean ---')
{
  // Six quiet days and one enormous one. The mean is dragged; the median is not.
  const daily = days('2026-02-01', [1, 1, 1, 1, 1, 1, 50])
  const all = range('2026-02-01', '2026-02-07')
  const week = range('2026-02-01', '2026-02-07')
  eq('the mean follows the outlier', compare(daily, week, all, 'mean', 'day').value, 8)
  eq('the median does not', compare(daily, week, all, 'median', 'day').value, 1)
}

console.log('')
console.log('--- the comparisons that must not be invented ---')
{
  const daily = days('2026-03-01', [2, 2, 2, 2, 2, 2, 2])
  const all = range('2026-03-01', '2026-03-07')

  /*
   * All time has no period before it. Reporting "up 100%" against a stretch
   * that predates the first session would be comparing against zero, which
   * is a number with no content behind it - and the loudest possible way to
   * say nothing.
   */
  const everything = compare(daily, all, all, 'mean', 'day')
  eq('all time has no previous period', everything.previous, null)
  eq('so there is no percentage either', everything.changePercent, null)

  /*
   * And a previous period that is genuinely empty is still not a comparison:
   * dividing by zero gives Infinity, which would render as "up Infinity%".
   */
  const later = range('2026-03-08', '2026-03-14')
  const wider = range('2026-03-01', '2026-03-14')
  const afterNothing = compare(daily, later, wider, 'mean', 'day')
  eq('an empty window answers zero rather than nothing', afterNothing.value, 0)
  eq('but a drop to zero from two is still a real comparison', afterNothing.previous, 2)
  eq('and it is reported as down 100%', Math.round(afterNothing.changePercent ?? 0), -100)
}

console.log('')
console.log('--- every calendar day counts, including the empty ones ---')
{
  // 10 hours across two days of a seven-day week. Dividing by worked days
  // would say 5; dividing by calendar days says 1.43, and CLAUDE.md settled
  // that the second is the one this app reports.
  const daily = days('2026-04-01', [5, 5, 0, 0, 0, 0, 0])
  const all = range('2026-04-01', '2026-04-07')
  const got = compare(daily, all, all, 'mean', 'day').value
  eq('ten hours over seven days is 1.43, not 5', Math.round((got ?? 0) * 100) / 100, 1.43)
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
