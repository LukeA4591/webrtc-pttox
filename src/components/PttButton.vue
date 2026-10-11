<script setup>
/**
 * Push-to-talk control. Hold with pointer or the space bar; releasing always
 * gives the floor back, including when the pointer leaves the button mid-press
 * (pointer capture) or the tab loses focus.
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'
import {
  canTalk,
  floorState,
  isConnected,
  micMuted,
  micTestActive,
  mediaReady,
  pressPtt,
  releasePtt,
} from '@/stores/session'

const held = computed(() => floorState.value !== 'idle')

const caption = computed(() => {
  if (micMuted.value) return { title: 'Microphone muted', hint: 'Unmute to transmit' }
  if (micTestActive.value) return { title: 'Testing microphone', hint: 'Stop the test to transmit' }
  if (!isConnected.value) return { title: 'Disconnected', hint: 'Connect to a server to talk' }
  if (!mediaReady.value) return { title: 'Preparing audio…', hint: 'Negotiating the media session' }
  return (
    {
      idle: { title: 'Push to Talk', hint: 'Hold to speak' },
      requesting: { title: 'Requesting floor…', hint: 'Waiting for the server' },
      granted: { title: 'You are live', hint: 'Release to stop' },
      denied: { title: 'Floor denied', hint: 'Someone else is speaking' },
    }[floorState.value] ?? { title: 'Push to Talk', hint: 'Hold to speak' }
  )
})

function onPointerDown(event) {
  if (event.button !== 0 && event.pointerType === 'mouse') return
  event.preventDefault()
  event.currentTarget.setPointerCapture?.(event.pointerId)
  pressPtt()
}

function onPointerUp() {
  releasePtt()
}

function isTypingTarget(target) {
  return target?.matches?.('input, textarea, select, [contenteditable="true"]')
}

function onKeyDown(event) {
  if (event.code !== 'Space' || event.repeat || isTypingTarget(event.target)) return
  event.preventDefault()
  pressPtt()
}

function onKeyUp(event) {
  if (event.code !== 'Space' || isTypingTarget(event.target)) return
  event.preventDefault()
  releasePtt()
}

// Losing focus or visibility mid-press must not leave the mic open.
function onBlur() {
  releasePtt()
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onBlur)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onBlur)
  document.removeEventListener('visibilitychange', onBlur)
  releasePtt()
})
</script>

<template>
  <div class="ptt">
    <button
      type="button"
      class="ptt__button"
      :class="[`ptt__button--${canTalk ? floorState : 'off'}`, { 'ptt__button--muted': micMuted }]"
      :disabled="!canTalk"
      :aria-pressed="held"
      aria-label="Push to talk. Hold to speak."
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @contextmenu.prevent
    >
      <span class="ptt__ring" aria-hidden="true" />
      <AppIcon :name="micMuted ? 'micOff' : 'mic'" :size="52" class="ptt__icon" />
    </button>

    <h2 class="ptt__title">{{ caption.title }}</h2>
    <p class="ptt__hint">{{ caption.hint }}</p>
    <p class="ptt__kbd" aria-hidden="true">or hold <kbd>Space</kbd></p>
  </div>
</template>

<style scoped>
.ptt {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 28px 20px;
}

.ptt__button {
  position: relative;
  display: grid;
  place-items: center;
  width: clamp(180px, 26vh, 240px);
  aspect-ratio: 1;
  margin-bottom: 26px;
  background: var(--brand-50);
  border: 1px solid var(--brand-200);
  border-radius: 50%;
  color: var(--brand-600);
  cursor: pointer;
  touch-action: none;
  transition:
    transform 0.12s ease,
    background-color 0.15s,
    border-color 0.15s,
    box-shadow 0.15s;
  box-shadow: var(--shadow);
}

.ptt__button:hover:not(:disabled) {
  background: var(--brand-100);
}

.ptt__button--off {
  background: var(--surface-hover);
  border-color: var(--border);
  color: var(--text-faint);
  cursor: not-allowed;
  box-shadow: none;
}

.ptt__button--requesting {
  background: var(--warn-100);
  border-color: var(--warn-500);
  color: var(--warn-500);
  transform: scale(0.96);
}

.ptt__button--granted {
  background: var(--ok-100);
  border-color: var(--ok-500);
  color: var(--ok-500);
  transform: scale(0.96);
  box-shadow: 0 0 0 8px color-mix(in srgb, var(--ok-500) 18%, transparent);
}

.ptt__button--denied {
  background: var(--danger-100);
  border-color: var(--danger-500);
  color: var(--danger-500);
}

/* Muting is a deliberate state, so it reads as red rather than merely inactive. */
.ptt__button--muted {
  background: var(--danger-100);
  border-color: var(--danger-500);
  color: var(--danger-500);
}

.ptt__ring {
  position: absolute;
  inset: -14px;
  border-radius: 50%;
  border: 2px solid transparent;
}

.ptt__button--granted .ptt__ring {
  border-color: var(--ok-500);
  animation: ripple 1.4s ease-out infinite;
}

@keyframes ripple {
  0% {
    transform: scale(0.92);
    opacity: 0.8;
  }
  100% {
    transform: scale(1.12);
    opacity: 0;
  }
}

.ptt__icon {
  position: relative;
}

.ptt__title {
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.ptt__hint {
  font-size: 14px;
  color: var(--text-muted);
}

.ptt__kbd {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-faint);
}

kbd {
  padding: 2px 6px;
  background: var(--surface-hover);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 5px;
  font-family: inherit;
  font-size: 11px;
}

@media (max-width: 720px) {
  .ptt__kbd {
    display: none;
  }
}
</style>
