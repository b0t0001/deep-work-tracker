/**
 * Runs the current source against a read-only copy of the real history.
 *
 * Run:
 *   npm run preview
 *
 * ## Read-only, and thrown away
 *
 * The preview exists to try a change on real data before it is installed. It
 * takes a copy of the real history, and **nothing ever goes back**: rows
 * recorded in it are marked `test` like every unpackaged build's
 * (`sourceForNewRow`), and when the preview closes its copy is deleted.
 *
 * For one day (11/06/2026) it did the opposite - it copied what was done in it
 * back into the real history on close, after the user logged real sessions in
 * a preview and nearly lost them. The user rejected that as an untested build
 * writing to production data, which it was. Real work is recorded in the
 * installed app; the banner in the preview says so.
 *
 * ## The copy is of the real file, not the one the sandbox shows
 *
 * The Claude desktop app is MSIX-packaged, and processes started from its
 * terminal have `%APPDATA%` redirected into the package's LocalCache. Read
 * from there, "the real database" is a stale hidden copy - which split the
 * user's data in two for seven weeks (CLAUDE.md, "Claude's sandbox redirects
 * AppData"). So when this script finds itself inside that sandbox, the
 * snapshot is taken by a copy of itself started through WMI, outside it,
 * reading the real file. The preview profile itself can live in the
 * redirected view: it is disposable, and the preview app started from here
 * sees the same view.
 *
 * ## The snapshot is taken with VACUUM INTO, read-only
 *
 * The installed app may be running, and a committed row lives in
 * `deepwork.db-wal` until a checkpoint moves it, so copying `.db`, `-wal` and
 * `-shm` as three files can tear. `VACUUM INTO` writes one consistent file
 * from a single read transaction, and the source is opened **read-only**, so
 * this cannot write to the real history even if it is wrong. Counted and
 * `quick_check`ed on both sides before anything is replaced.
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Helper mode, run outside the sandbox by snapshotFromOutside(). It is handed
// every path rather than reading APPDATA, because a process started through
// WMI is not guaranteed the same environment as the one that asked for it.
// Hoisted functions only below this point until the guard returns.
if (process.argv[2] === '--snapshot-helper') {
  const [source, out, result] = process.argv.slice(3)
  const outcome = snapshot(source, out)
  writeFileSync(`${result}.part`, JSON.stringify(outcome))
  renameSync(`${result}.part`, result)
  process.exit(0)
}

const appData = process.env['APPDATA']
const localAppData = process.env['LOCALAPPDATA']
if (!appData || !localAppData) {
  console.error('APPDATA is not set; this script is Windows-only.')
  process.exit(1)
}

const realDb = join(appData, 'deep-work-tracker', 'deepwork.db')
const previewProfile = join(appData, 'deep-work-tracker-preview')
const previewDb = join(previewProfile, 'deepwork.db')
const marker = join(previewProfile, 'preview-snapshot.json')

function die(message: string): never {
  console.error('')
  console.error(message)
  process.exit(1)
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function sessionCount(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare('select count(*) n from sessions').get() as { n: number }).n
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

interface SnapshotResult {
  ok: boolean
  problem?: string
  sourceRows?: number
  rows?: number
  check?: string
  untouched?: boolean
}

/**
 * Copies `source` into `out` with VACUUM INTO, read-only, and checks both.
 *
 * Retried: on 2026-11-05 a read landed while the installed app was still
 * closing and reported `database disk image is malformed` on a file that was
 * fine every time after. A transient failure must not read as a damaged
 * history, and it must never be "fixed" by writing to the source.
 */
function snapshot(source: string, out: string): SnapshotResult {
  if (!existsSync(source)) return { ok: false, problem: `no database at ${source}` }
  if (out.includes("'")) return { ok: false, problem: `refusing a path with a quote: ${out}` }
  const before = statSync(source).mtimeMs
  let lastError = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      rmSync(out, { force: true })
      const sourceRows = sessionCount(source)
      const check = integrity(source)
      if (check !== 'ok') throw new Error(`quick_check on the source reported: ${check}`)
      const db = new DatabaseSync(source, { readOnly: true })
      try {
        db.exec(`VACUUM INTO '${out.split(String.fromCharCode(92)).join('/')}'`)
      } finally {
        db.close()
      }
      const rows = sessionCount(out)
      const outCheck = integrity(out)
      if (rows !== sourceRows)
        throw new Error(`copy has ${rows} sessions, source has ${sourceRows}`)
      if (outCheck !== 'ok') throw new Error(`quick_check on the copy reported: ${outCheck}`)
      return {
        ok: true,
        sourceRows,
        rows,
        check: outCheck,
        untouched: statSync(source).mtimeMs === before
      }
    } catch (error) {
      lastError = String(error)
      pause(1500)
    }
  }
  rmSync(out, { force: true })
  return { ok: false, problem: lastError }
}

/**
 * Whether this process is inside the Claude app's package sandbox.
 *
 * Measured, not guessed: a file written to `%APPDATA%` either lands there or
 * turns up under some package's LocalCache. Nothing about the environment
 * says which, and getting it wrong means previewing a stale copy.
 */
