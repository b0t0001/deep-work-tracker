/** Shared so the timer and the settings panel offer the same set. */
export const ACCENTS = [
  { name: 'Blue', value: '#0a84ff' },
  { name: 'Ruby', value: '#d92b4b' },
  { name: 'Purple', value: '#7c4dff' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Green', value: '#2eb85c' },
  { name: 'Orange', value: '#f28c28' },
  { name: 'Graphite', value: '#9aa0a6' }
] as const

export const ACCENT_KEY = 'dwt.accent'
export const DEFAULT_ACCENT = ACCENTS[0].value

export function isKnownAccent(value: string | null): value is string {
  return ACCENTS.some((option) => option.value === value)
}
