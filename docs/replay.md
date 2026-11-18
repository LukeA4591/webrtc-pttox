# Instant replay

Records each received transmission so an operator can play back the call they
just missed. Clips appear newest-first in the Replay panel in the right rail,
each tagged with who spoke, which group, when, and how long for.

Recording is off by default and toggled from the panel header. Capturing other
people's voice traffic seemed like a decision the operator should make
deliberately rather than one the app makes for them on first run.

## How it works

One `MediaRecorder` per transmission, started on `new-call` and stopped on
`end-call`. That gives one complete, independently decodable file per call.

The obvious alternative, recording continuously and slicing afterwards, doesn't
work reliably: WebM chunks after the first are missing the container header, so
the fragments only play in some browsers. Per-call recorders sidestep that, and
they make overlapping calls trivially safe since no two transmissions share any
recorder state.

Recording is taken from the raw remote stream rather than the panned one from
`docs/stereo-routing.md`, so a clip never bakes in the operator's ear
assignment.

Code: `src/utils/recorder.js`, the replay section of `src/stores/session.js`,
`src/components/ReplayPanel.vue`.

## Restrictions

### Clips are in memory only, and don't survive a reload

They're `Blob`s behind object URLs held in the store. A refresh, a crash, or a
PWA update prompt accepted mid-session loses everything captured. Use the save
button on a clip to keep one; there's no automatic export.

This was a deliberate call rather than something left half-finished. Writing
radio traffic to IndexedDB raises retention questions (how long, whose voice,
who can read it off the device afterwards) that belong to whoever deploys this
rather than to the client. If persistence is wanted it should be an explicit,
separately-consented feature.

Nothing recorded ever leaves the device. There is no upload path.

### The buffer holds 20 transmissions

`CLIP_LIMIT` in `src/stores/session.js`. The oldest is evicted and its object
URL revoked when the 21st arrives. Object URLs leak until revoked, so anything
that drops a clip has to revoke it explicitly; `addClip` and `clearClips` both
do.

There's no size cap, only a count, so twenty unusually long transmissions will
hold proportionally more memory.

### The first fraction of a second can be clipped

Recording starts when `new-call` arrives, and RTP audio may already be flowing
by then. There's no pre-roll, because a pre-roll needs the continuous recording
that the chunk-header problem above rules out.

The end is handled: `CLIP_TAIL_MS` (400 ms) keeps recording past `end-call` so
the last syllable isn't cut off. That's the direction that matters, since the
final word is usually the one being replayed for.

### Traffic without a `new-call` is not captured

Joining mid-transmission, or a server that omits the message, produces audio
that plays but is never recorded. The recorder is driven entirely by
signalling, not by detecting audio.

### It records what the server sends, which is one mixed track

If two groups transmit at once their audio is already summed, so a clip
labelled with one group may contain another group's speech. Same root cause as
`docs/stereo-routing.md`. The label reflects the `new-call` that started the
clip; nothing analyses the audio.

### Container support varies

`pickMimeType` tries Opus-in-WebM first and falls back through mp4 and ogg.
Safari only produces mp4. If `MediaRecorder` is missing or refuses to
construct, `recordClip` returns `null`, the app logs a warning and switches
recording back off rather than silently appearing to record.

Saved filenames get an extension matching the container, so clips open in a
normal player.

### Interaction with per-group mute

Muted groups are still recorded. Mute means "don't play", not "don't capture",
so an operator can silence a busy group and still replay it later. See
`docs/group-mute.md`.
