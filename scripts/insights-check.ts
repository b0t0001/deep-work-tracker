/**
 * Checks the insights card's arithmetic and the minimum sample of each
 * insight.
 *
 * Run:
 *   npx esbuild scripts/insights-check.ts --bundle --platform=node --format=esm \
 *     --outfile=<tmp>/i.mjs && node <tmp>/i.mjs
 *
 * Every insight is tested twice: once on a fixture built by hand so the
 * expected figure can be worked out on paper, and once one step below its
 * threshold, where it must not appear at all. The second half is the one that
 * matters - an insight that speaks from too little data is the failure the
 * thresholds exist to prevent, and it looks exactly like a working one.
 */
import type { SessionRow } from '../src/shared/analytics'
import {
  INSIGHT_MIN,
  biggestDay,
  buildInsights,
  consistency,
  editing,
  formatRate,
  hourWindow,
  hoursTotal,
  loopLength,
  longestSession,
  outputs,
  paceChanges,
  peakHours,
  periodPair,
  pickInsight,
  projectShift,
  sessionTrend,
  stoppedEarly,
  streak,
  streakInfo,
  topCourse,
  topProject,
  typicalDay,
  weekdayPattern,
  type InsightContext
} from '../src/shared/insights'
import { resolveLayout } from '../src/shared/layout'
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
function has(label: string, text: string | undefined, part: string): void {
  eq(label, (text?.includes(part) ?? false) ? part : text, part)
}

const DAY_MS = 86_400_000
function dateOf(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}
/** The date `n` days after 2026-01-04, which is a Sunday. */
function day(n: number): string {
  return dateOf(dayNumber('2026-01-04') + n)
}
function range(from: string, to: string): Range {
  return { from, to, days: dayNumber(to) - dayNumber(from) + 1 }
}

function row(date: string, minutes: number, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    date,
    project: 'HW',
    task: 'Work',
    plannedS: minutes * 60,
    runningS: minutes * 60,
    laps: 1,
    source: 'import',
    hour: null,
    unit: null,
    quantity: null,
    ...extra
  }
}

function ctx(rows: SessionRow[], r: Range | null = null, label = 'all time'): InsightContext {
  return { rows, range: r, label, today: '2027-01-01' }
}

console.log('--- small formatters ---')
eq('a window in one half of the day', hourWindow(21), '9–11 PM')
eq('a window across noon', hourWindow(11), '11 AM–1 PM')
eq('a window across midnight', hourWindow(23), '11 PM–1 AM')
eq('midnight is 12 AM', hourWindow(0), '12–2 AM')
eq('a fast rate reads per minute', formatRate(22.5, 'words'), '22.5 words a minute')
eq('a slow rate reads as one every N min', formatRate(0.5, 'questions'), 'one every 2 min')
eq('a very slow rate reads as hours each', formatRate(1 / 222, 'meetings'), '3.7 h each')

console.log('--- time of day: app-timed only, 20 sessions over 5 days ---')
{
  // 6 at 9 PM, 6 at 10 PM, 8 at 9 AM: the 9-11 PM window holds 12 of 20 hours.
  const timed: SessionRow[] = []
  for (let i = 0; i < 20; i += 1) {
    const hour = i < 6 ? 21 : i < 12 ? 22 : 9
    timed.push(row(day(i % 5), 60, { source: 'app', hour }))
  }
  const peak = peakHours(ctx(timed))
  eq('the busiest two hours are named', peak?.figure, '9–11 PM')
  has('their share is of timed hours', peak?.detail, '60% of your timed hours start then')
  eq('19 timed sessions say nothing', peakHours(ctx(timed.slice(1))), null)
  const fourDays = timed.map((r, i) => ({ ...r, date: day(i % 4) }))
  eq('20 sessions on 4 days say nothing', peakHours(ctx(fourDays)), null)
  // An imported or manual row carrying an hour must still not count.
  const borrowed = [
    ...timed.slice(1),
    row(day(0), 600, { source: 'import', hour: 3 }),
    row(day(0), 600, { source: 'manual', hour: 3 })
  ]
  eq('imported and manual rows never count, hour or not', peakHours(ctx(borrowed)), null)
  const flat = Array.from({ length: 24 }, (_, h) => row(day(h % 6), 60, { source: 'app', hour: h }))
  eq('a flat day has no peak worth naming', peakHours(ctx(flat)), null)
}

