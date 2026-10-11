/**
 * One row per trial, exported as CSV.
 *
 * Column order is fixed by the shared contract — the analysis scripts and the
 * report both key off it, so add at the end rather than inserting.
 *
 * An empty cell is genuinely missing, never zero: a trial that timed out has
 * no `tGrant`, which is not the same as a grant at time zero.
 */

export const CSV_COLUMNS = [
  'runId',
  'label',
  'seed',
  'trialIndex',
  'warmup',
  'transport',
  'reqId',
  'tPress',
  'tFirstSend',
  'tGrant',
  'accessMs',
  'sends',
  'outcome',
  'denyReason',
  'dupReplies',
  'lateReplies',
  'serverRecvMs',
  'serverSendMs',
  'serverProcMs',
  'tReleaseSend',
  'tReleaseAck',
  'releaseSends',
  'releaseOutcome',
  'retryMs',
  'timeoutMs',
  'intervalMs',
  'holdMs',
  'visibility',
  'userAgent',
  'wallClockIso',
]

/** Microsecond resolution is already more than `performance.now()` provides. */
function ms(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(3)) : null
}

/**
 * Flatten a finished trial into its CSV row.
 *
 * @param {object} trial
 * @param {object} trial.run run-level metadata (runId, label, seed, params)
 * @param {object} trial.request settled request record from the controller
 * @param {object} [trial.release] settled release record, if one was sent
 */
export function toRow({ run, index, warmup, request, release }) {
  const tGrant = request.outcome === 'granted' ? request.tReply : null
  const serverProcMs =
    typeof request.serverSendMs === 'number' && typeof request.serverRecvMs === 'number'
      ? request.serverSendMs - request.serverRecvMs
      : null

  return {
    runId: run.runId,
    label: run.label,
    seed: run.seed,
    trialIndex: index,
    warmup: warmup ? 1 : 0,
    transport: request.transport,
    reqId: request.reqId,
    tPress: ms(request.tPress),
    tFirstSend: ms(request.tFirstSend),
    tGrant: ms(tGrant),
    accessMs: tGrant != null ? ms(tGrant - request.tPress) : null,
    sends: request.sends,
    outcome: request.outcome,
    // Only a denial carries one, and a denied trial stays in the output.
    denyReason: request.denyReason || '',
    dupReplies: request.dupReplies,
    lateReplies: request.lateReplies,
    serverRecvMs: ms(request.serverRecvMs),
    serverSendMs: ms(request.serverSendMs),
    serverProcMs: ms(serverProcMs),
    tReleaseSend: ms(release?.tFirstSend ?? null),
    tReleaseAck: ms(release?.outcome === 'acked' ? release.tReply : null),
    releaseSends: release ? release.sends : null,
    releaseOutcome: release ? release.outcome : 'skipped',
    retryMs: request.retryMs,
    timeoutMs: request.timeoutMs,
    intervalMs: run.intervalMs,
    holdMs: run.holdMs,
    visibility: request.visibility,
    userAgent: run.userAgent,
    wallClockIso: new Date().toISOString(),
  }
}

/** RFC 4180 quoting — the user agent string contains commas. */
function cell(value) {
  if (value == null) return ''
  if (typeof value === 'boolean') return value ? '1' : '0'
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows) {
  const lines = rows.map((row) => CSV_COLUMNS.map((column) => cell(row[column])).join(','))
  return [CSV_COLUMNS.join(','), ...lines].join('\n')
}

export function fileName(run) {
  const slug = String(run.label || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  return `floor_${slug || 'run'}_${run.runId}.csv`
}

/** Median of the measured (non-warmup) access times for one transport. */
export function medianAccessMs(rows, transport) {
  const values = rows
    .filter((row) => !row.warmup && row.transport === transport && row.accessMs != null)
    .map((row) => row.accessMs)
    .sort((a, b) => a - b)
  if (!values.length) return null
  const middle = values.length >> 1
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
  return Number(median.toFixed(3))
}

/** `{reason: count}`, so a run's denials can be read without opening the CSV. */
function tally(values) {
  return values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {})
}

/** Per-transport summary shown in the panel and reported in the write-up. */
export function summarise(rows) {
  const transports = [...new Set(rows.map((row) => row.transport))]
  return transports.map((transport) => {
    const measured = rows.filter((row) => !row.warmup && row.transport === transport)
    return {
      transport,
      trials: measured.length,
      granted: measured.filter((row) => row.outcome === 'granted').length,
      denied: measured.filter((row) => row.outcome === 'denied').length,
      denyReasons: tally(measured.filter((row) => row.denyReason).map((row) => row.denyReason)),
      timeout: measured.filter((row) => row.outcome === 'timeout').length,
      medianAccessMs: medianAccessMs(rows, transport),
      maxSends: measured.reduce((most, row) => Math.max(most, row.sends ?? 0), 0),
      retried: measured.filter((row) => (row.sends ?? 0) > 1).length,
      hiddenTrials: measured.filter((row) => row.visibility !== 'visible').length,
    }
  })
}
