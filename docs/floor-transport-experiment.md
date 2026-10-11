# RQ3 — floor-control transport: running the client side

> To what extent does the transport used for floor-control signalling
> (WebSocket or WebRTC data channel) affect push-to-talk access time under
> packet loss and delay in a browser-based client?

The measured outcome is **access time**: button press to grant received, timed
in this client with `performance.now()`. Loss and delay are applied outside the
browser by the server-side rig; the client cannot see the impairment settings,
so the `label` you pass in the URL is the only link between a results file and
its condition. Label every run.

This note covers the client. The server contract is in
`docs/floor-transport-client-handoff.md`; deviations found while implementing it
are listed at the bottom of this file.

## The transports

| Mode id         | Carrier                                      | Settings                                                                    | Client sends                                         |
| --------------- | -------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ws`            | The existing signalling WebSocket (TCP)      | unchanged                                                                   | once                                                 |
| `dc-reliable`   | Data channel on the existing peer connection | `floor-reliable`, `negotiated`, `id: 100`, `ordered`                        | once                                                 |
| `dc-unreliable` | Data channel on the existing peer connection | `floor-unreliable`, `negotiated`, `id: 101`, unordered, `maxRetransmits: 0` | resends every `retryMs` until a reply or `timeoutMs` |

### One data channel per connection

A run carries the WebSocket **plus exactly one** data channel type. The two
types must never share a peer connection: they would share one SCTP
association, and server-side testing found that they interfere badly enough to
stall the reliable channel for most of a run. The client enforces this — a
`transports` value naming both is refused before any trial runs.

So **each network condition takes two runs**, each on a fresh connection:

| Run | `transports`       | Server started with           |
| --- | ------------------ | ----------------------------- |
| A   | `ws,dc-reliable`   | `--floor-channels reliable`   |
| B   | `ws,dc-unreliable` | `--floor-channels unreliable` |

`ws` appears in both, which is what tells you whether the two runs are
comparable: if the `ws` medians differ between A and B, something about the
conditions changed between them and the two data channel figures cannot be
compared either.

Both sides must agree. The server puts only its `--floor-channels` channel on
the offer; the client creates only the one in `transports`. If they disagree the
channel never opens, and the client blocks after 15 s with a message saying so
rather than running a file full of timeouts.

Both transports carry the same JSON envelope, so the comparison is of transports
and not of message formats:

```json
{
  "v": 1,
  "kind": "floor-request",
  "reqId": 1234,
  "body": { "type": "floor-request", "participant_id": "Rock", "ssrc": 4242, "cc_port": 0 }
}
```

`body` is the client's existing floor message, untouched. The server unwraps it,
runs its normal floor logic, and wraps its normal reply the same way, adding
`serverRecvMs`, `serverSendMs`, `dup`, and a reason on a denial.

## Starting a run

Open the client with `exp=floor` and the run parameters:

```text
http://localhost:4173/?exp=floor&label=loss5_delay50&trials=500&warmup=20
  &intervalMs=2000&holdMs=200&retryMs=100&timeoutMs=2000
  &transports=ws,dc-reliable&seed=1
