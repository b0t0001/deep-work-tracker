/**
 * The Analytics tab's layout, as the user arranged it.
 *
 * Stored as one `app_settings` row rather than scattered keys: it is a single
 * preference that changes as a unit, and one key is one write. The resolving
 * below is the whole point of the file - a stored layout outlives the panel
 * list it was written against, so reading it is a merge rather than a load.
 */
import { GRAINS, STATISTICS, type Grain, type Statistic } from './compare'
import { WINDOWS, type WindowId } from './windows'

/** Panel ids, named for what a panel is rather than where it sits. */
export const PANEL_IDS = [
  'calendar',
  /*
   * `stats` used to sit here, second, as the thing the user said they looked
   * at most. It is gone, at their request: its first row repeated the figure
   * in the tile above it and its right-hand column repeated the one beside
   * that, which is what "look at how much redundant data there is" was
   * about. The comparison box in the figure row answers the same questions
   * with one number at a time. A stored layout naming `stats` resolves
   * cleanly - `resolveLayout` drops an id that no longer exists, which is
   * exactly this case.
   */
  'hoursPerWeek',
  'projects',
  'plannedRatio',
  'timeOfDay',
  'pace',
  // Last, and the move is a layout one rather than a judgement about the
  // chart. It is full width while `projects` and `pace` are half, and with it
  // between them each of those two sat alone on a row with its own width of
  // empty grid beside it. A full-width panel after the pair lets them share a
  // row. Ordering only: a stored layout keeps whatever order it already has.
  'rateTrend',
  // Every session as one star in a 3D cloud - see `shared/constellation.ts`.
  // Last, in a section of its own: it is the one panel that is explored
  // rather than read, and a stored layout from before it existed gets it
  // appended here by `resolveLayout` rather than needing a migration.
  'constellation'
] as const

export type PanelId = (typeof PANEL_IDS)[number]

/**
 * The headed groups the panels are shown in, in the order they appear.
 *
 * Sections are a property of a panel, like its width, rather than a second
 * arrangement the user maintains. The alternative - letting a panel be dragged
 * from one section to another - sounds more flexible and is worse: a heading
 * then describes whatever happens to be under it, so "Output and pace" can end
 * up over the calendar, and the headings stop being worth reading. What the
 * user arranges is the order within a section and what is hidden.
 *
 * `glance` holds no panels. The four figures at the top of the tab are not
 * panels - they are not draggable, hideable or in `PANEL_IDS` - but they are
 * the first section and the user named it, so it is declared here with the
 * rest rather than hard-coded into the markup beside them.
 */
export const SECTIONS = [
  { id: 'glance', title: 'At a glance', panels: [] },
  {
    id: 'hours',
    title: 'Hours and consistency',
    panels: ['calendar', 'hoursPerWeek']
  },
  { id: 'habits', title: 'Habits', panels: ['timeOfDay', 'plannedRatio'] },
  { id: 'output', title: 'Projects and output', panels: ['projects', 'rateTrend', 'pace'] },
  { id: 'explore', title: 'Explore', panels: ['constellation'] }
] as const satisfies readonly { id: string; title: string; panels: readonly PanelId[] }[]

export type SectionId = (typeof SECTIONS)[number]['id']

/** Section ids in their declared order, which is the default arrangement. */
export const SECTION_IDS = SECTIONS.map((section) => section.id) as SectionId[]

export function sectionTitle(id: SectionId): string {
  return SECTIONS.find((section) => section.id === id)?.title ?? id
}

/** The panels a section holds, in the order the layout puts them. */
export function panelsInSection(layout: Layout, id: SectionId): PanelId[] {
  return visiblePanels(layout).filter((panel) => sectionOf(panel) === id)
}

/** Which section a panel belongs to. Every panel is in exactly one. */
export function sectionOf(id: PanelId): SectionId {
  for (const section of SECTIONS) {
    if ((section.panels as readonly PanelId[]).includes(id)) return section.id
  }
  // Unreachable while the test below passes, and a sensible home if a panel is
  // ever added without being placed: the last section rather than a throw,
  // because an unplaced panel should appear somewhere, not take the tab down.
  return SECTIONS[SECTIONS.length - 1].id
}

