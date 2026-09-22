import beepNormal from '../assets/sounds/BeepNormal.wav'

/**
 * Hourglass's own cues, extracted from its binary's embedded resources
 * (`BeepNormal` and `BeepQuiet` in Hourglass.Properties.Resources).
 *
 * Using the real files rather than synthesised tones means the loop sounds
 * exactly as it always has, and the two events keep the contrast the spec
 * requires without it having to be tuned by hand: quiet for the pace loop,
 * which fires every few minutes and must not break focus, normal for expiry,
 * which is rare and should not be missed.
 */

let toneContext: AudioContext | null = null

function load(src: string, volume: number): HTMLAudioElement {
  const audio = new Audio(src)
  audio.volume = volume
  audio.preload = 'auto'
  return audio
}

const expiry = load(beepNormal, 1)

function play(audio: HTMLAudioElement): void {
  try {
    // Rewound rather than re-created: a cue arriving while the previous one is
    // still playing should restart it, not overlap with it.
    audio.currentTime = 0
    void audio.play().catch(() => {
      /* no output device, or playback blocked; the visual cue still fires */
    })
  } catch {
    /* same */
  }
}

/**
 * Chromium will not play audio before a user gesture, and expiry arrives long
 * after the last click. Loading on an early interaction means the file is ready
 * and the gesture requirement is already satisfied when the cue is due.
 */
export function primeAudio(): void {
  expiry.load()
  try {
    toneContext ??= new AudioContext()
    if (toneContext.state === 'suspended') void toneContext.resume()
  } catch {
    /* no audio device */
  }
}

export function expiryCue(): void {
  play(expiry)
}

/**
 * A short double tick, synthesised rather than a quieter copy of the beep.
 *
 * The two events mean different things and must never be confused by ear, and
 * the same waveform at a lower volume is exactly the confusable case - in a
 * loud room a quiet beep and a loud one are the same sound. A different timbre
 * and rhythm stay distinct however loud the room is.
 */
export function paceCue(): void {
  try {
    toneContext ??= new AudioContext()
    const ctx = toneContext
    if (ctx.state === 'suspended') void ctx.resume()
    for (const delay of [0, 0.11]) {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'triangle'
      oscillator.frequency.value = 1760
      const start = ctx.currentTime + delay
      // Ramped rather than switched: an instant start or stop is heard as a click.
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.09, start + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.07)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(start)
      oscillator.stop(start + 0.1)
    }
  } catch {
    /* no audio device; the visual cue still fires */
  }
}
