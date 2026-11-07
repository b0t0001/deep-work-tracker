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

import { DAILY_TARGET_HOURS, dayFill, isSuperstar, SUPERSTAR_HOURS } from '@shared/dayShade'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { DayTotal, HourTotal } from '@shared/analytics'
import { EmptyState, TipBox, type TipRow } from './AnalyticsCharts'
import { formatDate, formatDateRange } from '@shared/dates'

const DAY_MS = 86_400_000

/**
 * The hover box these two share with the charts.
 *
 * Their hover text used to be an svg `<title>`, which the OS draws: a
 * different font, a different delay, a different corner of the screen, and
 * nothing about it stylable. Two tooltip designs in one tab is the kind of
 * difference the user notices before anyone else does, so these now show the
 * same `TipBox` the charts do.
 *
 * ## What is positioned against what
 *
 * The box is placed in the panel's coordinates, not the page's, because it is
 * a child of the panel - and the panel is what it must stay inside. The
 * hovered cell's rect and the panel's rect both come from the DOM at hover
 * time rather than from the svg's own units: the grid is scaled by
 * `maxWidth`, so a cell's position in viewBox units is not its position on
 * screen, and the two disagree by whatever the scale factor happens to be.
 *
 * ## Why it is not an svg `<title>`, a `<foreignObject>` or a portal
 *
 * A `<title>` is what is being replaced. A `<foreignObject>` would inherit
 * the svg's scale, so the box would grow and shrink with the grid. A portal
 * to `document.body` would escape the panel, which is the one thing the box
 * must not do - "stay inside the panel near the edges" is the requirement,
 * and clamping against a rectangle the box is not inside is harder than
 * staying a child of it.
 */
/**
 * The two rules that cannot be inline.
 *
 * The rest of this file styles by object, because nearly every value is
 * computed from the accent and the data. These two cannot be: one is a
 * pseudo-class and the other has to apply *before* the hover box exists.
 * They lived in `TOOLTIP_CSS` first, which is rendered by the box itself -
 * so the panel was not a containing block until the first tip appeared, and
 * the hovered square did not light up until one had. Rendered per panel
 * rather than once globally, which is what the charts already do.
 */
const HEATMAP_CSS = `
.hm {
  position: relative;
}
/*
 * The hovered square takes a thin stroke rather than a rectangle behind it.
 *
 * The user's objection to the chart cursor was a grey block appearing
 * *behind* the thing hovered, which reads as a selection they did not make.
 * A stroke on the square's own edge reads as the square lighting up - it
 * says "this one" without adding a second shape. On the track in the empty
 * state the same job is done by a border, since those cells are spans.
 */
.hm-cell:hover {
  stroke: var(--text);
  stroke-width: 1.5;
  stroke-opacity: 0.85;
}
span.hm-cell:hover {
  box-shadow: inset 0 0 0 1.5px #f2f4f7d9;
}
/* A superstar day: a crisp white ring and a soft glow in the accent, on top of
   its colour. Static on purpose - a pulsing square would keep the page
   repainting while it is on screen, against the rule that Analytics costs
   nothing when nothing is changing. */
.hm-star {
  stroke: #ffffff;
  stroke-width: 1.25;
  stroke-opacity: 0.9;
  filter: drop-shadow(0 0 3px var(--accent));
}
`

interface HoverTip {
  caption: string
  rows: TipRow[]
  note?: string
  /** Panel-relative, already clamped. */
  left: number
  top: number
}

const TIP_WIDTH = 170
const TIP_GAP = 10

