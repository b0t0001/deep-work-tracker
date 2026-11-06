/**
 * Runs the app against a fresh copy of the real history.
 *
 * Run:
 *   npm run preview
 *
 * ## Why a third profile
 *
 * The installed app has the real history; `npm run dev` has a handful of
 * throwaway rows. Neither is what you want for testing the Analytics tab: the
 * dev profile cannot show a trend, a streak or a chart worth looking at, and
 * the installed one is the data that must not be experimented on.
 *
 * Copying the real history into the **dev** profile is the obvious fix and
 * the wrong one - it is shared between sessions, so one session's snapshot
 * silently becomes another session's test data. That happened once already.
 * Hence `deep-work-tracker-preview`, which belongs to this command and is
 * rebuilt from scratch every time it runs.
 *
 * ## The snapshot is taken with VACUUM INTO, not copied
 *
 * The installed app may be running, and a committed row lives in
 * `deepwork.db-wal` until a checkpoint moves it. Copying `.db`, `-wal` and
 * `-shm` as three separate files while a writer is active can therefore tear:
 * the three are read at three different instants and need not agree.
 *
 * `VACUUM INTO` writes one consistent file from a single read transaction,
 * WAL contents included. The source is opened **read-only**, so this cannot
 * write to the real history even if it is wrong.
 *
 * ## What you do in the preview is saved
 *
 * The preview used to be disposable: rows created in it were marked `test`
 * and thrown away by the next run. On 2026-11-06 the user logged three real
 * sessions in it, and they survived only because someone noticed. A window
 * that looks exactly like the real app and quietly discards what is typed into
 * it is a data-loss trap whatever its banner says.
 *
 * So the snapshot is kept as `baseline.db`, and when the preview closes its
 * changes are copied into the real history by a three-way comparison against
 * it - see `scripts/preview-sync.ts` for the rules. If the preview was killed
 * rather than closed, the next run does the copy before taking a new
 * snapshot. A copy of the real database is taken before anything is written,
 * and the preview's own files are kept under
 * `Documents/Deep Work Tracker/Recovery/` whenever they held a change.
 *
 * It refuses to run while a preview is still open: copying from a database
 * that is still being written, then replacing it under the running app, would
 * lose whatever came after.
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  renameSync,
  rmdirSync,
  writeFileSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { describe, syncPreview, SyncRefused, type SyncReport } from './preview-sync'

const appData = process.env['APPDATA']
if (appData === undefined || appData === '') {
  console.error('APPDATA is not set; this script is Windows-only.')
  process.exit(1)
}

const realProfile = join(appData, 'deep-work-tracker')
const previewProfile = join(appData, 'deep-work-tracker-preview')
const realDb = join(realProfile, 'deepwork.db')
const previewDb = join(previewProfile, 'deepwork.db')
const baselineDb = join(previewProfile, 'baseline.db')

function die(message: string): never {
  console.error('')
  console.error(message)
  process.exit(1)
}

if (!existsSync(realDb)) {
  die(`No database at ${realDb}. Nothing to preview.`)
}

/**
 * Retries a read of the real database before giving up on it.
 *
 * On 2026-11-05 the first read failed with `database disk image is malformed`
 * 28 seconds after the installed app had quit, then succeeded on byte-identical
 * files every time after - five in a row on the live file, and on copies. The
 * file was never damaged; the read landed while the closing app was still
 * letting go of it. Printed as a crash, though, a transient read error names
 * the user's real history as corrupt, which is the one thing this command must
 * never appear to do. So it is retried, and if it still fails it is reported as
 * what it is: a read that failed, against a file this command never writes.
 */
const ATTEMPTS = 4
const RETRY_MS = 1500

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readReal<T>(what: string, read: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return read()
    } catch (error) {
      if (attempt >= ATTEMPTS) {
        die(
          `Could not ${what} after ${ATTEMPTS} tries: ${String(error)}\n\n` +
            'Nothing was written to your real history by this step: the snapshot only ever ' +
            'opens it read-only. If the installed app just closed, wait a minute and run it again. ' +
            'If it keeps failing, open the installed app - it checks the database on ' +
            'startup and will say if the file itself is damaged.'
        )
      }
      console.log(`  (could not ${what}, retrying: ${String(error)})`)
      pause(RETRY_MS)
    }
  }
}

/** Counted before and after, so a torn or partial snapshot cannot pass. */
function sessionCount(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('select count(*) n from sessions').get() as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

function integrity(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('pragma quick_check').get() as Record<string, string>
    return Object.values(row)[0] ?? 'unknown'
  } finally {
    db.close()
  }
}

/**
 * What "nothing wrote to it" is checked against.
 *
 * Opening a WAL database creates an empty `-wal` beside it if none is there -
 * even read-only - so the `-wal` appearing at 0 bytes is this command's own
 * open, not a write. Comparing existence would refuse every run made after the
 * installed app had closed cleanly, which is exactly when it deletes its `-wal`.
 */
