/**
 * Checks the Constellation panel's geometry, `shared/constellation.ts`.
 *
 * Run:
 *   npx esbuild scripts/constellation-check.ts --bundle --platform=node \
 *     --format=esm --outfile=<tmp>/c.mjs && node <tmp>/c.mjs
 *
 * Each rule is checked against a fixture small enough to work out by hand,
 * and the ones that decide what a line or a size *means* - sittings, the
 * within-unit percentile - are checked from the negative side as well: the
 * join that must not be drawn, the comparison across units that must not
 * happen. A cloud that draws a false line looks exactly like one that draws a
 * true one.
 */
import {
  CORE,
  HEIGHT,
  MAX_ARMS,
  MIN_WIDTH,
  RADIUS,
  armColours,
  colourRanks,
  buildConstellation,
  buildLinks,
  buildWedges,
  chronological,
  hash01,
  heightOf,
  outputPercentiles,
  ringDates,
  ringGrain,
  ringLabel,
  unitKey,
  type StarRow
} from '../src/shared/constellation'

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
function near(label: string, actual: number, expected: number, tol = 1e-9): void {
  const ok = Math.abs(actual - expected) <= tol
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) console.log(`        expected ${expected}  actual ${actual}`)
}

let nextId = 1
function row(p: Partial<StarRow>): StarRow {
  return {
    id: nextId++,
    date: '2026-01-01',
    project: 'HW',
    task: null,
    runningS: 1800,
    unit: null,
    quantity: null,
    source: 'import',
    startMs: null,
    endMs: null,
    ...p
  }
}
const at = (iso: string): number => Date.parse(iso)

console.log('--- units ---')
eq('plural and singular are one unit', unitKey('Questions'), unitKey('question'))
eq('-ies plurals', unitKey('activities'), 'activity')
eq('-es after a sibilant', unitKey('boxes'), 'box')
eq('a phrase is left whole', unitKey('seconds edited'), 'seconds edited')
eq('"class" is not a plural', unitKey('class'), 'class')

console.log('')
console.log('--- output is ranked within its own unit only ---')
{
  nextId = 1
  const rows = [
    row({ unit: 'word', quantity: 100 }), // 1
    row({ unit: 'words', quantity: 300 }), // 2
    row({ unit: 'word', quantity: 200 }), // 3
    row({ unit: 'question', quantity: 5 }), // 4
    row({ unit: 'questions', quantity: 50 }), // 5
    row({ unit: 'slide', quantity: 9 }), // 6
    row({ unit: 'cell', quantity: 4 }), // 7
    row({ unit: 'cell', quantity: 4 }), // 8
    row({ unit: 'cell', quantity: 8 }), // 9
    row({ unit: null, quantity: null }), // 10
    row({ unit: 'word', quantity: null }) // 11
  ]
  const p = outputPercentiles(rows)
  eq('words: 100 < 200 < 300', [p.get(1), p.get(3), p.get(2)], [0, 0.5, 1])
  // 5 questions is the smallest question session, so it ranks 0 - even though
  // 5 is larger than nothing in the word list. Across units nothing compares.
  eq('questions ranked among questions', [p.get(4), p.get(5)], [0, 1])
  eq('a unit seen once sits in the middle', p.get(6), 0.5)
  eq('ties share a rank', [p.get(7), p.get(8), p.get(9)], [0.25, 0.25, 1])
  eq('no output has no percentile', [p.has(10), p.has(11)], [false, false])
}

