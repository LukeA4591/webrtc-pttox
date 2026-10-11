/**
 * Stereo routing for received audio.
 *
 * The server sends a single mixed remote track, so groups cannot be pulled
 * apart in the audio domain — by the time audio reaches us it is already summed.
 * What this module provides is a pan control over the whole stream; the store
 * moves it per transmission using the `calling_group_id` on `new-call`, which
 * reads as per-group routing because PTToX is half-duplex.
 *
 * The limits of that trick are written up in `docs/stereo-routing.md`.
 */

/**
 * How hard a left/right group is pushed, 0..1.
 *
 * Deliberately not 1. A full hard pan is silent in the opposite ear, so an
 * operator running a single earpiece would miss that group entirely. At 0.7 the
 * far ear still carries the traffic, roughly 12 dB down.
 */
export const PAN_BIAS = 0.7

export const PAN_POSITIONS = ['left', 'center', 'right']

/** Segmented-control captions. */
export const PAN_LABELS = { left: 'L', center: 'C', right: 'R' }

/** Spoken/hover names for the same positions. */
export const PAN_NAMES = { left: 'Left ear', center: 'Both ears', right: 'Right ear' }

/** Position id -> StereoPannerNode value. Anything unrecognised centres. */
export function panValue(position) {
  if (position === 'left') return -PAN_BIAS
  if (position === 'right') return PAN_BIAS
  return 0
}

/** Ramp time for a pan move, so switching between calls does not click. */
const RAMP_SECONDS = 0.02

/**
 * Wrap a remote stream in `source -> panner -> destination` and hand back a new
 * stream to feed the `<audio>` element.
 *
 * Playback stays on the element rather than going out of the AudioContext, so
 * volume, mute and `setSinkId` keep working exactly as they did.
 *
 * @param {MediaStream} stream Remote stream from the peer connection
 * @returns {{stream: MediaStream, setPan: (value: number) => void,
 *            resume: () => Promise<void>, close: () => void} | null}
 *          `null` when the browser cannot do it, so callers fall back to the
 *          raw stream rather than losing audio.
 */
export function createStereoRouter(stream) {
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext
  if (!AudioContextClass || !stream) return null

  let context
  try {
    context = new AudioContextClass()
  } catch {
    return null
  }

  // Pre-14.1 Safari has an AudioContext but no stereo panner.
  if (typeof context.createStereoPanner !== 'function') {
    context.close?.()
    return null
  }

  let source
  let panner
  let destination
  try {
    source = context.createMediaStreamSource(stream)
    panner = context.createStereoPanner()
    destination = context.createMediaStreamDestination()
    source.connect(panner)
    panner.connect(destination)
  } catch {
    context.close?.()
    return null
  }

  // Safari only keeps a remote WebRTC stream flowing while it is attached to a
  // media element; without this anchor the graph above reads silence.
  const anchor = createAnchor(stream)

  return {
    stream: destination.stream,

    setPan(value) {
      const clamped = Math.min(1, Math.max(-1, Number(value) || 0))
      try {
        panner.pan.setTargetAtTime(clamped, context.currentTime, RAMP_SECONDS)
      } catch {
        panner.pan.value = clamped
      }
    },

    /** Contexts start suspended under autoplay policy until a user gesture. */
    async resume() {
      if (context.state !== 'suspended') return
      try {
        await context.resume()
      } catch {
        // Still waiting on a gesture; the next one will try again.
      }
    },

    close() {
      if (anchor) {
        anchor.pause()
        anchor.srcObject = null
        anchor.remove()
      }
      try {
        source.disconnect()
        panner.disconnect()
      } catch {
        // Already torn down.
      }
      context.close?.()
    },
  }
}

/** Hidden muted element that keeps the source stream alive on Safari. */
function createAnchor(stream) {
  if (typeof document === 'undefined') return null
  const element = document.createElement('audio')
  element.srcObject = stream
  element.muted = true
  element.autoplay = true
  element.style.display = 'none'
  document.body?.appendChild(element)
  try {
    element.play?.()?.catch?.(() => {})
  } catch {
    // Autoplay refused, or a test environment without media playback.
  }
  return element
}
