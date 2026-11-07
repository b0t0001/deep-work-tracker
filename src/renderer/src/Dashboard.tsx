import { useEffect, useState } from 'react'
import { ACCENTS, ACCENT_KEY, DEFAULT_ACCENT, isKnownAccent } from '@shared/accents'
import { acceleratorFromEvent, describeAccelerator } from '@shared/accelerator'
import { formatDurationInput, parseDurationMs } from '@shared/duration'
import type { Analytics } from '@shared/analytics'
import {
  aboveBaseline,
  averagePerDay,
  baseline,
  rangeOf,
  windowDefFor,
  type Range,
  type WindowId
} from '@shared/windows'
import { formatDate, formatDateRange, formatDateTime } from '@shared/dates'
import { rankProjects } from '@shared/projects'
import { listOf, missingForEdit, missingForNewSession } from '@shared/sessionForm'
import { parseSpan } from '@shared/span'
import { useArrange, type DragHandle } from './lib/arrange'
import {
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  SECTIONS,
  customTextFor,
  panelsInSection,
  rangeFor,
  sectionOf,
  withCustomRange,
  withRange,
  withSections,
  type Layout,
  type PanelId,
  type RangeTargetId,
  type SectionId
} from '@shared/layout'
import { hourTotalsIn, plannedVsActualIn, projectTotalsIn, within } from '@shared/ranges'
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
import { INSIGHT_KEY, InsightCard } from './components/InsightCard'

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
  /** Laps of a loop; planned covers all of them. 1 for a single run. */
  laps: number
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
                On expiry, cue and start another lap of the same length. The whole loop is one
                session, so what you get done is entered once and counted across all of it.
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
      <div className="set-group set-group--wide">
        <h2>Error log</h2>
        <ErrorLog />
      </div>
    </section>
  )
}

/**
 * Where the app writes what goes wrong. Shown so that "the Data tab is stuck"
 * comes with somewhere to look, and so the file can be sent along with a
 * report rather than the problem being reconstructed from memory.
 */
