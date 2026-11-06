/**
 * Checks the stat-row maths: selectable windows, the first-year baseline,
 * period-over-period, and the fun facts.
 *
 * Run:
 *   npx esbuild scripts/stats-check.ts --bundle --platform=node --format=esm \
 *     --outfile=<tmp>/s.mjs && node <tmp>/s.mjs
 *
 * The cases that matter are the ones where a motivational number could be
 * quietly wrong in the flattering direction: a window that includes today, a
 * baseline that moves, an average over worked days instead of calendar days.
 */
import { periodOverPeriod, weekOverWeek, type DayTotal } from '../src/shared/analytics'
import {
  WINDOWS,
  aboveBaseline,
  averagePerDay,
  baseline,
  windowDef,
  windowRange
} from '../src/shared/windows'
import {
  buildFacts,
  formatCount,
  formatHours,
  pickFact,
  pluralUnit,
  verbFor,
  type FactSource
} from '../src/shared/facts'

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
function near(label: string, actual: number | null, expected: number, tol = 1e-6): void {
  const ok = actual !== null && Math.abs(actual - expected) < tol
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) console.log('        expected ' + expected + '  actual ' + actual)
}

const day = (date: string, hours: number): DayTotal => ({ date, hours, sessions: 1 })

console.log('--- windows ---')
eq('ids are unique', new Set(WINDOWS.map((w) => w.id)).size, WINDOWS.length)
eq(
  'the user list is all there',
  WINDOWS.map((w) => w.id),
  // '3m' joined the ladder when the comparison box needed 90 days. It is in
  // the shared list rather than a private one so that "past 90 days" covers
  // the same 90 days wherever it is chosen.
  ['1w', '2w', '1m', '8w', '3m', '1y', '2y', 'all']
)
eq('8 weeks is 56 days, not two calendar months', windowDef('8w').days, 56)

eq('a week ends yesterday, never today', windowRange('1w', '2026-11-05', '2023-03-27'), {
  from: '2026-10-29',
  to: '2026-11-04',
  days: 7
})
eq(
  'clamped to the first session rather than inventing zeroes',
  windowRange('2y', '2026-11-05', '2026-06-01'),
  { from: '2026-06-01', to: '2026-11-04', days: 157 }
)
eq('all time starts at the first session', windowRange('all', '2026-11-05', '2026-11-01'), {
  from: '2026-11-01',
  to: '2026-11-04',
  days: 4
})
eq('no history, no range', windowRange('1w', '2026-11-05', null), null)
eq('first session today: no complete day yet', windowRange('1w', '2026-11-05', '2026-11-05'), null)
eq('across a month boundary', windowRange('1w', '2026-03-03', '2020-01-01'), {
  from: '2026-02-24',
  to: '2026-03-02',
  days: 7
})

console.log('')
console.log('--- averagePerDay: calendar days, not worked days ---')
const sparse = [day('2026-11-01', 7), day('2026-11-03', 7), day('2026-11-05', 99)]
const r = windowRange('1w', '2026-11-05', '2026-01-01')!
const avg = averagePerDay(sparse, r)
eq('today is excluded from the hours', avg.hours, 14)
near('divides by 7 calendar days, not 2 worked', avg.perDay, 2)
eq(
  'an empty range is zero, not NaN',
  averagePerDay([], { from: '2026-01-01', to: '2026-01-01', days: 0 }).perDay,
  0
)

console.log('')
console.log('--- baseline: the first 365 days, fixed ---')
const history: DayTotal[] = []
// First year: 1 h every day. After that: 4 h every day.
const start = Date.UTC(2023, 2, 27)
for (let i = 0; i < 800; i++) {
  const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
  history.push(day(date, i < 365 ? 1 : 4))
}
const base = baseline(history, '2023-03-27')
near('first-year average is 1 h a day', base?.perDay ?? null, 1)
eq('it covers exactly 365 days', base?.days, 365)
near('+300% above baseline at 4 h a day', aboveBaseline(4, base), 300)
near('-50% is allowed to be negative', aboveBaseline(0.5, base), -50)

// Adding a terrible recent stretch must not move the baseline at all.
const worse = history.concat(
  Array.from({ length: 30 }, (_, i) =>
    day(new Date(start + (800 + i) * 86_400_000).toISOString().slice(0, 10), 0)
  )
)
near(
  'a bad month later does not move the baseline',
  baseline(worse, '2023-03-27')?.perDay ?? null,
  1
)
eq('under a year of history has no baseline', baseline(history.slice(0, 200), '2023-03-27'), null)
eq('no history, no baseline', baseline([], null), null)
eq(
  'a zero baseline gives null, not Infinity',
  aboveBaseline(3, { hours: 0, days: 365, perDay: 0 }),
  null
)
eq('no baseline gives null', aboveBaseline(3, null), null)

