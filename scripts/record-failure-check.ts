/**
 * Checks that a session which cannot be written says so, instead of vanishing.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/record-failure-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/record-failure/index.js && electron out/record-failure/index.js
 *
 * This is the failure the project exists to prevent, and until 2026-11-05 it
 * was completely silent. `main/index.ts` caught the throw correctly, kept the
 * timer stopping cleanly, and sent `timer:recordFailed` to the window — but
 * `preload` exposed no subscription for it and `App.tsx` listened for nothing,
 * so the message arrived nowhere. `lastCompleted` was then null, the stop
 * prompt opened looking entirely normal, and `sessions:setQuantity` took its
 * `if (completed)` false branch: it did nothing and resolved successfully.
 *
 * So the user watched a run end, typed `19` and `questions` into it, and lost
 * the session and the labels, with nothing on screen.
 *
 * Three things are checked, against the real preload and the real renderer
 * bundle rather than a copy of their logic:
 *
 *   1. `recordSession` really does throw when the database refuses a write,
 *      so the premise is reachable rather than hypothetical.
 *   2. `timer:recordFailed` now reaches the window and is shown.
 *   3. The stop prompt is NOT offered while that warning is up. Asking for a
 *      quantity that cannot be stored is worse than asking for nothing.
 *
 * What it does NOT cover, stated so nobody reads more into a pass than is
 * there: it drives the IPC channel directly rather than booting `main/index.ts`
 * and stopping a real timer, so it proves the renderer half and the premise,
 * not the wiring in between. That send has been present and correct since the
 * channel was written; it was the only part of the chain that always worked.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../src/main/db'
import { recordSession } from '../src/main/db/sessions'
import { TimerEngine } from '../src/main/timer'

const profile = join(app.getPath('temp'), `dwt-recfail-${process.pid}`)
mkdirSync(profile, { recursive: true })
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

app.whenReady().then(async () => {
  console.log(`profile: ${profile}`)
  console.log('')
  console.log('1. recordSession throws when the database will not take a write')

  // A finished run worth recording: started, ran, stopped. Driven through the
  // real engine so the snapshot is the shape main actually hands over.
  const engine = new TimerEngine()
  engine.start(1500)
  engine.setTask('CIS 1200 problem set')
  await new Promise((done) => setTimeout(done, 1200))
  const snapshot = engine.stop()

  // `query_only` makes every write fail on this connection the way a locked or
  // damaged database does, without having to damage a file to find out.
  openDatabase().exec('PRAGMA query_only = ON')

  let threw: string | null = null
  try {
    recordSession(snapshot)
  } catch (error) {
    threw = String(error)
  }
  check('recordSession throws rather than returning', threw !== null, true)
  console.log(`       ${threw ?? '(no throw — the rest of this test is vacuous)'}`)

  console.log('')
  console.log('2. the window receives timer:recordFailed and shows it')

  // The reads the timer window performs on first paint. Only enough to let it
  // render; nothing here writes.
  const reads: Record<string, (...args: unknown[]) => unknown> = {
    'timer:get': () => new TimerEngine().snapshot(),
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
  for (const channel of ['timer:start', 'timer:stop', 'timer:setTask', 'timer:setProject']) {
    ipcMain.handle(channel, () => null)
  }

  const window = new BrowserWindow({
    show: false,
    width: 250,
    height: 220,
    useContentSize: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  await window.loadFile(join(__dirname, '../renderer/index.html'))
  await new Promise((done) => setTimeout(done, 700))

  const ask = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression, true)

  check(
    'no error is shown before anything fails',
    await ask(`!!document.querySelector('.card__error')`),
    false
  )

  window.webContents.send('timer:recordFailed', 'Error: database is locked')
  await new Promise((done) => setTimeout(done, 500))

  check('the error is shown', await ask(`!!document.querySelector('.card__error')`), true)
  check(
    'it names the consequence, not just the fault',
    await ask(`/was not saved/i.test(document.querySelector('.card__error')?.textContent ?? '')`),
    true
  )
  check(
    'it passes through the underlying reason',
    await ask(
      `/database is locked/.test(document.querySelector('.card__error')?.textContent ?? '')`
    ),
    true
  )
  check(
    'it has a role so it is announced, not just drawn',
    await ask(`document.querySelector('.card__error')?.getAttribute('role')`),
    'alert'
  )

  console.log('')
  console.log('3. the stop prompt is not offered when there is nothing to attach to')
  check('no quantity field', await ask(`!!document.querySelector('.stop-output')`), false)
  check('no stop-reason row', await ask(`!!document.querySelector('.stop-prompt')`), false)

  // A PNG of the real window, because this is the one message the user must
  // not miss and "it is in the DOM" is not the same as "it is legible at
  // 250px". Three captures: a window that is never shown has no compositor
  // heartbeat, so the first frames can predate the change - see
  // notes/implementer-hidden-window-capture.md.
  const shotTo = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : null
  if (shotTo) {
    for (let i = 0; i < 3; i++) {
      await window.webContents.capturePage()
      await new Promise((done) => setTimeout(done, 400))
    }
    const image = await window.webContents.capturePage()
    mkdirSync(shotTo, { recursive: true })
    writeFileSync(join(shotTo, 'record-failed.png'), image.toPNG())
    console.log(`       shot: ${join(shotTo, 'record-failed.png')}`)
  }

  console.log('')
  console.log('4. it persists rather than auto-dismissing')
  // The stop prompt clears itself after 30s because missing it costs a label.
  // Missing this one means not knowing a session was lost, so it must stay.
  await new Promise((done) => setTimeout(done, 2000))
  check(
    'still shown two seconds later',
    await ask(`!!document.querySelector('.card__error')`),
    true
  )

  check(
    'it can be dismissed deliberately',
    await ask(
      `(() => { const b = document.querySelector('.card__error-dismiss'); if (!b) return 'no button'; b.click(); return 'clicked' })()`
    ),
    'clicked'
  )
  await new Promise((done) => setTimeout(done, 300))
  check('dismissing clears it', await ask(`!!document.querySelector('.card__error')`), false)

  closeDatabase()
  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})
