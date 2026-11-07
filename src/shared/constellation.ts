/**
 * The Constellation panel's geometry: where every session sits in the cloud.
 *
 * Pure, and kept apart from the WebGL code on purpose. The renderer only
 * uploads what this returns, so every rule about what a position *means* is
 * here, testable from Node (`scripts/constellation-check.ts`) without a GPU.
 *
 * The three axes, and why each is the one it is:
 *
 * - **Distance from the centre is hours worked up to that session.** The user's
 *   own words were "the distance from the origin can be the hours worked".
 *   Cumulative hours rather than the calendar date, which was the other
 *   candidate: both put the first session at the core and the latest at the
 *   rim, but only hours makes the rings behave like a tree's. A ring is drawn
 *   where each year (or month, or week) began, so the band between two rings
 *   is as thick as that period was productive - a heavy year is a wide band
 *   and a quiet one is a thin line. On a calendar radius every year would be
 *   the same width and the rings would say nothing.
 * - **The angle is the project.** Each project gets a wedge as wide as its
 *   share of the hours in range, largest first, so the cloud is a set of arms
 *   and the biggest arm is the biggest commitment. Projects too small to read
 *   as an arm are pooled into one "Other" arm - see `buildWedges`.
 * - **Height is session length**, on a log scale. A 5-minute check and a
 *   6-hour build are both normal here and a linear axis would flatten every
 *   short session into the floor.
 *
 * Two things are deliberately not axes. **Output** is star size, and only as a
 * percentile within its own unit: 120 words and 12 questions are not more and
 * less of anything, so a word-count session is compared only with other
 * word-count sessions. **Recency** is brightness, because it is already
 * carried by the radius and a second positional encoding would be redundant.
 */

import type { SessionRow } from './analytics'

/** One counted session, cut down to what the cloud needs. See `starRows`. */
export interface StarRow {
  id: number
  /** Local `YYYY-MM-DD`. */
  date: string
  project: string | null
  task: string | null
  runningS: number
  unit: string | null
  /** Null when absent or unquantifiable. */
  quantity: number | null
  source: string
  /**
   * Epoch milliseconds, **app-recorded rows only**. An imported row has no
   * clock time and a manual one has a remembered one, so neither may decide
   * whether two sessions were one sitting - see `buildLinks`.
   */
  startMs: number | null
  endMs: number | null
}

/**
 * The panel's rows, from what the payload already carries: `sessionRows` for
 * everything the tooltip shows, and the flat `sessionClock` numbers beside it
 * for the id and clock. A row without its clock entry - a payload from before
 * the field existed - gets a negative id and no clock, so it still draws and
 * simply never joins a sitting by time.
 */
export function starRows(rows: readonly SessionRow[], clock: readonly number[]): StarRow[] {
  return rows.map((row, i) => {
    const id = clock[i * 3]
    const start = clock[i * 3 + 1]
    const end = clock[i * 3 + 2]
    const timed = start !== undefined && end !== undefined && start >= 0 && end >= 0
    return {
      id: id ?? -(i + 1),
      date: row.date,
      project: row.project,
      task: row.task,
      runningS: row.runningS,
      unit: row.unit,
      quantity: row.quantity,
      source: row.source,
      startMs: timed ? start * 1000 : null,
      endMs: timed ? end * 1000 : null
    }
  })
}

/** A group of projects drawn as one arm. Most hold exactly one. */
export interface Wedge {
  key: string
  label: string
  projects: string[]
  hours: number
  sessions: number
  /** Radians, measured from +x towards +z. */
  start: number
  width: number
  /** True for the pooled arm of small projects. */
  other: boolean
}

export interface Star {
  row: StarRow
  wedge: number
  x: number
  y: number
  z: number
  /** 0 at the core, 1 at the rim. */
  radial: number
  /** 0 on the floor, 1 at the top of the height scale. */
  height: number
  /** Within-unit percentile of output, 0-1; null when the session recorded none. */
  output: number | null
  /** 0 for the oldest day in range, 1 for the newest. */
  recency: number
}

/** A faint line between two stars that were one sitting. Indices into `stars`. */
export interface Link {
  a: number
  b: number
}

