/**
 * Exercises the pure functions in `src/shared/analytics.ts`.
 *
 * There is no test runner in this project (see CLAUDE.md, "Working
 * practices") - logic is checked by bundling it standalone and driving it from
 * Node. Same pattern as the timer engine scripts:
 *
 *   npx esbuild scripts/analytics-check.ts --bundle --platform=node --format=esm --outfile=<tmp>/t.mjs
 *   node <tmp>/t.mjs
 *
 * Always exits 0. A failure is a line in the output, not a non-zero status -
 * the point is to read the whole report in one pass.
 */

import {
  fillDays,
  median,
  periodStats,
  plannedFit,
  sittings,
  streaks,
  weekOverWeek,
  isDayWorked,
  previousDay,
  type DayTotal,
  type PlannedVsActual,
  type Sitting
} from '../src/shared/analytics'

// ---------------------------------------------------------------- harness ---

let passed = 0
let total = 0

function record(name: string, failure: string | null): void {
  total += 1
  if (failure === null) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name} -- ${failure}`)
  }
}

function show(value: unknown): string {
  return JSON.stringify(value)
}

/** Structural equality, with a tolerance on numbers so 0.1+0.2 is not a bug. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true
    return Math.abs(a - b) < 1e-9
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => same(item, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort()
    const kb = Object.keys(b as object).sort()
    if (!same(ka, kb)) return false
    return ka.every((k) =>
      same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  }
  return a === b
}

function eq(name: string, actual: unknown, expected: unknown): void {
  record(name, same(actual, expected) ? null : `expected ${show(expected)}, got ${show(actual)}`)
}

function check(name: string, condition: boolean, detail: string): void {
  record(name, condition ? null : detail)
}

function section(title: string): void {
  console.log('')
  console.log(title)
}

// ------------------------------------------------------------- fixtures ----

/** A worked day. `hours` above zero is what makes it count. */
function day(date: string, hours = 2, sessions = 1): DayTotal {
  return { date, hours, sessions }
}

function run(
  startedAt: string,
  endedAt: string,
  seconds: number
): { startedAt: string; endedAt: string; seconds: number } {
  return { startedAt, endedAt, seconds }
}

// -------------------------------------------------------------- streaks ----

section('streaks()')

eq('empty input gives zeroes and a null since', streaks([], '2026-03-10'), {
  current: 0,
  best: 0,
  currentSince: null
})

eq('a single worked day, which is today', streaks([day('2026-03-10')], '2026-03-10'), {
  current: 1,
  best: 1,
  currentSince: '2026-03-10'
})

eq('a single worked day, which is yesterday', streaks([day('2026-03-09')], '2026-03-10'), {
  current: 1,
  best: 1,
  currentSince: '2026-03-09'
})

// The 9am case: the streak is not over until the day is.
{
  const history = [day('2026-03-07'), day('2026-03-08'), day('2026-03-09')]
  eq('today not worked yet does not break the streak', streaks(history, '2026-03-10'), {
    current: 3,
    best: 3,
    currentSince: '2026-03-07'
  })
  eq(
    'working today extends that same streak to four',
    streaks([...history, day('2026-03-10')], '2026-03-10'),
    { current: 4, best: 4, currentSince: '2026-03-07' }
  )
}

eq(
  'neither today nor yesterday worked ends the streak at zero',
  streaks([day('2026-03-06'), day('2026-03-07'), day('2026-03-08')], '2026-03-10'),
  { current: 0, best: 3, currentSince: null }
)

// A gap in the middle: current and best must differ.
eq(
  'a gap in the middle: current 2, best 4',
  streaks(
    [
      day('2026-03-01'),
      day('2026-03-02'),
      day('2026-03-03'),
      day('2026-03-04'),
      // 05, 06, 07 missing
      day('2026-03-08'),
      day('2026-03-09')
    ],
    '2026-03-10'
  ),
  { current: 2, best: 4, currentSince: '2026-03-08' }
)

eq(
  'best streak sits earlier in history than the current one',
  streaks(
    [
      day('2026-01-05'),
      day('2026-01-06'),
      day('2026-01-07'),
      day('2026-01-08'),
      day('2026-01-09'),
      day('2026-03-09'),
      day('2026-03-10')
    ],
    '2026-03-10'
  ),
  { current: 2, best: 5, currentSince: '2026-03-09' }
)

eq(
  'best is the current streak when the current one is the longest',
  streaks(
    [day('2026-01-05'), day('2026-01-06'), day('2026-03-08'), day('2026-03-09'), day('2026-03-10')],
    '2026-03-10'
  ),
  { current: 3, best: 3, currentSince: '2026-03-08' }
)

// Date arithmetic: month, year, leap year, and 31->1.
eq(
  'a streak spanning the year boundary, 2025-12-30 to 2026-01-02',
  streaks(
    [day('2025-12-30'), day('2025-12-31'), day('2026-01-01'), day('2026-01-02')],
    '2026-01-02'
  ),
  { current: 4, best: 4, currentSince: '2025-12-30' }
)

eq(
  'year boundary with today not worked yet (2026-01-03)',
  streaks(
    [day('2025-12-30'), day('2025-12-31'), day('2026-01-01'), day('2026-01-02')],
    '2026-01-03'
  ),
  { current: 4, best: 4, currentSince: '2025-12-30' }
)

eq(
  'a streak spanning a month boundary, 2026-01-30 to 2026-02-02',
  streaks(
    [day('2026-01-30'), day('2026-01-31'), day('2026-02-01'), day('2026-02-02')],
    '2026-02-02'
  ),
  { current: 4, best: 4, currentSince: '2026-01-30' }
)

eq(
  'a streak across 29 February in a leap year',
  streaks([day('2028-02-28'), day('2028-02-29'), day('2028-03-01')], '2028-03-01'),
  { current: 3, best: 3, currentSince: '2028-02-28' }
)

eq(
  '28 Feb to 1 Mar is consecutive in a non-leap year',
  streaks([day('2026-02-28'), day('2026-03-01')], '2026-03-01'),
  { current: 2, best: 2, currentSince: '2026-02-28' }
)

eq(
  '29 Feb is NOT a day in a non-leap year, so 28 Feb and 1 Mar stay joined',
  streaks(
    [day('2026-02-27'), day('2026-02-28'), day('2026-03-01'), day('2026-03-02')],
    '2026-03-02'
  ),
  { current: 4, best: 4, currentSince: '2026-02-27' }
)

eq(
  '30 April to 1 May (a 30-day month) is consecutive',
  streaks([day('2026-04-29'), day('2026-04-30'), day('2026-05-01')], '2026-05-01'),
  { current: 3, best: 3, currentSince: '2026-04-29' }
)

// hours === 0 is a day present in the array but not worked - fillDays puts
// these in, so streaks sees them constantly.
eq('a zero-hour day does not count as worked', streaks([day('2026-03-10', 0)], '2026-03-10'), {
  current: 0,
  best: 0,
  currentSince: null
})

eq(
  'a zero-hour day in the middle breaks the streak',
  streaks(
    [day('2026-03-07'), day('2026-03-08', 0), day('2026-03-09'), day('2026-03-10')],
    '2026-03-10'
  ),
  { current: 2, best: 2, currentSince: '2026-03-09' }
)

eq(
  'a fully zeroed array (fillDays over an empty range) is not a streak',
  streaks([day('2026-03-08', 0), day('2026-03-09', 0), day('2026-03-10', 0)], '2026-03-10'),
  { current: 0, best: 0, currentSince: null }
)

eq(
  'a fillDays-shaped array with zeroes around real days still reads correctly',
  streaks(
    [
      day('2026-03-05', 0),
      day('2026-03-06', 1.5),
      day('2026-03-07', 0),
      day('2026-03-08', 0.25),
      day('2026-03-09', 3),
      day('2026-03-10', 0)
    ],
    '2026-03-10'
  ),
  { current: 2, best: 2, currentSince: '2026-03-08' }
)

eq(
  'a tiny but non-zero day counts',
  streaks([day('2026-03-09', 0.0001), day('2026-03-10', 0)], '2026-03-10'),
  { current: 1, best: 1, currentSince: '2026-03-09' }
)

eq(
  'duplicate dates do not inflate the streak',
  streaks([day('2026-03-09'), day('2026-03-09'), day('2026-03-10')], '2026-03-10'),
  { current: 2, best: 2, currentSince: '2026-03-09' }
)

eq(
  'unsorted input gives the same answer as sorted',
  streaks([day('2026-03-10'), day('2026-03-08'), day('2026-03-09')], '2026-03-10'),
  { current: 3, best: 3, currentSince: '2026-03-08' }
)

{
  // 400 consecutive days, so nothing in the arithmetic can quietly lose a day
  // across a year, a leap day or a DST switch.
  const long: DayTotal[] = []
  const cursor = new Date(Date.UTC(2027, 10, 1))
  for (let i = 0; i < 400; i += 1) {
    long.push(day(cursor.toISOString().slice(0, 10)))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  const last = long[long.length - 1].date
  eq('400 consecutive days count as 400', streaks(long, last), {
    current: 400,
    best: 400,
    currentSince: '2027-11-01'
  })
}

// --------------------------------------------------------- weekOverWeek ----

section('weekOverWeek()')

eq('empty input', weekOverWeek([], '2026-03-10'), {
  thisWeek: 0,
  lastWeek: 0,
  thisWeekDays: 0,
  lastWeekDays: 0,
  thisWeekPerDay: 0,
  lastWeekPerDay: 0,
  changePercent: null,
  perDayChangePercent: null
})

{
  // This week = 2026-03-04..2026-03-10 (today inclusive, 7 days).
  // Last week = 2026-02-25..2026-03-03.
  const daily = [
    day('2026-03-10', 1), // today
    day('2026-03-04', 1), // 6 back, earliest day of this week
    day('2026-03-03', 10), // 7 back, newest day of last week
    day('2026-02-25', 10), // 13 back, oldest day of last week
    day('2026-02-24', 99) // 14 back, outside both
  ]
  const got = weekOverWeek(daily, '2026-03-10')
  eq('this week sums only the last seven days inclusive of today', got.thisWeek, 2)
  eq('a day exactly 7 days back lands in LAST week', got.lastWeek, 20)
  check(
    'a day exactly 14 days back is in neither window',
    got.thisWeek + got.lastWeek === 22,
    `99 hours leaked in: thisWeek ${got.thisWeek}, lastWeek ${got.lastWeek}`
  )
}

{
  // Every day of a 21-day run, each worth one hour: the windows must be
  // exactly seven wide and must not overlap.
  const daily: DayTotal[] = []
  const cursor = new Date(Date.UTC(2026, 1, 18)) // 2026-02-18
  for (let i = 0; i < 21; i += 1) {
    daily.push(day(cursor.toISOString().slice(0, 10), 1))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  const got = weekOverWeek(daily, '2026-03-10')
  eq('seven one-hour days in this week', got.thisWeek, 7)
  eq('seven one-hour days in last week', got.lastWeek, 7)
  check(
    'the two windows do not overlap and do not double-count',
    got.thisWeek + got.lastWeek === 14,
    `expected 14 hours across both windows, got ${got.thisWeek + got.lastWeek}`
  )
  eq('equal weeks give a zero change, not null', got.changePercent, 0)
}

{
  const got = weekOverWeek([day('2026-03-10', 5), day('2026-03-20', 99)], '2026-03-10')
  eq('future-dated rows are excluded from this week', got.thisWeek, 5)
  eq('future-dated rows are excluded from last week', got.lastWeek, 0)
}

eq(
  'tomorrow is excluded (the off-by-one at the top of the window)',
  weekOverWeek([day('2026-03-11', 99)], '2026-03-10'),
  {
    thisWeek: 0,
    lastWeek: 0,
    thisWeekDays: 0,
    lastWeekDays: 0,
    thisWeekPerDay: 0,
    lastWeekPerDay: 0,
    changePercent: null,
    perDayChangePercent: null
  }
)

{
  const got = weekOverWeek([day('2026-03-09', 4)], '2026-03-10')
  eq('an empty last week gives a null changePercent', got.changePercent, null)
  check(
    'that null is not Infinity or NaN',
    got.changePercent === null,
    `got ${show(got.changePercent)}`
  )
}

eq(
  'an empty THIS week against a real last week is -100%',
  weekOverWeek([day('2026-03-01', 8)], '2026-03-10'),
  {
    thisWeek: 0,
    lastWeek: 8,
    thisWeekDays: 0,
    lastWeekDays: 1,
    thisWeekPerDay: 0,
    lastWeekPerDay: 8,
    changePercent: -100,
    perDayChangePercent: -100
  }
)

eq(
  'a doubled week is +100%',
  weekOverWeek([day('2026-03-09', 4), day('2026-03-02', 2)], '2026-03-10'),
  {
    thisWeek: 4,
    lastWeek: 2,
    thisWeekDays: 1,
    lastWeekDays: 1,
    thisWeekPerDay: 4,
    lastWeekPerDay: 2,
    changePercent: 100,
    perDayChangePercent: 100
  }
)

eq(
  'a halved week is -50%',
  weekOverWeek([day('2026-03-09', 2), day('2026-03-02', 4)], '2026-03-10'),
  {
    thisWeek: 2,
    lastWeek: 4,
    thisWeekDays: 1,
    lastWeekDays: 1,
    thisWeekPerDay: 2,
    lastWeekPerDay: 4,
    changePercent: -50,
    perDayChangePercent: -50
  }
)

{
  // The windows reach back across a year boundary, where the arithmetic is
  // most likely to go wrong.
  const got = weekOverWeek(
    [
      day('2026-01-02', 1), // today
      day('2025-12-27', 1), // 6 back -> this week
      day('2025-12-26', 5), // 7 back -> last week
      day('2025-12-20', 5), // 13 back -> last week
      day('2025-12-19', 99) // 14 back -> neither
    ],
    '2026-01-02'
  )
  eq('this week across the year boundary', got.thisWeek, 2)
  eq('last week across the year boundary', got.lastWeek, 10)
}

{
  // Today 2028-03-01, a leap year: this week is 02-24..03-01, last week is
  // 02-17..02-23. The leap day sits inside this week.
  const got = weekOverWeek(
    [
      day('2028-03-01', 1), // today
      day('2028-02-29', 2), // 1 back, the leap day -> this week
      day('2028-02-24', 3), // 6 back -> this week
      day('2028-02-23', 5), // 7 back -> last week
      day('2028-02-17', 5), // 13 back -> last week
      day('2028-02-16', 99) // 14 back -> neither
    ],
    '2028-03-01'
  )
  eq('the leap day counts in this week', got.thisWeek, 6)
  eq('the window below it is still exactly seven days wide', got.lastWeek, 10)
}

eq(
  'zero-hour days do not disturb the comparison',
  weekOverWeek([day('2026-03-09', 0), day('2026-03-02', 0)], '2026-03-10'),
  {
    thisWeek: 0,
    lastWeek: 0,
    thisWeekDays: 0,
    lastWeekDays: 0,
    thisWeekPerDay: 0,
    lastWeekPerDay: 0,
    changePercent: null,
    perDayChangePercent: null
  }
)

// ------------------------------------------- hours per worked day (12b) ----

section('weekOverWeek() per worked day')

{
  // The case the change exists for. Five working days against seven, the same
  // hours on each: the totals say a collapse, the per-day figure says nothing
  // changed. Comparing totals punishes the shape of a week rather than the
  // work in it.
  const daily = [
    day('2026-03-10', 4),
    day('2026-03-09', 4),
    day('2026-03-08', 4),
    day('2026-03-07', 4),
    day('2026-03-06', 4),
    day('2026-03-03', 4),
    day('2026-03-02', 4),
    day('2026-03-01', 4),
    day('2026-02-28', 4),
    day('2026-02-27', 4),
    day('2026-02-26', 4),
    day('2026-02-25', 4)
  ]
  const got = weekOverWeek(daily, '2026-03-10')
  eq('five working days this week', got.thisWeekDays, 5)
  eq('seven working days last week', got.lastWeekDays, 7)
  eq('totals read as a collapse', Math.round(got.changePercent ?? 0), -29)
  eq('per worked day is flat', got.perDayChangePercent, 0)
}

{
  // A zero-hour day must not land in the denominator, or a misclick quietly
  // halves the average. Same definition as streaks(), via isDayWorked.
  const got = weekOverWeek([day('2026-03-10', 6), day('2026-03-09', 0)], '2026-03-10')
  eq('a zero-hour day is not a worked day', got.thisWeekDays, 1)
  eq('so the average is the one real day', got.thisWeekPerDay, 6)
  check(
    'and isDayWorked agrees with it',
    isDayWorked(day('2026-03-09', 0)) === false && isDayWorked(day('2026-03-10', 6)) === true,
    'isDayWorked disagrees with the denominator it feeds'
  )
}

{
  // Fewer days but longer ones is the case a total comparison hides.
  const got = weekOverWeek(
    [day('2026-03-10', 9), day('2026-03-03', 3), day('2026-03-02', 3), day('2026-03-01', 3)],
    '2026-03-10'
  )
  eq('totals are identical', got.changePercent, 0)
  eq('but the day was three times as long', got.perDayChangePercent, 200)
}

eq(
  'no worked day last week leaves the per-day change null',
  weekOverWeek([day('2026-03-10', 5)], '2026-03-10').perDayChangePercent,
  null
)

section('previousDay()')

eq('an ordinary day', previousDay('2026-03-10'), '2026-03-09')
eq('the first of a month', previousDay('2026-03-01'), '2026-02-28')
eq('the first of January', previousDay('2026-01-01'), '2025-12-31')
eq('the first of March in a leap year', previousDay('2024-03-01'), '2024-02-29')

// -------------------------------------------------------------- sittings ---

section('sittings()')

eq('empty input', sittings([]), [])

eq(
  'a single row is one sitting',
  sittings([run('2026-03-10T09:00:00Z', '2026-03-10T09:25:00Z', 1500)]),
  [
    {
      startedAt: '2026-03-10T09:00:00Z',
      endedAt: '2026-03-10T09:25:00Z',
      sessions: 1,
      hours: 1500 / 3600
    }
  ]
)

{
  // Same three runs, shuffled. Grouping must not depend on arrival order.
  const rows = [
    run('2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z', 1800),
    run('2026-03-10T09:40:00Z', '2026-03-10T10:10:00Z', 1800),
    run('2026-03-10T14:00:00Z', '2026-03-10T14:30:00Z', 1800)
  ]
  const expected: Sitting[] = [
    {
      startedAt: '2026-03-10T09:00:00Z',
      endedAt: '2026-03-10T10:10:00Z',
      sessions: 2,
      hours: 1
    },
    {
      startedAt: '2026-03-10T14:00:00Z',
      endedAt: '2026-03-10T14:30:00Z',
      sessions: 1,
      hours: 0.5
    }
  ]
  eq('in order: two sittings', sittings(rows), expected)
  eq('reversed: the same two sittings', sittings([...rows].reverse()), expected)
  eq('shuffled: the same two sittings', sittings([rows[2], rows[0], rows[1]]), expected)
  check(
    'the input array is not mutated',
    rows[0].startedAt === '2026-03-10T09:00:00Z' && rows[2].startedAt === '2026-03-10T14:00:00Z',
    'sittings() reordered the caller’s array in place'
  )
}

eq(
  'a gap of exactly the threshold merges',
  sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z', 1800),
    run('2026-03-10T10:00:00Z', '2026-03-10T10:30:00Z', 1800)
  ]).length,
  1
)

eq(
  'a gap one minute over the threshold splits',
  sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z', 1800),
    run('2026-03-10T10:01:00Z', '2026-03-10T10:30:00Z', 1740)
  ]).length,
  2
)

eq(
  'a gap one minute under the threshold merges',
  sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z', 1800),
    run('2026-03-10T09:59:00Z', '2026-03-10T10:30:00Z', 1860)
  ]).length,
  1
)

eq(
  'a gap of exactly one second over the threshold splits',
  sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z', 1800),
    run('2026-03-10T10:00:01Z', '2026-03-10T10:30:00Z', 1799)
  ]).length,
  2
)

eq(
  'a custom threshold is honoured',
  sittings(
    [
      run('2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z', 1800),
      run('2026-03-10T09:35:00Z', '2026-03-10T10:00:00Z', 1500)
    ],
    5
  ).length,
  1
)

eq(
  'a custom threshold also splits when exceeded',
  sittings(
    [
      run('2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z', 1800),
      run('2026-03-10T09:36:00Z', '2026-03-10T10:00:00Z', 1440)
    ],
    5
  ).length,
  2
)

{
  // A chain: each gap is under the threshold, so a four-run morning is one
  // sitting even though the first and last are hours apart.
  const got = sittings([
    run('2026-03-10T08:00:00Z', '2026-03-10T08:45:00Z', 2700),
    run('2026-03-10T09:10:00Z', '2026-03-10T09:55:00Z', 2700),
    run('2026-03-10T10:20:00Z', '2026-03-10T11:05:00Z', 2700),
    run('2026-03-10T11:30:00Z', '2026-03-10T12:15:00Z', 2700)
  ])
  eq('a chain of short gaps is one long sitting', got, [
    {
      startedAt: '2026-03-10T08:00:00Z',
      endedAt: '2026-03-10T12:15:00Z',
      sessions: 4,
      hours: 3
    }
  ])
}

{
  // The gap is measured from the end of the previous run, not its start - a
  // long run followed closely must not be split.
  const got = sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T11:00:00Z', 7200),
    run('2026-03-10T11:05:00Z', '2026-03-10T11:35:00Z', 1800)
  ])
  eq('the gap is measured from the previous end, not its start', got.length, 1)
}

{
  const got = sittings([
    run('2026-03-10T23:40:00Z', '2026-03-11T00:10:00Z', 1800),
    run('2026-03-11T00:20:00Z', '2026-03-11T00:50:00Z', 1800)
  ])
  eq('a sitting may cross midnight', got.length, 1)
  eq('and reports the span across it', got[0]?.endedAt, '2026-03-11T00:50:00Z')
}

// Two timer windows can run at once (CLAUDE.md, "Windows"), each with its own
// engine, so overlapping rows are expected input rather than a hypothetical.
// A nested row used to drag the sitting's end backwards; these are the cases
// that were wrong.

{
  // The minimal nested case: the second run starts later and ends earlier.
  const got = sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T12:00:00Z', 10800), // long run
    run('2026-03-10T09:30:00Z', '2026-03-10T09:45:00Z', 900) // nested inside it
  ])
  eq('a nested run joins the sitting rather than starting one', got.length, 1)
  eq(
    'a nested run does not move the sitting end backwards',
    got[0]?.endedAt,
    '2026-03-10T12:00:00Z'
  )
  eq('the nested run still counts towards the session count', got[0]?.sessions, 2)
  eq('and its seconds still count towards the hours', got[0]?.hours, 11700 / 3600)
}

{
  // The consequence of the old bug: a nested row shrank the end to 09:45, so
  // the next row's gap was measured from there (105 min) and split a sitting
  // that never broke. Measured from the true end (12:00) the gap is 5 min.
  const got = sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T12:00:00Z', 10800), // long run
    run('2026-03-10T09:30:00Z', '2026-03-10T09:45:00Z', 900), // nested
    run('2026-03-10T12:05:00Z', '2026-03-10T12:35:00Z', 1800) // 5 min after TRUE end
  ])
  eq('a row within the threshold of the TRUE end joins, despite a nested row', got.length, 1)
  eq('the sitting runs to the last real end', got[0]?.endedAt, '2026-03-10T12:35:00Z')
  eq('all three runs are counted', got[0]?.sessions, 3)
}

{
  // The same shape, but the following row is genuinely beyond the threshold of
  // the true end. The fix must not make everything merge.
  const got = sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T12:00:00Z', 10800),
    run('2026-03-10T09:30:00Z', '2026-03-10T09:45:00Z', 900), // nested
    run('2026-03-10T12:31:00Z', '2026-03-10T13:00:00Z', 1740) // 31 min after true end
  ])
  eq('a row beyond the threshold of the true end still splits', got.length, 2)
  eq('the first sitting keeps the true end', got[0]?.endedAt, '2026-03-10T12:00:00Z')
  eq('the first sitting holds the long run and the nested one', got[0]?.sessions, 2)
  eq('the second sitting is the later run alone', got[1]?.sessions, 1)
}

{
  // Several nested runs in a row, in the worst order: each one would have
  // pulled the end further back under the old behaviour.
  const got = sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T12:00:00Z', 10800),
    run('2026-03-10T11:30:00Z', '2026-03-10T11:45:00Z', 900),
    run('2026-03-10T09:30:00Z', '2026-03-10T09:40:00Z', 600), // ends earliest of all
    run('2026-03-10T10:00:00Z', '2026-03-10T10:05:00Z', 300)
  ])
  eq('several nested runs stay in one sitting', got.length, 1)
  eq('the end is the maximum of all of them', got[0]?.endedAt, '2026-03-10T12:00:00Z')
  eq('every run is counted once', got[0]?.sessions, 4)
  eq('hours sum across all four', got[0]?.hours, 12600 / 3600)
}

{
  // A run that starts at the same instant as the long one and ends earlier.
  // Sort order between equal starts is not guaranteed, so neither arrangement
  // may lose the later end.
  const long = run('2026-03-10T09:00:00Z', '2026-03-10T11:00:00Z', 7200)
  const short = run('2026-03-10T09:00:00Z', '2026-03-10T09:20:00Z', 1200)
  eq(
    'identical starts, long first: end is the later one',
    sittings([long, short])[0]?.endedAt,
    '2026-03-10T11:00:00Z'
  )
  eq(
    'identical starts, short first: end is still the later one',
    sittings([short, long])[0]?.endedAt,
    '2026-03-10T11:00:00Z'
  )
}

{
  // Real rows come from `new Date(ms).toISOString()`, so they always carry
  // milliseconds. The end comparison is a string compare, which is only
  // chronological while the format is uniform - pin that it is.
  const got = sittings([
    run('2026-03-10T09:00:00.000Z', '2026-03-10T12:00:00.000Z', 10800),
    run('2026-03-10T09:30:00.000Z', '2026-03-10T09:45:00.500Z', 900)
  ])
  eq('nesting is handled with millisecond ISO strings too', got.length, 1)
  eq(
    'the end stays the later timestamp with milliseconds present',
    got[0]?.endedAt,
    '2026-03-10T12:00:00.000Z'
  )
}

{
  // Two timers covering the same stretch, interleaved rather than nested:
  // neither contains the other, both overlap.
  const got = sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T10:30:00Z', 5400),
    run('2026-03-10T09:45:00Z', '2026-03-10T11:15:00Z', 5400)
  ])
  eq('interleaved overlapping runs are one sitting', got.length, 1)
  eq('ending at the later of the two', got[0]?.endedAt, '2026-03-10T11:15:00Z')
  eq('with both runs counted', got[0]?.sessions, 2)
}

eq(
  'hours are summed from seconds, not from the wall-clock span',
  sittings([
    run('2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z', 600), // 25 min paused
    run('2026-03-10T09:40:00Z', '2026-03-10T10:10:00Z', 600)
  ])[0]?.hours,
  1200 / 3600
)

// ------------------------------------------------------------- fillDays ----

section('fillDays()')

eq('from === to with no data gives one zero day', fillDays([], '2026-03-10', '2026-03-10'), [
  { date: '2026-03-10', hours: 0, sessions: 0 }
])

eq(
  'from === to with data gives that one day',
  fillDays([day('2026-03-10', 2, 3)], '2026-03-10', '2026-03-10'),
  [{ date: '2026-03-10', hours: 2, sessions: 3 }]
)

eq(
  'a gap in the middle becomes real zeroes',
  fillDays([day('2026-03-08', 1, 1), day('2026-03-11', 2, 2)], '2026-03-08', '2026-03-11'),
  [
    { date: '2026-03-08', hours: 1, sessions: 1 },
    { date: '2026-03-09', hours: 0, sessions: 0 },
    { date: '2026-03-10', hours: 0, sessions: 0 },
    { date: '2026-03-11', hours: 2, sessions: 2 }
  ]
)

eq(
  'days outside the range are dropped rather than appended',
  fillDays(
    [day('2026-03-01', 9), day('2026-03-09', 1), day('2026-03-20', 9)],
    '2026-03-09',
    '2026-03-10'
  ),
  [
    { date: '2026-03-09', hours: 1, sessions: 1 },
    { date: '2026-03-10', hours: 0, sessions: 0 }
  ]
)

eq(
  'unsorted input comes back sorted',
  fillDays([day('2026-03-10', 2), day('2026-03-08', 1)], '2026-03-08', '2026-03-10').map(
    (d) => d.date
  ),
  ['2026-03-08', '2026-03-09', '2026-03-10']
)

eq('to before from gives an empty range', fillDays([], '2026-03-10', '2026-03-09'), [])

{
  // Contiguous, ascending, no duplicates, right length - over a span that
  // crosses a year boundary and a leap day.
  const out = fillDays([day('2028-02-29', 4)], '2027-12-28', '2028-03-02')
  const dates = out.map((d) => d.date)

  eq('the range starts at `from`', dates[0], '2027-12-28')
  eq('the range ends at `to`', dates[dates.length - 1], '2028-03-02')
  eq('the length is the inclusive day count (4 + 31 + 29 + 2)', out.length, 66)
  check(
    'there are no duplicate dates',
    new Set(dates).size === dates.length,
    `${dates.length - new Set(dates).size} duplicate(s)`
  )
  check(
    'the dates ascend',
    dates.every((d, i) => i === 0 || d > dates[i - 1]),
    'a date was not greater than the one before it'
  )

  const contiguous = dates.every((d, i) => {
    if (i === 0) return true
    const previous = Date.parse(dates[i - 1] + 'T00:00:00Z')
    return Date.parse(d + 'T00:00:00Z') - previous === 86_400_000
  })
  check('every step is exactly one day', contiguous, 'a step was not 24h')

  check(
    'the leap day is present and carries its hours',
    out.some((d) => d.date === '2028-02-29' && d.hours === 4),
    '2028-02-29 missing or zeroed'
  )
  check(
    '2027-12-31 and 2028-01-01 are both present',
    dates.includes('2027-12-31') && dates.includes('2028-01-01'),
    'the year boundary dropped a day'
  )
}

{
  // The non-leap counterpart: 2026-02-29 does not exist, so the span is one
  // day shorter and must not contain it.
  const dates = fillDays([], '2026-02-27', '2026-03-02').map((d) => d.date)
  eq('a non-leap February runs 27, 28, then 1 March', dates, [
    '2026-02-27',
    '2026-02-28',
    '2026-03-01',
    '2026-03-02'
  ])
}

{
  // A year of days, to catch an arithmetic slip that only shows up at scale.
  const out = fillDays([], '2026-01-01', '2026-12-31')
  eq('a full non-leap year is 365 days', out.length, 365)
  check(
    'all 365 are distinct',
    new Set(out.map((d) => d.date)).size === 365,
    'duplicate dates in a full year'
  )
  eq('a full leap year is 366 days', fillDays([], '2028-01-01', '2028-12-31').length, 366)
}

check(
  'fillDays and streaks agree on the same filled range',
  (() => {
    const filled = fillDays(
      [day('2026-03-08', 1), day('2026-03-09', 1)],
      '2026-03-01',
      '2026-03-10'
    )
    const s = streaks(filled, '2026-03-10')
    return s.current === 2 && s.best === 2 && s.currentSince === '2026-03-08'
  })(),
  'a filled range fed to streaks did not read as a two-day streak'
)

// --------------------------------------------------------- plannedFit ------

section('--- plannedFit ---')

/** A planned-duration bucket, as `analytics()` hands them over. */
function bucket(plannedMinutes: number, sessions: number, actualMinutes: number): PlannedVsActual {
  return { plannedMinutes, sessions, actualMinutes }
}

eq('nothing to go on', plannedFit([], 8), null)

eq(
  'every bucket under the threshold is no answer, not a weak one',
  plannedFit([bucket(60, 7, 44), bucket(30, 3, 20)], 8),
  null
)

eq('a zero-length bucket is not a duration anyone set', plannedFit([bucket(0, 90, 0)], 8), null)

eq(
  'the busiest bucket answers, not the longest',
  plannedFit([bucket(180, 20, 130), bucket(60, 531, 45.1)], 8),
  { plannedMinutes: 60, sessions: 531, actualMinutes: 45.1, suggestedMinutes: 45 }
)

eq(
  'nor the first one listed',
  plannedFit([bucket(15, 9, 13.5), bucket(90, 462, 66.9)], 8)?.plannedMinutes,
  90
)

check(
  'the suggestion is the nearest five minutes, rounding up',
  plannedFit([bucket(60, 40, 43.1)], 8)?.suggestedMinutes === 45,
  'a 43.1 minute average should suggest 45'
)

check(
  'and rounding down',
  plannedFit([bucket(60, 40, 41.9)], 8)?.suggestedMinutes === 40,
  'a 41.9 minute average should suggest 40'
)

check(
  'a suggestion is never shorter than the shortest timer anyone sets',
  plannedFit([bucket(5, 24, 1.2)], 8)?.suggestedMinutes === 5,
  'rounding 1.2 to the nearest five is zero, which is not a timer'
)

check(
  'a length that matches what is run suggests itself',
  plannedFit([bucket(30, 50, 29.8)], 8)?.suggestedMinutes === 30,
  'a 30 that runs 29.8 should not be talked down'
)

eq(
  'a tie goes to the shorter length, whichever order it arrives in',
  [
    plannedFit([bucket(90, 20, 70), bucket(45, 20, 33)], 8)?.plannedMinutes,
    plannedFit([bucket(45, 20, 33), bucket(90, 20, 70)], 8)?.plannedMinutes
  ],
  [45, 45]
)

check(
  "the threshold is the caller's, so the panel and the sentence agree",
  plannedFit([bucket(60, 4, 45)], 8) === null && plannedFit([bucket(60, 4, 45)], 4) !== null,
  'the same data answered differently under the same minRuns'
)

// The real history, as it stood on 2026-11-05: 60 minutes is set 531 times,
// more than any other length, and those runs average 45.1 minutes. This is the
// sentence the panel prints, so it is worth pinning to the numbers it was
// written from.
eq(
  'the real history suggests 45 against a 60 set 531 times',
  plannedFit(
    [
      bucket(15, 239, 13.5),
      bucket(30, 324, 21.5),
      bucket(45, 265, 32.1),
      bucket(60, 531, 45.1),
      bucket(90, 462, 66.9),
      bucket(120, 252, 95.5),
      bucket(180, 165, 131.9)
    ],
    8
  ),
  { plannedMinutes: 60, sessions: 531, actualMinutes: 45.1, suggestedMinutes: 45 }
)

// ------------------------------------------------------- median ------------

section('--- median ---')

eq('nothing has no middle', median([]), null)
eq('one value is its own middle', median([4]), 4)
eq('an odd count takes the middle', median([5, 1, 3]), 3)
eq('an even count takes the mean of the middle two', median([1, 2, 3, 4]), 2.5)
eq('zeroes are values like any other', median([0, 0, 0, 9]), 0)

check(
  'the input is not reordered',
  (() => {
    const input = [3, 1, 2]
    median(input)
    return same(input, [3, 1, 2])
  })(),
  "median sorted its caller's array"
)

// ------------------------------------------------------- periodStats -------

section('--- periodStats ---')

/** A week of days, hours given oldest first. */
function week(hours: number[], from = '2026-03-02'): DayTotal[] {
  const start = Date.parse(from + 'T00:00:00Z')
  return hours.map((h, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    hours: h,
    sessions: h > 0 ? 1 : 0
  }))
}

check(
  'an empty day is a day, so it counts in both figures',
  (() => {
    // Seven days, one of them worked. Over worked days only this would read
    // 7 h mean and 7 h median; counting every day it is 1 h and 0 h.
    const s = periodStats(week([0, 0, 0, 7, 0, 0, 0]), '2026-03-02', '2026-03-08')
    return s.day.count === 7 && s.day.mean === 1 && s.day.median === 0
  })(),
  'the zeroes were dropped somewhere'
)

check(
  'days with no row at all count too, not just days recorded as zero',
  (() => {
    // One row in a seven-day span: the other six never appear in `daily`.
    const s = periodStats(
      [{ date: '2026-03-05', hours: 7, sessions: 1 }],
      '2026-03-02',
      '2026-03-08'
    )
    return s.day.count === 7 && s.day.mean === 1 && s.day.median === 0
  })(),
  'a missing day was not filled in as zero'
)

eq(
  'a week is seven days, and one of them is one whole week',
  (() => {
    const s = periodStats(week([1, 2, 3, 4, 5, 6, 7]), '2026-03-02', '2026-03-08')
    return [s.day.count, s.week.count, s.month.count, s.week.mean, s.week.median]
  })(),
  [7, 1, 0, 28, 28]
)

eq(
  'a span shorter than a week has no week to report',
  (() => {
    const s = periodStats(week([1, 2, 3]), '2026-03-02', '2026-03-04')
    return [s.week.count, s.week.mean, s.week.median]
  })(),
  [0, null, null]
)

check(
  'blocks are laid out from the end, so the part-period falls at the old edge',
  (() => {
    // Nine days; the hours sit in the two oldest. The single whole week is the
    // seven most recent days, which are empty - and the total still counts the
    // hours, because the total is the span and not the blocks.
    const s = periodStats(week([5, 5, 0, 0, 0, 0, 0, 0, 0]), '2026-03-02', '2026-03-10')
    return s.week.count === 1 && s.week.mean === 0 && s.totalHours === 10
  })(),
  'the dropped remainder was taken from the recent end, or folded into a block'
)

check(
  'an exact multiple drops nothing',
  (() => {
    const s = periodStats(week(Array(14).fill(1)), '2026-03-02', '2026-03-15')
    return s.week.count === 2 && s.week.mean === 7 && s.totalHours === 14
  })(),
  'fourteen days should be exactly two weeks'
)

check(
  'a month is thirty days, and the weeks inside it are four',
  (() => {
    const s = periodStats(week(Array(30).fill(2)), '2026-03-02', '2026-03-31')
    return s.month.count === 1 && s.month.mean === 60 && s.week.count === 4 && s.week.mean === 14
  })(),
  'thirty days should be one month and four whole weeks'
)

check(
  'days outside the span are ignored, not clipped into it',
  (() => {
    const rows = [
      { date: '2026-03-01', hours: 100, sessions: 1 },
      { date: '2026-03-05', hours: 7, sessions: 1 },
      { date: '2026-03-09', hours: 100, sessions: 1 }
    ]
    const s = periodStats(rows, '2026-03-02', '2026-03-08')
    return s.totalHours === 7 && s.day.count === 7
  })(),
  'a row either side of the span leaked in'
)

check(
  'two rows on one date are one day, summed',
  (() => {
    const rows = [
      { date: '2026-03-05', hours: 3, sessions: 1 },
      { date: '2026-03-05', hours: 4, sessions: 1 }
    ]
    const s = periodStats(rows, '2026-03-02', '2026-03-08')
    return s.day.count === 7 && s.totalHours === 7 && s.day.mean === 1
  })(),
  'a second row for the same date was dropped or counted as its own day'
)

check(
  'the mean of the day row is the same figure averagePerDay reports',
  (() => {
    // Not a coincidence worth leaving to chance: the stat row above the table
    // prints `averagePerDay` and the table prints this, and a reader comparing
    // the two must not find them disagreeing.
    const rows = week([1, 0, 4, 0, 0, 2, 0])
    const s = periodStats(rows, '2026-03-02', '2026-03-08')
    const byHand = rows.reduce((sum, d) => sum + d.hours, 0) / 7
    return s.day.mean !== null && Math.abs(s.day.mean - byHand) < 1e-9
  })(),
  'the day mean is not hours over calendar days'
)

// The real history as it stood on 2026-11-05, driven through this same
// function: 1,319 days from 2023-03-27, 2,750.91 hours, which is 2.09 h a day
// as a mean and 1.50 h as a median. The gap between those two is the point of
// the row - half the days are under an hour and a half, while the mean is
// pulled up by the heavy ones.
check(
  'the shape of the real history: a mean well above its median',
  (() => {
    const s = periodStats(
      [...week(Array(10).fill(0), '2026-01-01'), { date: '2026-01-11', hours: 12, sessions: 4 }],
      '2026-01-01',
      '2026-01-11'
    )
    return s.day.mean !== null && s.day.median === 0 && s.day.mean > s.day.median
  })(),
  'a long tail of empty days should pull the mean above the median'
)

// ---------------------------------------------------------------- report ---

console.log('')
console.log(`${passed}/${total} passed`)
process.exit(0)
