/**
 * What a hand-entered session must have, checked against the shared rule both
 * the form and main apply.
 *
 * Run:
 *   npx esbuild scripts/session-form-check.ts --bundle --platform=node --format=esm --outfile=out/checks/session-form.mjs && node out/checks/session-form.mjs
 */
import { listOf, missingForEdit, missingForNewSession } from '../src/shared/sessionForm'

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

const full = {
  session_date: '2026-11-05',
  project: 'HW',
  task: 'Study for CIS 1200 Midterm',
  planned_duration_s: 10800,
  running_duration_s: 3416
}
eq('a complete session is accepted', missingForNewSession(full), [])
eq('the 11/05 case: no project', missingForNewSession({ ...full, project: null }), ['Project'])
eq('blank text counts as missing', missingForNewSession({ ...full, project: '  ', task: '' }), [
  'Project',
  'Task'
])
eq(
  'planned is required, not borrowed from actual',
  missingForNewSession({ ...full, planned_duration_s: 0 }),
  ['Planned']
)
eq('actual is required', missingForNewSession({ ...full, running_duration_s: 0 }), ['Actual'])
eq(
  'a date must be a real ISO date',
  missingForNewSession({ ...full, session_date: '11/05/2026' }),
  ['Date']
)
eq('an empty form names all five in form order', missingForNewSession({}), [
  'Date',
  'Project',
  'Task',
  'Planned',
  'Actual'
])
eq('output is optional', missingForNewSession({ ...full, work_quantity: null } as typeof full), [])
eq(
  'an edit to an unlabeled imported row is not blocked',
  missingForEdit({ ...full, project: null, task: null }),
  []
)
eq('an edit still needs a date and an actual', missingForEdit({ running_duration_s: 0 }), [
  'Date',
  'Actual'
])
eq('laps default to one when absent', missingForNewSession(full), [])
eq('two laps are fine', missingForNewSession({ ...full, laps: 2 }), [])
eq('zero laps is not a session', missingForNewSession({ ...full, laps: 0 }), ['Laps'])
eq('a fraction of a lap is not a count', missingForNewSession({ ...full, laps: 1.5 }), ['Laps'])
eq('an edit checks laps too', missingForEdit({ ...full, laps: 0 }), ['Laps'])
eq('listOf one', listOf(['Project']), 'Project')
eq('listOf two', listOf(['Project', 'Task']), 'Project and Task')
eq('listOf three', listOf(['Date', 'Project', 'Actual']), 'Date, Project and Actual')

console.log('')
console.log(`session-form: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
