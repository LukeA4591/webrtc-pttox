/**
 * The RQ3 message envelope — shared by all three transports.
 *
 * Every experiment floor message is JSON text in this shape, whichever carrier
 * it travels on:
 *
 *     { "v": 1, "kind": "floor-request", "reqId": 1234, "body": {} }
 *
 * `body` is the client's existing floor message, unchanged, so the server can
 * unwrap it, run its normal floor logic and wrap the normal reply the same way.
 * Keeping the envelope identical on all three carriers is what makes the
 * access-time comparison a comparison of transports rather than of formats.
 *
 * This file is the only place the wire format is defined; the server agent
 * implements the same contract (docs/floor-transport-client-handoff.md).
 */

export const ENVELOPE_VERSION = 1

export const Kind = {
  Request: 'floor-request',
  Release: 'floor-release',
  Grant: 'floor-grant',
  Deny: 'floor-deny',
  ReleaseAck: 'floor-release-ack',
}

/** Replies that close a request. */
export const REQUEST_REPLIES = [Kind.Grant, Kind.Deny]

let sequence = 0

/**
 * Next request id: integer, unique and increasing within one page session.
 * Shared across transports so a reqId identifies one attempt unambiguously.
 */
export function nextReqId() {
  sequence += 1
  return sequence
}

/** Only for tests — the contract requires ids to keep increasing in a session. */
export function resetReqIds() {
  sequence = 0
}

/**
 * @param {string} kind
 * @param {number} reqId
 * @param {object|string} body the existing floor message, unchanged
 */
export function makeEnvelope(kind, reqId, body) {
  return { v: ENVELOPE_VERSION, kind, reqId, body }
}

/** Serialise once per send attempt; retries resend the identical text. */
export function encode(envelope) {
  return JSON.stringify(envelope)
}

/**
 * Parse an inbound frame.
 *
 * Returns `null` for anything that is not a well-formed envelope of this
 * version — ordinary signalling traffic, malformed JSON, a future version.
 * Rule 6 of the contract depends on this being strict: a non-envelope frame
 * must fall through to the client's normal handling untouched.
 *
 * @param {unknown} raw
 */
export function parseEnvelope(raw) {
  if (typeof raw !== 'string') return null
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return null
  }
  if (!message || typeof message !== 'object') return null
  if (message.v !== ENVELOPE_VERSION) return null
  if (typeof message.kind !== 'string') return null
  if (!Number.isInteger(message.reqId)) return null
  return message
}
