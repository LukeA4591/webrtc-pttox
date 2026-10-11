# Local PTT Server and RQ2 Test Rig — Implementation Specification

**Status:** Implementation handoff (not yet implemented)  
**Last revised:** 10 October 2026  
**Purpose:** Reproduce controlled WebRTC receive-side jitter-buffer experiments without Hydra. Retain the existing Tait WebRTC receiving client.

## 1. The agreed setup (do not redesign)

There are **two computers**:

- **Computer 1 (sender + server):** Runs a _new browser-based transmitter_ and a _new minimal Python PTT media server_. The transmitter can play a prerecorded speech file or use a microphone. The server grants/releases the PTT floor and forwards its received audio to the receiver through a **second WebRTC connection**.
- **Computer 2 (receiver):** Runs the **existing `webrtc-pttox` client** in Chrome. Add only research instrumentation and minimal local signalling compatibility. Do not replace its audio receiving/playout code.

**Netem must be applied only to the server's outgoing WebRTC UDP traffic toward Computer 2.** It is not run inside JavaScript or on the sender's audio file. Place it on the Linux interface _after the server's WebRTC packetisation/encryption and before those packets leave for the receiver_.

```text
COMPUTER 1                                                  COMPUTER 2
┌────────────────────────────┐                              ┌────────────────────────────┐
│ Browser A (new transmitter)│                              │ Browser B (existing client)│
│  - microphone or WAV       │                              │  - incoming WebRTC audio   │
│  - PTT hold/release        │                              │  - jitterBufferTarget      │
│  - floor-request/grant     │                              │  - record + getStats()     │
└────────────┬───────────────┘                              └──────────────▲─────────────┘
             │ WebRTC media + WebSocket signalling                         │
             ▼                                                            │
┌──────────────────────────────────┐                                       │
│ Local Python PTT server (new)    │                                       │
│  - signalling both browser peers│                                       │
│  - single shared floor owner    │                                       │
│  - receives A's audio           │                                       │
│  - forwards to B / sends silence│                                       │
│  - emits its own WebRTC RTP     │                                       │
└─────────────────┬────────────────┘                                       │
                  │ Server → Browser B UDP                                 │
                  ▼                                                        │
           [ tc netem on Linux ] ───── impaired WebRTC UDP ────────────────┘
           (server-to-receiver ONLY)
```

**Important:** This is not peer-to-peer browser-to-browser audio, not a signalling-only relay, and not a full PTToX/Hydra implementation. It is a small **two-leg WebRTC media bridge with basic PTT floor control**.

## 2. Networking and operating system — decide this before coding

The sender and the server are on the **same physical computer**; the receiver is on **another computer**. Do not assume the server's Linux network namespace shares macOS networking.

- `tc netem` runs on **Linux only**. If Computer 1 is a native Linux machine, run the Python server there and apply netem to the actual egress network interface. Browser A can run on the same machine.
- **If Computer 1 is a Mac (likely):** run the Python server in a **Linux VM** with a network configuration that gives it a reachable IP/UDP path from _both_ browsers. Prefer a bridged LAN connection if the hypervisor/network adapter supports it. Browser A can run as normal Chrome on the Mac; the Linux VM is still on the _same physical computer_. The receiver runs on a separate computer.
- Docker Desktop is an optional advanced alternative, **not the default**: container host ICE candidates and dynamic UDP port access across Docker Desktop NAT can break even when WebSocket signalling succeeds. Do not use a Docker setup unless browser-to-server ICE connectivity is proven in both directions.
- Serve Browser A's page on `http://localhost` on Computer 1 (secure context for mic capture). Serve/open Browser B's existing app on `http://localhost` on Computer 2 for local testing (or HTTPS with trusted WSS). Browsers should connect to the server's reachable LAN IP for signalling and ICE media.
- Existing receiver `wss://` construction needs a **development-only** `ws://` override for a locally hosted HTTP page; an HTTPS-hosted receiving page must use valid `wss://`.
- Do not start building research automation until each peer's ICE candidate-pair addresses are confirmed reachable. The VM must advertise an IP the remote receiver can actually reach, and UDP must work, not merely TCP/WebSockets.

**Connection validation:** both browsers reach `connected`/`completed`, receive live audio, and the selected WebRTC candidate pair uses the intended Linux server route. On the Linux server run `ip route get RECEIVER_IP` to identify the correct egress interface.

## 3. Keep the software minimal

### A. Transmitter — new browser page

Provide:

