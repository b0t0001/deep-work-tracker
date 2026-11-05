/**
 * The Analytics tab's layout, as the user arranged it.
 *
 * Stored as one `app_settings` row rather than scattered keys: it is a single
 * preference that changes as a unit, and one key is one write. The resolving
 * below is the whole point of the file - a stored layout outlives the panel
 * list it was written against, so reading it is a merge rather than a load.
 */

/** Panel ids, named for what a panel is rather than where it sits. */
export const PANEL_IDS = [
  'calendar',
  'hoursPerWeek',
  'projects',
  'plannedRatio',
  'rateTrend',
  'timeOfDay',
  'pace'
] as const

export type PanelId = (typeof PANEL_IDS)[number]

export const LAYOUT_KEY = 'analytics.layout'
export const LAYOUT_VERSION = 1

/** Below 0.8 the captions stop being readable; above 1.6 two panels stop fitting side by side. */
export const MIN_FONT_SCALE = 0.8
export const MAX_FONT_SCALE = 1.6

export interface Layout {
  order: PanelId[]
  hidden: PanelId[]
  fontScale: number
}

/** What a user who has never touched anything sees. */
export function defaultLayout(): Layout {
  return { order: [...PANEL_IDS], hidden: [], fontScale: 1 }
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

  return { order, hidden, fontScale: clampScale(raw.fontScale) }
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