function insideSandbox(): boolean {
  const name = `.dwt-sandbox-probe-${process.pid}`
  const probe = join(appData!, name)
  try {
    writeFileSync(probe, 'x')
    const packages = join(localAppData!, 'Packages')
    if (!existsSync(packages)) return false
    return readdirSync(packages).some((pkg) =>
      existsSync(join(packages, pkg, 'LocalCache', 'Roaming', name))
    )
  } catch {
    return false
  } finally {
    rmSync(probe, { force: true })
  }
}

/**
 * Takes the snapshot from outside the sandbox: this same script, started
 * through WMI (which runs outside any package), in `--snapshot-helper` mode.
 * Both paths are in Temp, which the sandbox does not redirect.
 */
function snapshotFromOutside(out: string): SnapshotResult {
  const result = join(tmpdir(), `dwt-preview-snapshot-${process.pid}.json`)
  rmSync(result, { force: true })
  const command = [
    process.execPath,
    resolve(process.argv[1]),
    '--snapshot-helper',
    realDb,
    out,
    result
  ]
    .map((part) => `"${part}"`)
    .join(' ')
  const ps =
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ` +
    `CommandLine = '${command.replace(/'/g, "''")}'; CurrentDirectory = '${process.cwd().replace(/'/g, "''")}' }; ` +
    `$r.ReturnValue`
  const started = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  if (started.stdout.trim() !== '0') {
    return {
      ok: false,
      problem: `could not start the snapshot outside the sandbox: ${started.stdout}${started.stderr}`
    }
  }
  for (let waited = 0; waited < 90_000; waited += 500) {
    if (existsSync(result)) {
      try {
        const parsed = JSON.parse(readFileSync(result, 'utf8')) as SnapshotResult
        rmSync(result, { force: true })
        return parsed
      } catch {
        /* still being written */
      }
    }
    pause(500)
  }
  return {
    ok: false,
    problem: 'the snapshot taken outside the sandbox did not finish within 90 seconds'
  }
}

/** Chromium holds `lockfile` open in the profile for as long as the app runs. */
function previewRunning(): boolean {
  const lock = join(previewProfile, 'lockfile')
  if (!existsSync(lock)) return false
  try {
    closeSync(openSync(lock, 'r+'))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EBUSY'
  }
}

/**
 * Deletes the preview's copy and everything recorded in it. What was done in
 * a preview is not kept anywhere - that is the point of it. `baseline.db` and
 * `last-sync.json` are from the one day the preview copied back, removed if
 * an old run left them.
 */
function discardPreview(): void {
  for (const name of [
    'deepwork.db',
    'deepwork.db-wal',
    'deepwork.db-shm',
    'preview-snapshot.json',
    'baseline.db',
    'last-sync.json'
  ]) {
    rmSync(join(previewProfile, name), { force: true })
  }
}

// ---- The preview.
if (previewRunning()) {
  die(
    'A preview is already open. Close it first: starting another would replace its copy under it.'
  )
}

// Whatever a previous preview left - one that was killed rather than closed -
// is discarded before anything else, so its rows cannot outlive it.
mkdirSync(previewProfile, { recursive: true })
discardPreview()

const sandboxed = insideSandbox()
const staging = join(tmpdir(), `dwt-preview-${process.pid}.db`)
console.log('')
console.log(`source  ${realDb}${sandboxed ? '  (read from outside the Claude sandbox)' : ''}`)
console.log(`preview ${previewProfile}`)

const taken = sandboxed ? snapshotFromOutside(staging) : snapshot(realDb, staging)
if (!taken.ok) {
  rmSync(staging, { force: true })
  die(
    `Could not copy the real history: ${taken.problem}\n\n` +
      'Nothing was written to it: the copy only ever opens it read-only. If the installed app ' +
      'just closed, wait a minute and run this again.'
  )
}
console.log(
  `${taken.rows!.toLocaleString()} sessions copied, quick_check ${taken.check}, ` +
    `real database ${taken.untouched ? 'untouched' : 'CHANGED during the copy (by the installed app?)'}`
)

renameSync(staging, previewDb)
writeFileSync(
  marker,
  `${JSON.stringify({ takenAt: new Date().toISOString(), sessions: taken.rows }, null, 2)}\n`,
  'utf8'
)

if (process.argv.includes('--no-launch')) {
  console.log('--no-launch: snapshot only')
  process.exit(0)
}

console.log('\nbuilding...')
const built = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true })
if (built.status !== 0) {
  discardPreview()
  die('Build failed; not launching. The copy was discarded.')
}

console.log(`\nlaunching the preview against ${taken.rows!.toLocaleString()} sessions`)
console.log('Read-only: anything recorded is marked TEST and deleted when the preview closes.\n')
// A debugging port passes through, so a check can drive the preview the way
// the user would; nothing else does.
const passThrough = process.argv.filter((arg) => arg.startsWith('--remote-debugging-port='))
const child = spawn('npx', ['electron', join('out', 'main', 'index.js'), ...passThrough], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DWT_PROFILE: 'preview' }
})
child.on('exit', (code) => {
  // A moment for Chromium to let go of the files after the window closes.
  for (let i = 0; i < 20 && previewRunning(); i++) pause(500)
  discardPreview()
  console.log('Preview closed; its copy and anything recorded in it were deleted.')
  process.exit(code ?? 0)
})