1. Source selection: **pre-recorded WAV** or **microphone**.
2. Start/connect/disconnect controls and a visible media/ICE status.
3. A hold-to-talk button (mouse/touch/keyboard optionally). It sends `floor-request`; on `floor-grant`, begins sending audible speech; on release sends `floor-release` and stops sending speech (silence while idle is acceptable).
4. For a WAV source, a deterministic **start-from-beginning on grant** and an optional loop for long RQ2 trials. Use Web Audio (`AudioBufferSourceNode` → `MediaStreamAudioDestinationNode`) to provide a native browser `MediaStreamTrack` to WebRTC. Log source file name/hash and start event.
5. Use browser WebRTC, Opus and one audio transceiver. The transmitter is a **WebRTC peer of the Python server**, not of Browser B.
6. Prefer a simple offerer role for Browser A; the server can answer A's offer. ICE candidate exchange must work over LAN.

For real experiments, use the **same prerecorded speech** for every trial. Microphone mode is for manual end-to-end functional testing, not the quantitative RQ2 comparison.

### B. Server — new Python `aiortc` + WebSocket application

Implement only:

1. Exactly two logical peers: **transmitter A** and **existing receiver B**. Keep one `RTCPeerConnection` per browser. Use `websockets` (or equivalent) for signalling.
2. WebSocket endpoint `/api/webrtc/ws` for B, matching the existing client. For A, use the same endpoint with an explicit `?role=sender` or a separate `/sender` WebSocket endpoint. Identify peers **by role**, not by arrival order.
3. SDP and ICE signalling. **B is an answerer**, so the server must generate and send B its initial `offer`. A can initiate its own offer; the server answers.
4. A minimal floor-control state machine: `floor-request`, `floor-grant`, `floor-deny`, `floor-release`. Only **one** peer owns the floor; grant if free, otherwise deny; release also occurs when the holder disconnects. Enforce permission at the server, not just by trusting client-side muting.
5. Receive A's incoming audio as a decoded aiortc track; supply B with **one persistent outgoing audio track** which consumes A's audio while A holds the floor, or generates silence otherwise. Keep both RTCPeerConnections alive across floor changes. `MediaRelay` can assist, but may not alone handle floor switching and silence generation; implement a small continuous/gated track if necessary.
6. Optionally support B transmitting back to A using the same shared floor rule, **after** A→B and RQ2 are working. No requirement to implement channels, groups, auth, radio gateways, audio mixing or a production-grade SFU.
7. Timestamp and log every floor event, connection-state transition and codec negotiation; provide health/status diagnostics. Avoid introducing an unnecessary queue or buffer on the server's outgoing media leg.

**Media fidelity caveat:** `aiortc` media-track relaying normally receives decoded frames and sends newly encoded RTP on the other leg. It is **not packet-transparent** and it is not Hydra. This is acceptable here because netem is imposed **after** the server has generated its own outgoing WebRTC packets, so B's native Chrome jitter buffer sees actual late/lost packets. Record the negotiated codec and acknowledge the local-server limitation in the report. Do not promise unchanged RTP sequence numbers, timestamps or bytes from A to B.

### C. Receiver — existing `webrtc-pttox` app

> **STATUS: ITEMS 1 AND 3–6 IMPLEMENTED — not work for the Linux-side
> implementer. ITEM 2 IS OUTSTANDING.**
> Implemented in the receiver repository on Computer 2, in `src/research/`
> (self-contained; removable via `rm -rf src/research` plus one marked line in
> `src/main.js`):
>
> - **Item 1 — `ws://` compatibility.** A toggle, on by default, that rewrites
>   the hardcoded `wss://` to `ws://` **only** for loopback, RFC1918 and
>   link-local addresses and local-only TLDs, so a public host can never be
>   downgraded. It also collapses a duplicated `/api/webrtc/ws` path, which is
>   what happens when a full URL is pasted into the server field — that field
>   wants a **bare host**, e.g. `192.168.88.4:8080`. The panel displays the
>   effective URL, which is the fastest way to diagnose a failed connection.
>   Verified connecting to a live local server on 10 October 2026.
> - **Items 3–6** — a `jitterBufferTarget` control in ms reporting requested
>   _and_ achieved delay; a `getStats()` timeline at **50 ms**, the real floor,
>   since libwebrtc caches stats reports for 50 ms and faster polling returns
>   duplicate reports with identical timestamps; continuous received-audio
>   recording; per-trial export of stats CSV, metadata JSON and audio, saved on
>   stop. Void-trial detection (playout counters not advancing) and
>   `null`-preserving counters are included.
>
> **Item 2 (ICE gathering / trickle) is NOT implemented.** It is a Phase 1
> interop decision — see constraint **C5** in Appendix A. The receiver still
> sends an answer with no candidates, so the server must connect via
> peer-reflexive discovery.
>
> The rest is retained here as **reference for what the receiving end expects
> and produces**. Do not re-implement it.

