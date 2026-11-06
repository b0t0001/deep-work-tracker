/**
 * The Analytics tab's layout, as the user arranged it.
 *
 * Stored as one `app_settings` row rather than scattered keys: it is a single
 * preference that changes as a unit, and one key is one write. The resolving
 * below is the whole point of the file - a stored layout outlives the panel
 * list it was written against, so reading it is a merge rather than a load.
 */
import { WINDOWS, type WindowId } from './windows'

/** Panel ids, named for what a panel is rather than where it sits. */
export const PANEL_IDS = [
  'calendar',
  // Second, under the figure row whose window it shares. It is the thing the
  // user said they look at most, and it is the only panel that is read rather
  // than looked at, so it goes where the eye already is before the charts
  // start.
  'stats',
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
  'rateTrend'
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
    panels: ['calendar', 'stats', 'hoursPerWeek']
  },
  { id: 'habits', title: 'Habits', panels: ['timeOfDay', 'plannedRatio'] },
  { id: 'output', title: 'Projects and output', panels: ['projects', 'rateTrend', 'pace'] }
] as const satisfies readonly { id: string; title: string; panels: readonly PanelId[] }[]

export type SectionId = (typeof SECTIONS)[number]['id']

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
 * The two figures in the stat row that a range can move.
 *
 * They take range ids of their own rather than sharing a panel's, because they
 * are not panels: they cannot be hidden or dragged, and the stored layout has
 * to be able to tell "the average tile is set to 30 days" from "the stats
 * table is".
 *
 * The other two tiles deliberately have none. The baseline tile compares the
 * first year against the last and both ends have to be fixed for that to mean
 * anything - wired to a control it read +321% on one setting and +295% on
 * another, the same claim with two numbers. The fun fact is drawn from the
 * whole history by construction. A dropdown that cannot change the figure
 * beside it is worse than no dropdown.
 */
export const STAT_RANGE_IDS = ['averages', 'period'] as const
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
  averages: '1w',
  period: '1w',
  calendar: 'all',
  stats: '1w',
  hoursPerWeek: '8w',
  projects: 'all',
  plannedRatio: 'all',
  rateTrend: 'all',
  timeOfDay: 'all',
  pace: 'all'
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
}

/** What a user who has never touched anything sees. */
export function defaultLayout(): Layout {
  return { order: [...PANEL_IDS], hidden: [], fontScale: 1, ranges: {} }
}

/** The range a target is actually showing: what was stored, or its default. */
export function rangeFor(layout: Layout, target: RangeTargetId): WindowId {
  return layout.ranges[target] ?? DEFAULT_RANGES[target]
}

/** A layout with one target's range changed. */
export function withRange(layout: Layout, target: RangeTargetId, range: WindowId): Layout {
  return { ...layout, ranges: { ...layout.ranges, [target]: range } }
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

  return { order, hidden, fontScale: clampScale(raw.fontScale), ranges }
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
