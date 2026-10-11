/**
 * Single source of truth for the PTToX client.
 *
 * A module-level singleton rather than Pinia — the app has exactly one session,
 * and every component reads the same reactive refs.
 */
import { computed, ref, shallowRef } from 'vue'
import { createConnection, getLocalStream, releaseLocalStream, stripPrefix } from '@/utils/webrtc'
import { PAN_POSITIONS, panValue } from '@/utils/stereoRouting'
import { extensionFor, recordClip } from '@/utils/recorder'

const STORAGE_KEY = 'pttox.settings'
const LOG_LIMIT = 200
const STATS_INTERVAL_MS = 3000

/** How many transmissions the replay buffer holds before evicting the oldest. */
const CLIP_LIMIT = 20

/**
 * Keep recording briefly past `end-call`. The signalling message tends to beat
 * the last of the audio, and a clipped final syllable is exactly the word an
 * operator replays the clip to hear.
 */
const CLIP_TAIL_MS = 400

/**
 * Default server list, from `VITE_PTTOX_SERVERS` as a comma-separated list of
 * bare hosts. Kept in `.env` rather than in the repo because the development
 * servers are internal hostnames; see `.env.example`.
 *
 * This is not a secret: Vite inlines the value at build time, so it ends up in
 * the built bundle either way. It keeps the names out of a public repository,
 * not out of the application. With nothing set the list is empty and the
 * operator adds a host in the sidebar.
 */
function configuredServers() {
  const raw = import.meta.env?.VITE_PTTOX_SERVERS ?? ''
  return String(raw)
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
}

const DEFAULT_SERVERS = configuredServers()

const DEFAULT_SETTINGS = {
  displayName: 'Luke',
  servers: DEFAULT_SERVERS,
  selectedServer: DEFAULT_SERVERS[0] ?? '',
  micDeviceId: '',
  speakerDeviceId: '',
  /** [{ key, rawId, label, lastHeard, manual, pan, muted }] — see the groups section. */
  groups: [],
  selectedGroupKey: null,
  outputVolume: 1,
  /** Send groups to different ears. Off by default — see docs/stereo-routing.md. */
  stereoRouting: false,
  /** Ear for any group without an explicit choice: 'left' | 'center' | 'right'. */
  defaultPan: 'center',
  /**
   * Record received transmissions for replay. Off by default: capturing other
   * people's voice traffic is a decision the operator makes, not one we make
   * for them. See docs/replay.md.
   */
  replayEnabled: false,
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

const settings = loadSettings()

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        displayName: displayName.value,
        servers: servers.value,
        selectedServer: selectedServer.value,
        micDeviceId: micDeviceId.value,
        speakerDeviceId: speakerDeviceId.value,
        groups: groups.value,
        selectedGroupKey: selectedGroupKey.value,
        outputVolume: outputVolume.value,
        stereoRouting: stereoRouting.value,
        defaultPan: defaultPan.value,
        replayEnabled: replayEnabled.value,
      }),
    )
  } catch {
    // Private-mode Safari and friends: settings just won't survive a reload.
  }
}

/* -- state ---------------------------------------------------------------- */

// TODO(auth): when the PTToX server exposes authentication, the bearer token
// belongs here and gets appended to the signalling URL in utils/webrtc.js.
export const displayName = ref(settings.displayName)
export const servers = ref(settings.servers)
export const selectedServer = ref(settings.selectedServer)

/** 'disconnected' | 'connecting' | 'connected' | 'reconnecting' */
export const connectionState = ref('disconnected')
/** 'idle' | 'requesting' | 'granted' | 'denied' */
export const floorState = ref('idle')

/**
 * Transmissions inbound right now. This is a live indicator, not a roster — the
 * server reports each via `new-call` and withdraws it on `end-call`. It is a
 * list because the server may overlap them; `receiving` surfaces the newest.
 */
const activeCalls = ref([])

/** Who is transmitting to us right now, or null. */
export const receiving = computed(() => activeCalls.value.at(-1) ?? null)
/** True once the peer connection has been negotiated and we can hold the floor. */
export const mediaReady = ref(false)
export const log = ref([])
export const networkStats = ref(null)
export const remoteStream = shallowRef(null)

export const micDeviceId = ref(settings.micDeviceId)
export const speakerDeviceId = ref(settings.speakerDeviceId)
export const inputDevices = ref([])
export const outputDevices = ref([])