Keep its production receiving path. Provide **dev/research mode only** for:

1. Local signalling URL / `ws://` compatibility as required; preserve production `wss://` defaults.
2. SDP/ICE: it only constructs an `RTCPeerConnection` upon inbound `offer`. Make candidate gathering reliable (either wait for ICE gathering before the answer, or implement trickle ICE). Its inbound `candidate` parser expects **snake_case** `sdp_m_line_index`, `sdp_mid`, `username_fragment`; translate from Chrome camelCase where appropriate.
3. A visible control for `RTCRtpReceiver.jitterBufferTarget` with units explicitly **milliseconds** (e.g. browser default, 50, 100, 200, 400). Apply to the inbound audio receiver and record both the requested setting and the actual achieved delay.
4. An audio `getStats()` timeline every 1 second. Record raw counters, avoid converting missing values to zero. Minimum: `packetsReceived`, `packetsLost`, `packetsDiscarded`, `jitter`, `concealedSamples`, `silentConcealedSamples`, `totalSamplesReceived`, `jitterBufferDelay`, `jitterBufferEmittedCount`, `jitterBufferTargetDelay` (if supported), selected ICE pair, codec, connection status.
5. Record the **incoming received stream** continuously for one trial (e.g. WebM) and export WAV/PCM only if waveform analysis needs it. Export CSV + JSON (or one JSON with metadata) and the audio file per trial.
6. **Verify audio is actually playing** via the app's `<audio>` element. `jitterBufferEmittedCount` and `totalSamplesReceived` must increase; zero or absent playout counters invalidate that trial.

Derived statistics from **end-minus-start counter deltas**:

```text
Achieved mean jitter-buffer delay (ms)
  = 1000 * ΔjitterBufferDelay / ΔjitterBufferEmittedCount

Concealment proportion
  = ΔconcealedSamples / ΔtotalSamplesReceived

Packet loss fraction
  = ΔpacketsLost / (ΔpacketsLost + ΔpacketsReceived)
```

Use only when the fields and denominators are valid. Interpret received audio recordings alongside these counters; a `MediaRecorder`-encoded WebM is not a bit-identical capture of the decoded PCM signal.

## 4. Netem placement and control — most important requirement

`tc netem` operates on the **Linux server's outgoing network interface toward Computer 2**. It should affect **server → existing receiver WebRTC UDP**, not sender → server traffic.

Since Browser A and the server are on the _same computer_, a blanket outbound netem rule could also disturb unrelated traffic, especially if a VM/router setup is used. The actual experiment must **filter the receiver's destination IP and UDP**. Because Browser B is on a different computer, its destination IP should be distinct from Browser A's local address.

Example **inside the Linux VM/server**, after peer connections are established (adjust IP/interface):

```bash
RECEIVER_IP=192.168.1.55
IFACE=eth0   # Confirm via: ip route get "$RECEIVER_IP"

# Route traffic into three priority bands; attach netem only to band 3.
sudo tc qdisc replace dev "$IFACE" root handle 1: prio bands 3
sudo tc qdisc replace dev "$IFACE" parent 1:3 handle 30: \
  netem delay 100ms 20ms distribution normal loss 3%

# Only UDP destined for the receiving computer is impaired.
sudo tc filter add dev "$IFACE" parent 1: protocol ip prio 1 u32 \
  match ip protocol 17 0xff \
  match ip dst "$RECEIVER_IP"/32 \
  flowid 1:3

sudo tc -s qdisc show dev "$IFACE"
sudo tc -s filter show dev "$IFACE" parent 1:

# Restore normal networking
sudo tc qdisc del dev "$IFACE" root
```

`tc netem` acts on **egress** traffic only. A UDP destination filter also affects STUN/DTLS on that path, so apply impairment only once the session is established, and record any ICE restart/path changes. For finer isolation, additionally match the receiver's **actual selected UDP port** (after checking the ICE candidate pair). Do not assume all UDP packets to the receiver are audio.

Build repeatable scripts:

