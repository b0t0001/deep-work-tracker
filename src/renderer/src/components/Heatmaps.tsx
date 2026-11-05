/**
 * Two heatmaps for the Analytics tab: the calendar grid and the time-of-day
 * strip.
 *
 * Both are pure and props-driven. They take the aggregates the main process
 * already computed and draw them - nothing here reads the database, sums a
 * total or fills a gap. `daily` arrives gap-filled from `fillDays`, which is
 * where that work belongs (CLAUDE.md: trend maths lives in `src/shared`, not
 * inside components).
 *
 * Styling is inline rather than in `main.css`. Partly ownership, but mostly
 * because nearly every value here is computed from the accent and the data, so
 * it could not live in a static rule anyway. A `<style>` block was the other
 * option and is worse: React would re-emit it once per mounted instance.
 */

import { useMemo, useState } from 'react'
import type { DayTotal, HourTotal } from '@shared/analytics'
import { EmptyState } from './AnalyticsCharts'
import { formatDate, formatDateRange } from '@shared/dates'

const DAY_MS = 86_400_000

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * These dates are local calendar labels (`session_date`), not instants, so they
 * are converted through UTC midnight the same way `shared/analytics` does. A
 * local parse would shift by the offset and move a day across a DST boundary,
 * which in a grid keyed by weekday shears every column after it by one row.
 */
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

function dateString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

/** Monday = 0, to put Monday at the top. Epoch day 0 was a Thursday. */
function weekdayRow(day: number): number {
  return (day + 3) % 7
}

/** `3.25`, not `3.25000000001` and not `3.00`. */
function formatHours(hours: number): string {
  return String(Number(hours.toFixed(2)))
}

/** Grouped, because the session counts here reach four figures. */
function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Worked cells are the accent mixed *towards* the empty-cell colour rather than
 * the accent at a low alpha. Over a near-black surface a 20%-alpha accent
 * composites darker than `--surface-raised`, so the faintest worked day would
 * read as less than a day with no work at all - the scale would run backwards
 * at its bottom end. Mixing guarantees the ramp starts just above empty and
 * ends at the accent itself, for any of the seven stones.
 */
const MIX_PERCENT = [22, 45, 70, 100]

function cellFill(level: number, accent: string): string {
  if (level <= 0) return 'var(--surface-raised)'
  return `color-mix(in srgb, ${accent} ${MIX_PERCENT[level - 1]}%, var(--surface-raised))`
}

function level(value: number, scale: number): number {
  if (value <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((value / scale) * 4)))
}

const labelStyle: React.CSSProperties = { fill: 'var(--text-dim)', fontSize: 10 }

const noteStyle: React.CSSProperties = {
  color: 'var(--text-dim)',
  fontSize: 12,
  lineHeight: 1.55,
  margin: '8px 0 0',
  maxWidth: '62ch'
}

/** Shared by both grids, so a cell means the same thing in either one. */
function Legend({ accent }: { accent: string }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        color: 'var(--text-dim)',
        fontSize: 11
      }}
    >
      <span>Less</span>
      {[0, 1, 2, 3, 4].map((step) => (
        <span
          key={step}
          style={{
            width: 11,
            height: 11,
            borderRadius: 2,
            background: cellFill(step, accent)
          }}
        />
      ))}
      <span>More</span>
    </div>
  )
}

/* ---------- calendar ---------- */

const CELL = 12
const GAP = 3
const PITCH = CELL + GAP
/** Room for an end-aligned `M` / `W` / `F`. */
const WEEKDAY_W = 24
const MONTH_H = 16

/*
 * Three and a half years is about 183 weeks. Drawn in full inside the 1500px
 * panel that is roughly 8px a column: cells too small to aim at, and month
 * boundaries about four columns apart with no room for a three-letter name. The
 * one thing the grid exists for - reading the shape of a year at a glance - is
 * the first thing lost.
 *
 * So it shows a rolling 53-week window ending on the most recent day, at a cell
 * size that stays legible, and pages back a window at a time. The default is the
 * trailing window for the same reason the Data tab lands on the 100 most recent
 * sessions: recent is the question the tab is opened to answer. But CLAUDE.md's
 * rule about that table applies here too - a cap that silently hides the rest
 * and leaves no way to reach it is the failure mode - so the older years are
 * paged to rather than dropped.
 *
 * 53 weeks and not 52 because a year is 52 weeks plus a day or two: at 52 the
 * window creeps and the same date drifts a column every year.
 */
