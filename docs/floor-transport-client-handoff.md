# Handoff: floor-control transport experiment — CLIENT (transmitter) agent

A matching file exists for the server agent. The "Shared contract" section is identical in both files. Do not change it on one side only: if something in it cannot be implemented, stop and report back so both sides can be changed together.

## Purpose

This work supports a research question in a final-year project (the second question in the report; earlier notes may call it RQ3):

> To what extent does the transport used for floor-control signalling (WebSocket or WebRTC data channel) affect push-to-talk access time under packet loss and delay in a browser-based client?

The experiment compares three ways of carrying floor requests and grants between this browser client and the local server:

1. `ws` — the existing signalling WebSocket (TCP). This is the baseline.
2. `dc-reliable` — a WebRTC data channel, reliable and ordered.
3. `dc-unreliable` — a WebRTC data channel, unreliable and unordered, with the client resending the request until it gets a reply.

The measured outcome is access time: button press to grant received, timed in this client. Network loss and delay are applied outside the client by the server-side rig.

## What I know and don't know about this codebase

- Repository: `WebRTC-PTToX-Client/webrtc-pttox`.
- A previous session reported that `requestFloor()` in `src/utils/webrtc.js` (around line 255) hardcodes the WebSocket by calling `send()` (around line 229). Verify this before relying on it.
- The same session said a trial recorder, a stats export and local-signalling URL handling already exist and can be reused. Reuse them where they fit; I have not seen them.
- The default behaviour of the client must not change. Everything here sits behind an experiment mode that is off unless requested.

## Shared contract (identical in both handoff files)

### Transports

| Mode id | Carrier | Settings |
|---|---|---|
| `ws` | Existing signalling WebSocket | Unchanged |
| `dc-reliable` | Data channel on the existing peer connection | label `floor-reliable`, `negotiated: true`, `id: 100`, `ordered: true`, no `maxRetransmits`, no `maxPacketLifeTime` |
| `dc-unreliable` | Data channel on the existing peer connection | label `floor-unreliable`, `negotiated: true`, `id: 101`, `ordered: false`, `maxRetransmits: 0` |

**One data channel per connection.** A run uses the WebSocket plus exactly one data channel type. The server puts only that channel on its offer (`--floor-channels reliable` or `--floor-channels unreliable`) and the client creates only that channel. The two data channel types must never exist on the same connection: they would share one SCTP association, and server testing showed that this makes them interfere and can stall the reliable channel for most of a run. Comparing the two types therefore takes two runs per network condition, each on a fresh connection: one with `ws` and `dc-reliable`, one with `ws` and `dc-unreliable`. Having `ws` in both runs also shows whether the two runs are comparable.

The server is the offerer and the client only ever answers. The server creates the run's data channel before it creates its offer, so the offer includes a data (`m=application`) section alongside the audio one. The client creates the same channel when it constructs its peer connection, before it applies the server's offer. An answer can only mirror the sections in the offer, so if the server's offer has no data section the channel never opens.

Fallback, only if the server's WebRTC library cannot create negotiated channels: the server creates the channel in-band on its own offer (same label and reliability settings, no `negotiated` or `id`), and the client accepts it by label. Using the fallback is a contract change, so report it.

### Message envelope

On all three transports, experiment floor messages are JSON text in this envelope:

```json
{ "v": 1, "kind": "floor-request", "reqId": 1234, "body": {} }
```

- `kind`, client to server: `floor-request`, `floor-release`.
- `kind`, server to client: `floor-grant`, `floor-deny`, `floor-release-ack`.
- `reqId`: integer, unique and increasing within one page session. A release carries the `reqId` of the request it releases.
- `body`: the existing floor message for that action, unchanged (object or string, whatever the current protocol uses). The server unwraps it, runs the normal floor logic, and wraps the normal response the same way.

Server replies add these fields:

```json
{ "v": 1, "kind": "floor-grant", "reqId": 1234, "serverRecvMs": 5021.337, "serverSendMs": 5021.902, "dup": false, "body": {} }
```

- `serverRecvMs` / `serverSendMs`: server monotonic clock, milliseconds, fractional. Only their difference is used, so no clock sync is needed.
- `dup`: `true` when this reply answers a repeated `reqId`.

### Rules

1. **Same transport back.** The server replies on the transport the message arrived on.
2. **Idempotent requests.** A repeated `floor-request` with a `reqId` already answered does not re-run floor logic. The server resends the same reply with `dup: true`. It must resend, because the first reply may have been lost.
3. **Idempotent releases.** A repeated `floor-release` gets `floor-release-ack` again with `dup: true`.
4. **Implicit release.** If a `floor-request` with a new `reqId` arrives from the client that already holds the floor, the server releases, then grants, and logs it as an implicit release. This stops a lost release from stalling a run.
5. **Client retry.** On `dc-unreliable` only, the client resends the same envelope every `retryMs` (default 100, configurable) until the matching reply arrives or `timeoutMs` (default 2000) passes. On `ws` and `dc-reliable` the client sends once.
6. **Normal traffic unaffected.** WebSocket floor messages without the envelope keep working exactly as they do now.

## Tasks

### 1. Floor transport strategy

- Replace the hardcoded WebSocket send in the floor request and release paths with an injected transport: one small interface (`send(envelope)`, `onMessage(handler)`, `isOpen()`) with three implementations, `ws`, `dc-reliable` and `dc-unreliable`.
- Outside experiment mode the client keeps sending the plain, un-enveloped WebSocket messages it sends today.
- The three implementations may differ only in the carrier and, for `dc-unreliable`, the retry timer. Message building, parsing and the code that reacts to a grant must be shared.

