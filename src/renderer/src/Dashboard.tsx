import { useEffect, useState } from 'react'
import { ACCENTS, ACCENT_KEY, DEFAULT_ACCENT, isKnownAccent } from '@shared/accents'
import { acceleratorFromEvent, describeAccelerator } from '@shared/accelerator'
import { formatDurationInput, parseDurationMs } from '@shared/duration'

type Tab = 'settings' | 'data' | 'analytics' | 'import'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'settings', label: 'Settings' },
  { id: 'data', label: 'Data' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'import', label: 'Import' }
]

interface SessionRow {
  id: number
  task: string | null
  session_date: string | null
  started_at: string | null
  planned_duration_s: number
  running_duration_s: number
  work_quantity: number | null
  work_unit: string | null
  notes: string | null
  source: string
}

interface ImportPreview {
  totalRows: number
  importable: number
  skippedBlank: number
  skippedNoTiming: number
  totalHours: number
  firstDate: string
  lastDate: string
  projects: Array<{ name: string; sessions: number; hours: number }>
  units: Array<{ name: string; rows: number }>
}

function hours(seconds: number): string {
  return `${(seconds / 3600).toFixed(2)} h`
}

const SHORTCUTS: Array<{ id: string; label: string; hint: string }> = [
  {
    id: 'pause',
    label: 'Pause / resume',
    hint: 'The one that matters: writing full screen, reaching for the mouse breaks flow.'
  },
  { id: 'stop', label: 'Stop', hint: 'Ends the session. Undo is still offered afterwards.' },
  {
    id: 'newTimer',
    label: 'New timer window',
    hint: 'Opens a second timer for something running alongside.'
  }
]

function ShortcutField({
  label,
  hint,
  value,
  failed,
  onChange
}: {
  label: string
  hint: string
  value: string
  failed: boolean
  onChange: (accelerator: string) => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)

  return (
    <div className="shortcut">
      <div className="shortcut__text">
        <strong>{label}</strong>
        <em>{hint}</em>
      </div>
      <button
        className={`shortcut__key${capturing ? ' is-capturing' : ''}${failed ? ' is-failed' : ''}`}
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={(event) => {
          if (!capturing) return
          event.preventDefault()
          if (event.key === 'Escape') {
            setCapturing(false)
            return
          }
          if (event.key === 'Backspace' || event.key === 'Delete') {
            onChange('')
            setCapturing(false)
            return
          }
          const accelerator = acceleratorFromEvent(event)
          if (!accelerator) return
          onChange(accelerator)
          setCapturing(false)
        }}
      >
        {capturing ? 'Press keys…' : describeAccelerator(value)}
      </button>
    </div>
  )
}

