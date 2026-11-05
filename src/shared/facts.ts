/**
 * The "fun fact" tile: one figure pulled from the history, chosen at random
 * each time the Analytics tab is opened.
 *
 * Their words: *"what's the total # of questions i've answered, ever? how many
 * videos have i put out? how many hours have i spent editing in total? these
 * should just be some interesting facts, pulled from the data."*
 *
 * Two rules keep it from turning into clutter.
 *
 * **Built from the data, never a hardcoded list.** Units are typed by the user
 * and keep arriving, so the pool is generated from whatever `work_unit` holds.
 * The only hand-written part is a short map of verbs, so that `word` reads as
 * "words written" rather than just "words" - and a unit with no verb still
 * produces a fact, it just reads as a plain count.
 *
 * **Chosen once per open, not per render.** `pickFact` is a pure function of
 * the random number it is handed; the caller holds the result in state. A
 * figure that reshuffles while it is being read is a distraction, not a
 * delight.
 */
import type { Analytics } from './analytics'
import { formatDate } from './dates'

export interface Fact {
  /** Stable across opens, so the caller can avoid showing the same one twice running. */
  id: string
  /** The figure, already formatted: `292,358`, `15 h`. */
  value: string
  /** What the figure counts: `words written`. Read straight after the value. */
  label: string
  /** Where it came from, small: `across 526 sessions`. */
  detail: string
}

export type FactSource = Pick<
  Analytics,
  | 'unitTotals'
  | 'byProject'
  | 'longestSession'
  | 'daily'
  | 'editingHours'
  | 'totalHours'
  | 'firstDate'
>

/**
 * A unit has to have been used this often to become a fact.
 *
 * The tail of 212 units is mostly one-off spellings; "3 thumbnails" is not
 * interesting and "1 activitie" is a typo with a number on it.
 */
export const MIN_UNIT_SESSIONS = 5

/**
 * ...and have added up to something. "36 assignments" is true and flat; the
 * tile is for the numbers nobody guesses about themselves.
 */
export const MIN_UNIT_QUANTITY = 50

/**
 * How many units, most-used first, may contribute. Generous on purpose: the
 * user's own example, "seconds edited", is only 19th by use, and variety
 * across opens is the point of the tile.
 */
export const MAX_UNIT_FACTS = 20

/**
 * Units that measure time rather than output. "5,250 seconds" on its own says
 * nothing - seconds of what? A typed phrase such as `seconds edited` says what
 * was done and is kept; it never matches here because it is not a bare word.
 */
const TIME_UNITS = new Set(['second', 'sec', 'minute', 'min', 'hour', 'hr'])

/**
 * What doing a unit is called, where there is one obvious verb.
 *
 * Deliberately short. A wrong verb is worse than none - "pages read" for pages
 * that were written would be a small lie - so anything ambiguous stays a bare
 * count.
 */
const VERBS: Record<string, string> = {
  word: 'written',
  sentence: 'written',
  question: 'answered',
  problem: 'solved',
  cell: 'filled',
  slide: 'made'
}

/**
 * Plural of a stored unit.
 *
 * Units are stored singular where the import could singularise them, so the
 * plural is rebuilt here. A unit of more than one word (`seconds edited`,
 * `questions reviewed`) was typed whole and is already the phrase the user
 * wanted, so it is left exactly as it is.
 */
export function pluralUnit(unit: string, quantity: number): string {
  const u = unit.trim()
  if (u === '' || /\s/.test(u)) return u
  if (Math.round(quantity) === 1) return u
  if (/[^aeiou]y$/.test(u)) return u.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/.test(u)) return u + 'es'
  return u + 's'
}

/** `1,976` - whole numbers, US grouping. A fractional slide is not a fact. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** `15 h` for a long figure, `2.5 h` for a short one where the decimal matters. */
export function formatHours(h: number): string {
  const shown =
    h >= 10 ? Math.round(h).toLocaleString('en-US') : (Math.round(h * 10) / 10).toString()
  return `${shown} h`
}