### 2. Data channels

- **Changed after server testing:** create only the one data channel named in the run's `transports` parameter, with the contract settings, when the peer connection is constructed and before the server's offer is applied. Never create both on one connection.
- If the run's data channel has not opened within 15 s of the connection being established, stop with a clear message that the server was probably started with a different `--floor-channels` setting. Do not start trials.
- Treat a transport as ready only when its channel reports open.
- After open, log each channel's `ordered`, `maxRetransmits` and `id` so the settings can be shown in the report.

### 3. Retry and release

- `dc-unreliable`: resend the identical envelope (same `reqId`) every `retryMs` until the matching reply or `timeoutMs`. Count sends per request.
- `ws` and `dc-reliable`: send once and wait up to `timeoutMs`.
- Release follows the same per-transport rule and completes on `floor-release-ack`.
- Ignore replies whose `reqId` is not the current request, but count them (late duplicates are a result, not an error).

### 4. Timing

Use `performance.now()` for all of these:

- `tPress`: first line of the press handler, using the same entry point the real button uses.
- `tFirstSend`: immediately before the first send call for that request.
- `tGrant`: first line of the message handler for the matching `floor-grant`, before any other processing.
- `accessMs = tGrant - tPress`. This is the primary measurement.
- Also record `tReleaseSend` and `tReleaseAck`.

Do not use the 50 ms statistics sampler for any of these timings.

### 5. Automation driver

An in-page driver, started by URL parameters (and callable from the console), for example:

`?exp=floor&label=loss5_delay50&trials=500&warmup=20&intervalMs=2000&holdMs=200&retryMs=100&timeoutMs=2000&transports=ws,dc-reliable&seed=1`

- `label` is free text naming the network condition. The client cannot see the impairment settings, so the label is the only link between a results file and its condition.
- `transports` may contain `ws` and at most one of `dc-reliable` or `dc-unreliable`. Reject a value that lists both data channel types, with a message pointing to the one-channel-per-connection rule.
- The server now denies some requests with a reason (a stale request, or a request whose release overtook it on the unordered channel). Record the reason the reply carries in a `denyReason` column, and keep such trials in the output as `denied`.
- A trial that times out stays in the output with `outcome=timeout` and an empty `accessMs`. Do not drop it or substitute a number: the analysis treats it as "slower than `timeoutMs`".
- `trials` is per transport. Build a trial list with equal counts for each transport and shuffle it with a seeded random generator, so the transports are interleaved and the order is reproducible.
- Run `warmup` trials per transport first and mark them `warmup=true` in the output.
- Each trial: press, wait for grant or timeout, hold for `holdMs`, release, wait for the ack or timeout, then wait until `intervalMs` has passed since the press.
- Before the first trial, wait until the WebSocket is open, the run's data channel is open and the peer connection is connected. Then show a clear "ready" state and wait for a start signal (a button or console call), so the network condition can be applied after connection and before trials.
- Leave the normal post-grant behaviour (starting to transmit audio) in place unless it breaks automation. If the microphone prompt is a problem, document the Chrome flags for a fake media device in the run instructions; do not disable the audio path.
- The tab must stay visible and focused for the whole run, because browsers slow timers in background tabs, which would distort both the driver and the retry timer. Record `document.visibilityState` at each trial and flag any trial where it was not `visible`.

### 6. Results export

One row per trial, downloadable as CSV when the run ends and also available at `window.__floorExp.results`:

`runId, label, seed, trialIndex, warmup, transport, reqId, tPress, tFirstSend, tGrant, accessMs, sends, outcome, denyReason, dupReplies, lateReplies, serverRecvMs, serverSendMs, serverProcMs, tReleaseSend, tReleaseAck, releaseSends, releaseOutcome, retryMs, timeoutMs, intervalMs, holdMs, visibility, userAgent, wallClockIso`

- `outcome`: `granted`, `denied` or `timeout`.
- `serverProcMs = serverSendMs - serverRecvMs` from the reply.
- File name: `floor_<label>_<runId>.csv`.
- A run that is stopped early must still export the rows it has.

### 7. Run instructions

Add a short `docs/` note covering: how to start a run, the URL parameters, the order of steps (connect, apply network condition, start), and the output columns.

## Acceptance checks

1. With experiment mode off, the client behaves exactly as before.
2. With no impairment, each transport gets a grant, and the reply arrives on the transport the request was sent on. This takes both run types: `ws,dc-reliable` and `ws,dc-unreliable`.
3. With no impairment, median `accessMs` is within a few milliseconds across the three transports, measured across the condition's two runs. Report all four medians — `ws` from each run, plus `dc-reliable` and `dc-unreliable` — because the two `ws` figures agreeing is what makes the two runs comparable. If any of them differ by more, find out why before running any impaired condition.
4. With loss applied, `dc-unreliable` shows `sends > 1` on some trials, and `ws` and `dc-reliable` always show `sends = 1`.
5. A trial with no reply ends as `timeout` at `timeoutMs`, and the next trial still runs.
6. The same `seed` produces the same transport order.
7. The CSV has one row per trial, with counts per transport equal to `trials + warmup`.

## Report back to the user

- Whether `requestFloor()` and the send path were where this file says, and what was changed.
- What the existing floor message `body` looks like (so the server agent can confirm it matches).
- Whether negotiated channels worked or the fallback was needed.
- The three no-impairment medians from acceptance check 3.
- Anything in this file that did not match the codebase.
