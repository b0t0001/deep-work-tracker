/**
 * Shared so the timer and the settings panel offer the same set.
 *
 * Named after stones rather than colours. The hex values are unchanged, and
 * they are what is stored - renaming one cannot orphan a saved choice.
 */
export const ACCENTS = [
  { name: 'Diamond', value: '#0a84ff' },
  { name: 'Ruby', value: '#d92b4b' },
  { name: 'Sapphire', value: '#7c4dff' },
  { name: 'Turquoise', value: '#14b8a6' },
  { name: 'Jade', value: '#2eb85c' },
  { name: 'Amber', value: '#f28c28' },
  { name: 'Moonstone', value: '#9aa0a6' }
] as const

export const ACCENT_KEY = 'dwt.accent'
export const DEFAULT_ACCENT = ACCENTS[0].value

export function isKnownAccent(value: string | null): value is string {
  return ACCENTS.some((option) => option.value === value)
}

/* ------------------------------------------------------------------------ *
 * The opposite of the accent.
 *
 * "in the data tab, I want the color of the text that says manual to be
 * whatever the opposite of the current accent color is. So if it's red, then
 * it should be blue. And if it's like green, it should be whatever the
 * opposite, like the opposite color from the color wheel is."
 *
 * Opposite on the wheel is the hue turned 180 degrees with the saturation
 * kept, which is what makes Ruby read as a cyan and Jade as a magenta rather
 * than as some other red. It is computed rather than listed per accent so a
 * colour added to ACCENTS later cannot arrive without one.
 * ------------------------------------------------------------------------ */

/**
 * Below this there is no hue to turn.
 *
 * Moonstone is `#9aa0a6`, a saturation of 0.06: rotating that produces another
 * grey nobody could tell from the first. The user's answer when asked: "The
 * opposite for moonstone can just be white or something." It is the app's own
 * text white rather than `#fff`, so the badge matches every other bright thing
 * on the page instead of being the one pure white pixel in the window.
 */
const MIN_SATURATION = 0.15

/** What a hue-less accent, or an unreadable one, resolves to. */
export const NEUTRAL_COMPLEMENT = '#f2f4f7'

/**
 * The complement is lifted to at least this lightness, and the number is
 * measured rather than chosen.
 *
 * The badge is 11px text on `--surface-raised` (`#23262d`), so WCAG's 4.5:1
 * for small text is the bar. Straight hue rotation fails it twice: Turquoise
 * turns into a dark red at 2.7:1 against the row and Jade into a dark magenta
 * at 3.3:1 - legible as a colour, unreadable as a word. Sweeping the floor
 * against the chip the badge actually sits on:
 *
 *   floor 0.60 -> worst 4.02    floor 0.65 -> worst 4.66
 *   floor 0.62 -> worst 4.25    floor 0.68 -> worst 5.12
 *
 * 0.65 is the first that clears 4.5, and it is taken rather than a safer 0.70
 * because every step past the bar pastels the colour and costs the thing the
 * user asked for - that it look like the opposite of their accent. Worst case
 * is then Turquoise at 4.66 on the chip and 5.6 on the row; the brightest,
 * Sapphire, is 13.2.
 */
export const COMPLEMENT_MIN_LIGHTNESS = 0.65

function parseHex(hex: string): [number, number, number] | null {
  const text = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null
  return [
    parseInt(text.slice(0, 2), 16) / 255,
    parseInt(text.slice(2, 4), 16) / 255,
    parseInt(text.slice(4, 6), 16) / 255
  ]
}

function toHex(r: number, g: number, b: number): string {
  const part = (c: number): string =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** Hue in turns (0-1), then saturation and lightness, as HSL. */
export function toHsl(hex: string): { h: number; s: number; l: number } | null {
  const rgb = parseHex(hex)
  if (rgb === null) return null
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h / 6, s, l }
}

function fromHsl(h: number, s: number, l: number): string {
  if (s === 0) return toHex(l, l, l)
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    const x = (t + 1) % 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return toHex(channel(h + 1 / 3), channel(h), channel(h - 1 / 3))
}

/**
 * The accent's opposite, as a hex string.
 *
 * Pure, so the one place that applies the accent can derive this beside it and
 * every window gets the same answer. Anything unreadable returns the neutral
 * rather than throwing: a badge in the wrong colour is a blemish, a renderer
 * that throws while painting a table is not.
 */
export function complementAccent(hex: string): string {
  const hsl = toHsl(hex)
  if (hsl === null) return NEUTRAL_COMPLEMENT
  if (hsl.s < MIN_SATURATION) return NEUTRAL_COMPLEMENT
  return fromHsl((hsl.h + 0.5) % 1, hsl.s, Math.max(hsl.l, COMPLEMENT_MIN_LIGHTNESS))
}

/** White, for text on an accent dark enough to carry it. */
export const ON_ACCENT_LIGHT = '#ffffff'
/** The app's near-black, for text on an accent too light for white. */
export const ON_ACCENT_DARK = '#0b0d10'

/** WCAG relative luminance of a `#rrggbb` colour; null if it does not parse. */
function relativeLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (m === null) return null
  const n = parseInt(m[1], 16)
  const channel = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  )
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la === null || lb === null) return 1
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The text colour for anything drawn on a solid accent fill.
 *
 * The user, 11/11/2026, of the stop strip on Ruby: "i don't want red text on a
 * red background. i would want white text on a red background is ok ... this
 * needs to generalize for all the accent colors and still be readable." White
 * cannot be the answer everywhere: it reads at about 5:1 on Ruby and Sapphire
 * and at about 2.5:1 on Turquoise, Jade, Amber and Moonstone. So each accent
 * takes whichever of white and the app's near-black reads better on it - white
 * on the dark ones, as asked, and near-black on the light ones, which is what
 * the start button already did. `--on-accent` carries it, set beside
 * `--accent` by `useAccentSync`, and `scripts/accents-check.ts` holds every
 * accent to 4.5:1.
 */
export function onAccent(hex: string): string {
  return contrastRatio(ON_ACCENT_LIGHT, hex) >= contrastRatio(ON_ACCENT_DARK, hex)
    ? ON_ACCENT_LIGHT
    : ON_ACCENT_DARK
}
