// @vitest-environment jsdom

/**
 * RQ3 floor-transport experiment.
 *
 * The controller is tested against a fake carrier and a fake clock, so the
 * retry, timeout and reply-matching rules are checked without a server. The
 * seam in `utils/webrtc.js` is mocked out here and tested for real in
 * `src/utils/__tests__/webrtc.spec.js`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/webrtc', () => ({
  setFloorTransport: vi.fn(),
  deliverFloorMessage: vi.fn(() => true),
}))

import { deliverFloorMessage } from '@/utils/webrtc'
import { Kind, makeEnvelope, parseEnvelope, nextReqId, resetReqIds } from '../floor/envelope'
import { mulberry32, shuffle } from '../floor/random'
import { createController, Outcome } from '../floor/controller'
import { buildTrialList, createDriver, parseParams } from '../floor/driver'
import { attachFloorChannels, channelSettings, floorChannel } from '../floor/channels'
import { CSV_COLUMNS, medianAccessMs, summarise, toCsv, toRow } from '../floor/results'

describe('envelope', () => {
  beforeEach(() => resetReqIds())

  it('wraps the existing floor message without altering it', () => {
    const body = { type: 'floor-request', participant_id: 'Rock', ssrc: 42, cc_port: 0 }
    expect(makeEnvelope(Kind.Request, 7, body)).toEqual({
      v: 1,
      kind: 'floor-request',
      reqId: 7,
      body,
    })
  })

  it('issues increasing request ids within a session', () => {
    expect([nextReqId(), nextReqId(), nextReqId()]).toEqual([1, 2, 3])
  })

  it('ignores ordinary signalling traffic, so normal messages keep working', () => {
    expect(parseEnvelope(JSON.stringify({ type: 'floor-grant' }))).toBeNull()
    expect(parseEnvelope(JSON.stringify({ type: 'offer', sdp: 'v=0' }))).toBeNull()
  })

  it('rejects malformed, mis-versioned and unidentified frames', () => {
    expect(parseEnvelope('not json')).toBeNull()
    expect(parseEnvelope(JSON.stringify({ v: 2, kind: 'floor-grant', reqId: 1 }))).toBeNull()
    expect(parseEnvelope(JSON.stringify({ v: 1, kind: 'floor-grant' }))).toBeNull()
    expect(parseEnvelope(JSON.stringify({ v: 1, kind: 'floor-grant', reqId: 1.5 }))).toBeNull()
    expect(parseEnvelope(new ArrayBuffer(4))).toBeNull()
  })

  it('accepts a well-formed reply with its server timestamps', () => {
    const raw = JSON.stringify({
      v: 1,
      kind: 'floor-grant',
      reqId: 9,
      serverRecvMs: 5021.337,
      serverSendMs: 5021.902,
      dup: false,
      body: { type: 'floor-grant' },
    })
    expect(parseEnvelope(raw)).toMatchObject({ kind: 'floor-grant', reqId: 9, dup: false })
  })
})

describe('seeded ordering', () => {
  it('reproduces the same order from the same seed', () => {
    const items = [...Array(20).keys()]
    expect(shuffle(items, mulberry32(1))).toEqual(shuffle(items, mulberry32(1)))
  })

  it('produces a different order from a different seed', () => {
    const items = [...Array(20).keys()]
    expect(shuffle(items, mulberry32(1))).not.toEqual(shuffle(items, mulberry32(2)))
  })

  it('is a permutation, never a resample', () => {
    const items = [...Array(20).keys()]
    expect([...shuffle(items, mulberry32(3))].sort((a, b) => a - b)).toEqual(items)
  })
})

describe('trial list', () => {
  // A real run: the WebSocket baseline plus one data channel type.
  const config = { transports: ['ws', 'dc-reliable'], trials: 10, warmup: 2, seed: 1 }

  it('gives every transport the same number of trials', () => {
    const list = buildTrialList(config)
    expect(list).toHaveLength(24)
    for (const transport of config.transports) {
      expect(list.filter((trial) => trial.transport === transport)).toHaveLength(12)
    }
  })

  it('runs all warmup trials before any measured trial', () => {
    const list = buildTrialList(config)
    expect(list.slice(0, 4).every((trial) => trial.warmup)).toBe(true)
    expect(list.slice(4).some((trial) => trial.warmup)).toBe(false)
  })

  it('interleaves the transports rather than running them in blocks', () => {
    const measured = buildTrialList(config).slice(4)
    const firstThird = measured.slice(0, 8).map((trial) => trial.transport)
    expect(new Set(firstThird).size).toBeGreaterThan(1)
  })

  it('is reproducible from the seed', () => {
    expect(buildTrialList(config)).toEqual(buildTrialList(config))
    expect(buildTrialList(config)).not.toEqual(buildTrialList({ ...config, seed: 99 }))
  })
})

describe('URL parameters', () => {
  it('stays off unless exp=floor is present', () => {
    expect(parseParams('').enabled).toBe(false)
    expect(parseParams('?exp=something').enabled).toBe(false)
    expect(parseParams('?exp=floor').enabled).toBe(true)
  })

  it('reads a full run specification', () => {
    const params = parseParams(
      '?exp=floor&label=loss5_delay50&trials=500&warmup=20&intervalMs=2000' +
        '&holdMs=200&retryMs=100&timeoutMs=2000' +
        '&transports=ws,dc-unreliable&seed=7',
    )
    expect(params).toMatchObject({
      enabled: true,
      error: null,
      label: 'loss5_delay50',
      trials: 500,
      warmup: 20,
      intervalMs: 2000,
      holdMs: 200,
      retryMs: 100,
      timeoutMs: 2000,
      transports: ['ws', 'dc-unreliable'],
      seed: 7,
    })
  })

  it('defaults to the WebSocket plus one data channel, never both', () => {
    expect(parseParams('?exp=floor').transports).toEqual(['ws', 'dc-reliable'])
    expect(parseParams('?exp=floor&transports=carrier-pigeon').transports).toEqual([
      'ws',
      'dc-reliable',
    ])
  })

  it('rejects a run asking for both data channel types on one connection', () => {
    const params = parseParams('?exp=floor&transports=ws,dc-reliable,dc-unreliable')
    expect(params.error).toContain('one connection')
    expect(params.error).toContain('two runs per condition')
  })

  it('accepts either data channel type on its own', () => {
    expect(parseParams('?exp=floor&transports=ws,dc-reliable').error).toBeNull()
    expect(parseParams('?exp=floor&transports=ws,dc-unreliable').error).toBeNull()
    expect(parseParams('?exp=floor&transports=dc-unreliable').error).toBeNull()
  })
})

describe('data channels', () => {
  /** jsdom has no WebRTC; only `createDataChannel` is exercised here. */
  class FakePeerConnection {
    constructor() {
      this.created = []
    }
    createDataChannel(label, options) {
      const channel = {
        label,
        ...options,
        readyState: 'connecting',
        binaryType: '',
        listeners: {},
        addEventListener(type, handler) {
          ;(this.listeners[type] ??= []).push(handler)
        },
        open() {
          this.readyState = 'open'
          this.listeners.open?.forEach((handler) => handler())
        },
      }
      this.created.push(channel)
      return channel
    }
  }

  it('creates only the data channel the run asked for', () => {
    const pc = new FakePeerConnection()
    attachFloorChannels(pc, ['ws', 'dc-unreliable'])

    expect(pc.created.map((channel) => channel.label)).toEqual(['floor-unreliable'])
    expect(pc.created[0]).toMatchObject({ negotiated: true, id: 101, ordered: false })
    expect(pc.created[0].maxRetransmits).toBe(0)
    expect(floorChannel('dc-reliable')).toBeNull()
  })

  it('creates the reliable channel with no retransmit limit at all', () => {
    const pc = new FakePeerConnection()
    attachFloorChannels(pc, ['ws', 'dc-reliable'])

    expect(pc.created[0]).toMatchObject({ label: 'floor-reliable', id: 100, ordered: true })
    expect(pc.created[0]).not.toHaveProperty('maxRetransmits')
    expect(pc.created[0]).not.toHaveProperty('maxPacketLifeTime')
  })

  it('refuses to put both types on one connection', () => {
    const pc = new FakePeerConnection()
    attachFloorChannels(pc, ['ws', 'dc-reliable', 'dc-unreliable'])
    // They share one SCTP association and interfere, so neither is created.
    expect(pc.created).toHaveLength(0)
  })

  it('creates nothing for a WebSocket-only run', () => {
    const pc = new FakePeerConnection()
    attachFloorChannels(pc, ['ws'])
    expect(pc.created).toHaveLength(0)
  })

  it('records what was negotiated only once the channel reports open', () => {
    const pc = new FakePeerConnection()
    attachFloorChannels(pc, ['dc-reliable'])
    expect(channelSettings()).toEqual({})

    pc.created[0].open()
    expect(channelSettings()['dc-reliable']).toMatchObject({
      label: 'floor-reliable',
      id: 100,
      ordered: true,
    })
  })
})

