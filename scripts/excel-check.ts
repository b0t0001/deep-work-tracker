/**
 * Exports the sheet and reads the .xlsx back, twice over.
 *
 * **A fixture first**, built row by row so every case has a known answer: a
 * plain run stopped early, one that went to term, a loop of three laps, an
 * unquantifiable session, an unlabelled one, a hand-entered row whose actual
 * exceeds its planned, a fractional quantity, a multi-word unit and a `test`
 * row that must not appear. Each is checked as a *typed* cell - the date as a
 * date, the countdown as a duration, the hours as a number - because the
 * point of writing an .xlsx rather than a CSV is that Excel can compute with
 * it, and a string that merely looks right cannot be summed.
 *
 * **Then the real history**, compared row for row against the spreadsheet it
 * came from. That is the only test that can catch a convention quietly
 * drifting: the importer reads Start and End as countdown readings, this
 * writes them, and nothing short of the round trip proves the two agree. Give
 * it `--csv <the sheet's export>` and it matches every imported session
 * against the line it was read from.
 *
 * Three differences are expected there and are normalised rather than
 * ignored, each for a reason the comparison states:
 *
 * - **A blank End reads as `0:00:00`.** The sheet left nineteen cells empty in
 *   2023 where a countdown ran to term and has written the zero explicitly
 *   ever since.
 * - **Whitespace inside a unit collapses.** `126  words` was typed with two
 *   spaces; `normalizeUnit` trims and the sheet's own rows are inconsistent.
 * - **The unit's plural is rebuilt.** The importer stores `problem`, not
 *   `problems`, so the `s` is put back by rule - which is exactly what this
 *   comparison is checking, over all 2,336 rows rather than the handful
 *   anyone would think to write down.
 *
 * Run:
 *   npm run build
 *   npx esbuild scripts/excel-check.ts --bundle --platform=node --format=cjs \
 *     --target=node22 --external:electron --external:node:sqlite \
 *     --external:exceljs --outfile=out/excel/index.js
 *   npx electron out/excel/index.js [--db <copy>] [--csv <sheet export>]
 */
import { app } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import ExcelJS from 'exceljs'

const profile = join(app.getPath('temp'), `dwt-excel-${process.pid}`)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

function argument(name: string): string | null {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}

const source = argument('--db')
const sheetCsv = argument('--csv')
/** Keeps the workbook, so it can be opened and looked at. */
const outPath = argument('--out')

/*
 * The copy is put in place before anything opens a database, and is opened
 * the way the app opens it - not read-only.
 *
 * A snapshot taken weeks ago is behind on migrations: this one predated the
 * `laps` column, and read-only it stayed that way, so the export's own query
 * failed with `no such column`. Letting the runner migrate the copy is also
 * the honest test, because that is what happens to a real database before
 * this code ever sees it.
 */
if (source !== null && existsSync(source)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(source + suffix)) {
      copyFileSync(source + suffix, join(profile, `deepwork.db${suffix}`))
    }
  }
}

/*
 * Nothing here opens a window, so a rejected promise leaves an Electron
 * process with no UI and no reason to exit - a ten-minute hang rather than a
 * failure. Both of these turn one into a report.
 */
process.on('unhandledRejection', (error) => {
  console.log('')
  console.log(`UNHANDLED REJECTION: ${String(error)}`)
  app.exit(1)
})
const watchdog = setTimeout(() => {
  console.log('')
  console.log('TIMED OUT - the run never reached its own exit')
  app.exit(1)
}, 240_000)
watchdog.unref?.()

import { openDatabase } from '../src/main/db'
import { buildWorkbook, plural, roundHalfUp } from '../src/main/excel'
import { parseCsv, normalizeProject, normalizeUnit } from '../src/main/import/csv'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? (pass += 1) : (fail += 1)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok && detail !== '') console.log(`       ${detail}`)
}

const SECONDS_PER_DAY = 86_400

/** What a cell holds, reduced to something comparable. */
function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'error' in value) return String(value.error)
  if (typeof value === 'object' && 'richText' in value) {
    return value.richText.map((part) => part.text).join('')
  }
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/**
 * A duration cell, back to whole seconds.
 *
 * The cell in the file is a number of days with an elapsed-time format, which
 * is how Excel and Google Sheets represent a duration and what lets them add
 * a column of them. **ExcelJS's reader does not know that**: it classifies
 * any `h:mm:ss`-shaped format as a date and hands back a `Date` near the 1900
 * epoch. The file is right and the reader is guessing, so the guess is undone
 * here rather than the file being written as text to suit it - serial 0 is
 * 1899-12-30, which is 25,569 days before the Unix epoch.
 */
