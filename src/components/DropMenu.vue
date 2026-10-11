<script setup>
/**
 * Small popover menu. The trigger is supplied via the `trigger` slot, the
 * contents via the default slot. Closes on outside click, Escape or blur-out.
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

defineProps({
  align: { type: String, default: 'end' },
  label: { type: String, default: 'Open menu' },
})

const open = ref(false)
const root = ref(null)
const panel = ref(null)
/**
 * Flip above the trigger when there is not enough room below. Triggers near the
 * bottom of the window — the microphone and speaker controls — would otherwise
 * open off-screen, and get clipped by the stage card's `overflow: hidden`.
 */
const dropUp = ref(false)

async function toggle() {
  open.value = !open.value
  if (!open.value) return

  await nextTick()
  dropUp.value = false
  const trigger = root.value?.getBoundingClientRect()
  const height = panel.value?.offsetHeight ?? 0
  if (!trigger || !height) return

  const spaceBelow = window.innerHeight - trigger.bottom
  const spaceAbove = trigger.top
  // Only flip if above genuinely has more room, so short menus stay put.
  dropUp.value = spaceBelow < height + 16 && spaceAbove > spaceBelow
}

function close() {
  open.value = false
}

function onDocumentPointerDown(event) {
  if (open.value && root.value && !root.value.contains(event.target)) close()
}

function onKeydown(event) {
  if (event.key === 'Escape' && open.value) {
    close()
    root.value?.querySelector('button')?.focus()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
})

defineExpose({ close })
</script>

<template>
  <div ref="root" class="drop">
    <button
      type="button"
      class="drop__trigger"
      :aria-expanded="open"
      :aria-label="label"
      aria-haspopup="menu"
      @click="toggle"
    >
      <slot name="trigger" :open="open" />
    </button>

    <Transition name="drop">
      <div
        v-if="open"
        ref="panel"
        class="drop__panel"
        :class="[`drop__panel--${align}`, { 'drop__panel--up': dropUp }]"
        role="menu"
      >
        <slot :close="close" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.drop {
  position: relative;
}

.drop__trigger {
  display: flex;
  align-items: center;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}

.drop__panel {
  position: absolute;
  top: calc(100% + 6px);
  z-index: 40;
  min-width: 100%;
  padding: 6px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  /* A long device list scrolls inside the panel rather than off the screen. */
  max-height: min(320px, 60vh);
  overflow-y: auto;
}

.drop__panel--up {
  top: auto;
  bottom: calc(100% + 6px);
}

.drop__panel--end {
  right: 0;
}

.drop__panel--start {
  left: 0;
}

.drop-enter-active,
.drop-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.drop-enter-from,
.drop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* Grow from the trigger, so an upward menu rises rather than drops. */
.drop__panel--up.drop-enter-from,
.drop__panel--up.drop-leave-to {
  transform: translateY(4px);
}
</style>