/**
 * Things in the figure row that carry a range but are not panels.
 *
 * The baseline tile. The insights card is deliberately not here: it has no
 * range control at the user's request, because each insight reads its own
 * window. A `fact` range stored by an earlier build is not a target any more,
 * so `resolveLayout` drops it on read like any other unknown key - nothing
 * to migrate. The average and the period comparison
 * used to be here and are gone with the tiles that held them - the comparison
 * box replaced all three and keeps its own choices in `compare` below,
 * because a range is one of the three things it lets you set.
 *
 * **The baseline tile's range is the recent end only.** The first year stays
 * fixed, which is the whole point of a baseline: a comparison with both ends
 * moving is not a comparison. What the control chooses is which recent window
 * is held against it. That makes +321% and +295% two honestly different
 * claims rather than one claim with two numbers, which is what the earlier
 * version got wrong - and it is why the caption has to name the window it
 * used, not just say "now".
 */
export const STAT_RANGE_IDS = ['baseline'] as const
export type StatRangeId = (typeof STAT_RANGE_IDS)[number]

/** Anything that carries its own range control. */
export type RangeTargetId = PanelId | StatRangeId

/**
 * What each target starts on.
 *
 * Not one default for everything: a week of hours per week is one bar, and the
 * calendar's grid is a year wide whatever is asked of it. These are the
 * settings each panel was already showing before the control existed, so
 * nothing moves for a user opening the tab for the first time after the
 * change.
 */
export const DEFAULT_RANGES: Record<RangeTargetId, WindowId> = {
  baseline: '1y',
  calendar: 'all',
  hoursPerWeek: '8w',
  projects: 'all',
  plannedRatio: 'all',
  // A year rather than all time: at all time this draws a bar a month for
  // 42 months, which is honest and is a lot of panel to scroll past on the
  // way to the next one. Twelve bars is the shape the chart was rebuilt to
  // be readable at, and the control is right there for the rest.
  rateTrend: '1y',
  timeOfDay: 'all',
  pace: 'all',
  // The whole history is the picture worth looking at; a range is a zoom.
  constellation: 'all'
}

export const LAYOUT_KEY = 'analytics.layout'
export const LAYOUT_VERSION = 1

/** Below 0.8 the captions stop being readable; above 1.6 two panels stop fitting side by side. */
export const MIN_FONT_SCALE = 0.8
export const MAX_FONT_SCALE = 1.6

export interface Layout {
  order: PanelId[]
  hidden: PanelId[]
  fontScale: number
  /**
   * Each panel's own range, where it differs from the default.
   *
   * Sparse rather than complete, and that is deliberate: a target absent from
   * here has never been set, which is not the same as being set to its
   * default. If the sensible default for the hours chart ever changes, a
   * sparse record moves everyone who never touched it and leaves everyone who
   * did, while a complete one would have frozen every user at today's answer.
   * The same argument as `resolveLayout` appending an unknown panel.
   */
  ranges: Partial<Record<RangeTargetId, WindowId>>
  /**
   * What was typed into a target's Custom field, as typed.
   *
   * The text rather than the parsed day count, so the field shows back what
   * the user wrote - someone who typed "3 weeks" should not reopen the panel
   * to find "21 days". It is parsed on every read, which is cheap, and means
   * a stored value that stops parsing degrades to all time rather than to a
   * number nobody can account for.
   *
   * Kept even while the target is set to a preset, so switching to Custom
   * and back does not lose it.
   */
  customRanges: Partial<Record<RangeTargetId, string>>
  /**
   * The comparison box's three choices.
   *
   * Complete rather than sparse, unlike `ranges`. These are not preferences
   * about things that may come and go - there will always be exactly three,
   * and all three are always showing - so there is nothing for a missing
   * entry to mean.
   */
  compare: CompareChoice
  /**
   * The order of the sections themselves.
   *
   * Separate from `order`, which is the flat list of panels, because the two
   * are arranged independently: a panel moves within its section and a
   * section moves as a whole. Flattening them into one list would make
   * "which section is this panel in" a function of position, and the whole
   * argument for sections is that it is not - see `SECTIONS`.
   */
  sections: SectionId[]
}

/** What the comparison box is set to: statistic, grain, and over how long. */
export interface CompareChoice {
  statistic: Statistic
  grain: Grain
  range: WindowId
  /**
   * What its Custom field holds, as typed.
   *
   * Here rather than in `customRanges` because the box is not a range
   * target: its range lives in this object with the other two choices, and
   * splitting the typed span away from the id it belongs to would be two
   * places to keep in step for no gain.
   */
  custom: string
}

