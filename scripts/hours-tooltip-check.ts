/**
 * Checks that the hours chart's tooltip reports the bucket under the pointer.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/hours-tooltip-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/hours/index.js
 *   npx electron out/hours/index.js --db "%APPDATA%\deep-work-tracker\deepwork.db"
 *
 * `--db` is copied into a throwaway profile, never opened in place, so this
 * can be pointed at the real history without writing to it. Without it the
 * profile is empty and the check skips: the fault needs more distinct buckets
 * than a test database has. `--samples N` sets how many pointer positions are
 * tried per span, default 24; each one costs about two seconds.
 *
 * ## What it is testing
 *
 * `<XAxis dataKey="tick">` was the bug. `Point.tick` is axis *text*, blank on
 * every bucket that does not carry a label, and a category axis deduplicates
 * its domain - so 56 days collapsed into the three or four bands that had
 * text, and the tooltip resolved almost any pointer position to the first
 * blank day. Measured: 24 of 24 hovers answered, 4 of them correctly.
 *
 * It was invisible because **a band scale draws by index and resolves
 * tooltips by value**. The area, the value labels and the axis text are all
 * placed by index, so the chart was correct in every screenshot; only
 * hovering it went through the scale by value.
 *
 * ## Both bucketings are swept, because they are different code
 *
 * Under eight weeks the chart buckets by day and past that by week
 * (`DAILY_LIMIT_DAYS`), which is a different branch of `seriesFor`, a
 * different label set and a different `labelFormatter`. The first version of
 * this check only ever exercised the default daily span, which is half the
 * feature. The weekly span is reached by driving the chart's own span control.
 *
 * ## Why it drives the window rather than dispatching events
 *
 * A synthetic `dispatchEvent` does not drive hit-testing, so it cannot tell a
 * working tooltip from a broken one. Real input has to come from the
 * browser's own input pipeline - here `Input.dispatchMouseEvent` over the
 * debugger attached to this window, which needs no remote port and no second
 * process.
 *
 * ## The three switches at the top are load-bearing
 *
 * Chromium marks a covered window occluded and treats it as hidden, and a
 * hidden page does not run the hover state this reads. Without them an
 * identical sweep gave 29/60 responses in one run and 0/48 in the next
 * against the same build - an instrument that cannot be trusted in either
 * direction. With them, two runs per build agreed exactly.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-hours-${process.pid}`)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

function argument(name: string): string | null {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}

const source = argument('--db')
if (source) {
  // The -wal matters: rows committed since the last checkpoint live only
  // there, so copying the .db alone can yield a database missing recent days.
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(source + suffix)) {
      copyFileSync(source + suffix, join(profile, `deepwork.db${suffix}`))
    }
  }
}

const SAMPLES = Math.max(4, Number(argument('--samples') ?? 24) || 24)

import { analytics } from '../src/main/db/analytics'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) console.log(`       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

const watchdog = setTimeout(
  () => {
    console.log('')
    console.log('TIMED OUT - the run never reached its own exit')
    app.exit(1)
  },
  120_000 + SAMPLES * 2 * 4_000
)
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
    'layout:get': () => null
  }
  for (const [channel, read] of Object.entries(reads)) {
    ipcMain.handle(channel, () => read())
  }
  ipcMain.handle('layout:set', (_event, layout) => layout)

  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 950,
    useContentSize: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
  await new Promise((done) => setTimeout(done, 1200))

  const ask = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression, true)

  window.webContents.debugger.attach('1.3')
  const move = async (x: number, y: number): Promise<void> => {
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      buttons: 0
    })
    await new Promise((done) => setTimeout(done, 70))
  }

  await ask(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Analytics'); if (b) b.click(); return 1 })()`
  )
  await new Promise((done) => setTimeout(done, 2200))

  /**
   * Finds the hours chart by its own heading, never by position.
   *
   * The panels are rearrangeable, so `.recharts-wrapper[0]` is not the hours
   * chart for long, and an index that quietly lands on a neighbour would make
   * this check report on that instead. The heading has to come from the
   * chart's *own* container: searching upwards for any ancestor with a
   * heading finds the whole Analytics panel, which is titled "Analytics", and
   * every chart then looks identically named.
   */
  const locate = (): Promise<{
    charts: number
    titles: (string | null)[]
    at: number
    title: string | null
  }> =>
    ask(`(() => {
    const titleOf = (wrap) => {
      let node = wrap.parentElement, own = null;
      for (let i = 0; i < 6 && node; i++) {
        if (node.querySelectorAll('.recharts-wrapper').length === 1) own = node;
        else break;
        node = node.parentElement
      }
      return [...(own ? own.querySelectorAll('h2,h3,h4') : [])].map((t) => t.textContent.trim())[0] ?? null
    };
    const all = [...document.querySelectorAll('.recharts-wrapper')];
    const titles = all.map(titleOf);
    const at = titles.findIndex((t) => t !== null && /Hours per/.test(t));
    return { charts: all.length, titles, at, title: at === -1 ? null : titles[at] }
  })()`) as Promise<{ charts: number; titles: (string | null)[]; at: number; title: string | null }>

  console.log('')
  console.log('1. the chart under test is the one we think it is')
  const found = await locate()
  if (found.charts === 0) {
    // No charts at all means no history to chart. That is the one case worth
    // skipping, and it is kept distinct from "the chart moved" below: a skip
    // that exits 0 on a missing chart would be a silent pass.
    console.log('  SKIP - the Analytics tab drew no charts, so there is no history.')
    console.log('  Pass --db pointing at a database with sessions in it.')
    clearTimeout(watchdog)
    app.exit(0)
    return
  }
  check('an hours chart is on the tab', found.at !== -1, true)
  if (found.at === -1) {
    console.log(`       ${found.charts} charts, titled ${JSON.stringify(found.titles)}`)
    console.log('       None is the hours chart. Renamed, or removed from the tab?')
    console.log('')
    console.log(`${pass} passed, ${fail} failed`)
    clearTimeout(watchdog)
    app.exit(1)
    return
  }
  console.log(`       "${found.title}", chart ${found.at + 1} of ${found.charts}`)

  /** Sweeps the pointer across the chart and reports what the tooltip said. */
  async function sweep(at: number): Promise<{
    answered: number
    accurate: number
    distinct: number
    shape: string
    width: number
  }> {
    const WRAP = `document.querySelectorAll('.recharts-wrapper')[${at}]`
    const box = (await ask(`(() => {
      const r = ${WRAP}.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    })()`)) as [number, number, number, number]
    const [left, top, width, height] = box
    check(
      'the chart is inside the viewport',
      await ask(`${top} >= 0 && ${top + height} <= innerHeight`),
      true
    )

    const read = `(() => {
      const wrap = ${WRAP};
      const tip = wrap.querySelector('.recharts-tooltip-wrapper');
      const vis = tip ? (tip.textContent || '').trim().length > 0 && getComputedStyle(tip).visibility !== 'hidden' : false;
      const dot = wrap.querySelector('.recharts-active-dot');
      let dotX = null;
      if (dot) { const r = dot.getBoundingClientRect(); dotX = Math.round(r.x + r.width / 2) }
      return { vis, dotX, text: vis ? (tip.textContent || '').trim().replace(/[ ]+/g, ' ').slice(0, 30) : null }
    })()`

    // Entering from outside the plot, so the first sample is a move onto the
    // chart rather than a move within it.
    await move(left + Math.round(width / 2), top - 30)
    let answered = 0
    let accurate = 0
    const seenText = new Set<string>()
    let shape = ''
    for (let i = 0; i < SAMPLES; i++) {
      const x = Math.round(left + 36 + ((width - 50) * i) / (SAMPLES - 1))
      await move(x, Math.round(top + height * 0.55))
      const seen = (await ask(read)) as { vis: boolean; dotX: number | null; text: string | null }
      if (!seen.vis) {
        shape += '.'
        continue
      }
      answered++
      if (seen.text !== null) seenText.add(seen.text)
      // 35px rather than exact: the dot sits at the centre of its band, and a
      // band is about 21px wide at 56 buckets over this width.
      const near = seen.dotX !== null && Math.abs(seen.dotX - x) <= 35
      if (near) accurate++
      shape += near ? '#' : 'x'
    }
    return { answered, accurate, distinct: seenText.size, shape, width }
  }

  console.log('')
  console.log('2. the axis still reads the way it did')
  const WRAP0 = `document.querySelectorAll('.recharts-wrapper')[${found.at}]`
  const ticks = (await ask(`(() => [...${WRAP0}.querySelectorAll('text')]
    .filter((t) => ((t.parentElement && t.parentElement.className && t.parentElement.className.baseVal) || '').includes('tick-label'))
    .map((t) => t.textContent).filter(Boolean).slice(0, 3))()`)) as string[]
  check('dates are still printed along the axis', ticks.length > 0, true)
  console.log(`       axis reads ${JSON.stringify(ticks)}`)
  // Month first, like every other date the app prints. This used to read
  // `11 Sep`, which is the one order the user asked never to see. Asserted
  // rather than just printed, because an axis label is read at a glance and a
  // silently reordered date is the kind of wrong that looks right - and the
  // daily span is the only one with a day in it to misorder, which is why
  // this is checked here and not after the switch to weeks.
  check(
    'and they read month-first, MM/DD',
    ticks.every((text) => /^\d{2}\/\d{2}$/.test(text)),
    true
  )

  console.log('')
  console.log(`3. by day: every hover names the bucket under the pointer (${SAMPLES} positions)`)
  const daily = await sweep(found.at)
  console.log(`       ${daily.shape}`)
  console.log(`       (# accurate, x wrong bucket, . no tooltip)`)
  check('every sample answered', daily.answered, SAMPLES)
  // The assertion that fails on the old axis: it answered every sample too,
  // and only three or four named the day being pointed at.
  check('every answer was the bucket under the pointer', daily.accurate, SAMPLES)
  // Not `=== SAMPLES`: more samples than buckets means two pointer positions
  // legitimately land in one band. Four distinct readings was the symptom, so
  // the floor is what discriminates, not an exact count.
  check(
    `more than ${Math.floor(SAMPLES / 2)} distinct buckets, not 4 bands`,
    daily.distinct > Math.floor(SAMPLES / 2),
    true
  )
  console.log(`       ${daily.distinct} distinct buckets over ${SAMPLES} positions`)

  console.log('')
  console.log(`4. by week: the same, on the other bucketing (${SAMPLES} positions)`)
  // Driven through the chart's own span control, scoped to its panel - there
  // are unit selects on other charts, and a global `select` would hit one.
  const switched = await ask(`(() => {
    const wrap = ${WRAP0};
    const panel = wrap.closest('.ac');
    const select = panel ? panel.querySelector('select') : null;
    if (!select) return 'no span control';
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, '1y');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value
  })()`)
  check('the span control accepted a year', switched, '1y')
  await new Promise((done) => setTimeout(done, 1800))
  const weekly = await locate()
  check('the chart is now bucketed by week', /Hours per week/.test(weekly.title ?? ''), true)
  if (weekly.at !== -1 && /Hours per week/.test(weekly.title ?? '')) {
    console.log(`       "${weekly.title}"`)
    const byWeek = await sweep(weekly.at)
    console.log(`       ${byWeek.shape}`)
    check('every sample answered', byWeek.answered, SAMPLES)
    check('every answer was the bucket under the pointer', byWeek.accurate, SAMPLES)
    check(
      `more than ${Math.floor(SAMPLES / 2)} distinct buckets, not 4 bands`,
      byWeek.distinct > Math.floor(SAMPLES / 2),
      true
    )
    console.log(`       ${byWeek.distinct} distinct buckets over ${SAMPLES} positions`)
  }

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  clearTimeout(watchdog)
  app.exit(fail === 0 ? 0 : 1)
})

process.on('unhandledRejection', (reason) => {
  console.log('')
  console.log('UNHANDLED REJECTION:', String(reason))
  app.exit(1)
})
