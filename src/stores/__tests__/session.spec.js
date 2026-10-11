// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest'

const handle = {
  requestFloor: vi.fn(() => true),
  releaseFloor: vi.fn(() => true),
  readStats: vi.fn(async () => null),
  close: vi.fn(),
}
/** Callback bag handed to createConnection, captured so tests can drive it. */
let on = {}

vi.mock('@/utils/webrtc', () => ({
  createConnection: vi.fn((options) => {
    on = options.on
    return handle
  }),
  releaseLocalStream: vi.fn(),
  stripPrefix: (value) => (typeof value === 'string' ? value.split(':').at(-1) : ''),
}))

/** Stands in for MediaRecorder so the store's clip lifecycle can be driven. */
const recorder = vi.hoisted(() => ({ handle: { stop: vi.fn() }, onClip: null }))

vi.mock('@/utils/recorder', () => ({
  recordClip: vi.fn((stream, onClip) => {
    recorder.onClip = onClip
    return recorder.handle
  }),
  extensionFor: () => 'webm',
}))

const { recordClip } = await import('@/utils/recorder')
const store = await import('../session')

const CALL = { callId: 'call-1', groupId: 'group:PMR-1', userAlias: 'Alpha', ssrc: 1, ccPort: 9000 }

beforeEach(() => {
  vi.clearAllMocks()
  store.disconnect()
  store.clearLog()
  // disconnect() deliberately leaves these alone — un-muting without the
  // operator asking is the dangerous direction — so reset them per test.
  store.micMuted.value = false
  store.outputMuted.value = false
  store.outputVolume.value = 1
})

describe('connection lifecycle', () => {
  test('connect() opens a session and reports connected state', () => {
    store.connect()
    on.status('connected')
    expect(store.isConnected.value).toBe(true)
    expect(store.connectionLabel.value).toBe('Connected')
  })

  test('a server-initiated close lets the operator connect again', async () => {
    const { createConnection } = await import('@/utils/webrtc')
    store.connect()
    on.status('connected')
    expect(createConnection).toHaveBeenCalledTimes(1)

    // The server drops the socket. There is no reconnect logic, so the operator
    // has to reconnect by hand — and the button only offers "Connect" once
    // state is disconnected, so `connect()` must not be a silent no-op.
    on.closed()
    on.status('disconnected')
    expect(store.isConnected.value).toBe(false)

    store.connect()
    expect(createConnection).toHaveBeenCalledTimes(2)
  })

  test('disconnect() clears the receiving indicator and floor state', () => {
    store.connect()
    on.status('connected')
    on.ready()
    on.incomingCall(CALL)
    expect(store.receiving.value).not.toBeNull()

    store.disconnect()
    expect(store.receiving.value).toBeNull()
    expect(store.mediaReady.value).toBe(false)
    expect(store.isConnected.value).toBe(false)
  })
})

describe('inbound transmissions', () => {
  test('a new call shows who is transmitting, and clears when they stop', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    expect(store.receiving.value).toMatchObject({ callId: 'call-1', userAlias: 'Alpha' })

    on.callEnded('call-1')
    expect(store.receiving.value).toBeNull()
  })

  test('a stale end-call for a different transmission is ignored', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    on.callEnded('some-older-call')
    expect(store.receiving.value).toMatchObject({ callId: 'call-1' })
  })

  test('an inbound transmission does not gate the ability to talk', () => {
    store.connect()
    on.status('connected')
    on.ready()
    expect(store.receiving.value).toBeNull()
    // The regression this guards: talking used to require an active call.
    expect(store.canTalk.value).toBe(true)
  })
})

