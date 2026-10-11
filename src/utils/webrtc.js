/**
 * Low-level PTToX signalling + WebRTC plumbing.
 *
 * This module owns no UI state. It exposes `createConnection`, which opens the
 * signalling WebSocket, negotiates the peer connection and reports everything
 * back through the `on` callback bag. `stores/session.js` turns those callbacks
 * into reactive state for the UI.
 */

export const WebRTCMessageType = {
  NewCandidate: 'candidate',
  NewOffer: 'offer',
  NewAnswer: 'answer',
  NewCall: 'new-call',
  EndCall: 'end-call',
  FloorRequest: 'floor-request',
  FloorRelease: 'floor-release',
  FloorGrant: 'floor-grant',
  FloorDeny: 'floor-deny',
}

/** Participant id sent with floor messages. */
const PARTICIPANT_ID = 'Rock'

const noop = () => {}

/* ─── RQ3 EXPERIMENT SEAM — floor-control transport ─────────────────── begin ─
 *
 * Temporary research code for RQ3 (floor signalling over the WebSocket vs over
 * a WebRTC data channel). It is inert until `src/research/floor` injects a
 * transport, so with the experiment off the floor path below is byte-for-byte
 * the behaviour that shipped: `requestFloor()` / `releaseFloor()` fall through
 * to `send()` on the signalling WebSocket, un-enveloped, exactly as before.
 *
 * Why the seam is here at all: the experiment has to measure the *real* press
 * path, and both the WebSocket and the peer connection live in the closure
 * below where no outside code can reach them.
 *
 * To reverse the experiment, delete:
 *   1. this block,
 *   2. the line marked `RQ3` in `requestFloor()`,
 *   3. the line marked `RQ3` in `releaseFloor()`,
 *   4. the two lines marked `RQ3` inside `createConnection` (one next to
 *      `handleMessage`, one in `teardown`),
 *   5. `src/research/floor/`.
 * Nothing else in `src/` knows the experiment exists. See
 * docs/floor-transport-experiment.md.
 */

/** Injected floor transport, or `null` for normal operation. */
let floorTransport = null

/** The live connection's own floor handler, so replies can be fed back in. */
let floorDelivery = null

/**
 * Route floor requests and releases through `transport` instead of the
 * signalling WebSocket. Pass `null` to restore normal operation.
 *
 * @param {{sendRequest: (body: object) => boolean,
 *          sendRelease: (body: object) => boolean} | null} transport
 */
export function setFloorTransport(transport) {
  floorTransport = transport
}

/**
 * Hand a floor message that arrived somewhere other than the signalling
 * WebSocket (i.e. on a data channel) to the normal application handler, so the
 * microphone gate and the UI react exactly as they do for a WebSocket grant.
 *
 * @param {object} body the un-enveloped floor message, e.g. `{type:'floor-grant'}`
 * @returns {boolean} false when no connection is currently open
 */
export function deliverFloorMessage(body) {
  if (!floorDelivery) return false
  floorDelivery(body)
  return true
}
/* ─── RQ3 EXPERIMENT SEAM ─────────────────────────────────────────────── end ─ */

/**
 * Open a PTToX session against `domain`.
 *
 * @param {object} options
 * @param {string} options.domain Bare host name, e.g. `webrtc.example.co`
 * @param {string} [options.micDeviceId] Preferred input device
 * @param {object} options.on Callback bag; every key is optional
 * @returns {object} Connection handle
 */
