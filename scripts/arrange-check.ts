/**
 * Drives a real drag and asserts that the other panels move out of the way.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/arrange-check.ts --bundle --platform=node --format=cjs \
 *     --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/arrange/index.js
 *   npx electron out/arrange/index.js --db <copy-of-deepwork.db> [--shots <dir>]
 *
 * *"I want you to add like a live preview of how my dragging is affecting the
 * other panels"* - which is a behaviour no amount of reading the component
 * can confirm. The question is whether a sibling has **actually moved on
 * screen while the pointer is still down**, and the only way to know is to
 * hold a pointer down and measure.
 *
 * Pointer events are dispatched through CDP rather than synthesised in the
 * page, for the same reason the focus-ring diagnosis needed it: a synthetic
 * `PointerEvent` does not go through the browser's capture machinery, so a
 * handler bound with `setPointerCapture` never sees the moves and the check
 * would report a fault that only exists in the harness.
 *
 * With `--shots <dir>` it also captures the page mid-drag, which is the only
 * way to screenshot a gesture that is over before any other tool could look.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-arrange-${process.pid}`)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

function argument(name: string): string | null {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}

const source = argument('--db')
if (source) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(source + suffix)) {
      copyFileSync(source + suffix, join(profile, `deepwork.db${suffix}`))
    }
  }
}
const shotDir = argument('--shots')
/** Shots are asked for at the two widths the project screenshots at. */
const width = Number(argument('--width') ?? 1500) || 1500
if (shotDir !== null) mkdirSync(shotDir, { recursive: true })

import { analytics } from '../src/main/db/analytics'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? (pass += 1) : (fail += 1)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok && detail !== '') console.log(`       ${detail}`)
}

const watchdog = setTimeout(() => {
  console.log('')
  console.log('TIMED OUT - the run never reached its own exit')
  app.exit(1)
}, 300_000)
watchdog.unref?.()

/** What the renderer reports about where things are and what order they are in. */
interface Snapshot {
  sections: { id: string; title: string; top: number }[]
  panels: { title: string; left: number; top: number }[]
}