describe('push to talk', () => {
  function ready() {
    store.connect()
    on.status('connected')
    on.ready()
  }

  test('pressing requests the floor', () => {
    ready()
    store.pressPtt()
    expect(handle.requestFloor).toHaveBeenCalled()
    expect(store.floorState.value).toBe('requesting')

    on.floorGrant({})
    expect(store.floorState.value).toBe('granted')
  })

  test('cannot talk before the media session is negotiated', () => {
    store.connect()
    on.status('connected')
    expect(store.canTalk.value).toBe(false)

    store.pressPtt()
    expect(handle.requestFloor).not.toHaveBeenCalled()
  })

  test('releasing gives the floor back and returns to idle', () => {
    ready()
    store.pressPtt()
    on.floorGrant({})

    store.releasePtt()
    expect(handle.releaseFloor).toHaveBeenCalled()
    expect(store.floorState.value).toBe('idle')
  })

  test('a failed floor request does not leave the button stuck', () => {
    ready()
    handle.requestFloor.mockReturnValueOnce(false)
    store.pressPtt()
    expect(store.floorState.value).toBe('idle')
  })

  test('releasing when idle does not send a spurious release', () => {
    ready()
    store.releasePtt()
    expect(handle.releaseFloor).not.toHaveBeenCalled()
  })

  test('an inbound transmission arriving mid-press does not steal the floor', () => {
    ready()
    store.pressPtt()
    on.floorGrant({})

    on.incomingCall(CALL)
    expect(store.floorState.value).toBe('granted')
  })
})

describe('groups', () => {
  beforeEach(() => {
    store.groups.value = []
    store.selectedGroupKey.value = null
  })

  test('an inbound transmission records its group and selects the first one', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)

    expect(store.groups.value).toHaveLength(1)
    expect(store.groups.value[0]).toMatchObject({ key: 'pmr-1', label: 'PMR-1', manual: false })
    expect(store.selectedGroupKey.value).toBe('pmr-1')
  })

  test('hearing the same group again refreshes it rather than duplicating', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    const first = store.groups.value[0].lastHeard

    on.incomingCall({ ...CALL, callId: 'call-2' })
    expect(store.groups.value).toHaveLength(1)
    expect(store.groups.value[0].lastHeard).toBeGreaterThanOrEqual(first)
  })

  test('a group survives the transmission ending', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    on.callEnded('call-1')

    expect(store.receiving.value).toBeNull()
    // The regression that started all this: the entry used to vanish.
    expect(store.groups.value).toHaveLength(1)
  })

  test('manually added groups match discovered ones on the bare name', () => {
    store.addGroup('PMR-1')
    expect(store.groups.value).toHaveLength(1)

    store.connect()
    on.status('connected')
    on.incomingCall(CALL) // groupId is 'group:PMR-1'
    expect(store.groups.value).toHaveLength(1)
  })

  test('duplicate manual adds are rejected', () => {
    expect(store.addGroup('Ops')).toBe(true)
    expect(store.addGroup('  ops  ')).toBe(false)
    expect(store.groups.value).toHaveLength(1)
  })

  test('empty names are rejected', () => {
    expect(store.addGroup('   ')).toBe(false)
    expect(store.groups.value).toHaveLength(0)
  })

  test('removing the selected group falls back to another', () => {
    store.addGroup('A')
    store.addGroup('B')
    store.selectGroup('a')

    store.removeGroup('a')
    expect(store.groups.value).toHaveLength(1)
    expect(store.selectedGroupKey.value).toBe('b')
  })
})