function walState(): { mtimeMs: number; size: number } | null {
  const wal = `${realDb}-wal`
  if (!existsSync(wal)) return null
  const s = statSync(wal)
  return { mtimeMs: s.mtimeMs, size: s.size }
}

/**
 * Chromium holds `lockfile` in the profile open for as long as the app runs,
 * so opening it fails with EBUSY exactly while a preview is open. Verified
 * against the installed app and a running preview on 2026-11-06.
 */
function previewRunning(): boolean {
  const lock = join(previewProfile, 'lockfile')
  if (!existsSync(lock)) return false
  try {
    closeSync(openSync(lock, 'r+'))
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EBUSY' || code === 'EPERM'
  }
}

/**
 * Where a preview's changes are kept: beside the backups, not in the preview
 * profile, because that profile is rebuilt by every run.
 *
 * The local Documents folder rather than whatever OneDrive redirected it to,
 * for the reason `defaultBackupDirectory` gives.
 */
function recoveryDir(): string {
  const home = process.env['USERPROFILE'] ?? ''
  const root = join(home, 'Documents', 'Deep Work Tracker', 'Recovery')
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  let dir = join(root, `preview-${stamp}`)
  for (let n = 2; existsSync(dir); n++) dir = join(root, `preview-${stamp}-${n}`)
  return dir
}

function copyDatabase(from: string, to: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${from}${suffix}`)) copyFileSync(`${from}${suffix}`, `${to}${suffix}`)
  }
}

/** Writes one consistent file from a closed database, WAL contents included. */
function vacuumCopy(from: string, to: string): void {
  if (to.includes("'")) die(`Refusing to build a SQL literal from a path with a quote: ${to}`)
  rmSync(to, { force: true })
  const db = new DatabaseSync(from, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${to.replace(/\\/g, '/')}'`)
  } finally {
    db.close()
  }
}

/**
 * Copies what was done in the last preview into the real history.
 *
 * Run before every snapshot - which catches a preview that was killed rather
 * than closed - and after the preview this run launched exits. On any failure
 * it stops the command without touching the preview's database, so what was
 * entered there is still there to be copied once the problem is fixed.
 */
function carryBack(): void {
  if (!existsSync(previewDb)) return
  const baseline = existsSync(baselineDb) ? baselineDb : null
  const dir = recoveryDir()
  mkdirSync(dir, { recursive: true })

  let report: SyncReport
  try {
    report = syncPreview({
      baseline,
      preview: previewDb,
      real: realDb,
      backupTo: join(dir, 'real-before.db')
    })
  } catch (error) {
    const why = error instanceof SyncRefused ? error.message : `Copying failed: ${String(error)}`
    if (readdirSync(dir).length === 0) rmdirSync(dir)
    die(
      `${why}\n\nNothing from the preview was copied into your real history, and the preview's ` +
        `database is untouched at ${previewDb}. Ask for help before running the preview again.`
    )
  }

  const changed =
    report.added.length + report.edited.length + report.deleted.length + report.conflicts.length > 0
  const lines = describe(report)
  console.log('\nFrom the last preview:')
  for (const l of lines) console.log(`  ${l}`)

  if (changed) {
    // The preview's files as they were, beside the copy of the real database
    // taken before writing: everything needed to undo this or recover a
    // conflict lives in one folder.
    copyDatabase(previewDb, join(dir, 'preview.db'))
    if (baseline !== null) copyDatabase(baseline, join(dir, 'baseline.db'))
    writeFileSync(join(dir, 'report.txt'), `${lines.join('\n')}\n`, 'utf8')
    console.log(`  Kept in ${dir}`)
  } else if (readdirSync(dir).length === 0) {
    rmdirSync(dir)
  }

  // Only when something happened. The run after a clean close finds nothing
  // new, and writing that would replace what the close saved before anyone
  // had seen it in the banner.
  if (changed) {
    const record = {
      at: new Date().toISOString(),
      added: report.added.length,
      edited: report.edited.length,
      deleted: report.deleted.length,
      conflicts: report.conflicts.length,
      recoveryDir: dir
    }
    writeFileSync(
      join(previewProfile, 'last-sync.json'),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8'
    )
  }

  // The preview is now in step with the real history, so it becomes its own
  // baseline. Relaunching the preview build by hand keeps its data, and a
  // second copy finds nothing new rather than adding everything again.
  vacuumCopy(previewDb, baselineDb)
}

if (previewRunning()) {
  die(
    'A preview is still open. Close it first - from the tray, Quit - so what you did in it can ' +
      'be saved to your real history before a new copy is taken.'
  )
}

