/**
 * Screenshot harness. Renders the real renderer bundle against real data and
 * writes PNGs, so UI work is judged by looking at it rather than by reading
 * the markup — the practice CLAUDE.md insists on, after a night lost to
 * diagnosing a layout fault from JSX.
 *
 * It is NOT the app. It registers only the read handlers the windows call on
 * paint, stubs the writes, and points `userData` at a throwaway profile, so it
 * can never touch the real database or the real backup folder. `runBackup()`
 * is deliberately never called: it resolves Documents, which is where the
 * user's actual history lives.
 *
 *   npm run build
 *   npx electron out/shoot/index.js --db <copy-of-deepwork.db> --out <dir> [--only <id,id>]
 *   npx electron out/shoot/index.js --csv <backup.csv>  --out <dir> [--only <id,id>]
 *
 * Bundled by `npm run shoot`. Each shot is one entry in SHOTS below: a window
 * size, a route, and an optional script that drives the renderer into the
 * state worth seeing (open a tab, switch to the ring, start the clock).
 */
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { restoreFromCsv } from '../src/main/restore'
import {
  allProjectNames,
  lastProjectName,
  lastUnitFor,
  listProjects,
  querySessions
} from '../src/main/db/sessions'
import { historyState } from '../src/main/db/history'
import { analytics } from '../src/main/db/analytics'
import { backupStatus } from '../src/main/backup'
import { TimerEngine } from '../src/main/timer'

interface Shot {
  id: string
  /** Logical window size in px, matching what the app actually opens. */
  width: number
  height: number
  /** Hash route: '' for the timer, '/dashboard', '/pace'. */
  route: string
  /** Runs in the renderer once loaded, to reach the state worth capturing. */
  drive?: string
  /** Main-process setup, before the window loads. Drives the timer engine. */
  before?: () => void
  note: string
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

const csvPath = arg('csv')
const dbPath = arg('db')
const failAnalytics = process.argv.includes('--fail-analytics')
// `--preview` answers as `npm run preview` would, so the dashboard's preview
// banner can be seen - including its worst line, a change it could not save.
const asPreview = process.argv.includes('--preview')
const outDir = resolve(arg('out') ?? join(process.cwd(), 'shots'))
/*
 * `--live` shows the window - off screen - instead of keeping it hidden, with
 * occlusion tracking off so Chromium does not throttle a window it cannot
 * see. A hidden window draws about one frame a second, which is fine for a
 * picture and useless for measuring smoothness. `--expose-gc` lets a memory
 * probe force a collection before it reads the heap.
 */
const live = process.argv.includes('--live')
if (live) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('js-flags', '--expose-gc')
}
const only = arg('only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/**
 * A throwaway profile per run. The real database and the dev database both sit
 * beside this one and are never opened, which is the whole point: a screenshot
 * run must not be able to write a row into three and a half years of history.
 */
/**
 * Refuses to shoot a bundle older than the source it came from.
 *
 * `npm run shoot` renders whatever is in `out/`. It does not rebuild it. So
 * editing a component and shooting gives a real screenshot of a real page -
 * of the previous build. On 2026-11-05 that produced a shot of the week tile
 * reading the old figure with total conviction, minutes after the change that
 * altered it; it was only caught because the expected number was known in
 * advance. An unpredicted result would have been read as the change not
 * working.
 *
 * That is the same shape as the stale installed app one level down, and the
 * same shape as a capture taken before the frame settled: the artifact is
 * real, and it is of something else. The answer in all three cases is to
 * assert the artifact is of what you think it is, rather than to remember.
 *
 * Refusing rather than warning, because a warning scrolls past and the whole
 * failure mode is a result that looks right. `--stale-ok` is there for the
 * case where shooting the previous build is deliberate.
 */
/**
 * Stops the run with a message.
 *
 * Not a `throw`: this is an Electron main process, and an exception at module
 * scope does not exit it the way it would under plain Node - the first
 * version of this guard hung for two hundred seconds instead of refusing.
 */
function refuse(lines: string[]): never {
  console.error('')
  for (const line of lines) console.error(line)
  console.error('')
  process.exit(1)
}

function assertBundleIsCurrent(): void {
  if (process.argv.includes('--stale-ok')) return

  const page = join(__dirname, '../renderer/index.html')
  if (!existsSync(page)) {
    refuse(['No renderer build at out/renderer. Run `npm run build` first.'])
  }
  const built = statSync(page).mtimeMs

  // Only the sources that end up in a window. `scripts/` is bundled per-run
  // by the shoot script itself, so it is never stale.
  const roots = ['../../src/renderer', '../../src/preload', '../../src/shared']
  let newest = 0
  let culprit = ''
  for (const root of roots) {
    const dir = resolve(__dirname, root)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = join(entry.parentPath ?? entry.path, entry.name)
      const at = statSync(file).mtimeMs
      if (at > newest) {
        newest = at
        culprit = file
      }
    }
  }

  if (newest > built) {
    const behind = Math.round((newest - built) / 1000)
    // Joined rather than escaped: a backslash-n has arrived in a file here as
    // a literal newline before, and a broken string in the guard would take
    // the harness down with it.
    refuse([
      `out/renderer is ${behind}s older than the source it was built from.`,
      `  newest source: ${culprit}`,
      '  `npm run shoot` renders out/ and does not rebuild it, so this would',
      '  have produced a real screenshot of the previous build. Run',
      '  `npm run build` first, or pass --stale-ok if shooting the old bundle',
      '  is deliberate.'
    ])
  }
}

assertBundleIsCurrent()

const profile = join(app.getPath('temp'), `dwt-shots-${process.pid}`)
app.setPath('userData', profile)

/** Clicking a selector the renderer may not have rendered yet must not hang. */
const DRIVE_HELPERS = `
  const $ = (sel) => document.querySelector(sel);
  const click = (sel) => { const el = $(sel); if (el) el.click(); return !!el };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
`

/**
 * The engine the timer handlers read from, so a shot can show a live clock.
 *
 * Reassigned per shot rather than reset: the class has no reset, and a fresh
 * instance is the only way to be sure one shot's clock cannot leak into the
 * next. The handlers read the binding at call time, so they follow it.
 */
let engine = new TimerEngine()

/**
 * The insights card, stepped through. `Math.random` is pinned and the last
 * shown id cleared so a run opens on the strongest insight every time, and
 * each shot presses Next a set number of times from there. `range` sets the
 * card's own dropdown first, the way a user would.
 */
function insightShot(width: number, steps: number, range = 'all'): Shot {
  return {
    id: `insights-${width}-${range}-${steps}`,
    width,
    height: 560,
    route: '/dashboard',
    drive: `
      Math.random = () => 0;
      try { localStorage.removeItem('dwt.lastInsight') } catch {}
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const card = document.querySelector('.an-insight');
      if (${JSON.stringify(range)} !== 'all') {
        const sel = card.querySelector('select');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(range)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(400);
      }
      for (let i = 0; i < ${steps}; i++) {
        document.querySelector('.an-insight button[aria-label="Next insight"]').click();
        await wait(120);
      }
      await wait(300);
    `,
    note: `The insights card at ${width}px, ${range}, ${steps} steps past the strongest.`
  }
}

