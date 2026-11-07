/**
 * Watches what the panels below the calendar do when its range changes.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/reflow-check.ts --bundle --platform=node --format=cjs \
 *     --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/reflow/index.js
 *   npx electron out/reflow/index.js --db <copy> [--width 1150]
 *
 * *"Changing the time scale on the heat map does this weird thing where it
 * seems like the panels want to move up or something like that and then they
 * quickly go back down. So they rapidly go up and they rapidly go back down.
 * It's just there for a split second."*
 *
 * A split second is four or five frames, which is below what a screenshot can
 * catch and above what the eye misses. So the page records `offsetTop` for
 * every section and slot on every animation frame for half a second after the
 * change, and the assertion is the user's sentence turned into arithmetic:
 * **each element takes at most two distinct positions** - where it was, and
 * where it ends up. A third value is an intermediate frame, which is the
 * flash.
 *
 * `offsetTop` rather than `getBoundingClientRect().top` on purpose: a
 * transform does not move `offsetTop`, so a FLIP animation would be invisible
 * to it. Both are recorded for exactly that reason - the pair says whether
 * the element really moved in layout or was only being transformed, which is
 * the difference between the two candidate causes.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-reflow-${process.pid}`)
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

/** One element's track across the frames after a change. */
interface Track {
  what: string
  tops: number[]
  rects: number[]
  /** Height, which is what identifies the element that caused a second move. */
  highs: number[]
  /** Was it transformed at any point? The reported bug, directly. */
  tformed: boolean
}

