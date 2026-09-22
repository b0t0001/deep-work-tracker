import { useEffect } from 'react'
import { ACCENT_KEY, DEFAULT_ACCENT, isKnownAccent } from '@shared/accents'

/**
 * Keeps a window's accent in step with the rest of the app.
 *
 * Every window shares an origin, so the colour lives in one place and a change
 * reaches the others as a storage event. The dashboard dispatches a synthetic
 * one for itself, since localStorage does not notify the window that wrote it.
 */
export function useAccentSync(): void {
  useEffect(() => {
    const apply = (value: string | null): void => {
      document.documentElement.style.setProperty(
        '--accent',
        isKnownAccent(value) ? value : DEFAULT_ACCENT
      )
    }

    try {
      apply(localStorage.getItem(ACCENT_KEY))
    } catch {
      // Private window or blocked storage; the default accent still applies.
      apply(null)
    }

    const onStorage = (event: StorageEvent): void => {
      if (event.key === ACCENT_KEY) apply(event.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
}
