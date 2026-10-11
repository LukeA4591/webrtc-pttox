/**
 * Captures the peer connections the app creates, without touching app code.
 *
 * `utils/webrtc.js` keeps its `RTCPeerConnection` in a closure, so there is no
 * way to reach it from outside. Rather than edit that file, this subclasses the
 * global constructor before the app ever calls it and registers each instance.
 * That keeps the whole research layer deletable: nothing in `src/` outside this
 * folder knows it exists.
 *
 * Must be installed before the first connection is constructed — importing
 * `src/research` from `main.js` is early enough, since a connection is only
 * created when the operator connects.
 */

/** Live connections, insertion-ordered, so the newest is the current session. */
const connections = new Set()

/**
 * Observers run at construction time, before the app has touched the
 * connection. That is the only moment early enough to attach negotiated data
 * channels: this client is the *answerer*, so by the time `receiveOffer()`
 * reaches `createAnswer()` the SDP is already being built.
 */
const observers = new Set()

let installed = false

/**
 * Run `fn(pc)` for every peer connection the app constructs, synchronously in
 * the constructor. Returns an unsubscribe function.
 *
 * @param {(pc: RTCPeerConnection) => void} fn
 */
export function onConnectionCreated(fn) {
  observers.add(fn)
  return () => observers.delete(fn)
}

export function installCapture() {
  if (installed || typeof window === 'undefined') return false

  const Native = window.RTCPeerConnection
  if (typeof Native !== 'function') return false

  class ResearchPeerConnection extends Native {
    constructor(...args) {
      super(...args)
      connections.add(this)
      // The app closes and discards the connection on teardown; drop our
      // reference too so `activeConnection()` cannot hand back a dead one.
      this.addEventListener('connectionstatechange', () => {
        if (this.connectionState === 'closed') connections.delete(this)
      })
      // An observer must never be able to break the app's connection.
      for (const fn of observers) {
        try {
          fn(this)
        } catch (error) {
          console.warn('[research] connection observer failed', error)
        }
      }
    }
  }

  // Preserve the original for anything that feature-detects on the native name.
  ResearchPeerConnection.__native = Native
  window.RTCPeerConnection = ResearchPeerConnection
  installed = true
  return true
}

/** The newest connection that is still open, or null. */
export function activeConnection() {
  let found = null
  for (const pc of connections) {
    if (pc.connectionState !== 'closed') found = pc
  }
  return found
}

/** The inbound audio receiver — where `jitterBufferTarget` lives. */
export function audioReceiver(pc = activeConnection()) {
  if (!pc || typeof pc.getReceivers !== 'function') return null
  return pc.getReceivers().find((receiver) => receiver.track?.kind === 'audio') ?? null
}

/** True when this browser exposes the RQ2 independent variable at all. */
export function jitterBufferTargetSupported() {
  if (typeof window === 'undefined') return false
  const proto = window.RTCRtpReceiver?.prototype
  return !!proto && 'jitterBufferTarget' in proto
}

/**
 * Apply a target in **milliseconds**, or `null` to restore the browser default.
 *
 * Chrome treats this as a hint and clamps it, so the requested value is not
 * necessarily the achieved one — always report both (see `statsSampler.js`).
 */
export function setJitterBufferTarget(ms, pc = activeConnection()) {
  const receiver = audioReceiver(pc)
  if (!receiver || !('jitterBufferTarget' in receiver)) return false
  try {
    receiver.jitterBufferTarget = ms
    return true
  } catch {
    return false
  }
}

/** What the receiver currently reports as its requested target, in ms. */
export function readJitterBufferTarget(pc = activeConnection()) {
  const receiver = audioReceiver(pc)
  if (!receiver || !('jitterBufferTarget' in receiver)) return null
  return receiver.jitterBufferTarget ?? null
}
