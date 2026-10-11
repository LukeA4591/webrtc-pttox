/**
 * RQ3 floor-transport experiment, in a real browser.
 *
 * A negotiated data channel cannot be verified under jsdom — it has no WebRTC —
 * and the contract's whole point is what Chrome actually negotiates. So this
 * spec stands a second peer connection up inside the page as a stand-in for the
 * server, and checks the client half of the contract against it: the run's one
 * channel opens with the agreed settings, and an enveloped floor request goes
 * out and comes back on the transport it was sent on.
 *
 * One data channel per connection, so the two types are two separate page
 * loads here, exactly as they are two separate runs in the real experiment.
 *
 * The client peer connection is constructed through `window.RTCPeerConnection`
 * on purpose, so the real research-layer hook is what attaches the channel,
 * exactly as it does against the live server.
 */

const OPEN_TIMEOUT_MS = 15000

/**
 * Stand in for the server: offer with the run's channel on it, and echo an
 * enveloped reply on the channel the request arrived on.
 *
 * @param {Window} win
 * @param {string} transport the run's data channel transport id
 */
function loopback(win, transport) {
  const exp = win.__floorExp
  const spec = exp.channels.specs[transport]

  // `__native` is the unpatched constructor the research layer preserved; using
  // it keeps the hook from attaching a second copy of the channel here.
  const server = new win.RTCPeerConnection.__native()
  const serverChannel = server.createDataChannel(spec.label, spec.options)
  serverChannel.addEventListener('message', (event) => {
    const envelope = JSON.parse(event.data)
    const release = envelope.kind === 'floor-release'
    serverChannel.send(
      JSON.stringify({
        v: 1,
        kind: release ? 'floor-release-ack' : 'floor-grant',
        reqId: envelope.reqId,
        serverRecvMs: 1000.25,
        serverSendMs: 1000.75,
        dup: false,
        body: { type: release ? 'floor-release' : 'floor-grant' },
      }),
    )
  })

  const client = new win.RTCPeerConnection()

  server.addEventListener('icecandidate', (event) => {
    if (event.candidate) client.addIceCandidate(event.candidate)
  })
  client.addEventListener('icecandidate', (event) => {
    if (event.candidate) server.addIceCandidate(event.candidate)
  })

  /**
   * Wait on the *client's* own channel, not the server stand-in's. The two do
   * not open simultaneously — the offerer's side reports open first — and the
   * contract is explicit that a transport is ready only once its own channel
   * says so. Polling `isOpen()` is what the driver's readiness gate does.
   */
  const clientChannelOpen = async () => {
    const deadline = Date.now() + OPEN_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exp.controller.readiness()[transport]) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`${transport} never opened on the client`)
  }

  return (async () => {
    await server.setLocalDescription(await server.createOffer())
    const offerSdp = server.localDescription.sdp
    await client.setRemoteDescription(server.localDescription)
    await client.setLocalDescription(await client.createAnswer())
    const answerSdp = client.localDescription.sdp
    await server.setRemoteDescription(client.localDescription)

    await clientChannelOpen()

    exp.controller.configure({ transport, retryMs: 100, timeoutMs: 4000 })
    const request = await exp.controller.press(() =>
      exp.controller.sendRequest({ type: 'floor-request', participant_id: 'Rock', cc_port: 0 }),
    )
    const release = await exp.controller.releaseFloor(() =>
      exp.controller.sendRelease({ type: 'floor-release', participant_id: 'Rock', cc_port: 0 }),
    )

    const result = {
      offerSdp,
      answerSdp,
      settings: exp.channels.settings(),
      readiness: exp.controller.readiness(),
      request,
      release,
    }
    client.close()
    server.close()
    return result
  })()
}

/**
 * The mismatch case: the server offers a data section, but for the *other*
 * channel. Returns how the client's own channel behaves.
 */
