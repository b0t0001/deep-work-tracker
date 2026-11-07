/**
 * How strongly a day is coloured on the calendar, from its hours.
 *
 * A fixed target, not a scale relative to the user's own extremes. The grid
 * exists to reward consistency, and the user put it in those terms: a few
 * eight- and nine-hour days were setting the top of the scale, so an ordinary
 * three- or four-hour day came out mid-grey - "which is not good, that should
 * be a bright red, because what we want to reward is consistency... I
 * shouldn't be grading myself based off the maximum." So:
 *
 * - **0 to 4 hours** ramps smoothly from just above an empty day to the full
 *   accent. Four hours is the target; reaching it is the brightest ordinary
 *   colour.
 * - **4 hours and past it** is the full accent, and stays there. A long day is
 *   marked by the superstar ring (over `SUPERSTAR_HOURS`), not by a lighter
 *   colour - there was an 8 h+ shade for a while, and the user dropped it:
 *   "if 6 plus hours is a superstar day, then we don't need a separate color
 *   for 8 plus because I already know that will be a superstar."
 *
 * Absolute rather than relative also means a day keeps its colour forever:
 * adding a record day never repaints the rest of the grid.
 */

/** Hours that earn the full accent. */
export const DAILY_TARGET_HOURS = 4
/** The faintest worked day, as a share of accent mixed into the empty colour. */
const FLOOR_PERCENT = 18

export interface DayShade {
  /** Accent mixed into the empty-cell colour, 0-100. 0 means an empty day. */
  accentPercent: number
}

export function dayShade(hours: number): DayShade {
  if (!(hours > 0)) return { accentPercent: 0 }
  const share = Math.min(1, hours / DAILY_TARGET_HOURS)
  return { accentPercent: Math.round(FLOOR_PERCENT + (100 - FLOOR_PERCENT) * share) }
}

/** The CSS colour for a day, given the accent. */
export function dayFill(hours: number, accent: string): string {
  const { accentPercent } = dayShade(hours)
  if (accentPercent === 0) return 'var(--surface-raised)'
  return `color-mix(in srgb, ${accent} ${accentPercent}%, var(--surface-raised))`
}

/**
 * Superstar days: more than six hours.
 *
 * A fixed line, not a statistic. It was two standard deviations above the
 * average worked day (7.5 h on the real history) for an hour, and the user
 * replaced it: "just make it six hours... if it's a seven hour day I'm doing a
 * competition or PER or something" - a long club or competition day is a
 * different thing from six hours at a desk, but it is tracked the same, so a
 * statistic over the history mostly picked out those. Six is the line the
 * user chose, above the four-hour target.
 */
export const SUPERSTAR_HOURS = 6

export function isSuperstar(hours: number): boolean {
  return hours > SUPERSTAR_HOURS
}
