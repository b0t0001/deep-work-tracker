/**
 * Cues synthesised with Web Audio rather than shipped as files.
 *
 * Two events that must never be confused by ear: the pace loop fires every few
 * minutes and has to be hearable without breaking focus, while session expiry
 * is rare and should be unmissable. Synthesising them keeps that contrast under
 * direct control - pitch, length and loudness - with no assets to bundle.
 */

let context: AudioContext | null = null

function audio(): AudioContext {
  context ??= new AudioContext()
  if (context.state === 'suspended') void context.resume()
  return context
}

/**
 * Chromium will not start an AudioContext without a user gesture, and expiry
 * arrives long after the last click. Priming on any early interaction means the
 * context is already running when the cue is due.
 */
export function primeAudio(): void {
  try {
    audio()
  } catch {
    /* no audio device; the visual flash still fires */
  }
}

function tone(frequency: number, delay: number, duration: number, peak: number): void {
  const ctx = audio()
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency

  const start = ctx.currentTime + delay
  // Ramped rather than switched: an instant start or stop is heard as a click.
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.014)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)

  oscillator.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.03)
}

/** One short, quiet, high note. Meant to register without pulling attention. */
export function paceCue(): void {
  try {
    tone(1318, 0, 0.09, 0.05)
  } catch {
    /* no audio device */
  }
}

/** A rising three-note figure: longer, louder, unmistakably not the pace cue. */
export function expiryCue(): void {
  try {
    tone(659, 0, 0.3, 0.16)
    tone(880, 0.17, 0.34, 0.16)
    tone(1318, 0.36, 0.55, 0.13)
  } catch {
    /* no audio device */
  }
}