- `scripts/netem-apply.sh`: selected condition (delay/jitter/loss) + receiver IP/interface.
- `scripts/netem-clear.sh`: remove qdisc safely.
- `scripts/netem-status.sh`: show matching counters and active configuration.

**Proof netem is on the right path:**

- B's selected remote ICE candidate is the Linux server's reachable IP.
- The server sends a continuous known audio signal while the floor is granted.
- Matching `tc -s` counters increase during transmission.
- A deliberately extreme impairment (e.g. 300 ms delay, 10% loss) clearly changes B's `getStats()` and/or received audio compared with baseline.
- Clearing netem returns measurements toward baseline. If not, stop and investigate before accepting any research data.

Jitter in netem can also cause packet reordering; document this or record reordering explicitly if it influences the findings.

## 5. Connection / signalling order

1. Launch Python server with reachable WebSocket and media/ICE addresses.
2. Connect Browser A in transmitter role, establish A↔server WebRTC track.
3. Connect Browser B using its existing application: server sends an `offer` with a **single audio m-line**, `sendrecv` if B's mic is required. B obtains its mic and answers; complete ICE.
4. Server always has an outbound B audio track available (silence when idle). Never renegotiate on each PTT press.
5. Browser A requests floor; server grants if available. A starts WAV playback or mic speech; server forwards that speech to B.
6. A releases floor; server returns B's outgoing track to silence. Both peer connections remain connected.
7. Apply server-egress netem for RQ2 trials and configure B's jitter-buffer target. Use long enough transmissions to reach a stable media state before the measurement interval.

Mirror the existing receiver protocol: `offer`, `candidate`, `floor-grant`, `floor-deny`, optionally `new-call`/`end-call`, plus `answer`, `floor-request`, `floor-release`. **Exact field names, message shapes and the ten hard constraints are in Appendix A, which is normative — do not guess them.** Accept `cc_port: 0` for local testing. A is purpose-built and can use the same floor messages.

## 6. Build phases — do not jump ahead

**Phase 1 — Local functional test (no netem).**

- Create server and simple sender page.
- Get A↔server WebRTC connected with WAV, then server↔existing B client connected.
- Verify B hears WAV, and A's PTT button triggers server floor grant/release with actual server-side gating.
- Verify live mic also works on A. Keep speech/audio source switching simple.
- Record B's selected ICE candidate pair and the server's codec.

**Phase 2 — Linux netem networking.**

- Move/run the Python server in a reachable Linux environment on Computer 1.
- Confirm real browser WebRTC UDP reaches Computer 2.
- Implement selective server-egress impairment, `clear`, and status commands.
- Verify matching packet counters and receiver statistics under severe and baseline conditions.

**Phase 3 — RQ2 instrumentation.**

- Add dev-only `jitterBufferTarget` (ms), per-second `getStats()` logging and received-audio recording in existing B client.
- Export matching CSV/JSON/audio, with network settings, ICE pair, audio identity, trial timing, and Chrome versions.
- Compare only trials within the new setup; do not pool absolute measurements with prior Hydra trials.

**Phase 4 — Repeatable experiments.**

- Use same prerecorded speech, fixed trial duration, same codecs/browser versions.
- Establish the media connections and floor first; then start the measured window and apply the selected netem condition.
- Repeat and randomise the order of the planned network × jitter-buffer combinations. Include an unmodified baseline.
- Exclude trials with ICE path changes, stalled playout counters or missing data.

## 7. RQ3 future-proofing — not an RQ3 instruction

In the new transmitter, permit the test harness to **gate/stop/resume source audio at known timestamps** while **keeping the same WebRTC connections alive**. Log floor request, grant, first audio sent, release and the receiver's corresponding events when available. This gives future experiments control over intermittent PTT speech and floor timing without modifying the architecture. **Do not implement an RQ3 experiment yet.**

## 8. Strict non-goals

- Do not recreate Hydra's full proprietary protocols or claim this is an exact Hydra replica.
- Do not build a production SFU, RTP packet-transparent relay or audio mixing engine.
- Do not insert packet loss before the server for RQ2.
- Do not replace the receiver with another Python peer, a different Chrome test page or an artificial metrics generator.
- Do not implement advanced talkgroups, authentication, call history, presence, or multi-party routing.
- Do not overbuild Docker networking before the basic two-leg audio and floor control work.

## 9. Acceptance criteria

