/**
 * Drags a real panel with a real pointer and reads back every frame of it.
 *
 * *"whenever I try dragging panels around there's no live preview and the
 * entire GUI basically just starts spasming out... I can't see where my panel
 * goes. Everything else actually goes black."*
 *
 * `arrange-check.ts` passed 6/6 against the build that did all of that, and
 * the difference is the gesture, not the code: it drags a section in four
 * coarse steps with a 220ms settle between them. The old reflow measured
 * each element against its previous measurement, so a settle between moves
 * meant every measurement was taken at rest and the feedback loop that broke
 * the page never closed. **A check that waits cannot see this class of bug.**
 * This one moves every 16ms, the way a hand does, and samples on every
 * animation frame.
 *
 * What it records while the pointer is down:
 *
 * - the **lifted card's rectangle**, which must track the pointer and nothing
 *   else. A step larger than the pointer's own is the card leaving the hand,
 *   and it is how the 19,524,847px jump was found.
 * - the **placeholder's rectangle**, which is the live preview: it has to
 *   move when the pointer crosses a slot, and has to stop moving when the
 *   pointer merely wobbles on a boundary.
 * - **frame deltas**, for the 60fps claim.
 * - **nodes added and removed** under the grid, from a MutationObserver.
 *   Reordering the DOM mid-drag is what re-parents charts and canvases; the
 *   engine now reorders only on the drop, so this has to stay near zero.
 *
 * It also asks whether the constellation's WebGL canvas is painting - by
 * **photographing it** and counting lit pixels, not by reading the GL buffer.
 * `getContext` on a canvas that already has a context returns the existing
 * one and ignores the attributes passed, so `preserveDrawingBuffer` is
 * whatever the app asked for; without it the buffer is cleared after each
 * composite and a perfectly healthy canvas reads as 0 pixels lit. That probe
 * reported a dead constellation for a scene the screenshot showed in full.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/drag-check.ts --bundle --platform=node --format=cjs \
 *     --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/drag/index.js
 *   npx electron out/drag/index.js --db <copy> --width 1150 [--shots <dir>]
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-drag-${process.pid}`)
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
const width = Number(argument('--width') ?? 1150) || 1150
if (shotDir !== null) mkdirSync(shotDir, { recursive: true })

import { analytics } from '../src/main/db/analytics'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? (pass += 1) : (fail += 1)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (detail !== '') console.log(`       ${detail}`)
}

const watchdog = setTimeout(() => {
  console.log('TIMED OUT')
  app.exit(1)
}, 300_000)
watchdog.unref?.()

interface Box {
  x: number
  y: number
  w: number
  h: number
}
interface Frame {
  t: number
  lift: Box | null
  drop: Box | null
  order: string
  scroll: number
}
interface Reading {
  frames: Frame[]
  added: number
  removed: number
  canvasTouched: number
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
  // Long, because the constellation is a lazy chunk and a WebGL scene: what
  // happens with it on screen is half of what this run is for.
  await settle(5000)

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
  const press = async (key: string): Promise<void> => {
    for (const type of ['keyDown', 'keyUp']) {
      await debug.sendCommand('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: 27
      })
    }
  }

  const shoot = async (name: string): Promise<void> => {
    if (shotDir === null) return
    const image = await window.webContents.capturePage()
    writeFileSync(join(shotDir, `${name}-${width}.png`), image.toPNG())
  }

  /**
   * Is the constellation painting? Photographed, not read from GL.
   *
   * The canvas is captured as pixels and anything appreciably brighter than
   * the panel's near-black background counts as lit. That is the question
   * being asked - "does the user see stars or a black box" - and unlike
   * `readPixels` it does not depend on a context attribute this file does
   * not control.
   */
  const canvasLit = async (): Promise<string> => {
    const rect = (await ask(`(() => {
      const c = document.querySelector('.an-slot canvas');
      if (!c) return null;
      c.scrollIntoView({ block: 'center' });
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    })()`)) as { x: number; y: number; width: number; height: number } | null
    if (rect === null) return 'no canvas'
    await settle(2200)
    const image = await window.webContents.capturePage(rect)
    const bitmap = image.getBitmap()
    let lit = 0
    let seen = 0
    // Every 64th pixel: a quarter of a million samples is no more conclusive
    // than four thousand and takes a hundred times as long.
    for (let i = 0; i < bitmap.length; i += 4 * 64) {
      seen += 1
      if (bitmap[i] + bitmap[i + 1] + bitmap[i + 2] > 110) lit += 1
    }
    return `${((lit / Math.max(1, seen)) * 100).toFixed(1)}% of ${seen} sampled pixels lit`
  }

  console.log('')
  console.log(`--- reading mode at ${width}px ---`)
  const tall = (await ask(
    "document.querySelector('.dashboard__body')?.scrollHeight ?? document.body.scrollHeight"
  )) as number
  console.log(`    the arrangement is ${tall}px tall; the window is 1000px`)
  console.log(`    constellation: ${await canvasLit()}`)

  await ask(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Modify panels'); if (b) b.click(); return 1 })()`
  )
  await settle(900)

  console.log('')
  console.log(`--- arranging mode at ${width}px ---`)
  const short = (await ask(
    "document.querySelector('.dashboard__body')?.scrollHeight ?? document.body.scrollHeight"
  )) as number
  const canvases = (await ask("document.querySelectorAll('.an-slot canvas').length")) as number
  console.log(
    '    ' +
      ((await ask(`(() => [...document.querySelectorAll('.an-slot')].map((s) => {
    const t = s.querySelector('.an-slot__cardName');
    const r = s.getBoundingClientRect();
    return (t ? t.textContent.trim() : '?') + ' ' + Math.round(r.height) + 'px';
  }).join(' | '))()`)) as string)
  )
  const slotMap = (await ask(`(() => [...document.querySelectorAll('.an-slot')].map((s) => {
    const r = s.getBoundingClientRect();
    const t = s.querySelector('.an-slot__cardName');
    return { name: t ? t.textContent.trim() : '?', left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width) };
  }))()`)) as { name: string; left: number; top: number; w: number }[]
  for (const one of slotMap) {
    console.log(`    ${one.name.padEnd(34)} left ${one.left}  top ${one.top}  width ${one.w}`)
  }
  check(
    'the whole arrangement fits in the window once the panels are cards',
    short <= 1000,
    `${tall}px reading, ${short}px arranging`
  )
  check(
    'and nothing heavy is mounted while arranging',
    canvases === 0,
    `${canvases} canvas(es) on the page`
  )

  const record = (): Promise<unknown> =>
    ask(`(() => {
      const w = window;
      w.__frames = []; w.__added = 0; w.__removed = 0; w.__canvas = 0;
      const scroller = document.querySelector('.dashboard__body') || document.scrollingElement;
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
      const read = () => {
        w.__frames.push({
          t: performance.now(),
          lift: box(document.querySelector('.is-lifted')),
          drop: box(document.querySelector('.an-drop')),
          order: [...document.querySelectorAll('.an-slot__cardName')].map((n) => n.textContent.trim()).join(','),
          scroll: Math.round(scroller.scrollTop)
        });
        w.__raf = requestAnimationFrame(read);
      };
      w.__raf = requestAnimationFrame(read);
      w.__obs = new MutationObserver((list) => {
        for (const m of list) {
          w.__added += m.addedNodes.length; w.__removed += m.removedNodes.length;
          for (const n of [...m.addedNodes, ...m.removedNodes]) {
            if (n.nodeType === 1 && (n.tagName === 'CANVAS' || n.querySelector?.('canvas'))) w.__canvas += 1;
          }
        }
      });
      w.__obs.observe(document.querySelector('.dashboard__body') || document.body, { childList: true, subtree: true });
      return 1;
    })()`)

  const stop = (): Promise<Reading> =>
    ask(`(() => {
      cancelAnimationFrame(window.__raf);
      window.__obs.disconnect();
      return { frames: window.__frames, added: window.__added, removed: window.__removed, canvasTouched: window.__canvas };
    })()`) as Promise<Reading>

  /** The grip of a named card, with the page scrolled so it is in view. */
  const grip = async (title: string): Promise<{ x: number; y: number } | null> => {
    const find = `[...document.querySelectorAll('.an-slot')].find((s) => { const t = s.querySelector('.an-slot__cardName'); return t && t.textContent.trim().includes(${JSON.stringify(title)}) })`
    const there = (await ask(
      `(() => { const s = ${find}; if (!s) return null; s.scrollIntoView({ block: 'center' }); return 1 })()`
    )) as number | null
    if (there === null) return null
    await settle(400)
    return (await ask(
      `(() => { const g = ${find}.querySelector('.an-slot__grip'); const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
    )) as { x: number; y: number }
  }

  const order = (): Promise<string> =>
    ask(
      "[...document.querySelectorAll('.an-slot__cardName')].map((n) => n.textContent.trim()).join(',')"
    ) as Promise<string>

  /**
   * One drag, recorded and reported.
   *
   * `steps` is high and the pause between them short, because the bug this
   * exists to catch only appears when renders arrive faster than the
   * transitions they start.
   */
  const drag = async (
    name: string,
    title: string,
    dx: number,
    dy: number,
    opts: { steps?: number; escape?: boolean; reorder?: boolean } = {}
  ): Promise<void> => {
    const steps = opts.steps ?? 40
    const at = await grip(title)
    if (at === null) {
      check(`${name}: a card titled ${title}`, false)
      return
    }
    const before = await order()
    await record()
    await pointer('mousePressed', at.x, at.y)
    await settle(60)
    for (let i = 1; i <= steps; i += 1) {
      await pointer('mouseMoved', at.x + (dx * i) / steps, at.y + (dy * i) / steps)
      await settle(16)
      if (i === Math.round(steps / 2)) await shoot(`${name}-mid`)
    }
    await settle(160)
    if (opts.escape === true) {
      await press('Escape')
      await settle(300)
      await pointer('mouseReleased', at.x + dx, at.y + dy)
    } else {
      await pointer('mouseReleased', at.x + dx, at.y + dy)
    }
    await settle(420)
    const got = await stop()
    const after = await order()

    const lifted = got.frames.filter((f) => f.lift !== null)
    const expected = Math.hypot(dx, dy) / steps
    let jumps = 0
    let worst = 0
    for (let i = 1; i < lifted.length; i += 1) {
      const a = lifted[i - 1]
      const b = lifted[i]
      if (a.lift === null || b.lift === null) continue
      /*
       * In document coordinates, and with the scroll allowed for.
       *
       * The card is measured through `getBoundingClientRect`, which is
       * relative to the viewport, so while auto-scroll is running the card
       * can hold perfectly still under the hand and still appear to move by
       * the whole scroll step. Reading it as `viewport + scrollTop` and
       * allowing the frame's own scroll step is what separates "the page
       * moved" from "the card left the hand" - the first version counted
       * the former as a 460px jump.
       */
      const scrolled = Math.abs(b.scroll - a.scroll)
      const moved = Math.hypot(b.lift.x - a.lift.x, b.lift.y + b.scroll - (a.lift.y + a.scroll))
      if (moved > expected + scrolled + 24) {
        jumps += 1
        worst = Math.max(worst, moved)
      }
    }
    const withDrop = got.frames.filter((f) => f.drop !== null).length
    let previewMoves = 0
    const drops = got.frames.filter((f) => f.drop !== null)
    for (let i = 1; i < drops.length; i += 1) {
      const a = drops[i - 1].drop
      const b = drops[i].drop
      if (a !== null && b !== null && (Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2)) {
        previewMoves += 1
      }
    }
    let reorders = 0
    for (let i = 1; i < got.frames.length; i += 1) {
      if (got.frames[i].order !== got.frames[i - 1].order) reorders += 1
    }
    const deltas: number[] = []
    for (let i = 1; i < got.frames.length; i += 1) {
      deltas.push(got.frames[i].t - got.frames[i - 1].t)
    }
    deltas.sort((a, b) => a - b)
    const p95 = deltas.length === 0 ? 0 : deltas[Math.floor(deltas.length * 0.95)]

    console.log('')
    console.log(`  ${name} - ${title} by (${dx}, ${dy})`)
    console.log(
      `       ${got.frames.length} frames, lifted in ${lifted.length}, placeholder in ${withDrop}; p95 ${p95.toFixed(1)}ms`
    )
    console.log(
      `       card jumped ${jumps}x (worst ${Math.round(worst)}px); preview moved ${previewMoves}x; DOM reorders ${reorders}`
    )
    console.log(
      `       placeholder y ${drops[0]?.drop?.y} -> ${drops[drops.length - 1]?.drop?.y}; card y ${lifted[0]?.lift?.y} -> ${lifted[lifted.length - 1]?.lift?.y}`
    )
    console.log(
      `       nodes +${got.added} -${got.removed}, canvas touched ${got.canvasTouched}; scroll ${got.frames[0]?.scroll} -> ${got.frames[got.frames.length - 1]?.scroll}`
    )

    check(
      `${name}: the lifted card never leaves the hand`,
      jumps === 0,
      `worst step ${Math.round(worst)}px`
    )
    check(
      `${name}: it is visible and full size for the whole gesture`,
      lifted.length > got.frames.length * 0.6 && lifted.every((f) => (f.lift?.h ?? 0) > 20),
      `lifted in ${lifted.length} of ${got.frames.length} frames`
    )
    check(
      `${name}: a placeholder shows where it will land`,
      withDrop > got.frames.length * 0.6,
      `drawn in ${withDrop} of ${got.frames.length} frames`
    )
    check(
      `${name}: nothing is reordered or remounted mid-drag`,
      reorders <= 1 && got.canvasTouched === 0
    )
    check(
      `${name}: 60fps - the 95th percentile frame is under 16.7ms`,
      p95 < 16.7,
      `p95 ${p95.toFixed(1)}ms`
    )
    if (opts.escape === true) {
      check(`${name}: Escape cancels and nothing is committed`, after === before, after)
    } else if (opts.reorder === true) {
      /*
       * The preview and the commit have to agree, which is only a real
       * question when the drag crosses a slot - the two-panel sections
       * cannot, so this is asked of the three-panel one. The placeholder's
       * last position is where the drop said it would land; the order after
       * the drop is where it did.
       */
      check(
        `${name}: the preview moved as the pointer crossed a slot`,
        previewMoves > 0,
        `placeholder moved ${previewMoves}x`
      )
      check(
        `${name}: and the drop commits what it showed`,
        after !== before,
        `${before} -> ${after}`
      )
    }
  }

  /*
   * Where each drag goes, and why there. Two of the four sections hold
   * exactly two panels, so a drag inside them can only swap - which is worth
   * one test and cannot show a preview crossing anything. The ordering tests
   * use Projects and output, which holds three.
   */
  await drag('reorder-down', 'Hours by project', 0, 150, { reorder: true })
  // The same card back up again, rather than a different one: after the drop
  // above, which card now sits above which is exactly what has changed, and
  // a test that assumed the original arrangement was testing the fixture.
  await drag('reorder-up', 'Hours by project', 0, -150, { reorder: true })
  await drag('swap', 'Every day', 0, 90)
  await drag('wobble', 'Are your timers', 6, -8, { steps: 60 })
  await drag('escape', 'Work rate over time', 0, -150, { escape: true })

  /*
   * A drag long enough to need the page to move under it. The slots were
   * captured in document coordinates precisely so that this works; with
   * viewport rectangles every hit test after the first scrolled pixel is off
   * by the scroll, which is its own kind of spasm.
   */
  console.log('')
  console.log('  auto-scroll')
  /*
   * A member of a group of more than one: a lone panel cannot be dragged at
   * all - `grab` refuses a group with nothing to reorder - so grabbing the
   * Constellation would have scrolled the page with `scrollIntoView` and
   * then proved nothing about auto-scroll.
   */
  /*
   * Shortened first, because the compact cards leave the whole arrangement
   * 888px tall in a 1,000px window - 58px of scroll range, which is not
   * enough to tell auto-scroll from rounding. At 520px the page has to move
   * several hundred pixels for the pointer to reach the top of the list,
   * which is the case the feature exists for.
   */
  window.setContentSize(width, 520)
  await settle(700)
  const far = await grip('Work rate over time')
  if (far !== null) {
    await record()
    await pointer('mousePressed', far.x, far.y)
    await settle(60)
    // Held near the top edge, without moving further: the page should come to
    // the pointer rather than the pointer having to reach the page.
    for (let i = 1; i <= 10; i += 1) {
      await pointer('mouseMoved', far.x, far.y - (i * (far.y - 40)) / 10)
      await settle(16)
    }
    await settle(900)
    await shoot('autoscroll-mid')
    await pointer('mouseReleased', far.x, 40)
    await settle(400)
    const got = await stop()
    const first = got.frames[0]?.scroll ?? 0
    const last = got.frames[got.frames.length - 1]?.scroll ?? 0
    const held = got.frames.filter((f) => f.lift !== null).length
    check(
      'holding the pointer at the top edge scrolls the page under it',
      first - last > 150 && held > got.frames.length * 0.5,
      `scroll ${first} -> ${last}, lifted in ${held} of ${got.frames.length} frames`
    )
  }

  window.setContentSize(width, 1000)
  await settle(500)
  await ask(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Done'); if (b) b.click(); return 1 })()`
  )
  await settle(4500)
  console.log('')
  console.log('--- back in reading mode ---')
  const back = (await ask("document.querySelectorAll('.an-slot canvas').length")) as number
  const litAfter = await canvasLit()
  console.log(`    constellation: ${litAfter}`)
  await shoot('after-done')
  check('the heavy panels come back when the mode ends', back === 1, `${back} canvas(es)`)
  check('and the constellation is painting, not black', Number.parseFloat(litAfter) > 1, litAfter)

  if (shotDir !== null) console.log(`    shots in ${shotDir}`)
  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  clearTimeout(watchdog)
  app.exit(fail === 0 ? 0 : 1)
})
