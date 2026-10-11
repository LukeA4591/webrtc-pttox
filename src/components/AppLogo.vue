<script setup>
/** PTToX waveform mark. Bars animate only while the operator holds the floor. */
defineProps({
  live: { type: Boolean, default: false },
})

const BARS = [
  { x: 0, h: 10 },
  { x: 5, h: 20 },
  { x: 10, h: 14 },
  { x: 15, h: 24 },
  { x: 20, h: 8 },
]
</script>

<template>
  <span class="logo" :class="{ 'logo--live': live }">
    <svg width="28" height="28" viewBox="0 0 24 28" aria-hidden="true">
      <rect
        v-for="(bar, index) in BARS"
        :key="bar.x"
        class="logo__bar"
        :style="{ animationDelay: `${index * 0.1}s` }"
        :x="bar.x"
        :y="(28 - bar.h) / 2"
        :height="bar.h"
        width="3"
        rx="1.5"
        fill="currentColor"
      />
    </svg>
    <span class="logo__word">PTToX</span>
  </span>
</template>

<style scoped>
.logo {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--brand-600);
}

.logo__word {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
}

.logo--live .logo__bar {
  animation: pulse 0.7s ease-in-out infinite alternate;
  transform-origin: center;
}

@keyframes pulse {
  from {
    transform: scaleY(0.55);
  }
  to {
    transform: scaleY(1.15);
  }
}
</style>