console.log('--- a typical working day: medians over 10 worked days ---')
{
  const rows: SessionRow[] = []
  for (let d = 0; d < 10; d += 1) for (const m of [20, 40, 60]) rows.push(row(day(d * 2), m))
  const typical = typicalDay(ctx(rows))
  eq('median sessions a day', typical?.figure, '3 sessions')
  has('median hours a worked day', typical?.text, 'and 2 h make a typical working day')
  has('median session length', typical?.detail, 'the middle session runs 40 min')
  has('says what the medians are over', typical?.detail, 'medians over 10 days with work')
  eq('9 worked days say nothing', typicalDay(ctx(rows.slice(3))), null)
}

console.log('--- weekday: calendar days, 8 weeks minimum ---')
{
  // 56 days from a Sunday: 3 h on each weekend day, 1 h on each weekday.
  const rows = Array.from({ length: 56 }, (_, i) => {
    const wd = i % 7
    return row(day(i), wd === 0 || wd === 6 ? 180 : 60)
  })
  const w = weekdayPattern(ctx(rows))
  eq('a weekend story is told as weekends', w?.figure, 'Weekends')
  has('weekend against weekday, per day', w?.text, '200% more a day than weekdays')
  has('both figures shown', w?.detail, '3.00 h a weekend day, 1.00 h a weekday')
  eq('55 days say nothing', weekdayPattern(ctx(rows.slice(0, 55))), null)

  // Mondays at 4 h, everything else 1 h: average is (8*4 + 48)/56 = 1.43 h.
  const mondays = Array.from({ length: 56 }, (_, i) => row(day(i), i % 7 === 1 ? 240 : 60))
  const m = weekdayPattern(ctx(mondays))
  eq('a weekday leader is named', m?.figure, 'Mondays')
  has('lift over the calendar-day average', m?.text, '180% above your average day')
  has('days off are counted in the average', m?.detail, '1.43 h across all days')

  const flat = Array.from({ length: 56 }, (_, i) => row(day(i), 60))
  eq('a flat week says nothing', weekdayPattern(ctx(flat)), null)
  const thin = Array.from({ length: 56 }, (_, i) => row(day(i), i % 7 === 1 ? 30 : 5))
  eq('under 10 hours says nothing', weekdayPattern(ctx(thin)), null)
}

console.log('--- top course: from the task text ---')
{
  const rows = [
    row(day(0), 60, { task: 'CIS 1200 HW01' }),
    row(day(1), 60, { task: 'Study for CIS 1200' }),
    row(day(2), 60, { task: 'CIS1200 practice' }),
    row(day(3), 90, { task: 'MATH 1410 pset' }),
    row(day(4), 600, { task: 'cis 1200 typed in lower case' })
  ]
  const c = topCourse(ctx(rows))
  eq('the course with the most hours', c?.figure, 'CIS 1200')
  has('with its hours and sessions', c?.detail, '3 h across 3 sessions')
  has('and the runner-up', c?.detail, 'next is MATH 1410 at 1.5 h')
  eq('2 sessions say nothing', topCourse(ctx(rows.slice(1))), null)
  eq('one course alone is not a ranking', topCourse(ctx(rows.slice(0, 3))), null)
}

console.log('--- top project: a share of the time ---')
{
  const rows = [
    row(day(0), 360, { project: 'HW' }),
    row(day(1), 240, { project: 'Job' }),
    row(day(1), 600, { project: null })
  ]
  const p = topProject(ctx(rows))
  eq('share of all hours, unlabelled included in the total', p?.figure, '30%')
  has('names the project', p?.text, 'went to HW')
  eq(
    'under 10 hours says nothing',
    topProject(ctx([row(day(0), 360, { project: 'HW' }), row(day(1), 180, { project: 'Job' })])),
    null
  )
  const even = ['A', 'B', 'C', 'D', 'E'].map((n, i) => row(day(i), 120, { project: n }))
  eq('no project at a quarter of the time says nothing', topProject(ctx(even)), null)
}

