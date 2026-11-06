import { useEffect, useState } from 'react'
import { ACCENTS, ACCENT_KEY, DEFAULT_ACCENT, isKnownAccent } from '@shared/accents'
import { acceleratorFromEvent, describeAccelerator } from '@shared/accelerator'
import { formatDurationInput, parseDurationMs } from '@shared/duration'
import type { Analytics } from '@shared/analytics'
import { buildFacts, pickFact, type Fact } from '@shared/facts'
import {
  aboveBaseline,
  averagePerDay,
  baseline,
  windowRange,
  type Range,
  type WindowId
} from '@shared/windows'
import { formatDate, formatDateRange, formatDateTime } from '@shared/dates'
import { rankProjects } from '@shared/projects'
import {
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  SECTIONS,
  rangeFor,
  sectionOf,
  visiblePanels,
  withRange,
  type Layout,
  type PanelId,
  type RangeTargetId
} from '@shared/layout'
import {
  hourTotalsIn,
  plannedVsActualIn,
  projectTotalsIn,
  unitTotalsIn,
  within
} from '@shared/ranges'
import Icon from './components/Icon'
import { useLayout } from './lib/layout'
import { useAccentSync } from './lib/accent'
import {
  ByProject,
  HoursOverTime,
  PaceAccuracy,
  PlannedVsActual,
  RateTrend
} from './components/AnalyticsCharts'
import { CalendarHeatmap, TimeOfDayHeatmap } from './components/Heatmaps'
import { PreviewBanner } from './components/PreviewBanner'
import { RangePicker } from './components/RangePicker'
import { CompareBox } from './components/CompareBox'

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
  project_name: string | null
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
    /*
     * Four groups in a responsive grid rather than one tall column.
     *
     * The user's report was that widening the window left the content where
     * it was - "expanding the settings window should resize all the
     * information on all the tabs". Lifting the panel's width cap is half the
     * answer and on its own it makes this tab worse, not better: a toggle, a
     * numeric field and three key bindings stretched across 1900px are a few
     * short controls with a metre of empty row beside each.
     *
     * So the column count follows the width. `auto-fit` with a 340px minimum
     * gives one column on the narrow window the dashboard opens at, two at
     * about 1150, and three or four on a wide screen - and it does it from the
     * width actually available rather than from a breakpoint guessed at here.
     */
    <section className="panel">
      <div className="set-grid">
        <div className="set-group">
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
              minutes. A backstop for a pause you forgot, not a limit on how long a break may be
              &mdash; the session ends at the moment it was paused, so time away is never counted.
              Zero switches it off.
            </em>
          </label>
        </div>

        <div className="set-group">
          <h2>Keyboard shortcuts</h2>
          <p className="muted">
            System-wide, so they work without leaving whatever you are writing in. Click a binding
            and press the keys; Backspace clears it, Escape cancels.
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
              A binding shown in red could not be registered &mdash; another application already
              owns that combination. Pick a different one.
            </p>
          )}
        </div>

        <div className="set-group">
          <h2>Accent color</h2>
          <p className="muted">
            Used for the ring, the progress fill and every control. Applies to the timer
            immediately.
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
        </div>
      </div>

      {/* Outside the grid, not spanning it.
          
          It wants the whole width - it is a directory path, a schedule and a
          table of eight files - and `grid-column: 1 / -1` looked like the way
          to say that. It is not: `auto-fit` only collapses tracks that are
          **empty**, and a group spanning every track leaves none empty, so at
          1900px the grid kept five 360px columns and put the three real groups
          in the first three. The fix is for the wide thing not to be in the
          grid at all, and then the two spare tracks collapse and the three
          groups take a third each. */}
      <div className="set-group set-group--wide">
        <h2>Backups</h2>
        <Backups />
      </div>
    </section>
  )
}

interface BackupFile {
  name: string
  path: string
  bytes: number
  modified: string
}

interface BackupStatus {
  directory: string
  intervalDays: number
  kept: number
  backups: BackupFile[]
  nextDue: string | null
  sessions: number
}

/**
 * A backup's timestamp, in the app's own date order.
 *
 * `toLocaleDateString()` was the one date on this screen the app did not
 * control: it follows the machine's locale, so the backup list could print
 * `11/05/2026` or `05/11/2026` or `2026-11-05` depending on the install while
 * every other date beside it was MM/DD. Deferring to the OS looks like the
 * considerate choice and is the one that puts two orders on one screen.
 */
