import { openDatabase } from './index'

/**
 * Key/value settings that must survive a restart.
 *
 * Most app settings live in a plain object in the main process and reset when
 * the app closes. That is fine for a toggle the user can see and flip again;
 * it is not fine for anything the app acts on unattended, where forgetting the
 * choice means doing the wrong thing silently.
 */
export function getSetting(key: string): string | null {
  const row = openDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  openDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

export function clearSetting(key: string): void {
  openDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(key)
}