console.log('--- project shift: against the period before ---')
{
  const r = range(day(30), day(59))
  const rows = [
    row(day(0), 600, { project: 'A' }),
    row(day(1), 1200, { project: 'B' }),
    row(day(30), 1200, { project: 'A' }),
    row(day(31), 600, { project: 'B' })
  ]
  const s = projectShift(ctx(rows, r, 'past 30 days'))
  eq('the change in share, in points', s?.figure, '+33 pts')
  has('both shares', s?.text, "A's share of your time rose from 33% to 67%")
  has('which periods', s?.detail, 'the past 30 days against the 30 days before')
  const late = rows.map((x) => ({ ...x, date: dateOf(dayNumber(x.date) + 1) }))
  eq(
    'a history that does not reach the earlier period says nothing',
    projectShift(ctx(late.slice(2), r, 'past 30 days')),
    null
  )
  const small = rows.map((x) => ({ ...x, runningS: x.runningS / 2 }))
  eq('under 20 hours a side says nothing', projectShift(ctx(small, r, 'past 30 days')), null)
  eq(
    'all time compares the past year with the year before',
    periodPair([row('2024-01-01', 1), row('2026-01-01', 1)], null, 'all time')?.then,
    { from: '2024-01-03', to: '2025-01-01', days: 365 }
  )
}

console.log('--- pace: one unit, one course, five sessions a side ---')
{
  const q = (n: number, minutes: number, extra: Partial<SessionRow> = {}): SessionRow =>
    row(day(n), minutes, { unit: 'question', quantity: 10, task: 'MATH 1410 pset', ...extra })
  const rows = [
    ...[0, 1, 2, 3, 4].map((n) => q(n, 60)),
    ...[5, 6, 7, 8, 9].map((n) => q(n, 30)),
    // None of these may move the MATH 1410 figure.
    q(5, 1, { task: 'CIS 1200 pset', quantity: 500 }),
    q(6, 30, { unit: 'word', quantity: 5000 }),
    q(7, 4, { quantity: 100 }),
    q(8, 30, { source: 'manual', quantity: 100 })
  ]
  const p = paceChanges(ctx(rows))
  eq('one comparison, for the one pair with enough', p.length, 1)
  eq('pooled rate doubled', p[0]?.figure, '+100%')
  has('names unit and course', p[0]?.text, 'pace on MATH 1410 questions')
  has('both rates', p[0]?.detail, 'one every 3 min lately, one every 6 min at first')
  eq('four sessions a side say nothing', paceChanges(ctx(rows.slice(1))).length, 0)
  const steady = [...[0, 1, 2, 3, 4].map((n) => q(n, 60)), ...[5, 6, 7, 8, 9].map((n) => q(n, 55))]
  eq('a 9% change says nothing', paceChanges(ctx(steady)).length, 0)
}

console.log('--- timers stopped early, and loops ---')
{
  const runs = [
    ...Array.from({ length: 15 }, (_, i) => row(day(i), 30, { plannedS: 3600 })),
    ...Array.from({ length: 5 }, (_, i) => row(day(i), 60, { plannedS: 3600 })),
    row(day(0), 60, { source: 'manual', plannedS: 7200 }),
    row(day(0), 300)
  ]
  const s = stoppedEarly(ctx(runs))
  eq('share stopped before the end', s?.figure, '75%')
  has('median share of the time set', s?.detail, 'a typical run used 50% of the time set')
  has('manual rows and events left out', s?.detail, '15 of 20 single-lap runs')
  eq('19 runs say nothing', stoppedEarly(ctx(runs.slice(1, 20))), null)

  const loops = [1.5, 2, 2.5].map((x, i) =>
    row(day(i), 45 * x, { plannedS: 45 * 60, laps: Math.ceil(x), task: `Loop ${i}` })
  )
  const l = loopLength(ctx(loops))
  eq('median laps run', l?.figure, '2 laps')
  has('and the longest', l?.detail, 'longest 2.5 laps on "Loop 2"')
  eq('two loops say nothing', loopLength(ctx(loops.slice(1))), null)
}

