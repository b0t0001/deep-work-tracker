/**
 * The insights card: one statement from `shared/insights.ts`, and only one.
 *
 * It took over the fun fact's tile and its place in the At a glance row.
 *
 * - **One at a time, with no way to step through them.** The user: *"there
 *   should only be 1 fun fact at a time. i don't want an arrow button to click
 *   through these."* The card is a glance, not a list to read.
 * - **A new one each time the tab is opened.** The Analytics tab mounts when
 *   it is shown, and its payload handler draws a random number and reads the
 *   id shown last time; `pickInsight` turns those into one insight, weighted
 *   toward the strong ones and never the one shown last - across launches
 *   too, since the last id is kept in storage. Both are chosen off the render
 *   path, so rendering stays pure, and nothing changes while you look at it.
 * - **No range control.** *"only that panel should NOT have a timescale
 *   button"*. Each insight reads its own window and its detail line names it.
 */
import { useEffect, useMemo } from 'react'
import type { SessionRow } from '@shared/analytics'
import { buildInsights, pickInsight } from '@shared/insights'

/** Remembered so the same insight is not opened on twice running. */
export const INSIGHT_KEY = 'dwt.lastInsight'

export const INSIGHT_CSS = `
/* No corner control on this tile, so the figure and lines need no clearance
   for one. */
.an-stat.an-insight > strong,
.an-stat.an-insight > span {
  padding-right: 0;
}
/* The sentence after the figure is the insight itself, so it reads at full
   strength; the numbers under it are the small print that makes it
   checkable, and step back accordingly. */
.an-stat > span.an-insight__text {
  color: var(--text);
}
.an-stat > span.an-insight__detail {
  margin-top: 4px;
  font-size: calc(10.5px * var(--an-fs, 1));
  opacity: 0.85;
}
`

export function InsightCard({
  rows,
  today,
  seed,
  avoid
}: {
  rows: readonly SessionRow[]
  today: string
  /** A number in [0, 1), drawn once when the tab was opened. */
  seed: number
  /** The id shown last time, read when the tab was opened. */
  avoid: string | null
}): React.JSX.Element | null {
  const current = useMemo(
    () => pickInsight(buildInsights({ rows, today }), seed, avoid),
    [rows, today, seed, avoid]
  )
  const shownId = current?.id ?? null

  // Remember what was on screen, so the next opening of the tab starts on
  // something else. Storage can be blocked; the cost of that is a repeat.
  useEffect(() => {
    if (shownId === null) return
    try {
      localStorage.setItem(INSIGHT_KEY, shownId)
    } catch {
      /* storage blocked */
    }
  }, [shownId])

  // With no control on the card, an empty card would be a tile saying
  // nothing; leaving it out lets the row close up instead.
  if (current === null) return null
  return (
    <div className="an-stat an-insight">
      <style>{INSIGHT_CSS}</style>
      <strong>{current.figure}</strong>
      <span className="an-insight__text">{current.text}</span>
      <span className="an-insight__detail">{current.detail}</span>
    </div>
  )
}