```

Then repeat the same condition with `transports=ws,dc-unreliable`, a restarted
server and a fresh connection. Use the same `label` and the same `seed` for the
pair, so the two files are recognisable as one condition.

| Parameter    | Default          | Meaning                                                                                                                          |
| ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `exp`        | —                | Must be `floor`. Without it nothing is installed at all.                                                                         |
| `label`      | `unlabelled`     | Free text naming the network condition. Goes in every row and in the file name.                                                  |
| `trials`     | `100`            | Measured trials **per transport**.                                                                                               |
| `warmup`     | `10`             | Warmup trials per transport, run first and marked `warmup=1`.                                                                    |
| `intervalMs` | `2000`           | Time from one press to the next. Paced from the press, not the reply.                                                            |
| `holdMs`     | `200`            | How long the floor is held before releasing.                                                                                     |
| `retryMs`    | `100`            | Resend period, `dc-unreliable` only.                                                                                             |
| `timeoutMs`  | `2000`           | How long a request waits before it is recorded as `timeout`.                                                                     |
| `transports` | `ws,dc-reliable` | `ws` and at most **one** of `dc-reliable` / `dc-unreliable`. Unknown ids are ignored; naming both data channel types is refused. |
| `seed`       | `1`              | Seeds the trial shuffle. The same seed gives the same order.                                                                     |

The trial list has equal counts per transport, shuffled with the seeded
generator so the transports are interleaved: all warmup trials first, then the
measured block. Nothing starts on load.

### Order of steps

1. **Connect.** Pick the server in the client and connect as normal. The
   microphone has to be live, because a press that the application refuses
   (`canTalk` false) is recorded as `unsent`, not as a measurement.
2. **Wait for `ready`.** The run console, bottom-left, lights one dot per gate:
   the peer connection, `canTalk`, and each transport in the run. The data
   channel counts only once it reports `open`, never merely created, and if it
   has not opened 15 s after the peer connection came up the console turns red.

   Green dots are not enough, so the console then **probes** each transport —
   one real floor request per transport, before anything is impaired — and only
   says `READY` once each one has been answered. A denial counts as an answer;
   silence does not. See "Why the probe exists" below. On a failure the console
   turns red, names the transport and the likely cause, and refuses to start;
   fix the server and press **Re-check** (no reload needed).

3. **Apply the network condition** on the rig, now that the connection exists
   and the probe has passed.
   This is the reason the driver waits rather than autostarting: impairing the
   handshake would change what is being measured.
4. **Press Start** (or call `window.__floorExp.start()`).
5. **Leave the tab visible and focused** for the whole run. Browsers throttle
   timers in background tabs, which would distort both the pacing and the retry
   timer. Every row records `document.visibilityState`; `summary()` counts any
   trial where it was not `visible` and those trials should be discarded.
6. The CSV downloads when the run ends. `Stop` ends it early and still exports
   the rows collected so far.

Everything on the panel is also on the console handle:

```js
window.__floorExp.start() // begin, same as the button
window.__floorExp.stop() // stop early; rows are still exported
window.__floorExp.results // the rows collected so far
window.__floorExp.summary() // per-transport medians, timeouts, retries
window.__floorExp.readiness // which gates are up
window.__floorExp.blockedReason // why it refuses to run, if it does
window.__floorExp.retryReady() // re-run the gate and the probe
window.__floorExp.probe() // traffic on every carrier, for the rig's capture
window.__floorExp.exportCsv() // re-download
```

### Chrome flags

A run presses PTT hundreds of times, so the microphone must not prompt and
should not depend on a human being in a quiet room:

```sh
chrome \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required
```

The audio path is deliberately left in place — a grant still unmutes the
microphone and the client still transmits — because removing it would stop
measuring the real press path. `getUserMedia` needs a secure context, so serve
the client over `http://localhost` or HTTPS (see constraint C3 in
`docs/local-server-doc.md`).

## Output

`floor_<label>_<runId>.csv`, one row per trial, also at
`window.__floorExp.results`. An empty cell is genuinely missing, never zero: a
trial that timed out has no `tGrant`, which is not a grant at time zero.

| Column                                         | Meaning                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `runId`, `label`, `seed`                       | Run identity. `label` is the network condition.                                                                                      |
| `trialIndex`                                   | Position in the shuffled list, warmup included.                                                                                      |
| `warmup`                                       | `1` for a warmup trial. Excluded from the medians.                                                                                   |
| `transport`                                    | `ws`, or the one data channel type this run used.                                                                                    |
| `reqId`                                        | Envelope request id; unique and increasing within the page session.                                                                  |
| `tPress`                                       | First line of the driver's press, immediately before the application's own press entry point.                                        |
| `tFirstSend`                                   | Immediately before the first send for that request.                                                                                  |
| `tGrant`                                       | First line of the reply handler, before any other processing.                                                                        |
| `accessMs`                                     | `tGrant - tPress`. **The primary measurement.**                                                                                      |
| `sends`                                        | Send attempts for the request. `> 1` only on `dc-unreliable`.                                                                        |
| `outcome`                                      | `granted`, `denied`, `timeout`, or `unsent` when the carrier was closed or the application refused the press.                        |
| `denyReason`                                   | Why the server denied: a stale request, or one whose release overtook it on the unordered channel. Empty on anything but a denial.   |
| `dupReplies`                                   | Replies carrying `dup: true`, i.e. answers the server had sent before.                                                               |
| `lateReplies`                                  | Replies for a request that had already closed. A result, not an error.                                                               |
| `serverRecvMs`, `serverSendMs`                 | The server's own monotonic clock. Only their difference is used, so no clock sync is needed.                                         |
| `serverProcMs`                                 | `serverSendMs - serverRecvMs`: time inside the server, which can be subtracted from `accessMs` to leave the network and the browser. |
| `tReleaseSend`, `tReleaseAck`                  | Release timing. Empty when no release was sent.                                                                                      |
| `releaseSends`, `releaseOutcome`               | `acked`, `timeout`, `unsent`, or `skipped` when the trial never held the floor.                                                      |
| `retryMs`, `timeoutMs`, `intervalMs`, `holdMs` | The parameters in force, repeated per row so a file is self-describing.                                                              |
| `visibility`                                   | `document.visibilityState` at the press. Anything but `visible` invalidates the row.                                                 |
| `userAgent`, `wallClockIso`                    | Provenance.                                                                                                                          |

