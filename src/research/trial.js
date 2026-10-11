/**
 * Trial orchestration: record the received audio and the stats timeline
 * together, then export both plus reproducible metadata.
 *
 * The audio recorded is the **received** stream — what this client played out,
 * not what it transmitted. A MediaRecorder-encoded WebM is a re-encode of the
 * decoded signal, not a bit-exact capture, which is fine for listening and
 * waveform inspection but should be read alongside the counters rather than
 * instead of them.
 */

import { INBOUND_FIELDS, derive, markFreshness, sample, withIncrements } from './statsSampler'
import { readJitterBufferTarget } from './peerConnections'

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  if (typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

function extensionFor(mimeType) {
  if (typeof mimeType !== 'string') return 'webm'
  return mimeType.includes('ogg') ? 'ogg' : 'webm'
}

/**
 * Start a trial. Returns a handle whose `stop()` resolves to the finished trial.
 *
 * @param {object} options
 * @param {RTCPeerConnection} options.pc
 * @param {MediaStream} [options.stream] received stream; omit to skip audio
 * @param {string} options.label
 * @param {number} options.intervalMs
 * @param {object} options.conditions free-form notes (netem settings etc.)
 */
export function startTrial({ pc, stream, label, intervalMs, conditions }) {
  const startedAt = performance.now()
  const samples = []
  let previous = null
  let stopped = false

  const meta = {
    label: label || 'trial',
    startedAtIso: new Date().toISOString(),
    intervalMs,
    requestedJitterBufferTargetMs: readJitterBufferTarget(pc),
    conditions: conditions || '',
    userAgent: navigator.userAgent,
    codec: null,
    selectedCandidatePair: null,
  }

  const timer = setInterval(async () => {
    if (stopped) return
    const row = await sample(pc, startedAt)
    if (!row) return
    markFreshness(row, previous)
    // Capture negotiated codec and ICE pair once, for the metadata block.
    if (!meta.codec && row._codec) meta.codec = row._codec
    if (!meta.selectedCandidatePair && row._pair) meta.selectedCandidatePair = row._pair
    delete row._codec
    delete row._pair
    samples.push(row)
    previous = row
  }, intervalMs)

  // Audio capture of the received stream.
  const mimeType = pickMimeType()
  const chunks = []
  let recorder = null
  if (stream && typeof MediaRecorder !== 'undefined') {
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size) chunks.push(event.data)
      })
      recorder.start(1000)
    } catch {
      recorder = null
    }
  }

  return {
    get sampleCount() {
      return samples.length
    },
    get elapsedMs() {
      return performance.now() - startedAt
    },
    get latest() {
      return samples[samples.length - 1] ?? null
    },

    async stop() {
      if (stopped) return null
      stopped = true
      clearInterval(timer)

      let audioBlob = null
      if (recorder && recorder.state !== 'inactive') {
        // The container header is only finalised on `stop`, so wait for it or
        // the file is truncated and unplayable.
        await new Promise((resolve) => {
          recorder.addEventListener('stop', resolve, { once: true })
          recorder.stop()
        })
        if (chunks.length) {
          audioBlob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
        }
      }

      meta.durationMs = Math.round(performance.now() - startedAt)
      meta.audioMimeType = audioBlob ? audioBlob.type : null
      meta.achievedJitterBufferTargetMs = readJitterBufferTarget(pc)

      const rows = withIncrements(samples)
      return { meta, derived: derive(samples), samples: rows, audioBlob }
    },
  }
}

const CSV_COLUMNS = [
  't',
  'statsTimestamp',
  'fresh',
  ...INBOUND_FIELDS,
  'rttMs',
  'incAchievedDelayMs',
  'incConcealmentProportion',
  'incLossFraction',
]

/** Stats timeline as CSV. Empty cells are genuinely missing, not zero. */
export function statsCsv(trial) {
  const header = CSV_COLUMNS.join(',')
  const lines = trial.samples.map((row) =>
    CSV_COLUMNS.map((column) => {
      const value = row[column]
      if (value == null) return ''
      if (typeof value === 'boolean') return value ? '1' : '0'
      return String(value)
    }).join(','),
  )
  return [header, ...lines].join('\n')
}

/** Metadata plus window-level derived measures. */
export function metaJson(trial) {
  return JSON.stringify({ meta: trial.meta, derived: trial.derived }, null, 2)
}

/** Slug safe for a filename. */
function slug(value) {
  return String(value || 'trial')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

export function fileBaseName(trial) {
  const stamp = trial.meta.startedAtIso.replace(/[:.]/g, '-')
  return `${slug(trial.meta.label)}-${stamp}`
}

export function audioExtension(trial) {
  return extensionFor(trial.meta.audioMimeType)
}

/** Trigger a browser download for one blob. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
