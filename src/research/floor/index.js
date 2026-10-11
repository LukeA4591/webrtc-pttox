/**
 * RQ3 entry point — floor-control transport experiment.
 *
 * Everything here is gated on `?exp=floor`. Without that parameter nothing is
 * installed: no data channel is created, the floor transport is never injected,
 * and no panel is mounted, so the client behaves exactly as it does in
 * production.
 *
 * Install order matters. `onConnectionCreated` must be registered before the
 * app constructs its `RTCPeerConnection`, because the channel has to exist
 * before `createAnswer()`. Importing this module from `src/research/index.js`
 * runs it at module evaluation time, long before the operator can connect.
 */

import { createApp, h } from 'vue'
import FloorExpPanel from './FloorExpPanel.vue'
import { attachFloorChannels, channelSettings, CHANNEL_SPECS, setChannelLogger } from './channels'
import { createDriver, parseParams } from './driver'
import { onConnectionCreated } from '../peerConnections'

const ROOT_ID = 'floor-exp-root'

function consoleLog(level, message) {
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
  console[method](`[rq3] ${message}`)
}

/**
 * Take the service worker out of the picture for the duration of a run.
 *
 * The client ships `registerType: 'prompt'`, so rebuilding while a run window
 * is open raises the refresh toast — and accepting it reloads the page. A reload
 * gets a new WebSocket source port and a new peer connection, which silently
 * detaches the run from whatever network condition the rig pinned to the old
 * ports. It has happened: a condition set at 14:41:58 UTC against one 4-tuple,
 * and a `receiver#2` registration at 14:48:05 on different ports, giving a run
 * that measured 4.8 ms under what should have been 10 % loss and 50 ms.
 *
 * Experiment mode only, so the installable client is unaffected.
 */
function detachServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const registration of registrations) {
        registration.unregister().then((gone) => {
          if (gone) consoleLog('warn', 'service worker unregistered — it cannot reload this run')
        })
      }
    })
    .catch(() => {
      /* No service worker to detach; nothing to do. */
    })
}

export function installFloorExperiment(search = window.location.search) {
  const params = parseParams(search)
  if (!params.enabled) return null

  detachServiceWorker()
  setChannelLogger(consoleLog)

  const driver = createDriver({ log: consoleLog, params })
  // Only the run's own data channel, read at construction time so a console
  // change to the config before connecting still takes effect.
  onConnectionCreated((pc) => attachFloorChannels(pc, driver.config().transports))
  driver.install()

  // Console access, and the results handle the run instructions refer to.
  window.__floorExp = {
    get results() {
      return driver.rows.value
    },
    get phase() {
      return driver.phase.value
    },
    get blockedReason() {
      return driver.blockedReason.value
    },
    get readiness() {
      return driver.readiness.value
    },
    config: driver.config,
    setConfig: driver.setConfig,
    summary: driver.summary,
    probe: driver.probe,
    retryReady: driver.waitForReady,
    start: driver.start,
    stop: driver.stop,
    exportCsv: driver.exportCsv,
    controller: driver.controller,
    driver,
    /**
     * Channel internals, for diagnostics and for the loopback end-to-end check
     * in cypress/e2e/floor-transport.cy.js — a negotiated channel can only be
     * verified against a real browser.
     */
    channels: {
      specs: CHANNEL_SPECS,
      attach: attachFloorChannels,
      settings: channelSettings,
    },
  }

  const mount = () => {
    if (document.getElementById(ROOT_ID)) return
    const root = document.createElement('div')
    root.id = ROOT_ID
    document.body.appendChild(root)
    createApp({ render: () => h(FloorExpPanel, { driver }) }).mount(root)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }

  consoleLog('info', 'experiment armed — window.__floorExp')
  return driver
}

if (typeof window !== 'undefined') installFloorExperiment()