### Reading it

Report **medians**, not means: an access-time distribution under loss has a tail
that a mean follows and a median does not. Exclude `warmup` rows, and exclude
rows where `visibility` was not `visible`.

Keep `timeout` and `denied` rows in the file. A timeout is not missing data — it
means "slower than `timeoutMs`", which is a result, and dropping them or
substituting a number would flatter whichever transport lost the most replies.
Report them as counts alongside the medians.

Before any impaired condition, run the unimpaired pair and compare the medians.
`ws` should agree between the two runs, and all three figures should agree
within a few milliseconds. If they do not, something other than the transport is
being measured — find out what before spending a session on impaired runs.

`performance.now()` is clamped to 100 µs in Chrome outside a cross-origin
isolated context, so access times are quantised to 0.1 ms. That is far below the
differences RQ3 is looking for, but it is why an unimpaired loopback can show
`accessMs` of exactly 0.

## Why the probe exists

**An open data channel proves nothing about the server.** A negotiated channel
has no handshake — no DCEP exchange, because both sides were told the stream id
up front — so Chrome reports it `open` the moment the SCTP association connects,
whether or not the peer has a channel on that id.

Measured in this repo's Cypress suite, in real Chrome: a client configured for
`dc-reliable` (id 100) against a server offering only `floor-unreliable`
(id 101) reported its channel open after **26 ms**, with `sctp.state` =
`connected`, and then timed out every request sent on it. That is exactly what a
`--floor-channels` mismatch looks like: four green dots and a fifteen-minute run
of nothing but timeouts, which under an impaired condition could be mistaken for
a result.

The 15 s open deadline only catches the cruder failure — an offer with no data
section at all, so SCTP never forms. The probe catches the mismatch, because it
asks for something the server has to actually answer. The behaviour is pinned by
the test "reports a mismatched channel as open, which is why the probe exists"
in `cypress/e2e/floor-transport.cy.js`; if that ever starts failing, Chrome has
changed and the gate can be simplified.

## Proving a run was actually impaired

The rig applies the condition to **one connection's ports** — a specific
WebSocket 4-tuple and a specific UDP pair. If the client's ports change between
the condition being set and the run starting, the run is unimpaired and nothing
in the client or the CSV says so. It happened once: a condition applied at
03:13 and a run started at 03:17 on different ports, producing ~5 ms access
times under what should have been 10 % loss and 50 ms.

Nothing in the run loop opens a connection — `new WebSocket` only happens in
`createConnection()` and `new RTCPeerConnection()` only in `receiveOffer()`
(`src/utils/webrtc.js`) — so pressing Start cannot cause it. The two things that
can, and how to tell them apart from the rig's `/status`:

| Ports that changed    | Cause                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket **and** UDP | The page was reloaded, or Connect was pressed again.                                                                                                                                                                                        |
| UDP only              | The server sent a **second `offer`**; `receiveOffer()` builds a whole new peer connection each time one arrives, so the socket survives and the UDP pair does not. The channel hook re-attaches silently, so the panel still looks healthy. |

Practical guard: set the condition **after** the client reports `READY`, note the
ports the rig prints, press Start without reloading, and watch the first few
trials. Under 10 % loss and 50 ms the access times should be over 100 ms. If
they are ~5 ms, stop — the run is on the wrong ports.

Running `window.__floorExp.probe()` during the rig's capture window puts a
request and a release on every carrier in the run, which is what lets the
capture see TCP and UDP at once; a manual PTT press only exercises whichever
transport is currently selected. A hand-run probe never blocks the run, because
after the condition is applied losing a reply is a property of the condition.

## What the client does not control

The impairment is applied on the rig, and **the rig has to impair the WebSocket
too**. The `ws` arm is TCP on the server's HTTP port; the `dc-*` arm is SCTP
over DTLS on the ICE-selected UDP path. A netem rule matching only the WebRTC
UDP flow — which is what `docs/local-server-doc.md` specifies for RQ2 — would
leave the `ws` baseline completely unimpaired and the comparison meaningless.

