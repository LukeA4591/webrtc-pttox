# Research handoff — service worker overhead on WebRTC audio

**Purpose of this file.** Context for continuing the _research design_ conversation
in a browser chat, so the terminal session can stay focused on code. Paste or
upload this whole file into the new chat as its opening context.

**Split of work:**

- **Browser chat (research):** methodology, hypotheses, statistics, literature,
  write-up, supervisor questions.
- **Terminal chat (code):** instrumentation, build configs for the experimental
  conditions, data export, and the app itself.

Anything the browser chat decides that needs code is a request to bring back to
the terminal session. The "Instrumentation still to build" section below is the
current interface between the two.

---

## 1. The project

`webrtc-pttox` — a push-to-talk (PTT) radio client that carries audio over
WebRTC, packaged as an installable PWA. Vue 3 + Vite. It talks to a PTToX server
(Tait), which is external and not modifiable by us.

### Architecture

```
src/
  stores/session.js    Single reactive session: connection, groups, floor, log, devices
  utils/webrtc.js      Signalling socket + RTCPeerConnection; no UI state
  utils/stereoRouting.js  Web Audio panning graph for received audio
  utils/recorder.js    Per-transmission MediaRecorder for instant replay
  pwa.js               Service worker registration and update prompt
  components/          Presentational shell
  views/HomeView.vue   Three-pane layout, remote audio element, output routing
```

`utils/webrtc.js` reports through a callback bag; `stores/session.js` turns those
callbacks into reactive state. Components only read the store.

### Facts that constrain everything

- **The server sends ONE mixed audio track.** All talkgroups are summed before
  they reach the browser. This is the single most important constraint in the
  project and it has already shaped two features (see §2).
- **Half-duplex.** The microphone track stays `enabled = false` until the server
  answers a `floor-request` with `floor-grant`.
- **Signalling** is JSON over WebSocket at `wss://{domain}/api/webrtc/ws`.
- **`new-call` / `end-call`** are inbound transmission events (somebody else
  started or stopped talking), carrying `calling_group_id`. They are not a
  channel roster.
- **Group selection is presentation-only.** `floor-request` carries no group
  field, so the client cannot target transmission at a group. That needs server
  work.
- **There is no authentication yet** (`TODO(auth)` marker in the store).
- **There is no reconnect logic.** `utils/webrtc.js` sets a `reconnecting` state
  on ICE failure and the UI renders "Reconnecting", but nothing actually
  reconnects. Known gap, not yet fixed. Relevant to the study only as a threat to
  long runs — a dropped session will not recover itself.

### Existing measurement infrastructure

`connection.readStats()` in `utils/webrtc.js` reads `getStats()` and returns:

| Field             | Source                                |
| ----------------- | ------------------------------------- |
| `rttMs`           | `candidate-pair.currentRoundTripTime` |
| `jitterMs`        | `inbound-rtp.jitter`                  |
| `packetsLost`     | `inbound-rtp.packetsLost`             |
| `packetsReceived` | `inbound-rtp.packetsReceived`         |

Polled every `STATS_INTERVAL_MS = 3000` from `startStatsPolling()` in the store,
into the `networkStats` ref. This is the backbone the study builds on.

`mediaReady` (boolean ref) flips true when the peer connection has been
negotiated — this is the natural end marker for the "session establishment"
measurement window.

---

## 2. Features already built (context, not part of the study)

Three features exist that are _not_ the research topic but explain much of the
code and the documentation:

- **Stereo routing** (`docs/stereo-routing.md`) — pans received audio per
  transmission so different talkgroups land in different ears. Approximate only,
  because of the single mixed track. Off by default.
- **Per-group mute** (`docs/group-mute.md`) — silences a group's playback for the
  duration of its transmissions. Fails open when groups overlap.
- **Instant replay** (`docs/replay.md`) — records each received transmission to a
  20-clip in-memory buffer via one `MediaRecorder` per call. Off by default.

Each has a restrictions doc because each is limited by the mixed-track
constraint. **None of these are the research subject** — mentioned so the browser
chat understands the codebase and does not propose them as novel.

---

## 3. Research brief

**Prior work by the student:** a question of the form _"How does initial buffer
size in WebRTC affect audio statistics in a PTToX context?"_ — establishing the
preferred shape: one clear independent variable, measurable dependent variables,
and a PTToX context that stops it being generic.