export const DEFAULT_COMPARE: CompareChoice = {
  statistic: 'mean',
  grain: 'day',
  range: '1w',
  custom: ''
}

/** What a user who has never touched anything sees. */
export function defaultLayout(): Layout {
  return {
    order: [...PANEL_IDS],
    hidden: [],
    fontScale: 1,
    ranges: {},
    customRanges: {},
    compare: { ...DEFAULT_COMPARE },
    sections: [...SECTION_IDS]
  }
}

/** A layout with the sections in a new order. */
export function withSections(layout: Layout, sections: SectionId[]): Layout {
  return { ...layout, sections: resolveSections(sections) }
}

/**
 * A stored section order reconciled against the sections that exist.
 *
 * The same three rules as `resolveLayout` applies to panels, and for the same
 * reasons: an unknown id is dropped, a section nobody has expressed an
 * opinion about is **appended in its declared position** rather than last,
 * and anything unparseable means the default. The second is what makes a
 * section added later appear for someone who has already dragged things -
 * invisible until the first section added after someone customises, which is
 * the worst possible time to find out.
 *
 * A layout stored before sections could be moved has no `sections` at all,
 * and lands here as an empty list: every section is then "never opined
 * about" and the result is the declared order, which is exactly what that
 * user was seeing. That is the migration, and it needs no version bump.
 */
export function resolveSections(stored: unknown): SectionId[] {
  const known = new Set<string>(SECTION_IDS)
  const seen = new Set<SectionId>()
  const out: SectionId[] = []
  if (Array.isArray(stored)) {
    for (const id of stored) {
      if (typeof id !== 'string' || !known.has(id) || seen.has(id as SectionId)) continue
      seen.add(id as SectionId)
      out.push(id as SectionId)
    }
  }
  for (const id of SECTION_IDS) {
    if (seen.has(id)) continue
    const at = SECTION_IDS.indexOf(id)
    const before = out.findIndex((other) => SECTION_IDS.indexOf(other) > at)
    if (before === -1) out.push(id)
    else out.splice(before, 0, id)
    seen.add(id)
  }
  return out
}

/** The range a target is actually showing: what was stored, or its default. */
export function rangeFor(layout: Layout, target: RangeTargetId): WindowId {
  return layout.ranges[target] ?? DEFAULT_RANGES[target]
}

/** A layout with one target's range changed. */
export function withRange(layout: Layout, target: RangeTargetId, range: WindowId): Layout {
  return { ...layout, ranges: { ...layout.ranges, [target]: range } }
}

/** What a target's Custom field holds, as typed. */
export function customTextFor(layout: Layout, target: RangeTargetId): string {
  return layout.customRanges[target] ?? ''
}

/** A layout with one target's typed span changed. */
export function withCustomRange(layout: Layout, target: RangeTargetId, text: string): Layout {
  return { ...layout, customRanges: { ...layout.customRanges, [target]: text } }
}

function isRangeTarget(value: unknown): value is RangeTargetId {
  return (
    typeof value === 'string' &&
    ((PANEL_IDS as readonly string[]).includes(value) ||
      (STAT_RANGE_IDS as readonly string[]).includes(value))
  )
}

function isWindowId(value: unknown): value is WindowId {
  return typeof value === 'string' && WINDOWS.some((option) => option.id === value)
}

function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && (PANEL_IDS as readonly string[]).includes(value)
}

function clampScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value))
}

/**
 * A stored layout, reconciled against the panels that exist now.
 *
 * Three rules, and the second is the one that matters most:
 *
 * - **An unknown id is dropped.** A panel removed in a later version must not
 *   strand the layout or throw on read.
 * - **A panel missing from `order` is appended and shown.** This is what makes
 *   a panel added six months from now appear for someone who has already
 *   dragged things. The instinct to resist is treating a stored layout as a
 *   complete list of what exists: it is a record of the preferences someone
 *   expressed, and anything they have never had an opinion about is new rather
 *   than hidden. Getting this wrong is invisible until the first panel added
 *   after someone customises, which is the worst possible time to find out.
 * - **Anything unparseable means defaults, silently.** A corrupt preference is
 *   not worth an error in front of a chart, and there is nothing here that
 *   cannot be recreated by dragging.
 *
 * Appending in `PANEL_IDS` order rather than at the end keeps a new panel near
 * its intended neighbours instead of always last.
 */
