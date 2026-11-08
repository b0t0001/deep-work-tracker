/**
 * The history as an .xlsx laid out like the user's Google Sheet.
 *
 * *"give me a option to back up my data to an Excel spreadsheet. And it should
 * be formatted in the same way that my Google Sheet is."*
 *
 * The CSV backup in `backup.ts` is the one that can be restored from: it
 * carries ids, timestamps, pauses, stop reasons and pace targets, which is
 * everything `restore.ts` needs to rebuild the database. **This is not that.**
 * This is the sheet the user has been reading for three and a half years,
 * written from the same rows - ten columns, one per session, the countdown
 * convention and all. It is for reading, charting and keeping; it is not a
 * restore format, and `restore.ts` does not accept it.
 *
 * ## The countdown convention
 *
 * Start and End are **time remaining on the timer, not clock times** - every
 * row in the source sheet has `End < Start`, and `Start - End` is the time
 * worked. `main/import/csv.ts` reads that convention; this writes it, and the
 * two have to agree or a round trip through the sheet would move every
 * duration.
 *
 * - **Start is what the timer was set to**, which for a loop is one lap's
 *   length times the laps it ran. `planned_duration_s` is deliberately one
 *   lap (see CLAUDE.md), so a two-lap 45-minute loop writes `1:30:00`, and
 *   `Start - End` is still the time actually worked.
 * - **End is what was left**, `Start - actual`.
 * - A run that went to term writes `0:00:00` rather than a blank. The sheet
 *   left those nineteen cells empty in 2023 and has written `0:00:00` ever
 *   since; the importer reads both the same way, and an explicit zero cannot
 *   be mistaken for a cell nobody filled in.
 *
 * **Start is floored at the time actually worked.** A hand-entered session
 * carries a planned and an actual that are independent - someone can record
 * two hours against a one-hour goal - and the arithmetic above would then put
 * a negative number in End. Taking `max(planned x laps, actual)` keeps the
 * one invariant the sheet rests on, that `Start - End` is the time worked,
 * and spends the goal rather than the fact when they disagree. Timed rows are
 * never in this case: a lap cannot overrun its own length.
 *
 * ## Everything else that has to match
 *
 * - **Block is the project name, with no ordinal.** The sheet says `HW 1`,
 *   `HW 2`, `College Apps 3`; CLAUDE.md records that the user confirmed the
 *   number carries no meaning, and the importer strips it. Nothing stores it,
 *   so writing one back would mean inventing a sequence. An unlabelled
 *   session leaves Block empty.
 * - **Work Done is `19 problems`**, the unit pluralised exactly as the sheet
 *   does it - see `plural` below, which is built from what the sheet actually
 *   contains rather than from a guess about English.
 * - **Efficiency is `0.613 problems/minute`**, three decimals, carrying the
 *   same unit text. An unquantifiable session gets `#N/A`, which is what the
 *   sheet's own formula produces for one, written as a real Excel error value
 *   rather than as the text.
 * - **Total Time is hours to two decimals**, from the running time, which
 *   excludes every pause.
 *
 * ## Typed cells, not a CSV with a different extension
 *
 * Dates are dates, durations are durations and hours are numbers, each with a
 * display format that renders the same characters the sheet shows. Excel can
 * then sum a column or chart it without anyone re-typing it. The two columns
 * that stay text are the two the sheet itself keeps as text - Work Done and
 * Efficiency both bake the unit into the value, and splitting them into number
 * and unit would be a different sheet from the one that was asked for.
 *
 * Durations are written as a fraction of a day - Excel's own representation -
 * with the `[h]:mm:ss` format rather than `h:mm:ss`. The square brackets are
 * elapsed time: without them a loop that ran past twenty-four hours would
 * display as the remainder after midnight.
 *
 * ## What is left out
 *
 * - **`test` rows.** Every unpackaged build writes them, and they are already
 *   excluded from analytics.
 * - **A row per calendar day.** The sheet has one for every day since March
 *   2023, with `N/A` where the user rested. The app has no rest days - a day
 *   with no work is a day with no rows, and CLAUDE.md records that those `N/A`
 *   marks existed only to satisfy conditional formatting. Writing them would
 *   mean inventing a distinction the data does not carry, including for every
 *   day before the first session.
 */
import ExcelJS from 'exceljs'
import { openDatabase } from './db'

