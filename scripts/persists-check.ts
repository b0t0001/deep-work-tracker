/**
 * Checks that the Analytics tab says so when its layout is not being saved.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/persists-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/persists/index.js && electron out/persists/index.js
 *
 * `persists` used to mean "the channel exists". That is why it stayed quiet
 * through the one failure it was built for: during the string/object mismatch
 * `get` and `set` were both present, every write threw in the main process,
 * the rejection was swallowed by design, and the bar reported "saving" while
 * nothing saved. It now means "a write has succeeded".
 *
 * **Why this needs a harness rather than a few lines in the devtools
 * console.** The obvious test is to reach into the running app and replace
 * `window.api.layout.set` with something that rejects. That does not work,
 * and it fails in the most misleading way available: `contextBridge` freezes
 * what it exposes, so the assignment is silently ignored in non-strict code
 * and `window.api.layout.set` is still the original function. Measured:
 *
 *     Object.isFrozen(window.api)         true
 *     Object.isFrozen(window.api.layout)  true
 *     descriptor for 'set'                writable: false, configurable: false
 *
 * The first attempt at this test did exactly that, saw no warning, and nearly
 * recorded the fix as broken. The warning was absent because nothing had been
 * broken - a true reading of a test that did nothing.
 *
 * So the break has to happen on the other side of the bridge, where this
 * harness owns the handler and can make it throw for real.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { defaultLayout } from '../src/shared/layout'
import type { Layout } from '../src/shared/layout'

const profile = join(app.getPath('temp'), `dwt-persists-${process.pid}`)
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

/** Flipped mid-run, so one window sees a healthy channel then a broken one. */
let writesThrow = false
let stored: Layout = defaultLayout()

app.whenReady().then(async () => {
  const reads: Record<string, (...args: unknown[]) => unknown> = {
    // A real payload, not null: null is the read-failed path and the tab
    // renders an explanation instead of the panels, so the bar this test
    // needs would not exist. The first run of this harness failed with
    // "no button" for exactly that reason.
    'analytics:get': (): unknown => ({
      firstDate: '2026-11-01',
      lastDate: '2026-11-05',
      totalHours: 4,
      totalSessions: 3,
      activeDays: 2,
      calendarDays: 5,
      daily: [
        { date: '2026-11-01', hours: 2, sessions: 2 },
        { date: '2026-11-05', hours: 2, sessions: 1 }
      ],
      byProject: [{ name: 'HW', hours: 4, sessions: 3 }],
      byHour: [],
      timedSessions: 0,
      timedFirst: null,
      timedLast: null,
      plannedVsActual: [],
      units: [],
      ratesByUnit: {},
      pace: []
    }),
    'sessions:query': () => ({ rows: [], total: 0, hours: 0, first: null, last: null }),
    'sessions:projects': () => [],
    'history:state': () => ({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }),
    'backup:status': () => null,
    'import:existingCount': () => 0,
    'shortcuts:get': () => ({ pause: '', stop: '', newTimer: '' }),
    'window:isFullScreen': () => false,
    'layout:get': () => stored
  }
  for (const [channel, read] of Object.entries(reads)) {
    ipcMain.handle(channel, (_event, ...args) => read(...args))
  }

  // The one that matters: a handler that throws is what the renderer cannot
  // see for itself, and is the case the old flag could not report.
  ipcMain.handle('layout:set', (_event, layout: Layout) => {
    if (writesThrow) throw new Error('deliberate: the handler threw')
    stored = layout
    return stored
  })

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    useContentSize: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
  await new Promise((done) => setTimeout(done, 900))

  const ask = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression, true)

  await ask(
    `[...document.querySelectorAll('.tabs .tab')].find(t => t.textContent.trim() === 'Analytics')?.click(), 'x'`
  )
  await new Promise((done) => setTimeout(done, 1200))
  await ask(
    `[...document.querySelectorAll('button')].find(b => /customise/i.test(b.textContent))?.click(), 'x'`
  )
  await new Promise((done) => setTimeout(done, 700))

  const warned = `!!document.querySelector('.an-bar__warn')`
  const press = (which: string): string =>
    `(() => { const b = [...document.querySelectorAll('button')].find(x => /${which}/i.test(x.title || '')); if (!b) return 'no button'; b.click(); return 'clicked' })()`

  console.log('')
  console.log('1. a healthy channel does not warn')
  check('no warning at rest', await ask(warned), false)
  check('a write lands', await ask(press('larger')), 'clicked')
  await new Promise((done) => setTimeout(done, 900))
  check('still no warning after a successful write', await ask(warned), false)

  console.log('')
  console.log('2. a handler that throws is reported')
  writesThrow = true
  check('press it again', await ask(press('larger')), 'clicked')
  await new Promise((done) => setTimeout(done, 1200))
  check('the warning appears', await ask(warned), true)
  check(
    'and says the layout is session-only',
    await ask(`/not saved/i.test(document.querySelector('.an-bar__warn')?.textContent ?? '')`),
    true
  )

  console.log('')
  console.log('3. it clears when writing works again')
  writesThrow = false
  check('press it again', await ask(press('smaller')), 'clicked')
  await new Promise((done) => setTimeout(done, 1200))
  check('the warning goes', await ask(warned), false)

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})