const INSIGHT_SHOTS: Shot[] = [
  ...[0, 1, 2, 3, 4, 5, 6].map((n) => insightShot(1150, n)),
  ...[0, 3, 7, 9].map((n) => insightShot(1900, n)),
  ...[0, 1, 4].map((n) => insightShot(1150, n, '1m')),
  ...[0, 2].map((n) => insightShot(1900, n, '1w'))
]

/**
 * The Constellation panel. Its stage is a WebGL canvas, which this hidden
 * window renders (verified by `probe-cst-gl`), so these are real pictures of
 * the cloud rather than of an empty box.
 *
 * `cstDrive` opens the tab, scrolls the panel to the top of the window and
 * stops the idle turn, so a shot is of a known angle rather than of wherever
 * the rotation had reached when the capture fired. `then` drives it further.
 */
const CST_OPEN = `
  // The shape is remembered per viewer, and the profile outlives a shot.
  try { localStorage.removeItem('dwt.constellation.shape') } catch {}
  click('.tabs .tab:nth-child(3)'); await wait(2800);
  const stage = document.querySelector('.cst__stage');
  stage.closest('.an-section').scrollIntoView({ block: 'start' });
  await wait(900);
  stage.constellationStill();
`

/** Finds a star by sweeping the pointer over the canvas until the tooltip shows. */
const CST_HOVER = `
  const canvas = stage.querySelector('canvas');
  const box = canvas.getBoundingClientRect();
  const tip = stage.querySelector('.cst__tip');
  let found = false;
  const cx = box.left + box.width * 0.56, cy = box.top + box.height * 0.5;
  for (let ring = 30; ring < Math.min(box.width, box.height) * 0.45 && !found; ring += 9) {
    for (let a = 0; a < Math.PI * 2 && !found; a += 0.35) {
      const x = cx + Math.cos(a) * ring, y = cy + Math.sin(a) * ring * 0.6;
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => r()));
      await wait(16);
      if (tip.style.visibility === 'visible' && tip.textContent.length > 0) found = true;
    }
  }
  document.title = found ? 'hovered: ' + tip.textContent : 'no star found';
`

function cstShot(id: string, width: number, then = '', height = 900): Shot {
  return {
    id,
    width,
    height,
    route: '/dashboard',
    drive: CST_OPEN + then,
    note: `The Constellation panel at ${width}px${then === '' ? '' : ', driven'}.`
  }
}

const CONSTELLATION_SHOTS: Shot[] = [
  cstShot('cst-default-1150', 1150),
  cstShot('cst-default-1900', 1900, '', 1000),
  cstShot(
    'cst-isolate-1150',
    1150,
    `stage.querySelectorAll('.cst__arm')[1].click(); await wait(900);`
  ),
  cstShot(
    'cst-isolate-1900',
    1900,
    `stage.querySelectorAll('.cst__arm')[0].click(); await wait(900);`,
    1000
  ),
  cstShot('probe-cst-hover-1150', 1150, CST_HOVER),
  cstShot(
    'cst-picker-1900',
    1900,
    `
  const panel = stage.closest('.an-panel');
  panel.querySelector('.cst__pick').click(); await wait(300);
  const tick = async (name, on) => {
    const row = [...panel.querySelectorAll('.cst__choice')].find((el) => el.querySelector('.cst__arm-name').textContent === name);
    if (!row) { document.title += ' missing:' + name; return; }
    const box = row.querySelector('input');
    if (box.checked !== on) { box.click(); await wait(150); }
  };
  for (const name of ['College Apps', 'Sprocket', 'Scioly', 'JPL', 'SAT']) await tick(name, false);
  await tick('PER', true);
  await wait(400);
`,
    1000
  ),
  cstShot(
    'cst-chosen-1900',
    1900,
    `
  const panel = stage.closest('.an-panel');
  panel.querySelector('.cst__pick').click(); await wait(300);
  const tick = async (name, on) => {
    const row = [...panel.querySelectorAll('.cst__choice')].find((el) => el.querySelector('.cst__arm-name').textContent === name);
    if (!row) { document.title += ' missing:' + name; return; }
    const box = row.querySelector('input');
    if (box.checked !== on) { box.click(); await wait(150); }
  };
  for (const name of ['College Apps', 'Sprocket', 'Scioly', 'JPL', 'SAT']) await tick(name, false);
  await tick('PER', true);
  await wait(400);
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(600);`,
    1000
  ),
  cstShot(
    'cst-chosen-sphere-1900',
    1900,
    `
  const panel = stage.closest('.an-panel');
  panel.querySelector('.cst__pick').click(); await wait(300);
  const tick = async (name, on) => {
    const row = [...panel.querySelectorAll('.cst__choice')].find((el) => el.querySelector('.cst__arm-name').textContent === name);
    if (!row) { document.title += ' missing:' + name; return; }
    const box = row.querySelector('input');
    if (box.checked !== on) { box.click(); await wait(150); }
  };
  for (const name of ['College Apps', 'Sprocket', 'Scioly', 'JPL', 'SAT']) await tick(name, false);
  await tick('PER', true);
  await wait(400);
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(600); const sphere = stage.closest('.an-panel').querySelectorAll('.cst__shape button')[1]; sphere.click(); await wait(900);`,
    1000
  ),
  cstShot(
    'cst-chosen-1150',
    1150,
    `
  const panel = stage.closest('.an-panel');
  panel.querySelector('.cst__pick').click(); await wait(300);
  const tick = async (name, on) => {
    const row = [...panel.querySelectorAll('.cst__choice')].find((el) => el.querySelector('.cst__arm-name').textContent === name);
    if (!row) { document.title += ' missing:' + name; return; }
    const box = row.querySelector('input');
    if (box.checked !== on) { box.click(); await wait(150); }
  };
  for (const name of ['College Apps', 'Sprocket', 'Scioly', 'JPL', 'SAT']) await tick(name, false);
  await tick('PER', true);
  await wait(400);
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(600);`
  ),
  cstShot(
    'cst-sphere-1150',
    1150,
    `const sphere = stage.closest('.an-panel').querySelectorAll('.cst__shape button')[1]; sphere.click(); await wait(900);`
  ),
  cstShot(
    'cst-sphere-1900',
    1900,
    `const sphere = stage.closest('.an-panel').querySelectorAll('.cst__shape button')[1]; sphere.click(); await wait(900);`,
    1000
  ),
  cstShot(
    'cst-sphere-isolate-1900',
    1900,
    `const sphere = stage.closest('.an-panel').querySelectorAll('.cst__shape button')[1]; sphere.click(); await wait(900); stage.querySelectorAll('.cst__arm')[1].click(); await wait(900);`,
    1000
  ),
  cstShot('probe-cst-hover-1900', 1900, CST_HOVER, 1000),
  cstShot(
    'cst-range-1150',
    1150,
    `
    const sel = stage.closest('.an-panel').querySelector('.an-range select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '3m');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(1200);
  `
  ),
  {
    // Fullscreen is the HTML Fullscreen API on the stage, which a hidden
    // window cannot enter. The stage is given the window's size instead, with
    // the fullscreen-only overlays forced on, which is what fullscreen draws.
    id: 'cst-fullscreen-1900',
    width: 1900,
    height: 1000,
    route: '/dashboard',
    drive:
      CST_OPEN +
      `
      const s = document.createElement('style');
      s.textContent = '.cst__stage{position:fixed!important;inset:0!important;height:100vh!important;border-radius:0!important;z-index:9999}.cst__stage .cst__title{display:block!important}.cst__stage .cst__exit{display:inline-flex!important}';
      document.head.appendChild(s);
      await wait(900);
    `,
    note: 'The stage at the size fullscreen gives it, with the fullscreen overlays.'
  },
  {
    // Fullscreen is the HTML Fullscreen API on the stage, which a hidden
    // window cannot enter. The stage is given the window's size instead, with
    // the fullscreen-only overlays forced on, which is what fullscreen draws.
    id: 'cst-sphere-fullscreen-1900',
    width: 1900,
    height: 1000,
    route: '/dashboard',
    drive:
      CST_OPEN +
      `
      const s = document.createElement('style');
      s.textContent = '.cst__stage{position:fixed!important;inset:0!important;height:100vh!important;border-radius:0!important;z-index:9999}.cst__stage .cst__title{display:block!important}.cst__stage .cst__exit{display:inline-flex!important}';
      document.head.appendChild(s);
      const sphere = stage.closest('.an-panel').querySelectorAll('.cst__shape button')[1]; sphere.click(); await wait(900);
      await wait(900);
    `,
    note: 'The sphere at fullscreen size.'
  },
  {
    // WebGL, the frame clock and the per-frame cost, read off the live page.
    // `constellationBench` renders N frames back to back and waits for the GPU
    // to finish each, so the figure is the true cost of a frame rather than
    // the time to queue one.
    id: 'probe-cst-gl',
    width: 1900,
    height: 1000,
    route: '/dashboard',
    drive:
      CST_OPEN +
      `
      const gl = !!document.createElement('canvas').getContext('webgl2');
      let frames = 0; const t0 = performance.now();
      await new Promise((done) => { const f = () => { frames++; performance.now() - t0 < 2000 ? requestAnimationFrame(f) : done(); }; requestAnimationFrame(f); });
      const raf = frames / ((performance.now() - t0) / 1000);
      const bench = stage.constellationBench ? stage.constellationBench(300) : null;
      const stars = stage.dataset.stars;
      document.title = 'webgl2=' + gl + ' raf=' + raf.toFixed(1) + 'fps bench=' + JSON.stringify(bench) + ' stars=' + stars;
    `,
    note: 'Not a picture: WebGL availability and frame cost at all time.'
  },
  {
    // Range switching must not leak: ten switches, then the renderer's own
    // count of live geometries and the number of canvases on the page.
    id: 'probe-cst-leak',
    width: 1150,
    height: 900,
    route: '/dashboard',
    drive:
      CST_OPEN +
      `
      const sel = stage.closest('.an-panel').querySelector('.an-range select');
      const set = (v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true })); };
      const before = stage.constellationBench(1);
      for (const v of ['1w','3m','1y','all','1m','6m','all','2y','8w','all']) { set(v); await wait(250); }
      const after = stage.constellationBench(1);
      // Away to another tab and back, five times: the panel unmounts each time.
      for (let i = 0; i < 5; i++) { click('.tabs .tab:nth-child(2)'); await wait(400); click('.tabs .tab:nth-child(3)'); await wait(1500); }
      const canvases = document.querySelectorAll('.cst__stage canvas').length;
      const again = document.querySelector('.cst__stage').constellationBench(1);
      document.title = 'before=' + JSON.stringify(before) + ' afterRanges=' + JSON.stringify(after) + ' afterTabs=' + JSON.stringify(again) + ' canvases=' + canvases;
    `,
    note: 'Not a picture: live geometries and canvases after range and tab switches.'
  }
]