export interface Ring {
  /** In world units, the same scale as a star's x and z. */
  radius: number
  label: string
  /** The date the ring marks the start of. */
  date: string
}

export interface HeightTick {
  y: number
  label: string
}

export interface Constellation {
  stars: Star[]
  links: Link[]
  wedges: Wedge[]
  rings: Ring[]
  heightTicks: HeightTick[]
  totalHours: number
  /** The grain the rings were drawn at, for the caption. */
  ringGrain: RingGrain
  projection: Projection
  /** The height the camera should orbit around. */
  centreY: number
}

/**
 * The coordinate system, as one swappable mapping.
 *
 * Every rule about *what* a position means - hours out from the core, the
 * project's wedge, the session's length - produces three normalised numbers,
 * and only `place` turns them into x, y and z. So trying another shape is a
 * change to one function, not to the layout.
 *
 * - `cylinder` (the default): radius is time, the angle is the project, and
 *   height is session length. A disc of arms with a skyline above it.
 * - `sphere`: radius is still time, the project is longitude, and session
 *   length is latitude - short sessions in the south, long ones in the north.
 *   Shells instead of rings; the same data as a globe.
 *
 * The user's call, 11/06/2026: build the cylinder, "we can change the
 * coordinate system if it doesn't look cool."
 */
export type Projection = 'cylinder' | 'sphere'

export const PROJECTIONS: ReadonlyArray<{ id: Projection; label: string }> = [
  { id: 'cylinder', label: 'Disc' },
  { id: 'sphere', label: 'Sphere' }
]

/** How far from the equator the sphere's poles are kept, so nothing sits on a pole. */
export const SPHERE_LATITUDE = (Math.PI / 2) * 0.82

/**
 * Normalised inputs to world coordinates. `radial` is 0-1 out from the core,
 * `angle` in radians, `height` 0-1 up the length scale.
 */
export function place(
  projection: Projection,
  radial: number,
  angle: number,
  height: number
): { x: number; y: number; z: number } {
  const r = radial * RADIUS
  if (projection === 'sphere') {
    const lat = (height * 2 - 1) * SPHERE_LATITUDE
    return {
      x: Math.cos(angle) * Math.cos(lat) * r,
      y: Math.sin(lat) * r,
      z: Math.sin(angle) * Math.cos(lat) * r
    }
  }
  return { x: Math.cos(angle) * r, y: height * HEIGHT, z: Math.sin(angle) * r }
}

/** World size of the cloud. Arbitrary units; the camera is fitted to them. */
export const RADIUS = 10
export const HEIGHT = 4.2
/**
 * The first session sits this far out rather than on the axis itself, so the
 * oldest work is a small knot instead of a single point every arm converges
 * on - which read as a rendering artefact rather than as the start.
 */
export const CORE = 0.07
/**
 * How far the arms wind, in radians from core to rim. A gentle spiral is what
 * makes the cloud read as one turning thing rather than a pie chart, and it
 * is applied to every arm equally, so at any one radius the order and the
 * widths of the wedges are exactly as `buildWedges` set them.
 */
export const TWIST = 0.55
/** Clear space between neighbouring arms, as a fraction of each wedge. */
export const WEDGE_GAP = 0.14

/** The height scale's ends, in minutes. Shorter or longer sessions sit on the bound. */
export const MIN_MINUTES = 2
export const MAX_MINUTES = 8 * 60

/**
 * Pooling rules for small projects.
 *
 * At most `MAX_ARMS` arms, and a project must hold `MIN_SHARE` of the hours to
 * get its own. The real history has 36 projects of which nine carry most of
 * 2026, and 36 arms would be 36 slivers too thin to see, each needing a colour
 * nobody could tell from its neighbour. Every pooled project is still listed
 * under Other in the legend, so nothing disappears.
 *
 * `MIN_WIDTH` is the other half of "stay visible": a project just over the
 * share threshold would otherwise be an arm a few pixels wide.
 */
export const MAX_ARMS = 9
export const MIN_SHARE = 0.025
export const MIN_WIDTH = (Math.PI * 2) / 40

