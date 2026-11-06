/**
 * Reading a length of time out of what the user typed into a range box.
 *
 * *"and then a custom field where i can insert anything"*. "Anything" is the
 * requirement: `45 days`, `3 weeks`, `10 months`, `1 year`, and a bare number
 * meaning days.
 *
 * It is deliberately **not** `shared/duration.ts`, which parses the clock -
 * `1h30m`, `half an hour`, `90 sec`. That one answers "how long should this
 * timer run", in seconds, and its smallest meaningful unit is a second; this
 * one answers "how far back should this chart look", in whole days, and a
 * span of ninety seconds is not a thing a chart can be set to. Sharing a
 * parser between them would mean one of the two accepting input that is
 * nonsense for it, and the clock's grammar is tuned to the way a duration is
 * typed under time pressure. Two small parsers, each with its own tests.
 *
 * **A failure says what is wrong, in the panel.** `CLAUDE.md`'s rule is that
 * the app speaks for itself: no dialog, no silent fallback to a default. The
 * reason comes back as a string the field prints under itself in red.
 */

/** The longest span worth accepting: beyond this it is all time anyway. */
export const MAX_SPAN_DAYS = 36_500

export interface SpanResult {
  /** Whole days, or null when the text could not be read. */
  days: number | null
  /** Why not, phrased for the user. Empty when `days` is set. */
  problem: string
}

const UNITS: { match: RegExp; days: number; name: string }[] = [
  // Each accepts the bare initial as well as the abbreviation and the word,
  // because `3w` is what gets typed when the point is to not reach for the
  // mouse. `3w` failed the first draft: `w(ee)?ks?` still demanded the k.
  { match: /^d(ay)?s?$/, days: 1, name: 'day' },
  { match: /^w((ee)?k)?s?$/, days: 7, name: 'week' },
  // A month is 30 days here, matching the 30-day window the ladder already
  // offers. `WINDOWS` separately defines its *named* month options as
  // twelfths of a 365-day year; that is a different question - those are
  // fixed presets whose exact lengths had to stay what they already were,
  // while this is arithmetic on a number somebody just typed, and 10 months
  // reading as 300 days is what they will expect.
  // `m` is months, not minutes. A chart's range is never ninety seconds, so
  // the ambiguity that matters in the clock field does not exist here.
  { match: /^m(o(n(th)?)?)?s?$/, days: 30, name: 'month' },
  { match: /^y((ea)?r)?s?$/, days: 365, name: 'year' }
]

/**
 * Days from a typed span, or the reason it could not be read.
 *
 * Empty input is not an error - it is a field nobody has finished typing in,
 * and reddening a box the moment it is cleared is the behaviour `CLAUDE.md`
 * already rejects for the clock and the pace fields. It returns no days and
 * no problem, and the caller leaves the range where it was.
 */
export function parseSpan(text: string): SpanResult {
  const trimmed = text.trim().toLowerCase()
  if (trimmed === '') return { days: null, problem: '' }

  // `45days`, `45 days` and `45` all land here. The number may carry a
  // decimal point because "1.5 months" is a reasonable thing to type; the
  // answer is still rounded to whole days, because a chart's range is days.
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([a-z]*)$/.exec(trimmed)
  if (match === null) {
    return { days: null, problem: 'Try something like 45 days, 3 weeks or 10 months.' }
  }

  const amount = Number(match[1])
  const unit = match[2]

  if (!Number.isFinite(amount) || amount <= 0) {
    return { days: null, problem: 'That has to be more than zero.' }
  }

  // A bare number is days, which is the convention the user asked for.
  const found = unit === '' ? UNITS[0] : UNITS.find((one) => one.match.test(unit))
  if (found === undefined) {
    return { days: null, problem: `"${match[2]}" is not a unit. Try days, weeks, months or years.` }
  }

  const days = Math.round(amount * found.days)
  if (days < 1) {
    return { days: null, problem: 'That rounds to less than a day.' }
  }
  if (days > MAX_SPAN_DAYS) {
    return { days: null, problem: 'That is longer than any history. Use All time.' }
  }
  return { days, problem: '' }
}
