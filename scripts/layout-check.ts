/**
 * Checks the Analytics layout store.
 *
 * Run:
 *   DWT_USERDATA=<tmp> npx esbuild scripts/layout-check.ts --bundle \
 *     --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --external:node:sqlite --outfile=<tmp>/l.mjs && node <tmp>/l.mjs
 *
 * The case worth testing is not the happy one. A stored layout outlives the
 * panel list it was written against, so reading one is a merge: ids that no
 * longer exist have to be dropped, and panels the user has never had an
 * opinion about have to appear. Getting the second wrong is invisible until
 * the first panel added after someone customises.
 */
import {
  DEFAULT_RANGES,
  PANEL_IDS,
  SECTIONS,
  defaultLayout,
  parseLayout,
  rangeFor,
  resolveLayout,
  sectionOf,
  serialiseLayout,
  visiblePanels,
  withRange,
  type Layout,
  type PanelId
} from '../src/shared/layout'
import { readLayout, writeLayout } from '../src/main/db/layout'
import { closeDatabase, openDatabase } from '../src/main/db'

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

console.log('--- resolving a stored layout against the panels that exist ---')
eq('nothing stored means defaults', resolveLayout(null), defaultLayout())
eq('a string is not a layout', parseLayout('not json at all'), defaultLayout())
eq('an empty row means defaults', parseLayout(''), defaultLayout())
eq('valid JSON that is not an object', parseLayout('[1,2,3]').order, defaultLayout().order)

eq(
  'an unknown id is dropped rather than stranding the layout',
  resolveLayout({ order: ['calendar', 'panelFromTheFuture', 'pace'], hidden: [], fontScale: 1 })
    .order.length,
  PANEL_IDS.length
)

{
  // The rule that matters. A user who dragged things before `pace` existed
  // must still see `pace`.
  const before = { order: ['calendar', 'hoursPerWeek', 'projects'], hidden: [], fontScale: 1 }
  const got = resolveLayout(before)
  eq('every panel is present after resolving', got.order.length, PANEL_IDS.length)
  // Relative to itself, not at the front: a new panel whose default position
  // falls between two the user has placed belongs between them. `stats` is
  // exactly that case - it sits second in PANEL_IDS, so it lands between
  // `calendar` and `hoursPerWeek` rather than after everything they chose.
  eq(
    'the expressed order is preserved relative to itself',
    got.order.filter((id) => before.order.includes(id)),
    ['calendar', 'hoursPerWeek', 'projects']
  )
  eq(
    'and a panel never opined about lands in its default position, not last',
    got.order.slice(0, 4),
    ['calendar', 'stats', 'hoursPerWeek', 'projects']
  )
  eq('a panel never opined about is visible, not hidden', got.hidden, [])
  eq('and it is actually drawn', visiblePanels(got).includes('pace'), true)
}

{
  // A reordered layout must survive a round trip unchanged.
  const mine: Layout = {
    order: [
      'pace',
      'calendar',
      'rateTrend',
      'stats',
      'timeOfDay',
      'projects',
      'plannedRatio',
      'hoursPerWeek'
    ],
    hidden: ['timeOfDay'],
    fontScale: 1.25,
    ranges: { projects: '1y', averages: '8w' }
  }
  eq('a full custom layout round-trips', parseLayout(serialiseLayout(mine)), mine)
}

eq(
  'hiding an id that is not a panel is ignored',
  resolveLayout({ order: [...PANEL_IDS], hidden: ['nope'], fontScale: 1 }).hidden,
  []
)
eq(
  'a duplicated id appears once',
  resolveLayout({ order: ['pace', 'pace'], hidden: [], fontScale: 1 }).order.filter(
    (id) => id === 'pace'
  ).length,
  1
)
eq(
  'a hidden panel keeps its position',
  resolveLayout({
    order: ['pace', ...PANEL_IDS.filter((p) => p !== 'pace')],
    hidden: ['pace'],
    fontScale: 1
  }).order[0],
  'pace'
)

console.log('')
console.log('--- font scale ---')
eq('absurdly large is clamped', resolveLayout({ fontScale: 99 }).fontScale, 1.6)
eq('absurdly small is clamped', resolveLayout({ fontScale: 0.1 }).fontScale, 0.8)
eq('a string is not a scale', resolveLayout({ fontScale: 'big' }).fontScale, 1)
eq('NaN is not a scale', resolveLayout({ fontScale: Number.NaN }).fontScale, 1)

console.log('')
console.log('--- per-panel ranges ---')

/*
 * Both halves of a stored entry are checked, not just the key.
 *
 * A window id that no longer exists would resolve through `windowDef`'s
 * fallback to "all time" - a panel silently showing three and a half years
 * where the user had set a week. Dropping the entry shows the panel's own
 * default instead, which is at least a value somebody chose.
 */
eq(
  'a target that is not a panel or a tile is dropped',
  resolveLayout({ ranges: { nonsense: '1w', projects: '1w' } }).ranges,
  { projects: '1w' }
)
eq(
  'a window id that does not exist is dropped',
  resolveLayout({ ranges: { projects: 'past fortnight' } }).ranges,
  {}
)
eq('ranges that are not an object mean none', resolveLayout({ ranges: 7 }).ranges, {})
eq('no stored ranges at all means none', resolveLayout({ order: [...PANEL_IDS] }).ranges, {})
eq(
  'an unset target falls back to its own default, not a shared one',
  rangeFor(defaultLayout(), 'hoursPerWeek'),
  DEFAULT_RANGES.hoursPerWeek
)
eq(
  'and the defaults are not all the same, which is the point of having them per target',
  new Set(Object.values(DEFAULT_RANGES)).size > 1,
  true
)
eq(
  'setting one target leaves every other alone',
  withRange(defaultLayout(), 'projects', '1y').ranges,
  { projects: '1y' }
)
{
  const twice = withRange(withRange(defaultLayout(), 'projects', '1y'), 'stats', '1m')
  eq('a second target is added rather than replacing the first', twice.ranges, {
    projects: '1y',
    stats: '1m'
  })
  eq('and re-setting one overwrites only itself', withRange(twice, 'projects', '2w').ranges, {
    projects: '2w',
    stats: '1m'
  })
}

console.log('')
console.log('--- sections ---')

/*
 * The headings are fixed and the panels are not, so the one thing that can go
 * wrong is a panel belonging to no section - which would silently fall into
 * the last one and appear under a heading that does not describe it.
 */
eq(
  'every panel is in exactly one section',
  PANEL_IDS.filter(
    (id) => SECTIONS.filter((s) => (s.panels as readonly PanelId[]).includes(id)).length !== 1
  ),
  []
)
eq(
  'no section names a panel that does not exist',
  SECTIONS.flatMap((s) => s.panels).filter((id) => !(PANEL_IDS as readonly string[]).includes(id)),
  []
)
eq('the first section is the one the user named', SECTIONS[0].title, 'At a glance')
eq('and it holds no panels - the figure row is not draggable', SECTIONS[0].panels.length, 0)
eq('sectionOf agrees with the table', sectionOf('calendar'), 'hours')

console.log('')
console.log('--- through app_settings ---')
openDatabase()
eq('an unwritten layout reads as defaults', readLayout(), defaultLayout())
{
  const mine: Layout = {
    order: [...PANEL_IDS].reverse(),
    hidden: ['projects'],
    fontScale: 1.5,
    ranges: { stats: '1m', period: '2y' }
  }
  eq('what is written is what is read back', writeLayout(mine), mine)
  eq('and it survives a reopen', readLayout(), mine)
}
closeDatabase()

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
