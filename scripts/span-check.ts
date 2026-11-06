/**
 * Checks the Custom range parser.
 *
 * Run:
 *   npx esbuild scripts/span-check.ts --bundle --platform=node --format=esm \
 *     --outfile=<tmp>/s.mjs && node <tmp>/s.mjs
 *
 * The user asked for a field they can "insert anything" into, which makes the
 * failures the interesting half: anything includes a typo, an empty box and a
 * unit nobody has heard of, and each has to come back as a sentence the panel
 * can print rather than a dialog or a silent fallback.
 */
import { MAX_SPAN_DAYS, parseSpan } from '../src/shared/span'
import { describeSpan, windowDefFor } from '../src/shared/windows'

let pass = 0
let fail = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) {
    console.log(
      '        expected ' + JSON.stringify(expected) + '  actual ' + JSON.stringify(actual)
    )
  }
}

const days = (text: string): number | null => parseSpan(text).days
const problem = (text: string): string => parseSpan(text).problem

console.log('--- the forms the user named ---')
eq('45 days', days('45 days'), 45)
eq('3 weeks', days('3 weeks'), 21)
eq('10 months', days('10 months'), 300)
eq('1 year', days('1 year'), 365)
eq('a bare number is days', days('45'), 45)

console.log('')
console.log('--- the spellings people actually type ---')
eq('no space', days('45days'), 45)
eq('singular', days('1 day'), 1)
eq('abbreviated', days('3 wks'), 21)
eq('the bare initial, which is what gets typed', days('3w'), 21)
eq('and for the others too', [days('5d'), days('2m'), days('1y')], [5, 60, 365])
eq('mo', days('2mo'), 60)
eq('yr', days('2 yrs'), 730)
eq('capitals', days('3 WEEKS'), 21)
eq('padded', days('  3 weeks  '), 21)
eq('a decimal, because 1.5 months is a reasonable thing to type', days('1.5 months'), 45)

console.log('')
console.log('--- what it refuses, and what it says ---')
/*
 * An empty field is not an error. It is a box nobody has finished typing in,
 * and reddening it the moment it is cleared is the behaviour CLAUDE.md
 * already rejects for the clock and the pace fields.
 */
eq('empty is not an error', parseSpan(''), { days: null, problem: '' })
eq('nor is whitespace', parseSpan('   '), { days: null, problem: '' })
eq('zero is refused', days('0 days'), null)
eq('and says why', problem('0 days'), 'That has to be more than zero.')
eq('a negative never parses as a number here', days('-5 days'), null)
eq('an unknown unit is named back', problem('5 fortnights').includes('fortnights'), true)
eq('and suggests the real ones', problem('5 fortnights').includes('days, weeks'), true)
eq('prose is refused', days('about three weeks'), null)
eq('with a worked example', problem('about three weeks').includes('45 days'), true)
eq('a span rounding below a day is refused', days('0.0001 days'), null)
eq('and one longer than any history', days('200 years'), null)
eq(
  'which points at the option that does mean that',
  problem('200 years').includes('All time'),
  true
)
eq('the ceiling itself is allowed', days(`${MAX_SPAN_DAYS} days`), MAX_SPAN_DAYS)

console.log('')
console.log('--- the label it reads back as ---')
/*
 * Someone who typed "3 weeks" should see "past 3 weeks", not "past 21 days".
 * Exact divisions only: 20 days is 20 days, not 2.9 weeks.
 */
eq('weeks come back as weeks', describeSpan(21), '3 weeks')
eq('a year as a year', describeSpan(365), '1 year')
eq('months as months', describeSpan(90), '3 months')
eq('and an awkward number as days', describeSpan(20), '20 days')
eq('one of something is singular', describeSpan(7), '1 week')

console.log('')
console.log('--- a custom window resolves like any other ---')
eq('with a span it has a length', windowDefFor('custom', 45).days, 45)
eq('and reads it back', windowDefFor('custom', 45).label, 'past 45 days')
/*
 * The safe direction. A half-typed span showing more than was asked for is a
 * chart you can see is wrong; one silently showing a week is a chart you
 * cannot.
 */
eq('without one it is all time, not a week', windowDefFor('custom', null).days, null)
eq('and says so', windowDefFor('custom', null).label, 'all time')
eq('a preset ignores any typed span', windowDefFor('1w', 500).days, 7)

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
