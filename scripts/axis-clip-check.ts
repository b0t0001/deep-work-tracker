/**
 * Finds axis labels that are cut off **or overlapping**, at every timescale
 * every panel offers.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/axis-clip-check.ts --bundle --platform=node --format=cjs \
 *     --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/clip/index.js
 *   npx electron out/clip/index.js --db <copy-of-deepwork.db> [--width 1150,1900]
 *
 * The user's report is "do you see how the numbers clip off if the timescale
 * is too big?". The reason that is worth a harness rather than a screenshot is
 * that it is a *combinatorial* fault: eight panels times up to seven
 * timescales times two window widths is over a hundred states, the labels only
 * clip in some of them, and each individual screenshot looks fine until you
 * know which number should have been there. Every axis width in the file was a
 * fixed guess that happened to fit the data the chart was first drawn with.
 *
 * What is measured, rather than looked at: every `<text>` Recharts draws,
 * compared against the chart's own svg box. An svg clips at its viewport, so a
 * tick whose rectangle runs past that edge is a tick with its first or last
 * characters missing. Reported as overflow in pixels per side, with the text
 * that was cut, so a failure names the label rather than the chart.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'

// A window that Windows considers covered is a window Chromium stops painting
// and measuring - which cost a day on the tooltip check before it was found.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-clip-${process.pid}`)
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

/*
 * The text-size control is swept too, and it is the reason this found
 * anything at all.
 *
 * Axis tick text is `calc(11px * var(--an-fs))`, so the Modify panels A+
 * button makes every label up to 60% wider while the axis widths stay the
 * numbers somebody typed. At scale 1 and today's data almost nothing clips;
 * the fixed guesses are a fault waiting for either more digits or bigger
 * type, and the user can reach the second in two clicks. Setting the custom
 * property directly is faithful to what the button does - it is the same
 * property on the same element, and the point is precisely that Recharts does
 * NOT re-measure when it changes.
 */
const scales = (argument('--scale') ?? '1,1.6')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((s) => Number.isFinite(s) && s > 0)

const widths = (argument('--width') ?? '1150,1900')
  .split(',')
  .map((w) => Number(w.trim()))
  .filter((w) => Number.isFinite(w) && w > 400)

import { analytics } from '../src/main/db/analytics'

/**
 * A pixel of slack, because a glyph's reported box is not its ink.
 *
 * `getBoundingClientRect` on an svg text node includes the font's side
 * bearings, so a label that ends exactly at the edge measures a fraction past
 * it while every pixel of ink is inside. Anything over a pixel is a real
 * clip; under it is a rounding artefact, and failing on those would make the
 * check cry wolf until nobody ran it.
 */
const SLACK = 1

/** Two value labels need this much clear air between them to read as two. */
const MIN_LABEL_GAP = 4

interface Clip {
  panel: string
  range: string
  width: number
  scale: number
  side: string
  over: number
  text: string
}

const clips: Clip[] = []
let states = 0

