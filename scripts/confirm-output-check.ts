/**
 * Checks that confirming the output waits for the write, and that a refused
 * write keeps the strip open.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/confirm-output-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/confirm/index.js && electron out/confirm/index.js
 *
 * The happy path is easy to get right and easy to see. The failure path is
 * neither, and it is the only one where anything is actually at stake: the
 * quantity exists in the input and nowhere else, so a confirmation that
 * closed the strip on a rejected write would discard the user's number while
 * telling them it was saved.
 *
 * So the case this exists for is the third one below. The others are here to
 * stop it passing vacuously - a strip that never closes would satisfy "stays
 * open on failure" without being correct.
 *
 * Why a harness rather than the devtools console: `contextBridge` freezes
 * what it exposes, so `window.api.timer.setQuantity` cannot be replaced from
 * the renderer to make it fail - the assignment is silently ignored and the
 * test runs against a healthy channel. See
 * `notes/implementer-contextbridge-cannot-be-faked.md`. The break has to
 * happen on this side of the bridge.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { TimerEngine } from '../src/main/timer'

const profile = join(app.getPath('temp'), `dwt-confirm-${process.pid}`)
app.setPath('userData', profile)

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) console.log(`       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

/** Flipped mid-run so one window sees a healthy channel and then a broken one. */
let quantityThrows = false
const written: Array<{ quantity: number | null; unit: string | null }> = []

/**
 * Nothing here may hang.
 *
 * An exception inside `whenReady`'s callback is an unhandled rejection in an
 * Electron main process, and that does not exit - it sits there until
 * something kills it. A harness that hangs is worse than one that fails,
 * because a failure tells you what went wrong and a hang tells you nothing.
 */
const watchdog = setTimeout(() => {
  console.log('')
  console.log('TIMED OUT after 90s - the run never reached its own exit')
  app.exit(1)
}, 90_000)
watchdog.unref?.()

app.whenReady().then(async () => {
  // Running before the window paints, so `timer:get` returns a running
  // snapshot on first read and the stop control exists. The first version
  // started the clock by typing into it, which did nothing here because
  // `timer:start` is inert in this harness - the UI stayed idle and there
  // was no stop button to click.
  const engine = new TimerEngine()
  engine.start(25 * 60_000)
  engine.setTask('Editing')
  const reads: Record<string, (...args: unknown[]) => unknown> = {
    'timer:get': () => engine.snapshot(),
    'timer:getLoop': () => true,
    'timer:getAutoEnd': () => 180,
    'timer:getPace': () => null,
    'sessions:lastProject': () => null,
    'sessions:projectNames': () => [],
    'sessions:lastUnit': () => null,
    'window:isFullScreen': () => false,
    'shortcuts:get': () => ({ pause: '', stop: '', newTimer: '' })
  }
  for (const [channel, read] of Object.entries(reads)) {
    ipcMain.handle(channel, (_event, ...args) => read(...args))
  }
  for (const channel of ['timer:start', 'timer:setTask', 'timer:setProject', 'timer:undoStop']) {
    ipcMain.handle(channel, () => null)
  }
  ipcMain.handle('timer:stop', () => null)
  ipcMain.handle('sessions:setStopReason', () => null)
  ipcMain.handle('sessions:setQuantity', (_event, quantity: number | null, unit: string | null) => {
    if (quantityThrows) throw new Error('deliberate: the quantity write was refused')
    written.push({ quantity, unit })
  })

  const window = new BrowserWindow({
    show: false,
    width: 250,
    height: 136,
    useContentSize: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  await window.loadFile(join(__dirname, '../renderer/index.html'))
  await new Promise((done) => setTimeout(done, 800))

  const ask = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression, true)

  // The quantity field, not `.stop-output` - the saved note reuses that
  // class (`stop-output stop-output--saved`), so asking for `.stop-output`
  // matches the note as well and "the fields are gone" reads as false while
  // the note is up. A true reading of the wrong element, caught by the test
  // disagreeing with a change I had just watched work.
  const strip = `!!document.querySelector('.stop-output__qty')`
  const confirmBtn = `!!document.querySelector('.stop-output__confirm')`
  const note = `document.querySelector('.stop-output--saved')?.textContent ?? null`
  const errorShown = `!!document.querySelector('.card__error')`

  /** Drives the real controls rather than calling the handlers directly. */
  const openStrip = `(() => {
    const stop = document.querySelector('.ghost--danger');
    if (!stop) return 'no stop button';
    stop.click();
    return 'stopped'
  })()`
  const type = (sel: string, value: string): string => `(() => {
    const el = document.querySelector('${sel}');
    if (!el) return 'no ${sel}';
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed'
  })()`

  console.log('')
  console.log('1. the strip opens on stop and offers a confirm')
  console.log('   (driver results are printed so a wrong selector names itself)')
  check(
    'the clock is running, so stop is offered',
    await ask(`!!document.querySelector('.ghost--danger')`),
    true
  )
  check('stop opens the strip', await ask(openStrip), 'stopped')
  await new Promise((done) => setTimeout(done, 600))
  check('the output strip is up', await ask(strip), true)
  check('it has a confirm control', await ask(confirmBtn), true)

  console.log('')
  console.log('2. a healthy confirm names what was stored, then closes')
  await ask(type('.stop-output__qty', '8'))
  await new Promise((done) => setTimeout(done, 300))
  await ask(type('.stop-output__unit', 'seconds edited'))
  await new Promise((done) => setTimeout(done, 400))
  check('the write reached main', written.at(-1), { quantity: 8, unit: 'seconds edited' })
  await ask(`document.querySelector('.stop-output__confirm').click(), 'x'`)
  await new Promise((done) => setTimeout(done, 500))
  check('it names the value, not just "Saved"', await ask(note), 'Saved · 8 seconds edited')
  check('the fields are gone while it shows', await ask(strip), false)
  await new Promise((done) => setTimeout(done, 2200))
  // Composed as one expression rather than interpolating the two probes:
  // `a || b ?? null !== null` mixes `||` with `??`, which is a SyntaxError,
  // and the throw surfaced as "Script failed to execute" with no hint that
  // the test rather than the page was broken.
  check(
    'and the strip closes itself',
    await ask(
      `!!document.querySelector('.stop-output__qty') || !!document.querySelector('.stop-output--saved')`
    ),
    false
  )

  console.log('')
  console.log('3. a refused write keeps the strip open and says so')
  quantityThrows = true
  await ask(openStrip)
  await new Promise((done) => setTimeout(done, 700))
  await ask(type('.stop-output__qty', '19'))
  await new Promise((done) => setTimeout(done, 500))
  // The typing-time catch surfaces it, which already closes the strip in
  // favour of the error. What matters is that the number is not discarded
  // behind a "Saved" that never happened.
  check('the failure is reported', await ask(errorShown), true)
  check('no "Saved" was claimed', await ask(note), null)

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  clearTimeout(watchdog)
  app.exit(fail === 0 ? 0 : 1)
})

process.on('unhandledRejection', (reason) => {
  console.log('')
  console.log('UNHANDLED REJECTION:', String(reason))
  app.exit(1)
})