const WINDOW_DAYS = 371

/**
 * Four levels off the 90th percentile of worked days, not the maximum. One
 * fourteen-hour day would otherwise set the top of the scale and drop every
 * ordinary three-hour day into the faintest bucket, so the grid would report
 * that the user has worked properly once.
 *
 * The percentile is taken over the whole history rather than the visible
 * window, so a day keeps its colour when you page back a year. Rebasing per
 * page would make two windows uncomparable, which is most of what a heatmap is
 * for.
 */
function percentileHours(daily: DayTotal[]): number {
  const worked = daily
    .filter((d) => d.hours > 0)
    .map((d) => d.hours)
    .sort((a, b) => a - b)
  if (worked.length === 0) return 1
  return worked[Math.min(worked.length - 1, Math.floor(worked.length * 0.9))] || 1
}

function dayTitle(day: DayTotal): string {
  if (day.hours <= 0 && day.sessions === 0) return `${formatDate(day.date)} — no work`
  return `${formatDate(day.date)} — ${formatHours(day.hours)} h, ${plural(day.sessions, 'session')}`
}

function monthYear(date: string): string {
  const [y, m] = date.split('-')
  return `${MONTHS[Number(m) - 1]} ${y}`
}

export function CalendarHeatmap({
  daily,
  accent
}: {
  daily: DayTotal[]
  accent: string
}): React.JSX.Element {
  /** Windows back from the most recent one. Zero is the default view. */
  const [page, setPage] = useState(0)

  const scale = useMemo(() => percentileHours(daily), [daily])
  const totals = useMemo(() => new Map(daily.map((d) => [d.date, d])), [daily])

  if (daily.length === 0) {
    return (
      <p style={noteStyle}>
        No sessions yet, so there is nothing to plot. The grid fills in a square a day once the
        history has something in it.
      </p>
    )
  }

  const firstDay = dayNumber(daily[0].date)
  const lastDay = dayNumber(daily[daily.length - 1].date)
  const maxPage = Math.floor((lastDay - firstDay) / WINDOW_DAYS)
  // The page is clamped at render rather than only when it is set, so a filter
  // that shortens the history under a deep page shows the oldest window
  // instead of an empty grid.
  const safePage = Math.min(Math.max(page, 0), maxPage)

  const windowEnd = lastDay - WINDOW_DAYS * safePage
  // Clamped to the first real day, so a history of one week draws one week
  // rather than a year of blanks around it.
  const windowStart = Math.max(firstDay, windowEnd - (WINDOW_DAYS - 1))
  const gridStart = windowStart - weekdayRow(windowStart)
  const columns = Math.ceil((windowEnd - gridStart + 1) / 7)

  const width = WEEKDAY_W + columns * PITCH - GAP
  const height = MONTH_H + 7 * PITCH - GAP

  const cells: React.JSX.Element[] = []
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < 7; row += 1) {
      const day = gridStart + column * 7 + row
      if (day < windowStart || day > windowEnd) continue
      const total = totals.get(dateString(day))
      // `daily` is gap-filled, so a miss means a date outside the data rather
      // than a zero day. Drawing it would invent a day that was never recorded.
      if (!total) continue
      cells.push(
        <rect
          key={day}
          x={WEEKDAY_W + column * PITCH}
          y={MONTH_H + row * PITCH}
          width={CELL}
          height={CELL}
          rx={2}
          style={{ fill: cellFill(level(total.hours, scale), accent) }}
        >
          {/* SVG takes its tooltip from a `<title>` child; the HTML `title`
              attribute does nothing here. */}
          <title>{dayTitle(total)}</title>
        </rect>
      )
    }
  }

  const monthLabels: Array<{ x: number; text: string }> = []
  let previousMonth = ''
  let lastLabelColumn = -99
  for (let column = 0; column < columns; column += 1) {
    const month = dateString(Math.max(gridStart + column * 7, windowStart)).slice(5, 7)
    // Three columns is about the width of `Sep`, so a label is skipped rather
    // than overprinting the one before it - which only happens at the very
    // start of the window, where the first column is a part-month stub.
    if (month !== previousMonth && column - lastLabelColumn >= 3) {
      monthLabels.push({ x: WEEKDAY_W + column * PITCH, text: MONTHS[Number(month) - 1] })
      lastLabelColumn = column
    }
    previousMonth = month
  }

  const pagerButton = (
    label: string,
    glyph: string,
    delta: number,
    disabled: boolean
  ): React.JSX.Element => (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={() => setPage(safePage + delta)}
      style={{
        width: 22,
        height: 22,
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--text-dim)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1
      }}
    >
      {glyph}
    </button>
  )

  return (
    <div className="an-panel an-panel--hero">
      <div className="an-panel__head">
        <h4 className="an-panel__title">
          Every day
          <span className="an-panel__sub">
            {monthYear(dateString(windowStart))} – {monthYear(dateString(windowEnd))}
          </span>
        </h4>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: 'var(--text-dim)',
            fontSize: 12
          }}
        >
          <Legend accent={accent} />
          {pagerButton('Earlier', '‹', 1, safePage >= maxPage)}
          {pagerButton('Later', '›', -1, safePage <= 0)}
        </div>
      </div>

      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        /* Scales to the panel rather than sitting at its drawn 840px. The user
           asked for this chart specifically and it was the faintest thing on
           the tab, leaving a third of the row empty beside it; letting the
           viewBox fill the width roughly doubles the cell area and makes it
           the one chart you see first. `height: auto` keeps the squares
           square at any width. */
        style={{ display: 'block', width: '100%', height: 'auto' }}
        role="img"
        aria-label="Hours worked per day"
      >
        {monthLabels.map((label) => (
          <text key={label.text + label.x} x={label.x} y={MONTH_H - 5} style={labelStyle}>
            {label.text}
          </text>
        ))}
        {[
          [0, 'M'],
          [2, 'W'],
          [4, 'F']
        ].map(([row, text]) => (
          <text
            key={text}
            x={WEEKDAY_W - 7}
            y={MONTH_H + Number(row) * PITCH + CELL - 2}
            textAnchor="end"
            style={labelStyle}
          >
            {text}
          </text>
        ))}
        {cells}
      </svg>

      <p className="an-panel__note">
        Darker is more hours. Hover a square for the day it stands for; the arrows page back a year
        at a time.
      </p>
    </div>
  )
}