export function resolveLayout(stored: unknown): Layout {
  if (stored === null || typeof stored !== 'object') return defaultLayout()
  const raw = stored as Partial<Record<keyof Layout, unknown>>

  const orderIn = Array.isArray(raw.order) ? raw.order.filter(isPanelId) : []
  const seen = new Set<PanelId>()
  const order: PanelId[] = []
  for (const id of orderIn) {
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  // Anything the user has never expressed an opinion about, in its default
  // position relative to the panels around it.
  for (const id of PANEL_IDS) {
    if (seen.has(id)) continue
    const at = PANEL_IDS.indexOf(id)
    const before = order.findIndex((other) => PANEL_IDS.indexOf(other) > at)
    if (before === -1) order.push(id)
    else order.splice(before, 0, id)
    seen.add(id)
  }

  // Only ever ids that are in `order`, so hiding cannot outlive a panel.
  const hiddenIn = Array.isArray(raw.hidden) ? raw.hidden.filter(isPanelId) : []
  const hidden = [...new Set(hiddenIn)].filter((id) => order.includes(id))

  /*
   * A stored range survives only if both halves still mean something.
   *
   * Both are checked rather than trusted, because this crosses a process
   * boundary and a window id that no longer exists would resolve through
   * `windowDef`'s fallback to "all time" - a panel silently showing three and
   * a half years when the user had set it to a week. Dropping the entry
   * instead shows the panel's own default, which is at least a value somebody
   * chose.
   */
  const rangesIn =
    raw.ranges !== null && typeof raw.ranges === 'object'
      ? (raw.ranges as Record<string, unknown>)
      : {}
  const ranges: Partial<Record<RangeTargetId, WindowId>> = {}
  for (const [target, range] of Object.entries(rangesIn)) {
    if (isRangeTarget(target) && isWindowId(range)) ranges[target] = range
  }

  /*
   * Each of the three is checked on its own, so one bad value does not throw
   * away the other two - a stored grain that no longer exists should not
   * also reset the statistic the user chose.
   */
  const storedCompare =
    raw.compare !== null && typeof raw.compare === 'object'
      ? (raw.compare as Record<string, unknown>)
      : {}
  const compare: CompareChoice = {
    statistic: STATISTICS.some((option) => option.id === storedCompare.statistic)
      ? (storedCompare.statistic as Statistic)
      : DEFAULT_COMPARE.statistic,
    grain: GRAINS.some((option) => option.id === storedCompare.grain)
      ? (storedCompare.grain as Grain)
      : DEFAULT_COMPARE.grain,
    range: isWindowId(storedCompare.range) ? storedCompare.range : DEFAULT_COMPARE.range,
    custom: typeof storedCompare.custom === 'string' ? storedCompare.custom : ''
  }

  /*
   * The typed spans are kept as text and not validated here beyond being
   * text. Parsing belongs to `shared/span.ts` and happens at read time, so a
   * value that stops parsing - because the grammar changed, say - shows its
   * own error in the field rather than vanishing from storage, which would
   * leave the user retyping something they already entered.
   */
  const customIn =
    raw.customRanges !== null && typeof raw.customRanges === 'object'
      ? (raw.customRanges as Record<string, unknown>)
      : {}
  const customRanges: Partial<Record<RangeTargetId, string>> = {}
  for (const [target, text] of Object.entries(customIn)) {
    if (isRangeTarget(target) && typeof text === 'string') customRanges[target] = text
  }

  return {
    order,
    hidden,
    fontScale: clampScale(raw.fontScale),
    ranges,
    customRanges,
    compare,
    sections: resolveSections(raw.sections)
  }
}

/** The JSON that goes into `app_settings`. Resolved first, so what is stored is always valid. */
export function serialiseLayout(layout: Layout): string {
  const clean = resolveLayout(layout)
  return JSON.stringify({ v: LAYOUT_VERSION, ...clean })
}

/** Reads a stored row, including the case where it is absent or not JSON at all. */
export function parseLayout(text: string | null): Layout {
  if (text === null || text.trim() === '') return defaultLayout()
  try {
    return resolveLayout(JSON.parse(text))
  } catch {
    return defaultLayout()
  }
}

/** The panels to draw, in order, with the hidden ones removed. */
export function visiblePanels(layout: Layout): PanelId[] {
  const hidden = new Set(layout.hidden)
  return layout.order.filter((id) => !hidden.has(id))
}
