/**
 * In-page automation driver for the RQ3 floor-transport experiment.
 *
 * Started from URL parameters and callable from the console:
 *
 *   ?exp=floor&label=loss5_delay50&trials=500&warmup=20&intervalMs=2000
 *   &holdMs=200&retryMs=100&timeoutMs=2000
 *   &transports=ws,dc-reliable,dc-unreliable&seed=1
 *
 * The driver never short-circuits the application: every trial presses through
 * `pressPtt()` and releases through `releasePtt()`, the same functions the PTT
 * button calls, so the measured path is the real one including the microphone
 * gate and the UI update.
 *
 * It deliberately does *not* start on load. The network impairment has to be
 * applied **after** the connection is up and **before** the first trial, so the
 * driver connects, reports `ready`, and waits for a start signal.
 */

import { ref, shallowRef } from 'vue'
import { canTalk, floorState, micMuted, pressPtt, releasePtt } from '@/stores/session'
import { activeConnection } from '../peerConnections'
import { channelSettings } from './channels'
import { createController, DEFAULTS, Outcome } from './controller'
import { fileName, summarise, toCsv, toRow } from './results'
import { mulberry32, shuffle } from './random'
import { DEFAULT_TRANSPORTS, TRANSPORT_IDS } from './transports'
import { download } from '../trial'

const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, Math.max(0, duration)))

/** Shortest interval that still lets a `floor-deny` settle back to idle. */
const DENY_SETTLE_MS = 1200

/**
 * How long the run's data channel gets to open once the peer connection is up.
 * Past this it is almost certainly a mismatch with the server's
 * `--floor-channels` setting rather than slow negotiation, and no trial should
 * run: every one of them would time out and the file would look like data.
 */
const CHANNEL_OPEN_DEADLINE_MS = 15000

/**
 * How long a reachability probe waits for its reply.
 *
 * The probe runs before the network condition is applied, so there is no
 * legitimate reason for it to be slow. Short on purpose.
 */
const PROBE_TIMEOUT_MS = 1500

/** The data channel transports, as opposed to the WebSocket. */
const DC_IDS = TRANSPORT_IDS.filter((id) => id !== 'ws')

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Read the run configuration out of a query string.
 * @param {string} search e.g. `window.location.search`
 */
export function parseParams(search) {
  const params = new URLSearchParams(search)
  const raw = params.get('transports')
  const requested = (raw || DEFAULT_TRANSPORTS.join(','))
    .split(',')
    .map((id) => id.trim())
    .filter((id) => TRANSPORT_IDS.includes(id))

  // One data channel per connection: the two types share one SCTP association
  // and interfere, so a run that asks for both is rejected rather than quietly
  // measuring the interference instead of the transport.
  const channels = requested.filter((id) => DC_IDS.includes(id))
  const error =
    channels.length > 1
      ? `transports=${raw} asks for ${channels.join(' and ')} on one connection. ` +
        'A run carries the WebSocket plus at most one data channel type; comparing ' +
        'the two takes two runs per condition, each on a fresh connection.'
      : null

  return {
    enabled: params.get('exp') === 'floor',
    error,
    label: params.get('label') || 'unlabelled',
    trials: Math.max(0, integer(params.get('trials'), 100)),
    warmup: Math.max(0, integer(params.get('warmup'), 10)),
    intervalMs: Math.max(1, integer(params.get('intervalMs'), 2000)),
    holdMs: Math.max(0, integer(params.get('holdMs'), 200)),
    retryMs: Math.max(1, integer(params.get('retryMs'), DEFAULTS.retryMs)),
    timeoutMs: Math.max(1, integer(params.get('timeoutMs'), DEFAULTS.timeoutMs)),
    transports: requested.length ? requested : [...DEFAULT_TRANSPORTS],
    seed: integer(params.get('seed'), 1),
  }
}

/**
 * Build the trial order: every warmup trial first, then the measured block,
 * each shuffled with the same seeded generator. Equal counts per transport, so
 * the transports are interleaved and the order is reproducible from `seed`.
 */
export function buildTrialList({ transports, trials, warmup, seed }) {
  const random = mulberry32(seed)
  const block = (count, isWarmup) =>
    shuffle(
      transports.flatMap((transport) =>
        Array.from({ length: count }, () => ({ transport, warmup: isWarmup })),
      ),
      random,
    )
  return [...block(warmup, true), ...block(trials, false)]
}

/**
 * @param {object} [options]
 * @param {(level: string, message: string) => void} [options.log]
 * @param {object} [options.params] run configuration; defaults to the URL's
 * @param {() => boolean} [options.isConnected] peer-connection check; injected
 *   so the channel-open deadline can be tested without real WebRTC
 */
