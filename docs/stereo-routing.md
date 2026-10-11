# Stereo routing

Send different talkgroups to different ears — PMR-1 on the left, everything else
on the right — so an operator monitoring several groups can tell them apart
without reading the screen.

Turn it on in **Tools → Stereo routing**. Each group then gets an **L / C / R**
selector in the sidebar, and the **Other groups** selector in the Tools card is
the ear used by every group you have not pinned. That pairing is what produces
"one group in one ear, everything else in the other".

It is **off by default**. When off the remote stream goes straight to the
`<audio>` element with no Web Audio graph in the way, which is the most robust
playback path this app has. Everything below is a reason to leave it that way
unless the separation is actually wanted.

## What it actually does

Not what the UI implies. Read this before relying on it.

The server sends **one mixed audio track**. Every group is already summed
together by the time the browser sees it, so there is nothing to split — no
amount of client work can pull two groups apart once they are in the same PCM
stream.

What the client does instead is **pan the whole stream, and move the pan between
transmissions**. `new-call` carries `calling_group_id`, so at the moment a
transmission starts we know which group it belongs to and swing the panner to
that group's ear. PTToX is half-duplex, so one group talks at a time and the
result is indistinguishable from real per-group routing.

The audio path when routing is on:

```
remote track → MediaStreamAudioSourceNode → StereoPannerNode
             → MediaStreamAudioDestinationNode → <audio> element
```

Playback deliberately still ends at the `<audio>` element rather than leaving
the AudioContext, so output volume, mute and `setSinkId` keep working exactly as
they did before.

Code: `src/utils/stereoRouting.js` (the graph), `src/stores/session.js` (which
ear is live), `src/views/HomeView.vue` (wiring).

## Restrictions

### Simultaneous groups cannot be separated

This is the fundamental one. If two groups transmit at once, their audio is
already mixed in the single remote track and only one pan position can apply.
The client uses the **most recent** `new-call`, so overlapping traffic ends up
wherever the newer group is assigned — including the older group's audio.

The store tracks concurrent calls as a list so that a stale `end-call` cannot
wrongly clear the indicator, but that only fixes the display. The audio itself
is unrecoverable.

### Bluetooth headsets lose separation entirely

When a Bluetooth device's microphone is in use the link drops from A2DP stereo
to the HFP/HSP mono profile. Both ears then get the same mono mix and panning
does nothing — and on a push-to-talk app the mic is in use exactly when it
matters. Wired headphones, or headphones with a separate microphone, are
unaffected.

The Tools card shows a note when no headphones are detected, but that detection
is a label match (`headphonesConnected` in `src/stores/session.js`) and will not
catch every device.

### Panning is 70%, not hard left/right

`PAN_BIAS` in `src/utils/stereoRouting.js` is `0.7`. A full hard pan is
completely silent in the opposite ear, so an operator running a single earpiece
— common practice — would miss that group entirely. At 0.7 the far ear still
carries the traffic, roughly 12 dB down. Raising it to 1 is a safety decision,
not a preference.

### The pan is sticky between transmissions

It moves when a transmission starts and stays put afterwards, rather than
snapping back when the call ends. This avoids the panner moving underneath a
call's audio tail. The practical consequence: audio arriving with no preceding
`new-call` — joining mid-transmission, or a server that omits the message —
plays wherever the previous transmission left the pan.

### Unknown groups land on the default

A `new-call` whose `calling_group_id` is missing or unrecognised routes to the
**Other groups** position. This is the intended behaviour for the "everything
else" bucket, but it also means a malformed message is indistinguishable from
genuine unassigned traffic.

### Browser support

- **Chromium, Firefox** — works.
- **Safari 14.1+** — works, with the caveat below.
- **Safari before 14.1** — has an `AudioContext` but no `createStereoPanner`.
  `createStereoRouter` returns `null`, the app logs a warning and falls back to
  plain unrouted output rather than losing audio.

Safari keeps a remote WebRTC stream flowing only while it is attached to a media
element, so the router creates a hidden muted `<audio>` anchor alongside the
graph. Without it the graph reads silence. This is a workaround for a
long-standing WebKit bug and is the part most likely to break on a Safari
update — **test on real Apple hardware before deploying**, not in a simulator.

### Autoplay policy

An `AudioContext` starts suspended until a user gesture. The view retries
`resume()` on every `pointerdown` and `keydown`, so in practice the first
interaction fixes it — but a session that receives audio before the operator has
touched anything can be silent until they do. This is the same class of problem
as the existing "Audio playback blocked" warning.

### Bookkeeping

- The per-group choice and the default persist through `localStorage` with the
  rest of the settings. Groups saved before this feature have no `pan` field and
  fall back to the default, so nothing needs migrating.
- `logout()` clears both back to off/centre.
- The graph is torn down and rebuilt whenever the remote stream changes or the
  feature is toggled, so a stale context never holds a dead stream.

## The proper fix

All of the above follows from one mixed track. If the server negotiated a
**separate m-line per group**, each group would arrive as its own
`MediaStreamTrack` and could be panned independently and genuinely
simultaneously — no time-based approximation, no ambiguity when two groups talk
at once.

That needs server work. `src/utils/webrtc.js` would also need changing: the
`track` handler currently takes `trackEvent.streams[0]` and hands it over
wholesale, so multiple inbound tracks would clobber each other today.

This is the same shape of gap the README already notes for group targeting on
`floor-request` — the client can only present group structure that the server
actually sends.
