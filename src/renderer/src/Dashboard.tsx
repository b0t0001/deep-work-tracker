import { useEffect, useState } from 'react'
import { ACCENTS, ACCENT_KEY, DEFAULT_ACCENT, isKnownAccent } from '@shared/accents'
import { parseDurationMs } from '@shared/duration'

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

function SettingsTab(): React.JSX.Element {
  const [accent, setAccent] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(ACCENT_KEY)
      return isKnownAccent(stored) ? stored : DEFAULT_ACCENT
    } catch {
      return DEFAULT_ACCENT
    }
  })

  function choose(value: string): void {
    setAccent(value)
    document.documentElement.style.setProperty('--accent', value)
    try {
      localStorage.setItem(ACCENT_KEY, value)
      // localStorage does not notify the window that wrote it, so the timer is
      // told explicitly. Same origin, so it receives this as a storage event.
      window.dispatchEvent(new StorageEvent('storage', { key: ACCENT_KEY, newValue: value }))
    } catch {
      /* blocked storage: the colour applies but will not persist */
    }
  }

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent)
  }, [accent])

  const [loop, setLoop] = useState(true)
  const [autoEnd, setAutoEnd] = useState('15')
  const [paceInterval, setPaceInterval] = useState('')
  const [paceQuantity, setPaceQuantity] = useState('')
  const [paceUnit, setPaceUnit] = useState('')

  useEffect(() => {
    void window.api.timer.getLoop().then(setLoop)
    void window.api.timer.getAutoEnd().then((minutes) => setAutoEnd(String(minutes)))
    void window.api.timer.getPace().then((config) => {
      if (!config) return
      setPaceInterval(String(Math.round(config.intervalMs / 60_000)))
      setPaceQuantity(config.quantity === null ? '' : String(config.quantity))
      setPaceUnit(config.unit ?? '')
    })
  }, [])

  /** An interval with no number is not a pace loop, so it is switched off. */
  function applyPace(interval: string, quantity: string, unit: string): void {
    const intervalMs = parseDurationMs(interval)
    void window.api.timer.setPace(
      intervalMs === null
        ? null
        : {
            intervalMs,
            quantity: quantity.trim() === '' ? null : Number(quantity),
            unit: unit.trim() === '' ? null : unit.trim()
          }
    )
  }

  function toggleLoop(value: boolean): void {
    setLoop(value)
    void window.api.timer.setLoop(value)
  }

  return (
    <section className="panel">
      <h2>Timer</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={loop}
          onChange={(event) => toggleLoop(event.target.checked)}
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
          minutes. Pausing and walking away is easy to forget; the session ends at the moment it was
          paused, so time away is never counted. Zero switches this off.
        </em>
      </label>

      <h2 className="spaced">Pace loop</h2>
      <p className="muted">
        A second timer running alongside the session. Every interval it plays a quiet cue and shows
        what should be done by now &mdash; &ldquo;100 words per 20 minutes&rdquo; reads{' '}
        <em>target 300 words</em> on the third loop. It never asks you to type anything; quantity is
        entered once, at stop.
      </p>
      <div className="pace-row">
        <label className="field field--inline">
          <span>Every</span>
          <input
            value={paceInterval}
            placeholder="20"
            onChange={(event) => {
              setPaceInterval(event.target.value)
              applyPace(event.target.value, paceQuantity, paceUnit)
            }}
          />
        </label>
        <label className="field field--inline">
          <span>Target</span>
          <input
            value={paceQuantity}
            placeholder="100"
            inputMode="numeric"
            onChange={(event) => {
              setPaceQuantity(event.target.value)
              applyPace(paceInterval, event.target.value, paceUnit)
            }}
          />
        </label>
        <label className="field field--inline">
          <span>Unit</span>
          <input
            value={paceUnit}
            placeholder="words"
            onChange={(event) => {
              setPaceUnit(event.target.value)
              applyPace(paceInterval, paceQuantity, event.target.value)
            }}
          />
        </label>
      </div>
      <p className="muted">
        The interval reads the same forms as the clock: <code>20</code>, <code>3 min</code>,
        <code>90 sec</code>. Clearing it switches the pace loop off.
      </p>

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
            onClick={() => choose(option.value)}
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