function SettingsTab(): React.JSX.Element {
  const [accent, setAccent] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(ACCENT_KEY)
      return isKnownAccent(stored) ? stored : DEFAULT_ACCENT
    } catch {
      return DEFAULT_ACCENT
    }
  })
  const [loop, setLoop] = useState(true)
  const [autoEnd, setAutoEnd] = useState('180')
  const [shortcuts, setShortcuts] = useState<Record<string, string>>({})
  const [failures, setFailures] = useState<Record<string, boolean>>({})

  useEffect(() => {
    void window.api.timer.getLoop().then(setLoop)
    void window.api.timer.getAutoEnd().then((minutes) => setAutoEnd(String(minutes)))
    void window.api.shortcuts.get().then(setShortcuts)
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent)
  }, [accent])

  function chooseAccent(value: string): void {
    setAccent(value)
    document.documentElement.style.setProperty('--accent', value)
    try {
      localStorage.setItem(ACCENT_KEY, value)
      // localStorage does not notify the window that wrote it, so the timer is
      // told explicitly. Same origin, so it arrives as a storage event.
      window.dispatchEvent(new StorageEvent('storage', { key: ACCENT_KEY, newValue: value }))
    } catch {
      /* blocked storage: the colour applies but will not persist */
    }
  }

  function changeShortcut(id: string, accelerator: string): void {
    const next = { ...shortcuts, [id]: accelerator }
    setShortcuts(next)
    void window.api.shortcuts.set(next).then((results) => {
      setFailures(Object.fromEntries(Object.entries(results).map(([k, ok]) => [k, !ok])))
    })
  }

  return (
    <section className="panel">
      <h2>Timer</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={loop}
          onChange={(event) => {
            setLoop(event.target.checked)
            void window.api.timer.setLoop(event.target.checked)
          }}
        />
        <span>
          <strong>Loop</strong>
          <em>
            On expiry, start another run of the same length. Each pass is recorded as its own
            session.
          </em>
        </span>
      </label>

      <label className="field">
        <span>End a paused session after</span>
        <input
          value={autoEnd}
          onChange={(event) => {
            const next = event.target.value
            // Whole minutes only; empty is allowed so the field can be cleared.
            if (!/^\d{0,4}$/.test(next)) return
            setAutoEnd(next)
            if (next !== '') void window.api.timer.setAutoEnd(Number(next))
          }}
          inputMode="numeric"
        />
        <em>
          minutes. A backstop for a pause you forgot, not a limit on how long a break may be &mdash;
          the session ends at the moment it was paused, so time away is never counted. Zero switches
          it off.
        </em>
      </label>

      <h2 className="spaced">Keyboard shortcuts</h2>
      <p className="muted">
        System-wide, so they work without leaving whatever you are writing in. Click a binding and
        press the keys; Backspace clears it, Escape cancels.
      </p>
      {SHORTCUTS.map((entry) => (
        <ShortcutField
          key={entry.id}
          label={entry.label}
          hint={entry.hint}
          value={shortcuts[entry.id] ?? ''}
          failed={failures[entry.id] ?? false}
          onChange={(accelerator) => changeShortcut(entry.id, accelerator)}
        />
      ))}
      {Object.values(failures).some(Boolean) && (
        <p className="notice">
          A binding shown in red could not be registered &mdash; another application already owns
          that combination. Pick a different one.
        </p>
      )}

      <h2 className="spaced">Accent colour</h2>
      <p className="muted">
        Used for the ring, the progress fill and every control. Applies to the timer immediately.
      </p>
      <div className="swatches">
        {ACCENTS.map((option) => (
          <button
            key={option.value}
            className={`swatch-large${option.value === accent ? ' is-active' : ''}`}
            style={{ background: option.value }}
            onClick={() => chooseAccent(option.value)}
            title={option.name}
          >
            <span>{option.name}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function AnalyticsTab(): React.JSX.Element {
  return (
    <section className="panel">
      <h2>Analytics</h2>
      <p className="muted">Not built yet. Planned, in roughly this order:</p>
      <ul className="plan">
        <li>Total hours over time, this week against last</li>
        <li>Breakdown by project, and by task within a project</li>
        <li>Calendar heatmap, one cell per day</li>
        <li>Consistency and streaks</li>
        <li>
          Time-of-day heatmap &mdash; <strong>app-recorded sessions only</strong>, since imported
          rows have no clock times
        </li>
        <li>
          Rate trends, scoped to one unit at a time &mdash; words per minute and questions per
          minute are not comparable
        </li>
        <li>Planned against actual duration, and pace target against what happened</li>
      </ul>
    </section>
  )
}

interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

const EMPTY_HISTORY: HistoryState = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null
}

/** What the form edits. Timing is typed as a duration, not as raw seconds. */
interface FormState {
  session_date: string
  task: string
  planned: string
  actual: string
  work_quantity: string
  work_unit: string
  notes: string
}

function toForm(row: SessionRow | null): FormState {
  const today = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    session_date:
      row?.session_date ??
      `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    task: row?.task ?? '',
    planned: row ? formatDurationInput(row.planned_duration_s * 1000) : '',
    actual: row ? formatDurationInput(row.running_duration_s * 1000) : '',
    work_quantity: row?.work_quantity == null ? '' : String(row.work_quantity),
    work_unit: row?.work_unit ?? '',
    notes: row?.notes ?? ''
  }
}

function SessionForm({
  row,
  onSave,
  onCancel
}: {
  row: SessionRow | null
  onSave: (patch: Record<string, unknown>) => void
  onCancel: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<FormState>(() => toForm(row))

  const plannedMs = parseDurationMs(form.planned)
  const actualMs = parseDurationMs(form.actual)
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(form.session_date)
  const canSave = validDate && actualMs !== null

  function set<K extends keyof FormState>(key: K, value: string): void {
    setForm({ ...form, [key]: value })
  }

  return (
    <div className="editor">
      <h3>{row ? `Edit session ${row.id}` : 'Add a session'}</h3>
      <p className="muted">
        {row
          ? 'Changes apply to the row in place, and can be undone.'
          : 'For work that was not timed — a meeting entered afterwards. Recorded as a manual session, which time-of-day analytics will treat as approximate.'}
      </p>

      <div className="editor__grid">
        <label className="field field--inline">
          <span>Date</span>
          <input value={form.session_date} onChange={(e) => set('session_date', e.target.value)} />
        </label>
        <label className="field field--inline field--wide">
          <span>Task</span>
          <input value={form.task} onChange={(e) => set('task', e.target.value)} />
        </label>
        <label className="field field--inline">
          <span>Planned</span>
          <input
            value={form.planned}
            placeholder="1:00:00"
            onChange={(e) => set('planned', e.target.value)}
          />
        </label>
        <label className="field field--inline">
          <span>Actual</span>
          <input
            value={form.actual}
            placeholder="45:00"
            onChange={(e) => set('actual', e.target.value)}
          />
        </label>
        <label className="field field--inline">
          <span>Quantity</span>
          <input
            value={form.work_quantity}
            placeholder="340"
            onChange={(e) => {
              if (/^\d{0,7}(\.\d{0,2})?$/.test(e.target.value)) set('work_quantity', e.target.value)
            }}
          />
        </label>
        <label className="field field--inline">
          <span>Unit</span>
          <input
            value={form.work_unit}
            placeholder="words"
            onChange={(e) => set('work_unit', e.target.value.replace(/\d/g, ''))}
          />
        </label>
        <label className="field field--inline field--wide">
          <span>Notes</span>
          <input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
      </div>

      <div className="row">
        <button
          className="action action--primary"
          disabled={!canSave}
          onClick={() =>
            onSave({
              session_date: form.session_date,
              task: form.task.trim() === '' ? null : form.task.trim(),
              // Planned falls back to actual: a session entered from memory was
              // never planned, and a null there would break duration maths.
              planned_duration_s: Math.round((plannedMs ?? actualMs ?? 0) / 1000),
              running_duration_s: Math.round((actualMs ?? 0) / 1000),
              work_quantity: form.work_quantity === '' ? null : Number(form.work_quantity),
              work_unit: form.work_unit.trim() === '' ? null : form.work_unit.trim(),
              notes: form.notes.trim() === '' ? null : form.notes.trim(),
              ...(row ? {} : { source: 'manual' })
            })
          }
        >
          {row ? 'Save' : 'Add session'}
        </button>
        <button className="action" onClick={onCancel}>
          Cancel
        </button>
        {!canSave && <span className="muted">A date and an actual duration are required.</span>}
      </div>
    </div>
  )
}

interface SessionPage {
  rows: SessionRow[]
  total: number
  totalRunningS: number
  offset: number
  earliest: string | null
  latest: string | null
}

/** `null` is "show all" - the query reads a null limit as no limit. */
const PAGE_SIZES: Array<{ id: string; label: string; size: number | null }> = [
  { id: '50', label: '50', size: 50 },
  { id: '100', label: '100', size: 100 },
  { id: '250', label: '250', size: 250 },
  { id: 'all', label: 'All', size: null }
]

function DataTab(): React.JSX.Element {
  const [page, setPage] = useState<SessionPage | null>(null)
  const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
  const [editing, setEditing] = useState<SessionRow | 'new' | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sizeId, setSizeId] = useState('100')
  const [offset, setOffset] = useState(0)

  const limit = PAGE_SIZES.find((entry) => entry.id === sizeId)?.size ?? null

  async function refresh(): Promise<void> {
    const [next, state] = await Promise.all([
      window.api.sessions.query({ from: from || null, to: to || null, limit, offset }),
      window.api.history.state()
    ])
    const loaded = next as SessionPage
    // Deleting the last row of the last page would otherwise leave the view
    // sitting past the end of the results, showing an empty table.
    if (offset > 0 && loaded.total <= offset) setOffset(0)
    setPage(loaded)
    setHistory(state)
  }

  // Written as a promise chain rather than calling refresh(): the lint rule
  // cannot see that refresh awaits before it sets state, and reads the call as
  // a synchronous setState inside an effect.
  useEffect(() => {
    let live = true
    void Promise.all([
      window.api.sessions.query({ from: from || null, to: to || null, limit, offset }),
      window.api.history.state()
    ]).then(([next, state]) => {
      if (!live) return
      setPage(next as SessionPage)
      setHistory(state)
    })
    return () => {
      live = false
    }
  }, [from, to, limit, offset])

  // Any change to what is being shown returns to the first page. Staying on
  // page 14 of a range that now has three pages shows nothing at all.
  function setRange(nextFrom: string, nextTo: string): void {
    setFrom(nextFrom)
    setTo(nextTo)
    setOffset(0)
  }

  async function save(patch: Record<string, unknown>): Promise<void> {
    if (editing === 'new') await window.api.sessions.create(patch)
    else if (editing) await window.api.sessions.update(editing.id, patch)
    setEditing(null)
    await refresh()
  }

  async function remove(row: SessionRow): Promise<void> {
    const confirmed = await window.api.ui.confirm({
      title: 'Delete session',
      message: `Delete ${row.task ?? 'this unlabelled session'}?`,
      detail: `${row.session_date ?? 'no date'} · ${hours(row.running_duration_s)} recorded.

This can be undone.`,
      confirmLabel: 'Delete'
    })
    if (!confirmed) return

    // Imported rows are asked about twice. They are 3.5 years of history the
    // app did not record and cannot reconstruct, sitting in the same table as
    // a session from ten minutes ago with the same Delete button beside them.
    // It is the one place where a misclick costs something that did not come
    // from this app.
    if (row.source === 'import') {
      const again = await window.api.ui.confirm({
        title: 'This row came from the spreadsheet',
        message: 'Delete imported history?',
        detail: `${row.session_date ?? 'no date'} · ${row.task ?? 'unlabelled'}

Undo brings it back, and so does re-importing the CSV — but re-importing replaces every imported row, so it would discard any edits made to the others.`,
        confirmLabel: 'Delete imported row'
      })
      if (!again) return
    }

    const id = row.id
    await window.api.sessions.remove(id)
    if (editing !== 'new' && editing?.id === id) setEditing(null)
    await refresh()
  }

  async function step(direction: 'undo' | 'redo'): Promise<void> {
    await (direction === 'undo' ? window.api.history.undo() : window.api.history.redo())
    setEditing(null)
    await refresh()
  }

  if (page === null) return <section className="panel">Loading…</section>

  const { rows, total, totalRunningS, earliest, latest } = page
  const filtered = from !== '' || to !== ''
  const firstShown = total === 0 ? 0 : offset + 1
  const lastShown = Math.min(offset + rows.length, total)
  const pageCount = limit === null ? 1 : Math.max(1, Math.ceil(total / limit))
  const pageNumber = limit === null ? 1 : Math.floor(offset / limit) + 1

  return (
    <section className="panel">
      <h2>Sessions</h2>
      <p className="muted">
        {total === 0
          ? filtered
            ? 'No sessions in that date range.'
            : 'Nothing recorded yet. Run a timer and stop it, add one by hand, or bring in the spreadsheet from the Import tab.'
          : `${firstShown.toLocaleString()}–${lastShown.toLocaleString()} of ${total.toLocaleString()} · ${hours(totalRunningS)} in range`}
      </p>

      <div className="row filters">
        <label className="filter-field">
          <span>From</span>
          <input
            type="date"
            value={from}
            min={earliest ?? undefined}
            max={latest ?? undefined}
            onChange={(event) => setRange(event.target.value, to)}
          />
        </label>
        <label className="filter-field">
          <span>To</span>
          <input
            type="date"
            value={to}
            min={earliest ?? undefined}
            max={latest ?? undefined}
            onChange={(event) => setRange(from, event.target.value)}
          />
        </label>
        <button className="action" disabled={!filtered} onClick={() => setRange('', '')}>
          Clear
        </button>
        {earliest && latest && (
          <span className="muted">
            recorded {earliest} to {latest}
          </span>
        )}
      </div>

      {/* Above the table, not below it: "All" runs to thousands of rows, and a
          pager at the bottom of that is a pager nobody reaches. */}
      <div className="row pager">
        <span className="muted">Rows</span>
        <div className="pager__sizes">
          {PAGE_SIZES.map((entry) => (
            <button
              key={entry.id}
              className={entry.id === sizeId ? 'is-active' : ''}
              onClick={() => {
                setSizeId(entry.id)
                setOffset(0)
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {limit !== null && total > limit && (
          <>
            <button
              className="action"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              Previous
            </button>
            <span className="muted">
              page {pageNumber} of {pageCount.toLocaleString()}
            </span>
            <button
              className="action"
              disabled={offset + limit >= total}
              onClick={() => setOffset(offset + limit)}
            >
              Next
            </button>
          </>
        )}
      </div>

      <div className="row">
        <button className="action action--primary" onClick={() => setEditing('new')}>
          Add session
        </button>
        <button
          className="action"
          disabled={!history.canUndo}
          onClick={() => void step('undo')}
          title={history.undoLabel ? `Undo ${history.undoLabel}` : 'Nothing to undo'}
        >
          Undo
        </button>
        <button
          className="action"
          disabled={!history.canRedo}
          onClick={() => void step('redo')}
          title={history.redoLabel ? `Redo ${history.redoLabel}` : 'Nothing to redo'}
        >
          Redo
        </button>
        {history.canUndo && <span className="muted">last: {history.undoLabel}</span>}
      </div>

      {editing !== null && (
        <SessionForm
          row={editing === 'new' ? null : editing}
          onSave={(patch) => void save(patch)}
          onCancel={() => setEditing(null)}
        />
      )}

      {rows.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>Date</th>
              <th>Task</th>
              <th className="num">Planned</th>
              <th className="num">Actual</th>
              <th className="num">Output</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={editing !== 'new' && editing?.id === row.id ? 'is-editing-row' : ''}
              >
                <td>{row.session_date ?? '—'}</td>
                <td>{row.task ?? <span className="muted">unlabelled</span>}</td>
                <td className="num">{hours(row.planned_duration_s)}</td>
                <td className="num">{hours(row.running_duration_s)}</td>
                <td className="num">
                  {row.work_quantity == null ? '—' : `${row.work_quantity} ${row.work_unit ?? ''}`}
                </td>
                <td>
                  <span className={`badge badge--${row.source}`}>{row.source}</span>
                </td>
                <td className="row-actions">
                  <button onClick={() => setEditing(row)} title="Edit">
                    Edit
                  </button>
                  <button
                    className="row-actions__danger"
                    onClick={() => void remove(row)}
                    title="Delete — undoable"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function ImportTab(): React.JSX.Element {
  const [file, setFile] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [existing, setExisting] = useState(0)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    void window.api.importer.existingCount().then(setExisting)
  }, [done])

  async function pick(): Promise<void> {
    const chosen = await window.api.importer.pickFile()
    if (!chosen) return
    setBusy(true)
    setDone(null)
    setFile(chosen)
    setPreview((await window.api.importer.preview(chosen)) as ImportPreview)
    setBusy(false)
  }

  /**
   * The failure path matters more than the happy one here. An unhandled
   * rejection left `busy` true forever, so a failed import looked exactly like
   * a disabled button and reported nothing - the import silently never
   * happened and the Data tab stayed empty with no explanation.
   */
  async function commit(): Promise<void> {
    if (!file) return
    setBusy(true)
    setFailed(null)
    try {
      const result = (await window.api.importer.commit(file)) as {
        sessions: number
        projectsCreated: number
        replaced: number
      }
      setDone(
        `Imported ${result.sessions.toLocaleString()} sessions across ${result.projectsCreated} new projects` +
          (result.replaced > 0
            ? `, replacing ${result.replaced.toLocaleString()} from a previous import.`
            : '.')
      )
    } catch (error) {
      setFailed(`Nothing was imported. ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2>Import the spreadsheet</h2>
      <p className="muted">
        Reads the CSV export. Start and End are read as countdown readings, not clock times, so
        durations come across exactly while time of day does not &mdash; imported sessions carry a
        date but no clock time, and time-of-day analytics will exclude them.
      </p>

      {existing > 0 && (
        <p className="notice">
          {existing.toLocaleString()} imported sessions are already in the database. Importing again
          replaces them rather than adding a second copy.
        </p>
      )}

      <div className="row">
        <button className="action" onClick={() => void pick()} disabled={busy}>
          Choose CSV…
        </button>
        {file && <span className="muted mono">{file}</span>}
      </div>

      {preview && (
        <>
          <div className="stats">
            <div>
              <strong>{preview.importable.toLocaleString()}</strong>
              <span>sessions</span>
            </div>
            <div>
              <strong>{preview.totalHours.toFixed(1)}</strong>
              <span>hours</span>
            </div>
            <div>
              <strong>{preview.projects.length}</strong>
              <span>projects</span>
            </div>
            <div>
              <strong>
                {preview.firstDate} → {preview.lastDate}
              </strong>
              <span>range</span>
            </div>
          </div>

          <p className="muted">
            {preview.totalRows.toLocaleString()} rows read &middot;{' '}
            {preview.skippedBlank.toLocaleString()} blank or rest days &middot;{' '}
            {preview.skippedNoTiming.toLocaleString()} without usable timings
          </p>

          <div className="row">
            <button
              className="action action--primary"
              onClick={() => void commit()}
              disabled={busy}
            >
              {existing > 0 ? 'Replace import' : 'Import'}
            </button>
          </div>

          <h3>Projects</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">Sessions</th>
                <th className="num">Hours</th>
              </tr>
            </thead>
            <tbody>
              {preview.projects.map((project) => (
                <tr key={project.name}>
                  <td>{project.name}</td>
                  <td className="num">{project.sessions.toLocaleString()}</td>
                  <td className="num">{project.hours.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {done && <p className="notice notice--good">{done}</p>}
      {failed && <p className="notice notice--bad">{failed}</p>}
    </section>
  )
}

export default function Dashboard(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('settings')

  useEffect(() => {
    try {
      const stored = localStorage.getItem(ACCENT_KEY)
      document.documentElement.style.setProperty(
        '--accent',
        isKnownAccent(stored) ? stored : DEFAULT_ACCENT
      )
    } catch {
      /* storage blocked; the default accent still applies */
    }
  }, [])

  return (
    <div className="dashboard">
      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className={`tab${entry.id === tab ? ' is-active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <main className="dashboard__body">
        {tab === 'settings' && <SettingsTab />}
        {tab === 'data' && <DataTab />}
        {tab === 'analytics' && <AnalyticsTab />}
        {tab === 'import' && <ImportTab />}
      </main>
    </div>
  )
}