/** The sheet's columns, in its order, with the widths that fit its content. */
const COLUMNS: Array<{ header: string; width: number }> = [
  { header: 'Date', width: 11 },
  { header: 'Block', width: 20 },
  { header: 'Tasks', width: 38 },
  { header: 'Start (HH:MM:SS)', width: 16 },
  { header: 'End (HH:MM:SS)', width: 16 },
  { header: 'Total Time (hours)', width: 17 },
  { header: 'Work Done', width: 20 },
  { header: 'Efficiency (work/minute)', width: 23 },
  { header: 'Notes', width: 60 },
  { header: 'Task List', width: 30 }
]

const SECONDS_PER_DAY = 86_400

interface SheetRow {
  session_date: string | null
  project: string | null
  task: string | null
  planned_duration_s: number | null
  running_duration_s: number | null
  work_quantity: number | null
  work_unit: string | null
  unquantifiable: number
  notes: string | null
  laps: number | null
}

/**
 * The unit as the sheet writes it for this quantity.
 *
 * `normalizeUnit` in the importer strips a trailing `s`, so what is stored is
 * `question`, `word`, `cad model`. Putting the `s` back is not quite "add an
 * s", and the three rules below are read off the sheet's own 212 units rather
 * than reasoned about:
 *
 * - **A unit that already contains a plural is left alone.** `questions
 *   reviewed`, `seconds edited`, `minutes trimmed` keep their plural on the
 *   *first* word, so the stored form never lost one and adding another would
 *   give `questions revieweds`.
 * - **A unit ending in a past participle pluralises its first word.**
 *   `application submitted` becomes `applications submitted`.
 * - **Anything else pluralises its last word.** `cad model` becomes `cad
 *   models`, `bullet point` becomes `bullet points`.
 *
 * Exactly one is singular: a quantity of 1. The sheet writes `0 questions`
 * and `0.25 slides`, so this is equality with one, not "more than one".
 */
export function plural(unit: string, quantity: number): string {
  if (quantity === 1) return unit
  const words = unit.split(' ').filter((one) => one !== '')
  if (words.length === 0) return unit
  if (words.some((one) => one.endsWith('s') && !one.endsWith('ss'))) return unit
  const at = /ed$/.test(words[words.length - 1]) && words.length > 1 ? 0 : words.length - 1
  words[at] = `${words[at]}s`
  return words.join(' ')
}

/**
 * Rounded the way the sheet rounds, which is not the way `toFixed` does.
 *
 * A spreadsheet rounds a half up: 0.215 displays as `0.22` and 0.0375 as
 * `0.038`. `toFixed` rounds the *binary double*, and neither of those halves
 * is exactly representable - both sit a hair below - so it gives `0.21` and
 * `0.037`. Measured against the user's own sheet, that disagreed on 36 of
 * 2,474 Total Time cells and 5 Efficiency cells.
 *
 * Total Time is written as a real number and formatted by Excel, so Excel's
 * own rounding settles it there; Efficiency is text this builds, so it has to
 * round for itself. The nudge is far smaller than any figure here and far
 * larger than the representation error it is correcting.
 */
export function roundHalfUp(value: number, places: number): string {
  const scale = 10 ** places
  return (Math.round(value * scale + 1e-9) / scale).toFixed(places)
}

/** `19 problems`, or the sheet's literal `unquantifiable`, or nothing. */
export function workDone(row: {
  work_quantity: number | null
  work_unit: string | null
  unquantifiable: number
}): string | null {
  if (row.unquantifiable) return 'unquantifiable'
  if (row.work_quantity === null || row.work_unit === null) return null
  // Trailing zeros trimmed: the sheet writes `0.5 pages`, never `0.50 pages`.
  const quantity = String(Number(row.work_quantity))
  return `${quantity} ${plural(row.work_unit, row.work_quantity)}`
}

/** `0.613 problems/minute`, to the sheet's three decimals. */
export function efficiency(
  row: { work_quantity: number | null; work_unit: string | null; unquantifiable: number },
  runningSeconds: number
): string | null {
  if (row.unquantifiable) return null
  if (row.work_quantity === null || row.work_unit === null || runningSeconds <= 0) return null
  const perMinute = row.work_quantity / (runningSeconds / 60)
  return `${roundHalfUp(perMinute, 3)} ${plural(row.work_unit, row.work_quantity)}/minute`
}