**Brief for this piece:** original, not excessively difficult, ideally touching
the PWA angle (PWA vs traditional website) or headsets.

**Chosen direction: service worker overhead on real-time audio.**

### Options considered and set aside

Recorded so they are not re-proposed, and so they can be revisited if the chosen
question collapses:

| Option                                    | Why set aside                                          |
| ----------------------------------------- | ------------------------------------------------------ |
| PWA backgrounding / session survivability | Strong and low-risk; best fallback                     |
| Bluetooth mic acquisition strategy        | Most original, but needs several headsets              |
| Time-to-talk-ready across install states  | Easiest, most likely to duplicate existing PWA work    |
| Permission persistence across install     | Good pure-PWA option                                   |
| Recovery time after network loss          | Practical, easy                                        |
| Absence of sidetone                       | Very original, but needs human participants (ethics)   |
| Headset class × packet loss interaction   | Needs hardware and intelligibility testing             |
| Spatial separation & monitoring accuracy  | Feature already built, but needs participants (ethics) |
| Floor-grant latency & speech clipping     | Very PTT-specific, needs participants (ethics)         |

**Originality is unverified.** No literature search has been run. This needs
doing before committing — it is the main outstanding risk.

---

## 4. The chosen study

### 4.1 What a service worker is (background)

A service worker is a JavaScript file the browser runs in the background,
separately from any page, with no DOM access. It persists after all tabs close
and across browser restarts. Its main capability is acting as a programmable
network proxy: it intercepts `fetch` events from pages in its scope and can
answer them from a cache. That is what provides offline capability and is one of
the requirements for PWA installability.

Two properties drive this study:

1. **It is aggressively terminated.** The browser kills an idle worker after a
   few seconds and restarts it when an event arrives. Its CPU cost is spiky and
   event-driven, not a constant tax.
2. **It only sees `fetch`.** A service worker **cannot intercept WebSocket
   connections**, and cannot see WebRTC media at all.

### 4.2 Why the naive version of this question fails

In this app, signalling runs over WebSocket and media is SRTP over UDP via ICE.
**Neither touches the service worker.** It handles the app shell and nothing
else.

So measuring steady-state jitter with the worker on versus off, on a desktop,
will find nothing — and that follows directly from the architecture. Avoiding
this trap is the whole design problem.

### 4.3 Where an effect could plausibly hide

Four indirect paths, all transient and localised rather than continuous:

1. **Activation collides with session setup.** `src/pwa.js` registers with
   `immediate: true`, so on a first visit or after an update the worker installs
   and precaches while the page is simultaneously calling `getUserMedia`,
   constructing the `RTCPeerConnection` and running ICE. Real CPU and disk
   contention in a narrow, critical window.
2. **Update checks during a call.** `registerType: 'prompt'` means the
   registration periodically re-fetches the worker script. Landing mid-call wakes
   a terminated worker — new JS context, install logic, possibly precaching —
   while audio flows.
3. **Wake-up cost on weak hardware.** Because workers are killed and restarted
   per event, every wake-up pays context-startup cost. Not free on a low-end
   phone.
4. **Cache Storage / memory pressure.** Precached data is resident; under mobile
   memory pressure that means more eviction and GC activity.

### 4.4 The refined question

> **Under what conditions, if any, does service worker activity measurably
> degrade WebRTC audio performance in a PTT client — and how large would an
> effect need to be for us to detect it?**

The second clause is load-bearing, not padding. See §4.8.

### 4.5 Design: dose-response, not on/off

The key methodological choice. Four conditions of increasing worker workload:

- **C0 — control.** No service worker; `VitePWA` disabled.
- **C1 — current.** Precache only, as shipped: 18 entries, ~187 KiB.
- **C2 — inflated precache.** Padded with several MB of assets so installation
  does real work.
- **C3 — hostile.** Workbox `runtimeCaching` with a network-first strategy plus
  frequent update checks, so the worker is repeatedly woken _during_ the session.

A monotonic degradation across C0→C3 is a dose-response relationship — much
stronger than any two-condition difference. A flat result across all four makes
the null convincing, because it holds even under deliberately hostile config.
**Either outcome is a reportable result**, which is what makes the study safe.

### 4.6 Measurement windows

Averaging across a whole session would wash out a transient effect. Segment:

- **A:** page load → `mediaReady` (negotiation)
- **B:** first 10 s of media
- **C:** steady state, 60 s+
- **D:** during a forced update check

