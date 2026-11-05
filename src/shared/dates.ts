/**
 * How a stored date is shown to the user.
 *
 * **Display only.** Everything that persists stays ISO `YYYY-MM-DD`:
 * `sessions.session_date`, the backup CSV, what `restore.ts` reads back, and
 * what the importer writes. Those three agree on a format for a reason - a
 * backup is read by code that was not running when it was written - and this
 * file must never be the thing that changes them. If a formatted date reaches
 * a database column or a CSV cell, that is a bug.
 *
 * ISO sorts lexicographically, which is why it is stored; `MM/DD/YYYY` does
 * not, which is why nothing here may be used as a sort key either.
 */

/**
 * `MM/DD/YYYY` - month first, zero-padded, slashes.
 *
 * Asked for as "DD/MM/YYYY" and corrected within the hour: seeing `05/11/2026`
 * for the 5th of November, they read it as May. Their spreadsheet is `M/D/YY`
 * and the native date pickers render `mm/dd/yyyy`, so month-first was what
 * every other date in front of them already said. The ambiguity was visible
 * before it shipped and nobody put it to them, which is the lesson rather
 * than the format.
 */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return ''
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  // Anything that is not a stored date comes back untouched rather than
  // mangled. A caller handing this a timestamp or a free-text cell has a bug,
  // and showing the original makes that visible instead of inventing a date.
  if (!match) return iso
  const [, year, month, day] = match
  return `${month}/${day}/${year}`
}

/**
 * A stored timestamp as a date and a time.
 *
 * `started_at` and `ended_at` are ISO 8601 UTC, so they are converted to local
 * before being shown - a session at 11pm belongs to the day as lived, which is
 * the same reasoning that gives `sessions` its own `session_date` column.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.trim() === '') return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${pad(at.getMonth() + 1)}/${pad(at.getDate())}/${at.getFullYear()}`
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * A range, with the parts that repeat said once.
 *
 * "recorded 03/27/2023 to 11/05/2026" is a mouthful twice over, and a header
 * that reads the same at a glance whatever the range is tells the user
 * nothing. Dropping the shared year is the common case and the one worth
 * shortening.
 */
export function formatDateRange(from: string | null, to: string | null): string {
  const a = formatDate(from)
  const b = formatDate(to)
  if (a === '' || b === '') return a || b
  if (a === b) return a
  const sameYear = from !== null && to !== null && from.slice(0, 4) === to.slice(0, 4)
  return sameYear ? `${a.slice(0, 5)} to ${b}` : `${a} to ${b}`
}