- [ ] A new browser transmitter can use a WAV file **and** a real mic.
- [ ] A and B establish **separate** real WebRTC connections to the Python server.
- [ ] The server grants, denies and releases one PTT floor and enforces it on forwarded audio.
- [ ] Existing Browser B hears transmitted speech; silence is sent when nobody has the floor.
- [ ] Server outgoing UDP to B travels through the chosen Linux netem interface, proven by ICE route and traffic counters.
- [ ] Severe netem impairment changes B's incoming WebRTC playout stats; clearing netem restores baseline behaviour.
- [ ] B's jitter buffer setting is in **ms**, with both requested and achieved delay reported.
- [ ] B exports a continuous received-audio recording, per-second stats, and reproducible metadata for each trial.
- [ ] Existing production behaviour remains intact; all local-server and research changes are guarded or isolated.

**Done means:** a repeatable `Browser A (same machine as Python server) → Python PTT bridge → Linux netem → existing Browser B (other computer)` experiment, using real WebRTC on both legs, basic PTT floor control, and valid receiver-side RQ2 measurements.

## 10. Reference documentation

- aiortc MediaRelay and recorder helpers: https://aiortc.readthedocs.io/en/latest/helpers.html
- Linux `tc-netem`: https://man7.org/linux/man-pages/man8/tc-netem.8.html
- `jitterBufferTarget` (milliseconds, preferred target): https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget
- `jitterBufferDelay` stats: https://developer.mozilla.org/en-US/docs/Web/API/RTCInboundRtpStreamStats/jitterBufferDelay

---

# Appendix A — Receiver wire contract (normative)

Extracted verbatim from `src/utils/webrtc.js` in the receiver repository on
10 October 2026. **This appendix is normative: where it disagrees with the prose
above, follow this.** It exists because an implementer working from an empty
folder has no access to the receiver source, and the sections above name
behaviours without giving field names or message shapes.

Endpoint, built at `src/utils/webrtc.js:65`:

```
wss://{domain}/api/webrtc/ws
```

There is **no query string and no path variation**. See constraint C2.

## A.1 Server → receiver

### `offer` — sent unprompted, first, immediately on connection

```json
{ "type": "offer", "sdp": "v=0\r\no=- ...\r\n" }
```

The parsed message object is passed straight to `setRemoteDescription`, so extra
fields are tolerated and ignored.

### `candidate` — **snake_case**

```json
{
  "type": "candidate",
  "candidate": "candidate:1 1 UDP 2122260223 192.168.1.42 51820 typ host",
  "sdp_m_line_index": 0,
  "sdp_mid": "0",
  "username_fragment": "a1b2c3d4"
}
```

camelCase **breaks ICE outright** — see C7. May be omitted entirely if the
offer's SDP already carries the server's candidates (aiortc gathers before
`setLocalDescription` resolves, so it normally does).

### `floor-grant` / `floor-deny` — no required fields

```json
{ "type": "floor-grant" }
```

```json
{ "type": "floor-deny" }
```

`floor-grant` sets the receiver's microphone track `enabled = true`;
`floor-deny` and `floor-release` set it `false`. The whole message is handed to
the application callback, so additional fields are safe but unused.

### `new-call` — the only source of `cc_port`

```json
{
  "type": "new-call",
  "call_id": "call-0001",
  "calling_group_id": "group:PMR-1",
  "calling_user_alias": "Transmitter A",
  "calling_user_id": "user-a",
  "web_rtc_port": 24000
}
```

`web_rtc_port` is copied into the receiver's session-scoped `cc_port` and
**retained after the call ends**. All fields are optional in the sense that the
receiver reads them defensively, but `calling_group_id` drives the talkgroup
sidebar and `web_rtc_port` is the only way `cc_port` ever becomes non-zero.

### `end-call`

```json
{ "type": "end-call", "call_id": "call-0001" }
```

### Unknown types

Logged as `Unhandled message type "<x>"` and otherwise ignored. Extra server
messages are harmless.

## A.2 Receiver → server

### `answer`

```json
{ "type": "answer", "sdp": "v=0\r\no=- ...\r\n" }
```

Sent once, immediately after the offer is processed. See C5 and C10.

### `floor-request` / `floor-release`

```json
{
  "type": "floor-request",
  "participant_id": "Rock",
  "ssrc": 1234567890,
  "cc_port": 0
}
```

```json
{
  "type": "floor-release",
  "participant_id": "Rock",
  "ssrc": 1234567890,
  "cc_port": 0
}
```