describe('readiness gate', () => {
  const params = (overrides) => ({ ...parseParams('?exp=floor'), ...overrides })

  /**
   * A driver whose carriers are all up, with a scriptable reply per transport.
   * `replies` maps a transport id to the kind the fake server answers with, or
   * `null` for silence.
   */
  function readyDriver(replies, overrides = {}) {
    const driver = createDriver({
      params: params({ transports: Object.keys(replies), ...overrides }),
      isConnected: () => true,
      canTransmit: () => true,
      pressEntry: () => driver.controller.sendRequest({ type: 'floor-request' }),
      releaseEntry: () => driver.controller.sendRelease({ type: 'floor-release' }),
    })

    for (const [id, kind] of Object.entries(replies)) {
      const sent = []
      driver.controller.transports[id] = {
        id,
        retries: false,
        sent,
        isOpen: () => true,
        send(envelope) {
          sent.push(envelope)
          if (!kind) return true
          // Reply on the next tick, as a real carrier would. A release is
          // always acked; only the request gets the scripted answer.
          const reply = envelope.kind === 'floor-release' ? Kind.ReleaseAck : kind
          setTimeout(
            () => driver.controller._receive({ v: 1, kind: reply, reqId: envelope.reqId }),
            0,
          )
          return true
        },
        onMessage: () => () => {},
        describe: () => 'fake',
      }
    }
    return driver
  }

  it('blocks a run that asked for both data channel types', async () => {
    const driver = createDriver({ params: params({ error: 'both on one connection' }) })
    driver.waitForReady()

    expect(driver.phase.value).toBe('blocked')
    expect(driver.blockedReason.value).toBe('both on one connection')
    expect(await driver.start()).toBeNull()
    driver.uninstall()
  })

  it("blocks when the run's channel never opens, naming the likely cause", async () => {
    vi.useFakeTimers()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      // The peer connection is up, but the channel never opens — which is what
      // a `--floor-channels` mismatch on the server looks like from here.
      let connected = false
      const driver = createDriver({
        params: params({ transports: ['ws', 'dc-reliable'] }),
        isConnected: () => connected,
      })
      driver.waitForReady()
      expect(driver.phase.value).toBe('waiting')

      // The deadline does not start before the connection exists.
      performance.now.mockReturnValue(60000)
      await vi.advanceTimersByTimeAsync(250)
      expect(driver.phase.value).toBe('waiting')

      connected = true
      await vi.advanceTimersByTimeAsync(250)
      expect(driver.phase.value).toBe('waiting')

      performance.now.mockReturnValue(60000 + 14000)
      await vi.advanceTimersByTimeAsync(250)
      expect(driver.phase.value).toBe('waiting')

      performance.now.mockReturnValue(60000 + 15001)
      await vi.advanceTimersByTimeAsync(250)
      expect(driver.phase.value).toBe('blocked')
      expect(driver.blockedReason.value).toContain('--floor-channels')
      expect(driver.blockedReason.value).toContain('No trials have run')
      expect(await driver.start()).toBeNull()
      driver.uninstall()
    } finally {
      performance.now.mockRestore()
      vi.useRealTimers()
    }
  })

  it('probes every transport for a reply before declaring ready', async () => {
    const driver = readyDriver({ ws: Kind.Grant, 'dc-reliable': Kind.Grant })
    driver.waitForReady()
    await vi.waitFor(() => expect(driver.phase.value).toBe('ready'))

    // One request and one release per transport, and nothing recorded as a trial.
    expect(driver.controller.transports.ws.sent.map((e) => e.kind)).toEqual([
      'floor-request',
      'floor-release',
    ])
    expect(driver.controller.transports['dc-reliable'].sent).toHaveLength(2)
    expect(driver.rows.value).toEqual([])
    driver.uninstall()
  })

  it('blocks when a channel is open but the server never answers on it', async () => {
    // Exactly the --floor-channels mismatch: the dot is green, the stream is dead.
    const driver = readyDriver({ ws: Kind.Grant, 'dc-reliable': null })
    driver.waitForReady()

    await vi.waitFor(() => expect(driver.phase.value).toBe('blocked'), { timeout: 8000 })
    expect(driver.blockedReason.value).toContain('--floor-channels')
    expect(driver.blockedReason.value).toContain('as soon as SCTP connects')
    expect(driver.blockedReason.value).toContain('No trials have run')
    expect(await driver.start()).toBeNull()
    driver.uninstall()
  }, 15000)

  it('names the WebSocket differently, since a dead socket means something else', async () => {
    const driver = readyDriver({ ws: null })
    driver.waitForReady()

    await vi.waitFor(() => expect(driver.phase.value).toBe('blocked'), { timeout: 8000 })
    expect(driver.blockedReason.value).toContain('not')
    expect(driver.blockedReason.value).toContain('envelope')
    expect(driver.blockedReason.value).not.toContain('--floor-channels')
    driver.uninstall()
  }, 15000)

  it('treats a denial as a pass — the server replied, which is the point', async () => {
    const driver = readyDriver({ ws: Kind.Deny })
    driver.waitForReady()
    await vi.waitFor(() => expect(driver.phase.value).toBe('ready'), { timeout: 5000 })
    driver.uninstall()
  })

  it('can be re-probed by hand without stranding the run', async () => {
    // Used during the rig's capture window to put traffic on both carriers.
    const driver = readyDriver({ ws: Kind.Grant, 'dc-reliable': Kind.Grant })
    driver.waitForReady()
    await vi.waitFor(() => expect(driver.phase.value).toBe('ready'))

    expect(await driver.probe()).toBe(true)
    expect(driver.phase.value).toBe('ready')
    // Four frames per probe: request + release on each of the two transports.
    expect(driver.controller.transports.ws.sent).toHaveLength(4)
    expect(driver.rows.value).toEqual([])
    driver.uninstall()
  })

  it('leaves a ready run alone when a hand-run probe fails', async () => {
    // Fired during the rig's capture window, i.e. after the condition is
    // applied, where losing a reply is a property of the condition.
    const driver = readyDriver({ ws: Kind.Grant })
    driver.waitForReady()
    await vi.waitFor(() => expect(driver.phase.value).toBe('ready'))

    driver.controller.transports.ws.send = () => true // replies stop coming
    expect(await driver.probe()).toBe(false)
    expect(driver.phase.value).toBe('ready')
    expect(driver.blockedReason.value).toBe('')
    driver.uninstall()
  }, 15000)

  it('refuses to start while still probing', async () => {
    // A silent transport keeps the probe in flight long enough to observe it.
    const driver = readyDriver({ ws: null })
    driver.waitForReady()
    await vi.waitFor(() => expect(driver.phase.value).toBe('probing'))
    expect(await driver.start()).toBeNull()
    expect(driver.rows.value).toEqual([])
    driver.uninstall()
  })

  it('needs no channel at all for a WebSocket-only run', async () => {
    vi.useFakeTimers()
    try {
      const driver = createDriver({
        params: params({ transports: ['ws'] }),
        isConnected: () => true,
      })
      driver.waitForReady()
      await vi.advanceTimersByTimeAsync(60000)
      // Still only `waiting`, on `canTalk` — never `blocked`.
      expect(driver.phase.value).toBe('waiting')
      driver.uninstall()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('controller', () => {
  let controller
  let carrier
  let clock

  /** Replace a transport's carrier with a scriptable fake. */
  function fakeCarrier({ retries, open = true }) {
    const sent = []
    return {
      sent,
      retries,
      isOpen: () => open,
      send(envelope) {
        if (!open) return false
        sent.push(envelope)
        return true
      },
      onMessage: () => () => {},
      describe: () => 'fake',
    }
  }

  function install({ retries = false, open = true, transport = 'ws' } = {}) {
    clock = 1000
    controller = createController({ now: () => clock })
    carrier = fakeCarrier({ retries, open })
    controller.transports[transport] = carrier
    controller.configure({ transport, retryMs: 100, timeoutMs: 2000 })
    return controller
  }

  /** The application's press entry point, as the driver calls it. */
  const press = (ctrl) => ctrl.press(() => ctrl.sendRequest({ type: 'floor-request' }))

  beforeEach(() => {
    vi.useFakeTimers()
    resetReqIds()
    deliverFloorMessage.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends once on a reliable transport and measures press to grant', async () => {
    install()
    const settled = press(controller)
    expect(carrier.sent).toHaveLength(1)

    clock = 1037.5
    controller._receive({
      v: 1,
      kind: Kind.Grant,
      reqId: carrier.sent[0].reqId,
      serverRecvMs: 10,
      serverSendMs: 10.5,
      body: { type: 'floor-grant' },
    })

    const record = await settled
    expect(record.outcome).toBe(Outcome.Granted)
    expect(record.tPress).toBe(1000)
    expect(record.tReply - record.tPress).toBeCloseTo(37.5)
    expect(record.sends).toBe(1)
    // The grant reaches the app only after the clock has stopped.
    expect(deliverFloorMessage).toHaveBeenCalledWith({ type: 'floor-grant' })
  })

  it('resends the identical envelope on the unreliable transport', async () => {
    install({ retries: true })
    const settled = press(controller)

    await vi.advanceTimersByTimeAsync(250)
    expect(carrier.sent).toHaveLength(3)
    // Same reqId, same text — that is what makes the server's dup reply visible.
    expect(new Set(carrier.sent.map((envelope) => envelope.reqId)).size).toBe(1)

    controller._receive({ v: 1, kind: Kind.Grant, reqId: carrier.sent[0].reqId, dup: true })
    const record = await settled
    expect(record.sends).toBe(3)
    expect(record.dupReplies).toBe(1)

    // The retry timer must stop once the reply is in.
    await vi.advanceTimersByTimeAsync(500)
    expect(carrier.sent).toHaveLength(3)
  })

  it('never resends on a reliable transport', async () => {
    install({ retries: false })
    press(controller)
    await vi.advanceTimersByTimeAsync(1500)
    expect(carrier.sent).toHaveLength(1)
  })

  it('times out at timeoutMs and leaves the next trial able to run', async () => {
    install()
    const settled = press(controller)
    await vi.advanceTimersByTimeAsync(2000)

    const record = await settled
    expect(record.outcome).toBe(Outcome.Timeout)
    expect(record.tReply).toBeNull()
    expect(deliverFloorMessage).not.toHaveBeenCalled()

    const next = press(controller)
    controller._receive({ v: 1, kind: Kind.Grant, reqId: carrier.sent.at(-1).reqId })
    expect((await next).outcome).toBe(Outcome.Granted)
  })

  it('counts a late reply to a closed request without acting on it', async () => {
    install()
    const first = press(controller)
    const staleReqId = carrier.sent[0].reqId
    await vi.advanceTimersByTimeAsync(2000)
    expect((await first).outcome).toBe(Outcome.Timeout)

    const second = press(controller)
    controller._receive({ v: 1, kind: Kind.Grant, reqId: staleReqId })
    expect(deliverFloorMessage).not.toHaveBeenCalled()

    controller._receive({ v: 1, kind: Kind.Grant, reqId: carrier.sent.at(-1).reqId })
    const record = await second
    expect(record.lateReplies).toBe(1)
    expect(record.outcome).toBe(Outcome.Granted)
  })

  it('reports a closed carrier instead of waiting out the timeout', async () => {
    install({ open: false })
    const record = await press(controller)
    expect(record.outcome).toBe(Outcome.Unsent)
    expect(record.sends).toBe(0)
    expect(record.tFirstSend).toBeNull()
  })

  it('settles a press the application refused', async () => {
    install()
    const record = await controller.press(() => {
      /* canTalk was false, so requestFloor is never reached */
    })
    expect(record.outcome).toBe(Outcome.Unsent)
    expect(carrier.sent).toHaveLength(0)
  })

  it('keeps a denial as a result, with the reason the server gave', async () => {
    install()
    const settled = press(controller)
    controller._receive({
      v: 1,
      kind: Kind.Deny,
      reqId: carrier.sent[0].reqId,
      denyReason: 'stale-request',
      body: { type: 'floor-deny' },
    })

    const record = await settled
    expect(record.outcome).toBe(Outcome.Denied)
    expect(record.denyReason).toBe('stale-request')
    // A denial still reaches the app, so the UI settles back to idle.
    expect(deliverFloorMessage).toHaveBeenCalledWith({ type: 'floor-deny' })
  })

  it('finds the deny reason whichever field the server puts it in', async () => {
    for (const reply of [
      { reason: 'release-overtook-request' },
      { body: { type: 'floor-deny', reason: 'release-overtook-request' } },
      { body: { type: 'floor-deny', denyReason: 'release-overtook-request' } },
    ]) {
      install()
      const settled = press(controller)
      controller._receive({ v: 1, kind: Kind.Deny, reqId: carrier.sent[0].reqId, ...reply })
      expect((await settled).denyReason).toBe('release-overtook-request')
    }
  })

  it('leaves the reason empty on a grant', async () => {
    install()
    const settled = press(controller)
    controller._receive({ v: 1, kind: Kind.Grant, reqId: carrier.sent[0].reqId })
    expect((await settled).denyReason).toBe('')
  })

  it('releases under the reqId of the request it releases', async () => {
    install()
    const granted = press(controller)
    const reqId = carrier.sent[0].reqId
    controller._receive({ v: 1, kind: Kind.Grant, reqId })
    await granted

    const settled = controller.releaseFloor(() => controller.sendRelease({ type: 'floor-release' }))
    expect(carrier.sent.at(-1)).toMatchObject({ kind: Kind.Release, reqId })

    controller._receive({ v: 1, kind: Kind.ReleaseAck, reqId })
    expect((await settled).outcome).toBe(Outcome.Acked)
  })
})

describe('results', () => {
  const run = {
    runId: 'abc',
    label: 'loss5_delay50',
    seed: 1,
    intervalMs: 2000,
    holdMs: 200,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7), Chrome/141',
  }

  const granted = {
    index: 0,
    warmup: false,
    request: {
      reqId: 1,
      transport: 'ws',
      tPress: 1000,
      tFirstSend: 1000.2,
      tReply: 1037.5,
      outcome: 'granted',
      sends: 1,
      dupReplies: 0,
      lateReplies: 0,
      serverRecvMs: 10,
      serverSendMs: 10.5,
      retryMs: 100,
      timeoutMs: 2000,
      visibility: 'visible',
    },
    release: { tFirstSend: 1240, tReply: 1250, outcome: 'acked', sends: 1 },
    run,
  }

  it('derives the access time and the server processing time', () => {
    const row = toRow(granted)
    expect(row.accessMs).toBeCloseTo(37.5)
    expect(row.serverProcMs).toBeCloseTo(0.5)
    expect(row.tReleaseAck).toBe(1250)
  })

  it('carries a denial and its reason into the row', () => {
    const row = toRow({
      ...granted,
      request: { ...granted.request, outcome: 'denied', denyReason: 'stale-request' },
      release: null,
    })
    expect(row.outcome).toBe('denied')
    expect(row.denyReason).toBe('stale-request')
    // Denied is not granted, so there is no access time to report.
    expect(row.accessMs).toBeNull()
  })

  it('leaves a timed-out trial with no grant time rather than a zero', () => {
    const row = toRow({
      ...granted,
      request: { ...granted.request, outcome: 'timeout', tReply: null },
      release: null,
    })
    expect(row.tGrant).toBeNull()
    expect(row.accessMs).toBeNull()
    expect(row.releaseOutcome).toBe('skipped')
    const [, line] = toCsv([row]).split('\n')
    expect(line.split(',')[CSV_COLUMNS.indexOf('accessMs')]).toBe('')
  })

  it('quotes a user agent containing commas so the columns stay aligned', () => {
    const csv = toCsv([toRow(granted)])
    const [header, line] = csv.split('\n')
    expect(header.split(',')).toHaveLength(CSV_COLUMNS.length)
    expect(line).toContain('"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7), Chrome/141"')
  })

  it('takes medians from measured trials only', () => {
    const rows = [
      { warmup: 1, transport: 'ws', accessMs: 999 },
      { warmup: 0, transport: 'ws', accessMs: 10 },
      { warmup: 0, transport: 'ws', accessMs: 20 },
      { warmup: 0, transport: 'ws', accessMs: 30 },
      { warmup: 0, transport: 'dc-reliable', accessMs: null, outcome: 'timeout' },
    ]
    expect(medianAccessMs(rows, 'ws')).toBe(20)
    expect(medianAccessMs(rows, 'dc-reliable')).toBeNull()
  })

  it('tallies deny reasons so they can be read without the CSV', () => {
    const rows = [
      { warmup: 0, transport: 'ws', outcome: 'denied', denyReason: 'stale-request' },
      { warmup: 0, transport: 'ws', outcome: 'denied', denyReason: 'stale-request' },
      { warmup: 0, transport: 'ws', outcome: 'denied', denyReason: 'release-overtook' },
      { warmup: 0, transport: 'ws', outcome: 'granted', accessMs: 12, denyReason: '' },
    ]
    expect(summarise(rows)[0]).toMatchObject({
      denied: 3,
      denyReasons: { 'stale-request': 2, 'release-overtook': 1 },
    })
  })

  it('summarises retries and hidden trials per transport', () => {
    const rows = [
      {
        warmup: 0,
        transport: 'dc-unreliable',
        accessMs: 40,
        outcome: 'granted',
        sends: 3,
        visibility: 'visible',
      },
      {
        warmup: 0,
        transport: 'dc-unreliable',
        accessMs: null,
        outcome: 'timeout',
        sends: 20,
        visibility: 'hidden',
      },
    ]
    expect(summarise(rows)[0]).toMatchObject({
      transport: 'dc-unreliable',
      trials: 2,
      granted: 1,
      timeout: 1,
      retried: 2,
      maxSends: 20,
      hiddenTrials: 1,
      medianAccessMs: 40,
    })
  })
})

describe('installation', () => {
  let driver

  afterEach(() => {
    driver?.uninstall()
    driver = null
    document.getElementById('floor-exp-root')?.remove()
    delete window.__floorExp
  })

  it('installs nothing on a normal page load', async () => {
    const { installFloorExperiment } = await import('../floor/index.js')
    expect(installFloorExperiment('')).toBeNull()
    expect(window.__floorExp).toBeUndefined()
    expect(document.getElementById('floor-exp-root')).toBeNull()
  })

  it('arms the driver and mounts the run console for exp=floor', async () => {
    const { installFloorExperiment } = await import('../floor/index.js')
    driver = installFloorExperiment('?exp=floor&label=smoke&trials=3&warmup=1&seed=5')

    expect(driver).not.toBeNull()
    expect(window.__floorExp.results).toEqual([])
    expect(driver.config()).toMatchObject({ label: 'smoke', trials: 3, warmup: 1, seed: 5 })
    // Waiting on the carriers, so a start now must be refused.
    expect(driver.phase.value).toBe('waiting')
    expect(await driver.start()).toBeNull()

    const panel = document.getElementById('floor-exp-root')
    expect(panel?.textContent).toContain('RQ3 floor transport')
    expect(panel.textContent).toContain('smoke')
  })
})
