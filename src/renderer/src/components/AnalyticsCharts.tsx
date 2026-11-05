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
import { useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis
} from 'recharts'
import type {
  DayTotal,
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
const TOOLTIP = {
  contentStyle: {
    background: 'var(--surface-raised)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--text)'
  },
  labelStyle: { color: 'var(--text-dim)', marginBottom: 2 },
  itemStyle: { color: 'var(--text)' }
}

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
.ac .recharts-cartesian-axis-tick text {
  fill: var(--text-dim);
  font-size: 11px;
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
  children: React.ReactNode
  note?: React.ReactNode
  hero?: boolean
}): React.JSX.Element {
  return (
    <div className={`ac an-panel${hero ? ' an-panel--hero' : ''}`}>
      <style>{CHART_CSS}</style>
      <div className="an-panel__head">
        <h4 className="an-panel__title">
          {title}
          {sub ? <span className="an-panel__sub">{sub}</span> : null}
        </h4>
        {aside}
      </div>
      {children}
      {note ? <p className="an-panel__note">{note}</p> : null}
    </div>
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

interface WeekBar {
  week: number
  hours: number
  sessions: number
  /** Blank on most bars - see the comment in `HoursOverTime`. */
  tick: string
  from: string
}

/**
 * Hours per week over the whole history.
 *
 * Weekly, not daily, because the history is ~1,280 days: at any window width
 * this app can show, a daily bar is under a pixel wide, so the chart becomes a
 * noise band and the real signal - which stretches were heavy - disappears.
 * A week is also the unit the user already thinks in (week-over-week is the
 * headline figure elsewhere). The axis and the caption both say so, since a
 * reader who assumes days would misread every height by a factor of seven.
 *
 * Empty weeks are filled rather than skipped: a month off must read as a gap,
 * not be closed up into a continuous run of work that never happened.
 */
export function HoursOverTime({
  daily,
  accent
}: {
  daily: DayTotal[]
  accent: string
}): React.JSX.Element {
  const bars = weeklyBars(daily)

  return (
    <Frame
      title="Hours per week"
      note={
        bars.length > 0
          ? `Each bar is one week, Monday to Sunday — ${bars.length} weeks of history. Running time only; paused time is never counted.`
          : undefined
      }
    >
      {bars.length === 0 ? (
        <Empty height={220}>No sessions recorded yet.</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={bars} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            {/* Ticks are pre-labelled quarterly and blank elsewhere: `interval={0}`
                then guarantees the labels that exist land on the right bars,
                rather than letting Recharts thin them and drop them. */}
            <XAxis dataKey="tick" interval={0} tickLine={false} />
            <YAxis width={36} tickLine={false} />
            <Tooltip
              {...TOOLTIP}
              cursor={{ fill: '#ffffff0a' }}
              labelFormatter={(_label: React.ReactNode, payload): string => {
                const row = payload?.[0]?.payload as WeekBar | undefined
                return row ? `Week of ${row.from}` : ''
              }}
            />
            <Bar
              dataKey="hours"
              name="Hours"
              unit=" h"
              fill={accent}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </Frame>
  )
}

function weeklyBars(daily: DayTotal[]): WeekBar[] {
  if (daily.length === 0) return []

  const totals = new Map<number, { hours: number; sessions: number }>()
  let first = Infinity
  let last = -Infinity
  for (const day of daily) {
    const week = weekStart(day.date)
    if (week < first) first = week
    if (week > last) last = week
    const found = totals.get(week)
    if (found) {
      found.hours += day.hours
      found.sessions += day.sessions
    } else {
      totals.set(week, { hours: day.hours, sessions: day.sessions })
    }
  }

  const out: WeekBar[] = []
  for (let week = first; week <= last; week += 7) {
    const found = totals.get(week) ?? { hours: 0, sessions: 0 }
    const from = isoDate(week)
    const month = Number(from.slice(5, 7))
    // One label a quarter: a month label every ~4 bars overlaps its neighbour
    // at any width this panel reaches.
    const firstWeekOfMonth = Number(from.slice(8, 10)) <= 7
    out.push({
      week,
      hours: round(found.hours, 2),
      sessions: found.sessions,
      from,
      tick: firstWeekOfMonth && month % 3 === 1 ? monthLabel(from) : ''
    })
  }
  return out
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
  accent
}: {
  byProject: ProjectTotal[]
  accent: string
}): React.JSX.Element {
  const bars = projectBars(byProject)
  const height = Math.max(160, bars.length * 26 + 32)

  return (
    <Frame title="Hours by project">
      {bars.length === 0 ? (
        <Empty height={160}>No projects with recorded time yet.</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart
            data={bars}
            layout="vertical"
            margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
          >
            <CartesianGrid stroke={GRID} horizontal={false} />
            <XAxis type="number" tickLine={false} unit=" h" />
            {/* `interval={0}`: Recharts thins category ticks by default, which
                dropped every other project name and left bars no one could
                identify. A bar without its label is not a chart. */}
            <YAxis type="category" dataKey="name" width={150} interval={0} tickLine={false} />
            <Tooltip {...TOOLTIP} cursor={{ fill: '#ffffff0a' }} />
            <Bar
              dataKey="hours"
              name="Hours"
              unit=" h"
              fill={accent}
              radius={[0, 2, 2, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
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
  accent
}: {
  data: PlannedVsActualPoint[]
  accent: string
}): React.JSX.Element {
  const all = ratioBars(data)
  const bars = all.filter((b) => b.sessions >= MIN_RUNS)
  const dropped = all.length - bars.length

  const runsByLabel = new Map(bars.map((b) => [b.label, b.sessions]))
  const sessions = all.reduce((sum, b) => sum + b.sessions, 0)
  const plannedTotal = all.reduce((sum, b) => sum + b.planned * b.sessions, 0)
  const actualTotal = all.reduce((sum, b) => sum + b.actual * b.sessions, 0)
  const share = plannedTotal > 0 ? Math.round((actualTotal / plannedTotal) * 100) : null

  return (
    <Frame
      title="How much of the timer you run"
      sub="by what it was set to"
      note={
        share === null ? undefined : (
          <>
            Each bar is the share of the set duration actually run, averaged over the sessions set
            to it; the count is under the label, and fainter bars rest on fewer sessions. Across all{' '}
            {count(sessions, 'run')} it is <b>{share}%</b>.
            {dropped > 0
              ? ` ${dropped} ${dropped === 1 ? 'duration' : 'durations'} with fewer than ${MIN_RUNS} runs ${dropped === 1 ? 'is' : 'are'} left out.`
              : ''}
          </>
        )
      }
    >
      {bars.length === 0 ? (
        <Empty height={220}>No completed runs to compare yet.</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={bars} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="label"
              interval={0}
              tickLine={false}
              height={34}
              tick={<RunsTick runs={runsByLabel} />}
            />
            <YAxis width={44} unit="%" tickLine={false} domain={[0, 100]} allowDataOverflow />
            <Tooltip
              {...TOOLTIP}
              cursor={{ fill: '#ffffff0a' }}
              labelFormatter={(label: React.ReactNode, payload): string => {
                const row = payload?.[0]?.payload as RatioBar | undefined
                return row ? `${label} — ${count(row.sessions, 'run')}` : String(label ?? '')
              }}
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
 */
function rateCeiling(rates: number[]): number {
  if (rates.length === 0) return 1
  const sorted = [...rates].sort((a, b) => a - b)
  const at = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))]
  const top = Math.max(at, sorted[0])
  return top > 0 ? top * 1.08 : 1
}

interface RateDot {
  day: number
  rate: number
  minutes: number
  quantity: number
  date: string
}

/**
 * Work rate over time, for one unit.
 *
 * One unit at a time is a correctness rule, not a layout choice: words per
 * minute and questions per minute are different quantities, so a shared axis
 * would invite an average that means nothing (CLAUDE.md, "Rates are only
 * comparable within a unit"). The selected unit is therefore named in the
 * heading, on the axis and in the picker, and only that unit's series is ever
 * drawn - there is no "all units" option to pick by accident.
 *
 * Scatter rather than a line: sessions land on irregular dates, so a
 * connecting stroke would draw a trend through weeks where nothing happened.
 * Dot area is the session's length, because a rate from two minutes of work is
 * far noisier than one from ninety and should not read as equally solid.
 */
export function RateTrend({
  ratesByUnit,
  units,
  accent
}: {
  ratesByUnit: Record<string, RatePoint[]>
  units: string[]
  accent: string
}): React.JSX.Element {
  const [chosen, setChosen] = useState('')
  // Derived rather than stored in an effect, so a unit that disappears from the
  // data cannot leave the chart showing an empty series for a stale name.
  const unit = units.includes(chosen) ? chosen : (units[0] ?? '')
  const points = unit === '' ? [] : (ratesByUnit[unit] ?? [])

  const dots: RateDot[] = points.map((p) => ({
    day: dayNumber(p.date),
    rate: round(p.rate, 3),
    minutes: round(p.minutes),
    quantity: p.quantity,
    date: p.date
  }))

  const quantity = points.reduce((sum, p) => sum + p.quantity, 0)
  const minutes = points.reduce((sum, p) => sum + p.minutes, 0)
  const mean = minutes > 0 ? quantity / minutes : null

  const days = dots.map((d) => d.day)
  const low = days.length > 0 ? Math.min(...days) : 0
  const high = days.length > 0 ? Math.max(...days) : 0
  // A single point, or several on one day, would otherwise give a zero-width
  // domain and nothing to plot against.
  const pad = Math.max(3, (high - low) * 0.02)

  // The y axis is set by a high percentile, not by the maximum. One session at
  // 16 question/min against a median near 0.5 made the axis run to 16 and
  // squashed 773 of 774 points into the bottom eighth of the panel, so the
  // chart showed an outlier and hid the data. Clipped points are counted and
  // said in the caption rather than dropped - they are real sessions, and a
  // chart that silently discards rows is worse than one with a busy top edge.
  const ceiling = rateCeiling(dots.map((d) => d.rate))
  const clipped = dots.filter((d) => d.rate > ceiling)
  const plotted = dots.filter((d) => d.rate <= ceiling)

  return (
    <Frame
      title={
        unit === ''
          ? 'Work rate over time'
          : `${unit.charAt(0).toUpperCase()}${unit.slice(1)}s per minute`
      }
      aside={
        units.length > 0 ? (
          <label className="ac__note" style={{ margin: 0 }}>
            Unit{' '}
            <select
              className="ac__unit"
              value={unit}
              onChange={(e) => setChosen(e.target.value)}
              aria-label="Unit to trend"
            >
              {units.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
        ) : undefined
      }
      note={
        unit === '' || mean === null
          ? undefined
          : `${round(mean, 2)} ${unit} per minute overall, across ${count(points.length, 'session')}.${
              clipped.length > 0
                ? ` ${count(clipped.length, 'session')} above ${round(ceiling, 2)}/min ${clipped.length === 1 ? 'sits' : 'sit'} off the top of the axis, which is scaled to the bulk of the data rather than to its fastest point.`
                : ''
            } Rates are never compared across units — switch the picker to see another.`
      }
    >
      {units.length === 0 ? (
        <Empty height={220}>
          No sessions with a recorded quantity yet. A unit appears here once there is enough of it
          to trend.
        </Empty>
      ) : dots.length === 0 ? (
        <Empty height={220}>{`No rates recorded in ${unit}.`}</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ScatterChart margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} />
            <XAxis
              type="number"
              dataKey="day"
              domain={[low - pad, high + pad]}
              tickLine={false}
              tickFormatter={(value: string | number): string => monthLabel(isoDate(Number(value)))}
            />
            <YAxis
              type="number"
              dataKey="rate"
              width={48}
              tickLine={false}
              domain={[0, round(ceiling, 2)]}
              allowDataOverflow
              label={{ value: `${unit}/min`, angle: -90, position: 'insideLeft' }}
            />
            <ZAxis type="number" dataKey="minutes" range={[18, 150]} name="Minutes" />
            {mean === null ? null : (
              // Labelled, because an unexplained dashed line across a chart
              // that is filmed is debris rather than information.
              <ReferenceLine
                y={round(mean, 3)}
                stroke={tint(accent, '80')}
                strokeDasharray="4 4"
                label={{ value: 'overall', position: 'insideBottomRight', fontSize: 10 }}
              />
            )}
            <Tooltip
              {...TOOLTIP}
              cursor={{ stroke: '#ffffff20' }}
              labelFormatter={(_label: React.ReactNode, payload): string => {
                const row = payload?.[0]?.payload as RateDot | undefined
                return row ? `${row.date} — ${row.quantity} ${unit}` : ''
              }}
            />
            <Scatter
              name={`${unit} per minute`}
              data={plotted}
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