Hypothesis: any effect concentrates in **A** and **D**.

### 4.7 Dependent variables

Already collected: `rttMs`, `jitterMs`, `packetsLost`, `packetsReceived`.

To be added (more sensitive to CPU starvation than jitter is):

- `concealedSamples`, `concealmentEvents` — audio the decoder fabricated to
  cover a gap. The closest available proxy for "the audio pipeline was starved
  of CPU", and the most likely place an effect shows up.
- `jitterBufferDelay` — adaptive buffering responding to instability.
- **Time to `mediaReady`** — primary DV for window A.

### 4.8 The statistical move that decides whether this succeeds

Report the **minimum detectable effect size**. Run enough sessions per condition
to estimate DV variance, then state, e.g.:

> "With 30 sessions per condition we had 80% power to detect a 1.2 ms difference
> in mean jitter; we observed 0.1 ms (95% CI −0.4 to 0.6)."

This converts "we found nothing" into "we bounded the effect below a threshold
far under perceptual relevance." The first is a failed experiment; the second is
a finding. **Do not skip this.** A pilot run is needed to estimate variance
before the real sample size can be chosen.

### 4.9 Confounds and controls

- Interleave conditions rather than blocking them, so network drift cannot align
  with condition. Randomise order.
- Device class as an explicit factor: modern desktop (expect nothing) and a weak
  Android or Chrome DevTools 6× CPU throttling. If an effect exists anywhere, it
  is on constrained hardware.
- Let mobile devices cool between runs; log thermal/battery state if available.
- Warm vs cold cache is a controlled factor, not noise.
- One primary browser — Chromium, Firefox and Safari implement worker lifecycle
  differently. Note the others as a limitation.
- **Run against production builds only.** `vite.config.js` sets
  `devOptions.enabled: true`, so `npm run dev` also registers a service worker.
  Use `npm run build` + `npm run preview`, or C0 will not be a true control.

### 4.10 Honest risks

- Most likely outcome: null for C0–C1, possibly a small effect in C3 on
  throttled hardware. Be at peace with that before starting.
- It is a **validating** contribution — confirming an architectural assumption
  rather than discovering a phenomenon. Some supervisors value this highly;
  others want novelty. **Worth confirming with the supervisor before committing.**
- Enough repetitions are needed for the power calculation to mean anything. Five
  runs will not do.
- Upside: no human participants, so no ethics approval, and the whole thing is
  automatable. Cost is run time, not difficulty.

---

## 5. Current PWA configuration (the thing under test)

From `vite.config.js`:

```js
VitePWA({
  registerType: 'prompt', // operator decides when to reload
  includeAssets: ['favicon-32x32.png', 'apple-touch-icon.png'],
  manifest: {
    /* name, icons, display: 'standalone', ... */
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
    navigateFallback: '/index.html',
    cleanupOutdatedCaches: true,
    navigateFallbackDenylist: [/^\/api\//],
  },
  devOptions: { enabled: true, type: 'module' },
})
```

From `src/pwa.js`: registered via `registerSW({ immediate: true })` with
`onOfflineReady` / `onNeedRefresh` driving an update toast.

Last production build: **18 precache entries, 187.62 KiB**.

Note on `navigateFallbackDenylist: [/^\/api\//]`: sensible defensive config, but
it governs _navigation_ requests. It is not what protects the WebSocket — the
WebSocket is unreachable by a service worker regardless. Belt-and-braces, not
load-bearing. Worth stating correctly in any write-up.

---

## 6. Instrumentation still to build

This is the handoff interface back to the terminal/code session. None of it
exists yet.

- [ ] Extend `readStats()` in `utils/webrtc.js` with `concealedSamples`,
      `concealmentEvents`, `jitterBufferDelay`.
- [ ] Timestamped event markers for the window boundaries: SW registration, SW
      activation, `mediaReady`, first inbound audio, forced update check.
- [ ] A condition flag (env var or query param) selecting C0–C3, recorded in the
      output so runs are reproducible and self-labelling.
- [ ] Four build configurations for C0–C3.
- [ ] CSV/JSON export of the full stats timeline, not just the latest sample —
      the current store keeps only the most recent `networkStats`.
- [ ] Optionally, an automated run harness so sessions can be batched.

---

## 7. Open questions for the browser chat

1. **Literature check.** Has service worker overhead on real-time media been
   measured before? This is the main unverified assumption in the whole plan.
