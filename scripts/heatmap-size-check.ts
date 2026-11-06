/**
 * Asserts the calendar grid stays the same size whatever range it is given.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/heatmap-size-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/heatmap/index.js
 *   npx electron out/heatmap/index.js --db <copy-of-deepwork.db>
 *
 * The bug this exists for: the grid is an svg with a viewBox and
 * `width: 100%`, so it scaled to whatever the panel gave it - which is what
 * makes it the first thing you see at 12 months, and what made a 30-day range
 * draw 225px day squares in a panel 2,304px tall. The user: *"the zoom of the
 * heatmap is NOT proportional to the timescale. look what happens - it zooms
 * in hella and then i can't see anything."*
 *
 * The invariant is stronger than "not too big", and that is deliberate: **a
 * day square is the same size at every range**. A week is a smaller picture
 * than a year because it contains less, not because its squares shrank. A
 * bound alone would be satisfied by a grid that still jumped from 12px to
 * 26px as the range changed, which would look like a zoom and be just as
 * wrong.
 *
 * Swept across both window widths and both text sizes, because the svg is
 * laid out by CSS: the first changes what `width: 100%` resolves to, and the
 * second is the control that already broke every typed axis width once.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-heatmap-${process.pid}`)
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

import { analytics } from '../src/main/db/analytics'

/**
 * The size a day square settles at, and how far it may stray.
 *
 * 26px is what 12 months and all time already drew on a wide window - the
 * state nobody complained about - and `MAX_CELL_PX` in `Heatmaps.tsx` is set
 * from the same number. A narrow window is allowed to draw *smaller*, because
 * there the grid genuinely does not fit and shrinking is the right answer;
 * what it may never do is grow.
 */
const MAX_CELL = 26
/** Below this a square stops being readable at all. */
const MIN_CELL = 8
/** A panel taller than this is the fault being guarded against. */
const MAX_PANEL_HEIGHT = 700

interface Reading {
  range: string
  width: number
  scale: number
  cell: number
  /** Rendered svg width, and the width the panel had to give it. */
  drawn: number
  room: number
  panelHeight: number
}

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail: string): void {
  ok ? (pass += 1) : (fail += 1)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) console.log(`       ${detail}`)
}

