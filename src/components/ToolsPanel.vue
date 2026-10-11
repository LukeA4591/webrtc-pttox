<script setup>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import PanSelect from './PanSelect.vue'
import {
  defaultPan,
  headphonesConnected,
  isConnected,
  networkQuality,
  networkStats,
  setDefaultPan,
  stereoRouting,
  toggleStereoRouting,
} from '@/stores/session'

const network = computed(() => {
  const detail = networkStats.value
  const rtt = detail?.rttMs != null ? `${Math.round(detail.rttMs)} ms` : null
  return (
    {
      good: { tone: 'ok', icon: 'wifi', label: rtt ? `Good · ${rtt}` : 'Good' },
      fair: { tone: 'warn', icon: 'wifi', label: rtt ? `Fair · ${rtt}` : 'Fair' },
      poor: { tone: 'danger', icon: 'alert', label: rtt ? `Poor · ${rtt}` : 'Poor' },
      unknown: {
        tone: 'muted',
        icon: 'alert',
        label: isConnected.value ? 'Measuring…' : 'Unknown',
      },
    }[networkQuality.value] ?? { tone: 'muted', icon: 'alert', label: 'Unknown' }
  )
})

const headphones = computed(() =>
  headphonesConnected.value
    ? { tone: 'ok', label: 'Connected' }
    : { tone: 'muted', label: 'Not connected' },
)
</script>

<template>
  <div class="tools">
    <p class="panel-label">Tools</p>

    <div class="tool card">
      <AppIcon
        name="headphones"
        :size="22"
        class="tool__icon"
        :class="`tone--${headphones.tone}`"
      />
      <span class="tool__text">
        <span class="tool__title">Headphones</span>
        <span class="tool__value">{{ headphones.label }}</span>
      </span>
    </div>

    <div class="tool card">
      <AppIcon
        :name="network.icon"
        :size="22"
        class="tool__icon"
        :class="`tone--${network.tone}`"
      />
      <span class="tool__text">
        <span class="tool__title">Network</span>
        <span class="tool__value">{{ network.label }}</span>
      </span>
    </div>

    <div class="tool tool--stacked card">
      <div class="tool__head">
        <AppIcon
          name="speaker"
          :size="22"
          class="tool__icon"
          :class="stereoRouting ? 'tone--ok' : 'tone--muted'"
        />
        <span class="tool__text">
          <span class="tool__title">Stereo routing</span>
          <span class="tool__value">{{ stereoRouting ? 'On' : 'Off' }}</span>
        </span>
        <button
          type="button"
          class="switch"
          :class="{ 'switch--on': stereoRouting }"
          role="switch"
          :aria-checked="stereoRouting"
          aria-label="Stereo routing"
          @click="toggleStereoRouting"
        >
          <span class="switch__knob" />
        </button>
      </div>

      <template v-if="stereoRouting">
        <div class="tool__row">
          <span class="tool__rowlabel">Other groups</span>
          <PanSelect
            :model-value="defaultPan"
            label="Ear for groups with no choice of their own"
            @update:model-value="setDefaultPan"
          />
        </div>

        <p class="tool__note">
          Set an ear per group in the sidebar. Separation needs headphones, and Bluetooth headsets
          drop to mono while the microphone is open.
          <template v-if="!headphonesConnected"> No headphones detected. </template>
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tools {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.panel-label {
  margin-bottom: 2px;
}

.tool {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
}

/* Cards that grow controls below the headline rather than sitting on one line. */
.tool--stacked {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.tool__head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tool__head .tool__text {
  flex: 1;
}

.tool__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tool__rowlabel {
  font-size: 12px;
  color: var(--text-muted);
}

.tool__note {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-faint);
}

.switch {
  position: relative;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
  padding: 0;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}

.switch--on {
  background: var(--brand-600);
  border-color: var(--brand-600);
}

.switch__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: var(--surface);
  border-radius: 50%;
  transition: transform 0.15s;
}

.switch--on .switch__knob {
  background: #fff;
  transform: translateX(16px);
}

.tool__icon {
  flex-shrink: 0;
}

.tool__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.35;
}

.tool__title {
  font-size: 13.5px;
  font-weight: 600;
}

.tool__value {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tone--ok {
  color: var(--ok-500);
}

.tone--warn {
  color: var(--warn-500);
}

.tone--danger {
  color: var(--danger-500);
}

.tone--muted {
  color: var(--text-muted);
}
</style>