console.log('')
console.log('--- periodOverPeriod ---')
const pp = periodOverPeriod(history, '2025-06-01', 7)
eq('weekOverWeek is the 7-day case', weekOverWeek(history, '2025-06-01'), pp)
const p14 = periodOverPeriod(
  [day('2026-11-04', 2), day('2026-10-22', 1), day('2026-10-21', 1)],
  // Callers pass the last complete day, as they do for weekOverWeek.
  '2026-11-04',
  14
)
eq('a 14-day period ending 11-04 puts 10-22 in the current half', p14.thisWeek, 3)
eq('and 10-21 in the previous half', p14.lastWeek, 1)
eq('per worked day: 3 h over 2 days', p14.thisWeekPerDay, 1.5)

console.log('')
console.log('--- pluralUnit ---')
eq('word', pluralUnit('word', 292358), 'words')
eq('one of something stays singular', pluralUnit('question', 1), 'question')
eq('0.6 rounds to 1, singular', pluralUnit('slide', 0.6), 'slide')
eq('activity', pluralUnit('activity', 3), 'activities')
eq('the stored typo still comes out right', pluralUnit('activitie', 60), 'activities')
eq('day keeps its y', pluralUnit('day', 3), 'days')
eq('box', pluralUnit('box', 3), 'boxes')
eq('a typed phrase is left exactly alone', pluralUnit('seconds edited', 2748), 'seconds edited')

console.log('')
console.log('--- formatHours ---')
eq('long figures are whole', formatHours(760.4), '760 h')
eq('thousands are grouped', formatHours(2751.07), '2,751 h')
eq('short ones keep a decimal', formatHours(2.46), '2.5 h')

console.log('')
console.log('--- buildFacts ---')
const empty: FactSource = {
  unitTotals: [],
  byProject: [],
  longestSession: null,
  daily: [],
  editingHours: 0,
  totalHours: 0,
  firstDate: null,
  unitTasks: {}
}
eq('an empty history has no facts, not "0 words written"', buildFacts(empty), [])

const real: FactSource = {
  // Real task strings, so the verb rules are exercised against the history
  // they were derived from rather than against invented examples.
  unitTasks: {
    question: ['Bio', 'A2TH', 'ID Activity', 'Bio HW: Worksheet'],
    word: ['English', 'English Background Notes', 'Officer Applications for Scioly'],
    video: ['Create a Video', 'Record 2 Videos', 'Edit and Release 3 Videos'],
    page: ['Read 三体', '读三体', '三体', 'Bio Workbook']
  },
  unitTotals: [
    { unit: 'question', quantity: 16550.3, sessions: 775 },
    { unit: 'word', quantity: 292358, sessions: 526 },
    { unit: 'video', quantity: 145.5, sessions: 42 },
    { unit: 'seconds edited', quantity: 2748, sessions: 11 },
    { unit: 'thumbnail', quantity: 300, sessions: 2 },
    { unit: 'assignment', quantity: 36, sessions: 16 },
    { unit: 'second', quantity: 5250, sessions: 37 }
  ],
  byProject: [
    { name: 'College Apps', hours: 446, sessions: 300 },
    { name: 'HW', hours: 760, sessions: 900 }
  ],
  longestSession: { date: '2026-01-17', task: 'Competition', project: 'Scioly', hours: 15 },
  daily: [day('2026-01-17', 15), day('2026-01-18', 2)],
  editingHours: 12.3,
  totalHours: 2751.07,
  firstDate: '2023-03-27'
}
const facts = buildFacts(real)
const byId = Object.fromEntries(facts.map((f) => [f.id, f]))
eq('words get their verb', byId['unit:word'], {
  id: 'unit:word',
  value: '292,358',
  label: 'words written',
  detail: 'across 526 sessions'
})
eq(
  // Exact, at the user's insistence - "no. big numbers should always be
  // exact" - so the stored .3 of a question survives rather than being
  // rounded away.
  'questions are answered, and counted exactly',
  byId['unit:question']?.label + ' ' + byId['unit:question']?.value,
  'questions answered 16,550.3'
)
// This assertion used to be the opposite: that a unit the map did not know
// stayed a plain count. "285 components" is precisely what the user objected
// to, so there is no longer any such case - `video` is in the map, and
// anything that is not falls through to "done".
eq('a unit the map knows takes its verb', byId['unit:video']?.label, 'videos made')
eq('a typed phrase is not given a verb', byId['unit:seconds edited']?.label, 'seconds edited')
eq('a rarely-used unit is not a fact', byId['unit:thumbnail'], undefined)
eq('a small total is not a fact', byId['unit:assignment'], undefined)
eq('a bare time unit is not output', byId['unit:second'], undefined)
eq(
  'total hours, dated MM/DD/YYYY',
  [byId.total?.value, byId.total?.detail],
  ['2,751 h', 'since 03/27/2023']
)
eq('longest session names the task and date', byId.longest?.detail, '"Competition", 01/17/2026')
eq(
  'the biggest day is dropped when it is just the longest session again',
  byId['biggest-day'],
  undefined
)
eq('the top project is by hours, not list order', byId['top-project']?.label, 'on HW')
eq('editing says how it was counted', byId.editing?.detail, 'on tasks with "edit" in the name')

