import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { derive, markFreshness, withIncrements } from '../statsSampler'

/** Minimal stand-in: jsdom has no RTCPeerConnection. */
class FakePeerConnection extends EventTarget {
  constructor() {
    super()
    this.connectionState = 'new'
    this.receivers = []
  }
  getReceivers() {
    return this.receivers
  }
  close() {
    this.connectionState = 'closed'
    this.dispatchEvent(new Event('connectionstatechange'))
  }
}

/**
 * The capture hook mutates a global and guards against installing twice, so
 * each test needs a fresh module instance. `vi.resetModules()` clears the
 * registry; a variable query string on the import does not work under Vite.
 */
async function freshCapture() {
  vi.resetModules()
  const module = await import('../peerConnections.js')
  module.installCapture()
  return module
}

describe('peer connection capture', () => {
  let original

  beforeEach(() => {
    original = window.RTCPeerConnection
    window.RTCPeerConnection = FakePeerConnection
  })

  afterEach(() => {
    window.RTCPeerConnection = original
  })

  it('captures connections the app constructs without the app knowing', async () => {
    const { activeConnection } = await freshCapture()
    expect(activeConnection()).toBeNull()

    const pc = new window.RTCPeerConnection()
    expect(activeConnection()).toBe(pc)
  })

  it('keeps instanceof working, so app code is unaffected', async () => {
    await freshCapture()
    const pc = new window.RTCPeerConnection()
    expect(pc).toBeInstanceOf(FakePeerConnection)
  })

  it('forgets a connection once it closes', async () => {
    const { activeConnection } = await freshCapture()
    const pc = new window.RTCPeerConnection()
    pc.close()
    expect(activeConnection()).toBeNull()
  })

  it('treats the newest open connection as current, for reconnects', async () => {
    const { activeConnection } = await freshCapture()
    const first = new window.RTCPeerConnection()
    const second = new window.RTCPeerConnection()
    expect(activeConnection()).toBe(second)
    second.close()
    expect(activeConnection()).toBe(first)
  })

  it('does not install twice over itself', async () => {
    const module = await freshCapture()
    const afterFirst = window.RTCPeerConnection
    module.installCapture()
    expect(window.RTCPeerConnection).toBe(afterFirst)
  })
})

describe('markFreshness', () => {
  it('flags a sample repeating the cached report timestamp', () => {
    const previous = { statsTimestamp: 1000 }
    expect(markFreshness({ statsTimestamp: 1000, fresh: true }, previous).fresh).toBe(false)
    expect(markFreshness({ statsTimestamp: 1050, fresh: true }, previous).fresh).toBe(true)
  })

  it('leaves the first sample fresh', () => {
    expect(markFreshness({ statsTimestamp: 1000, fresh: true }, null).fresh).toBe(true)
  })
})

/** Build a fresh sample with sane defaults, overridable per field. */
const row = (t, overrides = {}) => ({
  t,
  statsTimestamp: 1000 + t,
  fresh: true,
  packetsReceived: 0,
  packetsLost: 0,
  packetsDiscarded: 0,
  jitter: 0.001,
  concealedSamples: 0,
  silentConcealedSamples: 0,
  concealmentEvents: 0,
  totalSamplesReceived: 0,
  jitterBufferDelay: 0,
  jitterBufferEmittedCount: 0,
  jitterBufferTargetDelay: null,
  insertedSamplesForDeceleration: 0,
  removedSamplesForAcceleration: 0,
  rttMs: null,
  ...overrides,
})

