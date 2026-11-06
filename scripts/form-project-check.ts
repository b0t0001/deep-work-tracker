/**
 * The Data tab's form files a session under a project the same way the timer
 * does: by name, resolved against what exists, never as a raw string.
 *
 * Run, against a throwaway copy - never the real profile:
 *   DWT_USERDATA=<tmp holding a copy of deepwork.db> npx esbuild scripts/form-project-check.ts \
 *     --bundle --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --outfile=<tmp>/f.mjs && node <tmp>/f.mjs
 *
 * The cases that matter are the negative ones from CLAUDE.md: a typed `hw`
 * must land on `HW` rather than start a sixty-seventh project, and `Job` must
 * not be snapped onto `JPL`.
 */
import { openDatabase } from '../src/main/db'
import { getSession, withProject } from '../src/main/db/sessions'
import { createSession, undo, updateSession } from '../src/main/db/history'

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

const db = openDatabase()
const projectName = (id: number | null | undefined): string | null =>
  id == null
    ? null
    : ((
        db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined
      )?.name ?? null)
const projectCount = (): number =>
  (db.prepare('SELECT COUNT(*) n FROM projects').get() as { n: number }).n

const before = projectCount()

const base = {
  session_date: '2026-11-05',
  task: 'Study for MATH 1410',
  planned_duration_s: 5400,
  running_duration_s: 4815,
  work_quantity: 4,
  work_unit: 'questions'
}

const id = createSession(withProject({ ...base, project: 'hw' }), 'add session')
const row = getSession(id)
eq('typed "hw" files under the existing HW', projectName(row?.project_id), 'HW')
eq('and creates no new project', projectCount(), before)
eq(
  'the rest of the row is written as sent',
  [row?.task, row?.running_duration_s],
  ['Study for MATH 1410', 4815]
)

updateSession(id, withProject({ project: 'Job' }), 'edit session')
eq('"Job" stays Job, not JPL', projectName(getSession(id)?.project_id), 'Job')

updateSession(id, withProject({ project: 'Penn Electric Racing' }), 'edit session')
eq(
  'a genuinely new name creates its project',
  projectName(getSession(id)?.project_id),
  'Penn Electric Racing'
)
eq('exactly one project was added', projectCount(), before + 1)

updateSession(id, withProject({ project: null }), 'edit session')
eq('clearing the field unlabels the session', getSession(id)?.project_id, null)

undo()
eq('undo puts the project back', projectName(getSession(id)?.project_id), 'Penn Electric Racing')

updateSession(id, withProject({ task: 'renamed' }), 'edit session')
eq(
  'a patch without a project leaves the project alone',
  projectName(getSession(id)?.project_id),
  'Penn Electric Racing'
)

updateSession(id, withProject({ source: 'manual' }), 'edit session')
eq('source can be corrected from the form', getSession(id)?.source, 'manual')

console.log('')
console.log(`form-project: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
