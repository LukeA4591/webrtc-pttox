# Per-group mute

Silence a talkgroup without losing it from the sidebar. Lets an operator carry
ten groups in the list while only listening to four, and still see the muted
ones light up as traffic arrives.

The speaker button on each group row toggles it. A muted group is dimmed and its
icon turns red, so the state reads at a glance rather than only on hover.

## How it works

Same mechanism as `docs/stereo-routing.md`, and the same underlying constraint:
the server sends one mixed audio track, so there is nothing to filter. What the
client does is mute **playback** for the duration of a transmission from a muted
group, driven by the `calling_group_id` on `new-call`.

`inboundMuted` in `src/stores/session.js` feeds the `<audio>` element's `muted`
property alongside the existing output mute, so it is the same one-line
mechanism the volume control already uses.

Unlike the stereo pan, this is deliberately **not** sticky — it applies only
while a transmission is live and lifts the moment `end-call` arrives. A mute
that outlived its call would silence the next speaker too.

## Restrictions

### It fails open, on purpose

Audio is silenced only when **every** live transmission is from a muted group.
If a muted and an unmuted group overlap, you hear both — including the muted
one — because the mixed track offers no way to drop just one of them.

On a radio system hearing too much is the safe failure and missing traffic is
not, so this is the intended behaviour rather than a limitation to work around.
The same reasoning covers audio with no `new-call` behind it: it is always
audible.

### Muted groups are still shown as transmitting

The receiving banner still appears, styled grey with frozen bars and a "muted"
note. This is intentional — an operator hearing nothing needs to be able to tell
their own mute apart from a dead link.

### Mute is playback only

It does not tell the server to stop sending, so it saves no bandwidth. It also
does not stop recording: muted groups are still captured for replay, so a busy
group can be silenced and reviewed later. See `docs/replay.md`.

### It persists across a reload

Unlike the microphone mute — which is deliberately not persisted, because a
silent mic surviving a reload is a safety hazard — group mutes are saved with
the rest of the group settings. Silencing a group you are not responsible for is
a monitoring preference, not a safety-critical state, and having to re-mute six
groups after every reload would be worse.

`logout()` clears them along with the groups themselves.
