/**
 * Checks the backup retention guard in `src/main/backup.ts`.
 *
 * Run:
 *   DWT_USERDATA=<tmp> npx esbuild scripts/backup-guard-check.ts --bundle \
 *     --platform=node --format=esm --alias:electron=./scripts/electron-stub.ts \
 *     --external:node:sqlite --outfile=<tmp>/check.mjs && node <tmp>/check.mjs
 *
 * Why this exists rather than being reasoned about: the guard it covers was
 * written twice. The first version compared the database against the *newest*
 * backup, which is wrong in exactly the situation it was written for - the junk
 * snapshots are themselves the newest files, so each one only has to be bigger
 * than the last piece of junk, and the series walks the real backup out of the
 * retention window one slot at a time. The regression below is that layout:
 * a 2,363-row backup with a 1-row snapshot dated after it.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { backupBlockedReason, backupStatus, countRows, runBackup } from '../src/main/backup'

const root = process.env.DWT_USERDATA
if (!root) throw new Error('set DWT_USERDATA to a throwaway directory')
const dir = join(root, 'Backups')

let pass = 0
let fail = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) {
    console.log('        expected ' + JSON.stringify(expected))
    console.log('        actual   ' + JSON.stringify(actual))
  }
}

function checkSays(label: string, actual: string | null, needles: string[]): void {
  const ok = actual !== null && needles.every((n) => actual.includes(n))
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) console.log('        got ' + JSON.stringify(actual))
}

// Built from character codes: a backslash escape in this repo has twice arrived
// in the file as the character it was meant to escape. See CLAUDE.md.
const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const CRLF = CR + LF

console.log('--- countRows ---')
check('empty string is 0 rows', countRows(''), 0)
check('header only is 0 rows', countRows('a,b,c' + CRLF), 0)
check('header + 2 rows', countRows(['h', '1', '2'].join(CRLF) + CRLF), 2)
check('no trailing newline still counts the last row', countRows(['h', '1', '2'].join(CRLF)), 2)
check('a blank line is not a row', countRows(['h', '1', '', '2'].join(CRLF) + CRLF), 2)
check('trailing blank lines are ignored', countRows('h' + CRLF + '1' + CRLF + CRLF + CRLF), 1)
check(
  'a newline inside a quoted field is not a row',
  countRows('id,notes' + CRLF + '1,"line one' + LF + 'line two"' + CRLF + '2,plain' + CRLF),
  2
)
check(
  'an escaped quote does not unbalance the parse',
  countRows('id,notes' + CRLF + '1,"he said ""hi""' + LF + 'then left"' + CRLF),
  1
)

console.log('')
console.log('--- the guard ---')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

check('no backups yet: nothing to compare against, so allowed', backupBlockedReason(3), null)

// The regression. The 1-row file is dated AFTER the 2,363-row one, which is
// what the real backup folder looked like on 2026-11-05.
const history =
  'id,session_date,task' +
  CRLF +
  Array.from({ length: 2363 }, (_, i) => `${i + 1},2026-01-01,t`).join(CRLF) +
  CRLF
writeFileSync(join(dir, 'deep-work-backup-2026-09-23-0130.csv'), history)
writeFileSync(join(dir, 'deep-work-backup-2026-10-02-1803.csv'), 'id,task' + CRLF + '1,junk' + CRLF)

checkSays('3 sessions beside a 2363-row backup is refused', backupBlockedReason(3), [
  'holds 3 sessions',
  'deep-work-backup-2026-09-23-0130.csv',
  '2363'
])
checkSays('1 session reads as singular', backupBlockedReason(1), ['holds 1 session but'])
check('exactly equal is allowed', backupBlockedReason(2363), null)
check('more rows than any backup is allowed', backupBlockedReason(2476), null)

// A real backup file, if one is to hand, as a check on countRows against
// something this script did not write itself.
const real =
  (process.env.USERPROFILE ?? '') +
  '/Documents/Deep Work Tracker/recovery-copies/db-backup-2026-09-23-full-history-2363-rows.csv'
if (existsSync(real)) {
  copyFileSync(real, join(dir, 'deep-work-backup-2026-09-22-0130.csv'))
  checkSays('a real 2363-row backup is read at its true size', backupBlockedReason(3), ['2363'])
} else {
  console.log('SKIP  real backup fixture not present on this machine')
}

console.log('')
console.log('--- runBackup / backupStatus ---')
const empty = await runBackup()
check('an empty database is refused', empty.written, false)
checkSays('and says why', empty.reason ?? null, ['no sessions'])
checkSays('backupStatus carries the refusal for the UI', backupStatus().blocked, [
  'Refusing to write'
])

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