const watchdog = setTimeout(() => {
  console.log('')
  console.log('TIMED OUT - the run never reached its own exit')
  app.exit(1)
}, 600_000)
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
    width: widths[0],
    height: 1000,
    useContentSize: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  const ask = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression, true)
  const settle = (ms: number): Promise<unknown> => new Promise((done) => setTimeout(done, ms))

  for (const { width, scale } of widths.flatMap((width) =>
    scales.map((scale) => ({ width, scale }))
  )) {
    window.setContentSize(width, 1000)
    await window.loadURL('about:blank')
    await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
    await settle(900)
    await ask(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Analytics'); if (b) b.click(); return 1 })()`
    )
    /*
     * Waited for, not timed.
     *
     * These checks all slept ~2.6s for the Analytics tab and all five began
     * failing at once when the Constellation arrived - a lazily loaded WebGL
     * panel that takes longer than that to appear. A check reporting "the
     * calendar panel is there: FAIL" for a tab that was merely still loading
     * is a check that will cry wolf every time the tab gets heavier.
     */
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = (await ask("document.querySelectorAll('.an-slot').length")) as number
      if (ready >= 7) break
      await settle(250)
    }
    await settle(900)
    await ask(
      `(() => {
        const p = document.querySelector('.panel--wide');
        if (p) p.style.setProperty('--an-fs', ${JSON.stringify(String(scale))});
        return 1;
      })()`
    )
    await settle(500)

    /*
     * Panels are found by their own heading, never by index - they are
     * rearrangeable, so position is not an identity, and a check reporting on
     * the panel next to the one it names is worse than no check.
     */
    const panels = (await ask(`(() => [...document.querySelectorAll('.an-panel')]
      .map((p) => {
        const title = p.querySelector('.an-panel__title');
        const select = p.querySelector('.an-range select');
        return {
          title: title ? title.childNodes[0].textContent.trim() : '(untitled)',
          options: select ? [...select.options].map((o) => o.value) : []
        };
      })
      .filter((p) => p.options.length > 0))()`)) as Array<{ title: string; options: string[] }>

    if (panels.length === 0) {
      console.log(`  no panels with a range control at ${width}px - nothing was measured`)
      app.exit(1)
      return
    }

    for (const panel of panels) {
      for (const option of panel.options) {
        await ask(`(() => {
          const p = [...document.querySelectorAll('.an-panel')]
            .find((el) => el.querySelector('.an-panel__title') &&
                          el.querySelector('.an-panel__title').childNodes[0].textContent.trim() === ${JSON.stringify(panel.title)});
          if (!p) return 0;
          const sel = p.querySelector('.an-range select');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(option)});
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return 1;
        })()`)
        // Recharts measures its container on a resize observer and redraws
        // asynchronously, so a measurement taken on the same frame as the
        // change is a measurement of the previous range.
        await settle(420)

        const found = (await ask(`(() => {
          const p = [...document.querySelectorAll('.an-panel')]
            .find((el) => el.querySelector('.an-panel__title') &&
                          el.querySelector('.an-panel__title').childNodes[0].textContent.trim() === ${JSON.stringify(panel.title)});
          if (!p) return [];
          const out = [];
          for (const svg of p.querySelectorAll('.recharts-wrapper svg.recharts-surface')) {
            const box = svg.getBoundingClientRect();
            for (const text of svg.querySelectorAll('text')) {
              const content = (text.textContent || '').trim();
              if (content === '') continue;
              const r = text.getBoundingClientRect();
              if (r.width === 0) continue;
              const sides = [
                ['left', box.left - r.left],
                ['right', r.right - box.right],
                ['top', box.top - r.top],
                ['bottom', r.bottom - box.bottom]
              ];
              for (const [side, over] of sides) {
                if (over > ${SLACK}) out.push({ side, over: Math.round(over * 10) / 10, text: content });
              }
            }

            /*
             * And labels that run into each other, which is a different
             * fault with the same cause and is invisible to the edge test.
             * "numbers still don't display on this chart" was answered by
             * writing a value on every bar; a value on every bar is only an
             * answer if they can all be read, and two that overlap are two
             * that cannot.
             *
             * Only the value labels, found by their own class - axis ticks
             * are thinned by Recharts on purpose and a date landing near
             * another date is not the same problem. Compared pairwise along
             * a row, after sorting by x, so a wrapped label on the row below
             * is not mistaken for a collision.
             */
            const values = [...svg.querySelectorAll('.ac__value')]
              .map((node) => ({ text: (node.textContent || '').trim(), r: node.getBoundingClientRect() }))
              .filter((one) => one.text !== '' && one.r.width > 0)
              .sort((a, b) => a.r.left - b.r.left);
            for (let i = 1; i < values.length; i += 1) {
              const before = values[i - 1];
              const here = values[i];
              const sameRow = Math.abs(before.r.top - here.r.top) < before.r.height * 0.6;
              /*
               * A *gap* is required, not merely the absence of overlap.
               * All time once left 0.8px between two numbers: they did not
               * overlap, and they read as one number. MIN_LABEL_GAP is what
               * turns "they do not touch" into "they can be told apart".
               */
              const over = before.r.right + ${MIN_LABEL_GAP} - here.r.left;
              if (sameRow && over > ${SLACK}) {
                out.push({
                  side: 'overlap',
                  over: Math.round(over * 10) / 10,
                  text: before.text + ' / ' + here.text
                });
              }
            }
          }
          return out;
        })()`)) as Array<{ side: string; over: number; text: string }>

        states += 1
        for (const one of found) {
          clips.push({ panel: panel.title, range: option, width, scale, ...one })
        }
      }
      // Back to where it was, so one panel's sweep cannot change what the next
      // one is measured against.
      await ask(`(() => {
        const p = [...document.querySelectorAll('.an-panel')]
          .find((el) => el.querySelector('.an-panel__title') &&
                        el.querySelector('.an-panel__title').childNodes[0].textContent.trim() === ${JSON.stringify(panel.title)});
        if (!p) return 0;
        const sel = p.querySelector('.an-range select');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(panel.options[panel.options.length - 1])});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 1;
      })()`)
      await settle(300)
    }
  }

  console.log('')
  console.log(`measured ${states} panel/timescale/width/text-size states`)
  if (clips.length === 0) {
    console.log('no clipped axis labels')
    app.exit(0)
    return
  }

  // Grouped by panel and side: one axis sized wrong produces a clip at every
  // timescale, and a flat list of eighty lines hides how few causes there are.
  const groups = new Map<string, Clip[]>()
  for (const clip of clips) {
    const key = `${clip.panel} | ${clip.side}`
    const list = groups.get(key) ?? []
    list.push(clip)
    groups.set(key, list)
  }
  console.log(`${clips.length} clipped labels, in ${groups.size} places:`)
  console.log('')
  for (const [key, list] of [...groups.entries()].sort()) {
    const worst = list.reduce((a, b) => (b.over > a.over ? b : a))
    const ranges = [...new Set(list.map((c) => c.range))].join(' ')
    const sizes = [...new Set(list.map((c) => c.width))].join(' ')
    const scaled = [...new Set(list.map((c) => c.scale))].join(' ')
    console.log(`  ${key}`)
    console.log(
      `      worst ${worst.over}px on "${worst.text}" ` +
        `(${worst.range}, ${worst.width}px, text ${worst.scale}x)`
    )
    console.log(
      `      ${list.length} labels  ·  ranges: ${ranges}  ·  widths: ${sizes}  ·  text: ${scaled}`
    )
  }
  app.exit(1)
})
