import { getSetting, setSetting } from './settings'
import { LAYOUT_KEY, parseLayout, serialiseLayout, type Layout } from '../../shared/layout'

/**
 * The Analytics tab's layout, read and written as one `app_settings` row.
 *
 * `setSetting` checkpoints through `checkpointSoon()`, so a layout change is
 * in `deepwork.db` itself within about a second rather than sitting in the
 * write-ahead log. That matters less here than for a session - a layout can be
 * recreated by dragging - but it costs nothing and the alternative is a second
 * durability rule to remember.
 */
export function readLayout(): Layout {
  return parseLayout(getSetting(LAYOUT_KEY))
}

export function writeLayout(layout: Layout): Layout {
  // Serialising resolves first, so an unknown id or an out-of-range scale
  // cannot be written even if the renderer sends one.
  setSetting(LAYOUT_KEY, serialiseLayout(layout))
  return readLayout()
}
