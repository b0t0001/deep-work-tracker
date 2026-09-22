/**
 * Shared so the timer and the settings panel offer the same set.
 *
 * Named after stones rather than colours. The hex values are unchanged, and
 * they are what is stored - renaming one cannot orphan a saved choice.
 */
export const ACCENTS = [
  { name: 'Diamond', value: '#0a84ff' },
  { name: 'Ruby', value: '#d92b4b' },
  { name: 'Sapphire', value: '#7c4dff' },
  { name: 'Turquoise', value: '#14b8a6' },
  { name: 'Jade', value: '#2eb85c' },
  { name: 'Amber', value: '#f28c28' },
  { name: 'Moonstone', value: '#9aa0a6' }
] as const

export const ACCENT_KEY = 'dwt.accent'
export const DEFAULT_ACCENT = ACCENTS[0].value

export function isKnownAccent(value: string | null): value is string {
  return ACCENTS.some((option) => option.value === value)
}
