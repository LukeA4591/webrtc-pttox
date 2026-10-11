# Research layer — RQ2 and RQ3 instrumentation

Temporary measurement code for the dissertation experiments. Two separate
experiments live here:

- **RQ2** (this file, below): receive-side jitter-buffer instrumentation.
- **RQ3** (`floor/`): floor-control signalling over the WebSocket vs over a
  WebRTC data channel, measuring push-to-talk access time. Entirely gated on
  `?exp=floor`; see [docs/floor-transport-experiment.md](../../docs/floor-transport-experiment.md).
  It is the one part of the research layer that needed a seam in application
  code — a marked block in `utils/webrtc.js`, because the floor send path and
  the peer connection are both inside a closure. That block is inert until the
  experiment injects a transport.

## RQ2 — receive-side jitter buffer

It provides:

- **`ws://` compatibility for a local signalling server.** `utils/webrtc.js`
  hardcodes `wss://`, so a plain-`ws` server on the LAN is otherwise
  unreachable. The rewrite only ever downgrades `wss:`→`ws:`, never the reverse,
  and only for loopback / RFC1918 / link-local addresses and local-only TLDs, so
  a public production host can never be downgraded. It also collapses a
  duplicated `/api/webrtc/ws` path — the server field wants a **bare host**
  (`192.168.88.4:8080`), and pasting a full URL otherwise doubles the path. The
  panel shows the effective URL.

- a control for `RTCRtpReceiver.jitterBufferTarget` in **milliseconds**, with
  both the requested and the achieved delay reported
- a trial recorder: the **received** audio plus a `getStats()` timeline
- export of stats CSV, metadata JSON and the audio file per trial

## Removing it

```sh
rm -rf src/research
```

Then delete the single marked line from `src/main.js`:

```js
import './research' // RESEARCH: remove with src/research
```

That is the whole removal for RQ2. No other file in `src/` was modified by it —
the panel mounts itself into an element it creates, and the peer connection is
captured by subclassing the global `RTCPeerConnection` rather than by editing
`utils/webrtc.js`.

RQ3 removal is `rm -rf src/research/floor` plus the marked seam in
`utils/webrtc.js`; the full list is at the end of
[docs/floor-transport-experiment.md](../../docs/floor-transport-experiment.md).

## Why 50 ms and not 20 ms

libwebrtc's `RTCStatsCollector` caches reports for 50 ms, so `getStats()` calls
inside that window return the _same report with the same timestamp_. Polling
faster produces duplicate rows and extra CPU contention with the audio pipeline
being measured, not finer resolution.

The interval is still editable in the panel. Every sample records the report's
own `statsTimestamp` and a `fresh` flag, and `derived` counts duplicates, so if
you do poll faster the redundancy is visible in the data rather than hidden.

## Reading the output

Window-level measures in `*-meta.json` come from end-minus-start deltas of
cumulative counters:

```text
achieved mean jitter-buffer delay (ms) = 1000 * ΔjitterBufferDelay / ΔjitterBufferEmittedCount
concealment proportion                 = ΔconcealedSamples / ΔtotalSamplesReceived
loss fraction                          = ΔpacketsLost / (ΔpacketsLost + ΔpacketsReceived)
```

A missing counter stays `null` and an empty CSV cell means genuinely absent —
never zero. If `jitterBufferEmittedCount` and `totalSamplesReceived` do not
advance, the browser was not playing audio out and `derived.usable` is `false`:
**that trial is void**, not a measurement of zero.

`jitterBufferTarget` is a hint that Chrome clamps, so the requested value is not
necessarily the achieved one. Always report both.

The audio file is a MediaRecorder re-encode (WebM/Opus) of the decoded signal,
not a bit-exact capture. Use it for listening and waveform inspection alongside
the counters, not as a substitute for them.
