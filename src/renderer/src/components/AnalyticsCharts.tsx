/**
 * The Analytics tab's charts. Pure and props-driven: every one takes the
 * already-aggregated shapes from `@shared/analytics` and renders them, so the
 * SQL that sums thousands of rows stays in the main process and these stay
 * testable by handing them an array.
 *
 * Recharts' own styling assumes a light page, so axes, grid and tooltip are
 * restyled here. Axis colours go through a CSS rule rather than a `fill`
 * attribute on the tick: `var()` inside an SVG presentation attribute is not
 * reliably resolved, while a CSS declaration always is.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { ALL_COURSES, courseFrom, coursesIn } from '@shared/courses'
import { rateBars, type RateGrain } from '@shared/ranges'
import { formatCount, pluralUnit } from '@shared/facts'
import {
  TICK_BASE_PX,
  VALUE_PX,
  categoryAxisWidth,
  digitsProbe,
  rightMarginFor,
  topMarginFor,
  widest,
  yAxisWidth
} from '../lib/measure'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { formatDate, formatMonthDay } from '@shared/dates'
import { windowDef, windowDefFor, type WindowId } from '@shared/windows'
import { plannedFit } from '@shared/analytics'
import type {
  DayTotal,
  PacePoint,
  PlannedVsActual as PlannedVsActualPoint,
  ProjectTotal,
  RatePoint
} from '@shared/analytics'

const DAY_MS = 86_400_000

/** Local calendar dates, so arithmetic runs in UTC to stay clear of DST. */
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

function isoDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

/** The Monday of the week a date falls in. */
function weekStart(date: string): number {
  const day = dayNumber(date)
  // Epoch day 0 was a Thursday, so shifting by 3 puts Monday at a multiple of 7.
  const sinceMonday = (((day + 3) % 7) + 7) % 7
  return day - sinceMonday
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthLabel(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return `${MONTHS[m - 1]} ’${String(y).slice(2)}`
}

/**
 * A month name is the wrong grain for a short span.
 *
 * The pace chart starts out covering a fortnight, and `monthLabel` across one
 * gives `Oct '26, Oct '26, Nov '26, Nov '26` — four ticks saying two things,
 * which reads as a broken axis. Under about four months the day is what
 * distinguishes one tick from the next; past that the day is noise and the
 * month carries it.
 */
function spanLabel(date: string, days: number): string {
  if (days > 120) return monthLabel(date)
  return formatMonthDay(date)
}

/** Captions read as prose, so a count of one must not say "1 sessions". */
function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`
}

function round(n: number, places = 1): number {
  const scale = 10 ** places
  return Math.round(n * scale) / scale
}

/**
 * An accent at reduced opacity. The stored accent is a 6-digit hex (see
 * `shared/accents.ts`), so alpha is appended - but a caller could hand over
 * anything, and a malformed colour must not silently paint nothing.
 */
function tint(accent: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(accent) ? accent + alpha : accent
}

const GRID = '#ffffff12'
/**
 * One tooltip for every chart: a quiet caption and a loud number.
 *
 * *"just make whatever the text is like gray and then make the font size
 * smaller. The actual statistic should be white and it should pop out and it
 * should be in a bigger font size."*
 *
 * Recharts' default draws `Hours : 10.51 h` - one line, one size, the label
 * and the figure given equal weight and joined by a colon. The figure is the
 * only part anyone hovers for, so it is now 17px and white and the words
 * around it are 10.5px and dim. The colon is gone with the single line: a
 * label above its value needs no punctuation to join them.
 *
 * It is a `content` component rather than the style props, because the style
 * props can only colour the default markup - they cannot put the name and
 * the value on separate lines or give them different sizes.
 *
 * No font family anywhere here. The app is on one face and the chart text
 * inherits it; naming it again would be a second place to change it.
 */
export const TOOLTIP_CSS = `
.ac-tip {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 8px 11px 9px;
  box-shadow: 0 6px 18px #00000055;
  pointer-events: none;
}
.ac-tip__when {
  display: block;
  color: var(--text-dim);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  margin-bottom: 4px;
}
.ac-tip__name {
  display: block;
  color: var(--text-dim);
  font-size: 10.5px;
}
.ac-tip__value {
  display: block;
  color: var(--text);
  font-size: 17px;
  font-weight: 620;
  line-height: 1.2;
  letter-spacing: -0.2px;
  font-variant-numeric: tabular-nums;
}
.ac-tip__row + .ac-tip__row {
  margin-top: 6px;
}
`

interface TipEntry {
  name?: string
  value?: number | string
  unit?: string
  payload?: unknown
}

export interface TipRow {
  name: string
  value: string
}

/**
 * `when` is the caption - the period being hovered - and `rows` overrides
 * what is listed under it. Both are given the payload, because every caption
 * in this file is built from the row rather than from the axis label: the
 * axis is thinned, so its label is blank on most buckets.
 */
export function ChartTip({
  active,
  payload,
  label,
  when,
  rows
}: {
  active?: boolean
  payload?: TipEntry[]
  label?: React.ReactNode
  when?: (label: React.ReactNode, payload: TipEntry[]) => string
  rows?: (payload: TipEntry[]) => TipRow[]
}): React.JSX.Element | null {
  if (active !== true || payload === undefined || payload.length === 0) return null
  const caption = when === undefined ? String(label ?? '') : when(label, payload)
  const lines =
    rows === undefined
      ? payload.map((entry) => ({
          name: entry.name ?? '',
          value: `${entry.value ?? ''}${entry.unit ?? ''}`
        }))
      : rows(payload)

  return (
    <div className="ac-tip">
      <style>{TOOLTIP_CSS}</style>
      {caption === '' ? null : <span className="ac-tip__when">{caption}</span>}
      {lines.map((line, index) => (
        <span className="ac-tip__row" key={`${line.name}-${index}`}>
          {line.name === '' ? null : <span className="ac-tip__name">{line.name}</span>}
          <span className="ac-tip__value">{line.value}</span>
        </span>
      ))}
    </div>
  )
}

/*
 * `cursor={false}` on every chart, and it is not a style choice.
 *
 * "I hate this highlight effect. Get rid of it. it shouldn't highlight it in
 * gray" - the full-height grey rectangle Recharts paints behind the hovered
 * band. On a bar chart it is a second rectangle behind the bar, which reads
 * as a selection the user did not make; on this tab it also sat over the
 * value labels that were added so the bars could be read without hovering at
 * all. The tooltip itself says which bucket is being read.
 */
const NO_CURSOR = { cursor: false } as const

const CHART_CSS = `
.ac {
  --ac-grid: ${GRID};
}
.ac__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 4px;
}
.ac__title {
  font-size: 13px;
  letter-spacing: 0.02em;
  color: var(--text);
  margin: 0;
}
.ac__note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  margin: 6px 0 0;
}
.ac__legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-dim);
}
.ac__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 5px;
  vertical-align: -1px;
}
.ac__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--border);
  border-radius: 10px;
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
  padding: 16px;
}
.ac__unit {
  background: var(--surface-raised);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
}
/* The tick text carries recharts-cartesian-axis-tick-value; its wrapper is
   recharts-cartesian-axis-tick-LABEL, so the old descendant selector
   (.recharts-cartesian-axis-tick text) matched nothing at all and the ticks
   sat at their inherited 14px. There was no inline style and no attribute to
   blame, which is what made it look like Recharts was overriding something.
   Measured: el.matches() on the old selector returned false. */
