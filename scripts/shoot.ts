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
 *   npx electron out/shoot/index.js --csv <backup.csv> --out <dir> [--only <id,id>]
 *
 * Bundled by `npm run shoot`. Each shot is one entry in SHOTS below: a window
 * size, a route, and an optional script that drives the renderer into the
 * state worth seeing (open a tab, switch to the ring, start the clock).
 */
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const outDir = resolve(arg('out') ?? join(process.cwd(), 'shots'))
const only = arg('only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/**
 * A throwaway profile per run. The real database and the dev database both sit
 * beside this one and are never opened, which is the whole point: a screenshot
 * run must not be able to write a row into three and a half years of history.
 */
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

const SHOTS: Shot[] = [
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
    drive: `click('.tabs .tab:nth-child(2)'); await wait(400);`,
    note: 'Data, against the full 2,363-session history.'
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
    drive: `click('.tabs .tab:nth-child(2)'); await wait(400);`,
    note: 'Data at a size the user is more likely to work at.'
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
    'analytics:get': () => analytics(),
    'backup:status': () => backupStatus(),
    'import:existingCount': () => 2363,
    'shortcuts:get': () => ({
      pause: 'CommandOrControl+Shift+Space',
      stop: 'CommandOrControl+Shift+X',
      newTimer: 'CommandOrControl+Shift+N'
    }),
    'window:isFullScreen': () => false
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
    'sessions:create',
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
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
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
  if (shot.id.startsWith('probe-')) {
    console.log('    probe:', await window.webContents.executeJavaScript('document.title', true))
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

  if (csvPath) {
    const result = restoreFromCsv(readFileSync(resolve(csvPath), 'utf8'))
    console.log(
      `loaded ${result.sessions.toLocaleString()} sessions, ${result.projects} projects into ${profile}`
    )
  } else {
    console.log(`no --csv given; shooting against an empty database at ${profile}`)
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
