<script setup>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { outputMuted, outputVolume, setOutputVolume, toggleOutputMute } from '@/stores/session'

const percent = computed(() => Math.round(outputVolume.value * 100))
const silent = computed(() => outputMuted.value || outputVolume.value === 0)
</script>

<template>
  <div class="volume">
    <button
      type="button"
      class="volume__btn"
      :class="{ 'volume__btn--off': silent }"
      :aria-label="silent ? 'Unmute output' : 'Mute output'"
      :aria-pressed="silent"
      :title="silent ? 'Unmute output' : 'Mute output'"
      @click="toggleOutputMute"
    >
      <AppIcon :name="silent ? 'speakerOff' : 'speaker'" :size="17" />
    </button>

    <input
      class="volume__slider"
      type="range"
      min="0"
      max="100"
      :value="percent"
      aria-label="Output volume"
      :aria-valuetext="`${percent}%`"
      @input="setOutputVolume($event.target.value / 100)"
    />
    <span class="volume__value">{{ silent ? '—' : `${percent}%` }}</span>
  </div>
</template>

<style scoped>
.volume {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.volume__btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
}

.volume__btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.volume__btn--off {
  color: var(--danger-500);
}

.volume__slider {
  width: 86px;
  height: 4px;
  appearance: none;
  background: var(--border-strong);
  border-radius: 999px;
  cursor: pointer;
}

.volume__slider::-webkit-slider-thumb {
  appearance: none;
  width: 13px;
  height: 13px;
  background: var(--brand-600);
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.volume__slider::-moz-range-thumb {
  width: 13px;
  height: 13px;
  background: var(--brand-600);
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.volume__value {
  width: 4ch;
  font-size: 11.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

@media (max-width: 1100px) {
  .volume__slider {
    width: 62px;
  }

  .volume__value {
    display: none;
  }
}
</style>