const twoDays = buildFacts({ ...real, daily: [day('2026-01-17', 15), day('2026-02-01', 16.5)] })
eq(
  'a biggest day that differs from the longest session is kept',
  twoDays.find((f) => f.id === 'biggest-day')?.detail,
  '02/01/2026'
)
eq(
  'no editing hours, no editing fact',
  buildFacts({ ...real, editingHours: 0 }).some((f) => f.id === 'editing'),
  false
)

console.log('')
console.log('--- verbFor: what was actually done ---')

/*
 * The task strings here are real ones from the user's history, not invented
 * examples. That matters for `page` in particular: the rule is deciding
 * between a novel read in Chinese and a Bio workbook worked through, and a
 * made-up sentence would not tell us whether it can.
 */
eq('a unit with one obvious verb takes it', verbFor('component'), 'CADded')
eq('and case and spacing do not matter', verbFor('  Component '), 'CADded')
eq('an unknown unit is never left bare', verbFor('widget'), 'done')
eq('a unit typed as a phrase already carries its verb', verbFor('seconds edited'), '')
eq(
  'pages of a novel are read',
  verbFor('page', ['Read 三体', '读三体', '三体', 'Bio Workbook']),
  'read'
)
eq(
  'pages of an essay are written',
  verbFor('page', ['Write College Essay', 'Draft Supplement', 'Outline Report', 'Read Prompt']),
  'written'
)
eq('and with nothing to go on it does not guess', verbFor('page', []), 'done')
eq(
  'a single reading task does not flip sixty written ones',
  verbFor('page', ['Write Essay', 'Write Notes', 'Draft Report', 'Review Answers']),
  'written'
)
eq('tests that were graded', verbFor('test', ['Grade XPD Tests', 'Grade Ecology Tests']), 'graded')
eq('tests that were taken', verbFor('test', ['Finish CSE Test', 'Conduct Tests']), 'taken')

console.log('')
console.log('--- formatCount: exact, always ---')

/*
 * "no. big numbers should always be exact". An earlier version printed
 * "nearly 300k words", which reads well and throws away the figure the card
 * exists to show.
 */
eq('a big number keeps every digit', formatCount(292358), '292,358')
eq('and is never abbreviated', formatCount(296412), '296,412')
eq('a fractional quantity keeps its precision', formatCount(1975.5), '1,975.5')
eq('with trailing zeros trimmed', formatCount(284.0), '284')
eq('and a small one is just itself', formatCount(92), '92')

console.log('')
console.log('--- pickFact ---')
eq('nothing to pick', pickFact([], 0.5), null)
eq('the lowest random picks the first', pickFact(facts, 0)?.id, facts[0].id)
eq('a random of 1 does not run off the end', pickFact(facts, 1)?.id, facts[facts.length - 1].id)
let repeats = 0
for (let i = 0; i < 200; i++) {
  if (pickFact(facts, i / 200, facts[0].id)?.id === facts[0].id) repeats += 1
}
eq('the fact shown last time never comes up twice running', repeats, 0)
eq('with one fact, it is still shown', pickFact([facts[0]], 0.5, facts[0].id)?.id, facts[0].id)
const seen = new Set<string>()
for (let i = 0; i < 1000; i++) seen.add(pickFact(facts, i / 1000)!.id)
eq('every fact is reachable', seen.size, facts.length)

console.log('')
console.log(`stats: ${pass} passed, ${fail} failed`)
