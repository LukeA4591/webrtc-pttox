/**
 * Development-only `ws://` compatibility for a local signalling server.
 *
 * `utils/webrtc.js:65` hardcodes `wss://${domain}/api/webrtc/ws`, so a plain
 * `ws://` server on the LAN is unreachable. Rather than edit that file, this
 * subclasses the global `WebSocket` and rewrites the URL on construction —
 * the same approach as the peer connection capture, so the whole research
 * layer stays deletable.
 *
 * Safety rules, because silently downgrading TLS is not acceptable in general:
 *
 *  - Only ever downgrades `wss:` to `ws:`, never the reverse.
 *  - Only for loopback, RFC1918 / link-local addresses and local-only TLDs,
 *    so a public production host can never be downgraded.
 *  - Can be switched off, and the effective URL is shown in the panel.
 */

const STORAGE_KEY = 'research.localWs'
const SIGNALLING_PATH = '/api/webrtc/ws'

/** Loopback, private and link-local ranges, plus local-only TLDs. */
export function isLocalHost(hostname) {
  if (!hostname) return false
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host === '::1') return true
  if (/(^|\.)(local|localhost|test|internal)$/.test(host)) return true

  const parts = host.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = parts.map(Number)
    if (parts.some((p) => Number(p) > 255)) return false
    if (a === 127 || a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
  }
  return false
}

function readEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

const state = {
  enabled: readEnabled(),
  /** Most recent rewrite, for display in the panel. */
  last: null,
}

/**
 * Signalling sockets the app has opened, insertion-ordered. The app keeps its
 * WebSocket in a closure, so the RQ3 floor experiment has no other way to send
 * on the same socket the real client uses.
 */
const sockets = new Set()

/** The newest signalling socket that is still connecting or open, or null. */
export function activeSignallingSocket() {
  let found = null
  for (const socket of sockets) {
    if (socket.readyState === 0 || socket.readyState === 1) found = socket
  }
  return found
}

export function localWsEnabled() {
  return state.enabled
}

export function setLocalWsEnabled(value) {
  state.enabled = !!value
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    /* private mode — keep the in-memory value */
  }
}

export function lastRewrite() {
  return state.last
}

/**
 * Apply the dev rewrites to a signalling URL.
 * @returns {{url: string, notes: string[]}}
 */
export function rewriteSignallingUrl(raw) {
  const notes = []
  let parsed
  try {
    parsed = new URL(String(raw))
  } catch {
    return { url: String(raw), notes: ['could not parse URL'] }
  }

  // The server field expects a bare host, but `addServer` only strips the
  // scheme — pasting a full URL leaves the path duplicated. Collapse it.
  const occurrences = parsed.pathname.split(SIGNALLING_PATH).length - 1
  if (occurrences > 1) {
    parsed.pathname = SIGNALLING_PATH
    notes.push(`collapsed ${occurrences} copies of ${SIGNALLING_PATH} (full URL pasted as host?)`)
  }

  if (parsed.protocol === 'wss:' && state.enabled && isLocalHost(parsed.hostname)) {
    parsed.protocol = 'ws:'
    notes.push('downgraded wss: to ws: for a local address')
  }

  return { url: parsed.toString(), notes }
}

let installed = false

export function installWebSocketOverride() {
  if (installed || typeof window === 'undefined') return false
  const Native = window.WebSocket
  if (typeof Native !== 'function') return false

  class ResearchWebSocket extends Native {
    constructor(url, protocols) {
      const { url: effective, notes } = rewriteSignallingUrl(url)
      if (notes.length) {
        state.last = { from: String(url), to: effective, notes }
        console.info(`[research] signalling URL ${url} -> ${effective} (${notes.join('; ')})`)
      } else {
        state.last = { from: String(url), to: effective, notes: [] }
      }
      super(effective, protocols)

      if (effective.includes(SIGNALLING_PATH)) {
        sockets.add(this)
        this.addEventListener('close', () => sockets.delete(this))
      }
    }
  }

  // Static constants are inherited through the constructor's prototype chain.
  ResearchWebSocket.__native = Native
  window.WebSocket = ResearchWebSocket
  installed = true
  return true
}
