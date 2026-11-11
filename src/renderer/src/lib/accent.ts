import { useEffect, useState } from 'react'
import {
  ACCENT_KEY,
  DEFAULT_ACCENT,
  complementAccent,
  isKnownAccent,
  onAccent
} from '@shared/accents'

/**
 * Keeps a window's accent in step with the rest of the app.
 *
 * Every window shares an origin, so the colour lives in one place and a change
 * reaches the others as a storage event. The dashboard dispatches a synthetic
 * one for itself, since localStorage does not notify the window that wrote it.
 */
export function useAccentSync(): string {
  // Returned as well as applied to `--accent`, because an SVG chart needs the
  // value itself: Recharts computes fills and gradient stops in JS, where a
  // `var(--accent)` string is just an unresolvable colour. Returning it from
  // the one hook that already owns the value keeps CLAUDE.md's rule intact -
  // every window reads the same stored accent through here, and no window
  // gets its own copy of the storage logic to drift out of step.
  const [accent, setAccent] = useState<string>(DEFAULT_ACCENT)

  useEffect(() => {
    const apply = (value: string | null): void => {
      const next = isKnownAccent(value) ? value : DEFAULT_ACCENT
      document.documentElement.style.setProperty('--accent', next)
      // Derived here rather than anywhere that needs it, for the same reason
      // the accent itself is: one place sets it, every window reads the same
      // value, and a colour added to ACCENTS cannot arrive without one.
      document.documentElement.style.setProperty('--accent-complement', complementAccent(next))
      // The text colour for a solid accent fill: white or near-black,
      // whichever reads better on this accent (see `onAccent`).
      document.documentElement.style.setProperty('--on-accent', onAccent(next))
      setAccent(next)
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

  return accent
}
