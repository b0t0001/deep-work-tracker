import beepNormal from '../assets/sounds/BeepNormal.wav'
import beepQuiet from '../assets/sounds/BeepQuiet.wav'

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

function load(src: string, volume: number): HTMLAudioElement {
  const audio = new Audio(src)
  audio.volume = volume
  audio.preload = 'auto'
  return audio
}

const expiry = load(beepNormal, 1)
const pace = load(beepQuiet, 1)

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
  pace.load()
}

export function expiryCue(): void {
  play(expiry)
}

export function paceCue(): void {
  play(pace)
}