- `participant_id` is the hardcoded string `"Rock"` (`src/utils/webrtc.js:23`).
- `ssrc` is read from the receiver's own `outbound-rtp` stats and is **`null`
  until media is flowing**.
- `cc_port` is **`0` until a `new-call` has been received**. Accept it.

### `candidate` — only if trickle is enabled

The receiver does not send candidates as shipped (C5). If trickle is added, the
natural implementation emits `RTCIceCandidate.toJSON()`, which is **camelCase**
(`sdpMLineIndex`, `sdpMid`, `usernameFragment`). Accept both casings inbound.

## A.3 Hard constraints

| #       | Constraint                                                                                                                                                                                                                           | Consequence if violated                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1**  | The receiver sends **nothing** on WebSocket open — no hello, no register. The server must send the `offer` unprompted.                                                                                                               | Waiting for a first message from B deadlocks: both sides sit idle with the socket open.                                                                                                                   |
| **C2**  | The receiver's URL carries no query string, so it cannot self-identify. Identify **A by its explicit `?role=sender` (or `/sender` endpoint) and treat a connection with no role marker as B.**                                       | Identifying by arrival order breaks on reconnect or reload.                                                                                                                                               |
| **C3**  | `receiveOffer()` awaits `getUserMedia` **before** `createAnswer()`. No microphone, or a non-secure context, throws and **no answer is ever sent**.                                                                                   | Looks exactly like a signalling bug. The single most likely way this handoff stalls.                                                                                                                      |
| **C4**  | The receiver constructs `new RTCPeerConnection()` with **no `iceServers`** — host candidates only, no STUN, no TURN.                                                                                                                 | The server must be reachable at an address B can see as a host candidate. Decides the §2 VM/LAN networking choice. Also means a `relay` candidate pair is impossible, which is a useful bypass invariant. |
| **C5**  | The receiver has **no `icecandidate` listener** and sends the answer immediately, so **the answer normally contains zero candidates**. The server must tolerate an empty remote candidate list, relying on peer-reflexive discovery. | ICE stalls at `checking` in Phase 1, before the receiver-side trickle fix exists.                                                                                                                         |
| **C6**  | **One audio m-line, Opus, `sendrecv`.** The receiver adds its own microphone track to the same connection. **Amended for RQ3:** the offer also carries one `m=application` SCTP section for the run's floor data channel (`--floor-channels reliable\|unreliable`); the receiver mirrors it in the answer. Never two data channels on one connection.                      | A recvonly offer, or a second *audio* m-line, is untested against this client. Without the data section the RQ3 channel is created client-side and never opens.                                            |
| **C7**  | Inbound `candidate` fields must be **snake_case**. The receiver destructures `sdp_m_line_index` / `sdp_mid` / `username_fragment` and then explicitly overwrites the camelCase keys with `undefined`.                                | `addIceCandidate` throws `TypeError` when both `sdpMid` and `sdpMLineIndex` are absent. ICE fails completely. The receiver repo's own README documents the camelCase form and is **wrong**.               |
| **C8**  | The scheme `wss://` is hardcoded.                                                                                                                                                                                                    | A local `ws://` server is unreachable without the dev-mode override noted in §3C.1.                                                                                                                       |
| **C9**  | There is **no reconnect logic**. On ICE failure the UI shows "Reconnecting" but nothing reconnects; a closed socket tears the session down permanently.                                                                              | A dropped session will not recover itself. Any trial spanning a drop is void and must be restarted manually.                                                                                              |
| **C10** | `send()` defaults a **missing** `type` to `"candidate"`.                                                                                                                                                                             | If the answer ever arrives labelled `candidate`, this is why. **Log every inbound frame verbatim before parsing** — it turns this into a one-minute diagnosis.                                            |

## A.4 Expected connection trace

A correct Phase 1 run, in order:

1. B opens the WebSocket. **B sends nothing.**
2. Server sends `offer` (one audio m-line, `sendrecv`, Opus, candidates in SDP).
3. B prompts for / acquires the microphone. _If this fails, the trace stops here
   with no answer — see C3._
4. B sends `answer`, typically **with no candidates** (C5).
5. ICE completes via peer-reflexive discovery; B reports `connected`.
6. Server's outbound track is live (silence while no one holds the floor).
7. A presses PTT → `floor-request` → server grants → B hears speech.
8. B's `totalSamplesReceived` and `jitterBufferEmittedCount` increase. **If they
   do not, B is not playing out and every jitter-buffer measurement is void.**