/**
 * Performance probes for the Constellation panel. Run with `--live`: the
 * hidden window these shots normally use has no frame clock (about one frame
 * a second), so it can say what a frame costs but not how smoothly frames
 * arrive. `--live` shows the window off screen with Chromium's occlusion
 * tracking turned off, so it runs at the display's real rate.
 */
const CST_STATS = `const stats = (reset) => document.querySelector('.cst__stage').constellationStats(reset);`
const CST_PERF_SHOTS: Shot[] = [
  {
    // Median and p95 of the CPU cost of a frame, and of the gap between
    // frames, over five seconds of the idle turn at all time.
    id: 'probe-cst-perf',
    width: 1900,
    height: 1000,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(2)'); await wait(1200);
      const t0 = performance.now();
      click('.tabs .tab:nth-child(3)');
      // The panel is the last on the tab and draws nothing until it is seen,
      // so this is two numbers: click to the panel existing (chunk loaded,
      // cloud built), then scrolled into view to its first frame.
      let st = null;
      while (performance.now() - t0 < 8000) {
        st = document.querySelector('.cst__stage');
        if (st && st.constellationStats) break;
        await wait(2);
      }
      const mounted = performance.now() - t0;
      const t1 = performance.now();
      st.closest('.an-section').scrollIntoView({ block: 'start' });
      while (st.constellationStats().firstFrameAt === null && performance.now() - t1 < 5000) await wait(2);
      const first = st.constellationStats().firstFrameAt - t1;
      ${CST_STATS}
      // Idle: no input since it came into view, so the turn should start at
      // IDLE_RESUME_MS and not before.
      while (!stats().turning && performance.now() - t1 < 9000) await wait(10);
      const idleToTurn = performance.now() - t1;
      // One pointer move on the panel stops it at once and restarts the clock.
      const canvas = st.querySelector('canvas');
      const box = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + 5, clientY: box.bottom - 5, bubbles: true }));
      const stoppedByInput = !stats().turning;
      const t2 = performance.now();
      while (!stats().turning && performance.now() - t2 < 9000) await wait(10);
      const inputToTurn = performance.now() - t2;
      await wait(1200); // past the ease-in
      stats(true);
      const d0 = stats().drawn;
      await wait(5000);
      const turn = stats(true);
      const turnFrames = turn.drawn - d0;
      // Off screen while turning: scrolled away, which is not an input event.
      document.querySelector('.an-section').scrollIntoView({ block: 'start' });
      await wait(800);
      const o0 = stats().drawn;
      await wait(3000);
      const offFrames = stats().drawn - o0;
      // Still: back in view with the turn stopped for good.
      st.closest('.an-section').scrollIntoView({ block: 'start' });
      st.constellationStill();
      await wait(1500);
      const s0 = stats().drawn;
      await wait(3000);
      const stillFrames = stats().drawn - s0;
      document.title = JSON.stringify({ clickToPanelMs: Math.round(mounted), inViewToFirstFrameMs: Math.round(first), inViewToTurnMs: Math.round(idleToTurn), stoppedByPointerMove: stoppedByInput, inputToTurnMs: Math.round(inputToTurn), turn5s: { frames: turnFrames, cpuMedian: turn.cpuMedian, cpuP95: turn.cpuP95, gapMedian: turn.gapMedian, gapP95: turn.gapP95, calls: turn.calls, pixelRatio: turn.pixelRatio }, stillFramesIn3s: stillFrames, offscreenFramesIn3s: offFrames });
    `,
    note: 'Not a picture: frame timing turning, still and off screen.'
  },
  {
    // Twenty trips away from the tab and back. JS heap after a forced GC, the
    // renderer's live geometry count, and how many canvases exist.
    id: 'probe-cst-memory',
    width: 1900,
    height: 1000,
    route: '/dashboard',
    drive: `
      const heap = async () => { if (window.gc) { window.gc(); await wait(200); window.gc(); } return Math.round(performance.memory.usedJSHeapSize / 1024 / 1024 * 10) / 10; };
      const show = async () => { click('.tabs .tab:nth-child(3)'); await wait(1200); document.querySelector('.cst__stage').closest('.an-section').scrollIntoView({ block: 'start' }); await wait(300); };
      await show(); await wait(1000);
      const before = await heap();
      const geo0 = document.querySelector('.cst__stage').constellationStats().geometries;
      for (let i = 0; i < 20; i++) {
        click('.tabs .tab:nth-child(2)'); await wait(300);
        await show();
      }
      await wait(1000);
      const after = await heap();
      const geo1 = document.querySelector('.cst__stage').constellationStats().geometries;
      document.title = JSON.stringify({ heapMBBefore: before, heapMBAfter20Switches: after, geometriesBefore: geo0, geometriesAfter: geo1, canvases: document.querySelectorAll('canvas').length, gc: !!window.gc });
    `,
    note: 'Not a picture: memory across twenty tab switches.'
  },
  {
    // The timer window loads the same bundle. It must never fetch the chunk.
    id: 'probe-cst-timer-scripts',
    width: 250,
    height: 150,
    route: '',
    drive: `
      await wait(1500);
    `,
    note: 'Not a picture: which scripts the timer window loaded.'
  },
  {
    // The dashboard on its other tabs: Settings, Data, Import. No chunk.
    id: 'probe-cst-settings-scripts',
    width: 1150,
    height: 900,
    route: '/dashboard',
    drive: `
      for (const n of [1, 2, 4, 1]) { click('.tabs .tab:nth-child(' + n + ')'); await wait(700); }
    `,
    note: 'Not a picture: the dashboard without the Analytics tab loads no chunk.'
  },
  {
    // The control: the dashboard does fetch it, once the tab opens.
    id: 'probe-cst-dashboard-scripts',
    width: 1150,
    height: 900,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2500);
    `,
    note: 'Not a picture: the chunk loads with the Analytics tab and not before.'
  }
]