// Skipped by --snapshot-only, which checks this script against a stand-in
// profile and must not write anywhere.
if (!process.argv.includes('--snapshot-only')) carryBack()

console.log('')
console.log(`source  ${realDb}`)
console.log(`preview ${previewProfile}`)

// Recorded so the run can prove it did not touch the original. mtime rather
// than a hash because the claim being made is "nothing wrote to it", and a
// write that happened to produce identical bytes would still be a write.
const before = { db: statSync(realDb).mtimeMs, wal: walState() }

const sourceRows = readReal('count the sessions in the real database', () => sessionCount(realDb))
// A failed check is retried like a failed read: copying from a file that does
// not pass is never the right next step, and one bad reading is not proof.
const sourceCheck = readReal('check the real database', () => {
  const result = integrity(realDb)
  if (result !== 'ok') throw new Error(`quick_check reported: ${result}`)
  return result
})
console.log(
  `\n${sourceRows.toLocaleString()} sessions in the real profile, quick_check ${sourceCheck}`
)

mkdirSync(previewProfile, { recursive: true })

// Into a temp name first, so a failure part-way cannot leave a half-written
// database sitting where the next launch would open it.
const staging = join(previewProfile, `snapshot-${process.pid}.db`)
rmSync(staging, { force: true })

// The path is a SQL string literal here, so a quote in it would break out.
// APPDATA containing a single quote is far-fetched; being wrong about that
// silently would not be.
if (staging.includes("'"))
  die(`Refusing to build a SQL literal from a path with a quote: ${staging}`)
readReal('snapshot the real database', () => {
  rmSync(staging, { force: true })
  const db = new DatabaseSync(realDb, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${staging.replace(/\\/g, '/')}'`)
  } finally {
    db.close()
  }
})

const snapshotRows = sessionCount(staging)
const snapshotOk = integrity(staging)
console.log(`${snapshotRows.toLocaleString()} sessions in the snapshot, quick_check ${snapshotOk}`)

// Asserted before anything is replaced. A snapshot that disagrees with its
// source is the failure this whole approach exists to prevent, so it stops
// here rather than launching against it.
if (snapshotRows !== sourceRows) {
  rmSync(staging, { force: true })
  die(
    `Snapshot has ${snapshotRows} sessions but the source has ${sourceRows}. Not replacing anything.`
  )
}
if (snapshotOk !== 'ok') {
  rmSync(staging, { force: true })
  die(`Snapshot failed quick_check: ${snapshotOk}. Not replacing anything.`)
}

// The old -wal and -shm have to go with the old database. Leaving a -wal from
// a previous preview beside a new .db is the exact shape of the 2026-09-23
// loss, with the halves mismatched instead of missing.
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${previewDb}${suffix}`, { force: true })
}
// The baseline is what the preview's changes are measured against when it
// closes. Copied while staging is a closed, freshly vacuumed file, so it is
// byte-for-byte the database the preview starts from.
rmSync(baselineDb, { force: true })
copyFileSync(staging, baselineDb)
renameSync(staging, previewDb)

const takenAt = new Date().toISOString()
writeFileSync(
  join(previewProfile, 'preview-snapshot.json'),
  `${JSON.stringify({ takenAt, sessions: snapshotRows, from: realDb }, null, 2)}\n`,
  'utf8'
)

const after = { db: statSync(realDb).mtimeMs, wal: walState() }
const walUntouched =
  before.wal === null
    ? after.wal === null || after.wal.size === 0
    : after.wal !== null &&
      after.wal.mtimeMs === before.wal.mtimeMs &&
      after.wal.size === before.wal.size
const untouched = before.db === after.db && walUntouched
console.log(`real profile ${untouched ? 'untouched' : 'CHANGED'} (.db and -wal mtimes compared)`)
if (!untouched) {
  die(
    'The real database changed while snapshotting it. Refusing to go on; check what is writing to it.'
  )
}

// For checking this script against a stand-in profile without rebuilding the
// app or opening a window: point APPDATA (and USERPROFILE, where Recovery
// goes) at folders holding copies. `--snapshot-only` never writes to the
// stand-in real database; `--no-launch` also runs the copy-back first.
if (process.argv.includes('--snapshot-only') || process.argv.includes('--no-launch')) {
  console.log('not building or launching')
  process.exit(0)
}

console.log('\nbuilding...')
const built = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true })
if (built.status !== 0) die('Build failed; not launching.')

console.log(`\nlaunching the preview build against ${snapshotRows.toLocaleString()} sessions`)
console.log(
  'What you add, edit or delete is copied into your real history when the preview closes.\n'
)
const child = spawn('npx', ['electron', join('out', 'main', 'index.js')], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DWT_PROFILE: 'preview' }
})
child.on('exit', (code) => {
  carryBack()
  process.exit(code ?? 0)
})
