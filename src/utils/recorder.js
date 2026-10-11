/**
 * Per-transmission recording for instant replay.
 *
 * A recorder is created fresh for every transmission and thrown away when it
 * finishes, so overlapping calls cannot corrupt one another's state and each
 * clip is a complete, independently decodable file. The alternative — one long
 * recording sliced afterwards — produces fragments missing their container
 * header, which only some browsers will play.
 *
 * Limits are written up in `docs/replay.md`.
 */

/** Containers worth trying, best first. Safari only does mp4. */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=opus',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

/**
 * First container this browser can actually produce, or `''` to let the
 * browser choose for itself.
 */
export function pickMimeType(candidates = MIME_CANDIDATES) {
  if (typeof MediaRecorder === 'undefined') return ''
  if (typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

/** Extension matching a recorded blob, for the download filename. */
export function extensionFor(mimeType) {
  if (typeof mimeType !== 'string') return 'webm'
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('ogg')) return 'ogg'
  return 'webm'
}

/**
 * Start recording one transmission.
 *
 * @param {MediaStream} stream Raw remote stream — deliberately not the panned
 *   one, so a recording never bakes in the operator's stereo routing.
 * @param {(clip: {blob: Blob, durationMs: number}) => void} onClip Called once
 *   the clip is complete. Never called for an empty recording.
 * @returns {{stop: (tailMs?: number) => void} | null} `null` when the browser
 *   cannot record, so callers can degrade rather than break.
 */
export function recordClip(stream, onClip) {
  if (!stream || typeof MediaRecorder === 'undefined') return null

  const mimeType = pickMimeType()
  let recorder
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch {
    return null
  }

  const chunks = []
  const startedAt = Date.now()
  let stopTimer = null

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data?.size) chunks.push(event.data)
  })

  recorder.addEventListener('stop', () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
    chunks.length = 0
    if (blob.size) onClip({ blob, durationMs: Date.now() - startedAt })
  })

  try {
    recorder.start()
  } catch {
    return null
  }

  return {
    /**
     * Finish the clip. `tailMs` keeps recording briefly past the end of the
     * transmission so the last syllable is not clipped off.
     */
    stop(tailMs = 0) {
      if (stopTimer) return
      const halt = () => {
        stopTimer = null
        try {
          if (recorder.state !== 'inactive') recorder.stop()
        } catch {
          // Already gone; the stop handler has run or never will.
        }
      }
      if (tailMs > 0) stopTimer = setTimeout(halt, tailMs)
      else halt()
    },
  }
}