/** What joins two sessions into one sitting, for rows that have clock times. */
export const SITTING_GAP_MINUTES = 30

const UNLABELLED = 'Unlabelled'

/**
 * A unit as a comparison key: case, spacing and a plural `s` collapsed.
 *
 * The import stores units singular where it could, while the stop prompt
 * stores whatever was typed, so `question` and `Questions` are the same unit
 * and must be ranked together. A phrase (`seconds edited`) is left whole -
 * the same rule as `pluralUnit`, so the two cannot disagree about which units
 * have a plural.
 */
export function unitKey(unit: string): string {
  const u = unit.trim().toLowerCase().replace(/\s+/g, ' ')
  if (u === '' || u.includes(' ')) return u
  if (u.endsWith('ies') && u.length > 4) return u.slice(0, -3) + 'y'
  if (/(ss|us|is)$/.test(u)) return u
  if (/(ches|shes|xes|zes|sses)$/.test(u)) return u.slice(0, -2)
  if (u.endsWith('s') && u.length > 2) return u.slice(0, -1)
  return u
}

/**
 * Each session's output as a percentile among sessions **of the same unit**.
 *
 * Ranks are averaged over ties, so ten sessions that all did 20 questions are
 * all the same size, and a unit seen once is placed in the middle rather than
 * at either extreme - one session is not the most or the least of anything.
 * Computed over every row given, not just the range, so a star keeps its size
 * when the range control moves: a session does not get bigger because the
 * sessions around it were cut away.
 */
export function outputPercentiles(rows: readonly StarRow[]): Map<number, number> {
  const byUnit = new Map<string, Array<{ id: number; q: number }>>()
  for (const row of rows) {
    if (row.unit === null || row.quantity === null || !(row.quantity > 0)) continue
    const key = unitKey(row.unit)
    if (key === '') continue
    let list = byUnit.get(key)
    if (list === undefined) byUnit.set(key, (list = []))
    list.push({ id: row.id, q: row.quantity })
  }
  const out = new Map<number, number>()
  for (const list of byUnit.values()) {
    if (list.length === 1) {
      out.set(list[0].id, 0.5)
      continue
    }
    list.sort((a, b) => a.q - b.q)
    let i = 0
    while (i < list.length) {
      let j = i
      while (j + 1 < list.length && list[j + 1].q === list[i].q) j += 1
      const rank = (i + j) / 2 / (list.length - 1)
      for (let k = i; k <= j; k += 1) out.set(list[k].id, rank)
      i = j + 1
    }
  }
  return out
}

/** The project a row is drawn under. */
export function projectOf(row: StarRow): string {
  const name = row.project?.trim() ?? ''
  return name === '' ? UNLABELLED : name
}

/**
 * The arms: one per large project, one for the rest, sized by hours.
 *
 * Largest first, starting at angle zero and running round. A project gets its
 * own arm if it is among the `MAX_ARMS - 1` largest **and** holds `MIN_SHARE`
 * of the hours; everything else is pooled. One arm is held back for Other
 * only when something is actually pooled, so a range with five projects shows
 * five arms rather than five and an empty one. A pool of exactly one project
 * is not a pool, so that project keeps its own name.
 *
 * Widths are proportional to hours with a floor of `MIN_WIDTH`, then rescaled
 * so the circle is exactly filled - the floor is taken from the large arms,
 * which can afford it, rather than overflowing.
 */
