/**
 * Asks Windows itself which parts of the timer window take a click.
 *
 *   npx esbuild scripts/project-click-check.ts --bundle --platform=node --format=cjs \
 *     --target=node22 --external:electron --outfile=out/clickcheck/index.js
 *   npx electron out/clickcheck/index.js
 *
 * Needs `npm run build` first, for the renderer and preload it loads.
 *
 * ## Why not a synthetic click
 *
 * `-webkit-app-region: drag` is enforced by the OS, not by the page: Windows
 * sends the window `WM_NCHITTEST`, Electron answers HTCAPTION over a drag
 * region, and the click is turned into a window drag before Chromium ever sees
 * it. A click dispatched through CDP or `element.click()` skips that step
 * entirely, so it lands on fields the user cannot reach. This sends the
 * window the same `WM_NCHITTEST` a real mouse would, at the centre of each
 * field, and reads the answer: 1 (HTCLIENT) is clickable, 2 (HTCAPTION) is
 * the window drag that swallows the click.
 *
 * No database is opened. The handlers the timer calls on paint return fixed
 * values, and everything that writes is inert.
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'dwt-clickcheck-')))

const idle = {
  status: 'idle',
  plannedMs: 25 * 60_000,
  startedAt: null,
  targetEndAt: null,
  pausedAt: null,
  runningMs: 0,
  task: '',
  project: 'HW'
}

function handlers(): void {
  const reads: Record<string, () => unknown> = {
    'timer:get': () => idle,
    'timer:getLoop': () => true,
    'timer:getAutoEnd': () => 180,
    'timer:getPace': () => null,
    'sessions:lastProject': () => 'HW',
    'sessions:projectNames': () => ['HW', 'Startup', 'College Apps'],
    'sessions:lastUnit': () => null,
    'shortcuts:get': () => ({ pause: '', stop: '', newTimer: '' }),
    'window:isFullScreen': () => false,
    'app:preview': () => null
  }
  for (const [channel, read] of Object.entries(reads)) ipcMain.handle(channel, () => read())
  for (const channel of [
    'timer:start',
    'timer:setTask',
    'timer:setProject',
    'timer:setPace',
    'window:setVariant',
    'window:minimize',
    'window:close'
  ])
    ipcMain.handle(channel, () => null)
}

interface Target {
  name: string
  selector: string
}

const TARGETS: Target[] = [
  { name: 'project field', selector: '.dial__project' },
  { name: 'clock field', selector: '.dial__clock--input' },
  { name: 'task field', selector: '.card__head input' }
]

/** Physical-pixel centres of each field, in screen coordinates. */
async function centres(
  win: BrowserWindow
): Promise<Array<{ name: string; x: number; y: number } | { name: string; missing: true }>> {
  const content = win.getContentBounds()
  const out: Array<{ name: string; x: number; y: number } | { name: string; missing: true }> = []
  for (const t of TARGETS) {
    const rect = (await win.webContents.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(t.selector)})?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`,
      true
    )) as { x: number; y: number } | null
    if (rect === null) {
      out.push({ name: t.name, missing: true })
      continue
    }
    const p = screen.dipToScreenPoint({
      x: Math.round(content.x + rect.x),
      y: Math.round(content.y + rect.y)
    })
    out.push({ name: t.name, x: p.x, y: p.y })
  }
  return out
}

/**
 * WM_NCHITTEST from outside the process, as the OS would ask it.
 *
 * Asynchronous on purpose. `SendMessage` waits for the window's thread to
 * answer, and that thread is this one: a `spawnSync` here deadlocks, the
 * PowerShell waiting on the window and the window waiting on PowerShell.
 */
function hitTest(hwnd: bigint, points: Array<{ x: number; y: number }>): Promise<number[]> {
  const script = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class H {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
[void][H]::SetProcessDPIAware()
$h = [IntPtr]::new([Int64]${hwnd.toString()})
${points
  .map(
    (p) =>
      `[H]::SendMessage($h, 0x84, [IntPtr]::Zero, [IntPtr]::new([Int64](((${p.y} -band 0xFFFF) -shl 16) -bor (${p.x} -band 0xFFFF)))).ToInt64()`
  )
  .join('\n')}
`
  const file = join(app.getPath('userData'), 'hit.ps1')
  writeFileSync(file, script, 'utf8')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`${error.message}\n${stderr}`))
        resolve(
          stdout
            .trim()
            .split(/\s+/)
            .map((s) => Number(s))
        )
      }
    )
  })
}