/** Talkgroups: seeded from inbound traffic, editable by hand. */
export const groups = ref(settings.groups)
export const selectedGroupKey = ref(settings.selectedGroupKey)

/** Playback level for received audio, 0..1. */
export const outputVolume = ref(settings.outputVolume)
export const outputMuted = ref(false)

/** Stereo routing: master switch, and the ear used by unassigned groups. */
export const stereoRouting = ref(settings.stereoRouting)
export const defaultPan = ref(settings.defaultPan)

/**
 * Group whose pan is currently applied. Sticky: it is set when a transmission
 * starts and held afterwards, so the pan never moves under a call's audio tail.
 */
const panGroupKey = ref(null)

/**
 * Recorded transmissions, newest first. In memory only — clips never touch
 * disk and never leave the device. See docs/replay.md.
 */
export const replayEnabled = ref(settings.replayEnabled)
export const clips = ref([])

/**
 * Hard microphone mute. Deliberately NOT persisted — a mute that silently
 * survives a reload is a safety hazard on a radio system.
 */
export const micMuted = ref(false)

/** Live input level (0..1) while the mic test is running. */
export const micTestActive = ref(false)
export const micLevel = ref(0)

let connection = null
let statsTimer = null
let logSeq = 0
let micTest = null
let clipSeq = 0
/** In-flight recording and the call it belongs to, or nulls when idle. */
let recording = null
let recordingCallId = null

/* -- derived -------------------------------------------------------------- */

export const isConnected = computed(
  () => connectionState.value === 'connected' || connectionState.value === 'reconnecting',
)

/**
 * Transmitting only needs a negotiated media session. It deliberately does NOT
 * depend on an inbound call being in progress — requiring that would mean you
 * could only talk while somebody else already was.
 */
export const canTalk = computed(
  () => isConnected.value && mediaReady.value && !micMuted.value && !micTestActive.value,
)

export const selectedGroup = computed(
  () => groups.value.find((group) => group.key === selectedGroupKey.value) ?? null,
)

/** Where a group sits in the stereo field, falling back to the shared default. */
export function groupPan(group) {
  return group?.pan ?? defaultPan.value
}

/**
 * StereoPannerNode value for the group we last heard. Only one pan can apply at
 * a time — the remote track is already mixed, so overlapping groups cannot be
 * separated. See docs/stereo-routing.md.
 */
export const activePan = computed(() =>
  panValue(groupPan(groups.value.find((group) => group.key === panGroupKey.value))),
)

/** Is this group silenced? Unknown groups are always audible. */
export function groupMuted(key) {
  return groups.value.find((group) => group.key === key)?.muted === true
}

/**
 * Whether inbound audio should currently be silenced.
 *
 * Deliberately fails open: it takes *every* live transmission being from a
 * muted group. The remote track is already mixed, so when a muted and an
 * unmuted group overlap there is no way to drop only one — and on a radio
 * system hearing too much beats missing traffic. Audio with no `new-call`
 * behind it is always audible for the same reason.
 */
export const inboundMuted = computed(
  () =>
    activeCalls.value.length > 0 &&
    activeCalls.value.every((call) => groupMuted(groupKeyOf(call.groupId))),
)

export const connectionLabel = computed(
  () =>
    ({
      disconnected: 'Disconnected',
      connecting: 'Connecting',
      connected: 'Connected',
      reconnecting: 'Reconnecting',
    })[connectionState.value] ?? 'Unknown',
)

/**
 * Network health derived from RTT and jitter. `unknown` until the first
 * successful stats read.
 */
export const networkQuality = computed(() => {
  const stats = networkStats.value
  if (!isConnected.value || !stats) return 'unknown'
  const rtt = stats.rttMs ?? 0
  const jitter = stats.jitterMs ?? 0
  if (rtt > 300 || jitter > 60) return 'poor'
  if (rtt > 150 || jitter > 30) return 'fair'
  return 'good'
})

export const headphonesConnected = computed(() =>
  outputDevices.value.some((device) => /head(phone|set)|airpod|earbud|buds/i.test(device.label)),
)

/* -- logging -------------------------------------------------------------- */

export function addLog(level, message) {
  log.value.unshift({ id: ++logSeq, at: new Date(), level, message })
  if (log.value.length > LOG_LIMIT) log.value.length = LOG_LIMIT
}

