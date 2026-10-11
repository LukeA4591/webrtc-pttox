<script setup>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { inboundMuted, receiving, stripPrefix } from '@/stores/session'

const who = computed(() => receiving.value?.userAlias || 'Unknown station')
const where = computed(() => stripPrefix(receiving.value?.groupId))
</script>

<template>
  <!-- The slot keeps a constant height so the PTT button never jumps when a
       transmission starts or stops. -->
  <div class="rx-slot">
    <Transition name="rx">
      <!-- Silenced traffic still shows, but must never look like it is audible:
           an operator hearing nothing needs to know whether it is their mute or
           a dead link. -->
      <div v-if="receiving" class="rx" :class="{ 'rx--muted': inboundMuted }" role="status">
        <span class="rx__bars" aria-hidden="true">
          <i v-for="n in 4" :key="n" :style="{ animationDelay: `${n * 0.12}s` }" />
        </span>
        <span class="rx__text">
          <strong>{{ who }}</strong>
          <span v-if="where" class="rx__where">on {{ where }}</span>
          <span v-if="inboundMuted" class="rx__where">— muted</span>
        </span>
        <AppIcon :name="inboundMuted ? 'speakerOff' : 'speaker'" :size="16" class="rx__icon" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.rx-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 54px;
  flex-shrink: 0;
  padding: 0 16px;
}

.rx {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--ok-100);
  border: 1px solid color-mix(in srgb, var(--ok-500) 45%, transparent);
  border-radius: 999px;
  font-size: 13px;
  color: var(--ok-500);
}

.rx--muted {
  background: var(--surface-sunken);
  border-color: var(--border);
  color: var(--text-faint);
}

/* Frozen bars read as "carrier present but silenced", not as dead air. */
.rx--muted .rx__bars i {
  animation: none;
  transform: scaleY(0.35);
}

.rx--muted .rx__text {
  color: var(--text-muted);
}

.rx__bars {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 14px;
}

.rx__bars i {
  width: 3px;
  height: 100%;
  background: currentColor;
  border-radius: 2px;
  animation: bounce 0.6s ease-in-out infinite alternate;
}

@keyframes bounce {
  from {
    transform: scaleY(0.3);
  }
  to {
    transform: scaleY(1);
  }
}

.rx__text {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--text);
}

.rx__where {
  color: var(--text-muted);
  font-size: 12px;
}

.rx__icon {
  flex-shrink: 0;
}

.rx-enter-active,
.rx-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.rx-enter-from,
.rx-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