const SHOTS: Shot[] = [
  ...INSIGHT_SHOTS,
  ...CONSTELLATION_SHOTS,
  ...CST_PERF_SHOTS,
  {
    id: 'probe-add-missing-project',
    width: 1150,
    height: 700,
    route: '/dashboard',
    // Everything but the project, then the form button: a popup naming Project, no write, form kept.
    drive: `
      click('.tabs .tab:nth-child(2)'); await wait(1500);
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add session').click();
      await wait(300);
      const fill = (label, value) => {
        const field = [...document.querySelectorAll('.editor .field')].find((f) => (f.querySelector('span')?.textContent ?? '').replace('*', '').trim() === label);
        const input = field.querySelector('input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      fill('Date', '2026-11-05'); fill('Task', 'Study for CIS 1200 Midterm');
      fill('Planned', '3h'); fill('Actual', '57 min'); fill('Quantity', '3'); fill('Unit', 'questions');
      
      await wait(200);
      const adds = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Add session');
      document.title = 'add-buttons=' + adds.length + ' in-form=' + adds.every((b) => b.closest('.editor'));
      adds[0].click();
      await wait(600);
      document.title += ' form-open-after=' + !!document.querySelector('.editor') + ' invalid=[' + [...document.querySelectorAll('.field--invalid > span:first-child')].map((e) => e.textContent.replace('*', '')).join(',') + '] error=' + JSON.stringify(document.querySelector('.editor__error')?.textContent ?? null) + ' total=' + JSON.stringify(document.querySelector('.editor__computed')?.textContent ?? null);
    `,
    note: 'Everything but the project, then the form button: a popup naming Project, no write, form kept.'
  },
  {
    id: 'probe-add-unreadable',
    width: 1150,
    height: 700,
    route: '/dashboard',
    // A planned time that cannot be read: said as unreadable, not as missing.
    drive: `
      click('.tabs .tab:nth-child(2)'); await wait(1500);
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add session').click();
      await wait(300);
      const fill = (label, value) => {
        const field = [...document.querySelectorAll('.editor .field')].find((f) => (f.querySelector('span')?.textContent ?? '').replace('*', '').trim() === label);
        const input = field.querySelector('input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      fill('Date', '2026-11-05'); fill('Task', 'Study for CIS 1200 Midterm');
      fill('Planned', 'three hours-ish'); fill('Actual', '57 min'); fill('Quantity', '3'); fill('Unit', 'questions');
      fill('Project', 'HW');
      await wait(200);
      const adds = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Add session');
      document.title = 'add-buttons=' + adds.length + ' in-form=' + adds.every((b) => b.closest('.editor'));
      adds[0].click();
      await wait(600);
      document.title += ' form-open-after=' + !!document.querySelector('.editor') + ' invalid=[' + [...document.querySelectorAll('.field--invalid > span:first-child')].map((e) => e.textContent.replace('*', '')).join(',') + '] error=' + JSON.stringify(document.querySelector('.editor__error')?.textContent ?? null) + ' total=' + JSON.stringify(document.querySelector('.editor__computed')?.textContent ?? null);
    `,
    note: 'A planned time that cannot be read: said as unreadable, not as missing.'
  },
  {
    id: 'probe-add-complete-enter',
    width: 1150,
    height: 700,
    route: '/dashboard',
    // Complete, submitted the way Enter submits: one write, form closed.
    drive: `
      click('.tabs .tab:nth-child(2)'); await wait(1500);
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add session').click();
      await wait(300);
      const fill = (label, value) => {
        const field = [...document.querySelectorAll('.editor .field')].find((f) => (f.querySelector('span')?.textContent ?? '').replace('*', '').trim() === label);
        const input = field.querySelector('input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      fill('Date', '2026-11-05'); fill('Task', 'Study for CIS 1200 Midterm');
      fill('Planned', '3h'); fill('Actual', '57 min'); fill('Quantity', '3'); fill('Unit', 'questions');
      fill('Project', 'HW');
      await wait(200);
      const adds = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Add session');
      document.title = 'add-buttons=' + adds.length + ' in-form=' + adds.every((b) => b.closest('.editor'));
      document.querySelector('form.editor').requestSubmit();
      await wait(600);
      document.title += ' form-open-after=' + !!document.querySelector('.editor') + ' invalid=[' + [...document.querySelectorAll('.field--invalid > span:first-child')].map((e) => e.textContent.replace('*', '')).join(',') + '] error=' + JSON.stringify(document.querySelector('.editor__error')?.textContent ?? null) + ' total=' + JSON.stringify(document.querySelector('.editor__computed')?.textContent ?? null);
    `,
    note: 'Complete, submitted the way Enter submits: one write, form closed.'
  },
  {
    id: 'probe-add-loop',
    width: 1150,
    height: 700,
    route: '/dashboard',
    // A loop: 45 min x 2 laps shows a 1:30:00 total and is saved with laps 2.
    drive: `
      click('.tabs .tab:nth-child(2)'); await wait(1500);
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add session').click();
      await wait(300);
      const fill = (label, value) => {
        const field = [...document.querySelectorAll('.editor .field')].find((f) => (f.querySelector('span')?.textContent ?? '').replace('*', '').trim() === label);
        const input = field.querySelector('input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      fill('Date', '2026-11-05'); fill('Task', 'Study for CIS 1200 Midterm');
      fill('Planned', '45 min'); fill('Laps', '2'); fill('Actual', '57 min'); fill('Quantity', '3'); fill('Unit', 'questions');
      fill('Project', 'HW');
      await wait(200);
      const adds = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Add session');
      document.title = 'add-buttons=' + adds.length + ' in-form=' + adds.every((b) => b.closest('.editor'));
      document.querySelector('form.editor').requestSubmit();
      await wait(600);
      document.title += ' form-open-after=' + !!document.querySelector('.editor') + ' invalid=[' + [...document.querySelectorAll('.field--invalid > span:first-child')].map((e) => e.textContent.replace('*', '')).join(',') + '] error=' + JSON.stringify(document.querySelector('.editor__error')?.textContent ?? null) + ' total=' + JSON.stringify(document.querySelector('.editor__computed')?.textContent ?? null);
    `,
    note: 'A loop: 45 min x 2 laps shows a 1:30:00 total and is saved with laps 2.'
  },
  {
    id: 'timer-bar-idle',
    width: 250,
    height: 136,
    route: '',
    note: 'Bar at its minimum size, idle. The first thing the user ever sees.'
  },
  {
    id: 'timer-bar-running',
    width: 250,
    height: 136,
    route: '',
    before: () => engine.start(25 * 60_000),
    note: 'Bar, running. Controls are hover-only, so this is the filmed state.'
  },
  {
    id: 'timer-bar-hover',
    width: 250,
    height: 136,
    route: '',
    before: () => engine.start(25 * 60_000),
    // Hover cannot be faked from the renderer, so the chrome is forced visible
    // the way :hover would — this shows what the user sees reaching for stop.
    drive: `
      const s = document.createElement('style');
      s.textContent = '.card:not(.is-ring) .tools, .card:not(.is-ring) .card__foot { opacity: 1 !important }';
      document.head.appendChild(s);
    `,
    note: 'Bar with its chrome revealed, as on hover.'
  },
  {
    id: 'timer-ring-idle',
    width: 250,
    height: 220,
    route: '',
    drive: `click('.icon');`,
    note: 'Ring at its minimum size, idle.'
  },
  {
    id: 'timer-ring-running',
    width: 250,
    height: 220,
    route: '',
    before: () => engine.start(50 * 60_000),
    drive: `click('.icon');`,
    note: 'Ring, running. The variant used for timelapse footage.'
  },
  {
    id: 'timer-ring-large',
    width: 420,
    height: 420,
    route: '',
    before: () => engine.start(50 * 60_000),
    drive: `click('.icon');`,
    note: 'Ring resized by hand. Everything scales off the viewport.'
  },
  {
    id: 'timer-pace-panel',
    width: 250,
    height: 136,
    route: '',
    drive: `click('.ghost--pace');`,
    note: 'The pace panel, opened from the button beside start.'
  },
  {
    id: 'pace-window',
    width: 132,
    height: 132,
    route: '/pace',
    before: () => {
      engine.start(50 * 60_000)
      engine.setPace({ intervalMs: 20 * 60_000, quantity: 100, unit: 'words' })
    },
    note: "The pace loop's own window, a child of the timer."
  },
  {
    id: 'dash-settings',
    width: 940,
    height: 660,
    route: '/dashboard',
    note: 'Settings: the tab the dashboard opens on.'
  },
  {
    id: 'dash-data',
    width: 940,
    height: 660,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(2)'); await wait(2500);`,
    note: 'Data, against the full 2,363-session history.'
  },
  {
    id: 'dash-add-session',
    width: 1150,
    height: 700,
    route: '/dashboard',
    // Filled the way the user filled it when the form was reported broken:
    // the long Unit value is what ran off the card.
    drive: `
      click('.tabs .tab:nth-child(2)'); await wait(1500);
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add session').click();
      await wait(300);
      const fill = (label, value) => {
        const field = [...document.querySelectorAll('.editor .field')].find((f) => (f.querySelector('span')?.textContent ?? '').replace('*', '').trim() === label);
        const input = field.querySelector('input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      fill('Task', 'Study for MATH 1410'); fill('Planned', '1:30:00'); fill('Actual', '1:20:15');
      fill('Quantity', '4'); fill('Unit', 'questions');
      const project = [...document.querySelectorAll('.editor input')].find((i) => i.getAttribute('aria-label') === 'Project');
      project.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(project, 'h'); project.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(300);
    `,
    note: 'Add session, filled as reported, with the project suggestions open.'
  },
  {
    id: 'dash-add-session-narrow',
    width: 640,
    height: 700,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(2)'); await wait(1500);
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add session').click();
      await wait(300);
    `,
    note: 'Add session in a narrow dashboard: one column.'
  },
  {
    id: 'dash-edit-session',
    width: 1150,
    height: 700,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(2)'); await wait(1500);
      document.querySelector('.row-actions button').click();
      await wait(300);
    `,
    note: 'Editing an existing row: project filled in, and the Source choice.'
  },
  {
    id: 'dash-analytics',
    width: 940,
    height: 660,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(3)'); await wait(600);`,
    note: 'Analytics. Currently a list of intentions.'
  },
  {
    id: 'dash-import',
    width: 940,
    height: 660,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(4)'); await wait(300);`,
    note: 'Import.'
  },
  {
    id: 'dash-data-tall',
    width: 1280,
    height: 900,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(2)'); await wait(2500);`,
    note: 'Data at a size the user is more likely to work at.'
  },
  {
    id: 'dash-data-unlabelled',
    width: 1280,
    height: 620,
    route: '/dashboard',
    // A session with no project must read as "Unlabeled" rather than as a
    // blank cell, and `projectId: -1` - the sentinel, since a real id cannot
    // be negative - must find it. There are exactly two such rows: the app
    // session from 2026-10-02 and the 2023-09-27 import whose Block was N/A,
    // which the importer used to discard before `deeb0a4`.
    //
    // React tracks a controlled <select>'s value on the DOM node, so assigning
    // `value` directly is reverted on the next render. Going through the
    // prototype setter is what makes React see the change.
    drive: `
      click('.tabs .tab:nth-child(2)'); await wait(2500);
      const sel = [...document.querySelectorAll('select')]
        .find((s) => [...s.options].some((o) => o.textContent.includes('Unlabeled')));
      const opt = [...sel.options].find((o) => o.textContent.includes('Unlabeled'));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(1500);
    `,
    note: 'Data filtered to Unlabeled: the two rows with no project, named rather than blank.'
  },
  /*
   * The same four tabs at two widths, which is the only way to see item 29's
   * complaint: "expanding the settings window should resize all the
   * information on all the tabs. this doesn't happen right now". 1150 is the
   * width the user works at and 1900 is a full screen - at 1900 the old
   * `.panel` cap left a quarter of the window empty on every tab, and no
   * single-width shot shows that, because each one looks fine on its own.
   */
  {
    id: 'wide-settings-1150',
    width: 1150,
    height: 1000,
    route: '/dashboard',
    note: 'Settings at the width the user works at: two columns.'
  },
  {
    id: 'wide-settings-1900',
    width: 1900,
    height: 1000,
    route: '/dashboard',
    note: 'Settings at full screen. The groups take the width instead of a 900px strip.'
  },
  {
    id: 'wide-data-1900',
    width: 1900,
    height: 900,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(2)'); await wait(2500);`,
    note: 'Data at full screen: the table spans the window rather than stopping at 1500px.'
  },
  {
    id: 'wide-import-1900',
    width: 1900,
    height: 900,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(4)'); await wait(600);`,
    note: 'Import at full screen, with the prose still at a reading measure.'
  },
  {
    id: 'wide-analytics-1150',
    width: 1150,
    height: 3000,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(3)'); await wait(2800);`,
    note: 'The whole Analytics tab at 1150: four section headings, a range on every panel.'
  },
  {
    id: 'wide-analytics-1900',
    width: 1900,
    height: 2600,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(3)'); await wait(2800);`,
    note: 'Analytics at full screen: three columns of half-width panels.'
  },
  {
    id: 'wide-analytics-head-1900',
    width: 1900,
    height: 620,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(3)'); await wait(2800);`,
    note: 'The header and the figure row: Modify panels at the right edge, a range on two tiles.'
  },
  {
    id: 'rate-math1410-1150',
    width: 1150,
    height: 900,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('per minute') || el.textContent.includes('Work rate'));
      const setSel = (sel, value) => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const pick = (label) => [...panel.querySelectorAll('select')]
        .find((s) => (s.getAttribute('aria-label') || '').includes(label));
      setSel(pick('Unit'), 'question'); await wait(500);
      setSel(pick('Course'), 'MATH 1410'); await wait(900);
      for (const p of document.querySelectorAll('.an-slot')) {
        if (!p.contains(panel)) p.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(600);
    `,
    note: 'The rate panel for MATH 1410 questions: one bar a month, each labelled.'
  },
  {
    id: 'rate-writ0580-1900',
    width: 1900,
    height: 900,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('per minute') || el.textContent.includes('Work rate'));
      const setSel = (sel, value) => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const pick = (label) => [...panel.querySelectorAll('select')]
        .find((s) => (s.getAttribute('aria-label') || '').includes(label));
      setSel(pick('Unit'), 'word'); await wait(500);
      setSel(pick('Course'), 'WRIT 0580'); await wait(900);
      for (const p of document.querySelectorAll('.an-slot')) {
        if (!p.contains(panel)) p.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(600);
    `,
    note: 'A second course and unit: WRIT 0580 words per minute, at full width.'
  },
  {
    id: 'heatmap-week-1150',
    width: 1150,
    height: 760,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('Every day'));
      const sel = panel.querySelector('.an-range select');
      const want = ${JSON.stringify('1w')};
      if ([...sel.options].some((o) => o.value === want)) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, want);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
      }
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(panel)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'The calendar at week, 1150px wide. A day square is the same size at every range.'
  },
  {
    id: 'heatmap-30days-1150',
    width: 1150,
    height: 760,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('Every day'));
      const sel = panel.querySelector('.an-range select');
      const want = ${JSON.stringify('1m')};
      if ([...sel.options].some((o) => o.value === want)) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, want);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
      }
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(panel)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'The calendar at 30days, 1150px wide. A day square is the same size at every range.'
  },
  {
    id: 'heatmap-12months-1150',
    width: 1150,
    height: 760,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('Every day'));
      const sel = panel.querySelector('.an-range select');
      const want = ${JSON.stringify('1y')};
      if ([...sel.options].some((o) => o.value === want)) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, want);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
      }
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(panel)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'The calendar at 12months, 1150px wide. A day square is the same size at every range.'
  },
  {
    id: 'heatmap-alltime-1150',
    width: 1150,
    height: 760,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('Every day'));
      const sel = panel.querySelector('.an-range select');
      const want = ${JSON.stringify('all')};
      if ([...sel.options].some((o) => o.value === want)) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, want);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
      }
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(panel)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'The calendar at alltime, 1150px wide. A day square is the same size at every range.'
  },
  {
    id: 'heatmap-week-1900',
    width: 1900,
    height: 760,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('Every day'));
      const sel = panel.querySelector('.an-range select');
      const want = ${JSON.stringify('1w')};
      if ([...sel.options].some((o) => o.value === want)) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, want);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
      }
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(panel)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'The calendar at week, 1900px wide. A day square is the same size at every range.'
  },
  {
    id: 'heatmap-30days-1900',
    width: 1900,
    height: 760,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('Every day'));
      const sel = panel.querySelector('.an-range select');
      const want = ${JSON.stringify('1m')};
      if ([...sel.options].some((o) => o.value === want)) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, want);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
      }
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(panel)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'The calendar at 30days, 1900px wide. A day square is the same size at every range.'
  },
  {
    id: 'heatmap-12months-1900',
    width: 1900,
    height: 760,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('Every day'));
      const sel = panel.querySelector('.an-range select');
      const want = ${JSON.stringify('1y')};
      if ([...sel.options].some((o) => o.value === want)) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, want);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
      }
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(panel)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'The calendar at 12months, 1900px wide. A day square is the same size at every range.'
  },
  {
    id: 'heatmap-alltime-1900',
    width: 1900,
    height: 760,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const panel = [...document.querySelectorAll('.an-panel')]
        .find((el) => el.textContent.includes('Every day'));
      const sel = panel.querySelector('.an-range select');
      const want = ${JSON.stringify('all')};
      if ([...sel.options].some((o) => o.value === want)) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, want);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
      }
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(panel)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'The calendar at alltime, 1900px wide. A day square is the same size at every range.'
  },
  {
    id: 'custom-range-1150',
    width: 1150,
    height: 1100,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const setSel = (sel, v) => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setText = (input, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const panel = (title) => [...document.querySelectorAll('.an-panel')]
        .find((el) => el.querySelector('.an-panel__title') &&
          el.querySelector('.an-panel__title').childNodes[0].textContent.trim().startsWith(title));

      // Hours per X on a typed span, and the project chart on another, so
      // two panels show the field at once and neither affects the other.
      const hours = panel('Hours per');
      setSel(hours.querySelector('.an-range select'), 'custom');
      await wait(400);
      setText(hours.querySelector('.an-range input'), '45 days');
      await wait(900);
      const projects = panel('Hours by project');
      setSel(projects.querySelector('.an-range select'), 'custom');
      await wait(400);
      setText(projects.querySelector('.an-range input'), '3 weeks');
      await wait(900);
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      await wait(400);
    `,
    note: 'Two panels on typed spans at once: 45 days and 3 weeks.'
  },
  {
    id: 'custom-bad-1150',
    width: 1150,
    height: 700,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const setSel = (sel, v) => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setText = (input, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const panel = (title) => [...document.querySelectorAll('.an-panel')]
        .find((el) => el.querySelector('.an-panel__title') &&
          el.querySelector('.an-panel__title').childNodes[0].textContent.trim().startsWith(title));

      const hours = panel('Hours per');
      setSel(hours.querySelector('.an-range select'), 'custom');
      await wait(400);
      setText(hours.querySelector('.an-range input'), 'about three weeks');
      await wait(700);
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(hours)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'An unreadable span says so in the panel, in red. No dialog.'
  },
  {
    id: 'custom-range-1900',
    width: 1900,
    height: 1100,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const setSel = (sel, v) => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setText = (input, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const panel = (title) => [...document.querySelectorAll('.an-panel')]
        .find((el) => el.querySelector('.an-panel__title') &&
          el.querySelector('.an-panel__title').childNodes[0].textContent.trim().startsWith(title));

      // Hours per X on a typed span, and the project chart on another, so
      // two panels show the field at once and neither affects the other.
      const hours = panel('Hours per');
      setSel(hours.querySelector('.an-range select'), 'custom');
      await wait(400);
      setText(hours.querySelector('.an-range input'), '45 days');
      await wait(900);
      const projects = panel('Hours by project');
      setSel(projects.querySelector('.an-range select'), 'custom');
      await wait(400);
      setText(projects.querySelector('.an-range input'), '3 weeks');
      await wait(900);
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      await wait(400);
    `,
    note: 'Two panels on typed spans at once: 45 days and 3 weeks.'
  },
  {
    id: 'custom-bad-1900',
    width: 1900,
    height: 700,
    route: '/dashboard',
    drive: `
      click('.tabs .tab:nth-child(3)'); await wait(2800);
      const setSel = (sel, v) => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setText = (input, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const panel = (title) => [...document.querySelectorAll('.an-panel')]
        .find((el) => el.querySelector('.an-panel__title') &&
          el.querySelector('.an-panel__title').childNodes[0].textContent.trim().startsWith(title));

      const hours = panel('Hours per');
      setSel(hours.querySelector('.an-range select'), 'custom');
      await wait(400);
      setText(hours.querySelector('.an-range input'), 'about three weeks');
      await wait(700);
      for (const slot of document.querySelectorAll('.an-slot')) {
        if (!slot.contains(hours)) slot.style.display = 'none';
      }
      for (const h of document.querySelectorAll('.an-section__title')) h.style.display = 'none';
      document.querySelector('.an-stats').style.display = 'none';
      await wait(500);
    `,
    note: 'An unreadable span says so in the panel, in red. No dialog.'
  },
  {
    id: 'dash-analytics-tall',
    width: 1280,
    // Tall enough that the whole tab fits with nothing scrolled away. The
    // scroller is `.dashboard__body`, not the window, and a shot that scrolls
    // it is a shot that can lie: an earlier attempt called `window.scrollTo`,
    // which succeeded, moved nothing, and produced a picture of the top of the
    // tab filed as the bottom of it. A window taller than the content cannot
    // fail that way, and the window is never shown, so the size costs nothing.
    height: 2400,
    route: '/dashboard',
    drive: `click('.tabs .tab:nth-child(3)'); await wait(2500);`,
    note: 'The whole Analytics tab in one frame. It is six visualisations tall, so the 660px shot shows the first two and every fault that matters - an empty series, a wrapped label, a thinned axis, the time-of-day caveat - is below that fold.'
  }
]