const EXCEL_EPOCH_DAYS = 25_569

function seconds(value: ExcelJS.CellValue): number {
  const days =
    value instanceof Date
      ? value.getTime() / (SECONDS_PER_DAY * 1000) + EXCEL_EPOCH_DAYS
      : Number(value)
  return Math.round(days * SECONDS_PER_DAY)
}

function hms(total: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  return `${h}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** `m/d/yy`, the sheet's own date format. */
function mdy(value: ExcelJS.CellValue): string {
  if (!(value instanceof Date)) return text(value)
  return `${value.getMonth() + 1}/${value.getDate()}/${String(value.getFullYear()).slice(2)}`
}

async function readBack(book: ExcelJS.Workbook): Promise<ExcelJS.Worksheet> {
  const buffer = await book.xlsx.writeBuffer()
  const read = new ExcelJS.Workbook()
  await read.xlsx.load(buffer as ArrayBuffer)
  const sheet = read.worksheets[0]
  if (sheet === undefined) throw new Error('the workbook came back with no sheet')
  return sheet
}

app.whenReady().then(async () => {
  const real = source !== null && existsSync(source)

  if (!real) {
    console.log('')
    console.log('--- a fixture, every case with a known answer ---')

    const db = openDatabase()
    db.exec("INSERT INTO projects (name) VALUES ('HW'), ('Startup')")
    const hw = 1
    const startup = 2
    /** date, project, task, planned, actual, laps, qty, unit, unq, notes, source */
    const fixture: Array<
      [
        string,
        number | null,
        string,
        number,
        number,
        number,
        number | null,
        string | null,
        number,
        string | null,
        string
      ]
    > = [
      ['2026-01-05', hw, 'MATH 1410 PrepQuiz', 3000, 1400, 1, 10, 'question', 0, null, 'app'],
      ['2026-01-06', hw, 'WRIT 0580 Reflection', 1200, 1200, 1, 547, 'word', 0, null, 'app'],
      ['2026-01-07', startup, 'CalHacks App', 2700, 7000, 3, 891, 'word', 0, 'went long', 'app'],
      ['2026-01-08', hw, 'Computer Systems Project', 2700, 2700, 1, null, null, 1, null, 'app'],
      ['2026-01-09', null, 'Something unlabelled', 600, 300, 1, null, null, 0, null, 'app'],
      [
        '2026-01-10',
        startup,
        'Penn Electric Racing',
        3600,
        21600,
        1,
        null,
        null,
        0,
        'from memory',
        'manual'
      ],
      ['2026-01-11', hw, 'Bio workbook', 1800, 1800, 1, 0.5, 'page', 0, null, 'import'],
      ['2026-01-12', startup, 'Trim the demo', 1800, 600, 1, 90, 'seconds edited', 0, null, 'app'],
      ['2026-01-13', hw, 'CAD the bracket', 1800, 900, 1, 4, 'cad model', 0, null, 'app'],
      ['2026-01-14', hw, 'A harness wrote this', 600, 600, 1, 1, 'question', 0, null, 'test']
    ]
    const insert = db.prepare(
      `INSERT INTO sessions
       (project_id, task, session_date, planned_duration_s, running_duration_s,
        work_quantity, work_unit, unquantifiable, notes, source, laps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const row of fixture) {
      insert.run(
        row[1],
        row[2],
        row[0],
        row[3],
        row[4],
        row[6],
        row[7],
        row[8],
        row[9],
        row[10],
        row[5]
      )
    }

    const sheet = await readBack(buildWorkbook())

    check(
      'the test row is left out and every other source is kept',
      sheet.rowCount === fixture.length, // header + 9 rows
      `${sheet.rowCount - 1} data rows, expected ${fixture.length - 1}`
    )
    check(
      "the header is the sheet's, in its order",
      sheet
        .getRow(1)
        .values?.toString()
        .includes(
          'Date,Block,Tasks,Start (HH:MM:SS),End (HH:MM:SS),Total Time (hours),Work Done,Efficiency (work/minute),Notes,Task List'
        ) === true,
      String(sheet.getRow(1).values)
    )
    check('the header row is bold', sheet.getRow(1).font?.bold === true)
    check(
      'and frozen, so the columns stay named',
      sheet.views[0]?.state === 'frozen' && sheet.views[0]?.ySplit === 1,
      JSON.stringify(sheet.views[0])
    )
    check(
      'every column has a width',
      sheet.columns.every((column) => typeof column.width === 'number' && column.width > 8)
    )

    const row = (n: number): ExcelJS.Row => sheet.getRow(n + 1)

    // 1 - a plain run stopped early
    check(
      'a date is a real date, shown as m/d/yy',
      row(1).getCell(1).value instanceof Date && row(1).getCell(1).numFmt === 'm/d/yy',
      `${text(row(1).getCell(1).value)} ${row(1).getCell(1).numFmt}`
    )
    check(
      '  and reads as the day it was',
      mdy(row(1).getCell(1).value) === '1/5/26',
      mdy(row(1).getCell(1).value)
    )
    check('Block is the project name', text(row(1).getCell(2)) === 'HW', text(row(1).getCell(2)))
    check(
      'Start is what the timer was set to',
      seconds(row(1).getCell(4).value) === 3000 && row(1).getCell(4).numFmt === '[h]:mm:ss',
      `${hms(seconds(row(1).getCell(4).value))} ${row(1).getCell(4).numFmt}`
    )
    check(
      'End is what was left',
      seconds(row(1).getCell(5).value) === 1600,
      hms(seconds(row(1).getCell(5).value))
    )
    check(
      '  so Start minus End is the time worked',
      seconds(row(1).getCell(4).value) - seconds(row(1).getCell(5).value) === 1400
    )
    check(
      'Total Time is hours as a number, to two decimals',
      Math.abs(Number(row(1).getCell(6).value) - 1400 / 3600) < 1e-9 &&
        row(1).getCell(6).numFmt === '0.00',
      `${row(1).getCell(6).value} ${row(1).getCell(6).numFmt}`
    )
    check(
      'Work Done pluralises the unit',
      text(row(1).getCell(7)) === '10 questions',
      text(row(1).getCell(7))
    )
    check(
      'Efficiency is the rate to three decimals, carrying the unit',
      text(row(1).getCell(8)) === '0.429 questions/minute',
      text(row(1).getCell(8))
    )

    // 2 - ran to term
    check(
      'a run that went to term writes End 0:00:00',
      seconds(row(2).getCell(5).value) === 0,
      hms(seconds(row(2).getCell(5).value))
    )

    // 3 - a loop of three laps
    check(
      'a loop is one row, with Start = one lap x the laps it ran',
      seconds(row(3).getCell(4).value) === 2700 * 3,
      hms(seconds(row(3).getCell(4).value))
    )
    check(
      '  and Start minus End is still the time worked',
      seconds(row(3).getCell(4).value) - seconds(row(3).getCell(5).value) === 7000
    )

    // 4 - unquantifiable
    check(
      'an unquantifiable session says so',
      text(row(4).getCell(7)) === 'unquantifiable',
      text(row(4).getCell(7))
    )
    check(
      "  and its Efficiency is the sheet's #N/A",
      text(row(4).getCell(8)) === '#N/A',
      text(row(4).getCell(8))
    )

    // 5 - unlabelled
    check(
      'an unlabelled session leaves Block empty',
      text(row(5).getCell(2)) === '',
      text(row(5).getCell(2))
    )

    // 6 - a hand-entered row that overran its goal
    check(
      'a session longer than its goal still has End >= 0',
      seconds(row(6).getCell(5).value) >= 0,
      hms(seconds(row(6).getCell(5).value))
    )
    check(
      '  with Start stretched to the time worked, so the invariant holds',
      seconds(row(6).getCell(4).value) - seconds(row(6).getCell(5).value) === 21600,
      `${hms(seconds(row(6).getCell(4).value))} - ${hms(seconds(row(6).getCell(5).value))}`
    )

    // 7 - a fractional quantity is plural
    check(
      '0.5 is plural, as the sheet writes it',
      text(row(7).getCell(7)) === '0.5 pages',
      text(row(7).getCell(7))
    )

    // 8, 9 - multi-word units
    check(
      'a unit that is already plural is left alone',
      text(row(8).getCell(7)) === '90 seconds edited',
      text(row(8).getCell(7))
    )
    check(
      'and one that is not pluralises its last word',
      text(row(9).getCell(7)) === '4 cad models',
      text(row(9).getCell(7))
    )

    check('notes come through', text(row(3).getCell(9)) === 'went long', text(row(3).getCell(9)))
    check(
      'rows are oldest first',
      mdy(row(1).getCell(1).value) === '1/5/26' && mdy(row(9).getCell(1).value) === '1/13/26'
    )
  }

  // ---------------------------------------------------------------- the real thing
  if (real) {
    console.log('')
    console.log('--- the real history, against the sheet it came from ---')
    const rows = openDatabase()
      .prepare(
        `SELECT s.session_date, p.name AS project, s.task,
                s.planned_duration_s, s.running_duration_s,
                s.work_quantity, s.work_unit, s.unquantifiable, s.notes, s.laps, s.source
           FROM sessions s
           LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.source <> 'test' AND s.session_date IS NOT NULL
          ORDER BY s.session_date, s.id`
      )
      .all() as unknown as Array<{ source: string }>
    console.log(`    ${rows.length.toLocaleString()} sessions`)

    const book = buildWorkbook(rows as never)
    if (outPath !== null) {
      await book.xlsx.writeFile(outPath)
      console.log(`    wrote ${outPath}`)
    }
    const big = await readBack(book)
    check(
      'every session is a row',
      big.rowCount - 1 === rows.length,
      `${big.rowCount - 1} rows for ${rows.length} sessions`
    )

    let negative = 0
    let mismatched = 0
    for (let n = 2; n <= big.rowCount; n += 1) {
      const line = big.getRow(n)
      const start = seconds(line.getCell(4).value)
      const end = seconds(line.getCell(5).value)
      const hours = Number(line.getCell(6).value)
      if (end < 0 || start < 0) negative += 1
      if (Math.abs((start - end) / 3600 - hours) > 1 / 3600) mismatched += 1
    }
    check('no countdown is negative', negative === 0, `${negative} rows`)
    check(
      'and Start minus End equals Total Time on every row',
      mismatched === 0,
      `${mismatched} rows disagree`
    )

    /*
     * The sheet only ever held the imported rows. Everything this app has
     * recorded since, and everything entered by hand, is in the database and
     * was never in the spreadsheet, so matching those against it would be
     * asking the comparison to find lines that do not exist. The round trip
     * being checked is import -> database -> export, over exactly the rows
     * that made that trip.
     */
    const importedRows = rows.filter((one) => one.source === 'import')
    const imported = await readBack(buildWorkbook(importedRows as never))
    console.log(`    ${importedRows.length.toLocaleString()} of them came from the sheet`)

    if (sheetCsv !== null && existsSync(sheetCsv)) {
      /*
       * The source sheet, line for line.
       *
       * Matched on date plus the Start reading rather than on position: the
       * sheet has a row for every calendar day and the export has one per
       * session, so the two are not the same length and never line up. Two
       * sessions on one day with the same planned length are the one
       * ambiguous case, and they are consumed in order.
       */
      const table = parseCsv(readFileSync(sheetCsv, 'utf8'))
      const header = table[0].map((h) => h.trim())
      const at = (name: string): number => header.findIndex((h) => h.startsWith(name))
      const iDate = at('Date')
      const iBlock = at('Block')
      const iTask = at('Tasks')
      const iStart = at('Start')
      const iEnd = at('End')
      const iTotal = at('Total Time')
      const iWork = at('Work Done')
      const iEff = at('Efficiency')

      const tidy = (s: string): string => s.trim().replace(/\s+/g, ' ')
      /** A sheet cell and an exported one, with the three known differences out. */
      const same = (sheetCell: string, ours: string): boolean => {
        const a = tidy(sheetCell)
        const b = tidy(ours)
        if (a === b) return true
        // A blank End is a countdown that reached zero.
        if (a === '' && b === '0:00:00') return true
        return false
      }

      const byKey = new Map<string, string[][]>()
      for (const raw of table.slice(1)) {
        const date = tidy(raw[iDate] ?? '')
        const start = tidy(raw[iStart] ?? '')
        if (date === '' || start === '') continue
        const key = `${date}|${start}`
        const list = byKey.get(key) ?? []
        list.push(raw)
        byKey.set(key, list)
      }

      /*
       * Two places where the sheet disagrees with itself, found by running
       * this over all 2,474 rows. Both are allowed, counted and printed -
       * not quietly skipped - because the export is the consistent one and
       * the difference is worth seeing if it ever grows.
       *
       * **Seven Total Time cells carry three decimals** (`0.675`, `2.000`),
       * all of them on two days in August 2024, against 2,467 written to
       * two. Same number, a format someone changed on a handful of cells.
       * The export writes a real number with one format, so Excel renders
       * every row alike; the comparison is therefore on the value.
       *
       * **Three Efficiency cells name a shorter unit than their own Work
       * Done.** `1 videos + 1 question` worked out at `0.167
       * videos/minute`; the formula took the text up to the separator. Work
       * Done matches on all 2,474 rows, so the export is repeating the unit
       * it just reported and the sheet is the one that truncated. Allowed
       * when the rate is identical and the sheet's unit begins ours.
       */
      let looseTotal = 0
      let looseUnit = 0
      let compared = 0
      let unmatched = 0
      const wrong: Record<string, number> = {}
      const example: Record<string, string> = {}
      for (let n = 2; n <= imported.rowCount; n += 1) {
        const line = imported.getRow(n)
        const key = `${mdy(line.getCell(1).value)}|${hms(seconds(line.getCell(4).value))}`
        const candidates = byKey.get(key)
        if (candidates === undefined || candidates.length === 0) {
          unmatched += 1
          continue
        }
        const raw = candidates.shift() as string[]
        compared += 1
        const note = (field: string, sheetCell: string, ours: string): void => {
          if (same(sheetCell, ours)) return
          wrong[field] = (wrong[field] ?? 0) + 1
          const line = `${key}  sheet ${JSON.stringify(tidy(sheetCell))}  ours ${JSON.stringify(tidy(ours))}`
          example[field] = `${example[field] ?? ''}
        ${line}`
        }
        // Block is compared after the sheet's ordinal is stripped and its
        // aliases applied - the same reading the importer did, because that
        // is what produced the project name being written back.
        note('Block', normalizeProject(raw[iBlock] ?? '') ?? '', text(line.getCell(2)))
        note('Tasks', raw[iTask] ?? '', text(line.getCell(3)))
        note('End', raw[iEnd] ?? '', hms(seconds(line.getCell(5).value)))
        // Total Time is a real number in the file with a `0.00` format, so what
        // the sheet is being compared against is what Excel will *display* -
        // and Excel rounds a half up, where `toFixed` rounds the double below
        // it. Same rounder as the exporter, so the two cannot drift.
        const sheetTotal = tidy(raw[iTotal] ?? '')
        const ourTotal = roundHalfUp(Number(line.getCell(6).value), 2)
        if (sheetTotal !== ourTotal && Math.abs(Number(sheetTotal) - Number(ourTotal)) < 0.0051) {
          looseTotal += 1
        } else {
          note('Total Time', sheetTotal, ourTotal)
        }
        // Work Done and Efficiency are compared with the unit put through the
        // importer's own normaliser on both sides, so the comparison is about
        // the number and the plural rather than about `126  words`.
        const sheetWork = tidy(raw[iWork] ?? '')
        const match = /^([\d.,]+)\s+(.+)$/.exec(sheetWork)
        const sheetWorkTidy =
          match === null
            ? sheetWork
            : `${Number(match[1].replace(/,/g, ''))} ${plural(normalizeUnit(match[2]), Number(match[1].replace(/,/g, '')))}`
        note('Work Done', sheetWorkTidy, text(line.getCell(7)))
        const sheetEff = tidy(raw[iEff] ?? '')
        const effMatch = /^([\d.]+)\s+(.+)\/minute$/.exec(sheetEff)
        const sheetEffTidy =
          effMatch === null || match === null
            ? sheetEff
            : `${effMatch[1]} ${plural(normalizeUnit(effMatch[2]), Number(match[1].replace(/,/g, '')))}/minute`
        const ourEff = text(line.getCell(8))
        const sheetUnit = /^([\d.]+) (.+)\/minute$/.exec(tidy(sheetEffTidy))
        const ourUnit = /^([\d.]+) (.+)\/minute$/.exec(tidy(ourEff))
        if (
          sheetEffTidy !== ourEff &&
          sheetUnit !== null &&
          ourUnit !== null &&
          sheetUnit[1] === ourUnit[1] &&
          ourUnit[2].startsWith(sheetUnit[2])
        ) {
          looseUnit += 1
        } else {
          note('Efficiency', sheetEffTidy, ourEff)
        }
      }

      console.log(
        `    matched ${compared.toLocaleString()} of ${imported.rowCount - 1} imported rows to a line in the sheet`
      )
      console.log(
        `      allowed: ${looseTotal} Total Time cells the sheet wrote to three decimals, ` +
          `${looseUnit} Efficiency cells whose unit the sheet truncated`
      )
      for (const [field, count] of Object.entries(wrong)) {
        console.log(`      ${field}: ${count} differ${example[field]}`)
      }
      check(
        'every imported row is found in the sheet it came from',
        unmatched === 0,
        `${unmatched} not found`
      )
      for (const field of ['Block', 'Tasks', 'End', 'Total Time', 'Work Done', 'Efficiency']) {
        check(
          `  ${field} matches the sheet on all ${compared.toLocaleString()} rows`,
          (wrong[field] ?? 0) === 0
        )
      }
    }
  }

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})