.ac .recharts-cartesian-axis-tick-value {
  fill: var(--text-dim);
  font-size: calc(11px * var(--an-fs, 1));
}
.ac .recharts-cartesian-axis-line,
.ac .recharts-cartesian-axis-tick-line {
  stroke: var(--border);
}
.ac .recharts-label,
.ac .recharts-text.recharts-label {
  fill: var(--text-dim);
  font-size: 11px;
}
/* The value drawn on a point or a bar. It is the series speaking rather than a
   caption about it, so it takes the accent - and it needs its own selector
   because the rule above wins over a fill attribute on the element. */
.ac .recharts-text.ac__value {
  fill: var(--accent);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
`

/**
 * One chart, one panel.
 *
 * The panel markup lives here rather than in `AnalyticsTab` so a chart stays a
 * single thing to place: the tab composes rows, not headers. `sub` is the part
 * of the old caption that says what you are looking at, which belongs beside
 * the title rather than floating under the plot as a loose paragraph.
 *
 * Panel styling is in `main.css` under "Analytics tab", in `var(--accent)` and
 * neutrals only. `CHART_CSS` keeps just the rules that have to reach inside
 * Recharts' own SVG.
 */
function Frame({
  title,
  sub,
  aside,
  children,
  note,
  hero
}: {
  title: string
  sub?: string
  aside?: React.ReactNode
  /**
   * The panel's contents, or a function of the size its axis ticks will be
   * drawn at.
   *
   * A function rather than a context, because the thing that needs the
   * number is the chart body, and the chart body is written inside the same
   * component that renders this frame - so it would sit *outside* any
   * provider this component could set up, and read the default forever. A
   * render prop hands the measured value to exactly the code that uses it.
   */
  children: React.ReactNode | ((tickPx: number) => React.ReactNode)
  note?: React.ReactNode
  hero?: boolean
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [tickPx, setTickPx] = useState(TICK_BASE_PX)

  /*
   * Measured after layout, every render, which is deliberate.
   *
   * The scale changes through a custom property on an ancestor, and a custom
   * property changing is not a prop changing - there is nothing for a
   * dependency array to watch. Pressing A+ re-renders this component through
   * the layout state it also changes, so running on every commit is enough,
   * and `setTickPx` is guarded so an unchanged value cannot loop.
   */
  // No dependency array on purpose, and the rule's warning is the right
  // warning for the wrong case: it guards against an effect that sets state
  // on every commit looping forever. This one cannot, because `setTickPx`
  // returns the previous value unless the measurement actually changed, and
  // React bails out of a re-render when the state is identical.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = box.current
    if (el === null) return
    const raw = getComputedStyle(el).getPropertyValue('--an-fs').trim()
    const scale = raw === '' ? 1 : Number(raw)
    const next = Number.isFinite(scale) && scale > 0 ? TICK_BASE_PX * scale : TICK_BASE_PX
    setTickPx((prev) => (Math.abs(prev - next) < 0.01 ? prev : next))
  })

  return (
    <div className={`ac an-panel${hero ? ' an-panel--hero' : ''}`} ref={box}>
      <style>{CHART_CSS}</style>
      <div className="an-panel__head">
        <h4 className="an-panel__title">
          {title}
          {sub ? <span className="an-panel__sub">{sub}</span> : null}
        </h4>
        {aside}
      </div>
      {typeof children === 'function' ? children(tickPx) : children}
      {note ? <p className="an-panel__note">{note}</p> : null}
    </div>
  )
}

/**
 * A panel that has no data yet, and says why in its own words.
 *
 * Shared by the time-of-day heatmap and the pace chart so the two read as one
 * kind of thing. They are empty for different reasons and the sentences must
 * not blur them: time of day is *early* and thickens as the app is used, while
 * pace is *structurally* empty, because no imported row can ever carry a pace
 * target. One is a chart waiting for data; the other is a feature nobody has
 * switched on.
 *
 * `track` is the shape the chart would occupy, drawn as an outline. It is kept
 * rather than hidden because a panel that disappears until it has data cannot
 * teach anyone the feature exists.
 *
 * `progress` fills a hairline meter toward whatever counts as enough. It turns
 * "there is nothing here" into "here is how far along this is", which is the
 * difference between a dead widget and one that is visibly waiting.
 */
export function EmptyState({
  title,
  children,
  progress,
  track
}: {
  title: string
  children: React.ReactNode
  /** 0-1; omitted when there is no threshold worth counting towards. */
  progress?: number
  track?: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {track}
      <div className="an-empty">
        <b className="an-empty__title">{title}</b>
        <p className="an-empty__body">{children}</p>
        {progress === undefined ? null : (
          <div className="an-empty__meter">
            <i style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
          </div>
        )}
      </div>
    </>
  )
}

/** Empty is a normal state - a fresh database, or a filter that matched nothing. */
function Empty({ height, children }: { height: number; children: string }): React.JSX.Element {
  return (
    <div className="ac__empty" style={{ height }}>
      {children}
    </div>
  )
}

/**
 * Hours over time, cut daily or weekly according to how far back you look.
 *
 * The range comes from `@shared/windows` rather than a ladder of this chart's
 * own. It had one first - and that is exactly how "the past 8 weeks" ends up
 * meaning 56 days under the chart and something else in the stat row above it.
 * One list, one definition, and a window chosen in either place reads the same
 * in both.
 *
 * A dropdown, not a row of buttons. Seven of them would spend a row's width
 * saying two characters each, which is the trade the Data tab already refused
 * for its Source and rows-per-page pickers - it keeps buttons only for its
 * date presets, where there are four and each is a one-tap shortcut rather
 * than a persistent selection. This is a persistent selection, and the extra
 * room lets the options read as words instead of abbreviations.
 *
 * The bucket follows the window rather than being chosen separately. A week of
 * weekly buckets is one point, which is not a chart - so anything up to eight
 * weeks is cut daily and anything longer is cut weekly. That keeps the number
 * of points between about seven and a hundred at every setting, which is the
 * range an area reads well over, and it means the control has one axis rather
 * than two for the user to reconcile.
 *
 * Empty buckets are filled rather than skipped: a month off must read as a
 * gap, not be closed up into a continuous run of work that never happened.
 */

/**
 * How finely a range is cut, chosen so **every bar can carry its value**.
 *
 * "numbers still don't display on this chart" - at past 8 weeks the chart
 * drew 56 daily points and labelled exactly one of them, the peak, because
 * 56 labels would have collided. The user had already said that a chart
 * whose data points they cannot read tells them nothing, so the right answer
 * is not to thin the labels harder: it is to draw fewer, bigger buckets.
 *
 * The thresholds are set from the narrow window, 1,150px, because a grain
 * that only works at full screen is a grain that breaks when the window is
 * resized. At that width a panel has about 1,090px of plot, so:
 *
 *   grain    worst case        bars   px per bar
 *   day      30 days             30         ~36
 *   week     120 days            18         ~60
 *   month    the whole history   44         ~25
 *
 * and a value label is 2-5 characters of tabular 10.5px type, about 12-31px.
 * The month row is the tight one and is what `scripts/label-overlap-check.ts`
 * exists to keep honest.
 *
 * Chosen from the range's length rather than from the measured width on
 * purpose: the title says which grain is in use ("Hours per week"), and a
 * grain that changed as you dragged the window edge would make that title
 * flicker between two truths.
 */
type Grain = 'day' | 'week' | 'month' | 'quarter'

/**
 * The most bars that can each carry a readable number at 1,150px.
 *
 * A panel has about 1,090px of plot there, so 32 bars is 34px each against a
 * value label of 2-5 characters of tabular 10.5px type - 12 to 31px wide.
 *
 * Found by measuring, not by reasoning. The first rule picked the grain from
 * fixed day thresholds and put all time on 45 monthly bars, where the closest
 * pair of labels had **0.8px** between them. That passes an overlap test and
 * is still two numbers read as one, which is the fault this panel exists to
 * fix.
 */
const MAX_BARS = 32

/** Rough days per bucket, for choosing between grains. */
const GRAIN_DAYS: Record<Grain, number> = { day: 1, week: 7, month: 30.44, quarter: 91.3 }

/**
 * The finest cut whose bars can each still be labelled.
 *
 * Walking from finest to coarsest and taking the first that fits is better
 * than a table of day thresholds in two ways: a custom span of any length
 * lands somewhere sensible without a rule being written for it, and the
 * thing being guaranteed - that every bar carries a readable value - is the
 * thing the condition actually tests.
 *
 * `historyDays` matters as well as the window's length: "all time" on
 * eighteen months of data is eighteen months, and choosing from the window
 * alone would cut a short history into quarters for no reason.
 */
function grainFor(days: number | null, historyDays: number): Grain {
  const span = days === null ? historyDays : Math.min(days, historyDays)
  for (const grain of ['day', 'week', 'month'] as const) {
    if (Math.ceil(span / GRAIN_DAYS[grain]) <= MAX_BARS) return grain
  }
  return 'quarter'
}

const GRAIN_NOUN: Record<Grain, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  quarter: 'quarter'
}

interface Point {
  /** Epoch day of the bucket's first day, for ordering. */
  day: number
  hours: number
  sessions: number
  from: string
  /**
   * The axis text for this bucket, blank where a label would collide.
   *
   * This is tick *text*, never the axis's `dataKey`. Keying the scale on it
   * put every blank-tick day into one band - see the XAxis below.
   */
  tick: string
  /** The value drawn on the bar. Every bar has one - see `valueLabels`. */
  label: string
}

export function HoursOverTime({
  daily,
  accent,
  range,
  customDays,
  control
}: {
  daily: DayTotal[]
  accent: string
  /*
   * The range arrives as a prop rather than being held here.
   *
   * This panel had the tab's first range control and kept it in its own
   * `useState`, which meant it was the one panel whose setting did not
   * survive being looked at twice. Now that every panel has one they are all
   * stored in the layout together, so this one is lifted for the same reason
   * the rest exist.
   */
  range: WindowId
  /** Days, when the range is a typed one; null for every preset. */
  customDays: number | null
  control?: React.ReactNode
}): React.JSX.Element {
  const chosen = windowDefFor(range, customDays)
  const historyDays =
    daily.length === 0 ? 0 : dayNumber(daily[daily.length - 1].date) - dayNumber(daily[0].date) + 1
  const grain = grainFor(chosen.days, historyDays)
  const points = seriesFor(daily, chosen.days, grain)
  const unit = GRAIN_NOUN[grain]
  /** Axis text by bucket, so the scale can be keyed on something unique. */
  const tickText = new Map(points.map((point) => [point.from, point.tick]))

  return (
    <Frame
      /* The grain is in the title because it changes with the range, and a
         bar's value means a different thing at each one. "12.4" under "Hours
         per day" and under "Hours per month" are not the same claim. */
      title={`Hours per ${unit}`}
      sub={
        points.length > 0
          ? `${points.length} ${unit}${points.length === 1 ? '' : 's'}${grain === 'week' ? ', Monday to Sunday' : ''}`
          : undefined
      }
      aside={control}
      note={
        points.length > 0
          ? `Every bar carries its hours — one decimal under 100, whole above it. Running time only; paused time is never counted. Empty ${unit}s are drawn as zero rather than closed up, so a gap reads as a gap.`
          : undefined
      }
    >
      {(tickPx) =>
        points.length === 0 ? (
          <Empty height={220}>No sessions recorded yet.</Empty>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            {/* Every number here is measured rather than typed. The top
                margin carries the value labels - at 4 the peak sat on the
                axis ceiling and its own label was clipped, which is the one
                point you most want named - and the right margin carries the
                half of the last date label that hangs past the final point.
                `Thu 5` was cut by 12px at 1.6x text before this. */}
            <BarChart
              data={points}
              margin={{
                top: topMarginFor(tickPx, 7),
                right: rightMarginFor([...tickText.values()], tickPx, 10),
                left: 0,
                bottom: 0
              }}
            >
              <CartesianGrid stroke={GRID} vertical={false} />
              {/* Keyed on `from`, which is unique per bucket, with the tick text
                supplied by the formatter.

                `dataKey="tick"` is the bug this replaces, and it was not a
                thinning problem - it was a tooltip one. A category axis
                deduplicates its domain, and `tick` is deliberately blank on
                every bucket that does not carry a label, so 56 days collapsed
                into the three bands that had text. Recharts then resolved
                almost every pointer position to the same collapsed band.

                Measured over 60 hover positions by
                `scripts/hours-tooltip-check.ts`, which is the control for
                this change. Keyed on `tick`, every position answered and 9 of
                them named the bucket under the pointer, across 8 distinct
                bands; keyed on `from` it is 60 of 60 across 56. It hit both
                bucketings - by week it was 9 of 60 across 7 bands - because
                both thin their labels the same way.

                The chart looked right throughout, because the area, the value
                labels and the axis text are all placed by index while only
                the tooltip resolves by value. Nothing but hovering it could
                have shown this. */}
              <XAxis
                dataKey="from"
                interval={0}
                tickLine={false}
                tickFormatter={(value: string): string => tickText.get(value) ?? ''}
              />
              <YAxis
                width={yAxisWidth(
                  [digitsProbe(Math.max(0, ...points.map((point) => point.hours)))],
                  tickPx
                )}
                tickLine={false}
              />
              <Tooltip
                {...NO_CURSOR}
                content={
                  <ChartTip
                    when={(_label, payload) => {
                      const row = payload?.[0]?.payload as Point | undefined
                      if (!row) return ''
                      if (grain === 'day') return formatDate(row.from)
                      return grain === 'week'
                        ? `Week of ${formatDate(row.from)}`
                        : monthLabel(row.from)
                    }}
                  />
                }
              />
              {/* Bars rather than an area, at the user's request: they named
                the Hours-by-project panel as the format they can read, and
                the thing that makes it readable is that every bar carries
                its number. An area has points, not slots, so there is
                nowhere for a label to sit that is unambiguously one day's.

                The fill does not fade with value. A second encoding of the
                same number would be decoration, and the height already says
                it twice over with the label. */}
              <Bar
                dataKey="hours"
                name="Hours"
                unit=" h"
                fill={accent}
                radius={[2, 2, 0, 0]}
                isAnimationActive={false}
              >
                {/* The value on the bar, the way a spreadsheet does it. Accent
                  rather than --text-dim: it is the series speaking, not a
                  caption about it. */}
                <LabelList dataKey="label" position="top" offset={5} className="ac__value" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )
      }
    </Frame>
  )
}

/**
 * The series for a span, cut daily or weekly.
 *
 * Empty buckets are filled rather than skipped: a fortnight off has to read as
 * a trough, not be closed up into a continuous run of work that never
 * happened. That matters more for an area than it did for bars, because an
 * area connects its points and would draw a slope straight across the gap.
 */
function seriesFor(daily: DayTotal[], days: number | null, grain: Grain): Point[] {
  if (daily.length === 0) return []
  if (grain === 'month' || grain === 'quarter') {
    return monthSeries(daily, days, grain === 'quarter' ? 3 : 1)
  }

  const byDay = grain === 'day'
  const totals = new Map<number, { hours: number; sessions: number }>()
  let last = -Infinity
  for (const row of daily) {
    const key = byDay ? dayNumber(row.date) : weekStart(row.date)
    if (key > last) last = key
    const found = totals.get(key)
    if (found) {
      found.hours += row.hours
      found.sessions += row.sessions
    } else {
      totals.set(key, { hours: row.hours, sessions: row.sessions })
    }
  }

  const step = byDay ? 1 : 7
  const earliest = Math.min(...totals.keys())
  // Rounded up to whole buckets, because `last` is a bucket key and the loop
  // walks back from `first` in steps of one bucket. A year cut weekly has to
  // start 53 weeks back, not 365 days back: an offset that is not a multiple
  // of seven lands between the week keys and every bucket then reads as zero.
  const span = days === null ? null : (Math.ceil(days / step) - 1) * step
  const first = span === null ? earliest : Math.max(earliest, last - span)

  const out: Point[] = []
  for (let key = first; key <= last; key += step) {
    const found = totals.get(key) ?? { hours: 0, sessions: 0 }
    out.push({
      day: key,
      hours: round(found.hours, 2),
      sessions: found.sessions,
      from: isoDate(key),
      tick: '',
      label: ''
    })
  }
  return valueLabels(label(out, grain))
}

/**
 * The same, cut into calendar months.
 *
 * Months cannot be walked in a fixed number of days, so they are enumerated
 * by name rather than by arithmetic on epoch days - stepping 30 or 31 at a
 * time drifts and eventually lands two buckets in one month. Empty months
 * are still filled, for the same reason empty days are: a term off has to
 * read as a gap rather than be closed up.
 */
function monthSeries(daily: DayTotal[], days: number | null, step: number): Point[] {
  const totals = new Map<string, { hours: number; sessions: number }>()
  for (const row of daily) {
    const key = row.date.slice(0, 7)
    const found = totals.get(key)
    if (found) {
      found.hours += row.hours
      found.sessions += row.sessions
    } else {
      totals.set(key, { hours: row.hours, sessions: row.sessions })
    }
  }
  if (totals.size === 0) return []

  const keys = [...totals.keys()].sort()
  const lastKey = keys[keys.length - 1]
  // The cut-off is a date, so it is compared as one: the first month that
  // contains any day of the range. A range of 365 days ending in November
  // starts in the previous December, and that part-month is included - it
  // is a month the range really touches, and dropping it would lose work.
  const earliestKey = keys[0]
  const startKey =
    days === null
      ? earliestKey
      : (() => {
          const end = dayNumber(lastDayOf(lastKey))
          const wanted = isoDate(end - days + 1).slice(0, 7)
          return wanted > earliestKey ? wanted : earliestKey
        })()

  const out: Point[] = []
  let [year, month] = startKey.split('-').map(Number)
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`
    if (key > lastKey) break
    // A quarter is three of these summed, so it is the same walk with a
    // longer stride rather than a second function: the only difference
    // between the two grains is how many months land in one bar.
    let hours = 0
    let sessions = 0
    let scanYear = year
    let scanMonth = month
    for (let i = 0; i < step; i += 1) {
      const part = `${scanYear}-${String(scanMonth).padStart(2, '0')}`
      const found = totals.get(part)
      if (found) {
        hours += found.hours
        sessions += found.sessions
      }
      scanMonth += 1
      if (scanMonth > 12) {
        scanMonth = 1
        scanYear += 1
      }
    }
    out.push({
      day: dayNumber(`${key}-01`),
      hours: round(hours, 2),
      sessions,
      from: `${key}-01`,
      tick: '',
      label: ''
    })
    month += step
    while (month > 12) {
      month -= 12
      year += 1
    }
  }
  return valueLabels(label(out, step === 3 ? 'quarter' : 'month'))
}