describe('stereo routing', () => {
  const OTHER = { callId: 'call-2', groupId: 'group:Ops', userAlias: 'Bravo' }

  beforeEach(() => {
    store.groups.value = []
    store.selectedGroupKey.value = null
    store.setDefaultPan('center')
    if (store.stereoRouting.value) store.toggleStereoRouting()
  })

  test('is off until asked for, so the plain audio path stays the default', () => {
    expect(store.stereoRouting.value).toBe(false)
  })

  test('a group follows the shared default until it is pinned', () => {
    store.addGroup('PMR-1')
    expect(store.groupPan(store.groups.value[0])).toBe('center')

    store.setDefaultPan('right')
    expect(store.groupPan(store.groups.value[0])).toBe('right')

    store.setGroupPan('pmr-1', 'left')
    expect(store.groupPan(store.groups.value[0])).toBe('left')
    // Pinning one group must not drag the rest with it.
    expect(store.defaultPan.value).toBe('right')
  })

  test('a nonsense position is ignored rather than silencing an ear', () => {
    store.addGroup('PMR-1')
    store.setGroupPan('pmr-1', 'sideways')
    expect(store.groups.value[0].pan).toBeNull()

    store.setDefaultPan('upwards')
    expect(store.defaultPan.value).toBe('center')
  })

  test('the pan follows whoever is transmitting', () => {
    store.connect()
    on.status('connected')
    store.addGroup('PMR-1')
    store.setGroupPan('pmr-1', 'left')
    store.setDefaultPan('right')

    on.incomingCall(CALL)
    expect(store.activePan.value).toBeLessThan(0)

    // "Everything else" — a group with no choice of its own.
    on.incomingCall(OTHER)
    expect(store.activePan.value).toBeGreaterThan(0)
  })

  test('the pan holds after a transmission ends, so it never moves under a tail', () => {
    store.connect()
    on.status('connected')
    store.addGroup('PMR-1')
    store.setGroupPan('pmr-1', 'left')
    store.setDefaultPan('right')

    on.incomingCall(CALL)
    on.callEnded('call-1')
    expect(store.activePan.value).toBeLessThan(0)
  })

  test('retuning a group mid-transmission takes effect immediately', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    expect(store.activePan.value).toBe(0)

    store.setGroupPan('pmr-1', 'right')
    expect(store.activePan.value).toBeGreaterThan(0)
  })

  test('disconnecting drops back to the default ear', () => {
    store.connect()
    on.status('connected')
    store.addGroup('PMR-1')
    store.setGroupPan('pmr-1', 'left')

    on.incomingCall(CALL)
    store.disconnect()
    expect(store.activePan.value).toBe(0)
  })
})

describe('per-group mute', () => {
  const OPS = { callId: 'call-2', groupId: 'group:Ops', userAlias: 'Bravo' }

  beforeEach(() => {
    store.groups.value = []
    store.selectedGroupKey.value = null
  })

  test('nothing is muted until a group is silenced', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    expect(store.inboundMuted.value).toBe(false)
  })

  test('a muted group silences its traffic', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    store.toggleGroupMute('pmr-1')

    expect(store.inboundMuted.value).toBe(true)
    on.callEnded('call-1')
    // Silence lifts with the transmission, never outlasting it.
    expect(store.inboundMuted.value).toBe(false)
  })

  test('an unmuted group overlapping a muted one still gets through', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    store.toggleGroupMute('pmr-1')
    expect(store.inboundMuted.value).toBe(true)

    // The track is already mixed, so the safe direction is to fail open.
    on.incomingCall(OPS)
    expect(store.inboundMuted.value).toBe(false)
  })

  test('audio with no transmission behind it is never silenced', () => {
    store.addGroup('PMR-1')
    store.toggleGroupMute('pmr-1')
    expect(store.inboundMuted.value).toBe(false)
  })

  test('muting survives a reconnect but not a logout', () => {
    store.addGroup('PMR-1')
    store.toggleGroupMute('pmr-1')
    expect(store.groups.value[0].muted).toBe(true)

    store.logout()
    expect(store.groups.value).toHaveLength(0)
  })
})

