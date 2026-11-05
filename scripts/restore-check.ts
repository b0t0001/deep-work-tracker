/**
 * Checks that restoring a backup reproduces the database the import would.
 *
 * Run:
 *   DWT_USERDATA=<tmp> npx esbuild scripts/restore-check.ts --bundle \
 *     --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --external:node:sqlite --outfile=<tmp>/r.mjs && node <tmp>/r.mjs <backup.csv>
 *
 * The case this exists for: `restoreFromCsv` wrote the `project` column
 * verbatim, so restoring any backup taken before the 2026-09-23 project
 * consolidation rebuilt 66 projects where the import yields 36 - and the only
 * database-shaped backup of the full history predates that consolidation by
 * half an hour. A restore and an import must not disagree about the same rows.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { previewRestore, restoreFromCsv } from '../src/main/restore'
import { databasePath, closeDatabase } from '../src/main/db'

const file = process.argv[2]
if (!file) throw new Error('pass a backup CSV')

let pass = 0
let fail = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok)
    console.log(
      '        expected ' + JSON.stringify(expected) + '  actual ' + JSON.stringify(actual)
    )
}

const csv = readFileSync(file, 'utf8')
const preview = previewRestore(csv)
console.log('--- preview ---')
console.log(
  'rows ' + preview.rows + '  hours ' + preview.hours.toFixed(2) + '  projects ' + preview.projects
)
console.log('range ' + preview.firstDate + ' -> ' + preview.lastDate)
check('the file is accepted', preview.ok, true)
check('no problem reported', preview.problem, null)

console.log('')
console.log('--- restore ---')
const result = restoreFromCsv(csv)
console.log(JSON.stringify(result))

const db = new DatabaseSync(databasePath(), { readOnly: true })
const one = (sql: string): Record<string, unknown> =>
  db.prepare(sql).get() as Record<string, unknown>

check('sessions restored', one('SELECT COUNT(*) n FROM sessions').n, result.sessions)
check(
  'projects collapse to the consolidated set',
  one('SELECT COUNT(*) n FROM projects').n,
  preview.projects
)
check('preview and restore agree on projects', result.projects, preview.projects)
check('quick_check', one('PRAGMA quick_check').quick_check, 'ok')
check(
  'ids are preserved, not renumbered',
  one('SELECT MIN(id) lo, MAX(id) hi FROM sessions').hi,
  result.sessions
)
check(
  'no project row is a leftover drifted spelling',
  (
    db
      .prepare("SELECT name FROM projects WHERE name LIKE 'Block %' OR name LIKE '%1'")
      .all() as unknown[]
  ).length,
  0
)
console.log('')
console.log(
  'projects: ' +
    (db.prepare('SELECT name FROM projects ORDER BY name').all() as Array<{ name: string }>)
      .map((r) => r.name)
      .join(', ')
)
db.close()
closeDatabase()

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
