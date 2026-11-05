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
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}`
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
/**
 * How far back the bars go.
 *
 * The whole history is 189 weeks, which across this panel is about 6px a bar
 * with no gap - a seismograph rather than a chart. Two years is the default
 * because it is the shortest span that still shows the thing the data has to
 * say, which is that the weekly load roughly doubled through 2024; one year is
 * there to read recent weeks individually, and the whole record is one click
 * away rather than the thing you have to start from.
 */
const SPANS = [
  { id: '1y', label: '1y', weeks: 53 },
  { id: '2y', label: '2y', weeks: 105 },
  { id: 'all', label: 'all', weeks: Infinity }
] as const

type SpanId = (typeof SPANS)[number]['id']

export function HoursOverTime({
  daily,
  accent
}: {
  daily: DayTotal[]
  accent: string
}): React.JSX.Element {
  const [span, setSpan] = useState<SpanId>('2y')
  const all = weeklyBars(daily)
  const weeks = SPANS.find((s) => s.id === span)?.weeks ?? Infinity
  // Trimmed from the end, so a shorter span is the most recent weeks rather
  // than the first ones recorded.
  const bars = Number.isFinite(weeks) ? all.slice(-weeks) : all

  return (
    <Frame
      title="Hours per week"
      sub={bars.length > 0 ? `${bars.length} weeks, Monday to Sunday` : undefined}
      aside={
        all.length > SPANS[0].weeks ? (
          <div className="an-seg">
            {SPANS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={option.id === span ? 'is-on' : undefined}
                aria-pressed={option.id === span}
                onClick={() => setSpan(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : undefined
      }
      note={
        bars.length > 0
          ? `Running time only; paused time is never counted.${
              bars.length < all.length ? ` The whole record runs to ${all.length} weeks.` : ''
            }`
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
function rateCeiling(rates: number[]): number {
  if (rates.length === 0) return 1
  const sorted = [...rates].sort((a, b) => a - b)
  const at = sorted[Math.floor((sorted.length - 1) * 0.98)]
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
  accent
}: {
  pace: PacePoint[]
  accent: string
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
                      ? `${dots[i].date} — ${dots[i].actual} of ${dots[i].target} ${dots[i].unit} (${Math.round(dots[i].ratio * 100)}%)`
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
      note={`${count(dots.length, 'paced session')}, ${met} at or above target. Mean ${round(mean, 2)}× what was aimed at; the dashed line at 1.0 is where a prediction landed exactly. The ratio is unit-free, so sessions counted in words and in questions belong on one axis — the absolute amounts never would.`}
    >
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
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
          <YAxis
            type="number"
            dataKey="ratio"
            width={48}
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
            {...TOOLTIP}
            cursor={{ stroke: '#ffffff20' }}
            labelFormatter={(_label: React.ReactNode, payload): string => {
              const row = payload?.[0]?.payload as PaceDot | undefined
              return row ? `${row.date} — ${row.actual} of ${row.target} ${row.unit}` : ''
            }}
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
    </Frame>
  )
}
