<script setup>
/**
 * RQ3 run console: readiness, start/stop, progress and the live per-transport
 * medians. Mounted only when `?exp=floor` is present, so the normal client is
 * untouched without it.
 *
 * It is a run console rather than a settings panel on purpose — the run
 * parameters belong in the URL so that a condition and its results file can be
 * traced back to one another.
 */
import { computed, onUnmounted } from 'vue'
import { TRANSPORT_IDS } from './transports'
import { channelSettings } from './channels'

const props = defineProps({ driver: { type: Object, required: true } })

const driver = props.driver
const config = computed(() => driver.config())
const phase = driver.phase
const progress = driver.progress
const readiness = driver.readiness

const gates = computed(() => [
  ['peer connection', readiness.value.peerConnection],
  ['can talk', readiness.value.canTalk],
  ...TRANSPORT_IDS.filter((id) => config.value.transports.includes(id)).map((id) => [
    id,
    readiness.value[id],
  ]),
])

/** Denials are expected now, so show their reasons without opening the CSV. */
const denials = computed(() =>
  summary.value.flatMap((entry) =>
    Object.entries(entry.denyReasons ?? {}).map(([reason, count]) => ({
      reason,
      count,
      transport: entry.transport,
    })),
  ),
)

const summary = computed(() => (driver.rows.value.length ? driver.summary() : []))
const channels = computed(() => Object.entries(channelSettings()))

const running = computed(() => phase.value === 'running' || phase.value === 'stopping')

onUnmounted(() => driver.uninstall())
</script>

<template>
  <section class="floor-exp" aria-label="RQ3 floor transport experiment">
    <header>
      <strong>RQ3 floor transport</strong>
      <span :class="['phase', `phase--${phase}`]">{{ phase }}</span>
    </header>

    <div class="body">
      <p class="label">
        {{ config.label }} · seed {{ config.seed }} · {{ config.trials }}+{{
          config.warmup
        }}/transport · {{ config.intervalMs }}ms interval · hold {{ config.holdMs }}ms · retry
        {{ config.retryMs }}ms · timeout {{ config.timeoutMs }}ms
      </p>

      <ul class="gates">
        <li v-for="[name, ok] in gates" :key="name" :class="{ ok }">
          <span aria-hidden="true">{{ ok ? '●' : '○' }}</span> {{ name }}
        </li>
      </ul>

      <div v-if="phase === 'blocked'" class="blocked">
        <p>{{ driver.blockedReason.value }}</p>
        <button type="button" @click="driver.waitForReady()">Re-check</button>
      </div>
      <p v-else-if="phase === 'probing'" class="hint">
        Probing each transport for a reply — an open channel does not prove the server is listening
        on it.
      </p>
      <p v-else-if="phase === 'ready'" class="hint">
        Connected. Apply the network condition now, then press Start.
      </p>
      <p v-else-if="phase === 'waiting'" class="hint">
        Waiting for {{ config.transports.join(', ') }} and a connected peer.
      </p>

      <div class="actions">
        <button
          type="button"
          :disabled="phase !== 'ready' && phase !== 'done' && phase !== 'stopped'"
          @click="driver.start()"
        >
          Start
        </button>
        <button type="button" :disabled="!running" @click="driver.stop()">Stop</button>
        <button type="button" :disabled="!driver.rows.value.length" @click="driver.exportCsv()">
          CSV
        </button>
      </div>

      <p v-if="progress.total" class="progress">
        {{ progress.done }} / {{ progress.total }} trials
        <progress :value="progress.done" :max="progress.total" />
      </p>

      <table v-if="summary.length">
        <thead>
          <tr>
            <th>transport</th>
            <th>n</th>
            <th>median</th>
            <th>t/o</th>
            <th>retried</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in summary" :key="entry.transport">
            <td>{{ entry.transport }}</td>
            <td>{{ entry.trials }}</td>
            <td>{{ entry.medianAccessMs ?? '—' }}</td>
            <td>{{ entry.timeout }}</td>
            <td>{{ entry.retried }}</td>
          </tr>
        </tbody>
      </table>

      <dl v-if="channels.length" class="channels">
        <template v-for="[id, settings] in channels" :key="id">
          <dt>{{ id }}</dt>
          <dd>
            id={{ settings.id }} ordered={{ settings.ordered }} maxRetransmits={{
              settings.maxRetransmits ?? 'null'
            }}
          </dd>
        </template>
      </dl>

      <ul v-if="denials.length" class="denials">
        <li v-for="entry in denials" :key="`${entry.transport}-${entry.reason}`">
          {{ entry.transport }} denied {{ entry.count }}× — {{ entry.reason }}
        </li>
      </ul>

      <ul v-if="driver.notes.value.length" class="notes">
        <li v-for="(entry, index) in driver.notes.value" :key="index">{{ entry }}</li>
      </ul>

      <p class="warn">Keep this tab visible and focused — background tabs throttle timers.</p>
    </div>
  </section>
</template>

<style scoped>
.floor-exp {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 9999;
  width: 320px;
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
.body {
  padding: 10px;
  max-height: 70vh;
  overflow-y: auto;
}
.phase {
  padding: 1px 6px;
  border: 1px solid #334155;
  border-radius: 10px;
  text-transform: uppercase;
  font-size: 10px;
}
.phase--ready,
.phase--done {
  border-color: #16a34a;
  color: #86efac;
}
.phase--running {
  border-color: #eab308;
  color: #fde047;
}
.phase--blocked {
  border-color: #b91c1c;
  color: #fca5a5;
}
.phase--probing {
  border-color: #eab308;
  color: #fde047;
}
.label {
  color: #94a3b8;
  margin-bottom: 8px;
}
.gates {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  list-style: none;
  margin-bottom: 8px;
}
.gates li {
  color: #94a3b8;
}
.gates li.ok {
  color: #86efac;
}
.hint {
  margin-bottom: 8px;
  color: #fde047;
}
.actions {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
button {
  flex: 1;
  padding: 5px 0;
  font: inherit;
  color: #e2e8f0;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 5px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.progress {
  margin-bottom: 8px;
}
progress {
  width: 100%;
  height: 4px;
}
table {
  width: 100%;
  margin-bottom: 8px;
  border-collapse: collapse;
}
th,
td {
  padding: 2px 4px;
  text-align: right;
  border-bottom: 1px solid #1e293b;
}
th:first-child,
td:first-child {
  text-align: left;
}
th {
  color: #94a3b8;
  font-weight: 400;
}
.channels {
  margin-bottom: 8px;
  color: #94a3b8;
}
.channels dt {
  color: #cbd5e1;
}
.channels dd {
  margin: 0 0 4px;
}
.blocked {
  margin-bottom: 8px;
  padding: 6px;
  color: #fecaca;
  background: #7f1d1d55;
  border: 1px solid #b91c1c;
  border-radius: 5px;
}
.blocked button {
  margin-top: 6px;
}
.denials,
.notes {
  list-style: none;
  margin-bottom: 8px;
  color: #fca5a5;
}
.denials {
  color: #fcd34d;
}
.warn {
  color: #94a3b8;
  border-top: 1px solid #1e293b;
  padding-top: 6px;
}
</style>
