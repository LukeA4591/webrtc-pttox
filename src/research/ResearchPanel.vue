<script setup>
/**
 * RQ2 research panel. Mounts itself into its own root element, reads the
 * session store read-only, and never writes to it.
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { mediaReady, remoteStream, selectedServer } from '@/stores/session'
import {
  activeConnection,
  jitterBufferTargetSupported,
  readJitterBufferTarget,
  setJitterBufferTarget,
} from './peerConnections'
import { audioExtension, download, fileBaseName, metaJson, startTrial, statsCsv } from './trial'
import { localWsEnabled, rewriteSignallingUrl, setLocalWsEnabled } from './localSignalling'

/** 50 ms is the real floor — libwebrtc caches stats reports for that long. */
const SAMPLE_INTERVAL_MS = 50
const IDLE_MONITOR_MS = 500
const PRESETS = [null, 50, 100, 200, 400]

const collapsed = ref(false)
const supported = jitterBufferTargetSupported()

const targetInput = ref('')
const appliedTarget = ref(null)
const applyError = ref('')

/* -- signalling URL ------------------------------------------------------- */

const localWs = ref(localWsEnabled())

watch(localWs, (value) => setLocalWsEnabled(value))

/**
 * What the client will actually dial for the currently selected server.
 * Recomputed from the toggle as well as the server, so flipping the checkbox
 * updates the displayed URL immediately.
 */
const rewritten = computed(() => {
  void localWs.value
  if (!selectedServer.value) return null
  return rewriteSignallingUrl(`wss://${selectedServer.value}/api/webrtc/ws`)
})

const effectiveUrl = computed(() => rewritten.value?.url ?? null)
const urlNotes = computed(() => rewritten.value?.notes ?? [])

const label = ref('baseline')
const conditions = ref('')
const intervalMs = ref(SAMPLE_INTERVAL_MS)

const running = ref(false)
const sampleCount = ref(0)
const elapsedMs = ref(0)
const liveDelayMs = ref(null)
const playoutOk = ref(null)
const finished = ref(null)
const lastSaved = ref('')

/**
 * On by default: a finished trial lives only in memory, and starting the next
 * one discards it. Across a randomised run of many trials that is a silent,
 * unrecoverable loss, so saving on stop is the safer default.
 */
const autoExport = ref(true)

let handle = null
let ticker = null
let idleTimer = null
let idlePrevious = null

/* -- jitter buffer target ------------------------------------------------- */

function apply(ms) {
  applyError.value = ''
  const pc = activeConnection()
  if (!pc) {
    applyError.value = 'No peer connection — connect first.'
    return
  }
  if (!setJitterBufferTarget(ms, pc)) {
    applyError.value = 'Receiver did not accept the target.'
    return
  }
  appliedTarget.value = readJitterBufferTarget(pc)
  targetInput.value = ms == null ? '' : String(ms)
}

function applyCustom() {
  const value = Number(targetInput.value)
  if (!Number.isFinite(value) || value < 0) {
    applyError.value = 'Enter a non-negative number of milliseconds.'
    return
  }
  apply(value)
}

// A new connection means a new receiver, so the target has to be re-applied.
watch(mediaReady, (ready) => {
  if (ready && appliedTarget.value != null) apply(appliedTarget.value)
})

/* -- live readout (cheap, so the effect of a change is visible) ----------- */

async function idleTick() {
  const pc = activeConnection()
  if (!pc || running.value) return
  const { sample, markFreshness } = await import('./statsSampler')
  const row = await sample(pc, performance.now())
  if (!row) return
  markFreshness(row, idlePrevious)
  if (idlePrevious && row.fresh) {
    const delay = row.jitterBufferDelay - idlePrevious.jitterBufferDelay
    const emitted = row.jitterBufferEmittedCount - idlePrevious.jitterBufferEmittedCount
    liveDelayMs.value = emitted > 0 ? Number(((delay / emitted) * 1000).toFixed(1)) : null
    playoutOk.value = emitted > 0
  }
  if (row.fresh) idlePrevious = { ...row, statsTimestamp: row.statsTimestamp }
}

