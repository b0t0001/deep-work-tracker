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
 * ## Nothing here is ever copied back
 *
 * The preview profile is disposable in one direction only. Rows created in it
 * are written with `source='test'` - `sourceForNewRow` does that for any
 * unpackaged build - so they show orange in the Data tab and stay out of
 * analytics even if the file were ever confused for a real one.
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const appData = process.env['APPDATA']
if (appData === undefined || appData === '') {
  console.error('APPDATA is not set; this script is Windows-only.')
  process.exit(1)
}

const realProfile = join(appData, 'deep-work-tracker')
const previewProfile = join(appData, 'deep-work-tracker-preview')
const realDb = join(realProfile, 'deepwork.db')
const previewDb = join(previewProfile, 'deepwork.db')

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
            'Nothing was written to your real history: this command only ever opens it ' +
            'read-only. If the installed app just closed, wait a minute and run it again. ' +
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
// app or opening a window: point APPDATA at a folder holding a copy.
if (process.argv.includes('--snapshot-only')) {
  console.log('snapshot only: not building or launching')
  process.exit(0)
}

console.log('\nbuilding...')
const built = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true })
if (built.status !== 0) die('Build failed; not launching.')

console.log(`\nlaunching the preview build against ${snapshotRows.toLocaleString()} sessions`)
console.log('Rows you create here are written as source=test and stay in this profile.\n')
const child = spawn('npx', ['electron', join('out', 'main', 'index.js')], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DWT_PROFILE: 'preview' }
})
child.on('exit', (code) => process.exit(code ?? 0))
