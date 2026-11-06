/**
 * One figure, set three ways, with the two comparisons that make it useful.
 *
 * It replaces two tiles and a seven-row table that were three readings of the
 * same number: *"look at how much redundant data there is. im not sure what
 * the difference is between the 3.21h measure, the 3.75h measure, and what
 * the table below is trying to tell me. you misunderstood me. i don't want a
 * direct copy of the table. I want ONE general box that i can quickly do
 * comparisons on."*
 *
 * Three decisions follow from that, and each is a thing not done:
 *
 * - **It shows one number at a time**, not a column of seven. The controls
 *   are how you get the other six, and a control you operate is a question
 *   you asked - which is the difference between reading a figure and
 *   scanning a table for the one that might be relevant.
 * - **An option that can only answer "—" is not offered.** The old table
 *   printed an em dash for "hours a month" over a week-long window. The
 *   grain picker lists only the grains the chosen range is long enough to
 *   fill, so the box can always answer.
 * - **Two comparisons, and no more.** The previous period of equal length
 *   says whether this is a good one; all time says whether it is a good one
 *   by your standards rather than in the abstract. A third would start
 *   rebuilding the table.
 */
import {
  COMPARE_WINDOWS,
  GRAINS,
  STATISTICS,
  compare,
  grainsFor,
  type Grain,
  type Statistic
} from '@shared/compare'
import type { CompareChoice } from '@shared/layout'
import { WINDOWS, windowDef, windowRange, type WindowId } from '@shared/windows'
import type { DayTotal } from '@shared/analytics'

export const COMPARE_CSS = `
.an-compare {
  grid-column: span 2;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* The controls read as a sentence, so they wrap like one. */
.an-compare__ask {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 5px;
  color: var(--text-dim);
  font-size: calc(12px * var(--an-fs, 1));
}
.an-compare__ask select {
  appearance: auto;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: calc(12px * var(--an-fs, 1));
  padding: 1px 3px;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    color 120ms ease;
}
.an-compare__ask select:hover,
.an-compare__ask select:focus {
  border-color: var(--border);
}
.an-compare__ask option {
  background: var(--surface-raised);
  color: var(--text);
}
.an-compare__answer {
  display: block;
  font-size: calc(31px * var(--an-fs, 1));
  font-weight: 640;
  letter-spacing: -0.6px;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}
.an-compare__against {
  color: var(--text-dim);
  font-size: calc(12px * var(--an-fs, 1));
  line-height: 1.5;
}
.an-compare__foot {
  color: var(--text-dim);
  font-size: calc(10.5px * var(--an-fs, 1));
  opacity: 0.75;
}
`

/** Two decimals on a daily figure, one on a weekly or monthly - a mean over seven noisy days does not carry two decimals. */
function hours(value: number | null, grain: Grain): string {
  if (value === null) return '—'
  const places = grain === 'day' ? 2 : 1
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places
  })} h`
}

export function CompareBox({
  daily,
  today,
  firstDate,
  choice,
  onChoice
}: {
  daily: DayTotal[]
  today: string
  firstDate: string | null
  choice: CompareChoice
  onChoice: (next: CompareChoice) => void
}): React.JSX.Element {
  const range = windowRange(choice.range, today, firstDate)
  const all = windowRange('all', today, firstDate)
  const allowed = grainsFor(windowDef(choice.range).days)

  const figures =
    range === null || all === null
      ? null
      : compare(daily, range, all, choice.statistic, choice.grain)

  const grain = figures?.grain ?? choice.grain
  const grainLabel = GRAINS.find((g) => g.id === grain)?.label ?? 'day'
  const windowLabel = windowDef(choice.range).label

  const ask = (
    <div className="an-compare__ask">
      <select
        value={choice.statistic}
        aria-label="Average or median"
        onChange={(event) => onChoice({ ...choice, statistic: event.target.value as Statistic })}
      >
        {STATISTICS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <span>hours per</span>
      <select
        /* The stored grain, not the usable one, so shortening the range and
           widening it again returns to what was chosen rather than to
           whatever the short range could manage. */
        value={allowed.includes(choice.grain) ? choice.grain : grain}
        aria-label="Per day, week or month"
        onChange={(event) => onChoice({ ...choice, grain: event.target.value as Grain })}
      >
        {GRAINS.filter((option) => allowed.includes(option.id)).map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <span>over the</span>
      <select
        value={choice.range}
        aria-label="Over how long"
        onChange={(event) => onChoice({ ...choice, range: event.target.value as WindowId })}
      >
        {WINDOWS.filter((option) => COMPARE_WINDOWS.includes(option.id)).map((option) => (
          <option key={option.id} value={option.id}>
            {option.label.replace(/^past /, '')}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <div className="an-stat an-stat--lead an-compare">
      <style>{COMPARE_CSS}</style>
      {ask}
      <strong className="an-compare__answer">{hours(figures?.value ?? null, grain)}</strong>
      <span className="an-compare__against">
        {figures === null || figures.value === null ? (
          `nothing recorded in the ${windowLabel}`
        ) : (
          <>
            {figures.changePercent === null ? (
              // Either there is no period before this one, or it had no
              // hours in it. "up ∞%" is not a comparison, and silence is
              // better than a number with no content behind it.
              <span>no earlier {grainLabel}s to compare against</span>
            ) : (
              <>
                <span className={figures.changePercent >= 0 ? 'is-up' : 'is-down'}>
                  {figures.changePercent >= 0 ? 'up' : 'down'}{' '}
                  {Math.abs(Math.round(figures.changePercent))}%
                </span>{' '}
                on the {windowLabel.replace(/^past /, '')} before
              </>
            )}
            {' · '}
            {hours(figures.allTime, grain)} all time
          </>
        )}
      </span>
      <span className="an-compare__foot">
        {/* One line, not the paragraph the table carried. The rule is
            load-bearing and settled in CLAUDE.md - dividing by worked days
            answers how long a working day is, not how much gets done - so it
            is stated, once, where the figure is read. */}
        Every calendar day counts, including days with no work.
      </span>
    </div>
  )
}
