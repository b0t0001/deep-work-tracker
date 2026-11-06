/**
 * The stats table: all time against the chosen window.
 *
 * This is the part of the old spreadsheet the user said they look at most -
 * "the info that i honestly look the most at" - so it is a table rather than a
 * chart, and it reads like the sheet did: a label on the left and two columns
 * of figures. Nothing here is a visualisation of anything; the point is to be
 * able to read a number off it.
 *
 * It is in its own file rather than in `AnalyticsCharts.tsx` because it is not
 * a chart: it imports no Recharts, it needs none of the axis and tooltip
 * styling that file exists to carry, and the panel markup it shares with the
 * charts is a handful of class names in `main.css` rather than a component.
 *
 * **The window is the stat row's, not its own.** Every figure in the right
 * column moves with the `Averages over` picker above, which is the whole
 * argument of spec items 18-20 taken together: one notion of "the period" for
 * the tab. A second picker here would be a second definition of "the past 8
 * weeks" waiting to disagree with the first.
 */
import { periodStats, type Analytics, type PeriodFigures } from '@shared/analytics'
import { formatDate } from '@shared/dates'
import { windowDef, windowRange, type WindowId } from '@shared/windows'

/**
 * Hours, at a precision that suits the size of the number.
 *
 * Two decimals on a daily figure and one on a weekly: 2.09 and 14.6 carry
 * about the same information, while 14.62 implies a precision that a mean over
 * seven noisy days does not have, and 2.1 throws away the difference between
 * two days that are genuinely unalike.
 */
function hours(value: number | null, places: number): string {
  if (value === null) return '—'
  return value.toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places
  })
}

interface Row {
  label: string
  /** Decimal places, chosen by the size of the figure - see `hours`. */
  places: number
  pick: (s: ReturnType<typeof periodStats>) => number | null
}

const ROWS: Row[] = [
  { label: 'Average hours a day', places: 2, pick: (s) => s.day.mean },
  { label: 'Median hours a day', places: 2, pick: (s) => s.day.median },
  { label: 'Average hours a week', places: 1, pick: (s) => s.week.mean },
  { label: 'Median hours a week', places: 1, pick: (s) => s.week.median },
  { label: 'Average hours a month', places: 1, pick: (s) => s.month.mean },
  { label: 'Median hours a month', places: 1, pick: (s) => s.month.median },
  { label: 'Total hours', places: 1, pick: (s) => s.totalHours }
]

/** `7 days · 1 week`, so the denominator of every figure above is on screen. */
function denominator(day: PeriodFigures, week: PeriodFigures, month: PeriodFigures): string {
  // A one-week window prints "1 week", which is also the window where it reads
  // most oddly if it does not - the single whole week is the entire column.
  const plural = (n: number, word: string): string =>
    `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
  const parts = [plural(day.count, 'day')]
  if (week.count > 0) parts.push(plural(week.count, 'week'))
  if (month.count > 0) parts.push(plural(month.count, 'month'))
  return parts.join(' · ')
}

export function StatsTable({
  data,
  today,
  window: windowId,
  accent
}: {
  data: Analytics
  today: string
  window: WindowId
  accent: string
}): React.JSX.Element {
  const whole = windowRange('all', today, data.firstDate)
  const picked = windowRange(windowId, today, data.firstDate)

  if (whole === null || picked === null) {
    return (
      <div className="ac an-panel">
        <div className="an-panel__head">
          <h4 className="an-panel__title">Stats</h4>
        </div>
        <p className="an-panel__note">Nothing recorded yet.</p>
      </div>
    )
  }

  const allTime = periodStats(data.daily, whole.from, whole.to)
  const window = periodStats(data.daily, picked.from, picked.to)
  const label = windowDef(windowId).label

  return (
    <div className="ac an-panel">
      <div className="an-panel__head">
        <h4 className="an-panel__title">
          Stats
          <span className="an-panel__sub">all time against the {label}</span>
        </h4>
      </div>

      <table className="an-stats-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">
              All time
              <span>{denominator(allTime.day, allTime.week, allTime.month)}</span>
            </th>
            {/* The chosen column is the one that moves, so it carries the
                accent - on the heading only. Accenting seven figures would
                make the column shout at a reader who is comparing it with the
                one beside it, which is the entire use of the table. */}
            <th scope="col" style={{ color: accent }}>
              The {label}
              <span>{denominator(window.day, window.week, window.month)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{hours(row.pick(allTime), row.places)}</td>
              <td>{hours(row.pick(window), row.places)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="an-panel__note">
        {/* Both rules are worth stating where the figures are read. The first
            is the one a reader is most likely to disagree with, and they
            should be able to see that it was a choice. */}
        {/*
         * The end date is here because the header above this panel prints a
         * lifetime total that includes today and this column's total does not
         * - 2,751 h against 2,750.9. Both are right, and the difference is one
         * unfinished day, but two totals on one screen with nothing to explain
         * the gap is how a reader stops believing either.
         *
         * The table is the one that gives way, by saying where it stops rather
         * than by taking today in. Every figure here divides by the days it
         * covers, so folding in a day still being lived would leave the total
         * covering one more day than the average beside it - a table that
         * disagrees with itself, which is worse than one that disagrees with a
         * caption.
         */}
        Everything here runs to the end of {formatDate(allTime.to)}, the last complete day, so work
        recorded today is not in it yet. Every calendar day counts, including days with no work — an
        average over worked days only would answer how long a working day is, not how much you get
        done. Weeks are 7 days and months 30, measured back from the end of the period; a part-week
        left over at the start is not counted as a week.
      </p>
    </div>
  )
}
