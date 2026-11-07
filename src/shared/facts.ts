/**
 * The "fun fact" tile: one figure pulled from the history, chosen at random
 * each time the Analytics tab is opened.
 *
 * **Superseded on screen by `insights.ts`**, which took over the tile. What
 * lives on from here is the vocabulary - `verbFor`, `pluralUnit`,
 * `formatCount`, `formatHours` - which the insights and the charts both use.
 * `buildFacts` and `pickFact` are no longer rendered.
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
  | 'unitTasks'
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

/** Whether a unit measures time rather than output. Shared with `insights.ts`. */
export function isTimeUnit(unit: string): boolean {
  return TIME_UNITS.has(unit.trim().toLowerCase())
}

/**
 * What doing a unit is called.
 *
 * *"for the fun fact, it should take in context. for example, 285 components
 * means 285 components CADded across XYZ sessions... it shouldn't just tell
 * me '285 components.' i get that i didn't specify the units as 'components
 * CADded' in the actual data, but you should be able to infer this"*
 *
 * This was six entries and everything else fell through to a bare noun. It is
 * now built from the user's own history rather than from guesses about what
 * the words might mean: the distinct `work_unit` values were listed by
 * frequency against a copy of the real database, and for each frequent one a
 * sample of the tasks it was recorded against was read. That is where
 * `components` → CADded comes from - every one of its 49 sessions is a task
 * beginning "CAD" - and it is why `cell` is "filled" rather than "written",
 * since those are morphology charts and college spreadsheets.
 *
 * A wrong verb is still worse than a vague one. Where the work genuinely goes
 * two ways the entry is `null` and `verbFor` decides from the tasks; where it
 * is a judgement nobody could check, the fallback is "done", which is honest
 * and never a bare noun.
 *
 * Ordered by how much of the history each covers, so the comment doubles as
 * the evidence. Counts are sessions in the 2,478-row history as of
 * 2026-11-06.
 */
const VERBS: Record<string, string | null> = {
  question: 'answered', // 775 — Bio, A2TH, worksheets
  word: 'written', // 526 — English, essays, applications
  slide: 'made', // 167 — notes, projects, Google Slides
  meeting: 'attended', // 90 — JPL and Scioly build meetings
  page: null, // 63 — a novel in Chinese and a Bio workbook: see verbFor
  cell: 'filled', // 52 — morphology charts, college research sheets
  component: 'CADded', // 49 — every task begins "CAD"
  video: 'made', // 42 — "Create a Video", "Record 2 Videos"
  sentence: 'written', // 33 — Chinese flipgrids and practice
  section: 'written', // 23 — resumes, applications, notes
  lab: 'completed', // 18 — CSA and AP Biology labs
  assignment: 'completed', // 16
  thumbnail: 'designed', // 15 — "Create Thumbnail for ..."
  test: null, // 13 — some taken, some graded: see verbFor
  term: 'studied', // 13 — vocabulary
  line: 'written', // 13
  task: 'completed', // 12
  competition: 'entered', // 10
  character: 'written', // 10 — Chinese characters
  problem: 'solved', // 9
  internship: 'applied to', // 9
  document: 'written', // 8
  activitie: 'completed', // 8 — the import's singular of "activities"
  step: 'completed', // 7
  part: 'made', // 7
  form: 'filled in', // 6
  email: 'sent', // 6
  concept: 'learned', // 6
  'cad model': 'made', // 6
  vocab: 'learned', // 5
  edit: 'made', // 5
  article: 'read', // 5
  timeline: 'made', // 5
  topic: 'covered', // 4
  paragraph: 'written', // 4
  idea: 'generated', // 4
  event: 'attended' // 4
}

/** Tasks that mean the unit was consumed rather than produced. */
const READING = /(^|[^a-z])(read|reading|skim|review|annotate)|读/i

/** Tasks that mean it was produced. */
const WRITING = /(^|[^a-z])(write|writing|essay|draft|outline|notes?|report|journal)/i

/** Tasks that mean a test was marked rather than sat. */
const GRADING = /(^|[^a-z])(grade|grading|mark|marking|score|scoring)/i

/**
 * The verb for a unit, using the work it was recorded against where the unit
 * alone cannot say.
 *
 * `page` is the case this exists for. The real history has 63 of them, split
 * between reading a novel in Chinese - `Read 三体`, `读三体` - and working
 * through a Bio workbook. One verb for both would be wrong about half the
 * card's appearances, and "pages" with no verb is what the user objected to.
 *
 * It decides by which kind of task is in the majority, not by the first match,
 * because a single `Review Answers` among sixty written pages should not flip
 * the sentence. A tie, or nothing recognisable, falls through to the default.
 */
export function verbFor(unit: string, tasks: readonly string[] = []): string {
  const key = unit.trim().toLowerCase()
  const known = VERBS[key]
  if (typeof known === 'string') return known
  // A unit typed as a phrase - `seconds edited`, `questions reviewed` - was
  // written whole by the user and already contains its verb.
  if (/\s/.test(key)) return ''
  if (!(key in VERBS)) return 'done'

  let reading = 0
  let writing = 0
  let grading = 0
  for (const task of tasks) {
    if (READING.test(task)) reading += 1
    if (WRITING.test(task)) writing += 1
    if (GRADING.test(task)) grading += 1
  }

  if (key === 'test') return grading > 0 && grading >= tasks.length - grading ? 'graded' : 'taken'
  if (reading > writing) return 'read'
  if (writing > reading) return 'written'
  return 'done'
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

/**
 * The number exactly as recorded, grouped.
 *
 * *"no. big numbers should always be exact"*, in as many words, after a first
 * version rounded 296,412 words to "nearly 300k". The abbreviation read well
 * and threw away the thing the card is for: the user knows roughly how much
 * they have written, and the point of seeing it is the actual figure.
 *
 * It used to round to whole numbers too, on the reasoning that a fractional
 * slide is not a fact. Some of them are - 1,975.5 slides and 2,158 cells are
 * both really in the history, and half a slide is half a slide. Trailing
 * zeros are trimmed, so a whole number still prints as one.
 */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
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
    // Never a bare noun. "285 components" was the complaint; the worst this
    // can now say is "285 components done", which at least names an action.
    // Optional-chained although the type says it is there. A payload from a
    // main process built before this field existed has no `unitTasks`, and a
    // fun fact is the least important thing on the tab - it must not be able
    // to throw the whole Analytics tab away on first paint.
    const verb = verbFor(u.unit, a.unitTasks?.[u.unit] ?? [])
    facts.push({
      id: `unit:${u.unit}`,
      value: formatCount(u.quantity),
      label: verb === '' ? noun : `${noun} ${verb}`,
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
