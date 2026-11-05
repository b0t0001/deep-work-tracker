/**
 * Fails when a source file contains an invisible control character.
 *
 * Run:
 *   npx esbuild scripts/control-char-check.ts --bundle --platform=node \
 *     --format=esm --outfile=<tmp>/c.mjs && node <tmp>/c.mjs
 *
 * This exists because the same hazard has bitten this project three times in
 * one day and `CLAUDE.md` has warned about it since long before that. A
 * warning that is already written down and still catches people three times
 * is not doing the work.
 *
 * **The hazard.** A backslash escape can collapse somewhere between being
 * written and landing in the file, so a backslash-b escape arrives as a literal U+0008
 * BACKSPACE. The code then compiles, runs, matches nothing, and reads as a
 * logic bug. Nothing objects: it is a valid character in a valid string.
 *
 * **What this covers, and what already had cover.** Measured before writing
 * it - each case injected and run past the existing tools - rather than
 * assumed:
 *
 * | case | already caught by |
 * | --- | --- |
 * | literal newline in a quoted string | eslint, `Parsing error: Unterminated string literal` |
 * | control character inside a **regex** | eslint, `no-control-regex` |
 * | control character inside a plain **string** | nothing |
 *
 * **So this closes one case of three.** Verified by putting a U+0008 inside
 * a plain string literal in `src/shared/timer.ts`: eslint reported zero
 * findings for that file, typecheck passed, prettier passed, and only this
 * reported it. The other two rows are eslint's and should stay eslint's.
 *
 * Worth knowing rather than trusting this blindly: the three cases have two
 * owners, and nothing here is watching whether the other owner still exists.
 * This scan would in fact catch a control character in a regex as well, but
 * that is incidental - it is not why the rule was written and it is not what
 * the message says.
 *
 * So the rule is narrow and mechanical: **no C0 control characters in source,
 * other than tab, newline and carriage return.** Those three are ordinary
 * formatting; the rest are never deliberate in a text file, which is what
 * makes this checkable without parsing anything.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

/** Text we author. Binary assets live under the same roots and are skipped. */
const EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.json',
  '.md',
  '.yml',
  '.yaml'
])

const ROOTS = ['src', 'scripts']

/**
 * Tab, newline and carriage return are the three C0 characters that belong in
 * a text file. Everything else in the range is either a collapsed escape or
 * something pasted in by accident.
 */
function isForbidden(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false
  return code <= 0x1f || code === 0x7f
}

/** U+0008 reads better than 8 when you are trying to find it in an editor. */
const NAMES: Record<number, string> = {
  0x00: 'NUL',
  0x07: 'BEL',
  0x08: 'BACKSPACE',
  0x0b: 'VERTICAL TAB',
  0x0c: 'FORM FEED',
  0x1b: 'ESCAPE',
  0x7f: 'DELETE'
}

function describe(code: number): string {
  const hex = code.toString(16).toUpperCase().padStart(4, '0')
  const name = NAMES[code]
  return name ? `U+${hex} ${name}` : `U+${hex}`
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      yield* walk(path)
    } else if (EXTENSIONS.has(extname(entry.name))) {
      yield path
    }
  }
}

interface Finding {
  file: string
  line: number
  column: number
  code: number
  text: string
}

const findings: Finding[] = []
let scanned = 0

for (const root of ROOTS) {
  let exists = true
  try {
    statSync(root)
  } catch {
    exists = false
  }
  if (!exists) continue

  for (const file of walk(root)) {
    scanned++
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      for (let column = 0; column < line.length; column++) {
        const code = line.charCodeAt(column)
        if (!isForbidden(code)) continue
        findings.push({
          file: relative(process.cwd(), file),
          line: index + 1,
          column: column + 1,
          code,
          // The character itself is invisible, so show the line with it made
          // visible rather than printing something that looks identical to a
          // correct line.
          // Built character by character rather than with a regex, and not for
          // neatness: a character class covering this range is itself a control
          // character in a regular expression, so the obvious one-liner trips
          // eslint no-control-regex and this file would have failed the lint it
          // exists to supplement. It is the same advice the project already gives
          // about preferring (^|[^a-z]) to a backslash escape: the way not to be
          // bitten by an escape is not to write one.
          text: Array.from(line, (ch) => (isForbidden(ch.charCodeAt(0)) ? '<?>' : ch)).join('')
        })
      }
    }
  }
}

console.log(`scanned ${scanned} files under ${ROOTS.join(', ')}`)

if (findings.length === 0) {
  console.log('no invisible control characters')
  process.exit(0)
}

console.log('')
for (const f of findings) {
  console.log(`${f.file}:${f.line}:${f.column}  ${describe(f.code)}`)
  console.log(`  ${f.text}`)
  console.log(`  ${' '.repeat(Math.max(0, f.column - 1))}^ here, shown as <?>`)
  console.log('')
}
console.log(
  `${findings.length} invisible control character${findings.length === 1 ? '' : 's'}. ` +
    'These are almost always a backslash escape that collapsed in transit - ' +
    'a `\\b` that became a literal backspace, say. Prefer a pattern with no ' +
    'escape in it, as the project does with (^|[^a-z]) rather than \\b.'
)
process.exit(1)