export function createDriver({
  log = () => {},
  params,
  isConnected = () => activeConnection()?.connectionState === 'connected',
  canTransmit = () => canTalk.value,
  pressEntry = pressPtt,
  releaseEntry = releasePtt,
} = {}) {
  const controller = createController({ log })

  const phase = ref('idle')
  const blockedReason = ref('')
  const rows = shallowRef([])
  const progress = ref({ done: 0, total: 0 })
  const readiness = ref({})
  const notes = ref([])
  let config = params ?? parseParams(typeof window === 'undefined' ? '' : window.location.search)
  let run = null
  let stopRequested = false
  let gateTimer = null

  function note(message) {
    notes.value = [...notes.value, message]
    log('info', message)
  }

  /* -- readiness gate ----------------------------------------------------- */

  function connectionReady() {
    return isConnected()
  }

  function checkReady() {
    readiness.value = {
      ...controller.readiness(),
      peerConnection: connectionReady(),
      canTalk: canTransmit(),
    }
    // Only the run's own transports count. A run with no data channel at all
    // (`transports=ws`) needs no channel to be open.
    return (
      config.transports.every((id) => readiness.value[id]) && connectionReady() && canTransmit()
    )
  }

  function block(message) {
    if (gateTimer) clearInterval(gateTimer)
    gateTimer = null
    phase.value = 'blocked'
    blockedReason.value = message
    log('error', message)
  }

  /**
   * One request per configured transport, before anything is impaired, to prove
   * the server is actually listening on each one.
   *
   * This exists because an open channel proves nothing. A negotiated data
   * channel has no handshake: Chrome reports it `open` as soon as SCTP connects,
   * whether or not the peer has a channel on that stream id. Verified in real
   * Chrome — a client on `dc-reliable` (id 100) against a server offering only
   * `floor-unreliable` (id 101) goes open in ~26 ms and then times out every
   * request. Readiness dots alone would let a whole run go to waste.
   *
   * A denial passes: it means the server replied on that transport, which is
   * all the probe is testing.
   */
  async function probe({ gate = false } = {}) {
    // A hand-run probe must never strand the run. Only the automatic one, which
    // happens before the condition is applied, is allowed to block: a failure
    // there is unambiguous, whereas a probe fired under heavy impairment can
    // legitimately lose its reply.
    const previous = phase.value
    phase.value = 'probing'
    for (const id of config.transports) {
      controller.configure({ transport: id, retryMs: config.retryMs, timeoutMs: PROBE_TIMEOUT_MS })
      const request = await controller.press(pressEntry)

      if (request.outcome === Outcome.Granted) {
        await controller.releaseFloor(releaseEntry)
      } else if (request.outcome === Outcome.Denied) {
        // Reachable, but the floor is held elsewhere. Let the client settle.
        await sleep(DENY_SETTLE_MS + 100)
      } else {
        if (floorState.value !== 'idle') await controller.releaseFloor(releaseEntry)
        const message = probeFailureMessage(id, request.outcome)
        if (gate) {
          block(message)
        } else {
          phase.value = previous
          log('warn', `Probe failed but the run is untouched (${previous}): ${message}`)
        }
        return false
      }
      log('info', `${id} probe ok (${request.outcome})`)
    }
    // Self-contained, so `window.__floorExp.probe()` is safe to call by hand:
    // it is the easiest way to put traffic on *both* carriers, which is what
    // the rig's capture needs in order to see TCP and UDP at once.
    phase.value = gate ? 'ready' : previous
    return true
  }

  function probeFailureMessage(id, outcome) {
    const common =
      `${id} reported open but no reply came back within ${PROBE_TIMEOUT_MS} ms ` +
      `(${outcome}), with nothing impaired yet. No trials have run.`
    if (id === 'ws') {
      return (
        `${common} The WebSocket is connected, so the server is probably not ` +
        'handling the experiment envelope on it.'
      )
    }
    return (
      `${common} A negotiated data channel opens as soon as SCTP connects even if ` +
      'the server has no channel on that stream id, so an open dot does not mean ' +
      `agreement. The server was most likely started with a different ` +
      `--floor-channels setting than this run's transports=${config.transports.join(',')}.`
    )
  }

  function waitForReady() {
    if (gateTimer) clearInterval(gateTimer)
    if (config.error) {
      block(config.error)
      return
    }

    phase.value = 'waiting'
    blockedReason.value = ''
    const channel = config.transports.find((id) => DC_IDS.includes(id))
    let connectedAt = null

    gateTimer = setInterval(() => {
      if (checkReady()) {
        clearInterval(gateTimer)
        gateTimer = null
        // Carriers are up; now prove the server answers on each of them.
        probe({ gate: true }).then((ok) => {
          if (ok) log('success', 'Ready — apply the network condition now, then press Start')
        })
        return
      }

      // The channel only has a chance to open once the peer connection is up,
      // so the deadline runs from there and resets if the connection drops.
      if (!connectionReady()) {
        connectedAt = null
        return
      }
      connectedAt ??= performance.now()
      if (!channel) return
      if (performance.now() - connectedAt < CHANNEL_OPEN_DEADLINE_MS) return

      block(
        `${channel} did not open within ${CHANNEL_OPEN_DEADLINE_MS / 1000} s of the peer ` +
          'connection being established. The server was most likely started with a ' +
          'different --floor-channels setting, so its offer carries no matching data ' +
          'section. No trials have run — restart the server for this run and reload.',
      )
    }, 250)
  }

  /* -- the trial loop ----------------------------------------------------- */

  async function runTrial(index, plan) {
    controller.configure({
      transport: plan.transport,
      retryMs: config.retryMs,
      timeoutMs: config.timeoutMs,
    })

    const request = await controller.press(pressEntry)

    let release = null
    if (request.outcome === Outcome.Granted) {
      await sleep(config.holdMs)
      release = await controller.releaseFloor(releaseEntry)
    } else if (request.outcome === Outcome.Timeout) {
      // The grant may have been sent and lost, in which case the server still
      // thinks we hold the floor. Releasing also clears the client's own
      // `requesting` state, which would otherwise refuse every later press.
      release = await controller.releaseFloor(releaseEntry)
    } else if (request.outcome === Outcome.Unsent) {
      note(
        `Trial ${index}: ${plan.transport} refused the press ` +
          `(floorState=${floorState.value}, micMuted=${micMuted.value})`,
      )
      if (floorState.value !== 'idle') release = await controller.releaseFloor(releaseEntry)
    }

    rows.value = [...rows.value, toRow({ run, index, warmup: plan.warmup, request, release })]
    progress.value = { done: index + 1, total: progress.value.total }

    // Pace from the press, not from the reply, so the offered load is the same
    // whatever the access time was.
    await sleep(config.intervalMs - (performance.now() - request.tPress))
  }

  async function start() {
    if (phase.value === 'running' || phase.value === 'probing') return null
    if (phase.value === 'blocked') {
      log('error', `Cannot start: ${blockedReason.value}`)
      return null
    }
    if (!checkReady()) {
      log(
        'error',
        `Not ready — need ${config.transports.join(', ')}, a connected peer and a live microphone`,
      )
      return null
    }

    stopRequested = false
    notes.value = []
    rows.value = []
    run = {
      runId: `${Date.now().toString(36)}`,
      label: config.label,
      seed: config.seed,
      intervalMs: config.intervalMs,
      holdMs: config.holdMs,
      userAgent: navigator.userAgent,
      startedAtIso: new Date().toISOString(),
      channels: channelSettings(),
    }

    const plans = buildTrialList(config)
    progress.value = { done: 0, total: plans.length }
    phase.value = 'running'
    log(
      'info',
      `Run ${run.runId} "${run.label}": ${plans.length} trials ` +
        `(${config.warmup} warmup + ${config.trials} per transport), seed ${config.seed}`,
    )
    if (config.intervalMs < DENY_SETTLE_MS + 300) {
      note(
        `intervalMs=${config.intervalMs} is below ${DENY_SETTLE_MS + 300}; a floor-deny ` +
          `takes ${DENY_SETTLE_MS} ms to settle back to idle and the next press would be refused`,
      )
    }

    for (let index = 0; index < plans.length; index += 1) {
      if (stopRequested) break
      await runTrial(index, plans[index])
    }

    phase.value = stopRequested ? 'stopped' : 'done'
    run.finishedAtIso = new Date().toISOString()
    // A run stopped early still exports the rows it has.
    exportCsv()
    const summary = summarise(rows.value)
    log('success', `Run ${run.runId} ${phase.value} — ${rows.value.length} rows exported`)
    for (const entry of summary) {
      log(
        'info',
        `${entry.transport}: median ${entry.medianAccessMs ?? 'n/a'} ms, ` +
          `${entry.granted} granted / ${entry.timeout} timeout, ` +
          `retried ${entry.retried}, max sends ${entry.maxSends}`,
      )
    }
    return summary
  }

  function stop() {
    stopRequested = true
    phase.value = 'stopping'
  }

  function exportCsv() {
    if (!rows.value.length || !run) return null
    const name = fileName(run)
    download(new Blob([toCsv(rows.value)], { type: 'text/csv' }), name)
    return name
  }

  const driver = {
    phase,
    blockedReason,
    /** Hand-run: generates traffic on every carrier, never blocks the run. */
    probe: () => probe(),
    gateProbe: () => probe({ gate: true }),
    rows,
    progress,
    readiness,
    notes,
    controller,
    config: () => ({ ...config }),
    setConfig(next) {
      config = { ...config, ...next }
      return { ...config }
    },
    checkReady,
    waitForReady,
    start,
    stop,
    exportCsv,
    summary: () => summarise(rows.value),
    install() {
      controller.install()
      waitForReady()
    },
    uninstall() {
      if (gateTimer) clearInterval(gateTimer)
      gateTimer = null
      controller.uninstall()
    },
  }

  return driver
}