function useHoverTip(): {
  tip: HoverTip | null
  show: (
    event: React.MouseEvent | React.FocusEvent,
    caption: string,
    rows: TipRow[],
    note?: string
  ) => void
  hide: () => void
  panelRef: (element: HTMLDivElement | null) => void
} {
  const [tip, setTip] = useState<HoverTip | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)

  const panelRef = useCallback((element: HTMLDivElement | null) => {
    panel.current = element
  }, [])

  const show = useCallback(
    (
      event: React.MouseEvent | React.FocusEvent,
      caption: string,
      rows: TipRow[],
      note?: string
    ) => {
      const box = panel.current
      const cell = event.currentTarget as Element
      if (box === null) return
      const panelBox = box.getBoundingClientRect()
      const cellBox = cell.getBoundingClientRect()

      // Beside the square by default, and above it, which is where a cursor
      // is not. Clamped to the panel on both axes: at the right-hand edge of
      // a 52-week grid the box would otherwise run off the panel and be
      // clipped by its border radius.
      const wanted = cellBox.left - panelBox.left + cellBox.width + TIP_GAP
      const left = Math.max(TIP_GAP, Math.min(wanted, panelBox.width - TIP_WIDTH - TIP_GAP))
      const top = Math.max(TIP_GAP, cellBox.top - panelBox.top - TIP_GAP)
      setTip({ caption, rows, note, left, top })
    },
    []
  )

  const hide = useCallback(() => setTip(null), [])

  return { tip, show, hide, panelRef }
}

/** The box, rendered last so it sits over the grid. */
function hoverTip(tip: HoverTip | null): React.JSX.Element {
  return (
    <>
      <style>{HEATMAP_CSS}</style>
      {tip === null ? null : (
        <TipBox
          caption={tip.caption}
          rows={tip.rows}
          note={tip.note}
          style={{
            position: 'absolute',
            left: tip.left,
            top: tip.top,
            width: TIP_WIDTH,
            zIndex: 4
          }}
        />
      )}
    </>
  )
}

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

/**
 * The calendar's key says what its colours now mean - hours against the
 * four-hour target - rather than a bare Less / More.
 */
function CalendarLegend({ accent }: { accent: string }): React.JSX.Element {
  const swatch = (hours: number): React.JSX.Element => (
    <span
      key={hours}
      title={hours === 0 ? 'No work' : `${hours} h`}
      style={{ width: 11, height: 11, borderRadius: 2, background: dayFill(hours, accent) }}
    />
  )
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
      <span>0 h</span>
      {[0, 1, 2, 3].map(swatch)}
      {swatch(DAILY_TARGET_HOURS)}
      <span>{DAILY_TARGET_HOURS} h</span>
      <span style={{ width: 6 }} />
      <svg width={11} height={11} aria-hidden="true">
        <rect
          className="hm-star"
          x={0.75}
          y={0.75}
          width={9.5}
          height={9.5}
          rx={2}
          style={{ fill: dayFill(DAILY_TARGET_HOURS, accent) }}
        />
      </svg>
      <span>superstar, over {SUPERSTAR_HOURS} h</span>
    </div>
  )
}

/* ---------- calendar ---------- */

const CELL = 12
const GAP = 3
const PITCH = CELL + GAP

/**
 * The biggest a day square may be drawn, in CSS pixels.
 *
 * The grid is an svg with a viewBox and `width: 100%`, so it scales to
 * whatever the panel gives it. That is right when the viewBox is wide - at
 * 12 months it is 816 units against an 1,800px panel, a little over 2x, and
 * it is what makes the calendar the first thing you see rather than the
 * faintest. It is catastrophic when the viewBox is narrow, because nothing
 * stopped the same rule from scaling two columns to the same width:
 *
 *   range        viewBox   scale    day square   panel height
 *   30 days          96    18.7x      224.9px        2,304px
 *   8 weeks         156    11.5x      138.4px        1,453px
 *   12 months       816     2.2x       26.5px          353px
 *   all time        831     2.2x       26.0px          348px
 *
 * Measured at 1,900px wide, and the user's words for the first row are "it
 * zooms in hella and then i can't see anything" - a handful of enormous
 * rounded squares several screens tall.
 *
 * 26 is not a guess: it is the size a day already has at 12 months and all
 * time on a wide window, which is the state nobody complained about. Capping
 * there means **a day is the same size whatever range is chosen**, which is
 * what "proportional to the timescale" actually asks for - a week is a
 * smaller picture than a year because it has less in it, not because its
 * squares are smaller. It also leaves the two long ranges visually
 * untouched, which matters: the upscale was asked for.
 */