function sessions(n: number): string {
  return n === 1 ? 'in 1 session' : `across ${formatCount(n)} sessions`
}

/**
 * Every fact the history supports, in a stable order.
 *
 * Empty for an empty history - the tile should then not render at all rather
 * than show "0 words written", which is a fact about nothing.
 */
export function buildFacts(a: FactSource): Fact[] {
  const facts: Fact[] = []

  const units = a.unitTotals
    .filter(
      (u) =>
        u.sessions >= MIN_UNIT_SESSIONS &&
        u.quantity >= MIN_UNIT_QUANTITY &&
        !TIME_UNITS.has(u.unit.trim().toLowerCase())
    )
    .slice(0, MAX_UNIT_FACTS)
  for (const u of units) {
    const noun = pluralUnit(u.unit, u.quantity)
    const verb = VERBS[u.unit.trim().toLowerCase()]
    facts.push({
      id: `unit:${u.unit}`,
      value: formatCount(u.quantity),
      label: verb ? `${noun} ${verb}` : noun,
      detail: sessions(u.sessions)
    })
  }

  if (a.totalHours > 0 && a.firstDate !== null) {
    facts.push({
      id: 'total',
      value: formatHours(a.totalHours),
      label: 'of deep work',
      detail: `since ${formatDate(a.firstDate)}`
    })
  }

  const longest = a.longestSession
  if (longest !== null && longest.hours > 0) {
    const what = longest.task ?? longest.project
    const parts = [what ? `"${what}"` : null, longest.date ? formatDate(longest.date) : null]
    facts.push({
      id: 'longest',
      value: formatHours(longest.hours),
      label: 'your longest single session',
      detail: parts.filter((p) => p !== null).join(', ')
    })
  }

  const biggest = a.daily.reduce<Analytics['daily'][number] | null>(
    (best, d) => (best === null || d.hours > best.hours ? d : best),
    null
  )
  // The biggest day is usually worth saying, except when it is just the
  // longest session again under another name - then it is one fact twice.
  const sameAsLongest =
    biggest !== null &&
    longest !== null &&
    biggest.date === longest.date &&
    Math.abs(biggest.hours - longest.hours) < 0.05
  if (biggest !== null && biggest.hours > 0 && !sameAsLongest) {
    facts.push({
      id: 'biggest-day',
      value: formatHours(biggest.hours),
      label: 'your biggest day',
      detail: formatDate(biggest.date)
    })
  }

  const top = a.byProject.reduce<Analytics['byProject'][number] | null>(
    (best, p) => (best === null || p.hours > best.hours ? p : best),
    null
  )
  if (top !== null && top.hours > 0) {
    facts.push({
      id: 'top-project',
      value: formatHours(top.hours),
      label: `on ${top.name}`,
      detail: `your most-worked project, ${sessions(top.sessions)}`
    })
  }

  if (a.editingHours > 0) {
    facts.push({
      id: 'editing',
      value: formatHours(a.editingHours),
      label: 'spent editing',
      // Says how it was counted, because it is a guess from task names and an
      // unexplained figure is one nobody trusts twice.
      detail: 'on tasks with "edit" in the name'
    })
  }

  return facts
}

/**
 * One fact, chosen by `random` (a number in [0, 1), as `Math.random` gives).
 *
 * `avoid` is the id shown last time, if the caller kept it: with more than one
 * fact to choose from, the same one never comes up twice running, which is
 * what makes reopening the tab feel like it rewards you.
 */
export function pickFact(facts: Fact[], random: number, avoid?: string | null): Fact | null {
  if (facts.length === 0) return null
  const pool = facts.length > 1 && avoid ? facts.filter((f) => f.id !== avoid) : facts
  const choices = pool.length > 0 ? pool : facts
  const r = Math.min(Math.max(random, 0), 0.999999)
  return choices[Math.floor(r * choices.length)]
}
