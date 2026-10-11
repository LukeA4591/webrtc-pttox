/**
 * Receive-side `getStats()` sampling and the derived RQ2 measures.
 *
 * Sampling floor: libwebrtc's RTCStatsCollector caches reports for 50 ms, so
 * calls inside that window return the *same report with the same timestamp*.
 * Polling faster buys duplicate rows and extra CPU contention, not resolution.
 * Every sample therefore carries the report's own `statsTimestamp` and a
 * `fresh` flag, so duplication is visible in the data rather than hidden.
 *
 * Counters are cumulative. Nothing here converts a missing field to zero: a
 * counter the browser did not supply stays `null`, because treating it as 0
 * silently manufactures a measurement.
 */

/** Cumulative inbound-audio counters, in CSV column order. */
export const INBOUND_FIELDS = [
  'packetsReceived',
  'packetsLost',
  'packetsDiscarded',
  'jitter',
  'concealedSamples',
  'silentConcealedSamples',
  'concealmentEvents',
  'totalSamplesReceived',
  'jitterBufferDelay',
  'jitterBufferEmittedCount',
  'jitterBufferTargetDelay',
  'insertedSamplesForDeceleration',
  'removedSamplesForAcceleration',
]

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * One reading of the inbound audio stream.
 * @returns {object|null} null when no inbound audio report exists yet
 */
export async function sample(pc, startedAt) {
  if (!pc) return null

  let report
  try {
    report = await pc.getStats()
  } catch {
    return null
  }

  let inbound = null
  let pair = null
  let codec = null
  report.forEach((entry) => {
    if (entry.type === 'inbound-rtp' && entry.kind === 'audio') inbound = entry
    if (entry.type === 'candidate-pair' && entry.state === 'succeeded') pair = entry
    if (entry.type === 'codec') codec = entry
  })
  if (!inbound) return null

  const row = {
    t: Math.round(performance.now() - startedAt),
    statsTimestamp: numberOrNull(inbound.timestamp),
    fresh: true,
  }
  for (const field of INBOUND_FIELDS) row[field] = numberOrNull(inbound[field])

  row.rttMs = pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null
  row._codec = codec
    ? {
        mimeType: codec.mimeType,
        clockRate: codec.clockRate,
        channels: codec.channels,
        sdpFmtpLine: codec.sdpFmtpLine,
      }
    : null
  row._pair = pair
    ? {
        localCandidateId: pair.localCandidateId,
        remoteCandidateId: pair.remoteCandidateId,
        currentRoundTripTime: pair.currentRoundTripTime,
      }
    : null

  return row
}

/** Mark a sample as a cache repeat of the previous one. */
export function markFreshness(row, previous) {
  if (previous && row.statsTimestamp != null && row.statsTimestamp === previous.statsTimestamp) {
    row.fresh = false
  }
  return row
}

/** Mean jitter buffer delay in ms between two samples, or null. */
function achievedDelayMs(from, to) {
  const delay = diff(from, to, 'jitterBufferDelay')
  const emitted = diff(from, to, 'jitterBufferEmittedCount')
  if (delay == null || emitted == null || emitted <= 0) return null
  return (delay / emitted) * 1000
}

/** Concealment as a proportion of played-out samples between two samples. */
function concealmentProportion(from, to) {
  const concealed = diff(from, to, 'concealedSamples')
  const total = diff(from, to, 'totalSamplesReceived')
  if (concealed == null || total == null || total <= 0) return null
  return concealed / total
}

/** Packet loss fraction between two samples. */
function lossFraction(from, to) {
  const lost = diff(from, to, 'packetsLost')
  const received = diff(from, to, 'packetsReceived')
  if (lost == null || received == null) return null
  const denominator = lost + received
  return denominator > 0 ? lost / denominator : null
}

function diff(from, to, field) {
  const a = from?.[field]
  const b = to?.[field]
  if (a == null || b == null) return null
  return b - a
}

/**
 * Window-level measures across a whole trial, from end-minus-start deltas.
 * Uses the first and last samples that actually carry the field.
 */
export function derive(samples) {
  const fresh = samples.filter((row) => row.fresh)
  if (fresh.length < 2) {
    return { usable: false, reason: 'fewer than two fresh samples', samples: samples.length }
  }

  const first = fresh[0]
  const last = fresh[fresh.length - 1]
  const durationS = (last.t - first.t) / 1000

  // If playout never advanced, every jitter-buffer measure is meaningless and
  // the trial must be discarded — surface that rather than reporting zeros.
  const playedOut = diff(first, last, 'totalSamplesReceived')
  const emitted = diff(first, last, 'jitterBufferEmittedCount')
  const playoutAdvanced = playedOut != null && playedOut > 0 && emitted != null && emitted > 0

  return {
    usable: playoutAdvanced,
    reason: playoutAdvanced ? null : 'playout counters did not advance — trial is void',
    samples: samples.length,
    freshSamples: fresh.length,
    duplicateSamples: samples.length - fresh.length,
    durationS: round(durationS, 3),
    achievedJitterBufferDelayMs: round(achievedDelayMs(first, last), 3),
    concealmentProportion: round(concealmentProportion(first, last), 6),
    lossFraction: round(lossFraction(first, last), 6),
    packetsReceived: diff(first, last, 'packetsReceived'),
    packetsLost: diff(first, last, 'packetsLost'),
    packetsDiscarded: diff(first, last, 'packetsDiscarded'),
    concealmentEvents: diff(first, last, 'concealmentEvents'),
    totalSamplesReceived: playedOut,
    meanJitterMs: round(meanOf(fresh, 'jitter') * 1000, 4),
  }
}

/** Per-sample incremental values, so the CSV is directly plottable. */
export function withIncrements(samples) {
  let previousFresh = null
  return samples.map((row) => {
    const incremental =
      row.fresh && previousFresh
        ? {
            incAchievedDelayMs: round(achievedDelayMs(previousFresh, row), 3),
            incConcealmentProportion: round(concealmentProportion(previousFresh, row), 6),
            incLossFraction: round(lossFraction(previousFresh, row), 6),
          }
        : { incAchievedDelayMs: null, incConcealmentProportion: null, incLossFraction: null }
    if (row.fresh) previousFresh = row
    return { ...row, ...incremental }
  })
}

function meanOf(rows, field) {
  const values = rows.map((row) => row[field]).filter((value) => value != null)
  if (!values.length) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function round(value, places) {
  if (value == null || Number.isNaN(value)) return null
  return Number.parseFloat(Number(value).toFixed(places))
}
