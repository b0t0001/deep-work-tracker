/**
 * Checks that finishing a session clears the task, duration and project
 * fields, that Undo brings them back, and that a run which could not be
 * written keeps them.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/clear-fields-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/clear-fields/index.js && electron out/clear-fields/index.js
 *
 * The user's rule, 11/07/2026: "when i finish a session you should clear
 * whatever i put in the 'what are you working on', time, and project name
 * fields". A real TimerEngine sits behind the IPC handlers, wired the way
 * `main/index.ts` wires it, so the renderer sees the same `update` and
 * `completed` traffic as in the app. Nothing touches a database.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { TimerEngine } from '../src/main/timer'
import type { TimerSnapshot } from '../src/shared/timer'

const profile = join(app.getPath('temp'), `dwt-clear-${process.pid}`)
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

const watchdog = setTimeout(() => {
  console.log('TIMED OUT after 90s')
  app.exit(1)
}, 90_000)
watchdog.unref?.()

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

app.whenReady().then(async () => {
  const engine = new TimerEngine()
  let lastCompleted: TimerSnapshot | null = null
  let failNextRecord = false
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
    'sessions:lastUnit': () => null,
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
  ipcMain.handle('sessions:setStopReason', () => null)
  ipcMain.handle('sessions:setQuantity', () => null)

  window = new BrowserWindow({
    show: false,
    width: 250,
    height: 136,
    useContentSize: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  await window.loadFile(join(__dirname, '../renderer/index.html'))
  await wait(800)
  const ask = (expression: string): Promise<unknown> =>
    window!.webContents.executeJavaScript(expression, true)

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

  async function fillAndStart(): Promise<void> {
    await ask(type('input.label', 'Problem set 4'))
    await ask(type('.dial__project', 'HW'))
    await ask(type('.dial__clock--input', '25'))
    await wait(200)
    check('Enter starts the session', await ask(startByEnter), 'entered')
    await wait(400)
  }

  console.log('')
  console.log('1. stopping clears all three fields')
  await fillAndStart()
  check('main has the task while running', engine.snapshot().task, 'Problem set 4')
  check('stop is offered', await ask(clickStop), 'stopped')
  await wait(500)
  check('the fields are empty', await ask(fields), { task: '', clock: '', project: '' })
  check('main forgot them too', [engine.snapshot().task, engine.snapshot().project], ['', ''])
  check(
    'the empty clock shows a dim 0:00 placeholder',
    await ask(`document.querySelector('.dial__clock--input')?.placeholder`),
    '0:00'
  )

  console.log('')
  console.log('2. Undo brings them back')
  check(
    'Undo is offered',
    await ask(
      `(() => { const b=document.querySelector('.stop-prompt__undo'); if(!b) return 'no undo'; b.click(); return 'undone' })()`
    ),
    'undone'
  )
  await wait(500)
  check(
    'task and project are back',
    await ask(`({
    task: document.querySelector('input.label')?.value ?? null,
    project: document.querySelector('.dial__project')?.value ?? null
  })`),
    { task: 'Problem set 4', project: 'HW' }
  )
  check(
    'main is paused with them',
    [engine.snapshot().status, engine.snapshot().task],
    ['paused', 'Problem set 4']
  )
  check('stop it again', await ask(clickStop), 'stopped')
  await wait(500)
  check('and they clear again', await ask(fields), { task: '', clock: '', project: '' })

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

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  clearTimeout(watchdog)
  app.exit(fail === 0 ? 0 : 1)
})

process.on('unhandledRejection', (reason) => {
  console.log('UNHANDLED REJECTION:', String(reason))
  app.exit(1)
})