/**
 * Start and End, in seconds of countdown.
 *
 * The one invariant: `start - end` is the time actually worked. See the file
 * comment for why Start is floored at it.
 */
export function countdown(row: {
  planned_duration_s: number | null
  running_duration_s: number | null
  laps: number | null
}): { start: number; end: number } {
  const actual = Math.max(0, Math.round(row.running_duration_s ?? 0))
  const laps = Math.max(1, Math.round(row.laps ?? 1))
  const planned = Math.max(0, Math.round(row.planned_duration_s ?? 0)) * laps
  const start = Math.max(planned, actual)
  return { start, end: start - actual }
}

/** A local calendar date, as a Date Excel will store without a timezone shift. */
function dateCell(iso: string | null): Date | null {
  if (iso === null) return null
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (parts === null) return null
  // Noon, not midnight. Excel keeps a serial number and the reader turns it
  // back into a Date; an hour either way around midnight from any rounding or
  // timezone handling would land on the previous day.
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12, 0, 0)
}

/**
 * Every session the sheet should carry, oldest first.
 *
 * Ordered by date and then by id, which is the order they happened in and the
 * order the sheet is in. A row with no `session_date` cannot be placed in a
 * sheet whose first column is the date, and there are none in the real
 * history - the column arrived with a migration that filled it - but the
 * query states the requirement rather than assuming it.
 */
export function sheetRows(): SheetRow[] {
  return openDatabase()
    .prepare(
      `SELECT s.session_date, p.name AS project, s.task,
              s.planned_duration_s, s.running_duration_s,
              s.work_quantity, s.work_unit, s.unquantifiable, s.notes, s.laps
         FROM sessions s
         LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.source <> 'test' AND s.session_date IS NOT NULL
        ORDER BY s.session_date, s.id`
    )
    .all() as unknown as SheetRow[]
}

export interface ExcelOutcome {
  ok: boolean
  path?: string
  rows?: number
  reason?: string
}

/** The workbook, built but not written. Separated so a check can read it back. */
export function buildWorkbook(rows = sheetRows()): ExcelJS.Workbook {
  const book = new ExcelJS.Workbook()
  book.creator = 'Deep Work Tracker'
  book.created = new Date()
  const sheet = book.addWorksheet('Deep Work Data', {
    // Frozen below the header, so the columns stay named however far down
    // three and a half years you scroll.
    views: [{ state: 'frozen', ySplit: 1 }]
  })

  sheet.columns = COLUMNS.map((column) => ({ header: column.header, width: column.width }))
  const head = sheet.getRow(1)
  head.font = { bold: true }
  head.alignment = { vertical: 'middle', wrapText: true }

  for (const row of rows) {
    const { start, end } = countdown(row)
    const running = Math.max(0, Math.round(row.running_duration_s ?? 0))
    const line = sheet.addRow([
      dateCell(row.session_date),
      row.project ?? null,
      row.task ?? null,
      start / SECONDS_PER_DAY,
      end / SECONDS_PER_DAY,
      running / 3600,
      workDone(row),
      null,
      row.notes ?? null,
      null
    ])

    line.getCell(1).numFmt = 'm/d/yy'
    // Elapsed time, not time of day: see the file comment.
    line.getCell(4).numFmt = '[h]:mm:ss'
    line.getCell(5).numFmt = '[h]:mm:ss'
    line.getCell(6).numFmt = '0.00'

    const rate = efficiency(row, running)
    if (rate !== null) line.getCell(8).value = rate
    else if (row.unquantifiable) line.getCell(8).value = { error: '#N/A' }

    line.getCell(3).alignment = { wrapText: false }
    line.getCell(9).alignment = { wrapText: false }
  }

  // An auto-filter over the whole table, which is what makes a sheet this long
  // usable without writing a formula: sort by project, filter to one course.
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: COLUMNS.length }
  }

  return book
}

/** Writes the workbook to `filePath`. Throws; the caller reports. */
export async function writeExcel(filePath: string): Promise<number> {
  const rows = sheetRows()
  const book = buildWorkbook(rows)
  await book.xlsx.writeFile(filePath)
  return rows.length
}

/** `deep-work-2026-11-08.xlsx`, the name the save dialog opens with. */
export function suggestedName(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `deep-work-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.xlsx`
}