The server side has addressed this: its scripts match the client's exact
WebSocket TCP connection and the UDP pair, in both directions. On the
same-machine path it verified 100 ms round trip against an expected 100 ms and
18–19 % loss against an expected 19 %. **That verification has not been repeated
for the two-machine path**, which is the one the real experiment uses, so run
the rig's `scripts/verify-condition.sh --capture 10` against your own
browser-to-server path before trusting any impaired run, and confirm loss and
delay on both the TCP and the UDP flow in both directions.

The client-side confirmation is independent of that and worth having too: with
loss applied, `dc-unreliable` must show `sends > 1` on some trials while `ws` and
`dc-reliable` stay at `sends = 1`.

Do not run the RQ2 trial recorder or its 50 ms stats sampler during an RQ3 run.
It contends for the main thread with the thing being timed, and none of the RQ3
timings come from it.

## Deviations from the handoff

1. **The channel is created in the `RTCPeerConnection` constructor.** The
   contract says "before the server's offer is applied"; constructor time is the
   earliest such moment, and it is before `setRemoteDescription()` and
   `createAnswer()`. Constraint C6 of `docs/local-server-doc.md` ("one audio
   m-line") has been amended to allow the one `m=application` section this
   needs; the server agent made the same amendment on its side.
2. **Two stale lines in the handoff**, left over from the two-channel version,
   now corrected in place: §5 said to wait until "both data channels are open"
   before the first trial, and acceptance checks 2 and 3 spoke of "the three
   transports" and "the three medians" in one run. Read as: the run's own
   channel, and four medians across the condition's two runs — `ws` from each
   run plus the two data channel figures, because the two `ws` medians agreeing
   is what makes the runs comparable.
3. **`denyReason`'s envelope field name is not pinned yet.** The contract names
   the column, not the key; both sides are to settle on a top-level `reason` on
   the `floor-deny` envelope. Until then the client reads `denyReason`, then
   `reason`, then the same two inside `body`, taking the first non-empty string,
   so it works with any of them.
4. **`tPress` is taken immediately before the application's press entry point**,
   not inside it, so no experiment code sits in `stores/session.js`. The missing
   interval is one function call, identical for all three transports.
5. **The retry timer is shared rather than duplicated.** Each transport declares
   whether it retries; one loop in `controller.js` acts on that. The handoff's
   intent — that the arms differ only in carrier and retry — is kept, without
   three copies of the resend logic.
6. **On the `ws` arm the application's own socket listener sees the frame
   first** and drops it, because an envelope has no top-level `type`. That is
   what keeps normal WebSocket floor traffic working (rule 6), and it costs one
   `JSON.parse` of a small object before `tGrant`, on that arm only. The
   envelope must therefore never carry a top-level `type`.
7. **A `floor-deny` takes 1200 ms to settle back to idle** in the existing
   client, so `intervalMs` below about 1500 would get the next press refused and
   recorded as `unsent`. The driver warns when it is. This matters more than it
   did: the server now denies stale and overtaken requests, so denials are
   expected rather than hypothetical. Keep `intervalMs` at 2000 or above.

## Code layout and removal

```text
src/research/floor/
  envelope.js        the wire format and request ids
  channels.js        the run's negotiated channel and its settings
  transports.js      ws | dc-reliable | dc-unreliable, one interface
  controller.js      envelopes, timing, retry, reply matching
  driver.js          URL parameters, seeded order, the trial loop
  results.js         rows, CSV, medians
  FloorExpPanel.vue  the run console
  index.js           gated on ?exp=floor
```

Tests: `src/research/__tests__/floor.spec.js` for the logic, and
`cypress/e2e/floor-transport.cy.js` for what only a real browser can show — that
Chrome negotiates the run's channel with the contract settings, only that
channel exists on the connection, and an enveloped request round-trips on the
transport it was sent on.

To remove the experiment:

```sh
rm -rf src/research/floor src/research/__tests__/floor.spec.js \
       cypress/e2e/floor-transport.cy.js
```

Then delete the `import './floor'` line from `src/research/index.js`, the
`RQ3 EXPERIMENT SEAM` block and the four lines marked `RQ3` in
`src/utils/webrtc.js`, and the `floor transport seam` describe block from
`src/utils/__tests__/webrtc.spec.js`. The two hooks the experiment uses —
`onConnectionCreated` in `research/peerConnections.js` and
`activeSignallingSocket` in `research/localSignalling.js` — are general research
plumbing and can stay.