/** An IPC rejection, without Electron's "Error invoking remote method" wrapper. */
function cleanError(error: unknown): string {
  return String(error)
    .replace(/^Error: /, '')
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function ErrorLog(): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    window.api.log
      .location()
      .then(setPath)
      .catch(() => setPath(null))
  }, [])
  return (
    <>
      <p className="muted">
        Anything that goes wrong - a failed read, a session that could not be saved, a crash - is
        written here with the details needed to find the cause. Nothing about your work is in it.
      </p>
      <div className="backup-path">
        <code>{path ?? 'unavailable'}</code>
        <button className="action" onClick={() => void window.api.log.reveal()}>
          Open folder
        </button>
      </div>
    </>
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

  const [loadError, setLoadError] = useState<string | null>(null)

  // With a catch: without one a failed read left this on "Loading..." for good.
  function load(): void {
    window.api.backups
      .status()
      .then((next) => {
        setStatus(next as BackupStatus)
        setLoadError(null)
      })
      .catch((error) => setLoadError(cleanError(error)))
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

  if (status === null && loadError !== null) {
    return (
      <p className="muted">
        Backup status could not be read: {loadError}. The details are in the error log below.
      </p>
    )
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
 * The only option any panel cannot answer, and why.
 *
 * Every dropdown now shows every window - *"every timescale dropdown should
 * have the same presets"* - so the previous two lists of allowed options are
 * gone. What replaces them is this: where an option genuinely cannot apply,
 * it is still listed, still in the same place, and drawn disabled with the
 * reason as its tooltip. An option that is missing looks like a different
 * control; one that is greyed out with a sentence attached is information.
 *
 * Exactly one case survives the change. The calendar used to drop the two
 * shortest windows because its grid stretched to fill the panel and a
 * one-column week was absurd; the heatmap's cell cap fixed that at the root,
 * so it offers everything again.
 */
const BASELINE_DISABLED: Partial<Record<WindowId, string>> = {
  all: 'All time contains the first year, so this would compare the history with itself'
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
function spanOf(
  range: WindowId,
  today: string,
  firstDate: string | null,
  customDays: number | null = null
): Range | null {
  const def = windowDefFor(range, customDays)
  if (def.days === null) return null
  return rangeOf(def, today, firstDate)
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
  onRange: (target: RangeTargetId, next: WindowId) => void,
  onCustom: (target: RangeTargetId, next: string) => void
): React.JSX.Element {
  const range = rangeFor(layout, id)
  const customDays = parseSpan(customTextFor(layout, id)).days
  const span = spanOf(range, today, data.firstDate, customDays)
  const set = (next: WindowId): void => onRange(id, next)
  const control = (
    <RangePicker
      value={range}
      onChange={set}
      label={PANELS[id].label}
      customText={customTextFor(layout, id)}
      onCustomText={(next) => onCustom(id, next)}
    />
  )

  switch (id) {
    case 'calendar':
      return <CalendarHeatmap daily={within(data.daily, span)} accent={accent} control={control} />
    case 'hoursPerWeek':
      return (
        <HoursOverTime
          daily={data.daily}
          accent={accent}
          range={range}
          customDays={customDays}
          control={control}
        />
      )
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
      return (
        <RateTrend
          ratesByUnit={ranged}
          units={units}
          accent={accent}
          control={control}
          range={range}
        />
      )
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
 * The flat panel order with one section's panels put in a new sequence.
 *
 * The layout keeps one list of every panel, and a drag rearranges one
 * section. Rather than splicing, the positions that section's panels occupy
 * are collected and refilled in the new order - so panels of other sections
 * interleaved with them (which a hand-edited or migrated layout can have)
 * stay exactly where they are.
 */
function reorderWithin(order: PanelId[], section: SectionId, within: PanelId[]): PanelId[] {
  const slots: number[] = []
  order.forEach((id, index) => {
    if (sectionOf(id) === section) slots.push(index)
  })
  const next = [...order]
  slots.forEach((index, n) => {
    const id = within[n]
    if (id !== undefined) next[index] = id
  })
  return next
}

function Slot({
  id,
  editing,
  lifted,
  grab,
  slotRef,
  style,
  layout,
  onChange,
  children
}: {
  id: PanelId
  editing: boolean
  lifted: boolean
  grab: DragHandle
  slotRef: (element: HTMLElement | null) => void
  style?: React.CSSProperties
  layout: Layout
  onChange: (next: Layout | ((prev: Layout) => Layout)) => void
  children: React.ReactNode
}): React.JSX.Element {
  const meta = PANELS[id]
  return (
    <div
      ref={slotRef}
      className={`an-slot${meta.full ? ' an-slot--full' : ''}${lifted ? ' is-lifted' : ''}`}
      style={style}
    >
      {children}
      {/* Declared after the panel it overlays, which is the house rule for
          anything sitting on top of another surface. */}
      {editing && (
        <div className="an-slot__tools">
          {/* The grip is the handle now, not the whole slot. A pointer drag
              that could start anywhere would swallow every click inside a
              panel - including the range dropdowns, which stay usable while
              arranging. */}
          <span className="an-slot__grip" aria-hidden="true" {...grab}>
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

  /*
   * One row, at the right edge, and no instructions.
   *
   * "I don't need the instructions when im modifying the layout of the data.
   * All it really should do is just the buttons should just move all the way
   * to the side. The done button should move all the way to the side."
   *
   * The hint sentence is gone. It was written for the moment entering the
   * mode was the only chance to explain what it did; the grips and the hide
   * buttons appear on every panel the instant you are in it, and a sentence
   * that says what you can already see is a sentence in the way.
   *
   * Everything stays in the header row rather than opening a second one
   * underneath, so nothing below the header moves when the mode is entered -
   * which matters more than usual here, because the next thing the user does
   * is drag the things underneath. **Done sits last**, in the place Modify
   * panels occupied, so the button you pressed to come in is the button you
   * press to leave.
   */
  return (
    <div className={`an-bar${editing ? ' is-arranging' : ''}`}>
      {editing && (
        <>
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

          {!persists && (
            <span className="an-bar__warn" role="status">
              Not saved &mdash; this session only
            </span>
          )}

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

          <button type="button" className="an-bar__reset" onClick={onReset}>
            Reset
          </button>
        </>
      )}

      {/* Last, so it is the rightmost control in both modes and lands under
          the pointer that opened the mode. */}
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
    </div>
  )
}

/**
 * What the insights card opens on, drawn where the history lands.
 *
 * A random number and the id shown last time, both read in the payload
 * handler rather than while rendering: choosing involves `Math.random` and
 * `localStorage`, and the render path must stay pure (see the comment on the
 * state below for the two versions that were not). `InsightCard` turns them
 * into an opening insight for whatever range the card is set to.
 */
function insightOpening(): { seed: number; avoid: string | null } {
  let avoid: string | null = null
  try {
    avoid = localStorage.getItem(INSIGHT_KEY)
  } catch {
    /* storage blocked; the worst case is opening on the same one again */
  }
  return { seed: Math.random(), avoid }
}

function AnalyticsTab(): React.JSX.Element {
  const accent = useAccentSync()
  const { layout, persists, update, reset } = useLayout()
  const [editing, setEditing] = useState(false)
  /*
   * One commit point for both kinds of drag.
   *
   * `useArrange` holds the preview in its own state and calls this only on a
   * successful drop, so an abandoned drag - Escape, or a pointer released
   * outside - writes nothing. That is what makes "dropping outside cancels"
   * true rather than a thing that has to be remembered at each call site.
   */
  const arrange = useArrange(editing, (group, order) => {
    if (group === 'sections') {
      update((prev) => withSections(prev, order as SectionId[]))
      return
    }
    update((prev) => ({
      ...prev,
      order: reorderWithin(prev.order, group as SectionId, order as PanelId[])
    }))
  })
  /*
   * The insights card's opening is drawn where the history lands, not while
   * rendering it.
   *
   * Two earlier versions of the fun fact picked in the body. A `useState`
   * initializer was the first, and it can only sit after this component's
   * early returns for loading and failure, so it ran on some renders and not
   * others - React error #310, and the tab rendered white. A ref filled in
   * during render was the second, and it works, but choosing involves
   * `Math.random` and `localStorage`, which is a side effect in the render
   * phase whatever holds the result; the compiler rejects both.
   *
   * So the payload handler draws a random number and reads the last id shown,
   * once, off the render path, and `setOpening` batches with `setData`.
   * `InsightCard` turns the two into an insight for whatever range the card
   * is set to, which is a pure function of them - and since only the seed is
   * held, the list can change under it with the range without anything
   * impure happening in render.
   */
  const [opening, setOpening] = useState<{ seed: number; avoid: string | null } | null>(null)
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
        setOpening(insightOpening())
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

  const setCustom = (target: RangeTargetId, next: string): void => {
    update((prev) => withCustomRange(prev, target, next))
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
  /*
   * One end fixed, one end chosen.
   *
   * The baseline tile used to have no control at all, on the grounds that a
   * comparison with both ends moving is not a comparison - wired to the old
   * shared window it read +321% on "past week" and +295% on "past year", the
   * same claim with two numbers. That reasoning was right about the first
   * year and wrong about the recent end: those two figures are not one claim
   * told badly, they are two different and equally true claims, and the only
   * thing missing was a caption that said which window each was about.
   *
   * So the first year stays fixed and the control chooses what is held
   * against it. "All time" is deliberately not offered: it contains the first
   * year, so the comparison would be partly against itself.
   */
  const baselineRange = rangeFor(layout, 'baseline')
  const baselineDef = windowDefFor(baselineRange, parseSpan(customTextFor(layout, 'baseline')).days)
  const recent = rangeOf(baselineDef, today, data.firstDate)
  const recentPerDay = recent === null ? null : averagePerDay(data.daily, recent).perDay
  const above = recentPerDay === null ? null : aboveBaseline(recentPerDay, base)

  /*
   * The insights card over its own range.
   *
   * It keeps the fun fact's range target, `fact`, so a range chosen for the
   * fun fact carries over. Every insight is built from dated sessions, so
   * unlike the fun fact - which had to drop its lifetime figures on a
   * narrowed range - all of them follow the control.
   */
  const factRange = rangeFor(layout, 'fact')
  const factCustomDays = parseSpan(customTextFor(layout, 'fact')).days
  const factSpan = spanOf(factRange, today, data.firstDate, factCustomDays)
  const factLabel = windowDefFor(factRange, factCustomDays).label

  const glanceRow = (
    <div className="an-stats">
      {/* The box, in the place the two tiles it replaces used to take. */}
      <CompareBox
        daily={data.daily}
        today={today}
        firstDate={data.firstDate}
        choice={layout.compare}
        onChoice={(next) => update((prev) => ({ ...prev, compare: next }))}
        customText={layout.compare.custom}
        onCustomText={(next) =>
          update((prev) => ({ ...prev, compare: { ...prev.compare, custom: next } }))
        }
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
            {/* The window is named rather than called "now". With a control
                    on the recent end, "2.93 h now" would be the same three
                    words over a figure that changes by a factor of two
                    depending on a dropdown - which is exactly the ambiguity
                    this tile was criticised for before it had one. */}
            against your first year &middot; {base?.perDay.toFixed(2)} h a day then,{' '}
            {recentPerDay === null
              ? ''
              : `${recentPerDay.toFixed(2)} h a day over the ${baselineDef.label}`}
          </span>
          <RangePicker
            value={baselineRange}
            onChange={(next) => setRange('baseline', next)}
            label="the window compared with your first year"
            disabled={BASELINE_DISABLED}
            customText={customTextFor(layout, 'baseline')}
            onCustomText={(next) => setCustom('baseline', next)}
          />
        </div>
      )}

      {opening !== null && (
        <InsightCard
          // Optional-chained although the type says it is there: a payload
          // from a main process built before this field existed has none,
          // and the card must not be able to take the tab down with it.
          rows={data.sessionRows ?? []}
          range={factSpan}
          label={factLabel}
          today={today}
          seed={opening.seed}
          avoid={opening.avoid}
          rangeId={factRange}
          onRange={(next) => setRange('fact', next)}
          customText={customTextFor(layout, 'fact')}
          onCustomText={(next) => setCustom('fact', next)}
        />
      )}
    </div>
  )

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

      {/*
       * "At a glance" is a section like the others and moves with them.
       *
       * It used to be rendered above the loop, because it holds the figure
       * row rather than a grid of panels - which also meant its heading was
       * the one header that could not be dragged. The user asked to move
       * the headers around and named this one in the list, so it goes
       * through the same loop and the same drag group; only its body
       * differs.
       */}
      {/*
       * Sections are rendered in the layout's order and are draggable as
       * whole units; panels drag within their own section. Two groups, one
       * engine - `useArrange` is given a group name and a key, and does not
       * know what either is.
       */}
      {arrange.orderOf('sections', layout.sections).map((id, index) => {
        const sectionId = id as SectionId
        const section = SECTIONS.find((one) => one.id === sectionId)
        if (section === undefined) return null
        const ids = panelsInSection(layout, sectionId)
        // A section with every panel hidden renders nothing at all, not an
        // empty heading. `glance` is the exception: its body is the figure
        // row, which is never hidden.
        if (sectionId !== 'glance' && ids.length === 0) return null
        const lifted = arrange.dragging?.group === 'sections' && arrange.dragging.key === sectionId
        return (
          <div
            key={sectionId}
            ref={arrange.ref('sections', sectionId)}
            className={`an-section${editing ? ' is-arranging' : ''}${lifted ? ' is-lifted' : ''}`}
            style={arrange.liftStyle('sections', sectionId)}
          >
            <h3
              className={`an-section__title${index === 0 ? ' an-section__title--first' : ''}`}
              {...(editing ? arrange.grab('sections', sectionId) : {})}
            >
              {editing && (
                <span className="an-section__grip" aria-hidden="true">
                  <Icon name="grip" />
                </span>
              )}
              {section.title}
            </h3>
            {sectionId === 'glance' ? (
              glanceRow
            ) : (
              <div className={`an${editing ? ' is-arranging' : ''}`}>
                {arrange.orderOf(sectionId, ids).map((id) => (
                  <Slot
                    key={id}
                    id={id as PanelId}
                    editing={editing}
                    lifted={arrange.dragging?.group === sectionId && arrange.dragging.key === id}
                    grab={arrange.grab(sectionId, id)}
                    slotRef={arrange.ref(sectionId, id)}
                    style={arrange.liftStyle(sectionId, id)}
                    layout={layout}
                    onChange={update}
                  >
                    {panelFor(id as PanelId, data, accent, today, layout, setRange, setCustom)}
                  </Slot>
                ))}
              </div>
            )}
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
  /** Laps of a loop, as typed. Planned is one lap; the total is derived. */
  laps: string
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
    laps: String(row?.laps ?? 1),
    actual: row ? formatDurationInput(row.running_duration_s * 1000) : '',
    work_quantity: row?.work_quantity == null ? '' : String(row.work_quantity),
    work_unit: row?.work_unit ?? '',
    notes: row?.notes ?? '',
    source: row?.source ?? 'manual'
  }
}

/** Which form field each validation label belongs to. */
const FIELD_LABEL: Partial<Record<keyof FormState, string>> = {
  session_date: 'Date',
  project: 'Project',
  task: 'Task',
  planned: 'Planned',
  laps: 'Laps',
  actual: 'Actual'
}

/**
 * The add and edit form.
 *
 * **What it says, it says in the app.** A missing or unreadable field is
 * outlined in red and named in a red line under the buttons; a save the main
 * process refuses is reported in the same line. It used to raise a Windows
 * dialog for both, which the user rejected for breaking the app's look:
 * information belongs in the app's own UI (CLAUDE.md, "The app speaks for
 * itself").
 *
 * **Planned is the goal; laps and total sit beside it.** The point of these
 * timers is to set slightly less time than the work seems to need, so the
 * figure worth keeping is what was set. A loop repeats that setting, so it is
 * entered as planned plus laps, and the total is shown rather than typed.
 *
 * **The button is never disabled.** A disabled button with a grey line
 * beside it is how a session went unsaved on 11/05/2026 with nothing to say
 * so. Clicking always either saves or says, in red, what is in the way.
 */
function SessionForm({
  row,
  onSave,
  onCancel
}: {
  row: SessionRow | null
  /** Resolves to null when saved, or to what went wrong. */
  onSave: (patch: Record<string, unknown>) => Promise<string | null>
  onCancel: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<FormState>(() => toForm(row))
  const [projectNames, setProjectNames] = useState<string[]>([])
  const [projectOpen, setProjectOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [invalid, setInvalid] = useState<Set<string>>(() => new Set())
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.timer
      .projectNames()
      .then(setProjectNames)
      .catch(() => setProjectNames([]))
  }, [])

  const plannedMs = parseDurationMs(form.planned)
  const actualMs = parseDurationMs(form.actual)
  const laps = form.laps === '' ? null : Number(form.laps)
  const totalMs = plannedMs !== null && laps !== null && laps >= 1 ? plannedMs * laps : null
  // The same ranking the timer's project field uses, so `hw`, `HW 2` and a
  // typo offer the same project here as they do there.
  const matches = rankProjects(form.project, projectNames, 4)

  // A new session needs all six; an edit keeps the smaller rule, because an
  // imported row with no project must stay fixable one field at a time.
  const required = new Set(
    row ? ['Date', 'Laps', 'Actual'] : ['Date', 'Project', 'Task', 'Planned', 'Laps', 'Actual']
  )

  function set<K extends keyof FormState>(key: K, value: string): void {
    setForm((current) => ({ ...current, [key]: value }))
    // Fixing a field takes its outline away at once, rather than leaving the
    // red until the next attempt to save.
    const label = FIELD_LABEL[key]
    if (label && invalid.has(label)) {
      setInvalid((current) => {
        const next = new Set(current)
        next.delete(label)
        return next
      })
    }
  }

  function chooseProject(name: string): void {
    set('project', name)
    setProjectOpen(false)
  }

  function patch(): Record<string, unknown> {
    return {
      session_date: form.session_date,
      // Sent as the typed name; main resolves it against the existing
      // projects, so it never starts a duplicate of one.
      project: form.project.trim() === '' ? null : form.project.trim(),
      task: form.task.trim() === '' ? null : form.task.trim(),
      // An edit may leave planned blank and keep actual for it, since an
      // imported row was not always planned; a new session must give both.
      planned_duration_s: Math.round((plannedMs ?? (row ? actualMs : null) ?? 0) / 1000),
      laps: laps ?? 0,
      running_duration_s: Math.round((actualMs ?? 0) / 1000),
      work_quantity: form.work_quantity === '' ? null : Number(form.work_quantity),
      work_unit: form.work_unit.trim() === '' ? null : form.work_unit.trim(),
      notes: form.notes.trim() === '' ? null : form.notes.trim(),
      ...(row ? { source: form.source } : {})
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (saving) return
    const next = patch()
    // Text that is there but cannot be read as a duration is said as that,
    // not as "required" - the field is not empty, and saying so would send
    // the user looking for the wrong problem.
    const unreadable = [
      ...(form.planned.trim() !== '' && plannedMs === null ? ['Planned'] : []),
      ...(form.actual.trim() !== '' && actualMs === null ? ['Actual'] : [])
    ]
    const missing = (row ? missingForEdit(next) : missingForNewSession(next)).filter(
      (label) => !unreadable.includes(label)
    )
    if (missing.length > 0 || unreadable.length > 0) {
      setInvalid(new Set([...missing, ...unreadable]))
      const parts = [
        missing.length > 0
          ? `${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} required.`
          : null,
        unreadable.length > 0
          ? `${listOf(unreadable)} could not be read as a duration - try 1:30:00, 90 min or 1h30m.`
          : null
      ]
      setMessage(`${parts.filter(Boolean).join(' ')} Nothing was ${row ? 'saved' : 'added'}.`)
      return
    }
    setInvalid(new Set())
    setMessage(null)
    setSaving(true)
    const problem = await onSave(next)
    setSaving(false)
    if (problem !== null) setMessage(`${problem} Nothing was ${row ? 'saved' : 'added'}.`)
  }

  function fieldClass(label: string, wide = false): string {
    return `field field--inline${wide ? ' field--wide' : ''}${invalid.has(label) ? ' field--invalid' : ''}`
  }

  /** The label, with an asterisk when the field is required. */
  function caption(label: string): React.JSX.Element {
    return (
      <span>
        {label}
        {required.has(label) && (
          <span className="req" aria-label="required">
            *
          </span>
        )}
      </span>
    )
  }

  return (
    // A form, so Enter in any field submits and is checked like a click.
    <form className="editor" onSubmit={(event) => void submit(event)} noValidate>
      <h3>{row ? `Edit session ${row.id}` : 'Add a session'}</h3>
      <p className="muted">
        {row
          ? 'Changes apply to the row in place, and can be undone.'
          : 'For work that was not timed, such as a meeting entered afterwards. Saved as a manual session; time-of-day charts leave it out, since its times are from memory.'}{' '}
        <span className="req">*</span> required.
      </p>

      {/* Two fixed columns rather than auto-fit. Auto-fit packed four
          label-and-field pairs onto one line and each field kept the
          browser's default width, so every label sat inside the field to its
          left and Unit ran off the card. Pairs that belong together share a
          line, in the order the numbers are thought about: the goal and how
          many times it was set, then the total that makes and what it took. */}
      <div className="editor__grid">
        <label className={fieldClass('Date')}>
          {caption('Date')}
          {/* The same native picker as the filters: it shows MM/DD/YYYY and
              stores the ISO date, which is what the column holds. */}
          <input
            type="date"
            value={form.session_date}
            onChange={(e) => set('session_date', e.target.value)}
          />
        </label>
        <div className={fieldClass('Project')}>
          {caption('Project')}
          <span className="project-box">
            <input
              value={form.project}
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
        <label className={fieldClass('Task', true)}>
          {caption('Task')}
          <input value={form.task} onChange={(e) => set('task', e.target.value)} />
        </label>
        <label className={fieldClass('Planned')}>
          {caption('Planned')}
          {/* An example, not a value: "e.g." in front, because an example
              that looks like an answer is how an empty field once read as
              filled. */}
          <input
            value={form.planned}
            placeholder="e.g. 45:00 or 45 min"
            onChange={(e) => set('planned', e.target.value)}
          />
        </label>
        <label className={fieldClass('Laps')}>
          {caption('Laps')}
          <input
            value={form.laps}
            inputMode="numeric"
            onChange={(e) => {
              // A count: digits only, and empty is allowed so it can be cleared.
              if (/^\d{0,3}$/.test(e.target.value)) set('laps', e.target.value)
            }}
          />
        </label>
        <div className="field field--inline">
          <span>Total planned</span>
          {/* Shown, not typed: it is planned times laps, and a second field
              holding it would be a second place for it to be wrong. */}
          <output className="editor__computed">
            {totalMs === null ? '—' : formatDurationInput(totalMs)}
          </output>
        </div>
        <label className={fieldClass('Actual')}>
          {caption('Actual')}
          <input
            value={form.actual}
            placeholder="e.g. 1:10:00"
            onChange={(e) => set('actual', e.target.value)}
          />
        </label>
        <label className="field field--inline">
          {caption('Quantity')}
          <input
            value={form.work_quantity}
            inputMode="decimal"
            onChange={(e) => {
              if (/^\d{0,7}(\.\d{0,2})?$/.test(e.target.value)) set('work_quantity', e.target.value)
            }}
          />
        </label>
        <label className="field field--inline">
          {caption('Unit')}
          <input
            value={form.work_unit}
            onChange={(e) => set('work_unit', e.target.value.replace(/[0-9]/g, ''))}
          />
        </label>
        <label className="field field--inline field--wide">
          {caption('Notes')}
          <input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
        {row && (
          <label className="field field--inline">
            {caption('Source')}
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
        <button type="submit" className="action action--primary">
          {row ? 'Save' : 'Add session'}
        </button>
        <button type="button" className="action" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {message !== null && (
        <p className="editor__error" role="alert">
          {message}
        </p>
      )}
    </form>
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
  const [loadError, setLoadError] = useState<string | null>(null)
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
    try {
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
      setLoadError(null)
    } catch (error) {
      setLoadError(cleanError(error))
    }
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
    ])
      .then(([next, state, options]) => {
        if (!live) return
        setPage(next as SessionPage)
        setHistory(state)
        setProjects(options)
        setLoadError(null)
      })
      // This had no catch. On 11/06/2026 the query failed and the tab sat on
      // "Loading..." indefinitely, which reads as "you have no data" - the
      // worst thing this tab can say. A failure is now said as one.
      .catch((error) => {
        if (live) setLoadError(cleanError(error))
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

  /**
   * A failed save says so and keeps the form, with everything typed still in
   * it. This used to have no catch: a rejected write vanished, the form sat
   * there looking ready, and the session simply did not exist.
   */
  /**
   * Resolves to null once saved, or to what went wrong - which the form shows
   * in its own red line. It used to raise a Windows dialog; the app says what
   * it has to say in its own UI.
   */
  async function save(patch: Record<string, unknown>): Promise<string | null> {
    try {
      if (editing === 'new') await window.api.sessions.create(patch)
      else if (editing) await window.api.sessions.update(editing.id, patch)
    } catch (error) {
      return cleanError(error)
    }
    setEditing(null)
    await refresh()
    return null
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

  if (loadError !== null && page === null) {
    return (
      <section className="panel">
        <h2>Sessions</h2>
        <p>
          <strong>Your sessions could not be loaded.</strong> They are still saved; this is the app
          failing to read them, not data that is gone.
        </p>
        <p className="muted">{loadError}</p>
        <div className="row">
          <button className="action action--primary" onClick={() => void refresh()}>
            Try again
          </button>
          <button className="action" onClick={() => void window.api.log.reveal()}>
            Open the error log
          </button>
        </div>
      </section>
    )
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
          {/* Hidden while the form is open. It used to stay, so the page had
              two blue "Add session" buttons, and this one - the bigger, more
              obvious one - only opens the form: clicking it with a filled
              form did nothing, and that is how a session went unsaved on
              11/05/2026. The form's own button is the only one now. */}
          {editing === null && (
            <button className="action action--primary action--sm" onClick={() => setEditing('new')}>
              Add session
            </button>
          )}
        </div>
      </div>

      {editing !== null && (
        <SessionForm
          row={editing === 'new' ? null : editing}
          onSave={save}
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
              <th className="num">Laps</th>
              <th className="num" title="Planned × laps">
                Total
              </th>
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
                {/* Planned is what the timer was set to - the goal, which
                    for these timers is deliberately a little less than the
                    work seems to need. Laps and the total it makes sit
                    beside it rather than inside one figure, so the goal can
                    be read on its own against what it actually took. */}
                <td className="num">{hours(row.planned_duration_s)}</td>
                <td className="num">
                  {row.laps > 1 ? row.laps : <span className="muted">1</span>}
                </td>
                <td className="num">
                  {row.laps > 1 ? (
                    hours(row.planned_duration_s * row.laps)
                  ) : (
                    <span className="muted">{hours(row.planned_duration_s)}</span>
                  )}
                </td>
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
