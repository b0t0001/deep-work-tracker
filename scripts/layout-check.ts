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
  PANEL_IDS,
  defaultLayout,
  parseLayout,
  resolveLayout,
  serialiseLayout,
  visiblePanels,
  type Layout
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
  eq('the expressed order is preserved at the front', got.order.slice(0, 3), [
    'calendar',
    'hoursPerWeek',
    'projects'
  ])
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
      'timeOfDay',
      'projects',
      'plannedRatio',
      'hoursPerWeek'
    ],
    hidden: ['timeOfDay'],
    fontScale: 1.25
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
console.log('--- through app_settings ---')
openDatabase()
eq('an unwritten layout reads as defaults', readLayout(), defaultLayout())
{
  const mine: Layout = { order: [...PANEL_IDS].reverse(), hidden: ['projects'], fontScale: 1.5 }
  eq('what is written is what is read back', writeLayout(mine), mine)
  eq('and it survives a reopen', readLayout(), mine)
}
closeDatabase()

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
