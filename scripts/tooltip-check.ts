/**
 * Hovers a bar on every chart and measures what the tooltip says and how.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/tooltip-check.ts --bundle --platform=node --format=cjs \
 *     --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/tooltip/index.js
 *   npx electron out/tooltip/index.js --db <copy> [--shots <dir>] [--width 1150]
 *
 * Two complaints, and both are about pixels rather than wording:
 *
 * - *"The actual statistic should be white and it should pop out and it
 *   should be in a bigger font size."* So this reads the **computed** size
 *   and colour of the value against the words around it, rather than
 *   trusting that a class was applied.
 * - *"I hate this highlight effect. Get rid of it."* The grey band Recharts
 *   paints behind the hovered bar is `.recharts-tooltip-cursor`. Asserting
 *   that no such element exists while a tooltip is open is the only way to
 *   tell `cursor={false}` from a cursor that is merely transparent.
 *
 * Hovering goes through CDP for the same reason the drag check does: a
 * synthetic `mousemove` does not drive Recharts' own pointer handling, so
 * the tooltip would never open and the check would report its own failure.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-tip-${process.pid}`)
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
if (shotDir !== null) mkdirSync(shotDir, { recursive: true })
const width = Number(argument('--width') ?? 1150) || 1150

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

interface Reading {
  panel: string
  caption: string
  value: string
  valuePx: number
  valueColour: string
  namePx: number
  nameColour: string
  cursors: number
}

/** Every panel here draws bars, which are the easiest thing to land on. */
const PANELS = ['Hours per', 'Hours by project', 'Are your timers', 'per minute']

app.whenReady().then(async () => {
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
    'layout:get': () => null
  }
  for (const [channel, read] of Object.entries(reads)) {
    ipcMain.handle(channel, () => read())
  }
  ipcMain.handle('layout:set', (_event, layout) => layout)

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
  await settle(2800)

  const debug = window.webContents.debugger
  debug.attach('1.3')
  const move = async (x: number, y: number): Promise<void> => {
    await debug.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y),
      buttons: 0
    })
    await settle(140)
  }

  const readings: Reading[] = []

  for (const name of PANELS) {
    const spot = (await ask(`(() => {
      const p = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes(${JSON.stringify(name)}));
      if (!p) return null;
      p.scrollIntoView({ block: 'center' });
      const bar = p.querySelector('.recharts-bar-rectangle path, .recharts-bar-rectangle rect');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(20, r.height / 2) };
    })()`)) as { x: number; y: number } | null

    if (spot === null) {
      check(`${name}: a bar to hover`, false, 'no bar found')
      continue
    }
    await settle(420)
    // Twice: Recharts ignores a first move that arrives with no prior
    // position inside the chart, so one event opens nothing.
    await move(spot.x - 5, spot.y)
    await move(spot.x, spot.y)

    const got = (await ask(`(() => {
      const tip = document.querySelector('.ac-tip');
      if (!tip) return null;
      const value = tip.querySelector('.ac-tip__value');
      const label = tip.querySelector('.ac-tip__name') || tip.querySelector('.ac-tip__when');
      if (!value || !label) return null;
      const vs = getComputedStyle(value);
      const ls = getComputedStyle(label);
      const when = tip.querySelector('.ac-tip__when');
      return {
        caption: when ? when.textContent : '',
        value: value.textContent,
        valuePx: parseFloat(vs.fontSize),
        valueColour: vs.color,
        namePx: parseFloat(ls.fontSize),
        nameColour: ls.color,
        cursors: document.querySelectorAll('.recharts-tooltip-cursor').length
      };
    })()`)) as Omit<Reading, 'panel'> | null

    if (got === null) {
      check(`${name}: the tooltip opens`, false, 'no .ac-tip in the page')
      continue
    }
    readings.push({ panel: name, ...got })

    if (shotDir !== null) {
      const image = await window.webContents.capturePage()
      const file = join(
        shotDir,
        `tooltip-${name.replace(/[^a-z]+/gi, '-').toLowerCase()}-${width}.png`
      )
      writeFileSync(file, image.toPNG())
      console.log(`       shot ${file}`)
    }
  }

  console.log('')
  for (const r of readings) {
    console.log(
      `  ${r.panel.padEnd(18)} "${r.caption}" -> ${r.value}   ` +
        `value ${r.valuePx}px ${r.valueColour} / label ${r.namePx}px ${r.nameColour}   ` +
        `cursors ${r.cursors}`
    )
  }
  console.log('')

  check(
    'every chart with bars showed a tooltip',
    readings.length === PANELS.length,
    `${readings.length} of ${PANELS.length}`
  )
  check(
    'the statistic is larger than the words around it',
    readings.length > 0 && readings.every((r) => r.valuePx >= r.namePx + 4),
    readings.map((r) => `${r.panel}: ${r.valuePx} vs ${r.namePx}`).join('; ')
  )
  check(
    'the statistic is white and the words are not',
    readings.length > 0 &&
      readings.every((r) => r.valueColour !== r.nameColour && r.valueColour.includes('242')),
    readings.map((r) => `${r.panel}: ${r.valueColour} vs ${r.nameColour}`).join('; ')
  )
  check(
    'and nothing is highlighted behind the bar',
    readings.length > 0 && readings.every((r) => r.cursors === 0),
    readings.map((r) => `${r.panel}: ${r.cursors}`).join('; ')
  )

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})