export function buildWedges(rows: readonly StarRow[], options: { pool?: boolean } = {}): Wedge[] {
  const pool = options.pool ?? true
  const totals = new Map<string, { hours: number; sessions: number }>()
  for (const row of rows) {
    const name = projectOf(row)
    const t = totals.get(name) ?? { hours: 0, sessions: 0 }
    t.hours += Math.max(0, row.runningS) / 3600
    t.sessions += 1
    totals.set(name, t)
  }
  const all = [...totals.entries()]
    .map(([name, t]) => ({ name, ...t }))
    // Ties by name, so the layout cannot depend on Map insertion order.
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name))
  const total = all.reduce((sum, p) => sum + p.hours, 0)
  if (all.length === 0) return []

  // With few enough projects every one is an arm, however small: the floor
  // width keeps it visible and there is nothing to gain by pooling. Otherwise
  // one arm is kept back for Other.
  // Not pooling - the user has chosen exactly what to see - fits by definition.
  const fits = !pool || all.length <= MAX_ARMS
  const capacity = fits ? Number.POSITIVE_INFINITY : MAX_ARMS - 1
  const own: typeof all = []
  const pooled: typeof all = []
  for (const p of all) {
    const share = total > 0 ? p.hours / total : 0
    // Unlabelled is never an arm of its own while there is a pool to put it
    // in: it is the absence of a project, and an arm says "this is a thing".
    if (own.length < capacity && (fits || share >= MIN_SHARE) && (!pool || p.name !== UNLABELLED)) {
      own.push(p)
    } else {
      pooled.push(p)
    }
  }
  if (pooled.length === 1) {
    own.push(pooled[0])
    pooled.length = 0
    own.sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name))
  }

  const wedges: Wedge[] = own.map((p) => ({
    key: p.name,
    label: p.name,
    projects: [p.name],
    hours: p.hours,
    sessions: p.sessions,
    start: 0,
    width: 0,
    other: false
  }))
  if (pooled.length > 0) {
    wedges.push({
      key: '\u0000other',
      label: 'Other',
      projects: pooled.map((p) => p.name),
      hours: pooled.reduce((sum, p) => sum + p.hours, 0),
      sessions: pooled.reduce((sum, p) => sum + p.sessions, 0),
      start: 0,
      width: 0,
      other: true
    })
  }

  const full = Math.PI * 2
  const floor = Math.min(MIN_WIDTH, full / wedges.length)
  const raw = wedges.map((w) => (total > 0 ? (w.hours / total) * full : full / wedges.length))
  // Arms below the floor are raised to it; the rest share what is left in
  // proportion to their hours.
  const small = raw.map((r) => r < floor)
  const fixed = small.reduce((sum, s) => sum + (s ? floor : 0), 0)
  const freeRaw = raw.reduce((sum, r, i) => sum + (small[i] ? 0 : r), 0)
  let at = 0
  wedges.forEach((w, i) => {
    w.width = small[i] ? floor : freeRaw > 0 ? (raw[i] / freeRaw) * (full - fixed) : floor
    w.start = at
    at += w.width
  })
  return wedges
}

/** Height on the log scale, 0-1. */
export function heightOf(runningS: number): number {
  const minutes = Math.max(runningS / 60, MIN_MINUTES)
  const t = Math.log(minutes / MIN_MINUTES) / Math.log(MAX_MINUTES / MIN_MINUTES)
  return Math.min(1, Math.max(0, t))
}

/** Where the height scale is labelled. */
export const HEIGHT_TICKS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 5, label: '5 min' },
  { minutes: 20, label: '20 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 180, label: '3 h' },
  { minutes: 480, label: '8 h' }
]

/**
 * A stable number in [0, 1) from a session id and a salt.
 *
 * Deterministic so that the cloud is the same shape every time it is opened -
 * a star that moved on every visit would make "that one, there" impossible to
 * point at, and screenshots impossible to compare.
 */
export function hash01(id: number, salt: number): number {
  let h = (Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Chronological order: date, then clock time where known, then id (import order). */
export function chronological(rows: readonly StarRow[]): StarRow[] {
  return [...rows].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.startMs ?? Number.NEGATIVE_INFINITY) - (b.startMs ?? Number.NEGATIVE_INFINITY) ||
      a.id - b.id
  )
}

/**
 * Which consecutive sessions were one sitting, as pairs of indices into
 * `ordered`.
 *
 * Two rules, because the history has two kinds of row:
 *
 * - **With clock times** (app-recorded): consecutive by start time, the same
 *   date, and the next one starting less than `SITTING_GAP_MINUTES` after the
 *   one before ended - the same gap `sittings()` in `analytics.ts` uses. Any
 *   project: switching from HW to the essay without leaving the desk is still
 *   one sitting, and the line crossing between arms is the point of drawing
 *   it.
 * - **Without** (imported, manual): consecutive rows of the same date **and**
 *   the same project. Without a clock there is no gap to measure, so the only
 *   honest join is the one the spreadsheet itself shows: one project's runs on
 *   one day, in the order they were logged. Across projects that would be a
 *   guess.
 */