const MAX_CELL_PX = 26
/** Room for an end-aligned `M` / `W` / `F`. */
const WEEKDAY_W = 24
const MONTH_H = 16

/**
 * About the width of `Sep` in viewBox units, used to keep the last label on
 * screen.
 *
 * The svg clips at its own edge, and the final column's label starts a few
 * units short of it: measured, `Nov` sat at x=819 in an 831-unit box and
 * needed 18, so it lost its last letter and read as `No`. The current month is
 * the one label nobody can afford to lose. Generous on purpose - too wide only
 * anchors a label that would have fitted anyway, which is invisible, while too
 * narrow clips it again.
 */
const MONTH_LABEL_W = 22

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

/*
 * Colour is a fixed target, not a scale off the user's own history: see
 * `shared/dayShade.ts`. It replaced four levels off the 90th percentile of
 * worked days, which still let a run of long days push an ordinary
 * three-hour day down to a middling shade.
 */

/**
 * What a day says when you hover it.
 *
 * The hours lead, because that is the question the grid is being read for;
 * the session count is the supporting line. A day with nothing on it says so
 * in words rather than showing `0 h`, which looks like a measurement.
 */
function dayRows(day: DayTotal): { rows: TipRow[]; note?: string } {
  if (day.hours <= 0 && day.sessions === 0) return { rows: [{ name: '', value: 'No work' }] }
  const superstar = isSuperstar(day.hours)
  return {
    rows: [{ name: superstar ? 'Superstar day' : 'Worked', value: `${formatHours(day.hours)} h` }],
    note: plural(day.sessions, 'session') + (superstar ? ` · over ${SUPERSTAR_HOURS} h` : '')
  }
}

function monthYear(date: string): string {
  const [y, m] = date.split('-')
  return `${MONTHS[Number(m) - 1]} ${y}`
}

