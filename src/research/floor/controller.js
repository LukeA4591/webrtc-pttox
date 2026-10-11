/**
 * The injected floor transport: envelopes, timing, retry and reply matching.
 *
 * This is the object handed to `setFloorTransport()` in `utils/webrtc.js`, so
 * every floor request the *real* press path makes — the PTT button, the space
 * bar or the driver — goes through here while the experiment is installed.
 *
 * Timing rules (all `performance.now()`, never the 50 ms stats sampler):
 *
 *   tPress      first line of `press()`, immediately before the application's
 *               own press entry point is called
 *   tFirstSend  immediately before the first `send()` for that request
 *   tGrant      first line of the reply handler, before anything else
 *   accessMs    tGrant - tPress        <- the primary measurement
 *
 * Only the reply that settles a request is handed to the application, and only
 * after tGrant is taken. A reply for an already-settled request is counted and
 * dropped: delivering it would open the microphone outside a trial.
 */

import { Kind, makeEnvelope, nextReqId, REQUEST_REPLIES } from './envelope'
import { createTransports, TRANSPORT_IDS } from './transports'
import { deliverFloorMessage, setFloorTransport } from '@/utils/webrtc'

export const DEFAULTS = { retryMs: 100, timeoutMs: 2000 }

/** Outcomes recorded in the CSV. `unsent` means the carrier was not open. */
export const Outcome = {
  Granted: 'granted',
  Denied: 'denied',
  Timeout: 'timeout',
  Acked: 'acked',
  Unsent: 'unsent',
}