console.log('')
console.log('--- arms ---')
{
  nextId = 1
  const rows = [
    row({ project: 'HW', runningS: 3600 * 6 }),
    row({ project: 'Startup', runningS: 3600 * 3 }),
    row({ project: 'Job', runningS: 3600 * 1 })
  ]
  const w = buildWedges(rows)
  eq(
    'largest first',
    w.map((x) => x.label),
    ['HW', 'Startup', 'Job']
  )
  near(
    'the circle is filled exactly',
    w.reduce((s, x) => s + x.width, 0),
    Math.PI * 2
  )
  near('they tile without overlap', w[1].start, w[0].width)
  near('widths are proportional to hours', w[0].width / w[1].width, 2)
  eq(
    'nothing pooled with three projects',
    w.some((x) => x.other),
    false
  )
}
{
  nextId = 1
  // 12 projects: one big, eleven small. More than MAX_ARMS, so the small ones pool.
  const rows = [row({ project: 'Big', runningS: 3600 * 100 })]
  for (let i = 0; i < 11; i += 1)
    rows.push(row({ project: `P${i}`, runningS: 3600 * (1 + i * 0.01) }))
  const w = buildWedges(rows)
  eq('no more than MAX_ARMS arms', w.length <= MAX_ARMS, true)
  eq('the small projects are pooled into Other', w[w.length - 1].other, true)
  eq('every project is somewhere', w.flatMap((x) => x.projects).length, 12)
  eq(
    'a pooled arm is never narrower than the floor',
    w.every((x) => x.width >= MIN_WIDTH - 1e-12),
    true
  )
  near(
    'still exactly a circle',
    w.reduce((s, x) => s + x.width, 0),
    Math.PI * 2
  )
}
{
  nextId = 1
  // Few enough projects that all fit: even a tiny one is an arm of its own,
  // held at the floor width rather than pooled.
  const rows: StarRow[] = []
  for (let i = 0; i < MAX_ARMS - 1; i += 1)
    rows.push(row({ project: `P${i}`, runningS: 3600 * (20 - i) }))
  rows.push(row({ project: 'Tiny', runningS: 60 }))
  const w = buildWedges(rows)
  eq(
    'with MAX_ARMS projects nothing is pooled',
    w.some((x) => x.other),
    false
  )
  eq(
    'the tiny one is listed under its own name',
    w.some((x) => x.label === 'Tiny'),
    true
  )
  near('at the floor width', w.find((x) => x.label === 'Tiny')?.width ?? 0, MIN_WIDTH)
}
{
  nextId = 1
  // A pool of one is not a pool. Unlabelled is the only thing that would go
  // into Other here, so it is drawn under its own name instead.
  const w = buildWedges([row({ project: 'HW', runningS: 7200 }), row({ project: null })])
  eq(
    'a pool of one keeps its own name',
    w.some((x) => x.other),
    false
  )
}
{
  nextId = 1
  const w = buildWedges([row({ project: null }), row({ project: '  ' }), row({ project: 'HW' })])
  eq('blank and null projects are one Unlabelled group', w.map((x) => x.label).sort(), [
    'HW',
    'Unlabelled'
  ])
}

console.log('')
console.log('--- height ---')
near('2 min sits on the floor', heightOf(120), 0)
near('8 h sits at the top', heightOf(8 * 3600), 1)
eq('longer than the scale is clamped, not off it', heightOf(20 * 3600), 1)
eq('a zero-length run is on the floor', heightOf(0), 0)
eq('log, not linear: 1 h is above the middle of 2 min..8 h', heightOf(3600) > 0.5, true)
{
  // Geometric midpoint of 2 and 480 minutes is sqrt(960) = 30.98 min.
  near('the geometric midpoint is half way up', heightOf(Math.sqrt(2 * 480) * 60), 0.5, 1e-9)
}