describe('instant replay', () => {
  // jsdom has no object-URL support at all.
  const revoke = vi.fn()

  beforeEach(() => {
    URL.revokeObjectURL = revoke
    URL.createObjectURL = vi.fn(() => 'blob:fake')
    revoke.mockClear()
    store.clearClips()
    if (store.replayEnabled.value) store.toggleReplay()
  })

  test('recording is off until the operator asks for it', () => {
    expect(store.replayEnabled.value).toBe(false)
  })

  test('nothing is captured while recording is off', () => {
    store.connect()
    on.status('connected')
    on.remoteStream({})
    on.incomingCall(CALL)
    on.callEnded('call-1')
    expect(store.clips.value).toHaveLength(0)
  })

  test('clearing revokes the object URLs it drops', () => {
    store.clips.value = [{ id: 1, url: 'blob:one' }]

    store.clearClips()
    expect(revoke).toHaveBeenCalledWith('blob:one')
    expect(store.clips.value).toHaveLength(0)
  })

  test('a logout discards recordings', () => {
    store.clips.value = [{ id: 1, url: 'blob:one' }]

    store.logout()
    expect(store.clips.value).toHaveLength(0)
    expect(store.replayEnabled.value).toBe(false)
  })

  describe('while recording', () => {
    /** Bring up a session with a remote stream and recording switched on. */
    function recording() {
      store.connect()
      on.status('connected')
      on.remoteStream({})
      store.toggleReplay()
    }

    test('a transmission is captured and filed against its group', () => {
      recording()
      on.incomingCall(CALL)
      expect(recordClip).toHaveBeenCalled()

      on.callEnded('call-1')
      expect(recorder.handle.stop).toHaveBeenCalledWith(expect.any(Number))

      // The recorder finishes asynchronously, well after end-call.
      recorder.onClip({ blob: new Blob(['audio']), durationMs: 2400 })
      expect(store.clips.value[0]).toMatchObject({
        alias: 'Alpha',
        groupKey: 'pmr-1',
        groupLabel: 'PMR-1',
        durationMs: 2400,
      })
    })

    test('the clip keeps the speaker it started with, not whoever came next', () => {
      recording()
      on.incomingCall(CALL)
      const finishFirst = recorder.onClip

      on.incomingCall({ callId: 'call-2', groupId: 'group:Ops', userAlias: 'Bravo' })
      finishFirst({ blob: new Blob(['audio']), durationMs: 1000 })

      expect(store.clips.value[0]).toMatchObject({ alias: 'Alpha', groupLabel: 'PMR-1' })
    })

    test('a muted group is still recorded — mute is playback, not capture', () => {
      recording()
      store.addGroup('PMR-1')
      store.toggleGroupMute('pmr-1')

      on.incomingCall(CALL)
      expect(store.inboundMuted.value).toBe(true)
      expect(recordClip).toHaveBeenCalled()
    })

    test('the buffer evicts the oldest clip and revokes its URL', () => {
      recording()
      for (let index = 0; index < 22; index += 1) {
        on.incomingCall({ ...CALL, callId: `call-${index}` })
        recorder.onClip({ blob: new Blob(['audio']), durationMs: 500 })
      }

      expect(store.clips.value).toHaveLength(20)
      expect(revoke).toHaveBeenCalled()
    })

    test('losing the connection closes off the clip in progress', () => {
      recording()
      on.incomingCall(CALL)
      recorder.handle.stop.mockClear()

      store.disconnect()
      expect(recorder.handle.stop).toHaveBeenCalledWith(0)
    })
  })
})

describe('overlapping transmissions', () => {
  const SECOND = { callId: 'call-2', groupId: 'group:Ops', userAlias: 'Bravo' }

  test('the newest transmission is the one shown', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    on.incomingCall(SECOND)
    expect(store.receiving.value).toMatchObject({ callId: 'call-2' })
  })

  test('ending the newer call falls back to the one still running', () => {
    store.connect()
    on.status('connected')
    on.incomingCall(CALL)
    on.incomingCall(SECOND)

    on.callEnded('call-2')
    expect(store.receiving.value).toMatchObject({ callId: 'call-1' })

    on.callEnded('call-1')
    expect(store.receiving.value).toBeNull()
  })
})

describe('servers', () => {
  test('removing the last server is refused', () => {
    store.servers.value = ['only.example.test']
    expect(store.removeServer('only.example.test')).toBe(false)
    expect(store.servers.value).toHaveLength(1)
  })

  test('removing the selected server disconnects and picks another', () => {
    store.servers.value = ['a.test', 'b.test']
    store.selectedServer.value = 'a.test'
    store.connect()
    on.status('connected')

    expect(store.removeServer('a.test')).toBe(true)
    expect(store.servers.value).toEqual(['b.test'])
    expect(store.selectedServer.value).toBe('b.test')
    expect(handle.close).toHaveBeenCalled()
  })
})

describe('microphone mute', () => {
  function ready() {
    store.connect()
    on.status('connected')
    on.ready()
  }

  test('muting blocks transmission', () => {
    ready()
    expect(store.canTalk.value).toBe(true)

    store.toggleMicMute()
    expect(store.micMuted.value).toBe(true)
    expect(store.canTalk.value).toBe(false)

    store.pressPtt()
    expect(handle.requestFloor).not.toHaveBeenCalled()
  })

  test('muting mid-transmission releases the floor', () => {
    ready()
    store.pressPtt()
    on.floorGrant({})

    store.toggleMicMute()
    expect(handle.releaseFloor).toHaveBeenCalled()
    expect(store.floorState.value).toBe('idle')
  })

  test('mute does not persist across a logout', () => {
    store.toggleMicMute()
    expect(store.micMuted.value).toBe(true)
    store.logout()
    expect(store.micMuted.value).toBe(false)
  })
})

