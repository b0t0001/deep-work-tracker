/**
 * Reader for the Deep Work spreadsheet export.
 *
 * The file's quirks are documented in CLAUDE.md; two matter here. Start and End
 * are countdown readings rather than clock times, so a row's duration is start
 * minus end. And the calendar date is known while the time of day is not.
 */

export interface ImportRow {
  /** YYYY-MM-DD. Time of day is unknowable from a countdown reading. */
  date: string
  project: string
  task: string | null
  plannedS: number
  actualS: number
  quantity: number | null
  unit: string | null
  unquantifiable: boolean
  notes: string | null
}

export interface ImportPreview {
  totalRows: number
  importable: number
  skippedBlank: number
  skippedNoTiming: number
  totalHours: number
  firstDate: string
  lastDate: string
  projects: Array<{ name: string; sessions: number; hours: number }>
  units: Array<{ name: string; rows: number }>
  sample: ImportRow[]
}

/**
 * Three and a half years of free-text labels drifted apart. These are one
 * project spelled several ways, and merging them is the whole reason projects
 * became rows rather than strings.
 */
/**
 * Three and a half years of free-text labels, collapsed to the categories the
 * user actually means. Confirmed with them 2026-09-23.
 *
 * Most of the tail is mechanical: a `Block N:` prefix from the 2023 habit of
 * numbering blocks, a digit stuck to the end with no space (the ordinal
 * stripper only catches ` 1`), and two outright typos. The judgement calls were
 * put to the user rather than guessed:
 *
 * - Entrepreneurship and Startup stay separate. Both are large and mean
 *   different things - coursework against the actual venture.
 * - Every application-shaped project stays distinct. College Apps, Scholarships,
 *   Internship Applications, Officer Apps, Leadership Application and Resume
 *   Building are not one category.
 * - Summer homework is homework, including the Chinese variety.
 * - Tutor joins Job: it is the same paid teaching, and Job already contains a
 *   `Tutor Jocelyn` session. Work does NOT - its tasks are a valedictorian
 *   speech, thank-you cards and an itinerary, which is personal admin rather
 *   than a job, and folding it in would pollute a clean teaching record.
 */
const PROJECT_ALIASES = new Map<string, string>([
  // College applications drifted across four spellings.
  ['college applications', 'College Apps'],
  ['college application', 'College Apps'],
  ['college', 'College Apps'],
  ['applications', 'College Apps'],

  ['study ap', 'Study for APs'],
  ['study aps', 'Study for APs'],
  ['study for ap', 'Study for APs'],

  // Homework, including the summer and per-subject variants.
  ['block 1: hw', 'HW'],
  ['block 2: hw', 'HW'],
  ['hw1', 'HW'],
  ['block 1: chem hw', 'HW'],
  ['block 1: summer hw', 'HW'],
  ['block 2: summer hw', 'HW'],
  ['chinese summer hw', 'HW'],
  ['block 1: chinese summer hw', 'HW'],
  ['block 2: chinese summer hw', 'HW'],

  ['block 1: chinese', 'Chinese'],
  ['block 2: chinese', 'Chinese'],
  ['chinese 1: 三体', 'Chinese'],
  ['block 1: chinese city project', 'Chinese'],
  ['block 2: chinese city project', 'Chinese'],

  ['study', 'Studying'],
  ['block 1: studying', 'Studying'],
  ['block 2: studying', 'Studying'],

  ['officer app', 'Officer Apps'],
  ['officer applications', 'Officer Apps'],
  ['block 1: officer apps', 'Officer Apps'],
  ['block 2: officer apps', 'Officer Apps'],
  ['block 2: usabo officer app', 'Officer Apps'],

  // A digit with no space in front of it escapes the ordinal stripper.
  ['sprocket1', 'Sprocket'],
  ['scholarships1', 'Scholarships'],
  ['internship7', 'Internship'],
  ['internships', 'Internship'],

  ['entpreneurship', 'Entrepreneurship'],
  ['bt', 'Brahma Tech'],
  ['tutor', 'Job'],
  ['practice saxophone', 'Saxophone'],
  ["driver's ed", 'Driving'],
  ["driver's test", 'Driving'],
  ['jpl invention challenge', 'JPL'],
  ['math r&d', 'R&D']
])

/** Minimal RFC 4180 reader: the export contains quoted fields with commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function hmsToSeconds(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** M/D/YY, as the sheet writes it. */
function toIsoDate(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(value.trim())
  if (!match) return null
  return `20${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`
}