const NAMES: Record<number, string> = {
  1: 'HTCLIENT (clickable)',
  2: 'HTCAPTION (drag - click swallowed)'
}

let failures = 0

async function check(win: BrowserWindow, label: string, focused: string | null): Promise<void> {
  if (focused) {
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(focused)})?.focus()`,
      true
    )
  } else {
    await win.webContents.executeJavaScript(`document.activeElement?.blur()`, true)
  }
  await new Promise((done) => setTimeout(done, 400))
  const found = await centres(win)
  const present = found.filter(
    (f): f is { name: string; x: number; y: number } => !('missing' in f)
  )
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
  const hits = await hitTest(hwnd, present)
  console.log(`\n${label}`)
  for (const f of found) {
    if ('missing' in f) {
      console.log(`  ${f.name.padEnd(14)} not on screen`)
      continue
    }
    const hit = hits[present.indexOf(f)]
    const ok = hit === 1
    if (!ok) failures += 1
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${f.name.padEnd(14)} ${NAMES[hit] ?? hit}`)
  }
}

app.whenReady().then(async () => {
  handlers()
  const win = new BrowserWindow({
    width: 250,
    height: 136,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  await win.loadFile(join(__dirname, '../renderer/index.html'))
  await new Promise((done) => setTimeout(done, 800))

  // The instrument has to be able to say no: an empty stretch of card is a
  // drag region by design, so it must come back HTCAPTION.
  {
    const c = win.getContentBounds()
    const p = screen.dipToScreenPoint({ x: c.x + 6, y: c.y + c.height - 6 })
    const [hit] = await hitTest(win.getNativeWindowHandle().readBigUInt64LE(0), [p])
    console.log(`control: bare card corner -> ${NAMES[hit] ?? hit}`)
    if (hit !== 2) failures += 1
  }

  // What a click does once it lands. CDP input goes through Chromium's real
  // mouse path - focus, caret placement, selection - which is what matters
  // here now that the OS hit test is known to pass.
  win.webContents.debugger.attach('1.3')
  const clickAt = async (selector: string): Promise<unknown> => {
    const r = (await win.webContents.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
      true
    )) as { x: number; y: number }
    for (const type of ['mousePressed', 'mouseReleased'])
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        x: r.x,
        y: r.y,
        button: 'left',
        clickCount: 1
      })
    await new Promise((done) => setTimeout(done, 300))
    return win.webContents.executeJavaScript(
      `(() => { const a = document.activeElement; return { focused: a?.className || a?.tagName, value: a?.value, selection: a?.value === undefined ? null : [a.selectionStart, a.selectionEnd], menu: !!document.querySelector('.project-menu') } })()`,
      true
    )
  }
  // Both fields arrive holding a value, so a click must select it whole or
  // whatever is typed next lands inside the old text.
  for (const [name, selector] of [
    ['clock', '.dial__clock--input'],
    ['project', '.dial__project']
  ]) {
    const r = (await clickAt(selector)) as { value: string; selection: [number, number] }
    const ok = r.selection[0] === 0 && r.selection[1] === r.value.length && r.value.length > 0
    if (!ok) failures += 1
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  click on ${name} selects "${r.value}" -> ${JSON.stringify(r.selection)}`
    )
  }
  await win.webContents.executeJavaScript(`document.activeElement?.blur()`, true)

  await check(win, 'bar, nothing focused (how the user finds it)', null)
  await check(win, 'bar, clock focused', '.dial__clock--input')

  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].find(b => /ring/i.test(b.title))?.click()`,
    true
  )
  win.setContentSize(250, 220)
  await new Promise((done) => setTimeout(done, 600))
  await check(win, 'ring, nothing focused', null)

  console.log(
    `\nproject-click-check: ${failures === 0 ? 'all fields take a click' : `${failures} field(s) swallow the click`}`
  )
  app.exit(failures === 0 ? 0 : 1)
})
