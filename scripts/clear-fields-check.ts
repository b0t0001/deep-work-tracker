/**
 * Checks when a finished session clears the task, duration and project, that
 * only the three reason buttons end a session, and that Tab and Shift+Tab run
 * the same loop in opposite directions.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/clear-fields-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/clear-fields/index.js && npx electron out/clear-fields/index.js \
 *     [--shots <folder>]
 *
 * The rules, in the user's words:
 * - 11/07/2026: "when i finish a session you should clear whatever i put in
 *   the 'what are you working on', time, and project name fields".
 * - 11/11/2026: "I need the information about the project and timer to reset
 *   when I click one of the 3 buttons 'done, tired, cut off,' not the moment
 *   I hit 'stop.'" and "i only want the 3 buttons (done, tired, cut off) to
 *   end the session".
 * - 11/11/2026: "shift+tab doesn't bring me in the reverse order. it cycles
 *   through all the icons."
 *
 * A real TimerEngine sits behind the IPC handlers, wired the way
 * `main/index.ts` wires it. Keys are sent as real input (sendInputEvent), not
 * synthesised in the page, because Tab order is the browser's and a
 * synthetic KeyboardEvent does not move focus.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { TimerEngine } from '../src/main/timer'
import type { TimerSnapshot } from '../src/shared/timer'

// Without these, capturePage on an off-screen window fails with UnknownVizError.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-clear-${process.pid}`)
app.setPath('userData', profile)
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt === -1 ? null : process.argv[shotsAt + 1]

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) console.log(`       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

const watchdog = setTimeout(() => {
  console.log('TIMED OUT after 120s')
  app.exit(1)
}, 120_000)
watchdog.unref?.()

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

app.whenReady().then(async () => {
  const engine = new TimerEngine()
  let lastCompleted: TimerSnapshot | null = null
  let failNextRecord = false
  const reasons: Array<string | null> = []
  let window: BrowserWindow | null = null
  const send = (channel: string, payload: unknown): void => {
    window?.webContents.send(channel, payload)
  }
  engine.on('update', (snap: TimerSnapshot) => send('timer:update', snap))
  engine.on('completed', (snap: TimerSnapshot) => {
    if (failNextRecord) {
      failNextRecord = false
      lastCompleted = null
      send('timer:recordFailed', 'deliberate: the row could not be written')
    } else {
      lastCompleted = snap
    }
    send('timer:completed', null)
  })

  const reads: Record<string, (...args: unknown[]) => unknown> = {
    'timer:get': () => engine.snapshot(),
    'timer:getLoop': () => false,
    'timer:getAutoEnd': () => 180,
    'timer:getPace': () => null,
    'sessions:lastProject': () => null,
    'sessions:projectNames': () => ['HW'],
    'sessions:lastUnit': () => 'words',
    'window:isFullScreen': () => false,
    'shortcuts:get': () => ({ pause: '', stop: '', newTimer: '' })
  }
  for (const [channel, read] of Object.entries(reads)) {
    ipcMain.handle(channel, (_event, ...args) => read(...args))
  }
  ipcMain.handle('timer:start', (_e, ms: number) => engine.start(ms))
  ipcMain.handle('timer:stop', () => engine.stop())
  ipcMain.handle('timer:setTask', (_e, task: string) => engine.setTask(task))
  ipcMain.handle('timer:setProject', (_e, name: string) => engine.setProject(name))
  ipcMain.handle('timer:undoStop', () => {
    if (!lastCompleted) return null
    const restored = engine.restore(lastCompleted)
    lastCompleted = null
    return restored
  })
  ipcMain.handle('sessions:setStopReason', (_e, reason: string | null) => {
    reasons.push(reason)
    return null
  })
  ipcMain.handle('sessions:setQuantity', () => null)

  window = new BrowserWindow({
    show: true,
    x: -2000,
    y: 0,
    width: 250,
    height: 220,
    useContentSize: true,
    frame: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  await window.loadFile(join(__dirname, '../renderer/index.html'))
  await wait(800)
  const ask = (expression: string): Promise<unknown> =>
    window!.webContents.executeJavaScript(expression, true)

  async function shoot(name: string): Promise<void> {
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    // Hover the card so the hover-revealed chrome shows, as it would under a hand.
    window!.webContents.sendInputEvent({ type: 'mouseMove', x: 125, y: 60 })
    await wait(300)
    const image = await window!.webContents.capturePage()
    writeFileSync(join(shots, `${name}.png`), image.toPNG())
  }

  const type = (sel: string, value: string): string => `(() => {
    const el = document.querySelector('${sel}');
    if (!el) return 'no ${sel}';
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed'
  })()`
  const fields = `({
    task: document.querySelector('input.label')?.value ?? null,
    clock: document.querySelector('.dial__clock--input')?.value ?? null,
    project: document.querySelector('.dial__project')?.value ?? null
  })`
  const startByEnter = `(() => {
    const el = document.querySelector('.dial__clock--input');
    if (!el) return 'no clock';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'entered'
  })()`
  const clickStop = `(() => {
    const b = document.querySelector('.ghost--danger');
    if (!b) return 'no stop';
    b.click();
    return 'stopped'
  })()`
  const clickReason = (label: string): string => `(() => {
    const b = Array.from(document.querySelectorAll('.stop-prompt button'))
      .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return 'no ${label}';
    b.click();
    return 'clicked'
  })()`
  const promptButtons = `Array.from(document.querySelectorAll('.stop-prompt button')).map((b) => b.textContent.trim())`
  const focused = `(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    if (el.matches('input.label')) return 'task';
    if (el.matches('.dial__clock--input')) return 'clock';
    if (el.matches('.dial__project')) return 'project';
    if (el.matches('.primary')) return 'start';
    return el.getAttribute('title') || el.textContent.trim() || el.tagName
  })()`
  async function press(key: string, shift = false): Promise<void> {
    const modifiers: Array<'shift'> = shift ? ['shift'] : []
    window!.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
    window!.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    await wait(120)
  }

  async function fillAndStart(): Promise<void> {
    await ask(type('input.label', 'Problem set 4'))
    await ask(type('.dial__project', 'HW'))
    await ask(type('.dial__clock--input', '25'))
    await wait(200)
    check('Enter starts the session', await ask(startByEnter), 'entered')
    await wait(400)
  }

  console.log('')
  console.log('1. stopping keeps the fields until a reason is picked')
  await fillAndStart()
  await shoot('1-running')
  check('stop is offered', await ask(clickStop), 'stopped')
  await wait(500)
  check('the fields are still there', await ask(fields), {
    task: 'Problem set 4',
    clock: '25:00',
    project: 'HW'
  })
  check(
    'main still has them',
    [engine.snapshot().task, engine.snapshot().project],
    ['Problem set 4', 'HW']
  )
  check('only Undo and the three reasons are offered', await ask(promptButtons), [
    'Undo',
    'done',
    'tired',
    'cut off'
  ])
  // "i swear the font isn't the same" - read the computed face and weight
  // rather than trusting the stylesheet.
  const face = (sel: string): string => `(() => {
    const el = document.querySelector('${sel}');
    if (!el) return null;
    const c = getComputedStyle(el);
    return c.fontFamily.split(',')[0].replace(/["']/g, '').trim()
  })()`
  check('the reasons use the app face', await ask(face('.stop-prompt button')), 'Archivo')
  check('the quantity uses the app face', await ask(face('.stop-output__qty')), 'Archivo')
  console.log(
    '       weights:',
    JSON.stringify(
      await ask(`['.dial__clock--input', '.dial__project', 'input.label', '.stop-prompt button', '.stop-output__qty', '.primary']
        .map((s) => { const el = document.querySelector(s); if (!el) return s + ' none'; const c = getComputedStyle(el); return s + ' ' + c.fontWeight + ' ' + c.fontSize + ' ' + c.letterSpacing + ' ' + c.fontFamily.slice(0, 40) })`)
    )
  )
  await ask(type('.stop-output__qty', '340'))
  // The test types into the project field without leaving it, which leaves
  // its suggestion list open over the strip; a hand would have moved on.
  await ask(`document.querySelector('.dial__project')?.blur()`)
  await wait(200)
  await shoot('2-stop-prompt')
  check('pick "tired"', await ask(clickReason('tired')), 'clicked')
  await wait(500)
  check('the reason was stored', reasons[reasons.length - 1], 'tired')
  check('now the fields are empty', await ask(fields), { task: '', clock: '', project: '' })
  check('main forgot them too', [engine.snapshot().task, engine.snapshot().project], ['', ''])
  await shoot('3-saved-note')
  await wait(1600)
  check(
    'the strip has gone',
    await ask(`document.querySelectorAll('.stop-prompt, .stop-output').length`),
    0
  )
  check(
    'the empty clock shows a dim 0:00 placeholder',
    await ask(`document.querySelector('.dial__clock--input')?.placeholder`),
    '0:00'
  )

  console.log('')
  console.log('2. Undo brings the session back; a reason then clears it')
  await fillAndStart()
  check('stop', await ask(clickStop), 'stopped')
  await wait(400)
  check(
    'Undo is offered',
    await ask(
      `(() => { const b=document.querySelector('.stop-prompt__undo'); if(!b) return 'no undo'; b.click(); return 'undone' })()`
    ),
    'undone'
  )
  await wait(500)
  check(
    'main is paused with the task',
    [engine.snapshot().status, engine.snapshot().task],
    ['paused', 'Problem set 4']
  )
  check('stop it again', await ask(clickStop), 'stopped')
  await wait(400)
  check('pick "done"', await ask(clickReason('done')), 'clicked')
  await wait(500)
  check('done stores finished_early', reasons[reasons.length - 1], 'finished_early')
  check('and the fields clear', await ask(fields), { task: '', clock: '', project: '' })

  console.log('')
  console.log('3. a run that could not be written keeps them')
  await fillAndStart()
  failNextRecord = true
  check('stop is offered', await ask(clickStop), 'stopped')
  await wait(500)
  check('the fields stay, as the only record', await ask(fields), {
    task: 'Problem set 4',
    clock: '25:00',
    project: 'HW'
  })
  check('no reason strip over a session that was not saved', await ask(promptButtons), [])

  console.log('')
  console.log('4. a finish with no prompt still clears (expiry, auto-end, shortcut)')
  await ask(`document.querySelector('.card__error-dismiss')?.click()`)
  await wait(200)
  await fillAndStart()
  engine.stop()
  await wait(500)
  check('the fields are empty', await ask(fields), { task: '', clock: '', project: '' })

  console.log('')
  console.log('5. Tab and Shift+Tab run the same loop')
  window.focus()
  window.webContents.focus()
  await ask(type('.dial__clock--input', '25'))
  await ask(`document.querySelector('input.label').focus()`)
  await wait(150)
  const forward: unknown[] = [await ask(focused)]
  for (let i = 0; i < 4; i++) {
    await press('Tab')
    forward.push(await ask(focused))
  }
  check('Tab: task, clock, project, start, back to task', forward, [
    'task',
    'clock',
    'project',
    'start',
    'task'
  ])
  const backward: unknown[] = [await ask(focused)]
  for (let i = 0; i < 4; i++) {
    await press('Tab', true)
    backward.push(await ask(focused))
  }
  check('Shift+Tab: task, start, project, clock, task', backward, [
    'task',
    'start',
    'project',
    'clock',
    'task'
  ])

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  clearTimeout(watchdog)
  app.exit(fail === 0 ? 0 : 1)
})

process.on('unhandledRejection', (reason) => {
  console.log('UNHANDLED REJECTION:', String(reason))
  app.exit(1)
})
