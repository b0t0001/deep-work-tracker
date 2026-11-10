/**
 * Curating the project list, against a fixture built to have every case.
 *
 * *"i should be able to manually adjust what projects the app recognizes"*.
 * What makes this worth a script rather than a read-through is that three of
 * the four operations change rows the user cannot afford to lose - a merge
 * rewrites hundreds of sessions, a delete removes a row other tables point at
 * - and the fourth changes what the timer offers, which is invisible from
 * anywhere except the timer.
 *
 * The fixture mirrors the real history's shapes: a large project and a small
 * one that are plainly the same thing spelled twice (the `College Apps` /
 * `College Applications` drift CLAUDE.md records), a project with no sessions
 * at all (the `Entre` that prompted this), a project with a tag, and two
 * names close enough that snapping has an opinion about them.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/projects-check.ts --bundle --platform=node \
 *     --format=cjs --target=node22 --external:electron --external:node:sqlite \
 *     --outfile=out/projects/index.js
 *   npx electron out/projects/index.js
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

/*
 * Without these, `capturePage` fails with `UnknownVizError` as soon as
 * Windows decides the window is covered - which it is, because nothing here
 * brings it to the front. Every other harness in this repo sets them for the
 * same reason.
 */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const profile = join(app.getPath('temp'), `dwt-projects-${process.pid}`)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

function argument(name: string): string | null {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}

/*
 * With `--db <copy>` this photographs the section against a real-size history
 * instead of running the fixture. Thirty-seven projects is a different thing
 * to look at from five, and a list that reads well at five and scrolls badly
 * at thirty-seven is the fault worth catching - the same argument as
 * screenshotting the Data tab rather than reading its markup.
 */
const source = argument('--db')
const shot = argument('--shot')
if (source !== null && existsSync(source)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(source + suffix)) {
      copyFileSync(source + suffix, join(profile, `deepwork.db${suffix}`))
    }
  }
}

import { openDatabase } from '../src/main/db'
import { allProjectNames, findOrCreateProject } from '../src/main/db/sessions'
import {
  deleteProject,
  listProjectsForAdmin,
  mergeProjects,
  planMerge,
  renameProject,
  setProjectArchived
} from '../src/main/db/projectAdmin'

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