export function clearLog() {
  log.value = []
}

/* -- devices -------------------------------------------------------------- */

export async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    inputDevices.value = devices.filter((device) => device.kind === 'audioinput')
    outputDevices.value = devices.filter((device) => device.kind === 'audiooutput')
  } catch (error) {
    addLog('error', `Could not list audio devices: ${error.message}`)
  }
}

export function setMicDevice(deviceId) {
  micDeviceId.value = deviceId
  persist()
  addLog('info', 'Microphone changed — reconnect to apply')
}

export function setSpeakerDevice(deviceId) {
  speakerDeviceId.value = deviceId
  persist()
}

/* -- session lifecycle ---------------------------------------------------- */

export function setServer(domain) {
  selectedServer.value = domain
  if (!servers.value.includes(domain)) servers.value = [...servers.value, domain]
  persist()
}

/**
 * Remove a configured server. Refuses to remove the last one, and disconnects
 * first if the server being removed is the live one.
 */
export function removeServer(domain) {
  if (servers.value.length <= 1) {
    addLog('warn', 'Keep at least one server configured')
    return false
  }
  const remaining = servers.value.filter((entry) => entry !== domain)
  servers.value = remaining
  if (selectedServer.value === domain) {
    if (isConnected.value || connectionState.value === 'connecting') disconnect()
    selectedServer.value = remaining[0]
  }
  persist()
  addLog('info', `Removed server ${domain}`)
  return true
}

/* -- groups --------------------------------------------------------------- */

/** Groups are identified by their bare name, so `group:PMR-1` and `PMR-1` match. */
function groupKeyOf(rawId) {
  return stripPrefix(rawId).trim().toLowerCase()
}

/** Record a group heard on inbound traffic, or refresh its last-heard time. */
function noteGroupHeard(rawId) {
  const key = groupKeyOf(rawId)
  if (!key) return
  const existing = groups.value.find((group) => group.key === key)
  if (existing) {
    existing.lastHeard = Date.now()
    existing.rawId = rawId || existing.rawId
  } else {
    groups.value = [
      ...groups.value,
      {
        key,
        rawId,
        label: stripPrefix(rawId),
        lastHeard: Date.now(),
        manual: false,
        pan: null,
        muted: false,
      },
    ]
  }
  if (!selectedGroupKey.value) selectedGroupKey.value = key
  persist()
}

export function addGroup(name) {
  const label = name.trim()
  const key = groupKeyOf(label)
  if (!key) return false
  if (groups.value.some((group) => group.key === key)) {
    addLog('warn', `Group ${label} is already listed`)
    return false
  }
  groups.value = [
    ...groups.value,
    { key, rawId: label, label, lastHeard: null, manual: true, pan: null, muted: false },
  ]
  if (!selectedGroupKey.value) selectedGroupKey.value = key
  persist()
  return true
}

export function removeGroup(key) {
  groups.value = groups.value.filter((group) => group.key !== key)
  if (selectedGroupKey.value === key) selectedGroupKey.value = groups.value[0]?.key ?? null
  persist()
}

export function selectGroup(key) {
  selectedGroupKey.value = key
  persist()
}

/**
 * Silence a group without losing it from the list. Muted groups are still
 * recorded for replay — mute means "do not play", not "do not capture".
 */
export function toggleGroupMute(key) {
  const group = groups.value.find((entry) => entry.key === key)
  if (!group) return
  group.muted = !group.muted
  persist()
  addLog('info', `${group.label} ${group.muted ? 'muted' : 'unmuted'}`)
}

/* -- audio output --------------------------------------------------------- */

export function setOutputVolume(value) {
  outputVolume.value = Math.min(1, Math.max(0, Number(value) || 0))
  // Moving the slider off zero is an explicit intent to hear again.
  if (outputVolume.value > 0) outputMuted.value = false
  persist()
}

export function toggleOutputMute() {
  outputMuted.value = !outputMuted.value
}

/* -- stereo routing ------------------------------------------------------- */

/**
 * Turn per-group ear routing on or off. Off means the remote stream goes
 * straight to the `<audio>` element with no Web Audio graph in the way, which
 * is the safest path on browsers that mishandle one.
 */