idleTimer = setInterval(idleTick, IDLE_MONITOR_MS)

/* -- trial --------------------------------------------------------------- */

function start() {
  const pc = activeConnection()
  if (!pc) {
    applyError.value = 'No peer connection — connect first.'
    return
  }
  finished.value = null
  handle = startTrial({
    pc,
    stream: remoteStream.value ?? undefined,
    label: label.value,
    intervalMs: Number(intervalMs.value) || SAMPLE_INTERVAL_MS,
    conditions: conditions.value,
  })
  running.value = true
  ticker = setInterval(() => {
    sampleCount.value = handle.sampleCount
    elapsedMs.value = Math.round(handle.elapsedMs)
    const latest = handle.latest
    if (latest) playoutOk.value = latest.totalSamplesReceived != null
  }, 250)
}

async function stop() {
  if (!handle) return
  clearInterval(ticker)
  ticker = null
  finished.value = await handle.stop()
  handle = null
  running.value = false
  if (autoExport.value) exportAll()
}

function exportAll() {
  const trial = finished.value
  if (!trial) return
  const base = fileBaseName(trial)
  download(new Blob([statsCsv(trial)], { type: 'text/csv' }), `${base}-stats.csv`)
  download(new Blob([metaJson(trial)], { type: 'application/json' }), `${base}-meta.json`)
  if (trial.audioBlob) download(trial.audioBlob, `${base}-audio.${audioExtension(trial)}`)
  lastSaved.value = base
}

const summary = computed(() => finished.value?.derived ?? null)

onUnmounted(() => {
  clearInterval(idleTimer)
  clearInterval(ticker)
})
</script>

<template>
  <section class="research" :class="{ collapsed }">
    <header>
      <strong>RQ2 research</strong>
      <button type="button" @click="collapsed = !collapsed">
        {{ collapsed ? 'Show' : 'Hide' }}
      </button>
    </header>

    <div v-if="!collapsed" class="body">
      <!-- signalling -->
      <fieldset>
        <legend>Signalling</legend>
        <label class="check">
          <input v-model="localWs" type="checkbox" />
          <span>Use ws:// for local addresses</span>
        </label>
        <p class="url">
          {{ effectiveUrl ?? 'no server selected' }}
        </p>
        <p v-for="note in urlNotes" :key="note" class="note">↳ {{ note }}</p>
        <p class="hint">
          The server field wants a bare host, e.g. <code>192.168.88.4:8080</code> — not a full URL.
        </p>
      </fieldset>

      <!-- jitter buffer -->
      <fieldset>
        <legend>Jitter buffer target (ms)</legend>
        <p v-if="!supported" class="warn">
          This browser does not expose <code>jitterBufferTarget</code>. Chrome 114+ required.
        </p>
        <template v-else>
          <div class="row">
            <button
              v-for="preset in PRESETS"
              :key="String(preset)"
              type="button"
              @click="apply(preset)"
            >
              {{ preset === null ? 'Default' : preset }}
            </button>
          </div>
          <div class="row">
            <input
              v-model="targetInput"
              type="number"
              min="0"
              step="10"
              placeholder="custom ms"
              aria-label="Custom jitter buffer target in milliseconds"
            />
            <button type="button" @click="applyCustom">Apply</button>
          </div>
          <dl>
            <dt>Requested</dt>
            <dd>{{ appliedTarget == null ? 'browser default' : appliedTarget + ' ms' }}</dd>
            <dt>Achieved</dt>
            <dd>{{ liveDelayMs == null ? '—' : liveDelayMs + ' ms' }}</dd>
            <dt>Playout</dt>
            <dd :class="playoutOk === false ? 'warn' : ''">
              {{ playoutOk == null ? '—' : playoutOk ? 'advancing' : 'STALLED' }}
            </dd>
          </dl>
        </template>
      </fieldset>

      <!-- trial -->
      <fieldset>
        <legend>Trial</legend>
        <label class="field">
          <span>Label</span>
          <input v-model="label" placeholder="baseline" />
        </label>
        <label class="field">
          <span>Poll interval (ms)</span>
          <input v-model="intervalMs" type="number" min="20" step="10" />
        </label>
        <label class="field">
          <span>Conditions</span>
          <input v-model="conditions" placeholder="netem: delay 100ms 20ms loss 3%" />
        </label>
        <label class="check">
          <input v-model="autoExport" type="checkbox" />
          <span>Save files on stop</span>
        </label>
        <div class="row">
          <button type="button" :disabled="running" @click="start">Start</button>
          <button type="button" :disabled="!running" @click="stop">Stop</button>
          <button type="button" :disabled="!finished" @click="exportAll">Save now</button>
        </div>
        <p v-if="running" class="live">
          {{ (elapsedMs / 1000).toFixed(1) }} s · {{ sampleCount }} samples
        </p>
        <p v-if="lastSaved" class="live">Saved to your browser downloads: {{ lastSaved }}-*</p>
        <p v-if="finished && !lastSaved" class="warn">
          Not saved yet — starting another trial discards this one.
        </p>
        <p v-if="applyError" class="warn">{{ applyError }}</p>
      </fieldset>

      <!-- result -->
      <fieldset v-if="summary">
        <legend>Last trial</legend>
        <p v-if="!summary.usable" class="warn">Void: {{ summary.reason }}</p>
        <dl v-else>
          <dt>Achieved delay</dt>
          <dd>{{ summary.achievedJitterBufferDelayMs }} ms</dd>
          <dt>Concealment</dt>
          <dd>{{ (summary.concealmentProportion * 100).toFixed(4) }} %</dd>
          <dt>Loss</dt>
          <dd>{{ (summary.lossFraction * 100).toFixed(3) }} %</dd>
          <dt>Samples</dt>
          <dd>{{ summary.freshSamples }} fresh / {{ summary.duplicateSamples }} dup</dd>
        </dl>
      </fieldset>
    </div>
  </section>