app.whenReady().then(async () => {
  if (source !== null && existsSync(source)) {
    const reads: Record<string, () => unknown> = {
      'projects:list': () => listProjectsForAdmin(),
      'backup:status': () => null,
      'sessions:query': () => ({ rows: [], total: 0, hours: 0 }),
      'sessions:projects': () => [],
      'history:state': () => ({ canUndo: false, canRedo: false }),
      'import:existingCount': () => 0,
      'shortcuts:get': () => ({ pause: '', stop: '', newTimer: '' }),
      'window:isFullScreen': () => false,
      'app:preview': () => null,
      'log:location': () => join(profile, 'logs', 'errors.log'),
      'layout:get': () => null,
      'analytics:get': () => null
    }
    for (const [channel, read] of Object.entries(reads)) ipcMain.handle(channel, () => read())

    const window = new BrowserWindow({
      show: true,
      width: 1200,
      height: 1000,
      useContentSize: true,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
    })
    await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
    const wait = (ms: number): Promise<unknown> => new Promise((done) => setTimeout(done, ms))
    await wait(2500)
    await window.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Settings'); if (b) b.click(); return 1 })()`,
      true
    )
    await wait(1200)
    const count = (await window.webContents.executeJavaScript(
      "document.querySelectorAll('.proj').length",
      true
    )) as number
    /*
     * Scrolled by setting `scrollTop` on the pane, not with `scrollIntoView`
     * on the heading. Settings scrolls inside `.dashboard__body`, and asking
     * an element inside it to scroll itself into view moved nothing - the
     * first version of this shot photographed the top of the tab and the two
     * rows that happened to reach the bottom edge.
     */
    await window.webContents.executeJavaScript(
      `(() => {
        const pane = document.querySelector('.dashboard__body');
        const h = [...document.querySelectorAll('h2')].find((x) => x.textContent.trim() === 'Projects');
        if (pane && h) pane.scrollTop = h.offsetTop - 16;
        return pane ? pane.scrollTop : -1;
      })()`,
      true
    )
    await wait(600)
    console.log('')
    console.log(`--- ${count} projects on a real-size history ---`)
    check('the section rendered its projects', count > 20, `${count} rows`)
    if (shot !== null) {
      const image = await window.webContents.capturePage()
      writeFileSync(shot, image.toPNG())
      console.log(`    wrote ${shot}`)
    }
    console.log('')
    console.log(`${pass} passed, ${fail} failed`)
    app.exit(fail === 0 ? 0 : 1)
    return
  }

  const db = openDatabase()
  const project = (name: string): number =>
    Number(db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid)

  const apps = project('College Apps')
  const applications = project('College Applications')
  const hw = project('HW')
  const entre = project('Entre')
  const scioly = project('Scioly')

  const session = db.prepare(
    `INSERT INTO sessions (project_id, task, session_date, planned_duration_s,
                           running_duration_s, source, laps)
     VALUES (?, ?, ?, ?, ?, 'import', 1)`
  )
  for (let n = 0; n < 12; n += 1) session.run(apps, `Essay ${n}`, '2026-01-05', 1800, 1500)
  for (let n = 0; n < 3; n += 1)
    session.run(applications, `Supplement ${n}`, '2026-02-05', 1800, 900)
  for (let n = 0; n < 40; n += 1) session.run(hw, `Problem set ${n}`, '2026-03-05', 3600, 3000)
  session.run(scioly, 'Bungee drop', '2025-04-05', 3600, 3600)
  db.prepare('INSERT INTO tags (name, project_id) VALUES (?, ?)').run('WRIT 0580', applications)
  db.prepare('INSERT INTO tags (name, project_id) VALUES (?, ?)').run('shared', applications)
  db.prepare('INSERT INTO tags (name, project_id) VALUES (?, ?)').run('shared', apps)

  const named = (id: number): string | null => {
    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as
      { name: string } | undefined
    return row?.name ?? null
  }
  const countSessions = (id: number): number =>
    Number(
      (
        db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(id) as {
          n: number
        }
      ).n
    )
  const countTags = (id: number): number =>
    Number(
      (db.prepare('SELECT COUNT(*) AS n FROM tags WHERE project_id = ?').get(id) as { n: number }).n
    )

  console.log('')
  console.log('--- the list ---')
  const list = listProjectsForAdmin()
  check(
    'every project is listed, including one with no sessions',
    list.length === 5,
    `${list.length}`
  )
  check(
    'a project with no sessions is there - the one that prompted this',
    list.some((row) => row.name === 'Entre' && row.sessions === 0),
    JSON.stringify(list.find((row) => row.name === 'Entre'))
  )
  check(
    'and it is most-used first',
    list[0].name === 'HW' && list[0].sessions === 40,
    `${list[0].name} ${list[0].sessions}`
  )
  check(
    'hours come from running time, not planned',
    Math.abs((list.find((row) => row.name === 'HW')?.hours ?? 0) - (40 * 3000) / 3600) < 1e-9,
    String(list.find((row) => row.name === 'HW')?.hours)
  )
  check(
    'tags are counted, because they decide whether Delete is offered',
    list.find((row) => row.name === 'College Applications')?.tags === 2
  )

  console.log('')
  console.log('--- rename ---')
  check('a plain rename succeeds', renameProject(scioly, 'Science Olympiad').ok)
  check('  and the row carries the new name', named(scioly) === 'Science Olympiad')
  check(
    '  with its session still attached, because the session points at the row',
    countSessions(scioly) === 1
  )
  const blank = renameProject(scioly, '   ')
  check('an empty name is refused', !blank.ok && 'reason' in blank, JSON.stringify(blank))
  check(
    'renaming to the same name is a no-op, not a conflict',
    renameProject(scioly, 'Science Olympiad').ok
  )
  check(
    'changing only the capitalisation of its own name is a rename',
    renameProject(scioly, 'Science olympiad').ok && named(scioly) === 'Science olympiad'
  )

  console.log('')
  console.log('--- rename onto a name that exists ---')
  const clash = renameProject(applications, 'College Apps')
  check(
    'it comes back as a merge to offer, not an error',
    !clash.ok && 'conflict' in clash,
    JSON.stringify(clash)
  )
  if (!clash.ok && 'conflict' in clash) {
    check('  naming the project it would merge into', clash.conflict.name === 'College Apps')
    check('  and how many sessions are already there', clash.conflict.sessions === 12)
  }
  const clashCase = renameProject(applications, 'college apps')
  check(
    'a name differing only in case is the same conflict, not a second project',
    !clashCase.ok && 'conflict' in clashCase,
    JSON.stringify(clashCase)
  )
  check('  and nothing was renamed', named(applications) === 'College Applications')

  console.log('')
  console.log('--- merge ---')
  const plan = planMerge(applications, apps)
  check(
    'the plan states what moves',
    plan?.sessions === 3 && plan?.tags === 2,
    JSON.stringify(plan)
  )
  check('merging a project into itself is refused', !mergeProjects(apps, apps).ok)
  check('the merge succeeds', mergeProjects(applications, apps).ok)
  check('  every session moved', countSessions(apps) === 15, String(countSessions(apps)))
  check('  the source row is gone', named(applications) === null)
  check(
    '  a tag moved with it',
    countTags(apps) === 2 &&
      (
        db.prepare('SELECT COUNT(*) AS n FROM tags WHERE name = ?').get('WRIT 0580') as {
          n: number
        }
      ).n === 1,
    `${countTags(apps)} tags on the target`
  )
  check(
    '  and a tag whose name was already on the target was dropped, not duplicated',
    Number(
      (db.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = 'shared'").get() as { n: number }).n
    ) === 1
  )
  check(
    '  no session was left pointing at nothing',
    Number(
      (
        db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id IS NULL').get() as {
          n: number
        }
      ).n
    ) === 0
  )

  console.log('')
  console.log('--- hide from suggestions ---')
  check(
    'Science olympiad is suggested while it is live',
    allProjectNames().includes('Science olympiad')
  )
  check('hiding it succeeds', setProjectArchived(scioly, true).ok)
  check('  it leaves the suggestions', !allProjectNames().includes('Science olympiad'))
  check('  its session is untouched', countSessions(scioly) === 1)
  check(
    '  and it is still listed here, so it can be brought back',
    listProjectsForAdmin().some((row) => row.name === 'Science olympiad' && row.archived)
  )
  /*
   * Snapping has to forget it too. `Scio` would otherwise be pulled into a
   * project the suggestions deny exists, which is a session filed somewhere
   * nothing on screen explains.
   */
  const scioHidden = findOrCreateProject('Science olympiadd')
  check(
    'a near miss no longer snaps to a hidden project',
    scioHidden !== scioly,
    `landed on ${named(scioHidden ?? -1)}`
  )
  db.prepare('DELETE FROM projects WHERE id = ?').run(scioHidden)
  /*
   * But the name itself still has to find the row: `UNIQUE` would refuse a
   * second one, and two rows with one name is the drift the whole app is
   * built to prevent.
   */
  const back = findOrCreateProject('Science olympiad')
  check(
    'typing the name exactly reuses the hidden row',
    back === scioly,
    `got ${back}, wanted ${scioly}`
  )
  check('  and brings it back', allProjectNames().includes('Science olympiad'))

  console.log('')
  console.log('--- delete ---')
  const refused = deleteProject(apps)
  check('a project with sessions is refused', !refused.ok && 'reason' in refused)
  if (!refused.ok && 'reason' in refused) {
    check(
      '  the refusal says how much is at stake',
      refused.reason.includes('15 session'),
      refused.reason
    )
    check(
      '  and points at merge and hide',
      refused.reason.includes('Merge') && refused.reason.includes('hide'),
      refused.reason
    )
  }
  check('  and nothing was deleted', named(apps) !== null && countSessions(apps) === 15)
  db.prepare('INSERT INTO tags (name, project_id) VALUES (?, ?)').run('only a tag', entre)
  const tagged = deleteProject(entre)
  check(
    'a project with only a tag is refused too',
    !tagged.ok && 'reason' in tagged,
    JSON.stringify(tagged)
  )
  db.prepare('DELETE FROM tags WHERE project_id = ?').run(entre)
  check('the empty project deletes', deleteProject(entre).ok)
  check('  and is gone from the list', !listProjectsForAdmin().some((row) => row.name === 'Entre'))
  check('deleting it again is refused rather than throwing', !deleteProject(entre).ok)

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})