app.whenReady().then(async () => {
  let stored: unknown = null
  const reads: Record<string, () => unknown> = {
    'analytics:get': () => analytics(),
    'sessions:query': () => ({ rows: [], total: 0, hours: 0 }),
    'sessions:projects': () => [],
    'history:state': () => ({ canUndo: false, canRedo: false }),
    'backup:status': () => null,
    'import:existingCount': () => 0,
    'shortcuts:get': () => ({ pause: '', stop: '', newTimer: '' }),
    'window:isFullScreen': () => false,
    'app:preview': () => null,
    'layout:get': () => stored
  }
  for (const [channel, read] of Object.entries(reads)) {
    ipcMain.handle(channel, () => read())
  }
  // Echoed and remembered, so the check can assert that a drop was actually
  // written rather than only that the screen moved.
  ipcMain.handle('layout:set', (_event, layout) => {
    stored = layout
    return layout
  })

  const window = new BrowserWindow({
    show: true,
    width,
    height: 1000,
    useContentSize: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  const ask = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression, true)
  const settle = (ms: number): Promise<unknown> => new Promise((done) => setTimeout(done, ms))

  await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
  window.focus()
  await settle(1400)
  await ask(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Analytics'); if (b) b.click(); return 1 })()`
  )
  // Long enough for the Constellation, which is a lazy chunk and a WebGL
  // scene. At 2,600ms this check reported "the tab has more than one section
  // to reorder" as a failure, which is what a tab that has not finished
  // loading looks like from outside.
  await settle(5000)
  await ask(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Modify panels'); if (b) b.click(); return 1 })()`
  )
  await settle(600)

  const debug = window.webContents.debugger
  debug.attach('1.3')
  const pointer = async (type: string, x: number, y: number): Promise<void> => {
    await debug.sendCommand('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
      pointerType: 'mouse'
    })
  }

  const snapshot = (): Promise<Snapshot> =>
    ask(`(() => ({
      sections: [...document.querySelectorAll('.an-section')].map((el) => ({
        id: el.className,
        title: el.querySelector('.an-section__title').textContent.trim(),
        top: Math.round(el.getBoundingClientRect().top)
      })),
      panels: [...document.querySelectorAll('.an-slot')].map((el) => ({
        title: (el.querySelector('.an-panel__title')
          ? el.querySelector('.an-panel__title').childNodes[0].textContent.trim()
          : '?'),
        left: Math.round(el.getBoundingClientRect().left),
        top: Math.round(el.getBoundingClientRect().top)
      }))
    }))()`) as Promise<Snapshot>

  const shoot = async (name: string): Promise<void> => {
    if (shotDir === null) return
    const image = await window.webContents.capturePage()
    const file = join(shotDir, `${name}-${width}.png`)
    writeFileSync(file, image.toPNG())
    console.log(`       shot ${file}`)
  }

  console.log('')
  console.log('--- dragging a section by its header ---')
  const before = await snapshot()
  check('the tab has more than one section to reorder', before.sections.length > 1)
  const firstTitle = before.sections[0].title
  const secondTitle = before.sections[1].title

  /*
   * The second section is carried *up* onto the first, not the other way
   * round. Both directions exercise the same code, but dragging downward
   * carries the lifted card past a tall section and off the bottom of the
   * window, so the capture shows the hole it left and not the card itself -
   * half the evidence. Upward keeps both in one frame.
   */
  const grabAt = (await ask(`(() => {
    const h = document.querySelectorAll('.an-section > .an-section__title')[1];
    const r = h.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + r.height / 2 };
  })()`)) as { x: number; y: number }
  /*
   * The target section's **centre**, not 30px below its top.
   *
   * The drop index is "which captured slot centre is the pointer nearest",
   * so a section's own centre is the one aim that cannot be ambiguous
   * however tall the sections grow. It is not what fixed the failure this
   * was first written for - that was a side effect inside a state updater,
   * see `finish` in `arrange.ts` - but a check that aims at a fixed offset
   * from a growing section is a check that will fail for the wrong reason
   * later.
   */
  const dropAt = (await ask(`(() => {
    const s = document.querySelectorAll('.an-section')[0];
    const r = s.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + r.height / 2 };
  })()`)) as { x: number; y: number }

  // Built by concatenation, not a nested template: a `${...}` inside the
  // injected string is evaluated by the page, where the constant does not
  // exist. That has now cost two runs in this repo.
  const probe =
    '(() => { const el = document.elementFromPoint(' +
    Math.round(grabAt.x) +
    ', ' +
    Math.round(grabAt.y) +
    "); return el ? el.tagName + '.' + el.className + ' | in title=' + !!el.closest('.an-section__title') : 'nothing' })()"
  console.log('       at the grab point:', await ask(probe))
  await pointer('mousePressed', grabAt.x, grabAt.y)
  await settle(80)
  console.log(
    '       after press, lifted elements:',
    await ask("document.querySelectorAll('.is-lifted').length")
  )
  // Several moves, as a hand produces: one jump can be read as a click by
  // anything that debounces, and the point is to observe the middle.
  /*
   * Stopped two thirds of the way for the capture, then taken the rest of
   * the way. A screenshot at the end of the travel has the lifted card off
   * the bottom of the window and shows only the hole it left, which is half
   * the evidence - the point is that the lifted card and the shifted
   * siblings are visible in the same frame.
   */
  for (let i = 1; i <= 4; i += 1) {
    await pointer(
      'mouseMoved',
      grabAt.x + ((dropAt.x - grabAt.x) * i) / 6,
      grabAt.y + ((dropAt.y - grabAt.y) * i) / 6
    )
    await settle(60)
  }
  await settle(220)
  await shoot('arrange-section-mid-drag')

  for (let i = 5; i <= 6; i += 1) {
    await pointer(
      'mouseMoved',
      grabAt.x + ((dropAt.x - grabAt.x) * i) / 6,
      grabAt.y + ((dropAt.y - grabAt.y) * i) / 6
    )
    await settle(60)
  }
  await settle(220)

  const during = await snapshot()

  const moved = during.sections.find((one) => one.title.includes(firstTitle))
  const movedBefore = before.sections.find((one) => one.title.includes(firstTitle))
  check(
    'the section being displaced has moved while the pointer is still down',
    moved !== undefined && movedBefore !== undefined && Math.abs(moved.top - movedBefore.top) > 20,
    `was ${movedBefore?.top}, now ${moved?.top}`
  )
  check(
    'and the dragged one is marked as lifted',
    during.sections.some((one) => one.id.includes('is-lifted'))
  )

  await pointer('mouseReleased', dropAt.x, dropAt.y)
  await settle(500)

  const after = await snapshot()
  check(
    'dropping commits what the preview showed',
    after.sections[0].title.includes(secondTitle) && after.sections[1].title.includes(firstTitle),
    `order is now ${after.sections.map((one) => one.title).join(' / ')}`
  )
  /*
   * The content of what was written, not merely that something was. The
   * first version checked `Array.isArray(sections)`, which passes for the
   * order it already had - so a drop that committed nothing looked like a
   * drop that committed.
   */
  const storedSections = (stored as { sections?: string[] } | null)?.sections ?? []
  console.log(`       stored sections: ${storedSections.join(' / ')}`)
  check(
    'and the new order was written to the layout',
    storedSections.length > 1 && storedSections[0] !== 'glance',
    JSON.stringify(storedSections)
  )
  await shoot('arrange-sections-after')

  console.log('')
  console.log('--- Escape puts everything back ---')
  const settled = await snapshot()
  const grip = (await ask(`(() => {
    const g = document.querySelectorAll('.an-slot__grip')[0];
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)) as { x: number; y: number }
  await pointer('mousePressed', grip.x, grip.y)
  for (let i = 1; i <= 4; i += 1) {
    await pointer('mouseMoved', grip.x + 120 * i, grip.y + 40 * i)
    await settle(60)
  }
  await settle(200)
  await shoot('arrange-panel-mid-drag')
  await debug.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown',
    windowsVirtualKeyCode: 27,
    key: 'Escape',
    code: 'Escape'
  })
  await settle(500)
  await pointer('mouseReleased', grip.x + 480, grip.y + 160)
  await settle(400)

  const cancelled = await snapshot()
  check(
    'a cancelled drag leaves every panel where it was',
    JSON.stringify(cancelled.panels) === JSON.stringify(settled.panels),
    `before ${JSON.stringify(settled.panels.map((p) => p.title))}\n       after  ${JSON.stringify(cancelled.panels.map((p) => p.title))}`
  )

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})