console.log('--- streaks and consistency ---')
{
  const dates = [0, 1, 2, 4, 5, 6, 7, 8].map(day)
  const s = streakInfo(dates, day(9))
  eq('longest and current, today not yet worked', s, {
    best: 5,
    bestEnd: day(8),
    current: 5,
    currentSince: day(4)
  })
  const rows = dates.map((d) => row(d, 30))
  const on = streak({ ...ctx(rows), today: day(9) })
  has('the current streak is the longest', on?.text, 'in a row and counting')
  const off = streak({ ...ctx(rows), today: day(20) })
  has('a past streak says where it ended', off?.text, `ending ${day(8).slice(5, 7)}/`)
  eq('a 2-day streak says nothing', streak(ctx([row(day(0), 30), row(day(1), 30)])), null)

  const r = range(day(0), day(13))
  const half = [0, 2, 4, 6, 8, 10, 12].map((n) => row(day(n), 30))
  const c = consistency(ctx(half, r, 'past 2 weeks'))
  eq('share of calendar days worked', c?.figure, '50%')
  has('counted over the range', c?.detail, '7 of 14 days')
  eq('13 days say nothing', consistency(ctx(half, range(day(0), day(12)), 'x')), null)
}

console.log('--- records ---')
{
  const rows = [1, 1, 2, 2].map((h, i) => row(day(i), h * 60))
  rows.push(row(day(4), 120, { project: 'Job' }), row(day(4), 240, { project: 'Job' }))
  const b = biggestDay(ctx(rows))
  eq('biggest day', b?.figure, '6 h')
  has('against the median worked day', b?.detail, '3× a typical working day of 2 h')
  has('and what it was mostly', b?.detail, 'mostly Job')
  eq('4 worked days say nothing', biggestDay(ctx(rows.slice(1))), null)
  eq(
    'the longest session is shown when it is not the whole biggest day',
    longestSession(ctx(rows))?.figure,
    '4 h'
  )
  const alone = [1, 1, 2, 2, 6].map((h, i) => row(day(i), h * 60))
  eq('a biggest day that is one session is not told twice', longestSession(ctx(alone)), null)
}

console.log('--- output, hours, editing ---')
{
  const rows = [
    ...Array.from({ length: 5 }, (_, i) =>
      row(day(i), 60, { unit: 'word', quantity: 36_000, task: 'Write essay' })
    ),
    ...Array.from({ length: 5 }, (_, i) => row(day(i), 20, { unit: 'question', quantity: 10 })),
    ...Array.from({ length: 4 }, (_, i) => row(day(i), 20, { unit: 'slide', quantity: 100 })),
    ...Array.from({ length: 6 }, (_, i) => row(day(i), 20, { unit: 'second', quantity: 100 }))
  ]
  const o = outputs(ctx(rows))
  const words = o.find((i) => i.id === 'unit:word')
  eq('words exact', words?.figure, '180,000')
  has('as novels, with the basis stated', words?.text, "2 novels' worth")
  has('the basis', words?.detail, 'at 90,000 words a novel')
  const qs = o.find((i) => i.id === 'unit:question')
  has(
    'another unit gets its own pace',
    qs?.text,
    'questions answered, one every 2 min of work on them'
  )
  eq(
    'a unit used 4 times is left out',
    o.some((i) => i.id === 'unit:slide'),
    false
  )
  eq(
    'a unit of time is left out',
    o.some((i) => i.id === 'unit:second'),
    false
  )

  const h = hoursTotal(ctx([row(day(0), 80 * 60)]))
  has('hours in work weeks', h?.text, '2 forty-hour work weeks')
  has(
    'a short total as a share of one',
    hoursTotal(ctx([row(day(0), 20 * 60)]))?.text,
    '50% of a forty-hour work week'
  )

  const edits = [
    row(day(0), 30, { task: 'Edit video' }),
    row(day(1), 30, { task: 'editing' }),
    row(day(2), 30, { task: 'Edit thumbnail' }),
    row(day(3), 600, { task: 'Credit card forms' })
  ]
  const e = editing(ctx(edits))
  eq('editing hours, "credit" not counted', e?.figure, '1.5 h')
  has('as a share of all time', e?.text, '13% of all your time')
  eq('two edit sessions say nothing', editing(ctx(edits.slice(1))), null)
}

console.log('--- session length trend ---')
{
  const r = range(day(30), day(59))
  const rows = [
    ...Array.from({ length: 15 }, (_, i) => row(day(i), 30)),
    ...Array.from({ length: 15 }, (_, i) => row(day(30 + i), 60))
  ]
  const t = sessionTrend(ctx(rows, r, 'past 30 days'))
  eq('the median session now', t?.figure, '60 min')
  has('against before', t?.text, 'up from 30 min')
  eq('14 sessions a side say nothing', sessionTrend(ctx(rows.slice(1), r, 'past 30 days')), null)
  const close = rows.map((x, i) => (i >= 15 ? { ...x, runningS: 33 * 60 } : x))
  eq('a 10% change says nothing', sessionTrend(ctx(close, r, 'past 30 days')), null)
}

