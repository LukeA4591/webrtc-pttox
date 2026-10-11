/**
 * The three floor transports.
 *
 * One interface — `send(envelope)`, `onMessage(handler)`, `isOpen()` — and
 * three implementations that differ **only** in the carrier they write to and
 * whether the sender retries. Envelope building, parsing, timing and the code
 * that reacts to a grant all live outside this file, in `envelope.js` and
 * `controller.js`, so none of that can drift between arms of the experiment.
 *
 * `retries` is declarative rather than a timer per implementation: the single
 * retry loop in `controller.js` is driven off this flag, which keeps one copy
 * of the resend logic instead of three.
 */

import { encode, parseEnvelope } from './envelope'
import { floorChannel } from './channels'
import { activeSignallingSocket } from '../localSignalling'

export const TRANSPORT_IDS = ['ws', 'dc-reliable', 'dc-unreliable']

/**
 * Default run: the WebSocket baseline plus one data channel. Never all three —
 * the two data channel types must not share a peer connection (see
 * `channels.js`), so a comparison of the two is two runs.
 */
export const DEFAULT_TRANSPORTS = ['ws', 'dc-reliable']

/** Fan inbound envelopes out to the controller, for one carrier. */
function makeInbox() {
  const handlers = new Set()
  return {
    add(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    deliver(raw) {
      const envelope = parseEnvelope(raw)
      // Not an envelope: ordinary signalling traffic, which the application's
      // own listener handles. Rule 6 — normal traffic unaffected.
      if (!envelope) return
      for (const handler of handlers) handler(envelope)
    },
  }
}

/** The signalling WebSocket the real client is already using. */
function webSocketTransport() {
  const inbox = makeInbox()
  let attachedTo = null

  // The app reconnects by constructing a new socket, so re-attach lazily
  // rather than holding one reference for the life of the page.
  function socket() {
    const live = activeSignallingSocket()
    if (live && live !== attachedTo) {
      live.addEventListener('message', (event) => inbox.deliver(event.data))
      attachedTo = live
    }
    return live
  }

  return {
    id: 'ws',
    retries: false,
    isOpen() {
      return socket()?.readyState === 1
    },
    send(envelope) {
      const live = socket()
      if (live?.readyState !== 1) return false
      live.send(encode(envelope))
      return true
    },
    onMessage(handler) {
      socket()
      return inbox.add(handler)
    },
    describe() {
      return 'signalling WebSocket (TCP)'
    },
  }
}

/** One of the two negotiated data channels. */
function dataChannelTransport(id, { retries, description }) {
  const inbox = makeInbox()
  let attachedTo = null

  function channel() {
    const live = floorChannel(id)
    if (live && live !== attachedTo) {
      live.addEventListener('message', (event) => inbox.deliver(event.data))
      attachedTo = live
    }
    return live
  }

  return {
    id,
    retries,
    isOpen() {
      // Readiness is the channel's own `open` state, never merely "created".
      return channel()?.readyState === 'open'
    },
    send(envelope) {
      const live = channel()
      if (live?.readyState !== 'open') return false
      live.send(encode(envelope))
      return true
    },
    onMessage(handler) {
      channel()
      return inbox.add(handler)
    },
    describe() {
      return description
    },
  }
}

/** All three, keyed by mode id. Built once per page session. */
export function createTransports() {
  return {
    ws: webSocketTransport(),
    'dc-reliable': dataChannelTransport('dc-reliable', {
      retries: false,
      description: 'data channel, reliable + ordered',
    }),
    'dc-unreliable': dataChannelTransport('dc-unreliable', {
      retries: true,
      description: 'data channel, unreliable + unordered, client resends',
    }),
  }
}