/** Last day of a `YYYY-MM`, so a month's range can be compared as a date. */
function lastDayOf(key: string): string {
  const [year, month] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function valueLabels(points: Point[]): Point[] {
  return points.map((point) => ({ ...point, label: hoursLabel(point.hours) }))
}

/**
 * The number written on a bar.
 *
 * One decimal under a hundred and none above it, which is not cosmetic: at
 * the month grain a bar can read 150, and `150.3` is five characters in a
 * 25px slot while `150` is three. The tenth it drops is a tenth of a percent
 * of the figure, and keeping it is what would push the labels into each
 * other.
 *
 * A zero bar is labelled `0` rather than left blank. Blank was the obvious
 * choice - a bar of no height says zero by itself - but this chart exists
 * because the user could not tell a value they could not read from a value
 * that was not there, and an unlabelled bar in a row of labelled ones is
 * exactly that ambiguity again. `0` is one character and never collides.
 */
function hoursLabel(hours: number): string {
  if (hours <= 0) return '0'
  if (hours >= 100) return String(Math.round(hours))
  return round(hours, 1).toString()
}

/**
 * Labels a handful of points and blanks the rest.
 *
 * Roughly six labels whatever the span, chosen by position rather than by
 * calendar, so a 1-week view is labelled by date and a 3-year view by month
 * without either needing its own rule. Recharts thins ticks on its own
 * otherwise, and thins the wrong ones.
 */
function label(points: Point[], grain: Grain): Point[] {
  if (points.length === 0) return points
  const byDay = grain === 'day'
  const every = Math.max(1, Math.round(points.length / 6))
  // The weekday earns its place only when every label is a different day of
  // the week you can orient by. Past a fortnight the labels land on arbitrary
  // weekdays - Wed, then Fri, then Sun - which reads as noise rather than as
  // structure, so the date carries it alone.
  const withWeekday = byDay && every <= 2
  return points.map((point, index) =>
    index % every === 0
      ? {
          ...point,
          tick: byDay
            ? withWeekday
              ? dayLabel(point.from)
              : shortDate(point.from)
            : grain === 'week'
              ? shortDate(point.from)
              : monthLabel(point.from)
        }
      : point
  )
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * `09/03` once the weekday stops meaning anything.
 *
 * Month first, like every other date the app prints. It used to read `3 Sep`,
 * which is unambiguous on its own - the month is a word - but it is the order
 * the user asked never to see, and mixing two orders on one screen is how
 * `05/11` gets read as May. The month names this needed are gone with it;
 * `MONTHS` above survives for the month-only labels, which have no day to
 * misorder.
 */
function shortDate(date: string): string {
  return formatMonthDay(date)
}

/** `Mon 3` over a short span, where the weekday is the thing you orient by. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const weekday = DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${weekday} ${d}`
}

interface ProjectBar {
  name: string
  hours: number
  sessions: number
}

const PROJECT_LIMIT = 10

/**
 * Hours per project, longest first.
 *
 * The tail is grouped rather than cut. There are ~36 projects and the top ten
 * hold nearly all the hours, so plotting all of them spends most of the chart
 * on bars a pixel long - but cutting them silently would make the bars stop
 * summing to the total the header states, which is the kind of quiet
 * disagreement that makes a dashboard untrustworthy. "Other" keeps the sum
 * honest and names how many projects it stands for. A tail of exactly one
 * keeps its own name: hiding a single project behind "Other" costs a name and
 * saves no space.
 */
export function ByProject({
  byProject,
  accent,
  control
}: {
  byProject: ProjectTotal[]
  accent: string
  /** This panel's range control, placed in its head beside the title. */
  control?: React.ReactNode
}): React.JSX.Element {
  const bars = projectBars(byProject)
  const height = Math.max(160, bars.length * 26 + 32)

  return (
    <Frame title="Hours by project" aside={control}>
      {(tickPx) =>
        bars.length === 0 ? (
          <Empty height={160}>No projects with recorded time yet.</Empty>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            {/*
             * The right margin is for the value labels, not for air.
             *
             * Recharts gives each label a `width` equal to the room left between
             * it and the edge of the svg, and its `Text` *wraps* when the string
             * does not fit - svg text cannot wrap on its own, so this is Recharts
             * doing it deliberately. At `right: 16` the longest bar left 25.6px
             * for a `760 h` that measures 26, and it broke into `760` over `h`:
             * one row twice the height of its neighbours, from a third of a pixel.
             * Measured in the running app rather than inferred from the markup.
             *
             * 48 leaves about 42px, which clears four digits. The bars lose the
             * same 32px, which at this width is invisible.
             */}
            <BarChart
              data={bars}
              layout="vertical"
              margin={{
                top: 0,
                // Value labels sit outside the bar end, so the right margin has
                // to hold a whole one rather than half a tick.
                right: Math.max(
                  48,
                  Math.ceil(
                    widest(
                      bars.map((bar) => `${Math.round(bar.hours)} h`),
                      VALUE_PX
                    )
                  ) + 12
                ),
                left: 0,
                bottom: 0
              }}
            >
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" tickLine={false} unit=" h" />
              {/* `interval={0}`: Recharts thins category ticks by default, which
                dropped every other project name and left bars no one could
                identify. A bar without its label is not a chart. */}
              <YAxis
                type="category"
                dataKey="name"
                /* 150 was the typed figure, and it fits the real names at
                 normal size. At 1.6x text `Entrepreneurship` is half as wide
                 again and the name is what identifies the bar, so the axis
                 grows with the type instead. */
                width={categoryAxisWidth(
                  bars.map((bar) => bar.name),
                  tickPx
                )}
                interval={0}
                tickLine={false}
              />
              <Tooltip {...NO_CURSOR} content={<ChartTip />} />
              <Bar
                dataKey="hours"
                name="Hours"
                unit=" h"
                fill={accent}
                radius={[0, 2, 2, 0]}
                isAnimationActive={false}
              >
                {/* Eleven bars, so every one carries its value. Outside the bar
                  end rather than inside it: the shortest bars have no room
                  within them, and a label that sometimes sits inside and
                  sometimes outside reads as two different things. */}
                <LabelList
                  dataKey="hours"
                  position="right"
                  offset={6}
                  className="ac__value"
                  formatter={(value: React.ReactNode) => `${Math.round(Number(value))} h`}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )
      }
    </Frame>
  )
}

function projectBars(byProject: ProjectTotal[]): ProjectBar[] {
  const sorted = [...byProject].sort((a, b) => b.hours - a.hours)
  const head = sorted.slice(0, PROJECT_LIMIT)
  const tail = sorted.slice(PROJECT_LIMIT)

  const bars: ProjectBar[] = head.map((p) => ({
    // Recharts wraps a category tick onto a second line rather than clipping
    // it, which makes one row twice the height of its neighbours - the same
    // fault the Data tab's date column had. Shortening here, with the axis
    // widened to 150, keeps every row one line high: 18 characters clears the
    // real names, the longest of which is `Entrepreneurship`.
    name: p.name.length > 18 ? p.name.slice(0, 17) + '…' : p.name,
    hours: round(p.hours, 2),
    sessions: p.sessions
  }))

  if (tail.length === 1) {
    bars.push({ name: tail[0].name, hours: round(tail[0].hours, 2), sessions: tail[0].sessions })
  } else if (tail.length > 1) {
    bars.push({
      name: `Other (${tail.length})`,
      hours: round(
        tail.reduce((sum, p) => sum + p.hours, 0),
        2
      ),
      sessions: tail.reduce((sum, p) => sum + p.sessions, 0)
    })
  }
  return bars
}

/**
 * The duration on one line and the number of runs behind it on the next.
 *
 * The count has to sit with the bar it qualifies, not in the caption: a mean
 * over 523 runs and a mean over 8 are not the same claim, and the chart is
 * read by glancing along the tops of the bars. Two lines also buys the room
 * the single line did not have - at 15 buckets the plain labels collided into
 * `210m240m270m`.
 */
function RunsTick({
  x,
  y,
  payload,
  runs
}: {
  x?: number
  y?: number
  payload?: { value?: string | number }
  runs: Map<string, number>
}): React.JSX.Element {
  const label = String(payload?.value ?? '')
  const n = runs.get(label)
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <text textAnchor="middle" dy={12} style={{ fill: 'var(--text-dim)', fontSize: 10.5 }}>
        {label}
      </text>
      {n === undefined ? null : (
        <text textAnchor="middle" dy={24} style={{ fill: '#6b717c', fontSize: 9.5 }}>
          {n}
        </text>
      )}
    </g>
  )
}

interface RatioBar {
  label: string
  /** Mean running time as a percentage of what the timer was set to. */
  ratio: number
  planned: number
  actual: number
  sessions: number
  /** Opacity, so a bar resting on 2 sessions cannot shout as loud as one on 523. */
  weight: number
}

/**
 * How much of the timer actually gets run, by what it was set to.
 *
 * This plots the ratio, never the absolute target against the absolute actual.
 * Plotting the magnitudes made bar height *be* the planned duration, so the
 * chart was a staircase that rose left to right by construction and could not
 * have shown anything else; the only real information - the shortfall - was a
 * sliver at the top of each bar, smallest exactly where the plan was shortest.
 * As a share of the plan the question is answered directly, and every bar is
 * on one comparable axis.
 *
 * Durations with very few runs are dropped rather than drawn faintly to zero,
 * and the count is printed under each label, because a mean over two sessions
 * and a mean over five hundred are not the same kind of claim. The ones that
 * survive are weighted by opacity for the same reason.
 */
const MIN_RUNS = 8

export function PlannedVsActual({
  data,
  accent,
  control
}: {
  data: PlannedVsActualPoint[]
  accent: string
  control?: React.ReactNode
}): React.JSX.Element {
  const all = ratioBars(data)
  const bars = all.filter((b) => b.sessions >= MIN_RUNS)
  // 100% unless a length's runs average past it. A loop's planned time is
  // one lap, so a 45-minute goal that took two laps runs well past 100%, and
  // a fixed ceiling would clip exactly the overrun this chart is for.
  const top = Math.max(100, Math.ceil(Math.max(0, ...bars.map((b) => b.ratio)) / 25) * 25)
  const dropped = all.length - bars.length

  const runsByLabel = new Map(bars.map((b) => [b.label, b.sessions]))
  const sessions = all.reduce((sum, b) => sum + b.sessions, 0)
  const plannedTotal = all.reduce((sum, b) => sum + b.planned * b.sessions, 0)
  const actualTotal = all.reduce((sum, b) => sum + b.actual * b.sessions, 0)
  const share = plannedTotal > 0 ? Math.round((actualTotal / plannedTotal) * 100) : null
  // The same threshold the bars are filtered by, so the sentence can never
  // name a duration the chart below it has left out.
  const fit = plannedFit(data, MIN_RUNS)

  return (
    <Frame
      title="Are your timers the right length?"
      sub="share of each setting actually run"
      aside={control}
      note={
        share === null ? undefined : (
          <>
            The count is under each label, and fainter bars rest on fewer sessions. Across all{' '}
            {count(sessions, 'run')} you run <b>{share}%</b> of what you set.
            {dropped > 0
              ? ` ${dropped} ${dropped === 1 ? 'duration' : 'durations'} with fewer than ${MIN_RUNS} runs ${dropped === 1 ? 'is' : 'are'} left out.`
              : ''}
          </>
        )
      }
    >
      {(tickPx) => (
        <>
          {/*
           * What the chart is for, said in one sentence from the data.
           *
           * The panel was liked and unused - "I LOVE how it looks, but I need you
           * to figure out how it could be USEFUL" - and a chart nobody acts on is
           * furniture. The bars show the shortfall; this names the one length it
           * is worth changing, which is the length set most often.
           *
           * It compares distances and stops there. `plannedFit` has the mean and
           * nothing else, so it can say that 45 is nearer a 45-minute average than
           * 60 is; it cannot say a 45 would usually run to the end, and on the real
           * history it would not - 52% of 60-minute runs reach 45. A panel that
           * overstates once is a panel that gets checked and then ignored.
           */}
          {fit !== null && (
            <p className="an-panel__lead">
              You set <b>{fit.plannedMinutes} minutes</b> more often than any other length, and
              those {count(fit.sessions, 'run')} average{' '}
              {/* A decimal, because the suggestion is this figure rounded to the
              nearest five: printed whole they collide and the sentence reads
              "average 45, so a 45 fits better", which says nothing. */}
              <b>{fit.actualMinutes.toFixed(1)} minutes</b>
              {fit.suggestedMinutes === fit.plannedMinutes ? (
                ' — about right.'
              ) : (
                <>
                  {' — so a '}
                  <b>{fit.suggestedMinutes}</b> fits them better than a {fit.plannedMinutes}.
                </>
              )}
            </p>
          )}
          {bars.length === 0 ? (
            <Empty height={220}>No completed runs to compare yet.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={bars}
                margin={{
                  top: topMarginFor(tickPx),
                  right: rightMarginFor(
                    bars.map((bar) => bar.label),
                    tickPx,
                    8
                  ),
                  left: 0,
                  bottom: 4
                }}
              >
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis
                  dataKey="label"
                  interval={0}
                  tickLine={false}
                  height={34}
                  tick={<RunsTick runs={runsByLabel} />}
                />
                {/* The ceiling is known before drawing - 100%, or the next 25%
                above the longest bar - so the widest label is too, and the
                axis is sized to it. At 1.6x text `100%` alone needs 55px. */}
                <YAxis
                  width={yAxisWidth([`${top}%`], tickPx)}
                  unit="%"
                  tickLine={false}
                  domain={[0, top]}
                  allowDataOverflow
                />
                <Tooltip
                  {...NO_CURSOR}
                  content={
                    <ChartTip
                      when={(label, payload) => {
                        const row = payload?.[0]?.payload as RatioBar | undefined
                        return row
                          ? `${label} — ${count(row.sessions, 'run')}`
                          : String(label ?? '')
                      }}
                    />
                  }
                />
                {/* The whole point of the chart is distance from this line, so it
                is drawn rather than left to the axis. Neutral, because it is a
                reference and not a second series. */}
                <ReferenceLine y={100} stroke="#ffffff59" strokeDasharray="4 3" />
                <Bar
                  dataKey="ratio"
                  name="Share of the plan run"
                  unit="%"
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                >
                  {bars.map((bar) => (
                    <Cell key={bar.label} fill={accent} fillOpacity={bar.weight} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </>
      )}
    </Frame>
  )
}

function ratioBars(data: PlannedVsActualPoint[]): RatioBar[] {
  // The busiest duration anchors the opacity scale, so weight means "how much
  // of the evidence sits here" rather than an arbitrary cutoff.
  const busiest = data.reduce((max, row) => Math.max(max, row.sessions), 0)
  return [...data]
    .sort((a, b) => a.plannedMinutes - b.plannedMinutes)
    .map((row) => ({
      label: `${round(row.plannedMinutes)}m`,
      ratio: row.plannedMinutes > 0 ? round((row.actualMinutes / row.plannedMinutes) * 100, 1) : 0,
      planned: round(row.plannedMinutes),
      actual: round(row.actualMinutes),
      sessions: row.sessions,
      weight: busiest > 0 ? round(0.35 + 0.65 * (row.sessions / busiest) ** 0.45, 2) : 1
    }))
}

/**
 * A y-axis ceiling that the bulk of the data fills, rather than one the single
 * fastest session dictates. The 98th percentile keeps essentially everything
 * on the plot while taking the axis off a lone extreme; the small headroom
 * stops the topmost dot sitting exactly on the frame.
 *
 * The rank is `(n - 1) * 0.98`, not `n * 0.98`, and the difference is not
 * cosmetic. On a zero-indexed array `Math.floor(n * 0.98)` reaches the last
 * element for every n up to 50, so the "98th percentile" silently *was* the
 * maximum - and the units with the least data are exactly the ones a single
 * outlier distorts most. Six of the twelve units in the real history fell in
 * that range. Measured on it: `lab` (18 rows) put its median at 13% of the
 * axis and now puts it at 27%, `sentence` 24% to 46%, `cell` 15% to 30%, while
 * `question` and `word` move by about a tenth of a percent.
 *
 * It costs a little more clipping - at worst one point in eighteen, against
 * none before - and that is the right trade, because clipped points are
 * counted and named in the caption rather than dropped. A busy top edge is
 * recoverable; a chart whose data sits in the bottom eighth says nothing.
 */

interface RateBarRow {
  label: string
  rate: number
  quantity: number
  minutes: number
  sessions: number
  from: string
  to: string
}

/**
 * How fast the work went, for one unit and one course, over time.
 *
 * This was a scatter of every session, and the user could not read it:
 * *"again, this data still doesn't make any sense. i love the FORMAT of the
 * bar chart, but this graph doesn't tell me anything! i can't read any data
 * points, are you trying to tell me if im getting more efficient? that
 * doesn't make sense because right now you would be comparing MATH 1410
 * questions to CIS 1200 questions"*.
 *
 * Three separate faults, and the first is the one that mattered:
 *
 * - **A rate is only comparable within one unit AND one subject.** Keeping
 *   the unit picker and nothing else meant 775 questions from Bio, CIS 1200
 *   and the SAT on one axis, and no movement in that series could mean
 *   anything. A course picker sits beside the unit picker now, and the title
 *   names both.
 * - **775 dots cannot be read.** Pooled into weekly or monthly bars with the
 *   value written on each one, they can - which is the format the user said
 *   they liked, from the Hours by project panel, so it is the same format.
 * - **The tooltip said `day: 19884`**, a raw epoch-day index, next to a bare
 *   `rate`. It now names the period in MM/DD/YYYY, the hours, the quantity
 *   and the rate with its unit.
 *
 * The bar is the **pooled** rate - total quantity over total minutes - not
 * the mean of each session's rate. See `RateBar`: those are different
 * numbers, and the pooled one is what "average across the entire section"
 * asks for.
 */
export function RateTrend({
  ratesByUnit,
  units,
  accent,
  control,
  range
}: {
  ratesByUnit: Record<string, RatePoint[]>
  units: string[]
  accent: string
  control?: React.ReactNode
  /** Chooses the grain as well as the span: weeks up to a quarter, months beyond. */
  range: WindowId
}): React.JSX.Element {
  const [chosenUnit, setChosenUnit] = useState('')
  const [chosenCourse, setChosenCourse] = useState(ALL_COURSES)

  // Derived rather than stored in an effect, so a unit that disappears from
  // the data cannot leave the chart showing an empty series for a stale name.
  const unit = units.includes(chosenUnit) ? chosenUnit : (units[0] ?? '')
  const forUnit = unit === '' ? [] : (ratesByUnit[unit] ?? [])

  /*
   * The courses offered are the ones present *in this unit*, not in the
   * history at large. Picking `words` and being offered `CIS 1200` - which
   * is measured in questions - is an option that selects an empty chart.
   */
  const courses = coursesIn(forUnit.map((point) => point.task))
  const course = courses.some((one) => one.course === chosenCourse) ? chosenCourse : ALL_COURSES
  const points =
    course === ALL_COURSES ? forUnit : forUnit.filter((point) => courseFrom(point.task) === course)

  const days = windowDef(range).days
  const grain: RateGrain = days !== null && days <= 92 ? 'week' : 'month'
  const bars: RateBarRow[] = rateBars(points, grain).map((bar) => ({
    label: grain === 'month' ? monthLabel(bar.from) : formatMonthDay(bar.from),
    rate: round(bar.rate, 3),
    quantity: bar.quantity,
    minutes: bar.minutes,
    sessions: bar.sessions,
    from: bar.from,
    to: bar.to
  }))

  const quantity = points.reduce((sum, p) => sum + p.quantity, 0)
  const minutes = points.reduce((sum, p) => sum + p.minutes, 0)
  const overall = minutes > 0 ? quantity / minutes : null

  const noun = unit === '' ? '' : pluralUnit(unit, 2)
  const title =
    unit === ''
      ? 'Work rate over time'
      : `${course === ALL_COURSES ? 'All courses' : course} · ${noun} per minute`

  // One row per bucket, tall enough that every label fits without thinning.
  const height = Math.max(180, bars.length * 24 + 36)
  const valueOf = (bar: RateBarRow): string => `${round(bar.rate, 2)}`

  return (
    <Frame
      title={title}
      sub={bars.length > 0 ? `${count(bars.length, grain)} with work in ${noun}` : undefined}
      aside={
        <>
          {units.length > 0 ? (
            <label className="ac__note" style={{ margin: 0 }}>
              Unit{' '}
              <select
                className="ac__unit"
                value={unit}
                onChange={(e) => setChosenUnit(e.target.value)}
                aria-label="Unit to measure"
              >
                {units.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {courses.length > 0 ? (
            <label className="ac__note" style={{ margin: 0 }}>
              Course{' '}
              <select
                className="ac__unit"
                value={course}
                onChange={(e) => setChosenCourse(e.target.value)}
                aria-label="Course to measure"
              >
                <option value={ALL_COURSES}>All courses</option>
                {courses.map((one) => (
                  <option key={one.course} value={one.course}>
                    {one.course}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {control}
        </>
      }
      note={
        unit === '' || overall === null ? undefined : (
          <>
            {round(overall, 2)} {noun} per minute overall, across {count(points.length, 'session')}.{' '}
            {course === ALL_COURSES ? (
              <>
                {/* Said plainly, because it is the thing that made the old
                    chart meaningless and the user spotted it before we did. */}
                <b>All courses mixes subjects</b> — {noun} for one course are not the same work as{' '}
                {noun} for another, so read this as a rough overall pace and pick a course to
                compare like with like.{' '}
              </>
            ) : (
              ''
            )}
            Sessions under five minutes and sessions entered by hand are left out: a quantity
            divided by two minutes, or by a remembered duration, is not a pace. Rates are never
            compared across units.
          </>
        )
      }
    >
      {(tickPx) =>
        unit === '' ? (
          <Empty height={180}>
            No sessions with a recorded quantity yet. A unit appears here once there is enough of it
            to measure.
          </Empty>
        ) : bars.length === 0 ? (
          <Empty height={180}>
            {`No ${noun} recorded${course === ALL_COURSES ? '' : ` for ${course}`} in this period.`}
          </Empty>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <BarChart
              data={bars}
              layout="vertical"
              margin={{
                top: 0,
                right: Math.max(36, Math.ceil(widest(bars.map(valueOf), VALUE_PX)) + 14),
                left: 0,
                bottom: 0
              }}
            >
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" tickLine={false} />
              {/* `interval={0}`: Recharts thins category ticks by default,
                  and a bar whose period is not named is a bar nobody can
                  read - which is the whole complaint this panel answers. */}
              <YAxis
                type="category"
                dataKey="label"
                width={categoryAxisWidth(
                  bars.map((bar) => bar.label),
                  tickPx
                )}
                interval={0}
                tickLine={false}
              />
              {/* The old tooltip read `Minutes: 134, day: 19884, rate: 1.91`
                  - an epoch-day index and a bare number. The pace leads now,
                  large and white, with what it was computed from under it in
                  the caption's size. */}
              <Tooltip
                {...NO_CURSOR}
                content={
                  <ChartTip
                    when={(_label, payload) => {
                      const row = payload?.[0]?.payload as RateBarRow | undefined
                      if (!row) return ''
                      return grain === 'month'
                        ? `${formatDate(row.from)} – ${formatDate(row.to)}`
                        : `Week of ${formatDate(row.from)}`
                    }}
                    rows={(payload) => {
                      const row = payload?.[0]?.payload as RateBarRow | undefined
                      if (!row) return []
                      return [
                        { name: `${noun} per minute`, value: `${round(row.rate, 2)}` },
                        {
                          name: `${formatCount(row.quantity)} ${noun} in ${round(row.minutes / 60, 1)} h`,
                          value: count(row.sessions, 'session')
                        }
                      ]
                    }}
                  />
                }
              />
              <Bar
                dataKey="rate"
                name="Pace"
                fill={accent}
                radius={[0, 2, 2, 0]}
                isAnimationActive={false}
              >
                <LabelList
                  dataKey="rate"
                  position="right"
                  offset={6}
                  className="ac__value"
                  formatter={(value: React.ReactNode) => `${round(Number(value), 2)}`}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )
      }
    </Frame>
  )
}

/**
 * Below this, the plot is replaced by the outline and the sentence.
 *
 * Two points drawn as a chart is the same fault as three sessions drawn as a
 * heatmap: it is a shape the data cannot support, and the reader takes a
 * trend from it. This is the state the chart spends its first week in, so it
 * is the state worth designing, not an edge case.
 */
const FEW_PACED = 3

interface PaceDot {
  day: number
  ratio: number
  date: string
  target: number
  actual: number
  unit: string
}

/**
 * Predicted output against what the session actually produced.
 *
 * **Plots `ratio`, never `target` against `actual`.** Those are absolute
 * amounts in whatever the session was measured in, so `250 words` and
 * `19 questions` on one axis is the same category error as trending rates
 * across units. The ratio is dimensionless, so every paced session belongs in
 * one series however it was counted. 1.0 is where the prediction landed.
 *
 * Nothing imported can ever appear here. A pace target is something the app
 * records while a session runs; the spreadsheet stored a countdown reading
 * and no target, so the 3.5 years of history contribute exactly zero points
 * and always will. The empty state says so, because a chart that is empty for
 * a permanent reason should not look like one that is merely waiting.
 */
export function PaceAccuracy({
  pace,
  accent,
  control
}: {
  pace: PacePoint[]
  accent: string
  control?: React.ReactNode
}): React.JSX.Element {
  const dots: PaceDot[] = pace.map((p) => ({
    day: dayNumber(p.date),
    ratio: round(p.ratio, 3),
    date: p.date,
    target: round(p.target, 1),
    actual: p.actual,
    unit: p.unit
  }))

  const first = pace[0]?.date ?? null
  const last = pace[pace.length - 1]?.date ?? null
  // Said in the empty state, because "2 sessions" on its own sounds like two
  // points spread across the history rather than two in one afternoon.
  const span =
    first === null || last === null
      ? ''
      : first === last
        ? `, both on ${first}`
        : `, ${first} to ${last}`

  if (dots.length < FEW_PACED) {
    return (
      <Frame
        title="Pace against target"
        /* "not enough data yet" is the wrong sub for this panel. Time of day
           is EARLY - it thickens as the app gets used. This one is
           structurally empty: no imported row can ever carry a pace target,
           so it is not waiting for history to catch up, it is waiting for the
           feature to be switched on. A sub implying patience would fix it
           would be a small lie. */
        sub={dots.length === 0 ? 'not switched on yet' : 'ratio of actual to target'}
        aside={control}
      >
        <EmptyState
          title={
            dots.length === 0
              ? 'No session has run against a pace target yet'
              : `${count(dots.length, 'session')} run with a pace target${span}`
          }
          progress={dots.length / FEW_PACED}
          /* The shape the chart would occupy, so the panel reads as a slot
             waiting rather than a gap in the page. One mark per session it
             would take to be worth plotting. */
          track={
            <div className="an-track">
              {Array.from({ length: FEW_PACED * 4 }, (_, i) => (
                <span
                  key={i}
                  className={i < dots.length ? 'is-on' : undefined}
                  title={
                    i < dots.length
                      ? `${formatDate(dots[i].date)} — ${dots[i].actual} of ${dots[i].target} ${dots[i].unit} (${Math.round(dots[i].ratio * 100)}%)`
                      : 'no paced session yet'
                  }
                />
              ))}
            </div>
          }
        >
          Set a pace from the button beside start — something like 100 words per 20 minutes — and
          this starts filling: each session appears as what you actually produced over what you
          aimed at. The imported history never contributes, however much of it there is, because
          Hourglass stored a countdown reading with no target attached.
        </EmptyState>
      </Frame>
    )
  }

  const days = dots.map((d) => d.day)
  const low = Math.min(...days)
  const high = Math.max(...days)
  // Several sessions on one day would otherwise give a zero-width domain.
  const pad = Math.max(3, (high - low) * 0.02)

  const met = dots.filter((d) => d.ratio >= 1).length
  const mean = dots.reduce((sum, d) => sum + d.ratio, 0) / dots.length
  // Headroom above the reference line, so a run that beat its target is not
  // drawn flush against the top edge. Rounded up to a half, and ticked in
  // halves, because letting Recharts divide an arbitrary ceiling gave
  // `0.35× 0.7× 1.05×` - gridlines at values nobody thinks in. Halves put a
  // line exactly on 1.0, which is the one number this chart is about.
  const ceiling = Math.max(1.5, Math.ceil(Math.max(...dots.map((d) => d.ratio)) * 2.2) / 2)
  const ticks = Array.from({ length: Math.round(ceiling * 2) + 1 }, (_, i) => i / 2)

  return (
    <Frame
      title="Pace against target"
      sub="ratio of actual to target"
      aside={control}
      note={`${count(dots.length, 'paced session')}, ${met} at or above target. Mean ${round(mean, 2)}× what was aimed at; the dashed line at 1.0 is where a prediction landed exactly. The ratio is unit-free, so sessions counted in words and in questions belong on one axis — the absolute amounts never would.`}
    >
      {(tickPx) => (
        <ResponsiveContainer width="100%" height={220}>
          <ScatterChart
            margin={{
              top: topMarginFor(tickPx),
              right: rightMarginFor(
                [spanLabel(isoDate(low), high - low), spanLabel(isoDate(high), high - low)],
                tickPx,
                12
              ),
              left: 0,
              bottom: 0
            }}
          >
            <CartesianGrid stroke={GRID} />
            <XAxis
              type="number"
              dataKey="day"
              domain={[low - pad, high + pad]}
              tickLine={false}
              tickFormatter={(value: string | number): string =>
                spanLabel(isoDate(Number(value)), high - low)
              }
            />
            {/* The ticks are given explicitly here, so the widest label is
              known exactly rather than probed for. */}
            <YAxis
              type="number"
              dataKey="ratio"
              width={yAxisWidth(
                ticks.map((tick) => `${tick}×`),
                tickPx
              )}
              tickLine={false}
              domain={[0, ceiling]}
              ticks={ticks}
              allowDataOverflow
              tickFormatter={(value: string | number): string => `${Number(value)}×`}
            />
            {/* Labelled: an unexplained line across a chart that gets filmed is
              debris. This is the whole point of the panel - above it you beat
              the target, below it you missed. */}
            <ReferenceLine
              y={1}
              stroke={tint(accent, '80')}
              strokeDasharray="4 4"
              label={{ value: 'target', position: 'insideBottomRight', fontSize: 10 }}
            />
            <Tooltip
              {...NO_CURSOR}
              content={
                <ChartTip
                  when={(_label, payload) => {
                    const row = payload?.[0]?.payload as PaceDot | undefined
                    return row === undefined ? '' : formatDate(row.date)
                  }}
                  rows={(payload) => {
                    const row = payload?.[0]?.payload as PaceDot | undefined
                    if (row === undefined) return []
                    return [
                      {
                        name: `of the ${row.target} ${row.unit} aimed at`,
                        value: `${round(row.ratio, 2)}×`
                      },
                      { name: 'produced', value: `${row.actual} ${row.unit}` }
                    ]
                  }}
                />
              }
            />
            <Scatter
              name="Share of target"
              data={dots}
              fill={tint(accent, 'cc')}
              stroke={accent}
              isAnimationActive={false}
            />
          </ScatterChart>
        </ResponsiveContainer>
      )}
    </Frame>
  )
}
