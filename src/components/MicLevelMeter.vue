<script setup>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { micLevel, micTestActive, stopMicTest } from '@/stores/session'

const SEGMENTS = 20

/** Lit segment count, so the meter reads like hardware rather than a progress bar. */
const lit = computed(() => Math.round(micLevel.value * SEGMENTS))

const verdict = computed(() => {
  if (micLevel.value < 0.04) return { tone: 'quiet', text: 'No input detected — say something' }
  if (micLevel.value > 0.92) return { tone: 'hot', text: 'Too loud — clipping likely' }
  return { tone: 'ok', text: 'Input level looks good' }
})

/** Segment colour: green through most of the range, amber then red at the top. */
function toneOf(index) {
  const ratio = index / SEGMENTS
  if (ratio > 0.9) return 'hot'
  if (ratio > 0.75) return 'warn'
  return 'ok'
}
</script>

<template>
  <Transition name="meter">
    <div v-if="micTestActive" class="meter" role="status">
      <div class="meter__head">
        <AppIcon name="activity" :size="16" class="meter__icon" />
        <span class="meter__title">Microphone test</span>
        <span class="meter__verdict" :class="`meter__verdict--${verdict.tone}`">
          {{ verdict.text }}
        </span>
        <button type="button" class="meter__stop" @click="stopMicTest">Stop</button>
      </div>

      <div class="meter__bars" aria-hidden="true">
        <span
          v-for="n in SEGMENTS"
          :key="n"
          class="meter__bar"
          :class="[`meter__bar--${toneOf(n)}`, { 'meter__bar--on': n <= lit }]"
        />
      </div>

      <p class="meter__note">Audio stays local — nothing is transmitted during the test.</p>
    </div>
  </Transition>
</template>

<style scoped>
.meter {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface-sunken);
}

.meter__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meter__icon {
  color: var(--brand-600);
  flex-shrink: 0;
}

.meter__title {
  font-size: 13px;
  font-weight: 600;
}

.meter__verdict {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meter__verdict--ok {
  color: var(--ok-500);
}

.meter__verdict--hot {
  color: var(--danger-500);
}

.meter__stop {
  padding: 5px 12px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
}

.meter__stop:hover {
  border-color: var(--border-strong);
}

.meter__bars {
  display: flex;
  gap: 3px;
  height: 20px;
}

.meter__bar {
  flex: 1;
  border-radius: 2px;
  background: var(--border);
  transition:
    background-color 0.06s linear,
    opacity 0.06s linear;
  opacity: 0.55;
}

.meter__bar--on {
  opacity: 1;
}

.meter__bar--on.meter__bar--ok {
  background: var(--ok-500);
}

.meter__bar--on.meter__bar--warn {
  background: var(--warn-500);
}

.meter__bar--on.meter__bar--hot {
  background: var(--danger-500);
}

.meter__note {
  font-size: 11.5px;
  color: var(--text-faint);
}

.meter-enter-active,
.meter-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.meter-enter-from,
.meter-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
