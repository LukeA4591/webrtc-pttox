# Feedback on `local-dev-server.md`: browser-to-browser WebRTC and client-side netem

**Goal:** Adapt the proposed local PTToX test environment so I can repeat RQ2 with **real WebRTC in two browser clients**, deliberately degrade the network **from the transmitting client**, and record received audio and browser statistics at the receiving client. Hydra will not be available.

This is feedback on the existing design, not a request to rebuild the full PTToX server. Please use the minimum implementation needed, verify each stage before expanding it, and preserve the existing client wherever practical.

## 1. Key change: the server should be signalling-only for RQ2

The current document proposes using Python `aiortc` as the server's WebRTC media endpoint. That is viable for developing the UI, but **it is not the architecture I want for the final RQ2 experiment**.

Instead:

```text
 Browser A: Chrome WebRTC sender                    Browser B: existing webrtc-pttox client
 (runs on Linux / in Linux container)               (Chrome WebRTC receiver)
       |                                                      ^
       |        WebRTC audio: ICE / DTLS / SRTP                 |
       +--------- [netem on A's OUTGOING traffic] ------------+
       |                                                      |
       +---- WebSocket / SDP / ICE ---- signalling relay -----+
```

- Both ends of the **media path** should be browsers using Chrome's native WebRTC implementation, rather than Chrome receiving from `aiortc`.
- The local server only exchanges WebRTC offers, answers and ICE candidates, plus minimal PTToX-like control messages needed by the existing client (`floor-request`, `floor-grant`, `floor-release` etc.). It should **not** decode, re-encode, relay, mix or originate the experimental audio.
- The receiver must remain the existing WebRTC client (including its `jitterBufferTarget`, audio output and `getStats()` behaviour). The sender can initially be a small purpose-built **browser page** that plays a fixed speech WAV into a `MediaStream` and creates the offer. That is still browser-to-browser WebRTC. If using two instances of the full app is easy, that is also fine, but do not expand scope simply to achieve it.
- Keep the `aiortc` server as an optional development fallback if it is already underway, but do not use data from it as though its media sender were identical to Chrome's.

## 2. Important client-protocol issue

As identified in the existing specification, `src/utils/webrtc.js` currently only **answers** remote offers. Two copies of this application cannot negotiate a peer connection without adding an offerer.

**Minimal approach:** make Browser A a separate testing sender page with an `RTCPeerConnection` offer path; route its offer to the existing Browser B client, route Browser B's answer back, and exchange ICE candidates or embed fully gathered candidates in the SDP. Keep one negotiated audio track and preserve `sendrecv` if you want Browser B's microphone/PTT to transmit back to Browser A for functional checks.

Preserve the required receiver contract:

