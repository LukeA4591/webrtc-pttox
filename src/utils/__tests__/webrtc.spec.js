// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createConnection, stripPrefix, WebRTCMessageType } from '../webrtc'

/** Minimal WebSocket stand-in that lets tests drive the signalling channel. */
class FakeWebSocket {
  static OPEN = 1
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    this.sent = []
    this.listeners = {}
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, handler) {
    ;(this.listeners[type] ??= []).push(handler)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.emit('close', {})
  }

  emit(type, event) {
    return Promise.all((this.listeners[type] ?? []).map((handler) => handler(event)))
  }

  /** Deliver a signalling message and wait for the async handler to settle. */
  receive(payload) {
    return this.emit('message', { data: JSON.stringify(payload) })
  }
}

let track
let peerConnection

beforeEach(() => {
  FakeWebSocket.instances = []

  track = { kind: 'audio', enabled: true, readyState: 'live', stop: vi.fn() }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }

  peerConnection = {
    listeners: {},
    addTrack: vi.fn(),
    addIceCandidate: vi.fn(),
    setRemoteDescription: vi.fn(),
    setLocalDescription: vi.fn(),
    createAnswer: vi.fn(async () => ({ type: 'answer', sdp: 'fake-sdp' })),
    getStats: vi.fn(
      async () => new Map([['a', { type: 'outbound-rtp', kind: 'audio', ssrc: 4242 }]]),
    ),
    close: vi.fn(),
    addEventListener(type, handler) {
      ;(this.listeners[type] ??= []).push(handler)
    },
  }

  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal(
    'RTCPeerConnection',
    vi.fn(() => peerConnection),
  )
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function connect(on = {}) {
  const connection = createConnection({ domain: 'pttox.test', on })
  return { connection, socket: FakeWebSocket.instances[0] }
}

describe('createConnection', () => {
  test('opens a secure signalling socket for the given domain', () => {
    const { socket } = connect()
    expect(socket.url).toBe('wss://pttox.test/api/webrtc/ws')
  })

  test('answers an SDP offer and sends the answer back', async () => {
    const { socket } = connect()
    await socket.receive({ type: WebRTCMessageType.NewOffer, sdp: 'remote-sdp' })

    expect(peerConnection.setRemoteDescription).toHaveBeenCalled()
    expect(peerConnection.addTrack).toHaveBeenCalledWith(track, expect.anything())
    expect(socket.sent.at(-1)).toMatchObject({ type: 'answer', sdp: 'fake-sdp' })
  })

  test('keeps the microphone muted until the floor is granted', async () => {
    const { socket } = connect()
    await socket.receive({ type: WebRTCMessageType.NewOffer, sdp: 'remote-sdp' })
    expect(track.enabled).toBe(false)

    await socket.receive({ type: WebRTCMessageType.FloorGrant, ssrc: 4242 })
    expect(track.enabled).toBe(true)

    await socket.receive({ type: WebRTCMessageType.FloorDeny, ssrc: 4242 })
    expect(track.enabled).toBe(false)
  })

  test('releasing the floor mutes the microphone immediately', async () => {
    const { connection, socket } = connect()
    await socket.receive({ type: WebRTCMessageType.NewOffer, sdp: 'remote-sdp' })
    await socket.receive({ type: WebRTCMessageType.FloorGrant, ssrc: 4242 })
    expect(track.enabled).toBe(true)

    connection.releaseFloor()
    expect(track.enabled).toBe(false)
    expect(socket.sent.at(-1)).toMatchObject({
      type: WebRTCMessageType.FloorRelease,
      ssrc: 4242,
    })
  })

  test('can request the floor with no inbound call in progress', async () => {
    const { connection, socket } = connect()
    await socket.receive({ type: WebRTCMessageType.NewOffer, sdp: 'remote-sdp' })

    expect(connection.requestFloor()).toBe(true)
    expect(socket.sent.at(-1)).toMatchObject({
      type: WebRTCMessageType.FloorRequest,
      // Read from our own outbound stats at negotiation time, not from a call.
      ssrc: 4242,
    })
  })

  test('reports an inbound transmission without treating it as a channel', async () => {
    const incomingCall = vi.fn()
    const { socket } = connect({ incomingCall })
    await socket.receive({ type: WebRTCMessageType.NewOffer, sdp: 'remote-sdp' })
    await socket.receive({
      type: WebRTCMessageType.NewCall,
      call_id: 'call-1',
      calling_group_id: 'group:PMR-1',
      calling_user_alias: 'Alpha',
      calling_user_id: 'user:7',
      web_rtc_port: 9000,
    })

    expect(incomingCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-1', groupId: 'group:PMR-1', userAlias: 'Alpha' }),
    )
  })

  test('retains the call-control port after the inbound call ends', async () => {
    const { connection, socket } = connect()
    await socket.receive({ type: WebRTCMessageType.NewOffer, sdp: 'remote-sdp' })
    await socket.receive({
      type: WebRTCMessageType.NewCall,
      call_id: 'call-1',
      calling_group_id: 'group:PMR-1',
      web_rtc_port: 9000,
    })
    await socket.receive({ type: WebRTCMessageType.EndCall, call_id: 'call-1' })

    connection.requestFloor()
    expect(socket.sent.at(-1)).toMatchObject({
      type: WebRTCMessageType.FloorRequest,
      cc_port: 9000,
    })
  })

  test('converts snake_case ICE candidate fields to the RTC API shape', async () => {
    const { socket } = connect()
    await socket.receive({ type: WebRTCMessageType.NewOffer, sdp: 'remote-sdp' })
    await socket.receive({
      type: WebRTCMessageType.NewCandidate,
      candidate: 'candidate:1',
      sdp_m_line_index: 0,
      sdp_mid: 'audio',
      username_fragment: 'frag',
    })

    expect(peerConnection.addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ sdpMLineIndex: 0, sdpMid: 'audio', usernameFragment: 'frag' }),
    )
    // The wire-format keys must not leak through.
    const [arg] = peerConnection.addIceCandidate.mock.calls[0]
    expect(arg).not.toHaveProperty('sdp_mid')
    expect(arg).not.toHaveProperty('type')
  })

  test('ignores ICE candidates that arrive before the peer connection exists', async () => {
    const log = vi.fn()
    const { socket } = connect({ log })
    await expect(
      socket.receive({ type: WebRTCMessageType.NewCandidate, candidate: 'early' }),
    ).resolves.not.toThrow()
    expect(peerConnection.addIceCandidate).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('Ignoring ICE candidate'))
  })

  test('survives malformed signalling payloads', async () => {
    const log = vi.fn()
    const { socket } = connect({ log })
    await expect(socket.emit('message', { data: 'not json' })).resolves.not.toThrow()
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('malformed'))
  })

  test('close() tears down the peer connection and stops local tracks', async () => {
    const { connection, socket } = connect()
    await socket.receive({ type: WebRTCMessageType.NewOffer, sdp: 'remote-sdp' })

    connection.close()
    expect(peerConnection.close).toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalled()
  })
})

describe('stripPrefix', () => {
  test.each([
    ['group:PMR-1', 'PMR-1'],
    ['PMR-1', 'PMR-1'],
    [undefined, ''],
  ])('%s -> %s', (input, expected) => {
    expect(stripPrefix(input)).toBe(expected)
  })
})