/* ---------- time of day ---------- */

const HOUR_CELL_W = 30
const HOUR_CELL_H = 30
const HOUR_GAP = 4
const HOUR_PITCH = HOUR_CELL_W + HOUR_GAP
const HOUR_LABEL_H = 18

/** `12a`, `6a`, `12p`, `6p` - nobody reads a day in 0..23. */
function hourLabel(hour: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}${hour < 12 ? 'a' : 'p'}`
}

/**
 * Few enough sessions to be worth saying so out loud. Thirty is about a
 * fortnight of ordinary use; below that the peak hour is as likely to be when
 * the user happened to try the app as when they actually focus.
 */
const FEW_SESSIONS = 30

export function TimeOfDayHeatmap({
  byHour,
  timedSessions,
  timedFirst,
  timedLast,
  accent
}: {
  byHour: HourTotal[]
  timedSessions: number
  /** First and last local dates the counted rows fall on; null when none. */
  timedFirst: string | null
  timedLast: string | null
  accent: string
}): React.JSX.Element {
  const hours = useMemo(() => {
    const found = new Map(byHour.map((h) => [h.hour, h]))
    return Array.from(
      { length: 24 },
      (_, hour): HourTotal => found.get(hour) ?? { hour, hours: 0, sessions: 0 }
    )
  }, [byHour])

  /*
   * The hard requirement from CLAUDE.md: the imported spreadsheet's Start and
   * End are readings off a countdown, not clock times, so 3.5 years of history
   * has a date and no time of day. An empty grid here would read as "you never
   * work" when what it means is "this app has not timed anything yet", so with
   * nothing to chart the chart is replaced by the explanation rather than drawn
   * blank.
   */
  // The maximum, where the calendar used a percentile: 24 buckets over the
  // whole history each aggregate many sessions, so there is no single outlier
  // day to flatten the scale.
  const scale = Math.max(...hours.map((h) => h.hours), 0) || 1
  const width = 24 * HOUR_PITCH - HOUR_GAP
  const height = HOUR_CELL_H + HOUR_LABEL_H

  /*
   * The dates the counted rows actually fall on.
   *
   * A row count on its own invites the wrong reading: "3 sessions" sounds
   * like three points spread over the history, when all three are one
   * evening. The span is what tells you the chart is one evening's worth,
   * and it keeps working unchanged once there are real dates to show.
   *
   * `all on` rather than a range when they share a day, because
   * "2026-10-02 to 2026-10-02" reads like a bug.
   */
  const span =
    timedFirst === null || timedLast === null
      ? ''
      : timedFirst === timedLast
        ? `, all on ${formatDate(timedFirst)}`
        : `, ${formatDateRange(timedFirst, timedLast)}`

  /*
   * Below the threshold the grid is not drawn at all.
   *
   * Three sessions in one evening rendered as a real heatmap is 23 empty cells
   * and one lit one, which reads as a broken widget rather than as a chart
   * waiting for data - and the lit cell invites exactly the reading the data
   * cannot support. So the slot keeps its shape as a dashed outline, the hours
   * that do have something are marked, and the sentence becomes the content
   * instead of a footnote under a misleading picture.
   *
   * The track is still drawn rather than hidden: a panel that disappears until
   * it has data cannot teach anyone that the feature exists.
   */
  if (timedSessions < FEW_SESSIONS) {
    return (
      <div className="an-panel">
        <div className="an-panel__head">
          <h4 className="an-panel__title">
            Time of day
            <span className="an-panel__sub">not enough data yet</span>
          </h4>
        </div>

        <div className="an-track">
          {hours.map((hour) => (
            <span
              key={hour.hour}
              className={hour.sessions > 0 ? 'is-on' : undefined}
              title={
                hour.sessions > 0
                  ? `${hourLabel(hour.hour)}–${hourLabel((hour.hour + 1) % 24)} — ${plural(hour.sessions, 'session')}`
                  : `${hourLabel(hour.hour)}–${hourLabel((hour.hour + 1) % 24)} — nothing yet`
              }
            />
          ))}
        </div>
        <div className="an-track__axis">
          <span>12a</span>
          <span>6a</span>
          <span>12p</span>
          <span>6p</span>
          <span>11p</span>
        </div>

        <EmptyState
          title={
            timedSessions === 0
              ? 'Nothing timed by this app yet'
              : `${plural(timedSessions, 'session')} timed by this app${span}`
          }
          progress={timedSessions / FEW_SESSIONS}
        >
          {timedSessions > 0 && timedFirst !== null && timedFirst === timedLast
            ? 'One afternoon is not a pattern. '
            : ''}
          This fills in as the app records sessions itself. The imported history never can:
          Hourglass stored a countdown reading rather than a clock time, so those rows carry a date
          and no hour.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="an-panel">
      <div className="an-panel__head">
        <h4 className="an-panel__title">
          Time of day
          <span className="an-panel__sub">
            {plural(timedSessions, 'session')} this app timed itself
          </span>
        </h4>
        <Legend accent={accent} />
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
        role="img"
        aria-label="Hours worked by hour of the local day"
      >
        {hours.map((hour) => (
          <rect
            key={hour.hour}
            x={hour.hour * HOUR_PITCH}
            y={0}
            width={HOUR_CELL_W}
            height={HOUR_CELL_H}
            rx={3}
            style={{ fill: cellFill(level(hour.hours, scale), accent) }}
          >
            <title>
              {hour.hours > 0
                ? `${hourLabel(hour.hour)}–${hourLabel((hour.hour + 1) % 24)} — ${formatHours(hour.hours)} h, ${plural(hour.sessions, 'session')}`
                : `${hourLabel(hour.hour)}–${hourLabel((hour.hour + 1) % 24)} — no work`}
            </title>
          </rect>
        ))}
        {/* Every third hour: enough to orient by without the labels touching. */}
        {hours
          .filter((hour) => hour.hour % 3 === 0)
          .map((hour) => (
            <text
              key={hour.hour}
              x={hour.hour * HOUR_PITCH + HOUR_CELL_W / 2}
              y={height - 5}
              textAnchor="middle"
              style={labelStyle}
            >
              {hourLabel(hour.hour)}
            </text>
          ))}
      </svg>

      <p className="an-panel__note">
        {`Covers the ${plural(timedSessions, 'session')} this app timed itself${span}. `}
        Imported rows are excluded: they carry a date but no clock time, so they cannot say anything
        about when the work happened.
      </p>
    </div>
  )
}