- WebSocket endpoint: `/api/webrtc/ws` (the client's `wss://` construction needs a development-safe override/configuration).
- Server/relay -> receiver: `offer`, `candidate`, `floor-grant` (and optional `new-call`).
- Receiver -> server/relay: `answer`, `floor-request`, `floor-release` (and ICE candidates if trickle is enabled).
- Receiver expects **snake_case** fields for inbound `candidate` messages. Normalise formats at the relay rather than assuming both browsers emit identical JSON.
- The existing receiver does not send trickle ICE candidates. For the first version, it may be simpler to wait for gathering to finish before sending the answer. Verify the connection actually reaches `connected` and passes audio, rather than assuming signalling success means media works.

The audio source should be a repeatable prerecorded **speech** recording (not only a sine tone). A Web Audio `MediaStreamAudioDestinationNode` or another browser-controlled audio track is acceptable. Log when playback starts and which reference file was used.

## 3. Non-negotiable: `tc netem` must impair traffic from the SENDING BROWSER

I need to simulate degraded network conditions **at Browser A**, so incoming audio at Browser B experiences controlled delay, jitter and loss. The direction matters:

- `tc netem` on **Browser A's egress** -> degrades A -> B audio (the desired direction for RQ2 inbound jitter-buffer measurements).
- `tc netem` on **Browser B's egress** -> primarily degrades B -> A traffic, **not** the A -> B audio being received at B.
- `tc` runs in Linux, not directly on macOS. If using a Mac with Docker Desktop, the transmitting Chrome process must actually run **inside a Linux container/VM/network namespace where the qdisc can control its packets**. A normal Chrome tab on the Mac is *not* impaired merely by adding netem to an unrelated Docker container.

**Preferred topology:** two Chrome processes in separate Linux containers attached to the **same user-defined Docker bridge**, plus a simple signalling service. Give the **sender container** `NET_ADMIN` so it can run `tc`. This avoids a common Docker Desktop issue where a browser on the Mac cannot reach a container's private ICE/UDP address. A separate Linux machine/VM running sending Chrome to a receiving browser reachable over a LAN is an acceptable alternative.

### Example sender-side netem commands

First confirm the selected ICE path actually uses the sender container's `eth0` and the expected receiver container IPv4 address. Then, *after ICE/media are connected for the initial experiments*, apply an impairment to **outgoing UDP addressed to the receiver**:

```bash
# Run inside the Linux SENDER container, with NET_ADMIN.
# Replace this with the receiver's verified IP on the selected ICE path.
RECEIVER_IP=172.20.0.12

# Route only matching outbound UDP through netem (not all TCP/WebSocket traffic).
tc qdisc replace dev eth0 root handle 1: prio
tc qdisc replace dev eth0 parent 1:3 handle 30: \
  netem delay 100ms 20ms distribution normal loss 3%
tc filter add dev eth0 parent 1: protocol ip prio 1 u32 \
  match ip protocol 17 0xff \
  match ip dst "$RECEIVER_IP"/32 \
  flowid 1:3

# Confirm the qdisc and its counters are in use:
tc -s qdisc show dev eth0
tc -s filter show dev eth0 parent 1:

# Remove all shaping after the test:
tc qdisc del dev eth0 root
```

A simpler `tc qdisc replace dev eth0 root netem ...` is acceptable for an early smoke test **only if** we understand it will affect all outbound traffic on that interface. For proper RQ2 trials, restrict the impairment to the media peer's UDP path and confirm packets actually hit the rule. Since ICE/STUN/DTLS/SRTP may share a UDP path, a destination/UDP filter isn't an SRTP-only filter; run the main measurement after call setup.

Please implement convenient scripts (for example `netem-apply.sh`, `netem-clear.sh`, `netem-status.sh`) rather than requiring manual commands for every condition. Record the exact `tc` arguments in each experiment's metadata.

## 4. Verify there is no bypass around netem

A displayed `netem` rule does **not** prove the WebRTC packets are going through it. Before collecting research data, verify all of these:

1. Browser A and B establish an actual **browser-to-browser** peer connection with an audio track (no `aiortc` RTP intermediary, SFU or TURN relay bypass).
2. Use browser `getStats()` / `chrome://webrtc-internals` to record the **selected ICE candidate pair**, local and remote candidate addresses, transport and negotiated audio codec. The selected media path must use the sender Linux interface being shaped.
3. Confirm sender-side `tc` counters increase during active audio transmission. A packet capture is optional but useful when debugging.
4. Compare an unmodified baseline with obvious test impairment (e.g. 300 ms one-way delay and 10% loss). Receiver statistics and/or audio should respond plausibly. If they do not, stop: likely wrong interface, candidate pair, IP family, direction or bypassed route.
5. Ensure resetting netem returns results toward baseline. An ICE path change/restart must be logged, not silently treated as the same trial.

If mDNS ICE candidates, Docker Desktop NAT or network topology prevent direct communication, fix the network/candidate configuration explicitly. Do **not** quietly fall back to a different media path and still claim browser-to-browser results.

## 5. RQ2 data collection at Browser B

Please preserve/extend the actual application's existing receiver-side instrumentation, instead of moving the primary measurements to the signalling server. For each trial, export:

- Timestamped `getStats()` samples (ideally every second): `packetsReceived`, `packetsLost`, `jitter`, `concealedSamples`, `totalSamplesReceived`, `jitterBufferDelay`, `jitterBufferEmittedCount`, `packetsDiscarded` where available, plus relevant connection state.
- The requested `jitterBufferTarget` (**in milliseconds**) and actual average buffer delay computed from **deltas** of `jitterBufferDelay / jitterBufferEmittedCount`.
- Concealment proportion computed from **per-trial deltas**, not raw cumulative counters, with clear handling for missing fields and zero denominators.
- A recording of the **received audio** (WebM is fine), and the original reference speech file used by Browser A.
- Metadata: trial/condition ID, impairment direction/settings, sender and receiver browser versions, negotiated Opus parameters if accessible, selected ICE candidate pair, trial duration, timestamp and run order.

Ensure received audio is genuinely being consumed/playable during the test: a connected peer connection with packets arriving is not enough to guarantee the browser advances playout/jitter-buffer stats. Don't silently treat `null` or unavailable stats as zero.

For the initial repeatable experiments, hold the reference speech, browser versions, codec selection, and trial duration constant. Test baseline first; then run the planned RQ2 impairment/jitter-buffer conditions multiple times and randomise run order where practical. Treat locally generated results as a **new, controlled test environment**, not exact replicas of earlier Hydra measurements.

## 6. Keep RQ3 possible, but do not implement it yet

Once this browser-to-browser rig works, it should support an RQ3 pilot **without changing the media topology**, e.g. intermittent PTT audio versus a continuous muted/silent stream, or on-demand microphone capture versus already-acquired audio. Those are candidate questions, **not an instruction to begin an RQ3 experiment**. First finish and validate the RQ2 infrastructure.

For that flexibility, design Browser A so its audio source can later be gated, stopped/resumed or replaced with silence with a known timestamp, while retaining the same peer connection and sender statistics.

## 7. Implementation order / acceptance criteria

Please build only to these checkpoints, in order:

- [ ] **A.** Run a local signalling service. Browser A can create an offer, and the existing receiver can answer and connect.
- [ ] **B.** Browser A plays a fixed speech WAV over **native browser WebRTC**; Browser B audibly receives it and reports inbound-audio stats.
- [ ] **C.** Both clients' selected ICE path is recorded, and the sending browser is definitively inside a Linux network namespace whose `eth0` carries that media.
- [ ] **D.** Sender-side `tc netem` causes a visible change in receiver measurements; `tc -s` confirms traffic matches; removing impairment restores the baseline.
- [ ] **E.** Browser B saves per-trial stats (CSV/JSON), received audio, and settings/metadata.
- [ ] **F.** The original client's receive path and RQ2 settings remain intact, with any local-testing modifications isolated behind a development mode/config.

**Definition of done:** I can run *browser sender -> client-side netem -> actual browser receiver*, choose network conditions and `jitterBufferTarget`, and export repeatable receiver audio and statistics **without Hydra**. Please prioritise this over simulating PTToX features that aren't needed for the experiment.

## References for implementation checks

- Existing project design: `local-dev-server.md` (particularly §§1, 3–4, 9–10).
- Linux netem manual: https://man7.org/linux/man-pages/man8/tc-netem.8.html
- Docker bridge network behaviour: https://docs.docker.com/engine/network/drivers/bridge/
- Docker Desktop networking caveats: https://docs.docker.com/desktop/features/networking/
- WebRTC receiver jitter-buffer statistics: https://developer.mozilla.org/en-US/docs/Web/API/RTCInboundRtpStreamStats/jitterBufferDelay
- Microphone permission / secure contexts: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