export function buildLinks(ordered: readonly StarRow[]): Link[] {
  const links: Link[] = []
  const timed: number[] = []
  const untimed: number[] = []
  ordered.forEach((row, i) => {
    if (row.source === 'app' && row.startMs !== null && row.endMs !== null) timed.push(i)
    else untimed.push(i)
  })

  timed.sort((a, b) => (ordered[a].startMs as number) - (ordered[b].startMs as number))
  // The end of the sitting so far, not just the previous row: two timers run
  // side by side by design, and a short one nested inside a long one must not
  // pull the boundary backwards.
  let reach = Number.NEGATIVE_INFINITY
  for (let k = 0; k < timed.length; k += 1) {
    const row = ordered[timed[k]]
    if (k > 0) {
      const prev = ordered[timed[k - 1]]
      const gap = ((row.startMs as number) - reach) / 60_000
      if (prev.date === row.date && gap < SITTING_GAP_MINUTES) {
        links.push({ a: timed[k - 1], b: timed[k] })
      } else {
        reach = Number.NEGATIVE_INFINITY
      }
    }
    reach = Math.max(reach, row.endMs as number)
  }

  untimed.sort(
    (a, b) => ordered[a].date.localeCompare(ordered[b].date) || ordered[a].id - ordered[b].id
  )
  for (let k = 1; k < untimed.length; k += 1) {
    const prev = ordered[untimed[k - 1]]
    const row = ordered[untimed[k]]
    if (prev.date === row.date && projectOf(prev) === projectOf(row)) {
      links.push({ a: untimed[k - 1], b: untimed[k] })
    }
  }
  return links
}

export type RingGrain = 'year' | 'quarter' | 'month' | 'week' | 'day'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayNumber(date: string): number {
  return Math.round(Date.parse(date + 'T00:00:00Z') / 86_400_000)
}

function fromDayNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10)
}

/**
 * The grain the rings are drawn at: the coarsest that still gives at least
 * three of them. Fewer than three rings cannot show that bands differ in
 * width, which is the only thing the rings are for.
 */
export function ringGrain(firstDate: string, lastDate: string): RingGrain {
  const span = dayNumber(lastDate) - dayNumber(firstDate) + 1
  if (span > 3 * 365) return 'year'
  if (span > 270) return 'quarter'
  if (span > 75) return 'month'
  if (span > 15) return 'week'
  return 'day'
}

