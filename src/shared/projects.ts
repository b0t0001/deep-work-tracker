/**
 * Matching typed text against the projects that already exist.
 *
 * The whole point of projects being rows rather than strings is that drift
 * cannot recur - but an exact, case-sensitive lookup reintroduces it on the
 * first keystroke: `hw` becomes a second project beside `HW`, and three years
 * later there are 66 of them again. So the timer never compares raw strings.
 * It ranks candidates, offers the best, and only creates something new when
 * nothing plausible exists.
 *
 * This is lexical, not semantic. It catches case, spacing, punctuation,
 * trailing ordinals, prefixes, initials, dropped letters and typos. It will
 * not know that `essay` belongs with `Writing`; that needs the LLM work this
 * project defers, and calling edit distance semantic would be a lie.
 */

export interface ProjectMatch {
  name: string
  score: number
  /** Close enough that committing the typed text should snap to this name. */
  canonical: boolean
}

/**
 * Case, spacing, punctuation and the trailing ordinal all collapse.
 *
 * `HW 2`, `hw2` and `  H.W.  ` are the same category - the ordinal carried no
 * meaning in the spreadsheet either, which is why the importer strips it.
 * Ampersand survives because `R&D` would otherwise become `rd`.
 */
export function normalizeProjectName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9&\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\d+$/, '')
    .trim()
}

/**
 * The same name with every separator gone.
 *
 * Punctuation normalises to a space so `College-Apps` splits into words the way
 * `College Apps` does, which is right for word-prefix matching and wrong for
 * equality: it leaves `H.W.` as `h w` against `hw`. Comparing the squashed
 * forms too catches that, and `CollegeApps` typed without the space, without
 * loosening anything that matters - the words are still all there in order.
 */
function squash(value: string): string {
  return normalizeProjectName(value).replace(/\s+/g, '')
}

/** Levenshtein, capped: beyond `limit` the exact distance does not matter. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      if (current[j] < best) best = current[j]
    }
    if (best > limit) return limit + 1
    previous = current
  }
  return previous[b.length]
}

/** Every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (const char of haystack) {
    if (char === needle[i]) i += 1
    if (i === needle.length) return true
  }
  return needle.length === 0
}

/** `ca` matches `College Apps` through its word initials. */
function matchesInitials(query: string, candidate: string): boolean {
  const initials = candidate
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
  return query.length >= 2 && initials.startsWith(query)
}

function score(query: string, candidate: string): number {
  if (query === candidate) return 100
  if (squash(query) === squash(candidate)) return 98
  if (candidate.startsWith(query)) return 90 - Math.min(10, candidate.length - query.length)
  if (query.startsWith(candidate)) return 84
  if (candidate.split(' ').some((word) => word.startsWith(query))) return 78
  if (matchesInitials(query, candidate)) return 74
  if (candidate.includes(query)) return 70
  // A typo is worth catching only once there is enough word to be sure which
  // one was meant; two edits against three letters matches almost anything.
  const limit = query.length <= 4 ? 1 : 2
  const distance = editDistance(query, candidate, limit)
  if (distance <= limit) return 66 - distance * 8
  if (query.length >= 3 && isSubsequence(query, candidate)) return 50
  return 0
}

/**
 * Ranked candidates for what was typed, best first.
 *
 * An empty query returns everything, because an empty field wants the list -
 * that is the "dropdown" case, where you have not typed and just want to pick.
 */
export function rankProjects(query: string, names: string[], limit = 5): ProjectMatch[] {
  const q = normalizeProjectName(query)
  if (q === '') {
    return names.slice(0, limit).map((name) => ({ name, score: 0, canonical: false }))
  }

  const ranked: ProjectMatch[] = []
  for (const name of names) {
    const value = score(q, normalizeProjectName(name))
    if (value > 0) {
      // 84 is `query starts with candidate`, which means what was typed is a
      // longer, more specific thing - `HW reading` over `HW` - and must not
      // silently become the shorter one.
      ranked.push({ name, score: value, canonical: value >= 90 })
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return ranked.slice(0, limit)
}

/**
 * The existing name that typed text should resolve to, or null to create it.
 *
 * Deliberately stricter than the suggestion list: a suggestion you can ignore
 * costs nothing, while silently filing a session under the wrong project is
 * the failure that makes the data untrustworthy. Only a match that differs by
 * case, spacing, punctuation or an ordinal counts.
 */
export function canonicalProjectName(query: string, names: string[]): string | null {
  const q = normalizeProjectName(query)
  if (q === '') return null
  const squashed = squash(query)
  for (const name of names) {
    if (normalizeProjectName(name) === q || squash(name) === squashed) return name
  }
  return null
}