export function CalendarHeatmap({
  daily,
  accent,
  control
}: {
  daily: DayTotal[]
  accent: string
  /** This panel's range control, placed in its head beside the pager. */
  control?: React.ReactNode
}): React.JSX.Element {
  /** Windows back from the most recent one. Zero is the default view. */
  const [page, setPage] = useState(0)
  const { tip, show, hide, panelRef } = useHoverTip()

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
        /* No `<title>` any more - see `useHoverTip`. Leaving one in place
           beside the styled box would show both, one of them late and in the
           OS's own font. */
        <rect
          key={day}
          className={isSuperstar(total.hours) ? 'hm-cell hm-star' : 'hm-cell'}
          x={WEEKDAY_W + column * PITCH}
          y={MONTH_H + row * PITCH}
          width={CELL}
          height={CELL}
          rx={2}
          style={{ fill: dayFill(total.hours, accent) }}
          onMouseEnter={(event) => {
            const { rows, note } = dayRows(total)
            show(event, formatDate(total.date), rows, note)
          }}
          onMouseLeave={hide}
        />
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
    <div className="an-panel an-panel--hero hm" ref={panelRef}>
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
          <CalendarLegend accent={accent} />
          {/* Before the pager, because the range decides what there is to page
              through: narrowing to 12 months is why the pager then has one
              window rather than four. */}
          {control}
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
           square at any width.

           `maxWidth` is the bound that was missing: the width at which a day
           square reaches `MAX_CELL_PX`. On a long range it is wider than the
           panel and nothing changes; on a short one it stops the grid
           stretching and leaves it compact and left-aligned. Expressed as a
           width rather than a transform because `height: auto` then follows
           from the aspect ratio - the squares stay square and the panel
           stops being three screens tall without any second rule to keep in
           step. */
        style={{
          display: 'block',
          width: '100%',
          maxWidth: `${(width * MAX_CELL_PX) / CELL}px`,
          height: 'auto'
        }}
        role="img"
        aria-label="Hours worked per day"
      >
        {monthLabels.map((label) => {
          // Flush to the right edge rather than clipped. Anchoring the end is
          // better than skipping the label or widening the box: the grid keeps
          // its full width, and the label moves by at most a few units - `Oct`
          // sits 60 units to its left, so they cannot collide.
          const overflows = label.x + MONTH_LABEL_W > width
          return (
            <text
              key={label.text + label.x}
              x={overflows ? width : label.x}
              y={MONTH_H - 5}
              textAnchor={overflows ? 'end' : undefined}
              style={labelStyle}
            >
              {label.text}
            </text>
          )
        })}
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
        Brighter is more hours, reaching full colour at {DAILY_TARGET_HOURS} h - a solid day, not
        your longest. Ringed squares are superstar days, over {SUPERSTAR_HOURS} h. Hover a square
        for its day; the arrows page back a year at a time.
      </p>
      {hoverTip(tip)}
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
  accent,
  control
}: {
  byHour: HourTotal[]
  timedSessions: number
  /** First and last local dates the counted rows fall on; null when none. */
  timedFirst: string | null
  timedLast: string | null
  accent: string
  control?: React.ReactNode
}): React.JSX.Element {
  const { tip, show, hide, panelRef } = useHoverTip()
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
      <div className="an-panel hm" ref={panelRef}>
        <div className="an-panel__head">
          <h4 className="an-panel__title">
            Time of day
            <span className="an-panel__sub">not enough data yet</span>
          </h4>
          {/* Kept in the empty state too. The range is why this panel is empty
              as often as not - app-timed rows are recent and thin - so being
              able to widen it from here is the first thing to try, and a
              control that appears only once a panel has data is a control
              nobody finds. */}
          {control}
        </div>

        {/* The empty state's track is this panel's hover surface until the
            grid has enough data to be drawn, which on a young history is
            most of the time - so it gets the same box, and loses its `title`
            attribute for the same reason the grid lost its `<title>`: two
            tooltips, one of them the OS's. */}
        <div className="an-track">
          {hours.map((hour) => (
            <span
              key={hour.hour}
              className={`hm-cell${hour.sessions > 0 ? ' is-on' : ''}`}
              onMouseEnter={(event) =>
                show(
                  event,
                  `${hourLabel(hour.hour)}–${hourLabel((hour.hour + 1) % 24)}`,
                  hour.sessions > 0
                    ? [{ name: '', value: plural(hour.sessions, 'session') }]
                    : [{ name: '', value: 'Nothing yet' }]
                )
              }
              onMouseLeave={hide}
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
        {hoverTip(tip)}
      </div>
    )
  }

  return (
    <div className="an-panel hm" ref={panelRef}>
      <div className="an-panel__head">
        <h4 className="an-panel__title">
          Time of day
          <span className="an-panel__sub">
            {plural(timedSessions, 'session')} this app timed itself
          </span>
        </h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Legend accent={accent} />
          {control}
        </div>
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
            className="hm-cell"
            x={hour.hour * HOUR_PITCH}
            y={0}
            width={HOUR_CELL_W}
            height={HOUR_CELL_H}
            rx={3}
            style={{ fill: cellFill(level(hour.hours, scale), accent) }}
            onMouseEnter={(event) =>
              show(
                event,
                `${hourLabel(hour.hour)}–${hourLabel((hour.hour + 1) % 24)}`,
                hour.hours > 0
                  ? [{ name: 'Worked', value: `${formatHours(hour.hours)} h` }]
                  : [{ name: '', value: 'No work' }],
                hour.hours > 0 ? plural(hour.sessions, 'session') : undefined
              )
            }
            onMouseLeave={hide}
          />
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
      {hoverTip(tip)}
    </div>
  )
}
