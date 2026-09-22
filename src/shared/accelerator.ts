/**
 * Turns a keypress into an Electron accelerator string.
 *
 * Capturing the key is the only sane way to set a shortcut: nobody should have
 * to know that Electron spells it `CommandOrControl+Shift+Space`.
 */
export function acceleratorFromEvent(event: {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): string | null {
  const key = normalizeKey(event)
  if (key === null) return null

  const parts: string[] = []
  // CommandOrControl resolves per platform, so one binding serves both.
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)

  // A bare letter would swallow that key everywhere, in every application.
  if (parts.length === 1 && !/^F\d{1,2}$/.test(key)) return null
  return parts.join('+')
}

function normalizeKey(event: { key: string; code: string }): string | null {
  const { key, code } = event
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(key)) return null

  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (/^F\d{1,2}$/.test(key)) return key
  if (key === ' ' || code === 'Space') return 'Space'

  const named: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
    Enter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  }
  if (named[key]) return named[key]
  if (key.length === 1) return key.toUpperCase()
  return null
}

/** Human-readable form: `Ctrl + Shift + Space`. */
export function describeAccelerator(accelerator: string): string {
  if (!accelerator) return 'Not set'
  return accelerator
    .replace(/CommandOrControl/g, 'Ctrl')
    .split('+')
    .join(' + ')
}
