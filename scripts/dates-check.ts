/**
 * Checks the display date format.
 *
 * Run:
 *   npx esbuild scripts/dates-check.ts --bundle --platform=node --format=esm \
 *     --outfile=<tmp>/d.mjs && node <tmp>/d.mjs
 *
 * The cases worth testing are the ones where a formatter does damage rather
 * than the ones where it works: something that is not a stored date must come
 * back untouched, not be reinterpreted into a plausible wrong day.
 */
import { formatDate, formatDateRange, formatDateTime, formatMonthDay } from '../src/shared/dates'

let pass = 0
let fail = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok)
    console.log(
      '        expected ' + JSON.stringify(expected) + '  actual ' + JSON.stringify(actual)
    )
}

console.log('--- formatDate ---')
eq('an ordinary date', formatDate('2026-11-05'), '11/05/2026')
eq('a single-digit day stays padded', formatDate('2023-03-07'), '03/07/2023')
eq('the first of January', formatDate('2026-01-01'), '01/01/2026')
eq('a leap day', formatDate('2024-02-29'), '02/29/2024')
eq('null is empty, not "Invalid Date"', formatDate(null), '')
eq('undefined is empty', formatDate(undefined), '')
eq('an empty string is empty', formatDate(''), '')

console.log('')
console.log('--- it must not mangle what it does not recognise ---')
eq(
  'a timestamp comes back untouched',
  formatDate('2026-11-05T14:00:00.000Z'),
  '2026-11-05T14:00:00.000Z'
)
eq('free text comes back untouched', formatDate('unquantifiable'), 'unquantifiable')
eq('an already-formatted date is not re-flipped', formatDate('11/05/2026'), '11/05/2026')

console.log('')
console.log('--- formatDateTime ---')
{
  // Built from local parts so the assertion does not depend on the zone the
  // check happens to run in.
  const at = new Date(2026, 10, 5, 9, 7)
  const got = formatDateTime(at.toISOString())
  eq('a UTC timestamp is shown local', got, '11/05/2026 09:07')
}
eq('an empty timestamp is empty', formatDateTime(''), '')
eq('nonsense comes back untouched', formatDateTime('not a date'), 'not a date')

console.log('')
console.log('--- formatDateRange ---')
eq('a shared year is said once', formatDateRange('2026-01-02', '2026-11-05'), '01/02 to 11/05/2026')
eq(
  'different years are both given',
  formatDateRange('2023-03-27', '2026-11-05'),
  '03/27/2023 to 11/05/2026'
)
eq('one day is one date', formatDateRange('2026-10-02', '2026-10-02'), '10/02/2026')
eq('a missing end gives the start', formatDateRange('2026-10-02', null), '10/02/2026')
eq('both missing is empty', formatDateRange(null, null), '')

console.log('')
console.log('--- formatMonthDay: chart axes, month first ---')
eq('September 11th is 09/11, never 11 Sep', formatMonthDay('2026-09-11'), '09/11')
eq('padded', formatMonthDay('2026-01-05'), '01/05')
eq('null is empty', formatMonthDay(null), '')
eq('not a stored date: untouched', formatMonthDay('Sep 11'), 'Sep 11')

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
