/**
 * The course a session was for, read out of its task name.
 *
 * A stand-in. `tags` exists in the schema for exactly this - course codes
 * such as `WRIT 0580` - and nothing writes to it yet (see **Known gaps** in
 * `CLAUDE.md`). Until something does, the codes live in the task text the
 * user already types, and this reads them back out. **When tags are real this
 * file is replaced by a join, not extended.**
 *
 * It exists because a rate is only comparable within one unit *and* one
 * subject: *"you would be comparing MATH 1410 questions to CIS 1200
 * questions"*. Questions per minute across both is a number with no referent,
 * which is why the chart it feeds could not be read.
 *
 * **It is a lexical match, not an understanding.** It will not know that
 * `Bio` and `BIOL 1101` are the same course; that is the same boundary
 * `shared/projects.ts` draws, and for the same reason.
 *
 * ## What the pattern had to survive
 *
 * Measured against the real history: 2,353 quantified sessions, of which 114
 * carry something code-shaped. A first pass with the obvious
 * `[A-Za-z]{2,5} ?\d{3,4}` found 24 "courses", and **half of them were not
 * courses**:
 *
 * | Matched | From | Why |
 * | --- | --- | --- |
 * | `ALYZE 2022` | "Analyze 2022 Rapid Reacts" | tail of a word |
 * | `EVIEW 645` | "Princeton Review 645+ Questions" | tail of a word |
 * | `RNELL 100` | "Write Cornell 100 Word Supps" | tail of a word |
 * | `GRADE 2019` | "Grade 2019 E&M FRQ Set 2" | a year |
 * | `LANG 2018` | "AP Lang 2018 FRQ" | a year |
 * | `PRING 2027` | "Figure Out Spring 2027 Classes" | both |
 * | `ST 1600` | "Work on St1600 Video" | a video title |
 *
 * A picker listing those beside `MATH 1410` would be worse than no picker:
 * every one of them is a confident-looking option that selects nonsense. Two
 * rules remove all seven and cost nothing real:
 *
 * - **The letters must be capitals in the task as typed.** Every genuine code
 *   in the history is written that way - `CIS 1200`, `MATH 1410`, `WRIT
 *   0580`, `MEAM 1010`, `ESE 1110` - while every false positive above comes
 *   from an ordinary capitalised or lower-case word. This is the rule that
 *   does most of the work, and the one that would need revisiting if the user
 *   ever typed a code in lower case.
 * - **A number that is a year is not a course number.** 1900-2099 is excluded,
 *   which removes the FRQ-set tasks that make up most of the rest. A real
 *   course numbered in that span would be missed; against twelve invented
 *   courses that is the right way round, and the sessions are not lost - they
 *   appear under All courses like every other unlabelled one.
 *
 * A word boundary before the letters is required for the same reason as
 * `shared/projects.ts` uses `(^|[^a-z])` rather than an escape: an escape has
 * collapsed in transit in this repo more than once and silently matched
 * nothing.
 */

/**
 * Letters in capitals, an optional space, then three or four digits.
 *
 * Global, because the useful code is not always the first thing in the task -
 * `Grade CIS1299 Fall 2026 Midterm` has a year in it too, and the loop below
 * has to be able to skip one candidate and take another.
 */
const CODE = /(^|[^A-Za-z0-9])([A-Z]{2,5}) ?([0-9]{3,4})(?![0-9])/g

/** 1900-2099 is a date, not a course number. */
function isYear(digits: string): boolean {
  const n = Number(digits)
  return digits.length === 4 && n >= 1900 && n <= 2099
}

/**
 * The course code in a task, normalised to `MATH 1410`, or null.
 *
 * Normalised means a single space between letters and digits and the letters
 * upper-cased, so `CIS1299` and `CIS 1299` are one course rather than two -
 * the same collapsing `shared/projects.ts` does, and for the same reason:
 * free text typed over three and a half years drifts, and two spellings of
 * one course split its history in half.
 */
export function courseFrom(task: string | null | undefined): string | null {
  if (typeof task !== 'string' || task === '') return null
  CODE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CODE.exec(task)) !== null) {
    const [, , letters, digits] = match
    if (isYear(digits)) continue
    return `${letters.toUpperCase()} ${digits}`
  }
  return null
}

/** What the picker calls the option that does not filter. */
export const ALL_COURSES = ''

export interface CourseCount {
  course: string
  sessions: number
}

/**
 * The courses present in a set of tasks, most-used first.
 *
 * Only courses that actually occur, because a picker offering a course with
 * nothing behind it selects an empty chart - the same rule the Data tab's
 * project filter follows.
 */
export function coursesIn(tasks: readonly (string | null)[]): CourseCount[] {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    const course = courseFrom(task)
    if (course === null) continue
    counts.set(course, (counts.get(course) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([course, sessions]) => ({ course, sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.course.localeCompare(b.course))
}
