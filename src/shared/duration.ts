/**
 * Duration parsing for the editable clock, modelled on Hourglass's
 * TimeSpanToken: a colon form, a unit form that accepts abbreviations with or
 * without spaces, spelled-out numbers, and a bare number meaning minutes.
 *
 *   90                -> 90 minutes
 *   5:30              -> 5 minutes 30 seconds
 *   1:30:00           -> 1 hour 30 minutes
 *   one hour          -> 1 hour
 *   1 HR / 1hr / 1h   -> 1 hour
 *   onem / one min    -> 1 minute
 *   1h30m             -> 1 hour 30 minutes
 *   90 sec            -> 90 seconds
 *   twenty five min   -> 25 minutes
 *   half an hour      -> 30 minutes
 */

const MAX_MS = 24 * 60 * 60 * 1000

/** Longest first, so `ninety` is not matched as `nine`. */
const NUMBER_WORDS: Array<[string, number]> = [
  ['seventeen', 17],
  ['thirteen', 13],
  ['fourteen', 14],
  ['eighteen', 18],
  ['nineteen', 19],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventy', 70],
  ['quarter', 0.25],
  ['hundred', 100],
  ['eleven', 11],
  ['twelve', 12],
  ['twenty', 20],
  ['thirty', 30],
  ['eighty', 80],
  ['ninety', 90],
  ['eight', 8],
  ['forty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seven', 7],
  ['three', 3],
  ['nine', 9],
  ['fourty', 40],
  ['four', 4],
  ['five', 5],
  ['half', 0.5],
  ['zero', 0],
  ['one', 1],
  ['two', 2],
  ['six', 6],
  ['ten', 10],
  ['an', 1],
  ['a', 1]
]

const UNIT_SECONDS: Array<[string, number]> = [
  ['seconds', 1],
  ['second', 1],
  ['secs', 1],
  ['sec', 1],
  ['minutes', 60],
  ['minute', 60],
  ['mins', 60],
  ['min', 60],
  ['hours', 3600],
  ['hour', 3600],
  ['hrs', 3600],
  ['hr', 3600],
  ['days', 86_400],
  ['day', 86_400],
  ['s', 1],
  ['m', 60],
  ['h', 3600],
  ['d', 86_400]
]

/**
 * Turns spelled-out numbers into digits.
 *
 * Deliberately not anchored on a trailing word boundary, so `onem` becomes
 * `1m`. No unit name contains a number word, so this cannot corrupt one.
 */
function digitiseWords(text: string): string {
  let out = text
  for (const [word, value] of NUMBER_WORDS) {
    // `(^|[^a-z])` rather than a word boundary: the same match, expressed
    // without an escape, and the trailing side is left open on purpose so
    // `onem` becomes `1 m`. No unit name contains a number word, so a unit
    // cannot be corrupted by this.
    const pattern = new RegExp('(^|[^a-z])(' + word + ')', 'g')
    out = out.replace(pattern, (_match, prefix: string) => prefix + ' ' + value + ' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** `1:30:00` and `5:30`, matching what the clock displays. */
function parseColonForm(text: string): number | null {
  if (!/^\d{1,3}(:\d{1,2}){1,2}$/.test(text)) return null
  const parts = text.split(':').map(Number)
  return parts.length === 2
    ? parts[0] * 60_000 + parts[1] * 1000
    : parts[0] * 3_600_000 + parts[1] * 60_000 + parts[2] * 1000
}

export function parseDurationMs(input: string): number | null {
  const raw = input.trim().toLowerCase()
  if (raw === '') return null

  const colon = parseColonForm(raw)
  if (colon !== null) return colon >= 1000 && colon <= MAX_MS ? colon : null

  const text = digitiseWords(raw.replace(/[-,]/g, ' '))
  // Numbers and unit words only; anything else means the input is not a duration.
  const tokens = text.match(/\d+(?:\.\d+)?|[a-z]+/g)
  if (!tokens) return null

  let seconds = 0
  let pending: number | null = null
  let sawUnit = false

  for (const token of tokens) {
    if (/^\d/.test(token)) {
      const value = Number(token)
      // `twenty five` arrives as 20 then 5 and means 25, not two quantities.
      if (pending !== null && pending >= 20 && pending % 10 === 0 && value < 10) {
        pending += value
      } else if (pending !== null && value === 1) {
        // The 1 came from an article, as in `half an hour`. Articles carry no
        // quantity, so the pending value stands.
      } else if (pending !== null) {
        // Two unrelated bare numbers: the input is not a duration.
        return null
      } else {
        pending = value
      }
      continue
    }

    const unit = UNIT_SECONDS.find(([name]) => name === token)
    if (!unit) return null
    seconds += (pending ?? 1) * unit[1]
    pending = null
    sawUnit = true
  }

  // A bare number is minutes, which is how a countdown timer is usually spoken.
  if (pending !== null) seconds += pending * 60
  else if (!sawUnit) return null

  const ms = Math.round(seconds * 1000)
  return ms >= 1000 && ms <= MAX_MS ? ms : null
}

/** The canonical form: what parseDurationMs reads back, and what the clock shows. */
export function formatDurationInput(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