export function createConnection({ domain, micDeviceId, on = {} }) {
  const handlers = {
    log: noop,
    status: noop,
    ready: noop,
    remoteStream: noop,
    incomingCall: noop,
    callEnded: noop,
    floorGrant: noop,
    floorDeny: noop,
    closed: noop,
    ...on,
  }

  let peerConnection = null
  let localStream = null
  let websocket = null
  let closedByUs = false

  // Session-scoped floor routing. Both are established by negotiation rather
  // than by any particular call, so transmitting does not require an inbound
  // call to be in progress.
  let ccPort = 0
  let ssrc = null

  // The mic is live from the moment we answer the offer, but PTToX is
  // half-duplex: we stay muted until the server grants us the floor.
  let micEnabled = false

  const url = `wss://${domain}/api/webrtc/ws`
  handlers.status('connecting')
  handlers.log('info', `Connecting to ${domain}`)

  websocket = new WebSocket(url)

  websocket.addEventListener('open', () => {
    handlers.status('connected')
    handlers.log('success', 'Signalling channel open')
  })

  websocket.addEventListener('error', () => {
    handlers.log('error', 'Signalling channel error')
  })

  websocket.addEventListener('close', () => {
    teardown()
    handlers.status('disconnected')
    handlers.log(closedByUs ? 'info' : 'warn', 'Signalling channel closed')
    handlers.closed()
  })

  websocket.addEventListener('message', async (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      handlers.log('error', 'Received malformed signalling message')
      return
    }
    if (!message?.type) return

    try {
      await handleMessage(message)
    } catch (error) {
      handlers.log('error', `Failed handling "${message.type}": ${error.message}`)
    }
  })

  // RQ3: lets the experiment layer feed a floor reply that arrived off-socket
  // into this same handler. See the seam block at the top of this file.
  floorDelivery = (body) => handleMessage(body)

  async function handleMessage(message) {
    switch (message.type) {
      case WebRTCMessageType.NewOffer:
        await receiveOffer(message)
        break

      case WebRTCMessageType.NewCandidate:
        await addRemoteCandidate(message)
        break

      case WebRTCMessageType.NewCall: {
        // A `new-call` means somebody else started transmitting. It is a
        // transient event, not a channel we join — it ends when they stop.
        const call = {
          callId: message.call_id,
          groupId: message.calling_group_id,
          userAlias: message.calling_user_alias,
          userId: message.calling_user_id,
        }
        // The call-control port is the one piece of session-scoped routing the
        // server only ever tells us here, so it outlives the call itself.
        if (message.web_rtc_port) ccPort = message.web_rtc_port
        handlers.incomingCall(call)
        handlers.log('info', `${call.userAlias || 'Someone'} is transmitting`)
        break
      }

      case WebRTCMessageType.EndCall:
        handlers.callEnded(message.call_id)
        handlers.log('info', 'Transmission ended')
        break

      case WebRTCMessageType.FloorGrant:
        setMicEnabled(true)
        handlers.floorGrant(message)
        handlers.log('success', 'Floor granted — you are live')
        break

      case WebRTCMessageType.FloorDeny:
        setMicEnabled(false)
        handlers.floorDeny(message)
        handlers.log('warn', 'Floor denied')
        break

      default:
        handlers.log('info', `Unhandled message type "${message.type}"`)
    }
  }

  async function receiveOffer(offer) {
    peerConnection = new RTCPeerConnection()

    localStream = await getLocalStream(micDeviceId)
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = micEnabled
      peerConnection.addTrack(track, localStream)
    })

    peerConnection.addEventListener('track', (trackEvent) => {
      handlers.remoteStream(trackEvent.streams[0])
    })

    peerConnection.addEventListener('connectionstatechange', () => {
      const state = peerConnection?.connectionState
      handlers.log('info', `Peer connection ${state}`)
      if (state === 'failed' || state === 'disconnected') {
        handlers.status('reconnecting')
      } else if (state === 'connected') {
        handlers.status('connected')
        // The SSRC only appears in stats once media is actually flowing.
        refreshSsrc()
      }
    })

    await peerConnection.setRemoteDescription(offer)
    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)
    send(answer)
    await refreshSsrc()
    handlers.log('success', 'Media session negotiated')
    handlers.ready()
  }

  async function refreshSsrc() {
    ssrc = (await readOutboundSsrc()) ?? ssrc
  }

  async function addRemoteCandidate(message) {
    if (!peerConnection) {
      handlers.log('warn', 'Ignoring ICE candidate before peer connection exists')
      return
    }
    // The server speaks snake_case; RTCIceCandidate wants camelCase. `type` is
    // pulled out purely to drop it from the candidate init.
    // eslint-disable-next-line no-unused-vars
    const { type, sdp_m_line_index, sdp_mid, username_fragment, ...rest } = message
    await peerConnection.addIceCandidate({
      ...rest,
      sdpMLineIndex: sdp_m_line_index,
      sdpMid: sdp_mid,
      usernameFragment: username_fragment,
    })
  }

  async function readOutboundSsrc() {
    if (!peerConnection) return null
    const stats = await peerConnection.getStats()
    let found = null
    stats.forEach((report) => {
      if (report.type === 'outbound-rtp' && report.kind === 'audio') {
        found = report.ssrc
      }
    })
    return found
  }

  function setMicEnabled(enabled) {
    micEnabled = enabled
    // NOTE: the property is `enabled`, not `enable`. The previous spelling was a
    // no-op, which left the mic hot even without the floor.
    localStream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled
    })
  }

  function send(data) {
    if (websocket?.readyState !== WebSocket.OPEN) {
      handlers.log('warn', 'Cannot send — signalling channel is not open')
      return false
    }
    const message = { ...data }
    if (!message.type) message.type = WebRTCMessageType.NewCandidate
    websocket.send(JSON.stringify(message))
    return true
  }

  function teardown() {
    floorDelivery = null // RQ3: see the seam block at the top of this file.
    if (peerConnection) {
      peerConnection.ontrack = null
      peerConnection.close()
      peerConnection = null
    }
    localStream?.getTracks().forEach((track) => track.stop())
    localStream = null
    micEnabled = false
    ccPort = 0
    ssrc = null
  }

  return {
    /**
     * Ask the server for the floor (PTT pressed). Uses session-scoped routing,
     * so this works whether or not anyone else is currently transmitting.
     */
    requestFloor() {
      const body = {
        type: WebRTCMessageType.FloorRequest,
        participant_id: PARTICIPANT_ID,
        ssrc,
        cc_port: ccPort,
      }
      // RQ3: see the seam block at the top of this file.
      if (floorTransport) return floorTransport.sendRequest(body)
      return send(body)
    },

    /** Give the floor back (PTT released). */
    releaseFloor() {
      setMicEnabled(false)
      const body = {
        type: WebRTCMessageType.FloorRelease,
        participant_id: PARTICIPANT_ID,
        ssrc,
        cc_port: ccPort,
      }
      // RQ3: see the seam block at the top of this file.
      if (floorTransport) return floorTransport.sendRelease(body)
      return send(body)
    },

    /** Read transport stats for the network indicator. */
    async readStats() {
      if (!peerConnection) return null
      const stats = await peerConnection.getStats()
      let inbound = null
      let pair = null
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') inbound = report
        if (report.type === 'candidate-pair' && report.state === 'succeeded') pair = report
      })
      if (!inbound && !pair) return null
      return {
        rttMs: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
        jitterMs: inbound?.jitter != null ? inbound.jitter * 1000 : null,
        packetsLost: inbound?.packetsLost ?? null,
        packetsReceived: inbound?.packetsReceived ?? null,
      }
    },

    close() {
      closedByUs = true
      teardown()
      websocket?.close()
    },
  }
}

let sharedStream = null
let sharedStreamDeviceId

/**
 * Get the microphone stream, reusing it unless the requested device changed.
 * @param {string} [deviceId]
 */
export async function getLocalStream(deviceId) {
  if (sharedStream && sharedStreamDeviceId === deviceId) {
    const live = sharedStream.getAudioTracks().some((track) => track.readyState === 'live')
    if (live) return sharedStream
  }

  sharedStream?.getTracks().forEach((track) => track.stop())
  sharedStream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  })
  sharedStreamDeviceId = deviceId
  return sharedStream
}

/** Drop the cached mic stream (used on disconnect/logout). */
export function releaseLocalStream() {
  sharedStream?.getTracks().forEach((track) => track.stop())
  sharedStream = null
  sharedStreamDeviceId = undefined
}

/** `group:PMR-1` -> `PMR-1`; leaves unprefixed values alone. */
export function stripPrefix(value) {
  if (typeof value !== 'string') return ''
  const index = value.indexOf(':')
  return index === -1 ? value : value.slice(index + 1)
}