export function toggleStereoRouting() {
  stereoRouting.value = !stereoRouting.value
  persist()
  addLog('info', stereoRouting.value ? 'Stereo routing enabled' : 'Stereo routing disabled')
}

/** Pin a group to an ear. Groups left alone follow `defaultPan`. */
export function setGroupPan(key, position) {
  if (!PAN_POSITIONS.includes(position)) return
  const group = groups.value.find((entry) => entry.key === key)
  if (!group) return
  group.pan = position
  persist()
}

/** Ear for every group that has not been pinned — the "everything else" bucket. */
export function setDefaultPan(position) {
  if (!PAN_POSITIONS.includes(position)) return
  defaultPan.value = position
  persist()
}

/* -- instant replay ------------------------------------------------------- */

export function toggleReplay() {
  replayEnabled.value = !replayEnabled.value
  // Turning it off stops the transmission in progress but keeps what is already
  // captured; discarding it is an explicit choice via clearClips().
  if (!replayEnabled.value) finishRecording(0)
  persist()
  addLog('info', replayEnabled.value ? 'Recording transmissions' : 'Recording stopped')
}

/**
 * Begin capturing a transmission. Any clip still running is flushed first, so
 * two overlapping calls never share one recording.
 */
function startRecording(call) {
  if (!replayEnabled.value) return
  finishRecording(0)
  if (!remoteStream.value) return

  const meta = { ...call }
  recording = recordClip(remoteStream.value, ({ blob, durationMs }) => {
    addClip(meta, blob, durationMs)
  })
  if (!recording) {
    addLog('warn', 'Recording is not supported in this browser')
    replayEnabled.value = false
    persist()
    return
  }
  recordingCallId = call.callId
}

/** Close off the current clip. The handle finishes on its own from here. */
function finishRecording(tailMs) {
  recording?.stop(tailMs)
  recording = null
  recordingCallId = null
}

function addClip(call, blob, durationMs) {
  const entry = {
    id: ++clipSeq,
    url: URL.createObjectURL(blob),
    at: new Date(),
    durationMs,
    bytes: blob.size,
    extension: extensionFor(blob.type),
    alias: call.userAlias || 'Unknown station',
    groupKey: groupKeyOf(call.groupId),
    groupLabel: stripPrefix(call.groupId) || 'Unknown group',
  }

  const next = [entry, ...clips.value]
  // Object URLs leak until revoked, so evictions have to be explicit.
  next.slice(CLIP_LIMIT).forEach((clip) => URL.revokeObjectURL(clip.url))
  clips.value = next.slice(0, CLIP_LIMIT)
}

export function clearClips() {
  clips.value.forEach((clip) => URL.revokeObjectURL(clip.url))
  clips.value = []
}

/* -- microphone ----------------------------------------------------------- */

export function toggleMicMute() {
  micMuted.value = !micMuted.value
  if (micMuted.value && floorState.value !== 'idle') releasePtt()
  addLog(micMuted.value ? 'warn' : 'info', micMuted.value ? 'Microphone muted' : 'Microphone live')
}

/** Gain applied to RMS so ordinary speech lands mid-scale rather than near zero. */
const LEVEL_GAIN = 3

/**
 * Convert a byte time-domain buffer (128 = silence) to a 0..1 meter level.
 * Exported so the scaling can be tested without a live microphone.
 *
 * @param {Uint8Array} samples
 */
export function levelFromTimeDomain(samples) {
  if (!samples?.length) return 0
  let sum = 0
  for (const sample of samples) {
    const centred = (sample - 128) / 128
    sum += centred * centred
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * LEVEL_GAIN)
}

/**
 * Run a local level meter so the operator can confirm the mic works without
 * transmitting. Never touches the peer connection.
 */
export async function startMicTest() {
  if (micTestActive.value) return
  try {
    const stream = await getLocalStream(micDeviceId.value || undefined)
    const context = new (window.AudioContext ?? window.webkitAudioContext)()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.6
    context.createMediaStreamSource(stream).connect(analyser)

    const samples = new Uint8Array(analyser.fftSize)
    let frame = 0
    const tick = () => {
      analyser.getByteTimeDomainData(samples)
      micLevel.value = levelFromTimeDomain(samples)
      frame = requestAnimationFrame(tick)
    }
    tick()

    micTest = {
      stop: () => {
        cancelAnimationFrame(frame)
        context.close()
      },
    }
    micTestActive.value = true
    addLog('info', 'Microphone test started')
  } catch (error) {
    addLog('error', `Microphone test failed: ${error.message}`)
  }
}