2. **Supervisor appetite** for a validating/null-result contribution — worth
   settling before investing in runs.
3. **Sample size**, once a pilot has produced variance estimates.
4. **Which devices** are actually available, and whether a genuinely weak
   Android can be sourced or whether DevTools throttling has to stand in.
5. **Primary browser** choice and how to frame the single-browser limitation.
6. Whether the write-up frames this as a **PWA** study or a **real-time web**
   study — it changes the related-work section substantially.

---

## 8. Established findings (2026-10-10)

Two facts settled while scoping a service-worker question. Both are independent
of which research question is finally chosen, so they are recorded here rather
than re-derived. The exploratory code and design docs they came from were
scrapped; the question is being re-decided.

### 8.1 Literature check — §7.1 is answered: no prior work

**No published study measures service worker overhead on real-time media.** The
originality concern in §3 is resolved for this direction. Nearest neighbours,
which any related-work section would need to engage:

- **Google Search service worker rollout** — web.dev case study, ~2019. On real
  devices, worker boot time varies widely, and on some low-end phones starting
  the worker takes nearly as long as fetching the page HTML. The strongest
  existing evidence that worker startup is a real cost on weak hardware, and the
  best justification for a constrained-device condition.
  <https://web.dev/case-studies/google-search-sw>
- **arXiv 2509.14583** — isolates a no-op service worker that intercepts a
  request and immediately returns, measuring 60 ms, 180 ms and 160 ms of added
  page-load time across three network profiles. The closest thing to a
  controlled measurement of service worker overhead, but it is wall-clock page
  load rather than media, and the overhead was driven by the prototype's own
  extra network activity.
- **WebRTC audio QoE methodology** — full-reference assessment in *Electronics*
  9(3):462 (<https://doi.org/10.3390/electronics9030462>), ViSQOL v3
  (<https://arxiv.org/pdf/2004.09584>), and the WebRTC-QoE dataset
  (<https://ieee-dataport.org/documents/webrtc-qoe-dataset-quality-experience-audio-video-communications>).
  These supply the measurement apparatus for WebRTC audio under impairment. None
  involves service workers.

### 8.2 A service worker cannot touch this app's signalling or media

Confirmed against the specifications, not just inferred from §4.2:

- **The WebSocket handshake is excluded from service worker interception by the
  Fetch standard**, and there is a web-platform test asserting the handshake
  never surfaces as a `fetch` event.
- **WebRTC media is unreachable entirely.** SRTP over UDP via ICE never produces
  a `fetch` event. The W3C discussions touching workers and `RTCPeerConnection`
  concern *exposing* the API inside workers, not interception.

Consequences for any future service-worker question:

1. There is **no direct causal path**. Any real effect must be indirect — CPU,
   disk or memory contention from install, wake-up and cache writes. The honest
   claim is about contention, which is far narrower than "service workers affect
   media output".
2. **A two-level on/off design cannot work**, because it has no dose with which
   to show contention is the mechanism. This is why §4.5 uses C0–C3.
3. **"Standard browser vs installed PWA" is confounded** and was rejected: a tab
   and an installed PWA differ in service worker presence, display mode,
   renderer/process allocation, cache warmth, and on Android media focus policy,
   all at once. The IV in that question is *service workers*; the IV in that
   design is *install state*. A difference could not be attributed and a null
   could not be interpreted. If a service-worker direction is kept, vary worker
   *workload* as a dose and treat install state as a labelled secondary factor.
4. **Steady-state jitter is the wrong primary DV** — it is network-determined and
   flat by construction, which is precisely why a naive design finds nothing.
   `concealedSamples / totalSamplesReceived` is the better primary measure.

### 8.3 Two implementation facts, if measurement code is rebuilt

- **A remote WebRTC stream routed only through Web Audio is not pulled by
  Chrome.** `jitterBufferEmittedCount` and `totalSamplesReceived` never advance,
  so every concealment metric silently reads `null` while packets still arrive.
  It must be attached to an `<audio>` element at `volume = 0` — not `muted`,
  which can stop playout and zero the counters being measured.
- **`src/pwa.js` breaks the build when `VitePWA` is absent.** Its
  `virtual:pwa-register` import is dynamic and runtime-guarded, but still fails
  build-time module resolution, so a no-service-worker control condition needs
  that specifier stubbed. Worth knowing before anyone tries to build the app
  without the PWA plugin.