/**
 * The reads every window performs on first paint, plus stubs for the writes.
 *
 * Only reads are real. A screenshot run that could record a session, take a
 * backup or delete a row would be a worse tool than no tool.
 */
function registerHandlers(): void {
  const snapshot = (): unknown => engine.snapshot()

  const reads: Record<string, (...args: unknown[]) => unknown> = {
    'timer:get': snapshot,
    'timer:getLoop': () => true,
    'timer:getAutoEnd': () => 180,
    'timer:getPace': () => engine.paceConfig(),
    'pace:state': () => ({ snapshot: engine.snapshot(), config: engine.paceConfig() }),
    'sessions:lastProject': () => lastProjectName(),
    'sessions:projectNames': () => allProjectNames(),
    'sessions:projects': () => listProjects(),
    'sessions:query': (query) => querySessions((query ?? {}) as never),
    'sessions:lastUnit': (task) => lastUnitFor((task ?? null) as string | null),
    'history:state': () => historyState(),
    // `--fail-analytics` makes the read return null, which is how the main
    // process reports that the query failed. It is worth being able to shoot,
    // because the tab must say so rather than render zeroes: a zeroed payload
    // reads as "you have never worked", which is both false and alarming, and
    // it is the one state that cannot be reached by pointing the harness at a
    // database.
    'analytics:get': () => (failAnalytics ? null : analytics()),
    'backup:status': () => backupStatus(),
    // `layout:get` was missing and rejected on every dashboard shot. Harmless -
    // it is caught in the renderer by design - but a harness that prints a
    // stack trace per run teaches you to ignore its output, which is the one
    // thing a screenshot harness must not do. Null means nothing is stored,
    // so the shots show the default arrangement.
    //
    // `app:preview` was added here twice, once on each side of a merge, and
    // the later key silently won. The preview-aware one below is the one to
    // keep; this note is here because a duplicate key in an object literal is
    // not an error and the only thing that caught it was an esbuild warning.
    'layout:get': () => null,
    'import:existingCount': () => 2363,
    'shortcuts:get': () => ({
      pause: 'CommandOrControl+Shift+Space',
      stop: 'CommandOrControl+Shift+X',
      newTimer: 'CommandOrControl+Shift+N'
    }),
    'window:isFullScreen': () => false,
    'app:preview': () =>
      asPreview
        ? {
            takenAt: '2026-11-06T06:00:00.000Z',
            sessions: 2478,
            lastSync: {
              at: '2026-11-06T05:40:00.000Z',
              added: 3,
              edited: 1,
              deleted: 0,
              conflicts: 1,
              // Joined on char 92 rather than written with backslashes, which
              // have collapsed in transit to this file before.
              recoveryDir: [
                'C:',
                'Users',
                'jamwa',
                'Documents',
                'Deep Work Tracker',
                'Recovery',
                'preview-2026-11-06-0040'
              ].join(String.fromCharCode(92))
            }
          }
        : null
  }

  for (const [channel, read] of Object.entries(reads)) {
    ipcMain.handle(channel, (_event, ...args) => read(...args))
  }

  // Everything that writes, opens a dialog, or moves a window. Answered so the
  // renderer never sees a rejected invoke, and does nothing.
  const inert = [
    'timer:start',
    'timer:pause',
    'timer:resume',
    'timer:stop',
    'timer:undoStop',
    'timer:setTask',
    'timer:setProject',
    'timer:setLoop',
    'timer:setAutoEnd',
    'timer:setPace',
    'pace:close',
    'sessions:setStopReason',
    'sessions:setQuantity',
    'sessions:update',
    'sessions:remove',
    'history:undo',
    'history:redo',
    'shortcuts:set',
    'backup:now',
    'backup:reveal',
    'backup:pickRestore',
    'backup:previewRestore',
    'backup:restore',
    'import:pickFile',
    'import:preview',
    'import:commit',
    'ui:confirm',
    'window:newTimer',
    'window:openDashboard',
    'window:setFullScreen',
    'window:setVariant',
    'window:minimize',
    'window:close'
  ]
  for (const channel of inert) {
    ipcMain.handle(channel, () => null)
  }

  // Logged rather than inert, so the add-session probes can show what the
  // form actually asked for: whether a write was attempted at all, and what
  // the popup said instead. Nothing is written - this is not the app.
  ipcMain.handle('sessions:create', (_event, patch) => {
    console.log('    create:', JSON.stringify(patch))
    return null
  })

  // Echoed rather than inert. `useLayout` adopts whatever the write returns, so
  // answering null would snap the tab back to the default layout the moment a
  // drive script changed a range or dragged a panel - a shot of the thing not
  // working, taken deliberately.
  ipcMain.handle('layout:set', (_event, layout) => layout)
}