export function stopMicTest() {
  micTest?.stop()
  micTest = null
  micTestActive.value = false
  micLevel.value = 0
  // Only give the device back if no call needs it.
  if (!isConnected.value) releaseLocalStream()
}

export function setDisplayName(name) {
  displayName.value = name.trim() || 'Operator'
  persist()
}

export function connect() {
  if (connection) return
  if (!selectedServer.value) {
    addLog('error', 'No server selected')
    return
  }
  persist()

  connection = createConnection({
    domain: selectedServer.value,
    micDeviceId: micDeviceId.value || undefined,
    on: {
      log: addLog,
      status: (state) => {
        connectionState.value = state
      },
      ready: () => {
        mediaReady.value = true
      },
      remoteStream: (stream) => {
        remoteStream.value = stream
      },
      incomingCall: (call) => {
        activeCalls.value = [
          ...activeCalls.value.filter((entry) => entry.callId !== call.callId),
          { ...call, startedAt: new Date() },
        ]
        noteGroupHeard(call.groupId)
        // An unrecognised group leaves this null, so it lands on the default ear.
        panGroupKey.value = groupKeyOf(call.groupId) || null
        startRecording(call)
      },
      callEnded: (callId) => {
        // A call we never showed simply is not in the list, so this is a no-op.
        activeCalls.value = activeCalls.value.filter((entry) => entry.callId !== callId)
        if (recordingCallId === callId) finishRecording(CLIP_TAIL_MS)
      },
      floorGrant: () => {
        floorState.value = 'granted'
      },
      floorDeny: () => {
        floorState.value = 'denied'
        // Let the operator see the denial, then settle back to idle.
        setTimeout(() => {
          if (floorState.value === 'denied') floorState.value = 'idle'
        }, 1200)
      },
      closed: () => {
        // Release the handle as well as the state. `connect()` early-returns
        // while `connection` is set, and the button only calls `disconnect()`
        // while connected — so a server-initiated close used to leave a stale
        // handle that made Connect a silent no-op with no way out but a reload.
        connection = null
        stopStatsPolling()
        resetSessionState()
      },
    },
  })

  startStatsPolling()
}

export function disconnect() {
  connection?.close()
  connection = null
  stopStatsPolling()
  resetSessionState()
  connectionState.value = 'disconnected'
  addLog('info', 'Disconnected')
}

export function logout() {
  disconnect()
  stopMicTest()
  releaseLocalStream()
  clearLog()
  groups.value = []
  selectedGroupKey.value = null
  micMuted.value = false
  outputMuted.value = false
  outputVolume.value = DEFAULT_SETTINGS.outputVolume
  stereoRouting.value = DEFAULT_SETTINGS.stereoRouting
  defaultPan.value = DEFAULT_SETTINGS.defaultPan
  replayEnabled.value = DEFAULT_SETTINGS.replayEnabled
  clearClips()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
  displayName.value = DEFAULT_SETTINGS.displayName
  servers.value = [...DEFAULT_SETTINGS.servers]
  selectedServer.value = DEFAULT_SETTINGS.selectedServer
  micDeviceId.value = ''
  speakerDeviceId.value = ''
}

function resetSessionState() {
  // The stream is about to go away, so close off any clip while it still can.
  finishRecording(0)
  activeCalls.value = []
  panGroupKey.value = null
  mediaReady.value = false
  floorState.value = 'idle'
  networkStats.value = null
  remoteStream.value = null
}

/* -- push to talk --------------------------------------------------------- */

export function pressPtt() {
  if (!canTalk.value || floorState.value !== 'idle') return
  floorState.value = 'requesting'
  if (!connection?.requestFloor()) {
    floorState.value = 'idle'
  }
}

export function releasePtt() {
  if (floorState.value === 'idle') return
  connection?.releaseFloor()
  floorState.value = 'idle'
}

/* -- stats polling -------------------------------------------------------- */

function startStatsPolling() {
  stopStatsPolling()
  statsTimer = setInterval(async () => {
    networkStats.value = (await connection?.readStats()) ?? null
  }, STATS_INTERVAL_MS)
}

function stopStatsPolling() {
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
}

export { stripPrefix }