console.log('--- the range is respected ---')
{
  const rows = [
    row(day(0), 600, { project: 'Old' }),
    row(day(40), 360, { project: 'HW' }),
    row(day(41), 300, { project: 'Job' })
  ]
  const p = topProject(ctx(rows, range(day(30), day(59)), 'past 30 days'))
  has('rows outside the range are not counted', p?.detail, '6 h of 11 h')
}

console.log('--- each insight reads its own window, and says which ---')
{
  // 400 days, so the year windows are full. HW exists only in the last 30
  // days (windows end yesterday: days 370-399), so naming it proves the
  // "now" insight read that window rather than all time, where Old leads.
  const rows: SessionRow[] = []
  for (let d = 0; d < 400; d += 1)
    rows.push(
      row(day(d), d % 7 === 0 ? 240 : 45, {
        project: d >= 370 ? (d % 3 ? 'HW' : 'Job') : d % 2 ? 'Old' : 'Job'
      })
    )
  const list = buildInsights({ rows, today: day(400) })
  const byId = new Map(list.map((x) => [x.id, x]))
  const top = byId.get('top-project')
  has('what is taking your time now is the past 30 days', top?.detail, 'past 30 days · ')
  has('and over those 30 days it is the recent project', top?.text, 'went to HW')
  has('a record is all time', byId.get('biggest-day')?.detail, 'all time · ')
  has('a streak is all time', byId.get('streak')?.detail, 'all time · ')
  has('a habit is the past 12 months', byId.get('stopped-early')?.detail, 'past 12 months · ')
  has('consistency is the past 12 months', byId.get('consistency')?.detail, '365 of 365 days')
  has('a typical day is the past 90 days', byId.get('typical-day')?.detail, 'past 90 days · ')
  has('the total says since, once', byId.get('total')?.detail, 'since ')
  eq('and is not also labelled all time', byId.get('total')?.detail.startsWith('all time'), false)
  eq(
    'no sentence carries a window of its own',
    list.filter((x) => x.text.includes(' over the past')).map((x) => x.id),
    []
  )
  eq(
    'every detail line names its window',
    list
      .filter((x) => !/^(all time|past \d+ (days|months)) · |since |the past /.test(x.detail))
      .map((x) => x.id),
    []
  )
}

console.log('--- an old stored range for the card is ignored ---')
{
  const resolved = resolveLayout({ ranges: { fact: '1w', baseline: '1m' } })
  eq('the card has no stored range', 'fact' in resolved.ranges, false)
  eq('the baseline keeps its own', resolved.ranges.baseline, '1m')
}

console.log('--- the list and the choosing ---')
{
  eq('an empty history has no insights', buildInsights({ rows: [], today: day(0) }), [])
  const rows: SessionRow[] = []
  for (let d = 0; d < 120; d += 1) {
    rows.push(
      row(day(d), d % 7 === 0 ? 240 : 45, {
        project: d % 3 === 0 ? 'HW' : 'Job',
        task: 'Edit things'
      })
    )
  }
  const list = buildInsights({ rows, today: day(120) })
  eq('several insights from a plain history', list.length >= 6, true)
  eq(
    'strongest first',
    list.every((x, i) => i === 0 || list[i - 1].strength >= x.strength),
    true
  )
  eq('ids are unique', new Set(list.map((x) => x.id)).size, list.length)
  let repeats = 0
  for (let i = 0; i < 200; i += 1)
    if (pickInsight(list, i / 200, list[0].id)?.id === list[0].id) repeats += 1
  eq('the one shown last is never opened on again', repeats, 0)
  const seen = new Set<string>()
  for (let i = 0; i < 2000; i += 1) seen.add(pickInsight(list, i / 2000)!.id)
  eq('every insight can be opened on', seen.size, list.length)
  eq(
    'one insight is still shown when it was the last',
    pickInsight([list[0]], 0.5, list[0].id)?.id,
    list[0].id
  )
  eq('nothing to pick', pickInsight([], 0.5), null)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)

// Thresholds are referenced so a renamed one fails to compile here rather
// than silently testing a stale edge.
void INSIGHT_MIN.timedSessions
