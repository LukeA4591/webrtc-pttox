<script setup>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { dismissToast, needRefresh, offlineReady, updateApp } from '@/pwa'

const visible = computed(() => needRefresh.value || offlineReady.value)
</script>

<template>
  <Transition name="toast">
    <div v-if="visible" class="toast card" role="status">
      <AppIcon :name="needRefresh ? 'check' : 'wifi'" :size="17" class="toast__icon" />
      <p class="toast__text">
        {{ needRefresh ? 'A new version is available.' : 'Ready to work offline.' }}
      </p>
      <button v-if="needRefresh" type="button" class="toast__action" @click="updateApp">
        Reload
      </button>
      <button type="button" class="toast__close" aria-label="Dismiss" @click="dismissToast">
        ×
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* Sits below the header rather than at the bottom, where it would cover the
   microphone and speaker controls. */
.toast {
  position: fixed;
  left: 50%;
  top: calc(var(--header-h) + 12px);
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px 11px 14px;
  transform: translateX(-50%);
  box-shadow: var(--shadow-lg);
  max-width: calc(100vw - 32px);
}

.toast__icon {
  color: var(--brand-600);
  flex-shrink: 0;
}

.toast__text {
  font-size: 13px;
}

.toast__action {
  padding: 6px 11px;
  background: var(--brand-600);
  border: 0;
  border-radius: var(--radius-sm);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.toast__action:hover {
  background: var(--brand-700);
}

.toast__close {
  padding: 0 4px;
  background: none;
  border: 0;
  color: var(--text-muted);
  font-size: 19px;
  line-height: 1;
  cursor: pointer;
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -12px);
}
</style>
