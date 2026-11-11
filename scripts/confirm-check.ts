/**
 * Every yes/no in the dashboard, driven with a real mouse and read back from
 * the database.
 *
 * *"deleting sessions still has a windows popup. this should be an in-app
 * popup"* (11/11/2026). What makes this worth driving rather than reading is
 * that a confirmation has exactly two jobs and both are invisible from the
 * markup: **Cancel must leave the row alone**, and **Delete must remove the
 * one that was asked about**. A strip that renders beautifully and deletes
 * the wrong row, or deletes on Cancel, looks identical in a screenshot.
 *
 * It also asserts the rule the old dialogs carried, which is the easiest
 * thing to lose in a rewrite: **an imported row is asked twice**. The first
 * Delete on one must not remove it - it must open the second step. Three and
 * a half years of history the app did not record sit in the same table as a
 * session from ten minutes ago, with the same button beside them.
 *
 * Clicks go through CDP rather than `el.click()`, for the reason the focus
 * ring diagnosis recorded: a scripted click does not move focus and does not
 * exercise what a hand does. These confirmations autofocus their action
 * button, which is only meaningful under a real one.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/confirm-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/confirm/index.js
 *   npx electron out/confirm/index.js [--db <copy>] [--shots <dir>]
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-confirm-${process.pid}`)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

function argument(name: string): string | null {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}
const source = argument('--db')
const shotDir = argument('--shots')
if (shotDir !== null) mkdirSync(shotDir, { recursive: true })
if (source !== null && existsSync(source)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(source + suffix)) {
      copyFileSync(source + suffix, join(profile, `deepwork.db${suffix}`))
    }
  }
}

import { openDatabase } from '../src/main/db'
import { querySessions } from '../src/main/db/sessions'
import { historyState, removeSession, undo } from '../src/main/db/history'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? (pass += 1) : (fail += 1)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok && detail !== '') console.log(`       ${detail}`)
}

process.on('unhandledRejection', (error) => {
  console.log(`UNHANDLED REJECTION: ${String(error)}`)
  app.exit(1)
})
const watchdog = setTimeout(() => {
  console.log('TIMED OUT')
  app.exit(1)
}, 240_000)
watchdog.unref?.()

app.whenReady().then(async () => {
  const db = openDatabase()

  /*
   * Two rows that differ only in `source`, so the only thing that can explain
   * a difference in how they are confirmed is the rule being tested.
   */
  if (source === null) {
    db.exec("INSERT INTO projects (name) VALUES ('HW')")
    const insert = db.prepare(
      `INSERT INTO sessions (project_id, task, session_date, planned_duration_s,
                             running_duration_s, source, laps)
       VALUES (1, ?, ?, 1800, 1500, ?, 1)`
    )
    insert.run('Timed by the app', '2026-03-02', 'app')
    insert.run('From the spreadsheet', '2026-03-01', 'import')
    insert.run('Entered by hand', '2026-02-28', 'manual')
  }

  const rows = (): Array<{ id: number; task: string | null; source: string }> =>
    (
      querySessions({ limit: 20, offset: 0 }) as unknown as {
        rows: Array<{ id: number; task: string | null; source: string }>
      }
    ).rows
  const countNow = (): number => rows().length
  const started = countNow()
  console.log('')
  console.log(`--- ${started} sessions to start ---`)

  const reads: Record<string, () => unknown> = {
    'sessions:query': () => querySessions({ limit: 20, offset: 0 }),
    'sessions:projects': () => [],
    'history:state': () => historyState(),
    /*
     * Canned, because the two remaining confirmations are reached through a
     * file picker and this is about the question, not the file. The values
     * are the shapes the real handlers return, so the panel renders exactly
     * what it would - including the counts the question is built from.
     */
    'backup:status': () => ({
      directory: join(profile, 'Backups'),
      intervalDays: 3.5,
      kept: 8,
      sessions: 2478,
      nextDue: null,
      backups: []
    }),
    'backup:pickRestore': () => join(profile, 'Backups', 'deep-work-backup-2026-11-09-0300.csv'),
    'backup:previewRestore': () => ({
      ok: true,
      problem: null,
      rows: 2478,
      hours: 2755.4,
      firstDate: '2023-03-27',
      lastDate: '2026-11-05',
      projects: 36,
      replaces: 3
    }),
    'import:pickFile': () => 'Deep Work Data.csv',
    'import:preview': () => ({
      totalRows: 3157,
      importable: 2336,
      skippedBlank: 797,
      skippedNoTiming: 24,
      // `totalHours`, not `hours`: the tab reads `preview.totalHours.toFixed`,
      // and a canned payload missing one field unmounted the whole tree - a
      // page with no buttons on it, which from outside looks like the tab
      // failing to open rather than like a typo in this file.
      totalHours: 2545.1,
      firstDate: '2023-03-27',
      lastDate: '2026-09-19',
      projects: [{ name: 'HW', sessions: 1056, hours: 762.2 }],
      units: [{ name: 'question', rows: 707 }],
      sample: []
    }),
    'import:existingCount': () => 2336,
    'shortcuts:get': () => ({ pause: '', stop: '', newTimer: '' }),
    'window:isFullScreen': () => false,
    'app:preview': () => null,
    'projects:list': () => [],
    'log:location': () => join(profile, 'logs', 'errors.log'),
    'layout:get': () => null,
    'analytics:get': () => null
  }
  for (const [channel, read] of Object.entries(reads)) ipcMain.handle(channel, () => read())
  // The same label main uses, so undo reads as it does in the app.
  ipcMain.handle('sessions:remove', (_event, id: number) => removeSession(id, 'delete session'))
  ipcMain.handle('history:undo', () => undo())

  const window = new BrowserWindow({
    show: true,
    width: 1300,
    height: 950,
    useContentSize: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  // A renderer that throws unmounts the whole tree, which from outside looks
  // like a page with no buttons on it. Saying so beats guessing.
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`       [page] ${message.slice(0, 300)}`)
  })
  const ask = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression, true)
  const settle = (ms: number): Promise<unknown> => new Promise((done) => setTimeout(done, ms))

  await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
  await settle(1500)
  await ask(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Data'); if (b) b.click(); return 1 })()`
  )
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = (await ask("document.querySelectorAll('table.grid tbody tr').length")) as number
    if (ready > 0) break
    await settle(250)
  }
  await settle(600)

  const debug = window.webContents.debugger
  debug.attach('1.3')
  /** A real click, at the centre of whatever matches. */
  const clickOn = async (find: string): Promise<boolean> => {
    const box = (await ask(`(() => {
      const el = ${find};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)) as { x: number; y: number } | null
    if (box === null) return false
    await settle(220)
    const again = (await ask(`(() => {
      const el = ${find};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)) as { x: number; y: number } | null
    if (again === null) return false
    for (const type of ['mousePressed', 'mouseReleased']) {
      await debug.sendCommand('Input.dispatchMouseEvent', {
        type,
        x: Math.round(again.x),
        y: Math.round(again.y),
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0
      })
    }
    await settle(320)
    return true
  }

  const shoot = async (name: string): Promise<void> => {
    if (shotDir === null) return
    const image = await window.webContents.capturePage()
    writeFileSync(join(shotDir, `${name}.png`), image.toPNG())
  }

  /**
   * The row to act on, as a DOM expression.
   *
   * On the fixture it is found by its task, which is unique there. Against a
   * real-size copy (`--db`) task names repeat - `MATH 1410` appears dozens of
   * times - so the first row carrying a given Source badge is used instead,
   * which is the only property these probes actually care about. The
   * behavioural assertions run on the fixture; `--db` is for the pictures,
   * because thirty-six projects and four-digit counts are a different thing
   * to look at from three invented rows.
   */
  const rowFor = (task: string, badge: string): string =>
    source === null
      ? `[...document.querySelectorAll('table.grid tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(task)}))`
      : `[...document.querySelectorAll('table.grid tbody tr')].find((tr) => { const b = tr.querySelector('.badge'); return b && b.textContent.trim() === ${JSON.stringify(badge)} })`
  const stripText = (): Promise<string> =>
    ask(
      "(() => { const el = document.querySelector('.confirm'); return el ? el.textContent.trim() : '' })()"
    ) as Promise<string>
  const confirmButton = (label: string): string =>
    `[...document.querySelectorAll('.confirm button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`

  console.log('')
  console.log('--- no dialog is ever opened ---')
  /*
   * The point of the whole change. `showMessageBox` blocks the main process,
   * so if anything still called it this run would hang rather than fail - and
   * a hang reads as a broken harness. Counting the calls says which it is.
   */
  let dialogs = 0
  const electron = await import('electron')
  const realBox = electron.dialog.showMessageBox
  /*
   * Swapped through an index signature rather than with `any`: the only thing
   * needed here is to replace one method on a namespace object, and widening
   * the whole module to `any` to do it would turn off every check on the
   * lines around it.
   */
  const seam = electron.dialog as unknown as Record<string, unknown>
  const inner = realBox as unknown as (...a: unknown[]) => unknown
  seam.showMessageBox = (...args: unknown[]): unknown => {
    dialogs += 1
    return inner(...args)
  }

  console.log('')
  console.log('--- cancel leaves the row alone ---')
  check(
    'the app-recorded row is in the table',
    await clickOn(`${rowFor('Timed by the app', 'app')}.querySelector('.row-action--danger')`)
  )
  const cancelText = await stripText()
  // Whatever that row's task actually is, rather than a name written down
  // here: on a real-size copy the first app-recorded row is whatever it is,
  // and the thing being asserted is that the strip names the row it opened
  // under - not that the fixture is the fixture.
  const openedTask = (await ask(
    `(() => { const tr = ${rowFor('Timed by the app', 'app')}; return tr ? tr.children[2].textContent.trim() : '' })()`
  )) as string
  check(
    'its confirmation names the session and says it can be undone',
    openedTask !== '' && cancelText.includes(openedTask) && cancelText.includes('undone'),
    `task ${JSON.stringify(openedTask)} in ${JSON.stringify(cancelText)}`
  )
  check('  and offers one step, not two', !cancelText.includes('spreadsheet'), cancelText)
  await shoot('confirm-delete-app')
  check('Cancel closes it', await clickOn(confirmButton('Cancel')))
  check('  the strip is gone', (await stripText()) === '')
  check('  and nothing was deleted', countNow() === started, `${countNow()} of ${started}`)

  if (source !== null) {
    // Against a real-size copy the remaining probes would delete real-looking
    // rows to prove something the fixture already proves. Open the imported
    // row's two steps for their pictures and stop.
    await clickOn(
      `${rowFor('From the spreadsheet', 'import')}.querySelector('.row-action--danger')`
    )
    await shoot('confirm-delete-import-1')
    await clickOn(confirmButton('Delete…'))
    await shoot('confirm-delete-import-2')
    await clickOn(confirmButton('Cancel'))
    check('an imported row still opens its second step', countNow() === started)
  } else {
    console.log('')
    console.log('--- delete removes the row it asked about ---')
    await clickOn(`${rowFor('Timed by the app', 'app')}.querySelector('.row-action--danger')`)
    check('Delete goes through', await clickOn(confirmButton('Delete')))
    await settle(400)
    const afterDelete = rows()
    check('  one fewer session', afterDelete.length === started - 1, `${afterDelete.length}`)
    check(
      '  and it is the one that was asked about',
      !afterDelete.some((row) => row.task === 'Timed by the app'),
      afterDelete.map((row) => row.task).join(', ')
    )
    check(
      '  the others are untouched',
      afterDelete.some((row) => row.task === 'From the spreadsheet') &&
        afterDelete.some((row) => row.task === 'Entered by hand'),
      afterDelete.map((row) => row.task).join(', ')
    )

    console.log('')
    console.log('--- an imported row is asked twice ---')
    await clickOn(
      `${rowFor('From the spreadsheet', 'import')}.querySelector('.row-action--danger')`
    )
    const firstStep = await stripText()
    check(
      'the first step is the ordinary question',
      firstStep.includes('From the spreadsheet'),
      firstStep
    )
    await shoot('confirm-delete-import-1')
    check('its action is marked as leading somewhere', firstStep.includes('Delete…'), firstStep)
    check('clicking it does not delete', await clickOn(confirmButton('Delete…')))
    check('  the row is still there', countNow() === started - 1, `${countNow()}`)
    const secondStep = await stripText()
    check(
      '  a second step explains what imported history is',
      secondStep.includes('spreadsheet') && secondStep.includes('re-importing'),
      secondStep
    )
    await shoot('confirm-delete-import-2')
    /*
     * The tint and the button colour, computed rather than assumed. A custom
     * property declared on an ancestor the strip does not actually descend from
     * resolves to nothing, and `color-mix` with an unset colour falls back
     * silently - the strip renders in the plain surface colour and looks like a
     * styling preference rather than a bug.
     */
    const paint = (await ask(`(() => {
    const cell = document.querySelector('.confirm-row > td');
    const act = [...document.querySelectorAll('.confirm button')].find((b) => b.textContent.includes('Delete'));
    const read = (el) => el ? getComputedStyle(el) : null;
    const c = read(cell), a = read(act);
    return {
      danger: cell ? getComputedStyle(cell).getPropertyValue('--danger').trim() : '',
      cellBg: c ? c.backgroundColor : '',
      actionColor: a ? a.color : ''
    };
  })()`)) as { danger: string; cellBg: string; actionColor: string }
    console.log(
      `       --danger ${paint.danger || '(unset)'} | strip ${paint.cellBg} | action ${paint.actionColor}`
    )
    /*
     * Compared against a real row rather than against a colour written down
     * here: what matters is that the strip does not look like another row of
     * the table, and the row's own background is the only honest reference.
     */
    const plain = (await ask(`(() => {
    const tr = [...document.querySelectorAll('table.grid tbody tr')].find((x) => !x.classList.contains('confirm-row'));
    return tr ? getComputedStyle(tr.querySelector('td')).backgroundColor : '';
  })()`)) as string
    console.log(`       an ordinary row is ${plain}`)
    check(
      'the strip reads as a warning, not as another row',
      paint.danger !== '' && paint.cellBg !== plain && paint.cellBg.includes('0.898'),
      `strip ${paint.cellBg} against row ${plain}`
    )
    check(
      'and its action button is the danger colour',
      paint.actionColor === 'rgb(229, 72, 77)',
      paint.actionColor
    )
    check('Cancel on the second step still keeps it', await clickOn(confirmButton('Cancel')))
    check('  nothing deleted', countNow() === started - 1, `${countNow()}`)

    await clickOn(
      `${rowFor('From the spreadsheet', 'import')}.querySelector('.row-action--danger')`
    )
    await clickOn(confirmButton('Delete…'))
    check('the second step deletes', await clickOn(confirmButton('Delete imported row')))
    await settle(400)
    check(
      '  the imported row is gone',
      !rows().some((row) => row.task === 'From the spreadsheet'),
      rows()
        .map((r) => r.task)
        .join(', ')
    )
    check('  and only it', countNow() === started - 2, `${countNow()}`)

    console.log('')
    console.log('--- and it is undoable, as the strip said ---')
    undo()
    check(
      'undo brings the imported row back',
      rows().some((row) => row.task === 'From the spreadsheet')
    )
  }

  check('no Windows dialog was opened at any point', dialogs === 0, `${dialogs} opened`)

  console.log('')
  console.log('--- restore, asked in the panel ---')
  await ask(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Settings'); if (b) b.click(); return 1 })()`
  )
  await settle(1200)
  check(
    'Restore from a backup opens a strip, not a dialog',
    await clickOn(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Restore from a backup'))`
    )
  )
  const restoreText = await stripText()
  check(
    '  stating what comes in and what goes out',
    restoreText.includes('2,478 sessions') && restoreText.includes('3 sessions currently'),
    restoreText
  )
  check('  and that it is reversible', restoreText.includes('reversible'), restoreText)
  await shoot('confirm-restore')
  check('Cancel closes it', await clickOn(confirmButton('Cancel')))
  check('  nothing restored', (await stripText()) === '')

  console.log('')
  console.log('--- replacing an import, asked in the tab ---')
  await ask(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Import'); if (b) b.click(); return 1 })()`
  )
  await settle(900)
  await clickOn(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Choose'))`
  )
  await settle(900)
  console.log(
    '       buttons on the Import tab: ' +
      ((await ask(
        "[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' | ')"
      )) as string)
  )
  check(
    'Replace import asks first',
    await clickOn(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Replace import')`
    )
  )
  const replaceText = await stripText()
  check(
    '  naming both counts',
    replaceText.includes('2,336 imported sessions') && replaceText.includes('2,336 from this file'),
    replaceText
  )
  check('  and saying what is not touched', replaceText.includes('not touched'), replaceText)
  await shoot('confirm-replace-import')
  check('Cancel closes it', await clickOn(confirmButton('Cancel')))
  check('  nothing imported', (await stripText()) === '')

  if (shotDir !== null) console.log(`    shots in ${shotDir}`)
  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  clearTimeout(watchdog)
  app.exit(fail === 0 ? 0 : 1)
})
