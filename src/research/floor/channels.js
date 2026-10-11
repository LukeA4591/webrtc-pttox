/**
 * The run's floor data channel.
 *
 * **One data channel per connection.** A run carries the WebSocket plus exactly
 * one data channel type, and the two types must never share a peer connection:
 * they would share one SCTP association, and server-side testing found that
 * they interfere badly enough to stall the reliable channel for most of a run.
 * Comparing the two types therefore takes two runs per network condition, each
 * on a fresh connection, with `ws` in both as the common reference.
 *
 * The channel is created in the `RTCPeerConnection` constructor hook, before
 * anything touches the SDP. This client is the **answerer** — the server sends
 * the offer unprompted — so creating it at construction time is the equivalent
 * of the server's "before the offer": it is before `setRemoteDescription()` and
 * `createAnswer()`.
 *
 * An answer can only mirror the m-lines the offer contains, so the server must
 * put the same channel on its offer (`--floor-channels reliable|unreliable`).
 * If the two sides disagree, the channel is created locally and never opens —
 * which is what the driver's 15 s open deadline reports.
 */

/** Contract settings. Changing these is a contract change — tell both sides. */
export const CHANNEL_SPECS = {
  'dc-reliable': {
    label: 'floor-reliable',
    options: { negotiated: true, id: 100, ordered: true },
  },
  'dc-unreliable': {
    label: 'floor-unreliable',
    options: { negotiated: true, id: 101, ordered: false, maxRetransmits: 0 },
  },
}

/** The run's channel, by transport id, replaced whenever the app reconnects. */
const channels = new Map()

/** What the browser actually negotiated, for the report. */
const settingsLog = new Map()

let log = () => {}

/** Route channel lifecycle messages somewhere visible. */
export function setChannelLogger(fn) {
  log = typeof fn === 'function' ? fn : () => {}
}

export function floorChannel(transportId) {
  return channels.get(transportId) ?? null
}

export function channelSettings() {
  return Object.fromEntries(settingsLog)
}

/**
 * Attach the run's data channel to a freshly constructed peer connection.
 *
 * @param {RTCPeerConnection} pc
 * @param {string[]} transportIds the run's transports; at most one may be a
 *   data channel, and `ws` is ignored here because it needs no channel
 */
export function attachFloorChannels(pc, transportIds = []) {
  channels.clear()
  settingsLog.clear()

  const wanted = transportIds.filter((id) => id in CHANNEL_SPECS)
  if (wanted.length > 1) {
    log('error', `Refusing to create ${wanted.join(' and ')} on one connection`)
    return
  }

  for (const transportId of wanted) {
    const spec = CHANNEL_SPECS[transportId]
    let channel
    try {
      channel = pc.createDataChannel(spec.label, spec.options)
    } catch (error) {
      log('error', `Could not create "${spec.label}": ${error.message}`)
      continue
    }

    channel.binaryType = 'arraybuffer'
    channels.set(transportId, channel)

    channel.addEventListener('open', () => {
      // Read the settings off the live channel rather than echoing what we
      // asked for: the report needs what was negotiated, not what we wanted.
      const negotiated = {
        label: channel.label,
        id: channel.id,
        ordered: channel.ordered,
        maxRetransmits: channel.maxRetransmits,
        maxPacketLifeTime: channel.maxPacketLifeTime,
        protocol: channel.protocol,
      }
      settingsLog.set(transportId, negotiated)
      log(
        'success',
        `${spec.label} open — id=${negotiated.id} ordered=${negotiated.ordered} ` +
          `maxRetransmits=${negotiated.maxRetransmits}`,
      )
    })

    channel.addEventListener('close', () => log('warn', `${spec.label} closed`))
    channel.addEventListener('error', (event) =>
      log('error', `${spec.label} error: ${event?.error?.message || 'unknown'}`),
    )
  }
}