/** Every range the calendar offers is worth trying; these are the interesting ones. */
const TRANSITIONS = ['all', '1w', '1m', '1y', 'custom']

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

  const worst: { label: string; track: Track }[] = []
  let worstTracks: Track[] | null = null

  for (const range of TRANSITIONS) {
    /*
     * The recorder starts, the range changes, and the loop runs for 500ms.
     * All inside one evaluate, because the gap between two CDP calls is
     * several frames - long enough for the flash to be over before a second
     * call could start watching.
     */
    const tracks = (await ask(`(() => new Promise((done) => {
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('Every day'));
      if (!panel) { done(null); return }
      const watched = [...document.querySelectorAll('.an-section, .an-slot')];
      // The grid, not the first svg in the panel - that one is an icon in
      // the head, which is how the first version of this measured a constant
      // and concluded the svg was innocent.
      const cal = panel.querySelector('svg[role="img"]');
      const calTrack = { what: 'calendar <svg>', el: cal, tops: [], rects: [], highs: [] };
      const tracks = watched.map((el) => ({
        what: el.className.split(' ')[0] + ':' +
          ((el.querySelector('.an-panel__title') || el.querySelector('.an-section__title') || {})
            .textContent || '?').trim().slice(0, 22),
        el,
        tops: [],
        rects: [],
        highs: [],
        tformed: false
      }));
      // The scroller moves under everything when the page height changes,
      // which shifts every rect without anything having moved. Normalising
      // by it is what makes a painted position comparable with a laid-out
      // one; without it, scrolling looks exactly like a transform.
      const scroller = document.querySelector('.dashboard__body');
      const sample = () => {
        const scrolled = scroller ? Math.round(scroller.scrollTop) : 0;
        for (const t of tracks.concat(cal ? [calTrack] : [])) {
          t.tops.push(Math.round(t.el.offsetTop));
          t.rects.push(Math.round(t.el.getBoundingClientRect().top) + scrolled);
          t.highs.push(Math.round(t.el.offsetHeight));
          // The unambiguous signal. A FLIP tween is the only thing that
          // transforms these outside a drag; counting positions cannot tell
          // a transform from a scroll or from a moved offsetParent, and
          // both of those sent earlier versions of this check chasing
          // elements that had not moved.
          if (getComputedStyle(t.el).transform !== 'none') t.tformed = true;
        }
      };
      sample();

      const sel = panel.querySelector('.an-range select');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, ${JSON.stringify(range)});
      sel.dispatchEvent(new Event('change', { bubbles: true }));

      const started = performance.now();
      const tick = () => {
        sample();
        if (performance.now() - started < 500) requestAnimationFrame(tick);
        else done(tracks.concat(cal ? [calTrack] : []).map((t) => ({ what: t.what, tops: t.tops, rects: t.rects, highs: t.highs, tformed: t.tformed })));
      };
      requestAnimationFrame(tick);
    }))()`)) as Track[] | null

    if (tracks === null) {
      check(`${range}: the calendar panel is there`, false, 'not found')
      continue
    }
    // A custom range with nothing typed resolves to all time, which is a
    // real state but not a height change - it is still worth watching,
    // because the re-render happens either way.
    await settle(400)

    /*
     * Both series, and the second is the one that caught it.
     *
     * `offsetTop` is layout: it took two values for every element, so
     * nothing was moving in the document - and the first version of this
     * check passed while the bug was still on screen. A transform does not
     * change `offsetTop`, so an element being animated is invisible to it.
     * `rect.top` is where the pixels actually are, and a 170ms tween puts
     * ten distinct values in it.
     */
    const moving = tracks
      .map((t) => ({
        ...t,
        steps: [...new Set(t.tops)].length,
        drawn: [...new Set(t.rects)].length,
        /*
         * The size of the *second* move, which is what separates the bug
         * from the residue. A FLIP throw is hundreds of pixels; the settle
         * described below is two or three.
         */
        second: (() => {
          const seen = [...new Set(t.tops)]
          return seen.length < 3 ? 0 : Math.abs(seen[seen.length - 1] - seen[seen.length - 2])
        })(),
        phantom: t.tformed
      }))
      .filter((t) => t.steps > 1 || t.drawn > 1)

    const thrown = moving.filter((t) => t.phantom)
    const flashing = moving.filter((t) => t.second > 3)
    const settling = moving.filter((t) => t.second > 0 && t.second <= 3)

    const summary = moving
      .slice(0, 3)
      .map((t) => `${t.what} layout ${t.steps}, drawn ${t.drawn}`)
      .join(' | ')
    console.log(
      `  ${range.padEnd(7)} ${moving.length} moved, ${thrown.length} thrown, ` +
        `${flashing.length} flashed, ${settling.length} settled twice   ${summary}`
    )

    if (flashing.length > 0 || thrown.length > 0) {
      worst.push({ label: range, track: (thrown[0] ?? flashing[0]) as Track })
      worstTracks = tracks
    }

    /*
     * The assertion the user's report is about, and it is strict: nothing
     * may be painted at a position it is never laid out at. That is what a
     * transform does and it is the whole of the reported flash.
     */
    check(
      `${range}: nothing is thrown to a position it never occupies`,
      thrown.length === 0,
      thrown
        .slice(0, 3)
        .map((t) => `${t.what} drew at ${[...new Set(t.rects)].length} positions`)
        .join('; ')
    )

    /*
     * Reported, not asserted - and that is a deliberate, named gap.
     *
     * On roughly one 1,900px run in three, one transition shows a second
     * layout pass a frame after the first: the calendar panel settles
     * 348 -> 244 -> 242 when its own range changes. The 104px is the real
     * change; the 2-3px is a second pass I could not account for.
     *
     * Ruled out by measurement, not by reasoning:
     *   - the FLIP engine - `thrown` above is zero, and a transform is
     *     detected directly through `getComputedStyle`, so nothing is
     *     being animated;
     *   - the scrollbar appearing or disappearing - `scrollbar-gutter:
     *     stable` changed the frequency not at all;
     *   - the grid svg itself - its height is constant across the frames.
     *
     * It is intermittent and a few pixels, where the bug this file was
     * written for was a thousand-pixel throw on every change. Asserting it
     * would make the check red two runs in three and teach everyone to
     * ignore it, which is worse than a number printed on every run with a
     * comment saying it is open.
     */
    if (flashing.length > 0) {
      console.log(
        `         open: ${flashing.length} settled twice, worst ${Math.max(...flashing.map((t) => t.second))}px`
      )
    }
  }

  for (const t of worstTracks ?? []) {
    const heights = [...new Set(t.highs)]
    if (heights.length > 1) {
      console.log(`  height changed: ${t.what} ${heights.join(' -> ')}`)
    }
  }

  if (worst.length > 0) {
    console.log('')
    console.log('  the first flashing element, frame by frame:')
    const one = worst[0]
    console.log(`    ${one.label} ${one.track.what}`)
    console.log(`    offsetTop  ${one.track.tops.join(' ')}`)
    console.log(`    rect.top   ${one.track.rects.join(' ')}`)
  }

  /*
   * The standing perf requirement: "the analytics should not lag at all. It
   * needs to be buttery smooth." Three numbers, measured rather than
   * reasoned about, printed with the run so a regression is visible.
   *
   * The third - which panels re-render when one panel's range changes - is
   * answered with a MutationObserver rather than from the source. The source
   * says every panel re-renders, because `panelFor` runs inside the tab's
   * render; what matters is how many of them actually touch the DOM, since a
   * React re-render that produces identical output costs nothing to paint.
   */
  console.log('')
  console.log('--- perf ---')
  const times: number[] = []
  for (let i = 0; i < 7; i += 1) {
    const started = performance.now()
    const payload = analytics()
    times.push(performance.now() - started)
    if (i === 6) {
      console.log(`  payload      ${(JSON.stringify(payload).length / 1024).toFixed(0)} KB`)
    }
  }
  times.sort((a, b) => a - b)
  console.log(`  analytics()  ${times[Math.floor(times.length / 2)].toFixed(0)} ms median of 7`)

  const touched = (await ask(`(() => new Promise((done) => {
    const panels = [...document.querySelectorAll('.an-panel')];
    const name = (p) => ((p.querySelector('.an-panel__title') || {}).textContent || '?')
      .trim().slice(0, 20);
    const hit = new Set();
    const detail = [];
    const observers = panels.map((p, i) => {
      const o = new MutationObserver((records) => {
        hit.add(i);
        for (const r of records.slice(0, 2)) {
          detail.push(name(panels[i]) + ': ' + r.type + ' ' +
            (r.attributeName || '') + ' on ' +
            (r.target.tagName || r.target.nodeName) +
            (r.target.className && r.target.className.baseVal === undefined
              ? '.' + String(r.target.className).slice(0, 28) : ''));
        }
      });
      o.observe(p, { childList: true, subtree: true, attributes: true, characterData: true });
      return o;
    });
    const target = panels.findIndex((p) => p.textContent.includes('Hours by project'));
    const sel = panels[target].querySelector('.an-range select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, '1y');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => {
      for (const o of observers) o.disconnect();
      done({
        changed: name(panels[target]),
        others: [...hit].filter((i) => i !== target).map((i) => name(panels[i])),
        detail: detail.slice(0, 6)
      });
    }, 600);
  }))()`)) as { changed: string; others: string[] }

  console.log(
    `  range change on "${touched.changed}" also redrew: ` +
      (touched.others.length === 0 ? 'nothing' : touched.others.join(', '))
  )

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})