function when(iso: string): string {
  return formatDateTime(iso)
}

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function Backups(): React.JSX.Element {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  function load(): void {
    void window.api.backups.status().then((next) => setStatus(next as BackupStatus))
  }

  useEffect(load, [])

  /**
   * Restoring replaces the whole history, so it asks with the numbers in hand -
   * how many rows are coming in against how many are going out - rather than a
   * generic warning nobody reads.
   */
  async function restore(): Promise<void> {
    const file = await window.api.backups.pickRestore()
    if (!file) return
    setResult(null)

    const preview = (await window.api.backups.previewRestore(file)) as {
      ok: boolean
      problem: string | null
      rows: number
      hours: number
      firstDate: string
      lastDate: string
      projects: number
      replaces: number
    }
    if (!preview.ok) {
      setResult(`Cannot restore: ${preview.problem ?? 'unreadable file'}`)
      return
    }

    const confirmed = await window.api.ui.confirm({
      title: 'Restore from a backup',
      message:
        `Replace everything with ${preview.rows.toLocaleString()} sessions ` +
        `(${preview.hours.toFixed(1)} h, ${preview.projects} projects)?`,
      detail:
        `The backup covers ${formatDateRange(preview.firstDate, preview.lastDate)}.\n\n` +
        (preview.replaces > 0
          ? `${preview.replaces.toLocaleString()} sessions currently in the app will be replaced. A backup of them is written first, so this is reversible.`
          : 'There is nothing in the app to replace.'),
      confirmLabel: 'Restore'
    })
    if (!confirmed) return

    setBusy(true)
    try {
      const done = (await window.api.backups.restore(file)) as {
        sessions: number
        projects: number
        pauses: number
        replaced: number
        safetyBackup: string | null
      }
      setResult(
        `Restored ${done.sessions.toLocaleString()} sessions across ${done.projects} projects.` +
          (done.safetyBackup ? ' The previous contents were backed up first.' : '')
      )
      load()
    } catch (error) {
      setResult(`Restore failed, nothing was changed. ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function backupNow(): Promise<void> {
    setBusy(true)
    setResult(null)
    try {
      const outcome = (await window.api.backups.now()) as {
        written: boolean
        rows?: number
        reason?: string
      }
      setResult(
        outcome.written
          ? `Backed up ${outcome.rows?.toLocaleString()} sessions.`
          : `Nothing written — ${outcome.reason}.`
      )
      load()
    } catch (error) {
      setResult(`Backup failed. ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  if (status === null) return <p className="muted">Loading…</p>

  const newest = status.backups[0]

  return (
    <>
      <p className="muted">
        A CSV of every session — dates, durations, project, task, output, pauses and all — written
        automatically every {status.intervalDays} days, which works out to twice a week. The app
        checks when it starts and every few hours while it runs, so a backup that came due while it
        was closed is taken at the next launch rather than skipped.
      </p>

      <div className="backup-path">
        <code>{status.directory}</code>
        <button className="action" onClick={() => void window.api.backups.reveal()}>
          Open folder
        </button>
      </div>

      <p className="muted">
        The {status.kept} most recent are kept. Older ones go to the Recycle Bin rather than being
        deleted outright, so a mistake in the retention rule is recoverable for 30 days.
      </p>

      <div className="row">
        <button className="action action--primary" disabled={busy} onClick={() => void backupNow()}>
          {busy ? 'Working…' : 'Back up now'}
        </button>
        <button className="action" disabled={busy} onClick={() => void restore()}>
          Restore from a backup…
        </button>
        <span className="muted">
          {newest
            ? `last backup ${when(newest.modified)}`
            : status.sessions === 0
              ? 'nothing to back up yet'
              : 'no backup taken yet'}
          {status.nextDue && ` · next due ${when(status.nextDue)}`}
        </span>
      </div>

      {result && <p className="notice notice--good">{result}</p>}

      {status.backups.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>File</th>
              <th>Taken</th>
              <th className="num">Size</th>
            </tr>
          </thead>
          <tbody>
            {status.backups.map((file) => (
              <tr key={file.name}>
                <td className="mono">{file.name}</td>
                <td>{when(file.modified)}</td>
                <td className="num">{size(file.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/** One local `YYYY-MM-DD`, for the streak and week windows. */
function localToday(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function hoursLabel(value: number): string {
  if (value >= 100) return `${Math.round(value).toLocaleString()} h`
  return `${value.toFixed(1)} h`
}

/**
 * What each panel is called when it is not on screen, and how wide it wants to
 * be.
 *
 * Width is a property of the panel rather than of the row it happens to be in.
 * Once the order can change, fixed rows cannot survive - two panels paired in
 * the markup would come apart the moment something was dragged between them.
 * Declaring that a chart reads well at half width and letting the grid pair
 * whatever ends up adjacent keeps the default layout exactly as it was while
 * making any other arrangement land sensibly.
 */
const PANELS: Record<PanelId, { label: string; full: boolean }> = {
  calendar: { label: 'Every day', full: true },
  hoursPerWeek: { label: 'Hours per week', full: true },
  projects: { label: 'Hours by project', full: false },
  plannedRatio: { label: 'Are your timers the right length?', full: false },
  rateTrend: { label: 'Work rate over time', full: true },
  timeOfDay: { label: 'Time of day', full: false },
  pace: { label: 'Pace against target', full: false }
}

/**
 * Which windows a panel offers, where the full ladder does not suit it.
 *
 * Only the calendar narrows. Its grid is a year wide by construction, so
 * "past week" draws one column of squares in a panel sized for fifty-two -
 * technically correct and useless. Everything else keeps every option,
 * including the panels where a short range will often be empty: time of day
 * is thin because the app is new, and hiding the week option would hide the
 * reason it is thin.
 */
const PANEL_RANGE_OPTIONS: Partial<Record<PanelId, readonly WindowId[]>> = {
  calendar: ['1m', '8w', '1y', '2y', 'all']
}

/**
 * The dates a target's range covers, or null for everything.
 *
 * `all` returns null rather than the range `windowRange` would give it,
 * because those are not the same set: every window ends on the **last
 * complete day**, which is right for an average and wrong for a calendar - it
 * would leave today's square unfilled on a grid whose whole job is to show
 * that today is filled. A bounded window keeps the complete-day rule, so the
 * figures that compare two periods still compare two whole ones.
 *
 * Null is also what a window with no complete day yet resolves to, which
 * shows everything rather than nothing. On a history this old it cannot
 * happen; on a fresh install it is the difference between a first day that
 * draws and one that reads as a broken panel.
 */
function spanOf(range: WindowId, today: string, firstDate: string | null): Range | null {
  if (range === 'all') return null
  return windowRange(range, today, firstDate)
}

/**
 * One panel, with its own range already applied.
 *
 * The narrowing happens here rather than inside each component, so that a
 * chart stays a thing that draws what it is handed. Two shapes of narrowing
 * are needed and `shared/ranges.ts` explains why: an aggregate that still
 * carries dates is filtered, and the three that had already been summed over
 * the whole history are re-totalled from the per-day forms the main process
 * now also sends.
 *
 * `hoursPerWeek` is the exception that takes the range itself. It does not
 * want a filtered series - it buckets by day or by week depending on how long
 * the range is, so it needs to know which window was chosen, not just which
 * days survived it.
 */
function panelFor(
  id: PanelId,
  data: Analytics,
  accent: string,
  today: string,
  layout: Layout,
  onRange: (target: RangeTargetId, next: WindowId) => void
): React.JSX.Element {
  const range = rangeFor(layout, id)
  const span = spanOf(range, today, data.firstDate)
  const set = (next: WindowId): void => onRange(id, next)
  const control = (
    <RangePicker
      value={range}
      onChange={set}
      label={PANELS[id].label}
      options={PANEL_RANGE_OPTIONS[id]}
    />
  )

  switch (id) {
    case 'calendar':
      return <CalendarHeatmap daily={within(data.daily, span)} accent={accent} control={control} />
    case 'hoursPerWeek':
      return <HoursOverTime daily={data.daily} accent={accent} range={range} onRange={set} />
    case 'projects':
      return (
        <ByProject
          byProject={projectTotalsIn(data.projectDays, span)}
          accent={accent}
          control={control}
        />
      )
    case 'plannedRatio':
      return (
        <PlannedVsActual
          data={plannedVsActualIn(data.plannedRuns, span)}
          accent={accent}
          control={control}
        />
      )
    case 'rateTrend': {
      const ranged: Record<string, (typeof data.ratesByUnit)[string]> = {}
      for (const [unit, points] of Object.entries(data.ratesByUnit)) {
        ranged[unit] = within(points, span)
      }
      /*
       * A unit with nothing in the range drops out of the picker.
       *
       * Left in, it would be an option that selects an empty chart - and
       * because the component falls back to the first unit in the list, a
       * narrow range could open on a unit with no points while another unit
       * had plenty. Rates are never comparable across units, so the picker is
       * the only way to see the other one; it has to list the ones that are
       * there.
       */
      const units = data.units.filter((unit) => (ranged[unit] ?? []).length > 0)
      return <RateTrend ratesByUnit={ranged} units={units} accent={accent} control={control} />
    }
    case 'timeOfDay': {
      /*
       * The count and the span are taken from the same filtered rows as the
       * grid, so the caption cannot name a period the heatmap is not drawn
       * from - which is the fault this panel is most exposed to, since its
       * whole caption exists to stop a thin chart being over-read.
       */
      const rows = within(data.hourDays, span)
      const sessions = rows.reduce((total, row) => total + row.sessions, 0)
      const dates = rows.map((row) => row.date).sort()
      return (
        <TimeOfDayHeatmap
          byHour={hourTotalsIn(data.hourDays, span)}
          timedSessions={sessions}
          timedFirst={dates[0] ?? null}
          timedLast={dates[dates.length - 1] ?? null}
          accent={accent}
          control={control}
        />
      )
    }
    case 'pace':
      return <PaceAccuracy pace={within(data.pace, span)} accent={accent} control={control} />
  }
}

/**
 * Moves `moved` to sit where `target` currently is.
 *
 * A drop onto a panel in a different section does nothing. Sections are a
 * property of a panel rather than a second arrangement (see `SECTIONS`), so
 * the alternative is not "the panel moves section" - it is "the flat order
 * changes and the panel stays visibly where it was", which reads as the drag
 * having failed. Refusing it means the drop target simply does not accept,
 * which the cursor already says.
 */
function reorder(order: PanelId[], moved: PanelId, target: PanelId): PanelId[] {
  if (moved === target) return order
  if (sectionOf(moved) !== sectionOf(target)) return order
  const next = order.filter((id) => id !== moved)
  const at = next.indexOf(target)
  if (at === -1) return order
  next.splice(at, 0, moved)
  return next
}

function Slot({
  id,
  editing,
  dragging,
  onDragging,
  layout,
  onChange,
  children
}: {
  id: PanelId
  editing: boolean
  dragging: PanelId | null
  onDragging: (id: PanelId | null) => void
  layout: Layout
  onChange: (next: Layout | ((prev: Layout) => Layout)) => void
  children: React.ReactNode
}): React.JSX.Element {
  const meta = PANELS[id]
  return (
    <div
      className={`an-slot${meta.full ? ' an-slot--full' : ''}${dragging === id ? ' is-dragging' : ''}`}
      draggable={editing}
      onDragStart={(event) => {
        onDragging(id)
        // A drag will not start at all unless some data is set.
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', id)
      }}
      onDragOver={(event) => {
        if (!editing || dragging === null) return
        // Not a valid target, so the drop is never accepted and the cursor
        // says so rather than the drag silently doing nothing.
        if (sectionOf(dragging) !== sectionOf(id)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (!editing || dragging === null) return
        event.preventDefault()
        onChange({ ...layout, order: reorder(layout.order, dragging, id) })
        onDragging(null)
      }}
      onDragEnd={() => onDragging(null)}
    >
      {children}
      {/* Declared after the panel it overlays, which is the house rule for
          anything sitting on top of another surface. */}
      {editing && (
        <div className="an-slot__tools">
          <span className="an-slot__grip" aria-hidden="true">
            <Icon name="grip" />
          </span>
          <button
            type="button"
            className="an-slot__hide"
            title={`Hide ${meta.label}`}
            onClick={() => onChange({ ...layout, hidden: [...layout.hidden, id] })}
          >
            &times;
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The controls, behind a mode rather than always on screen.
 *
 * The tab is read far more often than it is rearranged, and it is the surface
 * that is meant to feel like progress rather than an audit - so a grip and a
 * close button on every panel, permanently, is the wrong trade. Entering a
 * mode costs one click and gives the hidden panels somewhere to live, which is
 * the constraint that actually matters: a panel you cannot find again is a
 * panel you have lost.
 */
function LayoutBar({
  editing,
  onEditing,
  layout,
  persists,
  onChange,
  onReset
}: {
  editing: boolean
  onEditing: (next: boolean) => void
  layout: Layout
  persists: boolean
  onChange: (next: Layout | ((prev: Layout) => Layout)) => void
  onReset: () => void
}): React.JSX.Element {
  const scaleBy = (delta: number): void => {
    onChange((prev) => ({
      ...prev,
      fontScale: Math.min(
        MAX_FONT_SCALE,
        Math.max(MIN_FONT_SCALE, Math.round((prev.fontScale + delta) * 100) / 100)
      )
    }))
  }

  return (
    <div className={`an-bar${editing ? ' is-arranging' : ''}`}>
      {/* "Modify panels", at the user's request, replacing "Rearrange or hide
          panels".

          The long name was chosen deliberately - the verbs rather than a noun,
          because the user had asked for movable panels and then reported never
          getting them while the control was on screen the whole time. The
          short name is theirs and it is the one that goes in, but the grip
          glyph stays and matters more now: it is what still says the panels
          can be dragged when the words no longer do. */}
      <button type="button" className="an-bar__toggle" onClick={() => onEditing(!editing)}>
        {editing ? (
          'Done'
        ) : (
          <>
            <Icon name="grip" />
            Modify panels
          </>
        )}
      </button>

      {editing && (
        <>
          <div className="an-bar__scale" role="group" aria-label="Text size">
            <button
              type="button"
              onClick={() => scaleBy(-0.1)}
              disabled={layout.fontScale <= MIN_FONT_SCALE}
              title="Smaller text"
            >
              A
            </button>
            <span>{Math.round(layout.fontScale * 100)}%</span>
            <button
              type="button"
              className="is-big"
              onClick={() => scaleBy(0.1)}
              disabled={layout.fontScale >= MAX_FONT_SCALE}
              title="Larger text"
            >
              A
            </button>
          </div>

          {layout.hidden.length > 0 && (
            <div className="an-tray">
              <span className="an-tray__label">Hidden</span>
              {layout.hidden.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="an-tray__item"
                  title={`Show ${PANELS[id].label}`}
                  onClick={() =>
                    onChange({ ...layout, hidden: layout.hidden.filter((other) => other !== id) })
                  }
                >
                  {PANELS[id].label} <span aria-hidden="true">+</span>
                </button>
              ))}
            </div>
          )}

          <button type="button" className="an-bar__reset" onClick={onReset}>
            Reset
          </button>

          {!persists && (
            <span className="an-bar__warn" role="status">
              Not saved &mdash; this session only
            </span>
          )}

          {/* Entering the mode is the only moment the feature can explain
              itself, because every affordance it adds is hidden until then.
              Hiding gets named first: seven panels exist and none has ever
              been hidden, so that is the capability least likely to be
              guessed. */}
          <span className="an-bar__hint">
            Drag a panel to move it &middot; &times; hides one, and hidden panels come back from
            here
          </span>
        </>
      )}
    </div>
  )
}

/** Remembered so the same fact is not shown twice running. */
const FACT_KEY = 'dwt.lastFact'

/**
 * One fun fact for this opening of the tab.
 *
 * The last one is remembered so the same figure cannot come up twice running.
 * Both storage calls are wrapped because a blocked or cleared profile must
 * cost a repeat, not a crash - and a null back from `pickFact` means there was
 * nothing worth saying, which the row renders by leaving the tile out.
 */
function chooseFact(data: Analytics): Fact | null {
  let last: string | null = null
  try {
    last = localStorage.getItem(FACT_KEY)
  } catch {
    /* storage blocked; the worst case is repeating the last fact */
  }
  const chosen = pickFact(buildFacts(data), Math.random(), last)
  try {
    if (chosen !== null) localStorage.setItem(FACT_KEY, chosen.id)
  } catch {
    /* same */
  }
  return chosen
}

function AnalyticsTab(): React.JSX.Element {
  const accent = useAccentSync()
  const { layout, persists, update, reset } = useLayout()
  const [editing, setEditing] = useState(false)
  const [dragging, setDragging] = useState<PanelId | null>(null)
  /*
   * The fact is chosen where the history lands, not while rendering it.
   *
   * Two earlier versions picked it in the body. A `useState` initializer was
   * the first, and it can only sit after this component's early returns for
   * loading and failure, so it ran on some renders and not others - React
   * error #310, and the tab rendered white. A ref filled in during render was
   * the second, and it works, but choosing involves `Math.random` and a
   * `localStorage` write, which is a side effect in the render phase whatever
   * holds the result; the compiler rejects both the impure call and the ref.
   *
   * The payload handler below is where it belongs: it runs once, off the
   * render path, and `setFact` batches with `setData`, so the tile arrives
   * with the rest of the row rather than a frame after it.
   */
  /*
   * The *id* is chosen once, not the fact.
   *
   * The tile now has its own range control, so the list of facts changes
   * under it - a unit with nothing in the past week drops out entirely. The
   * choice still has to be made off the render path, because it involves
   * `Math.random` and a `localStorage` write, so what is held is the id and
   * the fact is looked up from whatever the current range supports. Same
   * fact across a range change where it survives, a sensible one where it
   * does not, and no impurity in render either way.
   */
  const [factId, setFactId] = useState<string | null>(null)
  const [data, setData] = useState<Analytics | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    let alive = true
    window.api.analytics
      .get()
      .then((payload) => {
        if (!alive) return
        // Null is the main process telling us the read failed - see the
        // `analytics:get` handler. It is deliberately not an empty payload,
        // because zeroes would render as "you have never worked", which is the
        // most alarming possible way to report a query error.
        if (payload === null) {
          setState('failed')
          return
        }
        setData(payload as Analytics)
        setFactId(chooseFact(payload as Analytics)?.id ?? null)
        setState('ready')
      })
      .catch(() => {
        // A rejected invoke is the same situation as a null payload. Without
        // this the promise would reject unhandled and the tab would sit on
        // "Reading" forever with the reason only in the console.
        if (alive) setState('failed')
      })
    return () => {
      alive = false
    }
  }, [])

  if (state === 'loading') {
    return (
      <section className="panel panel--wide">
        <h2>Analytics</h2>
        <p className="muted">Reading the history&hellip;</p>
      </section>
    )
  }

  if (state === 'failed' || data === null) {
    return (
      <section className="panel panel--wide">
        <h2>Analytics</h2>
        <p className="muted">
          The history could not be read, so nothing here would be trustworthy. Your sessions are not
          affected &mdash; this is a failure to query them, not a failure to store them. The Data
          tab reads the same rows and is worth trying; if that is empty too, Settings has Restore
          from backup.
        </p>
      </section>
    )
  }

  if (data.totalSessions === 0) {
    return (
      <section className="panel panel--wide">
        <h2>Analytics</h2>
        <p className="muted">
          Nothing recorded yet. Run a timer and stop it, add a session by hand, or bring in the
          spreadsheet from the Import tab.
        </p>
      </section>
    )
  }

  const today = localToday()

  const setRange = (target: RangeTargetId, next: WindowId): void => {
    update((prev) => withRange(prev, target, next))
  }

  /*
   * What is left of the figure row's own arithmetic.
   *
   * The average and the period comparison used to be computed here, each
   * with its own picker. Both are gone into `CompareBox`, which asks the
   * same questions better: they were two of the three readings of one number
   * the user could not tell apart.
   *
   * The baseline tile stays, and it does NOT follow any picker. It compares
   * the last year against the first, and both ends have to be fixed for that
   * to mean anything - wired to a window it read +321% on "past week" and
   * +295% on "past year", the same claim with two numbers. A figure
   * captioned "against your first year" has to choose its own other end.
   *
   * It is not a duplicate of the box, which was worth checking before
   * keeping it: the box compares a period against the one before it, this
   * compares the present against a fixed point three years back, and no
   * setting of the box produces that.
   */
  const base = baseline(data.daily, data.firstDate)
  const recentYear = windowRange('1y', today, data.firstDate)
  const above =
    recentYear === null ? null : aboveBaseline(averagePerDay(data.daily, recentYear).perDay, base)

  /*
   * The fun fact over its own range.
   *
   * Rebuilt here rather than held in state, because the range can change it:
   * 292,358 words all time is 1,400 words in the past week, and the unit may
   * not clear the thresholds in a short window at all. The id chosen on load
   * is used when the new list still has it, so moving the range does not
   * also reshuffle which fact you are looking at.
   */
  const factRange = rangeFor(layout, 'fact')
  const factSpan = spanOf(factRange, today, data.firstDate)
  const everyFact = buildFacts({
    ...data,
    unitTotals: unitTotalsIn(data.unitDays, factSpan)
  })
  /*
   * On a narrowed range, only the facts that narrowed with it.
   *
   * The output facts follow the control because `unitTotals` is recomputed
   * above; the rest - lifetime hours, the longest session ever, the
   * most-worked project - do not, and cannot without dating aggregates that
   * have no date. Left in, the tile could answer a dropdown reading "past
   * month" with "2,755 h of deep work since 03/27/2023", which is a control
   * that visibly does nothing to the thing beside it. They come back at all
   * time, where they are exactly right.
   */
  const facts =
    factSpan === null ? everyFact : everyFact.filter((one) => one.id.startsWith('unit:'))
  const fact = facts.find((one) => one.id === factId) ?? facts[0] ?? null

  return (
    // The text scale lives here rather than on the panel grid, because the
    // figure row is a sibling of that grid and not a child of it. Set lower
    // down, the control moved every caption and left the headline numbers -
    // the largest type on the page - exactly where they were. Found by
    // pressing the button and watching what did not move; it renders
    // identically either way.
    <section
      className="panel panel--wide"
      style={{ '--an-fs': layout.fontScale } as React.CSSProperties}
    >
      {/* The header carries the control rather than sitting above it. Under
          the figure row it was below four large numbers, which is where the
          eye has already stopped - the user asked for movable panels and then
          reported never getting them while this was on screen the whole time.
          Beside the title it is the first thing in the tab after the tab's own
          name. */}
      <header className="data-head data-head--with-action">
        <div>
          <h2>Analytics</h2>
          {/* The lifetime total lives here now. The tile row is four windowed
              figures after items 25-28, so the one number that only ever grows
              would otherwise have left the tab entirely - and it is the figure
              that answers "was any of this worth it". Quiet, because it does
              not change while you look at it. */}
          <p className="data-head__count">
            {hoursLabel(data.totalHours)} of deep work &middot;{' '}
            {data.totalSessions.toLocaleString()} sessions &middot;{' '}
            {data.activeDays.toLocaleString()} days worked
          </p>
          {data.firstDate && data.lastDate && (
            <p className="data-head__span">
              recorded {formatDateRange(data.firstDate, data.lastDate)}
            </p>
          )}
        </div>
        <LayoutBar
          editing={editing}
          onEditing={setEditing}
          layout={layout}
          persists={persists}
          onChange={update}
          onReset={reset}
        />
      </header>

      {/*
       * The stat row, with a range on each tile that has one.
       *
       * It was built around a single control and the user rejected that in
       * those words. What the shared control was protecting is still true and
       * now lives in `shared/windows.ts` alone: every one of these pickers
       * reads the same ladder and resolves through the same `windowRange`, so
       * "past 8 weeks" is the same eight weeks wherever it is chosen. Only the
       * choice is local.
       *
       * What leads is still a figure that cannot report a loss. The average
       * moves with its own picker and the baseline only grows; the comparison
       * can fall, and it sits last, told fairly, as it did before.
       */}
      <h3 className="an-section__title an-section__title--first">{SECTIONS[0].title}</h3>

      <div className="an-stats">
        {/* The box, in the place the two tiles it replaces used to take. */}
        <CompareBox
          daily={data.daily}
          today={today}
          firstDate={data.firstDate}
          choice={layout.compare}
          onChoice={(next) => update((prev) => ({ ...prev, compare: next }))}
        />

        {/* Hidden rather than shown as nothing when the history is under a
            year: a baseline needs a first year to be a baseline. */}
        {above !== null && (
          <div className="an-stat">
            <strong className={above >= 0 ? 'is-up' : 'is-down'}>
              {above >= 0 ? '+' : ''}
              {Math.round(above)}%
            </strong>
            <span>
              against your first year &middot; {base?.perDay.toFixed(2)} h a day then,{' '}
              {recentYear === null
                ? ''
                : `${averagePerDay(data.daily, recentYear).perDay.toFixed(2)} h now`}
            </span>
          </div>
        )}

        {fact !== null && (
          <div className="an-stat">
            <strong>{fact.value}</strong>
            <span>
              {fact.label}
              {fact.detail === '' ? '' : ` ${fact.detail}`}
            </span>
            <RangePicker
              value={factRange}
              onChange={(next) => setRange('fact', next)}
              label="the fun fact"
            />
          </div>
        )}
      </div>

      {/* Rows rather than one column: a chart that reads fine at half the
          width should not stretch a 220px plot across the whole panel. The
          calendar leads because the user asked for it by name.

          One grid per section rather than one grid with headings in it. A
          heading inside the grid would need a full-width cell and would still
          be a grid item, so a half-width panel could pair with it; a grid each
          also means a section's panels cannot drift across its own heading
          when the order changes.

          A section with everything in it hidden renders nothing at all, not an
          empty heading. The headings are fixed, so one over a gap would be the
          only part of the tab that reports something that is not there. */}

      {SECTIONS.map((section) => {
        if (section.panels.length === 0) return null
        const ids = visiblePanels(layout).filter((id) => sectionOf(id) === section.id)
        if (ids.length === 0) return null
        return (
          <div key={section.id}>
            <h3 className="an-section__title">{section.title}</h3>
            <div className={`an${editing ? ' is-arranging' : ''}`}>
              {ids.map((id) => (
                <Slot
                  key={id}
                  id={id}
                  editing={editing}
                  dragging={dragging}
                  onDragging={setDragging}
                  layout={layout}
                  onChange={update}
                >
                  {panelFor(id, data, accent, today, layout, setRange)}
                </Slot>
              ))}
            </div>
          </div>
        )
      })}
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
  project: string
  task: string
  planned: string
  actual: string
  work_quantity: string
  work_unit: string
  notes: string
  /** Only offered when editing; a new row's source is decided by main. */
  source: string
}

/**
 * Every value `source` may hold, in plain words. Offered so a row marked
 * wrongly can be corrected - every field of every session is editable, and
 * this one decides whether analytics count the row at all.
 */
const SOURCE_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'app', label: 'Timed' },
  { value: 'manual', label: 'Manual' },
  { value: 'import', label: 'Imported' },
  { value: 'test', label: 'Test (not counted)' }
]

function toForm(row: SessionRow | null): FormState {
  const today = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    session_date:
      row?.session_date ??
      `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    project: row?.project_name ?? '',
    task: row?.task ?? '',
    planned: row ? formatDurationInput(row.planned_duration_s * 1000) : '',
    actual: row ? formatDurationInput(row.running_duration_s * 1000) : '',
    work_quantity: row?.work_quantity == null ? '' : String(row.work_quantity),
    work_unit: row?.work_unit ?? '',
    notes: row?.notes ?? '',
    source: row?.source ?? 'manual'
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
  const [projectNames, setProjectNames] = useState<string[]>([])
  const [projectOpen, setProjectOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)

  useEffect(() => {
    window.api.timer
      .projectNames()
      .then(setProjectNames)
      .catch(() => setProjectNames([]))
  }, [])

  const plannedMs = parseDurationMs(form.planned)
  const actualMs = parseDurationMs(form.actual)
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(form.session_date)
  const canSave = validDate && actualMs !== null
  // The same ranking the timer's project field uses, so `hw`, `HW 2` and a
  // typo offer the same project here as they do there.
  const matches = rankProjects(form.project, projectNames, 4)

  function set<K extends keyof FormState>(key: K, value: string): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function chooseProject(name: string): void {
    set('project', name)
    setProjectOpen(false)
  }

  return (
    <div className="editor">
      <h3>{row ? `Edit session ${row.id}` : 'Add a session'}</h3>
      <p className="muted">
        {row
          ? 'Changes apply to the row in place, and can be undone.'
          : 'For work that was not timed, such as a meeting entered afterwards. Saved as a manual session; time-of-day charts leave it out, since its times are from memory.'}
      </p>

      {/* Two fixed columns rather than auto-fit. Auto-fit packed four
          label-and-field pairs onto one line and each field kept the
          browser's default width, so every label sat inside the field to its
          left and Unit ran off the card. Pairs that belong together - planned
          with actual, quantity with unit - share a line. */}
      <div className="editor__grid">
        <label className="field field--inline">
          <span>Date</span>
          {/* The same native picker as the filters: it shows MM/DD/YYYY and
              stores the ISO date, which is what the column holds. */}
          <input
            type="date"
            value={form.session_date}
            onChange={(e) => set('session_date', e.target.value)}
          />
        </label>
        <div className="field field--inline">
          <span>Project</span>
          <span className="project-box">
            <input
              value={form.project}
              placeholder="HW"
              autoComplete="off"
              spellCheck={false}
              aria-label="Project"
              onChange={(e) => {
                set('project', e.target.value)
                setProjectOpen(true)
                setHighlight(0)
              }}
              onFocus={(e) => {
                e.currentTarget.select()
                setProjectOpen(true)
                setHighlight(0)
              }}
              // Deferred so a mousedown on a suggestion lands before the list
              // closes under it.
              onBlur={() => window.setTimeout(() => setProjectOpen(false), 120)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setProjectOpen(true)
                  setHighlight((h) => Math.min(h + 1, matches.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHighlight((h) => Math.max(h - 1, 0))
                } else if (e.key === 'Escape') {
                  setProjectOpen(false)
                } else if (e.key === 'Enter' && projectOpen && matches[highlight]) {
                  e.preventDefault()
                  chooseProject(matches[highlight].name)
                }
              }}
            />
            {projectOpen && matches.length > 0 && (
              <ul className="project-menu project-menu--form">
                {matches.map((match, index) => (
                  <li key={match.name}>
                    <button
                      type="button"
                      className={index === highlight ? 'is-active' : ''}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        chooseProject(match.name)
                      }}
                      onMouseEnter={() => setHighlight(index)}
                    >
                      {match.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </span>
        </div>
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
            inputMode="decimal"
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
            onChange={(e) => set('work_unit', e.target.value.replace(/[0-9]/g, ''))}
          />
        </label>
        <label className="field field--inline field--wide">
          <span>Notes</span>
          <input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
        {row && (
          <label className="field field--inline">
            <span>Source</span>
            <select value={form.source} onChange={(e) => set('source', e.target.value)}>
              {SOURCE_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="row">
        <button
          className="action action--primary"
          disabled={!canSave}
          onClick={() =>
            onSave({
              session_date: form.session_date,
              // Sent as the typed name; main resolves it against the existing
              // projects, so it never starts a duplicate of one.
              project: form.project.trim() === '' ? null : form.project.trim(),
              task: form.task.trim() === '' ? null : form.task.trim(),
              // Planned falls back to actual: a session entered from memory was
              // never planned, and a null there would break duration maths.
              planned_duration_s: Math.round((plannedMs ?? actualMs ?? 0) / 1000),
              running_duration_s: Math.round((actualMs ?? 0) / 1000),
              work_quantity: form.work_quantity === '' ? null : Number(form.work_quantity),
              work_unit: form.work_unit.trim() === '' ? null : form.work_unit.trim(),
              notes: form.notes.trim() === '' ? null : form.notes.trim(),
              ...(row ? { source: form.source } : {})
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

interface ProjectOption {
  id: number
  name: string
  sessions: number
}

/**
 * 100 newest first is the default, and the first entry for a reason: it is the
 * view that answers "what have I been doing lately", which is what the tab is
 * opened for. `null` is "show all" - the query reads a null limit as no limit.
 */
const PAGE_SIZES: Array<{ id: string; label: string; size: number | null }> = [
  { id: '100', label: '100 rows', size: 100 },
  { id: '250', label: '250 rows', size: 250 },
  { id: '1000', label: '1000 rows', size: 1000 },
  { id: 'all', label: 'All rows', size: null }
]

const SOURCES: Array<{ id: string; label: string; value: string | null }> = [
  { id: 'any', label: 'Any source', value: null },
  { id: 'app', label: 'Timed', value: 'app' },
  { id: 'manual', label: 'Manual', value: 'manual' },
  { id: 'import', label: 'Imported', value: 'import' },
  // Every row an unpackaged build or a testing session wrote, so they can be
  // reviewed and cleared in one pass rather than hunted for.
  { id: 'test', label: 'Test', value: 'test' }
]

function today(): Date {
  return new Date()
}

function isoDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function daysAgo(days: number): string {
  const date = today()
  date.setDate(date.getDate() - days)
  return isoDay(date)
}

function monthsAgo(months: number): string {
  const date = today()
  date.setMonth(date.getMonth() - months)
  return isoDay(date)
}

const RANGES: Array<{ id: string; label: string; from: () => string }> = [
  { id: '7d', label: '7 days', from: () => daysAgo(6) },
  { id: '30d', label: '30 days', from: () => daysAgo(29) },
  { id: '90d', label: '90 days', from: () => daysAgo(89) },
  { id: '12m', label: '12 months', from: () => monthsAgo(12) }
]

function DataTab(): React.JSX.Element {
  const [page, setPage] = useState<SessionPage | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
  const [editing, setEditing] = useState<SessionRow | 'new' | null>(null)

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [sourceId, setSourceId] = useState('any')
  const [projectId, setProjectId] = useState('')
  const [sizeId, setSizeId] = useState('100')
  const [offset, setOffset] = useState(0)

  const limit = PAGE_SIZES.find((entry) => entry.id === sizeId)?.size ?? null
  const source = SOURCES.find((entry) => entry.id === sourceId)?.value ?? null
  const filtered = from !== '' || to !== '' || search !== '' || source !== null || projectId !== ''

  const criteria = {
    from: from || null,
    to: to || null,
    search: search || null,
    source,
    projectId: projectId === '' ? null : Number(projectId),
    limit,
    offset
  }

  // A query per keystroke would be one IPC round trip per letter. Short enough
  // that typing never feels like it is waiting on the table.
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(typed)
      setOffset(0)
    }, 200)
    return () => clearTimeout(id)
  }, [typed])

  async function refresh(): Promise<void> {
    const [next, state] = await Promise.all([
      window.api.sessions.query(criteria),
      window.api.history.state()
    ])
    const loaded = next as SessionPage
    // Deleting the last row of the last page would otherwise leave the view
    // sitting past the end of the results, showing an empty table.
    if (offset > 0 && loaded.total <= offset) setOffset(0)
    setPage(loaded)
    setHistory(state)
    setProjects(await window.api.sessions.projects())
  }

  // Written as a promise chain rather than calling refresh(): the lint rule
  // cannot see that refresh awaits before it sets state, and reads the call as
  // a synchronous setState inside an effect.
  useEffect(() => {
    let live = true
    void Promise.all([
      window.api.sessions.query({
        from: from || null,
        to: to || null,
        search: search || null,
        source,
        projectId: projectId === '' ? null : Number(projectId),
        limit,
        offset
      }),
      window.api.history.state(),
      window.api.sessions.projects()
    ]).then(([next, state, options]) => {
      if (!live) return
      setPage(next as SessionPage)
      setHistory(state)
      setProjects(options)
    })
    return () => {
      live = false
    }
  }, [from, to, search, source, projectId, limit, offset])

  // Any change to what is being shown returns to the first page. Staying on
  // page 14 of a filter that now has three pages shows nothing at all.
  function setRange(nextFrom: string, nextTo: string): void {
    setFrom(nextFrom)
    setTo(nextTo)
    setOffset(0)
  }

  function clearFilters(): void {
    setFrom('')
    setTo('')
    setTyped('')
    setSearch('')
    setSourceId('any')
    setProjectId('')
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
      message: `Delete ${row.task ?? 'this unlabeled session'}?`,
      detail: `${formatDate(row.session_date) || 'no date'} · ${hours(row.running_duration_s)} recorded.

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
        detail: `${formatDate(row.session_date) || 'no date'} · ${row.task ?? 'unlabeled'}

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
  const firstShown = total === 0 ? 0 : offset + 1
  const lastShown = Math.min(offset + rows.length, total)
  const pageCount = limit === null ? 1 : Math.max(1, Math.ceil(total / limit))
  const pageNumber = limit === null ? 1 : Math.floor(offset / limit) + 1
  const activeRange = RANGES.find((range) => range.from() === from && to === '')

  return (
    <section className="panel panel--wide">
      <header className="data-head">
        <h2>Sessions</h2>
        <p className="data-head__count">
          {total === 0
            ? filtered
              ? 'Nothing matches those filters.'
              : 'Nothing recorded yet. Run a timer and stop it, add one by hand, or bring in the spreadsheet from the Import tab.'
            : `${firstShown.toLocaleString()}–${lastShown.toLocaleString()} of ${total.toLocaleString()} · ${hours(totalRunningS)} ${filtered ? 'in this filter' : 'in total'}`}
        </p>
        {earliest && latest && (
          <p className="data-head__span">recorded {formatDateRange(earliest, latest)}</p>
        )}
      </header>

      <div className="toolbar">
        <input
          className="search"
          value={typed}
          placeholder="Search task or project"
          onChange={(event) => setTyped(event.target.value)}
        />
        <select
          className="picker"
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value)
            setOffset(0)
          }}
        >
          <option value="">All projects</option>
          <option value="-1">— Unlabeled —</option>
          {projects.map((option) => (
            <option key={option.id} value={String(option.id)}>
              {option.name} ({option.sessions.toLocaleString()})
            </option>
          ))}
        </select>
        <select
          className="picker picker--source"
          value={sourceId}
          onChange={(event) => {
            setSourceId(event.target.value)
            setOffset(0)
          }}
          title="Timed was recorded by the timer, Manual was entered by hand, Imported came from the spreadsheet"
        >
          {SOURCES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar">
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
        <div className="segmented segmented--sm">
          {RANGES.map((range) => (
            <button
              key={range.id}
              className={activeRange?.id === range.id ? 'is-active' : ''}
              onClick={() => setRange(range.from(), '')}
            >
              {range.label}
            </button>
          ))}
        </div>
        <button className="action action--sm" disabled={!filtered} onClick={clearFilters}>
          Clear filters
        </button>
      </div>

      {/* Paging above the table, not below it: "All rows" runs to thousands, and
          a pager at the bottom of that is a pager nobody reaches. */}
      <div className="toolbar toolbar--split">
        <div className="pager">
          {limit !== null && total > limit && (
            <>
              <button
                className="pager__step"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
                title="Previous page"
                aria-label="Previous page"
              >
                ‹
              </button>
              <span className="pager__at">
                {pageNumber}
                <span className="pager__of"> / {pageCount.toLocaleString()}</span>
              </span>
              <button
                className="pager__step"
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
                title="Next page"
                aria-label="Next page"
              >
                ›
              </button>
            </>
          )}
          <select
            className="picker picker--rows"
            value={sizeId}
            onChange={(event) => {
              setSizeId(event.target.value)
              setOffset(0)
            }}
          >
            {PAGE_SIZES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>

        <div className="toolbar__end">
          {history.canUndo && <span className="muted muted--sm">last: {history.undoLabel}</span>}
          <button
            className="action action--sm"
            disabled={!history.canUndo}
            onClick={() => void step('undo')}
            title={history.undoLabel ? `Undo ${history.undoLabel}` : 'Nothing to undo'}
          >
            Undo
          </button>
          <button
            className="action action--sm"
            disabled={!history.canRedo}
            onClick={() => void step('redo')}
            title={history.redoLabel ? `Redo ${history.redoLabel}` : 'Nothing to redo'}
          >
            Redo
          </button>
          <button className="action action--primary action--sm" onClick={() => setEditing('new')}>
            Add session
          </button>
        </div>
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
              <th>Project</th>
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
                <td className="nowrap">{formatDate(row.session_date) || '—'}</td>
                {/* Named, not dashed. A session with no project is a specific
                    thing the user can act on - the project filter has an
                    Unlabelled option and the whole point of it is that a week
                    of missed labels is one filter and a few edits rather than
                    archaeology. A bare em dash reads as "nothing here" and
                    does not connect the row to the filter that finds it.
                    Muted, because it is an absence rather than a value. */}
                <td>{row.project_name ?? <span className="muted">Unlabeled</span>}</td>
                <td>{row.task ?? <span className="muted">unlabeled</span>}</td>
                <td className="num">{hours(row.planned_duration_s)}</td>
                <td className="num">{hours(row.running_duration_s)}</td>
                <td className="num">
                  {row.work_quantity == null ? '—' : `${row.work_quantity} ${row.work_unit ?? ''}`}
                </td>
                <td>
                  <span className={`badge badge--${row.source}`}>
                    {/* Shouted, in orange: the one source that means "this
                        is not real history", and the user asked for it to
                        be impossible to miss. */}
                    {row.source === 'test' ? 'TEST' : row.source}
                  </span>
                </td>
                <td className="row-actions">
                  {/* The words are gone but the accessible name is not: this
                      column is how a mislabelled session gets fixed, and it is
                      the only place in the app that can lose a row. */}
                  <button
                    className="row-action"
                    onClick={() => setEditing(row)}
                    title="Edit"
                    aria-label={`Edit the session on ${formatDate(row.session_date) || 'no date'}`}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className="row-action row-action--danger"
                    onClick={() => void remove(row)}
                    title="Delete — undoable"
                    aria-label={`Delete the session on ${formatDate(row.session_date) || 'no date'}`}
                  >
                    <Icon name="trash" />
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

    // Only when there is something to lose. A first import adds rows and can
    // be undone by importing again; a replace deletes every imported row
    // first, which is the largest destructive action in the app and the only
    // one that happens behind a button labelled as an import.
    if (existing > 0) {
      const confirmed = await window.api.ui.confirm({
        title: 'Replace the imported history',
        message:
          `Delete ${existing.toLocaleString()} imported sessions and write ` +
          `${preview?.importable.toLocaleString() ?? 'the'} from this file?`,
        detail:
          'Sessions recorded by the timer and entered by hand are not touched.\n\n' +
          'Any edits made to imported rows are discarded \u2014 the file replaces them as it stands.',
        confirmLabel: 'Replace'
      })
      if (!confirmed) return
    }

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
              <strong>{formatDateRange(preview.firstDate, preview.lastDate)}</strong>
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
      {/* Above the tabs, so it is the first thing read and is on screen
          whichever tab is open. Renders nothing outside a preview build. */}
      <PreviewBanner />
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
