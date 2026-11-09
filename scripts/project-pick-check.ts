/**
 * Checks that choosing a project suggestion - by mouse or by Enter - puts that
 * name in the field and in main, rather than the text that was typed.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/project-pick-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/project-pick/index.js && npx electron out/project-pick/index.js
 *
 * 11/09/2026: "if I type something and try clicking on the label, it won't
 * update it properly". A suggestion's mousedown chose the name, then bubbled
 * to the card, whose handler blurred the field; the blur committed the text
 * from the render before the choice, and that won. Enter did the same through
 * its own blur(). The click is dispatched as real input (sendInputEvent), not
 * el.click(), because the bug lives in the mousedown/blur ordering.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { TimerEngine } from '../src/main/timer'

app.setPath('userData', join(app.getPath('temp'), `dwt-pick-${process.pid}`))

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
  console.log('TIMED OUT')
  app.exit(1)
}, 60_000)
watchdog.unref?.()
const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

app.whenReady().then(async () => {
  const engine = new TimerEngine()
  let window: BrowserWindow | null = null
  engine.on('update', (snap) => window?.webContents.send('timer:update', snap))
  const reads: Record<string, () => unknown> = {
    'timer:get': () => engine.snapshot(),
    'timer:getLoop': () => false,
    'timer:getAutoEnd': () => 180,
    'timer:getPace': () => null,
    'sessions:lastProject': () => null,
    'sessions:projectNames': () => ['HW', 'Entrepreneurship', 'Job', 'PER', 'PennApps'],
    'sessions:lastUnit': () => null,
    'window:isFullScreen': () => false,
    'shortcuts:get': () => ({ pause: '', stop: '', newTimer: '' })
  }
  for (const [channel, read] of Object.entries(reads)) ipcMain.handle(channel, () => read())
  ipcMain.handle('timer:setTask', (_e, task: string) => engine.setTask(task))
  ipcMain.handle('timer:setProject', (_e, name: string) => engine.setProject(name))

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
  const ask = (js: string): Promise<unknown> => window!.webContents.executeJavaScript(js, true)
  const field = (): Promise<unknown> => ask(`document.querySelector('.dial__project').value`)

  async function typeProject(text: string): Promise<void> {
    await ask(
      `(() => { const el = document.querySelector('.dial__project'); el.focus(); el.select(); })()`
    )
    await wait(50)
    window!.webContents.insertText(text)
    await wait(150)
  }
  async function realClick(selector: string): Promise<string> {
    const box =
      (await ask(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null })()`)) as {
        x: number
        y: number
      } | null
    if (!box) return 'no target'
    window!.webContents.sendInputEvent({
      type: 'mouseDown',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1
    })
    window!.webContents.sendInputEvent({
      type: 'mouseUp',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1
    })
    await wait(250)
    return 'clicked'
  }
  const menu = `Array.from(document.querySelectorAll('.project-menu button')).map(b => b.textContent)`

  console.log('\n1. clicking a suggestion')
  await typeProject('Ent')
  check('the menu offers Entrepreneurship', ((await ask(menu)) as string[])[0], 'Entrepreneurship')
  check('click it', await realClick('.project-menu button'), 'clicked')
  check('the field holds the name clicked', await field(), 'Entrepreneurship')
  check('main holds it too', engine.snapshot().project, 'Entrepreneurship')

  console.log('\n2. Enter on the highlighted suggestion')
  await typeProject('pen')
  check('the menu offers PennApps first', ((await ask(menu)) as string[])[0], 'PennApps')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await wait(250)
  check('the field holds the suggestion', await field(), 'PennApps')
  check('main holds it too', engine.snapshot().project, 'PennApps')

  console.log('\n3. typing a new name and leaving still keeps it')
  await typeProject('Brand new')
  await ask(`document.querySelector('.dial__project').blur()`)
  await wait(250)
  check('the field keeps what was typed', await field(), 'Brand new')
  check('main holds it too', engine.snapshot().project, 'Brand new')

  console.log('\n4. a near miss still snaps on leaving')
  await typeProject('hw')
  await ask(`document.querySelector('.dial__project').blur()`)
  await wait(250)
  check('hw becomes HW', await field(), 'HW')
  check('main holds HW', engine.snapshot().project, 'HW')

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})