console.log('')
console.log('--- sittings ---')
{
  nextId = 1
  const ordered = chronological([
    // App rows on one day: A ends 10:00, B starts 10:20 (joined), C starts
    // 11:00 after B ended 10:40 (20 min, joined), D starts 12:00 after 11:20
    // (40 min, not joined).
    row({
      source: 'app',
      project: 'HW',
      startMs: at('2026-10-01T09:00:00Z'),
      endMs: at('2026-10-01T10:00:00Z'),
      date: '2026-10-01'
    }),
    row({
      source: 'app',
      project: 'Essay',
      startMs: at('2026-10-01T10:20:00Z'),
      endMs: at('2026-10-01T10:40:00Z'),
      date: '2026-10-01'
    }),
    row({
      source: 'app',
      project: 'HW',
      startMs: at('2026-10-01T11:00:00Z'),
      endMs: at('2026-10-01T11:20:00Z'),
      date: '2026-10-01'
    }),
    row({
      source: 'app',
      project: 'HW',
      startMs: at('2026-10-01T12:00:00Z'),
      endMs: at('2026-10-01T12:30:00Z'),
      date: '2026-10-01'
    })
  ])
  const ids = (l: { a: number; b: number }): string => `${ordered[l.a].id}-${ordered[l.b].id}`
  eq('joined across projects within 30 min, split after 40', buildLinks(ordered).map(ids), [
    '1-2',
    '2-3'
  ])
}
{
  nextId = 1
  // A short timer nested inside a long one: the long one runs 9:00-12:00 and
  // a 10:00-10:10 one sits inside it. The next starts 12:15 - 15 minutes after
  // the *sitting* ended, though two hours after the nested row did.
  const ordered = chronological([
    row({
      source: 'app',
      startMs: at('2026-10-02T09:00:00Z'),
      endMs: at('2026-10-02T12:00:00Z'),
      date: '2026-10-02'
    }),
    row({
      source: 'app',
      startMs: at('2026-10-02T10:00:00Z'),
      endMs: at('2026-10-02T10:10:00Z'),
      date: '2026-10-02'
    }),
    row({
      source: 'app',
      startMs: at('2026-10-02T12:15:00Z'),
      endMs: at('2026-10-02T12:45:00Z'),
      date: '2026-10-02'
    })
  ])
  eq('a nested timer does not pull the sitting back', buildLinks(ordered).length, 2)
}
{
  nextId = 1
  // Two app rows 10 minutes apart, but across midnight: different days.
  const ordered = chronological([
    row({
      source: 'app',
      startMs: at('2026-10-03T23:00:00Z'),
      endMs: at('2026-10-03T23:55:00Z'),
      date: '2026-10-03'
    }),
    row({
      source: 'app',
      startMs: at('2026-10-04T00:05:00Z'),
      endMs: at('2026-10-04T00:30:00Z'),
      date: '2026-10-04'
    })
  ])
  eq('a sitting does not cross into the next day', buildLinks(ordered).length, 0)
}
{
  nextId = 1
  // Imported rows: no clocks. Same day and project join; a project switch or
  // a new day does not.
  const ordered = chronological([
    row({ date: '2025-03-01', project: 'HW' }), // 1
    row({ date: '2025-03-01', project: 'HW' }), // 2  joined to 1
    row({ date: '2025-03-01', project: 'Job' }), // 3  not joined: project changed
    row({ date: '2025-03-01', project: 'HW' }), // 4  not joined to 3; to 2? no - consecutive only
    row({ date: '2025-03-02', project: 'HW' }) // 5  new day
  ])
  const ids = (l: { a: number; b: number }): string => `${ordered[l.a].id}-${ordered[l.b].id}`
  eq(
    'imported rows join only same day and same project, consecutively',
    buildLinks(ordered).map(ids),
    ['1-2']
  )
}
{
  nextId = 1
  // A manual row has a remembered time. It must not be clock-joined to an app
  // row, however close the times look.
  const ordered = chronological([
    row({
      source: 'app',
      project: 'HW',
      date: '2026-10-05',
      startMs: at('2026-10-05T09:00:00Z'),
      endMs: at('2026-10-05T10:00:00Z')
    }),
    row({ source: 'manual', project: 'Club', date: '2026-10-05', startMs: null, endMs: null })
  ])
  eq('a manual row is never clock-joined', buildLinks(ordered).length, 0)
}

console.log('')
console.log('--- rings ---')
eq('3.5 years is drawn in years', ringGrain('2023-03-27', '2026-09-19'), 'year')
eq('a year is drawn in quarters', ringGrain('2025-11-01', '2026-10-31'), 'quarter')
eq('90 days in months', ringGrain('2026-08-01', '2026-10-29'), 'month')
eq('30 days in weeks', ringGrain('2026-10-01', '2026-10-30'), 'week')
eq('a week in days', ringGrain('2026-10-24', '2026-10-30'), 'day')
eq(
  'year rings start each January after the first date',
  ringDates('2023-03-27', '2026-09-19', 'year'),
  ['2024-01-01', '2025-01-01', '2026-01-01']
)
eq('quarter rings land on quarter starts', ringDates('2025-11-15', '2026-07-02', 'quarter'), [
  '2026-01-01',
  '2026-04-01',
  '2026-07-01'
])
eq('week rings are Mondays', ringDates('2026-10-01', '2026-10-20', 'week'), [
  '2026-10-05',
  '2026-10-12',
  '2026-10-19'
])
eq('a ring on the first date is not drawn', ringDates('2026-01-01', '2026-03-05', 'month'), [
  '2026-02-01',
  '2026-03-01'
])
eq('a January quarter ring is labelled with its year', ringLabel('2026-01-01', 'quarter'), '2026')
eq('other quarters by month', ringLabel('2026-04-01', 'quarter'), 'Apr ’26')
eq('week labels are month first', ringLabel('2026-10-05', 'week'), '10/05')
eq('day labels name the weekday', ringLabel('2026-11-02', 'day'), 'Mon 11/02')