export function createController({ log = () => {}, now = () => performance.now() } = {}) {
  const transports = createTransports()
  const unsubscribes = []

  let config = { transport: 'ws', ...DEFAULTS }
  /** In-flight request, or null. */
  let request = null
  /** In-flight release, or null. */
  let release = null
  /** The most recent request record, so late replies have somewhere to land. */
  let lastRequest = null

  function transport() {
    return transports[config.transport] ?? transports.ws
  }

  /* -- sending ------------------------------------------------------------ */

  /**
   * One send attempt plus, for a retrying transport, the resend timer.
   * The resent frame is the identical envelope with the identical reqId, which
   * is what makes the server's idempotency rule observable.
   */
  function startSending(record, kind, body) {
    record.envelope = makeEnvelope(kind, record.reqId, body)
    record.carrier = transport()

    record.tFirstSend = now()
    if (!record.carrier.send(record.envelope)) {
      log('warn', `${config.transport} is not open — request not sent`)
      record.tFirstSend = null
      settle(record, Outcome.Unsent)
      return false
    }
    record.sends = 1

    if (record.carrier.retries) {
      record.retryTimer = setInterval(() => {
        if (record.settled) return
        if (record.carrier.send(record.envelope)) record.sends += 1
      }, config.retryMs)
    }

    record.timeoutTimer = setTimeout(() => settle(record, Outcome.Timeout), config.timeoutMs)
    return true
  }

  function newRecord(kind) {
    return {
      kind,
      reqId: nextReqId(),
      transport: config.transport,
      retryMs: config.retryMs,
      timeoutMs: config.timeoutMs,
      visibility: typeof document === 'undefined' ? '' : document.visibilityState,
      sends: 0,
      dupReplies: 0,
      lateReplies: 0,
      tPress: null,
      tFirstSend: null,
      tReply: null,
      serverRecvMs: null,
      serverSendMs: null,
      denyReason: '',
      settled: false,
      outcome: null,
      envelope: null,
      carrier: null,
      retryTimer: null,
      timeoutTimer: null,
      resolve: null,
    }
  }

  function settle(record, outcome) {
    if (record.settled) return
    record.settled = true
    record.outcome = outcome
    if (record.retryTimer) clearInterval(record.retryTimer)
    if (record.timeoutTimer) clearTimeout(record.timeoutTimer)
    record.retryTimer = null
    record.timeoutTimer = null
    if (record === request) request = null
    if (record === release) release = null
    record.resolve?.(record)
  }

  /* -- receiving ---------------------------------------------------------- */

  /**
   * The server denies a request with a reason — a stale request, or one whose
   * release overtook it on the unordered channel. The field name is read
   * defensively because the envelope contract names the column but not the
   * key: whichever of these the server uses, the reason reaches the CSV.
   */
  function readDenyReason(envelope) {
    const candidates = [
      envelope.denyReason,
      envelope.reason,
      envelope.body?.denyReason,
      envelope.body?.reason,
    ]
    const found = candidates.find((value) => typeof value === 'string' && value)
    return found ?? ''
  }

  function handleEnvelope(envelope) {
    // First line: the reply clock stops here, before any other work.
    const tReply = now()

    const isRequestReply = REQUEST_REPLIES.includes(envelope.kind)
    const pending = isRequestReply ? request : envelope.kind === Kind.ReleaseAck ? release : null

    // `dup: true` says the server answered this reqId before, so our first
    // reply was lost. Counted whether or not it is the one that settles.
    if (envelope.dup) {
      const target = pending?.reqId === envelope.reqId ? pending : (request ?? lastRequest)
      if (target) target.dupReplies += 1
    }

    if (!pending || pending.reqId !== envelope.reqId) {
      // A reply we are no longer waiting for: the matching trial has already
      // closed, or it answers an earlier reqId. A result, not an error.
      const target = request ?? lastRequest
      if (target) target.lateReplies += 1
      return
    }

    pending.tReply = tReply
    if (typeof envelope.serverRecvMs === 'number') pending.serverRecvMs = envelope.serverRecvMs
    if (typeof envelope.serverSendMs === 'number') pending.serverSendMs = envelope.serverSendMs

    const reason = readDenyReason(envelope)
    if (reason) pending.denyReason = reason

    if (isRequestReply) {
      settle(pending, envelope.kind === Kind.Grant ? Outcome.Granted : Outcome.Denied)
      // Now, and only now, let the application react: gate the microphone and
      // move the UI. `body` is the server's normal floor message; fall back to
      // the envelope kind, which uses the same names the app already handles.
      const body =
        envelope.body && typeof envelope.body === 'object' && envelope.body.type
          ? envelope.body
          : { ...(typeof envelope.body === 'object' ? envelope.body : {}), type: envelope.kind }
      deliverFloorMessage(body)
    } else {
      settle(pending, Outcome.Acked)
    }
  }

  /* -- public surface ----------------------------------------------------- */

  const controller = {
    transports,

    /** Called by `utils/webrtc.js` in place of the WebSocket send. */
    sendRequest(body) {
      // A press that did not come from the driver (the real button, the space
      // bar) still has to work while the experiment is installed.
      if (!request) {
        request = newRecord(Kind.Request)
        request.tPress = now()
        request.adHoc = true
      }
      lastRequest = request
      return startSending(request, Kind.Request, body)
    },

    /** Called by `utils/webrtc.js` in place of the WebSocket send. */
    sendRelease(body) {
      if (!release) {
        release = newRecord(Kind.Release)
        release.adHoc = true
      }
      // A release carries the reqId of the request it releases.
      if (lastRequest) release.reqId = lastRequest.reqId
      release.tPress = now()
      return startSending(release, Kind.Release, body)
    },

    configure(next) {
      config = { ...config, ...next }
      return config
    },

    config() {
      return { ...config }
    },

    /**
     * Press through the application's own entry point and wait for the reply.
     *
     * @param {() => void} pressEntryPoint usually `pressPtt` from the store
     * @returns {Promise<object>} the settled request record
     */
    press(pressEntryPoint) {
      const record = newRecord(Kind.Request)
      request = record
      lastRequest = record
      const settled = new Promise((resolve) => {
        record.resolve = resolve
      })
      record.tPress = now()
      pressEntryPoint()
      // A press the app refused (not connected, muted, floor not idle) never
      // reaches `sendRequest`, so nothing would ever settle it.
      if (record.sends === 0 && !record.settled) settle(record, Outcome.Unsent)
      return settled
    },

    /**
     * Release through the application's own entry point and wait for the ack.
     *
     * @param {() => void} releaseEntryPoint usually `releasePtt` from the store
     */
    releaseFloor(releaseEntryPoint) {
      const record = newRecord(Kind.Release)
      release = record
      const settled = new Promise((resolve) => {
        record.resolve = resolve
      })
      releaseEntryPoint()
      if (record.sends === 0 && !record.settled) settle(record, Outcome.Unsent)
      return settled
    },

    /** True when every transport this run needs is open. */
    ready(ids = TRANSPORT_IDS) {
      return ids.every((id) => transports[id]?.isOpen())
    },

    readiness() {
      return Object.fromEntries(TRANSPORT_IDS.map((id) => [id, !!transports[id]?.isOpen()]))
    },

    install() {
      for (const id of TRANSPORT_IDS) {
        unsubscribes.push(transports[id].onMessage(handleEnvelope))
      }
      setFloorTransport(controller)
      log('info', 'Floor transport experiment installed — floor messages are enveloped')
    },

    uninstall() {
      setFloorTransport(null)
      while (unsubscribes.length) unsubscribes.pop()?.()
      if (request) settle(request, Outcome.Unsent)
      if (release) settle(release, Outcome.Unsent)
      log('info', 'Floor transport experiment removed — floor path back to normal')
    },

    /** Test seam: feed an envelope in as if it had arrived on a carrier. */
    _receive: handleEnvelope,
  }

  return controller
}