/** `HW 2` and `HW` are the same project: the ordinal carries no meaning. */
export function normalizeProject(raw: string): string | null {
  const withoutOrdinal = raw
    .trim()
    .replace(/\s+\d+$/, '')
    .trim()
  if (withoutOrdinal === '' || withoutOrdinal.toUpperCase() === 'N/A') return null
  return PROJECT_ALIASES.get(withoutOrdinal.toLowerCase()) ?? withoutOrdinal
}

/** `questions` and `question` are one unit. */
export function normalizeUnit(raw: string): string {
  const lower = raw.trim().toLowerCase()
  return lower.endsWith('s') && !lower.endsWith('ss') ? lower.slice(0, -1) : lower
}

function parseWorkDone(raw: string): {
  quantity: number | null
  unit: string | null
  unquantifiable: boolean
} {
  const value = raw.trim()
  if (value === '') return { quantity: null, unit: null, unquantifiable: false }
  if (value.toLowerCase() === 'unquantifiable') {
    return { quantity: null, unit: null, unquantifiable: true }
  }
  const match = /^([\d.,]+)\s+(.+)$/.exec(value)
  if (!match) return { quantity: null, unit: null, unquantifiable: false }
  const quantity = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(quantity)) return { quantity: null, unit: null, unquantifiable: false }
  return { quantity, unit: normalizeUnit(match[2]), unquantifiable: false }
}

export function readImportRows(text: string): {
  rows: ImportRow[]
  totalRows: number
  skippedBlank: number
  skippedNoTiming: number
} {
  const table = parseCsv(text)
  if (table.length === 0) {
    return { rows: [], totalRows: 0, skippedBlank: 0, skippedNoTiming: 0 }
  }

  const header = table[0].map((h) => h.trim())
  const col = (name: string): number => header.findIndex((h) => h.startsWith(name))
  const iDate = col('Date')
  const iBlock = col('Block')
  const iTask = col('Tasks')
  const iStart = col('Start')
  const iEnd = col('End')
  const iWork = col('Work Done')
  const iNotes = col('Notes')

  const rows: ImportRow[] = []
  let skippedBlank = 0
  let skippedNoTiming = 0

  for (const raw of table.slice(1)) {
    const cell = (index: number): string => (index >= 0 ? (raw[index] ?? '') : '')
    const date = toIsoDate(cell(iDate))
    const project = normalizeProject(cell(iBlock))
    const start = hmsToSeconds(cell(iStart))
    const end = hmsToSeconds(cell(iEnd))

    if (date === null || project === null) {
      skippedBlank += 1
      continue
    }
    // A blank End means the countdown reached 0:00:00. The sheet leaves it empty
    // when a run went to term and computes the duration from Start alone; its
    // own Total Time column agrees with that on all 19 such rows. Treating a
    // blank End as missing data instead would have discarded them.
    const finish = end ?? 0

    if (start === null || start <= finish) {
      // No Start either: the row records that something happened but not for how
      // long. An absence of timing is not a zero-length session, so it gets no row.
      skippedNoTiming += 1
      continue
    }

    const work = parseWorkDone(cell(iWork))
    const task = cell(iTask).trim()
    const notes = cell(iNotes).trim()

    rows.push({
      date,
      project,
      task: task === '' ? null : task,
      plannedS: start,
      actualS: start - finish,
      quantity: work.quantity,
      unit: work.unit,
      unquantifiable: work.unquantifiable,
      notes: notes === '' ? null : notes
    })
  }

  return { rows, totalRows: table.length - 1, skippedBlank, skippedNoTiming }
}

export function summarize(text: string): ImportPreview {
  const { rows, totalRows, skippedBlank, skippedNoTiming } = readImportRows(text)
  const byProject = new Map<string, { sessions: number; seconds: number }>()
  const byUnit = new Map<string, number>()
  let seconds = 0

  for (const row of rows) {
    seconds += row.actualS
    const project = byProject.get(row.project) ?? { sessions: 0, seconds: 0 }
    project.sessions += 1
    project.seconds += row.actualS
    byProject.set(row.project, project)
    if (row.unit) byUnit.set(row.unit, (byUnit.get(row.unit) ?? 0) + 1)
  }

  const dates = rows.map((r) => r.date).sort()

  return {
    totalRows,
    importable: rows.length,
    skippedBlank,
    skippedNoTiming,
    totalHours: seconds / 3600,
    firstDate: dates[0] ?? '',
    lastDate: dates[dates.length - 1] ?? '',
    projects: [...byProject.entries()]
      .map(([name, v]) => ({ name, sessions: v.sessions, hours: v.seconds / 3600 }))
      .sort((a, b) => b.hours - a.hours),
    units: [...byUnit.entries()]
      .map(([name, rowCount]) => ({ name, rows: rowCount }))
      .sort((a, b) => b.rows - a.rows)
      .slice(0, 12),
    sample: rows.slice(0, 8)
  }
}