/** The dates at which a ring starts, strictly after the first date and not after the last. */
export function ringDates(firstDate: string, lastDate: string, grain: RingGrain): string[] {
  const out: string[] = []
  const last = dayNumber(lastDate)
  const [fy, fm] = firstDate.split('-').map(Number)
  if (grain === 'year' || grain === 'quarter' || grain === 'month') {
    const step = grain === 'year' ? 12 : grain === 'quarter' ? 3 : 1
    // The first boundary after the start, aligned to the grain's own calendar
    // (January for years, Jan/Apr/Jul/Oct for quarters).
    let y = fy
    let m = fm - 1
    m = Math.floor(m / step) * step + step
    for (;;) {
      y += Math.floor(m / 12)
      m %= 12
      const date = `${y}-${String(m + 1).padStart(2, '0')}-01`
      if (dayNumber(date) > last) break
      out.push(date)
      m += step
    }
    return out
  }
  const first = dayNumber(firstDate)
  if (grain === 'week') {
    // Mondays. 1970-01-01 was a Thursday, so day 4 is the first Monday.
    let d = first + 1
    while ((((d - 4) % 7) + 7) % 7 !== 0) d += 1
    for (; d <= last; d += 7) out.push(fromDayNumber(d))
    return out
  }
  for (let d = first + 1; d <= last; d += 1) out.push(fromDayNumber(d))
  return out
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function ringLabel(date: string, grain: RingGrain): string {
  const [y, m, d] = date.split('-').map(Number)
  if (grain === 'year') return String(y)
  if (grain === 'quarter' || grain === 'month') {
    return m === 1 ? String(y) : `${MONTHS[m - 1]} ’${String(y).slice(2)}`
  }
  const md = `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`
  if (grain === 'week') return md
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${md}`
}

/**
 * Everything the panel draws, for the rows in range.
 *
 * `all` is every counted session, used only to rank output within a unit -
 * see `outputPercentiles`. `rows` is what the range control kept.
 */
export function buildConstellation(
  rows: readonly StarRow[],
  all: readonly StarRow[] = rows,
  projection: Projection = 'cylinder',
  hidden: readonly string[] | null = null
): Constellation {
  const gone = new Set(hidden ?? [])
  const ordered = chronological(rows.filter((row) => row.runningS > 0 && !gone.has(projectOf(row))))
  // Chosen by the user: every shown project is its own arm, no Other.
  const wedges = buildWedges(ordered, { pool: hidden === null })
  const wedgeOf = new Map<string, number>()
  wedges.forEach((w, i) => w.projects.forEach((p) => wedgeOf.set(p, i)))
  const percentiles = outputPercentiles(all)

  const totalHours = ordered.reduce((sum, row) => sum + row.runningS / 3600, 0)
  const firstDate = ordered[0]?.date ?? null
  const lastDate = ordered[ordered.length - 1]?.date ?? null
  const firstDay = firstDate === null ? 0 : dayNumber(firstDate)
  const daySpan = lastDate === null ? 0 : dayNumber(lastDate) - firstDay

  const radialOf = (hoursBefore: number): number =>
    CORE + (1 - CORE) * (totalHours > 0 ? hoursBefore / totalHours : 0)

  let before = 0
  const stars: Star[] = ordered.map((row) => {
    const hours = row.runningS / 3600
    // The session's own midpoint, so a six-hour session sits in the middle of
    // the band it occupies rather than at its inner edge.
    const radial = Math.min(1, radialOf(before + hours / 2))
    before += hours
    const wedgeIndex = wedgeOf.get(projectOf(row)) ?? 0
    const wedge = wedges[wedgeIndex]
    // Triangular jitter (the sum of two uniforms), so an arm is densest along
    // its centre line and feathers out to its edges - an arm, not a slice.
    const spread = (hash01(row.id, 1) + hash01(row.id, 2)) / 2 - 0.5
    const usable = wedge.width * (1 - WEDGE_GAP)
    const angle = wedge.start + wedge.width / 2 + spread * usable + TWIST * radial
    // A whisker of radial jitter as well: sessions on one day otherwise share a
    // radius to within a pixel and read as a dashed line.
    const jittered = radial + (hash01(row.id, 3) - 0.5) * 0.012
    const height = heightOf(row.runningS)
    const output = percentiles.get(row.id) ?? null
    return {
      row,
      wedge: wedgeIndex,
      ...place(projection, jittered, angle, height),
      radial,
      height,
      output,
      recency: daySpan > 0 ? (dayNumber(row.date) - firstDay) / daySpan : 1
    }
  })

  const grain: RingGrain =
    firstDate === null || lastDate === null ? 'year' : ringGrain(firstDate, lastDate)
  const rings: Ring[] = []
  if (firstDate !== null && lastDate !== null) {
    let k = 0
    let hoursBefore = 0
    for (const date of ringDates(firstDate, lastDate, grain)) {
      while (k < ordered.length && ordered[k].date < date) {
        hoursBefore += ordered[k].runningS / 3600
        k += 1
      }
      rings.push({ radius: radialOf(hoursBefore) * RADIUS, label: ringLabel(date, grain), date })
    }
  }

  return {
    stars,
    links: buildLinks(ordered),
    wedges,
    rings,
    heightTicks: HEIGHT_TICKS.map((t) => ({
      y: heightOf(t.minutes * 60) * HEIGHT,
      label: t.label
    })),
    totalHours,
    ringGrain: grain,
    projection,
    centreY: projection === 'sphere' ? 0 : HEIGHT * 0.32
  }
}

/**
 * Which projects the cloud shows. *"there should be a way for me to hide
 * something like College Apps or Sprocket or Scioly or JPL or SAT, because
 * those aren't things I'm doing anymore now that I'm in college. Instead,
 * let's put something like PER on there."*
 *
 * Stored as the list of **hidden** projects, and `null` until the user first
 * changes anything:
 *
 * - `null` is the automatic view - the largest projects as arms and the long
 *   tail pooled into Other - which is what every layout written before this
 *   existed resolves to.
 * - A list means the user has chosen: every project not in it is its own arm,
 *   and there is no Other at all, so nothing they asked to see can be
 *   swallowed by it. Hidden projects are removed entirely - not dimmed - and
 *   the wedges re-divide among what is left, so the arms fill the circle.
 *
 * Hidden rather than shown, so a project created next month appears on its
 * own instead of being invisible until someone thinks to tick it - the same
 * argument as `resolveLayout` appending an unknown panel.
 */
export interface ProjectChoice {
  name: string
  hours: number
  sessions: number
  /** Drawn as its own arm. */
  shown: boolean
}

/** Every project with sessions in `rows`, most hours first, and whether it is its own arm. */
export function projectChoices(
  rows: readonly StarRow[],
  hidden: readonly string[] | null
): ProjectChoice[] {
  const totals = new Map<string, { hours: number; sessions: number }>()
  for (const row of rows) {
    if (!(row.runningS > 0)) continue
    const name = projectOf(row)
    const t = totals.get(name) ?? { hours: 0, sessions: 0 }
    t.hours += row.runningS / 3600
    t.sessions += 1
    totals.set(name, t)
  }
  const own =
    hidden === null
      ? new Set(
          buildWedges(rows.filter((row) => row.runningS > 0))
            .filter((w) => !w.other)
            .flatMap((w) => w.projects)
        )
      : null
  const gone = new Set(hidden ?? [])
  return [...totals.entries()]
    .map(([name, t]) => ({
      name,
      hours: t.hours,
      sessions: t.sessions,
      shown: own === null ? !gone.has(name) : own.has(name)
    }))
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name))
}

/**
 * The hidden list after showing or hiding one project.
 *
 * The first change leaves the automatic view, and must not jump: everything
 * that was not an arm of its own a moment ago - the projects pooled into
 * Other, and every project outside the range - starts out hidden, so the
 * only thing that changes on screen is the project just clicked. Without
 * that, unticking one project would have turned thirty pooled ones into
 * thirty new arms.
 */
export function withProjectShown(
  hidden: readonly string[] | null,
  inRange: readonly StarRow[],
  all: readonly StarRow[],
  name: string,
  shown: boolean
): string[] {
  const base =
    hidden === null
      ? (() => {
          const visible = new Set(
            projectChoices(inRange, null)
              .filter((c) => c.shown)
              .map((c) => c.name)
          )
          return [...new Set(all.map(projectOf))].filter((p) => !visible.has(p))
        })()
      : [...hidden]
  const next = new Set(base)
  if (shown) next.delete(name)
  else next.add(name)
  return [...next].sort((a, b) => a.localeCompare(b))
}

/** Every project shown. */
export function showAllProjects(): string[] {
  return []
}

/** Every project hidden, including any outside the range. */
export function hideAllProjects(all: readonly StarRow[]): string[] {
  return [...new Set(all.map(projectOf))].sort((a, b) => a.localeCompare(b))
}

/**
 * Each project's colour rank: its position by hours over the whole history.
 *
 * Colour belongs to the project, not to the range. Ranked within the range,
 * College Apps was pink at all time and green at 90 days, because something
 * else had overtaken it - the same project in two colours depending on a
 * dropdown, which is the confusion a colour key exists to prevent.
 */
export function colourRanks(all: readonly StarRow[]): Map<string, number> {
  const hours = new Map<string, number>()
  for (const row of all) {
    const name = projectOf(row)
    hours.set(name, (hours.get(name) ?? 0) + Math.max(0, row.runningS))
  }
  const ranked = [...hours.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return new Map(ranked.map(([name], i) => [name, i]))
}

/**
 * One colour per arm, anchored on the app's accent.
 *
 * The project with the most hours ever takes the accent's hue, so the panel
 * belongs to the same app as every other chart, and the rest step round the
 * hue circle by the golden angle from there - the spacing that keeps neighbours
 * furthest apart however many there are. The step is by all-time rank (see
 * `colourRanks`), so a project keeps its colour whatever the range.
 * Lightness and saturation are fixed at values that glow on the near-black
 * stage without any arm being louder than the others. Other is a cool grey:
 * it is a pool, not a project, and should not compete.
 */
/**
 * The first look's saturation and lightness, which the user settled on:
 * *"I actually think the current brightness is alright."* A muted 0.42 and a
 * 0.74 were both tried and both read as too dim.
 */
export const MUTED_SATURATION = 0.78
export const MUTED_LIGHTNESS = 0.66

export function armColours(
  wedges: readonly Wedge[],
  accentHex: string,
  ranks: ReadonlyMap<string, number> = new Map()
): string[] {
  const base = hexToHsl(accentHex).h
  const out: string[] = wedges.map(() => OTHER_COLOUR)
  const arms = wedges
    .map((w, i) => ({ i, hue: (base + (ranks.get(w.projects[0]) ?? i) * 137.508) % 360 }))
    .filter((x) => !wedges[x.i].other)
  /*
   * Each project's natural hue is the golden-angle step for its all-time
   * rank, which keeps a project's colour the same across ranges. But
   * thirty-seven projects on a golden angle are bound to land some on top of
   * each other, and with the user's own choice of arms two did - PER and
   * Entrepreneurship in one green, side by side.
   *
   * So when the arms on screen are cramped, they are spread evenly round the
   * wheel instead, **in the same order** their natural hues had, turned by
   * whatever angle moves them least. Every colour stays near its usual
   * neighbourhood - pink stays pinkish - and no two arms on screen can be
   * closer than the wheel allows.
   */
  const sorted = [...arms].sort((x, y) => x.hue - y.hue)
  let cramped = false
  for (let k = 0; k < sorted.length && sorted.length > 1; k += 1) {
    const next = sorted[(k + 1) % sorted.length]
    if (hueGap(sorted[k].hue, next.hue) < Math.min(MIN_HUE_GAP, 360 / sorted.length)) cramped = true
  }
  if (cramped) {
    const step = 360 / sorted.length
    // The turn that moves them least: the circular mean of how far each
    // natural hue sits from its evenly spaced slot.
    let sx = 0
    let sy = 0
    sorted.forEach((x, k) => {
      const d = ((x.hue - k * step) * Math.PI) / 180
      sx += Math.cos(d)
      sy += Math.sin(d)
    })
    const turn = (Math.atan2(sy, sx) * 180) / Math.PI
    sorted.forEach((x, k) => {
      x.hue = (((turn + k * step) % 360) + 360) % 360
    })
  }
  for (const arm of arms) out[arm.i] = hslToHex(arm.hue, MUTED_SATURATION, MUTED_LIGHTNESS)
  // Unspread, the largest project ever is the accent itself, exactly, so the
  // panel belongs to the same app as every other chart.
  if (!cramped) {
    for (const arm of arms) {
      if ((ranks.get(wedges[arm.i].projects[0]) ?? arm.i) === 0) out[arm.i] = accentHex
    }
  }
  return out
}

/** Degrees apart on the colour wheel. */
export function hueGap(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return Math.min(d, 360 - d)
}

/** Arms on screen at least this far apart in hue, while the wheel has room. */
export const MIN_HUE_GAP = 28

export const OTHER_COLOUR = '#737b88'

/** One project's colour from its all-time rank: the same in the legend, the list and the cloud. */
export function projectColour(rank: number, accentHex: string): string {
  const hue = (hexToHsl(accentHex).h + rank * 137.508) % 360
  return hslToHex(hue, MUTED_SATURATION, MUTED_LIGHTNESS)
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0x5eead4
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return { h: h * 60, s, l }
}

export function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const hex = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`
}
