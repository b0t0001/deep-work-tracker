/**
 * Parsing for the editable clock, matching how Hourglass reads what you type.
 *
 * The formats mirror what the clock displays, so what you read is what you can
 * type back: a bare number is minutes, and colons fill in from seconds upward.
 *
 *   90        -> 90 minutes
 *   5:30      -> 5 minutes 30 seconds
 *   1:30:00   -> 1 hour 30 minutes
 */

const MAX_MS = 24 * 60 * 60 * 1000

export function parseDurationMs(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  const parts = trimmed.split(':')
  if (parts.length > 3) return null
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return null

  const numbers = parts.map(Number)
  let ms: number
  if (numbers.length === 1) {
    ms = numbers[0] * 60_000
  } else if (numbers.length === 2) {
    ms = numbers[0] * 60_000 + numbers[1] * 1000
  } else {
    ms = numbers[0] * 3_600_000 + numbers[1] * 60_000 + numbers[2] * 1000
  }

  if (ms < 1000 || ms > MAX_MS) return null
  return ms
}

/** The editable form of a duration: what parseDurationMs would read back. */
export function formatDurationInput(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
