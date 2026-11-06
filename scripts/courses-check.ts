/**
 * Checks the course-code reader.
 *
 * Run:
 *   npx esbuild scripts/courses-check.ts --bundle --platform=node --format=esm \
 *     --outfile=<tmp>/c.mjs && node <tmp>/c.mjs [--db <copy-of-deepwork.db>]
 *
 * Every string below is a real task from the user's history. That is the
 * point: the negative cases are not hypothetical, they are the twelve
 * not-courses a naive `[A-Za-z]{2,5} ?\d{3,4}` actually produced when it was
 * run over the 2,353 quantified sessions, and each would have appeared in the
 * picker as a confident-looking option that selects nonsense.
 *
 * With `--db` it also runs over a copy of a real database and asserts that
 * nothing code-shaped slips through that is obviously not a course.
 */
import { courseFrom, coursesIn } from '../src/shared/courses'

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

console.log('--- the real codes, as the user types them ---')
eq('a space', courseFrom('CIS 1200 p-set'), 'CIS 1200')
eq('no space', courseFrom('Grade CIS1299 Fall 2026 Midterm'), 'CIS 1299')
eq('mid-sentence', courseFrom('Study for MATH 1410'), 'MATH 1410')
eq('a leading zero is not dropped', courseFrom('WRIT 0580 Reflection'), 'WRIT 0580')
eq('four letters', courseFrom('MEAM 1010 Quiz'), 'MEAM 1010')
eq('three letters', courseFrom('Study for ESE 1110 Midterm'), 'ESE 1110')
eq(
  'and a code found after a year is still found',
  courseFrom('Grade CIS1299 Fall 2026 Midterm'),
  'CIS 1299'
)

console.log('')
console.log('--- the twelve a naive pattern invented ---')
/*
 * Each of these came back as a "course" from the real history. Half are the
 * tail of an ordinary word; half are years. A picker listing `ALYZE 2022`
 * beside `MATH 1410` is worse than no picker at all.
 */
eq('the tail of a word is not a code', courseFrom('Analyze 2022 Rapid Reacts Teams - 118'), null)
eq('nor is this one', courseFrom('Princeton Review 645+ Questions: Practice Test 2'), null)
eq('nor this', courseFrom('Write Cornell 100 Word Supps'), null)
eq('a year is not a course number', courseFrom('Grade 2019 E&M FRQ Set 2'), null)
eq('even after real capitals', courseFrom('APUSH 2022 FRQ'), null)
eq('or a capitalised word', courseFrom('AP Lang 2018 FRQ'), null)
eq('both at once', courseFrom('Figure Out Spring 2027 Classes'), null)
eq('and a video title is not a course', courseFrom('Work on St1600 Video'), null)

console.log('')
console.log('--- the edges ---')
eq('nothing at all', courseFrom(''), null)
eq('null in, null out', courseFrom(null), null)
eq('two digits is not a course number', courseFrom('MATH 14'), null)
eq('five digits is not either', courseFrom('CIS 12000'), null)
eq('one letter is not a department', courseFrom('A 1200'), null)
eq('six letters is not either', courseFrom('ABCDEF 1200'), null)
eq(
  'lower case is deliberately missed - see the file comment',
  courseFrom('study for math 1410'),
  null
)

console.log('')
console.log('--- the picker list ---')
{
  const tasks = [
    'CIS 1200 p-set',
    'CIS 1200 Practice Test',
    'Study for MATH 1410',
    'Analyze 2022 Rapid Reacts',
    null,
    'WRIT 0580 Reflection',
    'CIS1200 HW06'
  ]
  eq('most-used first, and the two spellings of CIS 1200 are one course', coursesIn(tasks), [
    { course: 'CIS 1200', sessions: 3 },
    { course: 'MATH 1410', sessions: 1 },
    { course: 'WRIT 0580', sessions: 1 }
  ])
  eq('a task with no code contributes nothing', coursesIn([null, 'Bio HW']), [])
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