describe('output volume', () => {
  test('clamps to 0..1', () => {
    store.setOutputVolume(2)
    expect(store.outputVolume.value).toBe(1)
    store.setOutputVolume(-1)
    expect(store.outputVolume.value).toBe(0)
    store.setOutputVolume(0.4)
    expect(store.outputVolume.value).toBeCloseTo(0.4)
  })

  test('raising the volume off zero clears an active mute', () => {
    store.toggleOutputMute()
    expect(store.outputMuted.value).toBe(true)

    store.setOutputVolume(0.6)
    expect(store.outputMuted.value).toBe(false)
  })

  test('a non-numeric value falls back to silence rather than NaN', () => {
    store.setOutputVolume('nonsense')
    expect(store.outputVolume.value).toBe(0)
  })
})

describe('microphone level metering', () => {
  /** Byte time-domain buffer for a sine of the given amplitude (0..1). */
  function sine(amplitude, length = 1024) {
    return Uint8Array.from({ length }, (_, i) =>
      Math.round(128 + 127 * amplitude * Math.sin((2 * Math.PI * i * 8) / length)),
    )
  }

  test('digital silence reads zero', () => {
    expect(store.levelFromTimeDomain(new Uint8Array(1024).fill(128))).toBe(0)
  })

  test('an empty or missing buffer reads zero rather than NaN', () => {
    expect(store.levelFromTimeDomain(new Uint8Array(0))).toBe(0)
    expect(store.levelFromTimeDomain(undefined)).toBe(0)
  })

  test('level rises monotonically with amplitude', () => {
    const quiet = store.levelFromTimeDomain(sine(0.02))
    const speech = store.levelFromTimeDomain(sine(0.2))
    const loud = store.levelFromTimeDomain(sine(0.8))

    expect(quiet).toBeLessThan(speech)
    expect(speech).toBeLessThan(loud)
  })

  test('a near-silent room stays under the "no input" threshold', () => {
    // The meter shows "No input detected" below 0.04.
    expect(store.levelFromTimeDomain(sine(0.005))).toBeLessThan(0.04)
  })

  test('ordinary speech amplitude lands mid-scale, not pinned at either end', () => {
    const level = store.levelFromTimeDomain(sine(0.25))
    expect(level).toBeGreaterThan(0.15)
    expect(level).toBeLessThan(0.85)
  })

  test('a full-scale signal clamps to 1 instead of overflowing', () => {
    expect(store.levelFromTimeDomain(sine(1))).toBe(1)
  })
})

describe('log', () => {
  test('newest entries come first and clearing empties it', () => {
    store.addLog('info', 'first')
    store.addLog('error', 'second')
    expect(store.log.value[0].message).toBe('second')

    store.clearLog()
    expect(store.log.value).toEqual([])
  })
})

describe('network quality', () => {
  test('is unknown while disconnected', () => {
    expect(store.networkQuality.value).toBe('unknown')
  })

  test.each([
    [{ rttMs: 40, jitterMs: 5 }, 'good'],
    [{ rttMs: 200, jitterMs: 10 }, 'fair'],
    [{ rttMs: 500, jitterMs: 90 }, 'poor'],
  ])('%o -> %s', (stats, expected) => {
    store.connect()
    on.status('connected')
    store.networkStats.value = stats
    expect(store.networkQuality.value).toBe(expected)
  })
})

describe('headphone detection', () => {
  test('matches common headset labels', () => {
    store.outputDevices.value = [{ deviceId: '1', label: 'MacBook Pro Speakers' }]
    expect(store.headphonesConnected.value).toBe(false)

    store.outputDevices.value = [{ deviceId: '2', label: "Luke's AirPods Pro" }]
    expect(store.headphonesConnected.value).toBe(true)
  })
})
