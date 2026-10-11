/**
 * Research layer entry point — RQ2 receive-side instrumentation.
 *
 * Self-contained by design: installs the peer connection capture hook and
 * mounts its own Vue app into an element it creates. Nothing in `src/` outside
 * this folder is modified, so removal is deleting the folder and the single
 * import in `main.js`. See README.md in this folder.
 */

import { createApp } from 'vue'
import ResearchPanel from './ResearchPanel.vue'
import { installCapture } from './peerConnections'
import { installWebSocketOverride } from './localSignalling'
// RQ3 floor-transport experiment. Self-gating on `?exp=floor`, so importing it
// is a no-op for a normal page load. Its own hooks are lazy, so it does not
// care that this import is hoisted above the two installs below — what matters
// is that all of it runs before the operator can connect. See ./floor/index.js.
import './floor'

const ROOT_ID = 'research-panel-root'

/**
 * Both hooks must be in place before the app constructs its first
 * `RTCPeerConnection` or `WebSocket`. Importing this module from `main.js` runs
 * it at module evaluation time, well before the operator can connect.
 */
installWebSocketOverride()
installCapture()

function mountPanel() {
  if (document.getElementById(ROOT_ID)) return
  const root = document.createElement('div')
  root.id = ROOT_ID
  document.body.appendChild(root)
  createApp(ResearchPanel).mount(root)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountPanel, { once: true })
} else {
  mountPanel()
}
