/**
 * The insights card: one statement at a time from `shared/insights.ts`, with
 * a small control to step to the next.
 *
 * It took over the fun fact's tile, its place in the At a glance row and its
 * range target (`fact`), so a range the user already chose for the fun fact
 * carries straight over.
 *
 * - **It opens on a different one each time.** The payload handler in the
 *   Analytics tab draws a random number and reads the id shown last time;
 *   `pickInsight` turns those into an opening insight, weighted toward the
 *   strong ones and never the one shown last. Both are chosen off the render
 *   path, so rendering stays pure.
 * - **Changing the range keeps your place** where the insight survives the
 *   new range - the click handler pins the current id before the range moves.
 *   Where it does not survive, the opening pick runs on the new list.
 * - **The stepper walks the list strongest first**, wrapping, and says where
 *   you are in it (`3 / 14`), so it is clear the card has more to say.
 */
import { useEffect, useMemo, useState } from 'react'
import type { SessionRow } from '@shared/analytics'
import { buildInsights, nextInsightId, pickInsight } from '@shared/insights'
import type { Range, WindowId } from '@shared/windows'
import { RangePicker } from './RangePicker'

/** Remembered so the same insight is not opened on twice running. */
export const INSIGHT_KEY = 'dwt.lastInsight'

export const INSIGHT_CSS = `
.an-insight {
  display: flex;
  flex-direction: column;
}
/* The range sits in the card's control row, beside the stepper, rather than
   in the top-right corner where the other tiles keep theirs. This figure can
   be a word - "MATH 1410", "Weekends", "11 AM–1 PM" - and at 1150px a
   corner control either ran under it or, given clearance, broke a course
   code over two lines. One row of controls at the foot keeps the figure
   whole and puts both of the card's controls in one place. */
.an-stat.an-insight > strong,
.an-stat.an-insight > span {
  padding-right: 0;
}
.an-stat.an-insight .an-insight__nav .an-range {
  position: static;
  margin-left: auto;
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
.an-insight__nav {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: auto;
  padding-top: 8px;
  color: var(--text-dim);
  font-size: calc(10.5px * var(--an-fs, 1));
  font-variant-numeric: tabular-nums;
}
.an-insight__nav button {
  appearance: none;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-dim);
  font: inherit;
  font-size: calc(13px * var(--an-fs, 1));
  line-height: 1;
  padding: 2px 7px 3px;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    color 120ms ease;
}
.an-insight__nav button:hover {
  border-color: var(--border);
  color: var(--text);
}
.an-insight__nav > span[aria-live] {
  min-width: 3.4em;
  text-align: center;
}
`

export function InsightCard({
  rows,
  range,
  label,
  today,
  seed,
  avoid,
  rangeId,
  onRange,
  customText,
  onCustomText
}: {
  rows: readonly SessionRow[]
  /** The card's range, or null for all time. */
  range: Range | null
  /** The window's words, `past 30 days`, for the sentences. */
  label: string
  today: string
  /** A number in [0, 1), drawn once when the history arrived. */
  seed: number
  /** The id opened on last time, read when the history arrived. */
  avoid: string | null
  rangeId: WindowId
  onRange: (next: WindowId) => void
  customText: string
  onCustomText: (next: string) => void
}): React.JSX.Element {
  const [pinned, setPinned] = useState<string | null>(null)
  const from = range?.from ?? null
  const to = range?.to ?? null
  const days = range?.days ?? null
  const insights = useMemo(
    () =>
      buildInsights({
        rows,
        range: from === null || to === null || days === null ? null : { from, to, days },
        label,
        today
      }),
    [rows, from, to, days, label, today]
  )
  const current = insights.find((i) => i.id === pinned) ?? pickInsight(insights, seed, avoid)
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

  const position = current === null ? 0 : insights.findIndex((i) => i.id === current.id) + 1

  return (
    <div className="an-stat an-insight">
      <style>{INSIGHT_CSS}</style>
      {current === null ? (
        // Never nothing at all: the range control lives on this card, so a
        // card that vanished on a short range would take the only way back
        // with it. Says why it is empty instead.
        <span className="an-insight__text">
          Not enough recorded over the {label} for anything worth saying. Try a longer range.
        </span>
      ) : (
        <>
          <strong>{current.figure}</strong>
          <span className="an-insight__text">{current.text}</span>
          <span className="an-insight__detail">{current.detail}</span>
        </>
      )}
      <div className="an-insight__nav">
        {current !== null && insights.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous insight"
              title="Previous insight"
              onClick={() => setPinned(nextInsightId(insights, current.id, -1))}
            >
              &lsaquo;
            </button>
            <span aria-live="polite">
              {position} / {insights.length}
            </span>
            <button
              type="button"
              aria-label="Next insight"
              title="Next insight"
              onClick={() => setPinned(nextInsightId(insights, current.id, 1))}
            >
              &rsaquo;
            </button>
          </>
        )}
        <RangePicker
          value={rangeId}
          onChange={(next) => {
            // Pin what is showing before the list changes under it, so a range
            // change keeps your place wherever that insight still applies.
            if (current !== null) setPinned(current.id)
            onRange(next)
          }}
          label="the insights"
          customText={customText}
          onCustomText={(next) => {
            if (current !== null) setPinned(current.id)
            onCustomText(next)
          }}
        />
      </div>
    </div>
  )
}