/**
 * One window, resized and reloaded per shot.
 *
 * Creating and destroying a window per shot killed the renderer process after
 * the first capture — the next `loadFile` came back ERR_FAILED and the run
 * died with crashpad unable to connect. Reusing one window is both more
 * reliable and closer to what the app does when the user resizes.
 */
let canvas: BrowserWindow | null = null

function surface(): BrowserWindow {
  if (canvas && !canvas.isDestroyed()) return canvas
  canvas = new BrowserWindow({
    show: live,
    ...(live ? { x: -6000, y: -3000, skipTaskbar: true, focusable: false } : {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: !live
    }
  })
  return canvas
}

async function shoot(shot: Shot): Promise<string> {
  shot.before?.()

  const window = surface()
  window.setContentSize(shot.width, shot.height)

  const html = join(__dirname, '../renderer/index.html')

  // A blank page between shots. `main.tsx` picks its root from the hash at
  // module load, and navigating from `#/pace` to `#/dashboard` on the same
  // document is a same-document navigation - the hash changes, the module is
  // never re-run, and the window keeps rendering the previous route. That is
  // how the pace shot came back showing the timer.
  /*
   * A `-scripts` shot lists every script the page requested, read from the
   * DevTools protocol. Resource Timing records nothing for file:// pages, so
   * asking the page itself would report an empty list whatever was loaded.
   */
  const requested: string[] = []
  const logRequests = shot.id.endsWith('-scripts')
  const onMessage = (
    _event: unknown,
    method: string,
    params: { request?: { url?: string } }
  ): void => {
    const url = params.request?.url ?? ''
    if (method === 'Network.requestWillBeSent' && url.endsWith('.js')) {
      requested.push(url.split('/').pop() ?? url)
    }
  }
  if (logRequests) {
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Network.enable')
    window.webContents.debugger.on('message', onMessage)
  }
  await window.loadURL('about:blank')
  await (shot.route === '' ? window.loadFile(html) : window.loadFile(html, { hash: shot.route }))

  // The renderer paints from a promise chain of invokes, and Recharts measures
  // its container on a resize observer, so a frame alone is not enough.
  await new Promise((done) => setTimeout(done, 500))

  if (shot.drive) {
    await window.webContents.executeJavaScript(
      `(async () => { ${DRIVE_HELPERS} ${shot.drive} })()`,
      true
    )
    await new Promise((done) => setTimeout(done, 500))
  }

  // A shot whose id starts with `probe-` reports back: set `document.title`
  // in its drive script and it is printed. Measuring the live page is how the
  // ring-mode chrome bug was found - the CSS said opacity 0 and the pixels
  // disagreed.
  if (logRequests) {
    console.log('    scripts requested, in order:', JSON.stringify(requested))
    window.webContents.debugger.removeListener('message', onMessage)
    window.webContents.debugger.detach()
  }
  if (shot.id.startsWith('probe-')) {
    console.log('    probe:', await window.webContents.executeJavaScript('document.title', true))
  }

  /*
   * Throw away three frames before keeping one.
   *
   * A window that is never shown gets no steady compositor heartbeat, and
   * Chromium advances CSS transitions off the frame clock rather than off
   * wall-clock time. `capturePage()` is one of the things that asks for a
   * frame. So a 160ms opacity transition can still be sitting on its first
   * frame when the capture happens no matter how long the drive script
   * waited, because nothing during that wait drew anything.
   *
   * What is actually verified here, rather than reasoned:
   *
   * - Ring mode at rest, DOM reporting `.tools` at `opacity: 0` and the PNG
   *   showing the icons anyway. One discarded capture plus 400ms did NOT fix
   *   it - the icons were still there. Three captures 500ms apart did, and
   *   the header came back correctly empty. So the effect is real and it
   *   needs more than one frame to clear; a single discard is not enough,
   *   which is worth stating because it looks like it ought to be.
   * - The dashboard shots are byte-identical with zero, one and three
   *   discarded frames - same md5 across all three. Nothing on those tabs
   *   depends on a transition, so there is no stale frame to clear.
   *
   * That second point is why this is cheap insurance rather than a fix for
   * the charts: a settled page captures the same either way, and only the
   * pages with a transition in them change. JavaScript timers run normally
   * in a hidden window, so React state, data loads and layout are already
   * settled by the drive script's own wait - this is only about CSS
   * transitions. Recharts' mount animation is the other case of the same
   * problem and is turned off at the series instead, with
   * `isAnimationActive={false}`, because a chart that paints its final
   * values immediately needs no clock at all.
   */
  for (let i = 0; i < 3; i++) {
    await window.webContents.capturePage()
    await new Promise((done) => setTimeout(done, 500))
  }

  const image = await window.webContents.capturePage()
  const file = join(outDir, `${shot.id}.png`)
  writeFileSync(file, image.toPNG())

  // A fresh clock for the next shot. The handlers read the binding at call
  // time, so reassigning is enough.
  engine = new TimerEngine()
  return file
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  mkdirSync(outDir, { recursive: true })

  // `--db` seeds the throwaway profile from a copy of a real database;
  // `--csv` rebuilds one from a backup. Prefer `--db` for anything being
  // judged against what the user will see, for two reasons. A backup CSV is
  // only as new as the last backup - the newest real one is 2026-09-23 and
  // holds 2,363 rows against the live 2,476. And `restoreFromCsv` writes the
  // project column verbatim without `PROJECT_ALIASES`, so restoring a backup
  // taken before the 2026-09-23 consolidation resurrects 66 projects where
  // the import yields 36: the By project chart would then be shot against a
  // category list the app does not produce.
  //
  // Copying the file is also what keeps this read-only in the sense that
  // matters. The copy is what gets migrated and queried; the original is
  // opened by nothing, so a screenshot run cannot write into real history
  // even by accident.
  if (dbPath) {
    const source = resolve(dbPath)
    if (!existsSync(source)) throw new Error(`--db ${source} does not exist`)
    mkdirSync(profile, { recursive: true })
    copyFileSync(source, join(profile, 'deepwork.db'))
    // A `-wal` beside it holds rows that have not been checkpointed into the
    // `.db` yet. Copying the `.db` alone can report an empty schema while the
    // app shows thousands of rows, which is exactly the asymmetry that made
    // the September loss look like corruption.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(source + suffix))
        copyFileSync(source + suffix, join(profile, `deepwork.db${suffix}`))
    }
    console.log(`copied ${source} into ${profile}`)
  } else if (csvPath) {
    const result = restoreFromCsv(readFileSync(resolve(csvPath), 'utf8'))
    console.log(
      `loaded ${result.sessions.toLocaleString()} sessions, ${result.projects} projects into ${profile}`
    )
  } else {
    console.log(`no --db or --csv given; shooting against an empty database at ${profile}`)
  }

  registerHandlers()

  const wanted = only ? SHOTS.filter((s) => only.includes(s.id)) : SHOTS
  for (const shot of wanted) {
    try {
      const file = await shoot(shot)
      console.log(`  ${shot.id.padEnd(20)} ${shot.width}x${shot.height}  ${file}`)
    } catch (error) {
      console.log(`  ${shot.id.padEnd(20)} FAILED  ${String(error)}`)
    }
  }

  console.log(`\n${wanted.length} shots in ${outDir}`)
  app.exit(0)
})
