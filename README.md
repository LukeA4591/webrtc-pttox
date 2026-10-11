# webrtc-pttox

A push-to-talk radio client that carries audio over WebRTC, packaged as an
installable progressive web app.

## Architecture

```
src/
  stores/session.js    Single reactive session: connection, channels, floor, log, devices
  utils/webrtc.js      Signalling socket + RTCPeerConnection; no UI state
  pwa.js               Service worker registration and update prompt
  components/          Presentational shell (header, sidebar, PTT, tools, log)
  views/HomeView.vue   Three-pane layout, remote audio element, output routing
```

`utils/webrtc.js` reports everything through a callback bag; `stores/session.js`
turns those callbacks into reactive state. Components only read the store, which
keeps the signalling layer testable without mounting anything.

### Servers and groups

**Servers** live in the header dropdown — select, add, or remove. The last
server cannot be removed, and removing the live one disconnects first.

**Groups** (talkgroups) fill the sidebar. They are seeded from
`calling_group_id` on inbound traffic and can also be added by hand; both are
persisted, so a group does not vanish when a transmission ends. Identity is the
bare name, so `group:PMR-1` and a hand-typed `PMR-1` are the same entry.

Group selection is **presentation only** at present. `floor-request` carries no
group field, so selecting a group changes highlighting and what the receiving
banner reflects — it does not target transmission. Adding real targeting needs a
server-supported field on the floor request.

`new-call` and `end-call` are **inbound transmission events** — they mean
somebody else started or stopped talking. They drive the "receiving" indicator
and refresh a group's last-heard time. Treating them as a channel roster is
wrong in two ways: the entry vanishes the moment the speaker releases, and
gating transmission on one means you can only talk while somebody else already
is.

### Audio controls

- **Output volume and mute** apply to the `<audio>` element, so they work on
  every browser regardless of `setSinkId` support. Volume is persisted; mute is
  not. Raising the slider off zero clears an active mute.
- **Microphone mute** is a hard block: it disables PTT, releases the floor if
  held, and is deliberately **not persisted** — a mute that silently survives a
  reload is a safety hazard on a radio system.
- **Stereo routing** puts groups in different ears. Off by default; when on, the
  remote stream runs through a `StereoPannerNode` whose position moves per
  transmission using `calling_group_id`. It only approximates per-group routing
  — the server sends one mixed track, so simultaneous groups cannot be
  separated. Restrictions in [docs/stereo-routing.md](docs/stereo-routing.md).
- **Per-group mute** silences a group without removing it from the sidebar.
  Playback only, and it fails open — overlapping traffic from an unmuted group
  still gets through, because the track is mixed.
  See [docs/group-mute.md](docs/group-mute.md).
- **Instant replay** records each received transmission to a 20-clip in-memory
  buffer so a missed call can be played back. Off by default; clips never leave
  the device and do not survive a reload.
  See [docs/replay.md](docs/replay.md).
- **Microphone test** runs a local `AnalyserNode` level meter. It never touches
  the peer connection and nothing is transmitted; PTT is disabled while it runs.
  The RMS-to-meter scaling is `levelFromTimeDomain`, exported so it can be
  tested without a live microphone.

### Push to talk

Hold the button or the space bar. Press sends `floor-request`; release sends
`floor-release`. This works whenever the media session is up, independent of any
inbound call.

Floor messages carry `ssrc` and `cc_port`, both session-scoped:

- `ssrc` is read from our own `outbound-rtp` stats once media flows.
- `cc_port` arrives as `web_rtc_port` on `new-call` and is **retained after the
  call ends**, since that message is the only place the server sends it. Until
  the first inbound call it is `0` — see the caveat below.

The microphone track stays `enabled = false` until the server answers with
`floor-grant`, and is muted again on release, on window blur, on tab hide, and
on unmount — the mic is never open without the floor.

> **Unverified:** whether the server accepts `cc_port: 0` for a floor request
> made before any inbound call has been seen. If a first transmission on a fresh
> connection is denied but later ones succeed, that is the cause, and the port
> needs to come from somewhere earlier in the handshake.

### Authentication

There is none yet. The header shows a locally stored display name and "Log out"
clears local settings and disconnects. When the server exposes authentication,
the token belongs in `stores/session.js` (see the `TODO(auth)` marker) and gets
attached to the signalling URL in `utils/webrtc.js`.

### PWA

`vite-plugin-pwa` generates the manifest and service worker. Updates use
`registerType: 'prompt'` so a new version never swaps itself in mid-call — the
operator gets a toast and chooses when to reload. Note that `getUserMedia`
requires a secure context, so the app must be served over HTTPS (or localhost).

## WebSocket signalling

Exchanging SDP and ICE candidate messages between the server and the client is
done via JSON messages sent over WebSocket. The general form is:

```json
{
  "type": "offer",
  "sdp": "v=0\r\no=..."
}
```

```json
{
  "type": "answer",
  "sdp": "v=0\r\no=..."
}
```

```json
{
  "type": "candidate",
  "candidate": "candidate:1 1 UCP 82376482376 ...",
  "sdpMLineIndex": 0,
  "sdpMid": 0,
  "usernameFragment": "lsdkfjlsj"
}
```

| Message type  | Example                                                                                                                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDP Offer     | `{"type": "offer", "sdp": "v=0\r\no=mozilla...THIS_IS_SDPARTA-99.0 380779812234976599 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 02:08:8B:13:A8:1D:50:1D:E9:32:B1:6A:07:2A:26:6B:78:DB:5B:6C:55:25:64:B9:6F:A5:84:1B:7C:32:72:94\r\na=ice-options:trickle\r\na=msid-semantic:WMS *\r\n"}`   |
| SDP Answer    | `{"type": "answer", "sdp": "v=0\r\no=mozilla...THIS_IS_SDPARTA-99.0 8882682929500653640 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 7D:5F:49:AC:19:AE:EB:25:BF:A8:DE:0F:93:A6:19:70:8F:18:89:A7:5E:DF:66:8D:AD:46:2F:22:56:7B:46:78\r\na=ice-options:trickle\r\na=msid-semantic:WMS *\r\n"}` |
| ICE Candidate | `{"type": "candidate" , "candidate":"candidate:1 1 TCP 2105524479 17722e78-9ea0-4350-98e9-336196762da8.local 9 typ host tcptype active","sdpMLineIndex":0,"sdpMid":"0","usernameFragment":"2f1170b5"}`                                                                                                     |

## Project Setup

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Compile and Minify for Production

```sh
npm run build
```

### Run Unit Tests with [Vitest](https://vitest.dev/)

```sh
npm run test:unit
```

### Run End-to-End Tests with [Cypress](https://www.cypress.io/)

```sh
npm run test:e2e:dev
```

This runs the end-to-end tests against the Vite development server.
It is much faster than the production build.

But it's still recommended to test the production build with `test:e2e` before deploying (e.g. in CI environments):

```sh
npm run build
npm run test:e2e
```

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```
