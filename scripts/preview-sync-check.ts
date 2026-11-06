/**
 * Exercises `syncPreview` against throwaway copies of a real history.
 *
 * Run:
 *   npx esbuild scripts/preview-sync-check.ts --bundle --platform=node --format=cjs \
 *     --target=node22 --external:node:sqlite --outfile=out/checks/preview-sync.js \
 *     && node out/checks/preview-sync.js <a copy of deepwork.db>
 *
 * Point it at a **copy** - a backup or a Recovery file - never at the live
 * profile. Every case copies that file three times into a temp folder (the
 * baseline the preview started from, the preview, and the "real" history),
 * changes them as a user would, and checks what the sync did. The source file
 * is only ever read.
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { syncPreview, SyncRefused, type SyncReport } from './preview-sync'

const source = process.argv[2]
if (source === undefined || !existsSync(source)) {
  console.error('usage: node preview-sync.js <a copy of deepwork.db>')
  process.exit(2)
}
const appData = process.env['APPDATA'] ?? ''
if (appData !== '' && resolve(source).toLowerCase().startsWith(resolve(appData).toLowerCase())) {
  console.error('Refusing to run against a file under APPDATA - pass a copy, not a live profile.')
  process.exit(2)
}

let pass = 0
let fail = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass += 1
  else fail += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok)
    console.log(`        expected ${JSON.stringify(expected)}  actual ${JSON.stringify(actual)}`)
}

const root = mkdtempSync(join(tmpdir(), 'dwt-sync-check-'))
let caseNo = 0

interface Case {
  base: string
  prev: string
  real: string
  backup: string
  sql(file: string, statement: string, ...params: Array<string | number | null>): void
  get<T>(file: string, query: string, ...params: Array<string | number | null>): T
  sync(withBaseline?: boolean): SyncReport
  digest(file: string): string
}

function fresh(): Case {
  caseNo += 1
  const dir = join(root, `case-${caseNo}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir)
  const c: Case = {
    base: join(dir, 'base.db'),
    prev: join(dir, 'prev.db'),
    real: join(dir, 'real.db'),
    backup: join(dir, 'real-before.db'),
    sql(file, statement, ...params) {
      const db = new DatabaseSync(file)
      try {
        db.exec('PRAGMA foreign_keys = ON')
        db.prepare(statement).run(...params)
      } finally {
        db.close()
      }
    },
    get<T>(file: string, query: string, ...params: Array<string | number | null>): T {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        return db.prepare(query).get(...params) as T
      } finally {
        db.close()
      }
    },
    sync(withBaseline = true) {
      rmSync(c.backup, { force: true })
      return syncPreview({
        baseline: withBaseline ? c.base : null,
        preview: c.prev,
        real: c.real,
        backupTo: c.backup
      })
    },
    digest(file) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const all = ['sessions', 'pauses', 'projects'].map((t) =>
          db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()
        )
        return createHash('sha256').update(JSON.stringify(all)).digest('hex').slice(0, 16)
      } finally {
        db.close()
      }
    }
  }
  for (const f of [c.base, c.prev, c.real]) copyFileSync(source!, f)
  return c
}

const maxId = (c: Case, file: string): number =>
  c.get<{ n: number }>(file, 'SELECT MAX(id) n FROM sessions').n
const count = (c: Case, file: string): number =>
  c.get<{ n: number }>(file, 'SELECT COUNT(*) n FROM sessions').n
const projectOf = (c: Case, file: string, id: number): string | null =>
  c.get<{ name: string | null } | undefined>(
    file,
    'SELECT p.name FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?',
    id
  )?.name ?? null
const taskOf = (c: Case, file: string, id: number): string | null | undefined =>
  c.get<{ task: string | null } | undefined>(file, 'SELECT task FROM sessions WHERE id = ?', id)
    ?.task

const ADD = `INSERT INTO sessions (project_id, task, session_date, started_at, ended_at,
  planned_duration_s, running_duration_s, source)
  VALUES ((SELECT id FROM projects WHERE name = ?), ?, '2026-11-06', ?, ?, 5400, ?, ?)`

// A row from the middle of the history to edit and delete.
const probe = (c: Case): number =>
  c.get<{ id: number }>(
    c.base,
    "SELECT id FROM sessions WHERE source = 'import' ORDER BY id LIMIT 1 OFFSET 100"
  ).id

// ---- 1. An added session is carried, under a fresh id, with its pause.
{
  const c = fresh()
  const top = maxId(c, c.real)
  // The installed app writes a session meanwhile, taking the id the preview also used.
  c.sql(c.real, ADD, 'HW', 'written in the desktop app', null, null, 600, 'manual')
  c.sql(
    c.prev,
    ADD,
    'HW',
    'MATH 1410',
    '2026-11-06T02:00:00.000Z',
    '2026-11-06T03:30:00.000Z',
    5000,
    'app'
  )
  c.sql(
    c.prev,
    `INSERT INTO pauses (session_id, paused_at, resumed_at) VALUES (?, '2026-11-06T02:30:00.000Z', '2026-11-06T02:36:40.000Z')`,
    top + 1
  )
  const r = c.sync()
  eq('add: one session reported added', r.added.length, 1)
  eq('add: given a fresh id, not the preview one the desktop app took', r.added[0]?.realId, top + 2)
  eq(
    'add: the desktop app row is untouched',
    taskOf(c, c.real, top + 1),
    'written in the desktop app'
  )
  eq(
    'add: carried with its task and project',
    [taskOf(c, c.real, top + 2), projectOf(c, c.real, top + 2)],
    ['MATH 1410', 'HW']
  )
  eq(
    'add: its pause came with it',
    c.get<{ n: number }>(c.real, 'SELECT COUNT(*) n FROM pauses WHERE session_id = ?', top + 2).n,
    1
  )
  eq('add: a backup was written first', existsSync(c.backup), true)

  // ---- 6. Re-running the same copy adds nothing.
  const before = c.digest(c.real)
  const again = c.sync()
  eq('re-run: nothing added twice', [again.added.length, again.alreadyThere.length], [0, 1])
  eq('re-run: real history unchanged', c.digest(c.real), before)
}

// ---- 2. An edit is carried when the real row has not changed.
{
  const c = fresh()
  const id = probe(c)
  c.sql(
    c.prev,
    'UPDATE sessions SET task = ?, work_quantity = 12, work_unit = ? WHERE id = ?',
    'edited in preview',
    'questions',
    id
  )
  const r = c.sync()
  eq('edit: reported edited', r.edited.length, 1)
  eq('edit: applied to the real row', taskOf(c, c.real, id), 'edited in preview')
}

// ---- 3. An edit is a conflict when the real row changed too.
{
  const c = fresh()
  const id = probe(c)
  c.sql(c.prev, 'UPDATE sessions SET task = ? WHERE id = ?', 'preview version', id)
  c.sql(c.real, 'UPDATE sessions SET task = ? WHERE id = ?', 'desktop version', id)
  const r = c.sync()
  eq('conflict: reported, not applied', [r.conflicts.length, r.edited.length], [1, 0])
  eq('conflict: the desktop version is kept', taskOf(c, c.real, id), 'desktop version')
}

// ---- 4. A delete is carried; 5. a delete of a row changed in the desktop app is not.
{
  const c = fresh()
  const id = probe(c)
  c.sql(c.prev, 'DELETE FROM sessions WHERE id = ?', id)
  const r = c.sync()
  eq('delete: reported deleted', r.deleted.length, 1)
  eq('delete: gone from the real history', taskOf(c, c.real, id), undefined)
}
{
  const c = fresh()
  const id = probe(c)
  c.sql(c.prev, 'DELETE FROM sessions WHERE id = ?', id)
  c.sql(c.real, 'UPDATE sessions SET notes = ? WHERE id = ?', 'changed in the desktop app', id)
  const r = c.sync()
  eq('delete conflict: reported, not applied', [r.conflicts.length, r.deleted.length], [1, 0])
  eq('delete conflict: the real row survives', count(c, c.real), count(c, c.base))
}

// ---- 7. A project new in the preview is created by name.
{
  const c = fresh()
  const projects = c.get<{ n: number }>(c.real, 'SELECT COUNT(*) n FROM projects').n
  c.sql(c.prev, "INSERT INTO projects (name, color) VALUES ('Penn Electric Racing', '#ff0000')")
  c.sql(c.prev, ADD, 'Penn Electric Racing', 'club meeting', null, null, 21600, 'manual')
  const r = c.sync()
  eq(
    'new project: created once',
    c.get<{ n: number }>(c.real, 'SELECT COUNT(*) n FROM projects').n,
    projects + 1
  )
  eq(
    'new project: the session is filed under it',
    projectOf(c, c.real, r.added[0]!.realId!),
    'Penn Electric Racing'
  )
}

// ---- 8. The same project id naming different projects is not an edit.
{
  const c = fresh()
  c.sql(c.prev, "INSERT INTO projects (name) VALUES ('Alpha')")
  c.sql(c.real, "INSERT INTO projects (name) VALUES ('Beta')")
  eq(
    'id collision: both new projects took the same id',
    c.get<{ id: number }>(c.prev, "SELECT id FROM projects WHERE name = 'Alpha'").id,
    c.get<{ id: number }>(c.real, "SELECT id FROM projects WHERE name = 'Beta'").id
  )
  c.sql(c.prev, ADD, 'Alpha', 'alpha work', null, null, 900, 'manual')
  const r = c.sync()
  eq('id collision: no edits or conflicts invented', [r.edited.length, r.conflicts.length], [0, 0])
  eq(
    'id collision: filed under Alpha, not Beta',
    projectOf(c, c.real, r.added[0]!.realId!),
    'Alpha'
  )
}

// ---- 9. Too many changes is refused, and nothing is written.
{
  const c = fresh()
  c.sql(
    c.prev,
    "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE source = 'import' ORDER BY id LIMIT 60)"
  )
  const before = c.digest(c.real)
  let refused = false
  try {
    c.sync()
  } catch (error) {
    refused = error instanceof SyncRefused
  }
  eq('threshold: refused', refused, true)
  eq('threshold: real history unchanged', c.digest(c.real), before)
  eq('threshold: no backup needed, none written', existsSync(c.backup), false)
}

// ---- 10. A preview from before baselines: test rows carried, already-copied ones recognized.
{
  const c = fresh()
  const top = maxId(c, c.real)
  // What the 2026-11-06 preview held: rows marked test...
  c.sql(
    c.prev,
    ADD,
    'HW',
    'MATH 1410',
    '2026-11-06T02:00:00.000Z',
    '2026-11-06T03:30:00.000Z',
    5400,
    'test'
  )
  c.sql(c.prev, ADD, null, 'Study for MATH 1410', null, null, 4815, 'test')
  // ...the first already copied into the real history by hand, as app.
  c.sql(
    c.real,
    ADD,
    'HW',
    'MATH 1410',
    '2026-11-06T02:00:00.000Z',
    '2026-11-06T03:30:00.000Z',
    5400,
    'app'
  )
  const r = c.sync(false)
  eq(
    'legacy: one already there, one added',
    [r.alreadyThere.length, r.added.length, r.legacy],
    [1, 1, true]
  )
  eq(
    'legacy: the untimed one becomes manual',
    c.get<{ source: string }>(
      c.real,
      'SELECT source FROM sessions WHERE id = ?',
      r.added[0]!.realId!
    ).source,
    'manual'
  )
  eq('legacy: nothing else counted as a change', [r.edited.length, r.deleted.length], [0, 0])
  eq('legacy: the hand-copied row is untouched', taskOf(c, c.real, top + 1), 'MATH 1410')
}

// ---- 11. A failure part-way rolls everything back.
{
  const c = fresh()
  const id = probe(c)
  c.sql(
    c.real,
    "CREATE TRIGGER boom BEFORE INSERT ON sessions WHEN NEW.task = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END"
  )
  c.sql(c.prev, 'UPDATE sessions SET task = ? WHERE id = ?', 'edit before the failure', id)
  c.sql(c.prev, ADD, 'HW', 'fine', null, null, 600, 'manual')
  c.sql(c.prev, ADD, 'HW', 'boom', null, null, 600, 'manual')
  const before = c.digest(c.real)
  let threw = false
  try {
    c.sync()
  } catch {
    threw = true
  }
  eq('rollback: the failure surfaced', threw, true)
  eq('rollback: real history exactly as before', c.digest(c.real), before)
}

// ---- 12. Pauses changed on an existing session are carried.
{
  const c = fresh()
  const id = probe(c)
  c.sql(
    c.prev,
    `INSERT INTO pauses (session_id, paused_at, resumed_at) VALUES (?, '2026-01-01T10:00:00.000Z', '2026-01-01T10:05:00.000Z')`,
    id
  )
  const r = c.sync()
  eq('pauses: counted as an edit', r.edited.length, 1)
  eq(
    'pauses: carried',
    c.get<{ n: number }>(c.real, 'SELECT COUNT(*) n FROM pauses WHERE session_id = ?', id).n,
    1
  )
}

// ---- 13. Nothing changed: nothing written, not even a backup.
{
  const c = fresh()
  const before = c.digest(c.real)
  const r = c.sync()
  eq(
    'no change: empty report',
    r.added.length + r.edited.length + r.deleted.length + r.conflicts.length,
    0
  )
  eq('no change: no backup written', existsSync(c.backup), false)
  eq('no change: real history unchanged', c.digest(c.real), before)
}

// ---- 14. An old preview's `test` mark does not ride on an edit; a deliberate change does.
{
  const c = fresh()
  const top = maxId(c, c.real)
  // The 2026-11-06 shape: a test row in the old preview, copied by hand as
  // app, then given a baseline - and now edited in the preview.
  for (const [file, source] of [
    [c.base, 'test'],
    [c.prev, 'test'],
    [c.real, 'app']
  ] as const)
    c.sql(file, ADD, 'HW', 'MATH 1410', '2026-11-06T02:00:00.000Z', null, 5400, source)
  c.sql(
    c.prev,
    'UPDATE sessions SET work_quantity = 9, work_unit = ? WHERE id = ?',
    'questions',
    top + 1
  )
  const id = probe(c)
  c.sql(c.prev, "UPDATE sessions SET source = 'manual' WHERE id = ?", id)
  const r = c.sync()
  eq('source: both edits carried', r.edited.length, 2)
  eq(
    'source: the hand-copied row keeps app, gains its quantity',
    c.get<{ source: string; q: number }>(
      c.real,
      'SELECT source, work_quantity q FROM sessions WHERE id = ?',
      top + 1
    ),
    { source: 'app', q: 9 }
  )
  eq(
    'source: a source changed in the preview is carried',
    c.get<{ source: string }>(c.real, 'SELECT source FROM sessions WHERE id = ?', id).source,
    'manual'
  )
}

rmSync(root, { recursive: true, force: true })
console.log('')
console.log(`preview-sync: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