function mismatchedLoopback(win, clientTransport, serverTransport) {
  const exp = win.__floorExp
  const serverSpec = exp.channels.specs[serverTransport]

  const server = new win.RTCPeerConnection.__native()
  server.createDataChannel(serverSpec.label, serverSpec.options)
  const client = new win.RTCPeerConnection()

  server.addEventListener('icecandidate', (event) => {
    if (event.candidate) client.addIceCandidate(event.candidate)
  })
  client.addEventListener('icecandidate', (event) => {
    if (event.candidate) server.addIceCandidate(event.candidate)
  })

  return (async () => {
    await server.setLocalDescription(await server.createOffer())
    await client.setRemoteDescription(server.localDescription)
    await client.setLocalDescription(await client.createAnswer())
    await server.setRemoteDescription(client.localDescription)

    const started = Date.now()
    let openedAfterMs = null
    while (Date.now() - started < 8000) {
      if (exp.controller.readiness()[clientTransport]) {
        openedAfterMs = Date.now() - started
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    let outcome = 'not-attempted'
    if (openedAfterMs !== null) {
      exp.controller.configure({ transport: clientTransport, timeoutMs: 1500 })
      const record = await exp.controller.press(() =>
        exp.controller.sendRequest({ type: 'floor-request' }),
      )
      outcome = record.outcome
    }

    const result = { openedAfterMs, outcome, sctp: client.sctp?.state ?? 'none' }
    client.close()
    server.close()
    return result
  })()
}

/** The run's data channel is the only one that may exist on the connection. */
function expectOnlyChannel(settings, transport) {
  expect(Object.keys(settings), 'channels on the connection').to.deep.eq([transport])
}

describe('RQ3 floor transport', () => {
  it('leaves the client untouched without ?exp=floor', () => {
    cy.visit('/')
    cy.get('#floor-exp-root').should('not.exist')
    cy.window().then((win) => {
      expect(win.__floorExp, 'experiment handle').to.be.undefined
    })
    cy.contains('h1', 'Push to Talk')
  })

  it('arms the run console from the URL without disturbing the client', () => {
    cy.visit('/?exp=floor&label=e2e_check&trials=4&warmup=2&seed=3&transports=ws,dc-reliable')
    cy.get('#floor-exp-root')
      .should('contain.text', 'RQ3 floor transport')
      .and('contain.text', 'e2e_check')
    // The real UI is still there and still disconnected.
    cy.contains('h1', 'Push to Talk')
    cy.get('button[aria-label*="Push to talk"]').should('be.disabled')
    cy.window().then((win) => {
      expect(win.__floorExp.config()).to.include({ label: 'e2e_check', trials: 4, seed: 3 })
      expect(win.__floorExp.config().transports).to.deep.eq(['ws', 'dc-reliable'])
      expect(win.__floorExp.results).to.deep.eq([])
      // Nothing may run until the carrier is up and the operator says go.
      expect(win.__floorExp.phase).to.eq('waiting')
    })
  })

  it('refuses a run that asks for both data channel types', () => {
    cy.visit('/?exp=floor&label=bad&transports=ws,dc-reliable,dc-unreliable')
    cy.get('#floor-exp-root').should('contain.text', 'one connection')
    cy.window().then((win) => {
      expect(win.__floorExp.phase).to.eq('blocked')
      expect(win.__floorExp.blockedReason).to.contain('two runs per condition')
    })
    // And a start attempt changes nothing.
    cy.window()
      .then((win) => win.__floorExp.start())
      .should('be.null')
    cy.window().then((win) => expect(win.__floorExp.results).to.deep.eq([]))
  })

  it('reports a mismatched channel as open, which is why the probe exists', () => {
    // This is the behaviour the readiness probe guards against, pinned so a
    // future change to the gate cannot quietly rely on `open` meaning agreement.
    cy.visit('/?exp=floor&label=mismatch&transports=ws,dc-reliable')
    cy.window()
      .then({ timeout: 25000 }, (win) => mismatchedLoopback(win, 'dc-reliable', 'dc-unreliable'))
      .then((result) => {
        expect(result.sctp, 'SCTP transport').to.eq('connected')
        // A negotiated channel has no handshake: SCTP connecting is enough.
        expect(result.openedAfterMs, 'ms until the client called it open').to.be.a('number')
        // ...and yet nothing the client sends on it is ever answered.
        expect(result.outcome, 'request on the mismatched channel').to.eq('timeout')
      })
  })

  for (const transport of ['dc-reliable', 'dc-unreliable']) {
    const expected =
      transport === 'dc-reliable'
        ? { label: 'floor-reliable', id: 100, ordered: true }
        : { label: 'floor-unreliable', id: 101, ordered: false, maxRetransmits: 0 }

    it(`opens ${transport} alone, with the contract settings`, () => {
      cy.visit(`/?exp=floor&label=loopback&transports=ws,${transport}`)
      cy.window()
        .then({ timeout: OPEN_TIMEOUT_MS + 5000 }, (win) => loopback(win, transport))
        .then((result) => {
          // The data section has to come from the offer: this client only answers.
          expect(result.offerSdp, 'offer').to.contain('m=application')
          expect(result.answerSdp, 'answer').to.contain('m=application')

          expectOnlyChannel(result.settings, transport)
          expect(result.settings[transport]).to.include(expected)
          if (transport === 'dc-reliable') {
            expect(result.settings[transport].maxRetransmits).to.eq(null)
            expect(result.settings[transport].maxPacketLifeTime).to.eq(null)
          }
          expect(result.readiness[transport], `${transport} ready`).to.be.true
        })
    })

    it(`round-trips an enveloped request and release on ${transport}`, () => {
      cy.visit(`/?exp=floor&label=loopback&transports=ws,${transport}`)
      cy.window()
        .then({ timeout: OPEN_TIMEOUT_MS + 5000 }, (win) => loopback(win, transport))
        .then(({ request, release }) => {
          expect(request.outcome, 'request outcome').to.eq('granted')
          expect(request.transport, 'carrier').to.eq(transport)
          expect(request.denyReason, 'deny reason on a grant').to.eq('')
          expect(request.sends, 'sends').to.be.at.least(1)
          // `performance.now()` is clamped to 100 µs in Chrome without
          // cross-origin isolation, and a same-process loopback is faster than
          // that, so a zero access time here is the clock's floor, not a bug.
          expect(request.tReply, 'grant time').to.be.a('number')
          expect(request.tReply - request.tPress, 'access time').to.be.at.least(0)
          // Server clocks arrive and only their difference is used.
          expect(request.serverSendMs - request.serverRecvMs).to.be.closeTo(0.5, 0.001)

          // A release carries the reqId of the request it releases.
          expect(release.outcome, 'release outcome').to.eq('acked')
          expect(release.reqId, 'release reqId').to.eq(request.reqId)
        })
    })
  }
})
