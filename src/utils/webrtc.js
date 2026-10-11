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
      return send({
        type: WebRTCMessageType.FloorRequest,
        participant_id: PARTICIPANT_ID,
        ssrc,
        cc_port: ccPort,
      })
    },

    /** Give the floor back (PTT released). */
    releaseFloor() {
      setMicEnabled(false)
      return send({
        type: WebRTCMessageType.FloorRelease,
        participant_id: PARTICIPANT_ID,
        ssrc,
        cc_port: ccPort,
      })
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
