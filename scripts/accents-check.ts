/**
 * Exercises `complementAccent` in `src/shared/accents.ts`.
 *
 * No test runner here yet (CLAUDE.md, "Working practices") - logic is checked
 * by bundling it standalone and driving it from Node:
 *
 *   npx esbuild scripts/accents-check.ts --bundle --platform=node --format=esm --outfile=<tmp>/a.mjs
 *   node <tmp>/a.mjs
 *
 * Mostly properties rather than hard-coded hexes, and that is deliberate. The
 * expected value of a hue rotation is whatever this implementation computes,
 * so asserting a table of hexes taken from the implementation proves only that
 * it still does what it did. What the user asked for is a relationship - the
 * opposite side of the wheel - so the relationship is what gets checked, plus
 * the contrast floor that keeps the result readable, plus the two cases that
 * are genuinely exact: grey, and anything unreadable.
 *
 * Always exits 0; a failure is a line in the output.
 */
import {
  ACCENTS,
  COMPLEMENT_MIN_LIGHTNESS,
  NEUTRAL_COMPLEMENT,
  complementAccent,
  toHsl
} from '../src/shared/accents'

let passed = 0
let total = 0

function record(name: string, failure: string | null): void {
  total += 1
  if (failure === null) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name} -- ${failure}`)
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  record(
    name,
    actual === expected
      ? null
      : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

function check(name: string, ok: boolean, detail: string): void {
  record(name, ok ? null : detail)
}

function section(title: string): void {
  console.log('')
  console.log(title)
}

/** The chip the badge sits on: `--surface-raised`. */
const CHIP = '#23262d'
/** The row behind it: `--surface`. */
const ROW = '#14161a'
/** WCAG AA for small text, which 11px is. */
const FLOOR = 4.5

function luminance(hex: string): number {
  const text = hex.replace('#', '')
  const channel = (at: number): number => {
    const c = parseInt(text.slice(at, at + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Shortest distance between two hues, in turns, so 0.99 and 0.01 are close. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 1
  return Math.min(d, 1 - d)
}

// ------------------------------------------------------- the relationship --

section('--- the opposite side of the wheel ---')

for (const accent of ACCENTS) {
  const out = complementAccent(accent.value)
  const from = toHsl(accent.value)
  const to = toHsl(out)
  if (from === null || to === null) {
    check(`${accent.name} parses`, false, 'one of the two did not parse')
    continue
  }
  if (from.s < 0.15) {
    // Moonstone: no hue to turn. Covered on its own below.
    continue
  }
  check(
    `${accent.name} turns half the wheel`,
    Math.abs(hueGap(from.h, to.h) - 0.5) < 0.01,
    `hue ${from.h.toFixed(3)} -> ${to.h.toFixed(3)}, gap ${hueGap(from.h, to.h).toFixed(3)}`
  )
  check(
    `${accent.name} keeps its saturation`,
    Math.abs(from.s - to.s) < 0.02,
    `saturation ${from.s.toFixed(3)} -> ${to.s.toFixed(3)}`
  )
  check(
    `${accent.name} is never darkened`,
    to.l >= Math.min(from.l, COMPLEMENT_MIN_LIGHTNESS) - 0.01,
    `lightness ${from.l.toFixed(3)} -> ${to.l.toFixed(3)}`
  )
}

// --------------------------------------------------------- it has to read --

section('--- readable on the chip and on the row ---')

for (const accent of ACCENTS) {
  const out = complementAccent(accent.value)
  const onChip = contrast(out, CHIP)
  const onRow = contrast(out, ROW)
  check(
    `${accent.name} -> ${out} reads on the badge`,
    onChip >= FLOOR && onRow >= FLOOR,
    `chip ${onChip.toFixed(2)}, row ${onRow.toFixed(2)}, floor ${FLOOR}`
  )
}

// This is the assertion that would have caught the first version. Straight hue
// rotation put Turquoise at 2.73 against the row - a dark red on near-black.
check(
  'the lightness floor is what makes the two dark cases legible',
  (() => {
    const turquoise = toHsl(complementAccent('#14b8a6'))
    const jade = toHsl(complementAccent('#2eb85c'))
    return (
      turquoise !== null &&
      jade !== null &&
      turquoise.l >= COMPLEMENT_MIN_LIGHTNESS - 0.01 &&
      jade.l >= COMPLEMENT_MIN_LIGHTNESS - 0.01
    )
  })(),
  'Turquoise and Jade rotate to dark colours and must be lifted to the floor'
)

// -------------------------------------------------------- the exact cases --

section('--- grey, and anything unreadable ---')

eq('Moonstone has no opposite hue, so it is white', complementAccent('#9aa0a6'), NEUTRAL_COMPLEMENT)
eq('a pure grey is the same case', complementAccent('#808080'), NEUTRAL_COMPLEMENT)
eq('black too', complementAccent('#000000'), NEUTRAL_COMPLEMENT)
eq('and white', complementAccent('#ffffff'), NEUTRAL_COMPLEMENT)

eq('nonsense does not throw, it goes neutral', complementAccent('not a colour'), NEUTRAL_COMPLEMENT)
eq('nor does an empty string', complementAccent(''), NEUTRAL_COMPLEMENT)
eq(
  'nor a three-digit hex, which this app never stores',
  complementAccent('#abc'),
  NEUTRAL_COMPLEMENT
)

eq('the hash is optional', complementAccent('0a84ff'), complementAccent('#0a84ff'))
eq('and case does not matter', complementAccent('#0A84FF'), complementAccent('#0a84ff'))
eq('surrounding space is trimmed', complementAccent('  #0a84ff  '), complementAccent('#0a84ff'))

check(
  'every accent in the list gets one, so a new colour cannot arrive without',
  ACCENTS.every((a) => /^#[0-9a-f]{6}$/.test(complementAccent(a.value))),
  'one of the accents produced something that is not a hex colour'
)

// ---------------------------------------------------------------- report ---

console.log('')
for (const accent of ACCENTS) {
  const out = complementAccent(accent.value)
  console.log(
    `  ${accent.name.padEnd(10)} ${accent.value} -> ${out}  ` +
      `chip ${contrast(out, CHIP).toFixed(2)}  row ${contrast(out, ROW).toFixed(2)}`
  )
}

console.log('')
console.log(`${passed}/${total} passed`)
process.exit(0)
