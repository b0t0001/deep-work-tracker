import { useEffect, useState } from 'react'
import { ACCENTS, ACCENT_KEY, DEFAULT_ACCENT, isKnownAccent } from '@shared/accents'
import { acceleratorFromEvent, describeAccelerator } from '@shared/accelerator'

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
            setAutoEnd(event.target.value)
            const minutes = Number(event.target.value)
            if (Number.isFinite(minutes)) void window.api.timer.setAutoEnd(minutes)
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

function DataTab(): React.JSX.Element {
  const [rows, setRows] = useState<SessionRow[] | null>(null)

  useEffect(() => {
    void window.api.sessions.recent(200).then((result) => setRows(result as SessionRow[]))
  }, [])

  if (rows === null) return <section className="panel">Loading…</section>

  if (rows.length === 0) {
    return (
      <section className="panel">
        <h2>Sessions</h2>
        <p className="muted">
          Nothing recorded yet. Run a timer and stop it, or bring in the spreadsheet from the Import
          tab.
        </p>
      </section>
    )
  }

  const total = rows.reduce((sum, row) => sum + row.running_duration_s, 0)

  return (
    <section className="panel">
      <h2>Sessions</h2>
      <p className="muted">
        {rows.length} most recent &middot; {hours(total)} in view
      </p>
      <table className="grid">
        <thead>
          <tr>
            <th>Date</th>
            <th>Task</th>
            <th className="num">Planned</th>
            <th className="num">Actual</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.session_date ?? '—'}</td>
              <td>{row.task ?? <span className="muted">unlabelled</span>}</td>
              <td className="num">{hours(row.planned_duration_s)}</td>
              <td className="num">{hours(row.running_duration_s)}</td>
              <td>
                <span className={`badge badge--${row.source}`}>{row.source}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function ImportTab(): React.JSX.Element {
  const [file, setFile] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [existing, setExisting] = useState(0)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

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

  async function commit(): Promise<void> {
    if (!file) return
    setBusy(true)
    const result = (await window.api.importer.commit(file)) as {
      sessions: number
      projectsCreated: number
      replaced: number
    }
    setBusy(false)
    setDone(
      `Imported ${result.sessions.toLocaleString()} sessions across ${result.projectsCreated} new projects` +
        (result.replaced > 0
          ? `, replacing ${result.replaced.toLocaleString()} from a previous import.`
          : '.')
    )
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

          <div className="row">
            <button
              className="action action--primary"
              onClick={() => void commit()}
              disabled={busy}
            >
              {existing > 0 ? 'Replace import' : 'Import'}
            </button>
          </div>
        </>
      )}

      {done && <p className="notice notice--good">{done}</p>}
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
