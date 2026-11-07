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
 * - **Past 4 hours** only lightens the accent a little, reaching its cap at 8
 *   hours. A long day still stands out, but it cannot redefine every other
 *   day the way a maximum-based scale did.
 *
 * Absolute rather than relative also means a day keeps its colour forever:
 * adding a record day never repaints the rest of the grid.
 */

/** Hours that earn the full accent. */
export const DAILY_TARGET_HOURS = 4
/** Hours at which the extra brightness above the target stops growing. */
export const DAILY_BONUS_CAP_HOURS = 8
/** The faintest worked day, as a share of accent mixed into the empty colour. */
const FLOOR_PERCENT = 18
/** The most white mixed into the accent, reached at the bonus cap. */
const BONUS_WHITE_PERCENT = 32

export interface DayShade {
  /** Accent mixed into the empty-cell colour, 0-100. 0 means an empty day. */
  accentPercent: number
  /** White mixed into the full accent above the target, 0-100. */
  whitePercent: number
}

export function dayShade(hours: number): DayShade {
  if (!(hours > 0)) return { accentPercent: 0, whitePercent: 0 }
  if (hours < DAILY_TARGET_HOURS) {
    const share = hours / DAILY_TARGET_HOURS
    return {
      accentPercent: Math.round(FLOOR_PERCENT + (100 - FLOOR_PERCENT) * share),
      whitePercent: 0
    }
  }
  const over = Math.min(
    1,
    (hours - DAILY_TARGET_HOURS) / (DAILY_BONUS_CAP_HOURS - DAILY_TARGET_HOURS)
  )
  return { accentPercent: 100, whitePercent: Math.round(BONUS_WHITE_PERCENT * over) }
}

/** The CSS colour for a day, given the accent. */
export function dayFill(hours: number, accent: string): string {
  const { accentPercent, whitePercent } = dayShade(hours)
  if (accentPercent === 0) return 'var(--surface-raised)'
  if (whitePercent > 0) return `color-mix(in srgb, #ffffff ${whitePercent}%, ${accent})`
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