console.log('')
console.log('--- the whole cloud ---')
{
  nextId = 1
  // 2022: 2 h. 2023 and 2024: nothing. 2025: 6 h. So all three rings sit a
  // quarter of the way out (2 of 8 hours) - the empty years collapse to one
  // thin line and 2025 is the wide band, the way a tree records a drought.
  const rows = [
    row({ date: '2022-05-01', runningS: 3600 }),
    row({ date: '2022-09-01', runningS: 3600 }),
    row({ date: '2025-02-01', runningS: 3600 * 3 }),
    row({ date: '2025-06-01', runningS: 3600 * 3 }),
    row({ date: '2025-07-01', runningS: 0 }) // never drawn: no running time
  ]
  const c = buildConstellation(rows)
  eq('a zero-length row is not a star', c.stars.length, 4)
  near('total hours', c.totalHours, 8)
  eq(
    'a ring per year',
    c.rings.map((r) => r.label),
    ['2023', '2024', '2025']
  )
  eq(
    'every ring sits at 2/8 of the hours: the empty years have no width',
    c.rings.map((r) => r.radius),
    [1, 2, 3].map(() => (CORE + (1 - CORE) * 0.25) * RADIUS)
  )
  // Star 1 covers hours 0-1, so its midpoint is 0.5 of 8.
  near(
    'a star sits at its own midpoint of the hours',
    c.stars[0].radial,
    CORE + (1 - CORE) * (0.5 / 8)
  )
  near('the last star sits at its midpoint too', c.stars[3].radial, CORE + (1 - CORE) * (6.5 / 8))
  eq(
    'radius only grows',
    c.stars.every((s, i, a) => i === 0 || s.radial >= a[i - 1].radial),
    true
  )
  near('recency 0 at the start', c.stars[0].recency, 0)
  near('recency 1 at the end', c.stars[3].recency, 1)
  near('height is the session length', c.stars[2].y, heightOf(3 * 3600) * HEIGHT)
  const dist = (s: { x: number; z: number }): number => Math.hypot(s.x, s.z)
  eq(
    'distance from the axis tracks the radial position, within the jitter',
    c.stars.every((s) => Math.abs(dist(s) - s.radial * RADIUS) <= 0.0061 * RADIUS),
    true
  )
}
{
  nextId = 1
  // Same rows, same cloud - the shape must not change between visits.
  const make = (): StarRow[] => {
    nextId = 1
    return [row({ date: '2026-01-01' }), row({ date: '2026-01-01' }), row({ date: '2026-02-01' })]
  }
  eq(
    'deterministic',
    JSON.stringify(buildConstellation(make()).stars),
    JSON.stringify(buildConstellation(make()).stars)
  )
  eq(
    'hash01 is in [0, 1)',
    [hash01(0, 0), hash01(1, 1), hash01(2 ** 31 - 1, 3)].every((v) => v >= 0 && v < 1),
    true
  )
  eq('different ids jitter differently', hash01(1, 1) === hash01(2, 1), false)
}
{
  nextId = 1
  // A star keeps its size when the range shrinks: percentile over `all`.
  const all = [
    row({ date: '2025-01-01', unit: 'word', quantity: 100 }),
    row({ date: '2026-01-01', unit: 'word', quantity: 50 }),
    row({ date: '2026-01-02', unit: 'word', quantity: 500 })
  ]
  const inRange = all.slice(1)
  const c = buildConstellation(inRange, all)
  eq(
    'output percentile is over the whole history, not the range',
    c.stars.map((s) => s.output),
    [0, 1]
  )
  const c1 = buildConstellation([all[1]], all)
  eq('even a range of one session keeps its size', c1.stars[0].output, 0)
}
eq('empty in, empty out', buildConstellation([]).stars.length, 0)

console.log('')
console.log('--- colours ---')
{
  nextId = 1
  const w = buildWedges([
    row({ project: 'A', runningS: 9000 }),
    row({ project: 'B', runningS: 100 })
  ])
  const c = armColours(w, '#5eead4')
  eq('the largest arm is the accent', c[0], '#5eead4')
  eq('the others are distinct from it', c[1] !== c[0], true)
  eq(
    'every colour is a hex',
    c.every((x) => /^#[0-9a-f]{6}$/.test(x)),
    true
  )
}
{
  nextId = 1
  // B is the bigger project all-time, A is bigger in the range. B keeps the
  // accent and A keeps its own colour: colour follows the project, not the range.
  const all = [
    row({ project: 'B', runningS: 90000, date: '2024-01-01' }),
    row({ project: 'A', runningS: 3600, date: '2026-01-01' }),
    row({ project: 'B', runningS: 600, date: '2026-01-02' })
  ]
  const ranks = colourRanks(all)
  const ranged = buildWedges(all.slice(1))
  eq('in range A is the larger arm', ranged[0].label, 'A')
  const c = armColours(ranged, '#5eead4', ranks)
  eq('but B, largest ever, keeps the accent', c[1], '#5eead4')
  const whole = armColours(buildWedges(all), '#5eead4', ranks)
  eq('and A is the same colour at both ranges', c[0], whole[1])
}

console.log('')
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
