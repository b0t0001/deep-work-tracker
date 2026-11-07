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

/**
 * The two hand-drawn grids, hovered by cell rather than by bar.
 *
 * They were the one place in the tab still showing an svg `<title>` - an OS
 * tooltip in its own font, at its own delay, in its own corner. The check
 * covers them the same way and additionally asserts that **no `<title>`
 * survives**: leaving one in place beside the styled box shows both, one of
 * them late, which is worse than either alone.
 */
const HEATMAPS = ['Every day', 'Time of day']

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
  const heatmaps: { panel: string; inside: boolean; titles: number }[] = []

  for (const name of PANELS) {
    /*
     * Scroll, wait, and only then measure.
     *
     * The first version did all three in one evaluate and hovered 420ms
     * later, which worked until a layout change moved the panel during
     * those 420ms - the coordinates were then a rect that no longer existed
     * and Recharts registered nothing, so the check reported "no tooltip"
     * for a tooltip that was fine. A position read after everything has
     * settled cannot go stale between reading it and using it.
     */
    await ask(`(() => {
      const p = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes(${JSON.stringify(name)}));
      if (p) p.scrollIntoView({ block: 'center' });
      return 1;
    })()`)
    await settle(420)

    const spot = (await ask(`(() => {
      const p = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes(${JSON.stringify(name)}));
      if (!p) return null;
      const bar = p.querySelector('.recharts-bar-rectangle path, .recharts-bar-rectangle rect');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(20, r.height / 2) };
    })()`)) as { x: number; y: number } | null

    if (spot === null) {
      check(`${name}: a bar to hover`, false, 'no bar found')
      continue
    }
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

  for (const name of HEATMAPS) {
    /*
     * Hovered by trial rather than by index.
     *
     * The first version took the middle cell and both grids answered "No
     * work" - true, and useless as evidence that the box can show a figure.
     * Which cells have work is not readable from the DOM without decoding
     * the fill, so the check hovers candidates until one answers with a
     * digit, and falls back to whatever it last saw if none does.
     */
    await ask(`(() => {
      const p = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes(${JSON.stringify(name)}));
      if (p) p.scrollIntoView({ block: 'center' });
      return 1;
    })()`)
    await settle(420)

    let got: (Omit<Reading, 'panel'> & { inside: boolean; titles: number }) | null = null
    for (const nth of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
      const spot = (await ask(`(() => {
      const p = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes(${JSON.stringify(name)}));
      if (!p) return null;
      p.scrollIntoView({ block: 'center' });
      // A cell with work in it, so the box has figures rather than "No work".
      // hm-cell is a rect in the drawn grid and a span in the empty state's
      // track. Both are this panel's hover surface, and on a young history
      // the second is the one actually on screen.
      const cells = [...p.querySelectorAll('.hm-cell')];
      const cell = cells[${nth} % Math.max(1, cells.length)];
      if (!cell) return null;
      const r = cell.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)) as { x: number; y: number } | null

      if (spot === null) break
      await move(spot.x - 4, spot.y)
      await move(spot.x, spot.y)

      const reading = (await ask(`(() => {
      const p = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes(${JSON.stringify(name)}));
      const tip = p && p.querySelector('.ac-tip');
      if (!tip) return null;
      const value = tip.querySelector('.ac-tip__value');
      const label = tip.querySelector('.ac-tip__name') || tip.querySelector('.ac-tip__when');
      if (!value || !label) return null;
      const vs = getComputedStyle(value);
      const ls = getComputedStyle(label);
      const when = tip.querySelector('.ac-tip__when');
      const box = tip.getBoundingClientRect();
      const panel = p.getBoundingClientRect();
      return {
        caption: when ? when.textContent : '',
        value: value.textContent,
        valuePx: parseFloat(vs.fontSize),
        valueColour: vs.color,
        namePx: parseFloat(ls.fontSize),
        nameColour: ls.color,
        cursors: document.querySelectorAll('.recharts-tooltip-cursor').length,
        inside: box.left >= panel.left - 1 && box.right <= panel.right + 1,
        // Both forms of OS tooltip: the svg element and the HTML attribute.
        // Only counting the element would have passed the empty-state track,
        // which carried the attribute form instead. No backticks in here -
        // this comment is inside a template literal, and one ends it.
        titles: p.querySelectorAll('title').length + p.querySelectorAll('[title]').length
      };
    })()`)) as (Omit<Reading, 'panel'> & { inside: boolean; titles: number }) | null

      if (reading !== null) got = reading
      if (reading !== null && /[0-9]/.test(reading.value)) break
    }

    if (got === null) {
      check(`${name}: the hover box opens`, false, 'no .ac-tip in the panel')
      continue
    }
    readings.push({ panel: name, ...got })
    heatmaps.push({ panel: name, inside: got.inside, titles: got.titles })

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
    'every chart and both heatmaps showed the box',
    readings.length === PANELS.length + HEATMAPS.length,
    `${readings.length} of ${PANELS.length + HEATMAPS.length}`
  )
  check(
    'no svg <title> is left on a heatmap to show a second, native tooltip',
    heatmaps.length === HEATMAPS.length && heatmaps.every((one) => one.titles === 0),
    heatmaps.map((one) => `${one.panel}: ${one.titles}`).join('; ')
  )
  check(
    'and the box stays inside its panel',
    heatmaps.length === HEATMAPS.length && heatmaps.every((one) => one.inside),
    heatmaps.map((one) => `${one.panel}: ${one.inside}`).join('; ')
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