</template>

<style scoped>
.research {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 9999;
  width: 310px;
  font:
    12px/1.45 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  color: #e2e8f0;
  background: #0f172aee;
  border: 1px solid #334155;
  border-radius: 8px;
  backdrop-filter: blur(4px);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid #1e293b;
}
.collapsed header {
  border-bottom: 0;
}
.body {
  padding: 10px;
  max-height: 70vh;
  overflow-y: auto;
}
fieldset {
  border: 1px solid #1e293b;
  border-radius: 6px;
  margin: 0 0 10px;
  padding: 8px;
}
legend {
  padding: 0 4px;
  color: #94a3b8;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.field {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}
.field > span {
  flex: 0 0 104px;
  color: #94a3b8;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: #94a3b8;
  cursor: pointer;
}
.check input {
  flex: 0 0 auto;
  width: auto;
  accent-color: #2563eb;
}
button {
  font: inherit;
  padding: 4px 8px;
  color: #e2e8f0;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 4px;
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: #334155;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
input {
  flex: 1 1 80px;
  min-width: 0;
  font: inherit;
  padding: 4px 6px;
  color: #e2e8f0;
  background: #020617;
  border: 1px solid #334155;
  border-radius: 4px;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 8px;
  margin: 4px 0 0;
}
dt {
  color: #94a3b8;
}
dd {
  margin: 0;
}
.warn {
  color: #fca5a5;
  margin: 4px 0 0;
}
.live {
  margin: 4px 0 0;
  color: #86efac;
}
.url {
  margin: 4px 0 0;
  padding: 4px 6px;
  color: #93c5fd;
  background: #020617;
  border-radius: 4px;
  overflow-wrap: anywhere;
}
.note {
  margin: 3px 0 0;
  color: #fcd34d;
}
.hint {
  margin: 4px 0 0;
  color: #64748b;
}
code {
  color: #fcd34d;
}
</style>