describe('derive', () => {
  it('refuses a trial with fewer than two fresh samples', () => {
    expect(derive([row(0)]).usable).toBe(false)
    const duplicated = [row(0), markFreshness(row(50, { statsTimestamp: 1000 }), row(0))]
    expect(derive(duplicated).usable).toBe(false)
  })

  it('voids a trial where playout never advanced', () => {
    // Packets arrive but nothing is played out — the exact silent-failure case.
    const samples = [
      row(0, { packetsReceived: 0 }),
      row(1000, { packetsReceived: 50, totalSamplesReceived: 0, jitterBufferEmittedCount: 0 }),
    ]
    const result = derive(samples)
    expect(result.usable).toBe(false)
    expect(result.reason).toMatch(/playout/i)
  })

  it('computes achieved delay from the delta ratio, not the raw counter', () => {
    const samples = [
      row(0, { jitterBufferDelay: 10, jitterBufferEmittedCount: 1000, totalSamplesReceived: 1000 }),
      row(1000, {
        jitterBufferDelay: 14.8,
        jitterBufferEmittedCount: 49000,
        totalSamplesReceived: 49000,
      }),
    ]
    // (14.8 - 10) / (49000 - 1000) * 1000 = 0.1 ms
    expect(derive(samples).achievedJitterBufferDelayMs).toBeCloseTo(0.1, 3)
  })

  it('computes concealment and loss as proportions of their own denominators', () => {
    const samples = [
      row(0, { totalSamplesReceived: 1000, concealedSamples: 0, packetsReceived: 10 }),
      row(1000, {
        totalSamplesReceived: 49000,
        concealedSamples: 480,
        jitterBufferEmittedCount: 48000,
        packetsReceived: 1000,
        packetsLost: 10,
      }),
    ]
    const result = derive(samples)
    expect(result.usable).toBe(true)
    expect(result.concealmentProportion).toBeCloseTo(480 / 48000, 6)
    expect(result.lossFraction).toBeCloseTo(10 / (10 + 990), 6)
  })

  it('reports a missing counter as null rather than zero', () => {
    const samples = [
      row(0, { concealedSamples: null, totalSamplesReceived: 1000 }),
      row(1000, {
        concealedSamples: null,
        totalSamplesReceived: 49000,
        jitterBufferEmittedCount: 48000,
      }),
    ]
    const result = derive(samples)
    expect(result.usable).toBe(true)
    expect(result.concealmentProportion).toBeNull()
  })

  it('counts duplicate samples separately from fresh ones', () => {
    const first = row(0, { totalSamplesReceived: 1000 })
    const duplicate = markFreshness(row(20, { statsTimestamp: first.statsTimestamp }), first)
    const last = row(1000, { totalSamplesReceived: 49000, jitterBufferEmittedCount: 48000 })
    const result = derive([first, duplicate, last])
    expect(result.freshSamples).toBe(2)
    expect(result.duplicateSamples).toBe(1)
  })
})

describe('withIncrements', () => {
  it('leaves increments null on the first sample and on duplicates', () => {
    const first = row(0, { totalSamplesReceived: 1000 })
    const duplicate = markFreshness(row(20, { statsTimestamp: first.statsTimestamp }), first)
    const rows = withIncrements([first, duplicate])
    expect(rows[0].incAchievedDelayMs).toBeNull()
    expect(rows[1].incAchievedDelayMs).toBeNull()
  })

  it('computes increments between consecutive fresh samples only', () => {
    const samples = [
      row(0, { jitterBufferDelay: 0, jitterBufferEmittedCount: 0 }),
      row(50, { jitterBufferDelay: 0.24, jitterBufferEmittedCount: 2400 }),
    ]
    const rows = withIncrements(samples)
    expect(rows[1].incAchievedDelayMs).toBeCloseTo(0.1, 3)
  })
})

describe('local signalling rewrite', () => {
  it('downgrades wss to ws for private and loopback addresses', async () => {
    vi.resetModules()
    const { rewriteSignallingUrl } = await import('../localSignalling.js')
    const hosts = [
      '192.168.88.4:8080',
      '10.1.2.3:8080',
      '172.16.0.9',
      '127.0.0.1:8080',
      'localhost:8080',
    ]
    const schemes = hosts.map(
      (host) => new URL(rewriteSignallingUrl(`wss://${host}/api/webrtc/ws`).url).protocol,
    )
    expect(schemes).toEqual(hosts.map(() => 'ws:'))
  })

  it('never downgrades a public host', async () => {
    vi.resetModules()
    const { rewriteSignallingUrl } = await import('../localSignalling.js')
    const { url } = rewriteSignallingUrl('wss://pttox.example.com/api/webrtc/ws')
    expect(url).toBe('wss://pttox.example.com/api/webrtc/ws')
  })

  it('does not treat 172.32 or 192.167 as private', async () => {
    vi.resetModules()
    const { isLocalHost } = await import('../localSignalling.js')
    expect(isLocalHost('172.16.0.1')).toBe(true)
    expect(isLocalHost('172.31.255.254')).toBe(true)
    expect(isLocalHost('172.32.0.1')).toBe(false)
    expect(isLocalHost('192.167.1.1')).toBe(false)
    expect(isLocalHost('8.8.8.8')).toBe(false)
  })

  it('collapses a duplicated signalling path from a pasted full URL', async () => {
    vi.resetModules()
    const { rewriteSignallingUrl } = await import('../localSignalling.js')
    // What the client builds when the operator pastes the whole URL as the host.
    const { url, notes } = rewriteSignallingUrl(
      'wss://192.168.88.4:8080/api/webrtc/ws/api/webrtc/ws',
    )
    expect(url).toBe('ws://192.168.88.4:8080/api/webrtc/ws')
    expect(notes.join(' ')).toMatch(/collapsed/)
  })

  it('never upgrades ws to wss', async () => {
    vi.resetModules()
    const { rewriteSignallingUrl } = await import('../localSignalling.js')
    const { url } = rewriteSignallingUrl('ws://192.168.88.4:8080/api/webrtc/ws')
    expect(url.startsWith('ws://')).toBe(true)
  })

  it('leaves an unparseable value alone instead of throwing', async () => {
    vi.resetModules()
    const { rewriteSignallingUrl } = await import('../localSignalling.js')
    expect(rewriteSignallingUrl('not a url').url).toBe('not a url')
  })
})