const watchdog = setTimeout(() => {
  console.log('')
  console.log('TIMED OUT - the run never reached its own exit')
  app.exit(1)
}, 300_000)
watchdog.unref?.()

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
    show: false,
    width: 1150,
    height: 1000,
    useContentSize: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  const ask = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression, true)
  const settle = (ms: number): Promise<unknown> => new Promise((done) => setTimeout(done, ms))

  const readings: Reading[] = []

  for (const width of [1150, 1900]) {
    for (const scaleText of ['1', '1.6']) {
      window.setContentSize(width, 1000)
      await window.loadURL('about:blank')
      await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
      await settle(900)
      await ask(
        `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Analytics'); if (b) b.click(); return 1 })()`
      )
      await settle(2600)
      await ask(
        `(() => {
          const p = document.querySelector('.panel--wide');
          if (p) p.style.setProperty('--an-fs', ${JSON.stringify(scaleText)});
          return 1;
        })()`
      )
      await settle(400)

      const found = (await ask(`(() => {
        const panel = [...document.querySelectorAll('.an-panel')]
          .find((el) => el.textContent.includes('Every day'));
        if (!panel) return null;
        return [...panel.querySelector('.an-range select').options].map((o) => o.value);
      })()`)) as string[] | null

      if (found === null) {
        console.log('the calendar panel was not found - nothing was measured')
        app.exit(1)
        return
      }

      for (const range of found) {
        await ask(`(() => {
          const panel = [...document.querySelectorAll('.an-panel')]
            .find((el) => el.textContent.includes('Every day'));
          const sel = panel.querySelector('.an-range select');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(range)});
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return 1;
        })()`)
        await settle(420)

        const one = (await ask(`(() => {
          const panel = [...document.querySelectorAll('.an-panel')]
            .find((el) => el.textContent.includes('Every day'));
          const svg = panel.querySelector('svg');
          const rect = svg && svg.querySelector('rect');
          if (!svg || !rect) return null;
          const viewBox = Number(svg.getAttribute('viewBox').split(' ')[2]);
          const box = svg.getBoundingClientRect();
          /*
           * The width the panel actually offers, so a square smaller than
           * the cap can be told apart from one that simply did not fit.
           *
           * The content box, not the border box. A bounding rect on the
           * parent includes its 18px of side padding, so a grid correctly
           * filling every pixel available to it measured 38px short and the
           * check reported a fault that was its own. No backticks in here:
           * this comment lives inside a template literal.
           */
          const parent = svg.parentElement;
          const style = getComputedStyle(parent);
          const room =
            parent.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight);
          return {
            scale: box.width / viewBox,
            cell: rect.getBoundingClientRect().width,
            drawn: box.width,
            room,
            panelHeight: panel.getBoundingClientRect().height
          };
        })()`)) as {
          scale: number
          cell: number
          drawn: number
          room: number
          panelHeight: number
        } | null

        if (one !== null) {
          readings.push({ range, width, ...one })
        }
      }
    }
  }

  console.log('')
  console.log('  range  width  text   scale   day square   panel height')
  for (const r of readings) {
    console.log(
      `  ${r.range.padEnd(6)} ${String(r.width).padEnd(6)} ` +
        `       ${r.scale.toFixed(2).padStart(5)}   ${r.cell.toFixed(1).padStart(8)}px   ` +
        `${Math.round(r.panelHeight).toString().padStart(8)}px`
    )
  }
  console.log('')

  const tooBig = readings.filter((r) => r.cell > MAX_CELL + 0.5)
  check(
    `no day square is drawn above ${MAX_CELL}px`,
    tooBig.length === 0,
    tooBig.map((r) => `${r.range} at ${r.width}px drew ${r.cell.toFixed(1)}px`).join('; ')
  )

  const tooSmall = readings.filter((r) => r.cell < MIN_CELL)
  check(
    `nor below ${MIN_CELL}px, where it stops being readable`,
    tooSmall.length === 0,
    tooSmall.map((r) => `${r.range} at ${r.width}px drew ${r.cell.toFixed(1)}px`).join('; ')
  )

  const tall = readings.filter((r) => r.panelHeight > MAX_PANEL_HEIGHT)
  check(
    `no panel is taller than ${MAX_PANEL_HEIGHT}px`,
    tall.length === 0,
    tall.map((r) => `${r.range} at ${r.width}px was ${Math.round(r.panelHeight)}px`).join('; ')
  )

  /*
   * The one that actually describes the fix, and it took a failing run to
   * state correctly.
   *
   * The first attempt asserted a day is the same size at every range full
   * stop, which is true at 1,900px and false at 1,150px - and rightly so: a
   * 52-column year needs about 1,800px to draw at 26px and only has 1,090,
   * so it shrinks to 15.2px. Shrinking to fit is the correct behaviour, not
   * a second bug; the assertion was wrong, not the code.
   *
   * So the real invariant has two halves. A square is either **at** the cap,
   * or it is smaller **only because the grid had no room** - which is
   * checkable, because a grid that ran out of room is one whose svg fills
   * the width it was offered. What that rules out is the thing the user saw:
   * a grid choosing to be bigger when it has fewer columns.
   */
  const shrunk = readings.filter((r) => r.cell < MAX_CELL - 0.5)
  const unexplained = shrunk.filter((r) => r.drawn < r.room - 1)
  check(
    'a day is at full size unless the grid ran out of room',
    unexplained.length === 0,
    unexplained
      .map(
        (r) =>
          `${r.range} at ${r.width}px drew ${r.cell.toFixed(1)}px in ` +
          `${Math.round(r.drawn)}px with ${Math.round(r.room)}px available`
      )
      .join('; ')
  )
  /*
   * `custom` is in this list because an untyped custom span resolves to all
   * time - the safe direction, documented in `windowDefFor` - so on the
   * narrow window it shrinks exactly as all time does. It is not an
   * exception to the rule above, it is the rule applying to a window whose
   * length happens to be the whole history.
   */
  check(
    'and the ones that shrank are the long ranges on the narrow window',
    shrunk.every((r) => r.width === 1150 && ['1y', '2y', 'all', 'custom'].includes(r.range)),
    shrunk.map((r) => `${r.range} at ${r.width}px`).join('; ')
  )

  console.log('')
  console.log(`${pass} passed, ${fail} failed, over ${readings.length} readings`)
  app.exit(fail === 0 ? 0 : 1)
})
