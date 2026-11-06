/**
 * How wide a chart label will actually be, and the axis sizes that follow.
 *
 * Every `YAxis width` and chart `margin` in `AnalyticsCharts.tsx` used to be a
 * number somebody typed while looking at one chart with one set of data. That
 * works until the data changes shape or the type changes size, and both
 * happen here: a panel's range control can swap a two-digit axis for a
 * three-digit one, and the Modify panels A+ button scales every tick to 1.6x
 * while the typed width stays where it was. Measured across 216
 * panel/range/width/text-size states, the fixed guesses clipped 42 labels in
 * four places - "100%" cut off at the left edge, "Nov '26" and "Thu 5" cut off
 * at the right, the top y tick cut off against the top.
 *
 * So the sizes are computed from the widest label the chart is about to draw,
 * at the size it is about to draw it. The measurement is the browser's own,
 * through a canvas, rather than a characters-times-a-constant estimate: this
 * is a proportional face, and `11/05` and `Nov '26` are not the same width
 * for the same character count.
 */

/** The canvas is made once and reused; creating one per label is the slow way. */
let context: CanvasRenderingContext2D | null | undefined

function measuringContext(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    context = document.createElement('canvas').getContext('2d')
  }
  return context
}

/**
 * The tick font, as `main.css` sets it: `calc(11px * var(--an-fs))` in the
 * app's own family. Declared here as well because canvas needs a full font
 * shorthand and cannot read it off an element that has not been drawn yet.
 */
const FAMILY = "'Archivo', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"

/** Base sizes from `main.css`. The scale multiplies the first; the second is fixed. */
export const TICK_BASE_PX = 11
export const VALUE_PX = 10.5

/**
 * The width of a string at a size, in pixels.
 *
 * Falls back to a conservative estimate when there is no 2d context - a
 * headless or locked-down renderer should get an axis that is slightly too
 * wide, never one that is too narrow, because too wide costs a few pixels of
 * plot and too narrow costs the number.
 */
export function textWidth(text: string, px: number): number {
  const ctx = measuringContext()
  if (ctx === null) return text.length * px * 0.62
  ctx.font = `${px}px ${FAMILY}`
  return ctx.measureText(text).width
}

/** The widest of several strings, which is the one an axis has to fit. */
export function widest(labels: readonly string[], px: number): number {
  let most = 0
  for (const label of labels) most = Math.max(most, textWidth(label, px))
  return most
}

/**
 * The gap between the end of a y tick's text and the plot.
 *
 * Recharts right-aligns y tick text inside the axis width and leaves room for
 * the tick line and its margin. Calibrated against the harness rather than
 * read out of Recharts: 12 is the smallest value that takes every measured
 * clip to zero with a pixel to spare at 1.6x text.
 */
const Y_AXIS_GAP = 12

/**
 * How wide a vertical axis must be to show every one of its labels.
 *
 * `extra` carries a rotated axis title, which adds its line height rather
 * than its length because it is turned on its side.
 */
export function yAxisWidth(labels: readonly string[], px: number, extra = 0): number {
  return Math.ceil(widest(labels, px) + Y_AXIS_GAP + extra)
}

/**
 * Digits enough for any tick an auto-scaled axis might choose.
 *
 * Recharts picks its own round ceiling above the data's maximum, so the top
 * tick is not known before it is drawn. One digit more than the maximum is an
 * upper bound on it, and since the tick text is `tabular-nums` every digit is
 * the same width - so a string of eights measures exactly what the real
 * number will.
 */
export function digitsProbe(max: number, suffix = ''): string {
  const digits = Math.max(1, String(Math.max(1, Math.ceil(Math.abs(max)))).length)
  return '8'.repeat(digits + 1) + suffix
}

/**
 * The right margin a horizontal axis needs so its last label is not cut off.
 *
 * The final tick sits centred on the last data point, which is at the right
 * edge of the plot, so half of its text hangs past it. Half the widest label
 * is the general answer; `least` keeps whatever the chart already needed for
 * other reasons, such as value labels drawn outside a bar.
 */
export function rightMarginFor(labels: readonly string[], px: number, least = 0): number {
  return Math.max(least, Math.ceil(widest(labels, px) / 2) + 3)
}

/**
 * The top margin, so the highest y tick and any value label stay inside.
 *
 * The top tick is centred on the top gridline, so half its line box is above
 * the plot. A value label drawn above a point needs its whole height plus the
 * offset it is pushed up by.
 */
export function topMarginFor(px: number, valueLabelOffset: number | null = null): number {
  const halfTick = Math.ceil(px * 0.62)
  if (valueLabelOffset === null) return halfTick
  return Math.max(halfTick, Math.ceil(VALUE_PX * 1.25) + valueLabelOffset + 2)
}
