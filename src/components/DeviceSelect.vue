<script setup>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import DropMenu from './DropMenu.vue'

const props = defineProps({
  icon: { type: String, required: true },
  title: { type: String, required: true },
  devices: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
  fallbackLabel: { type: String, default: 'System default' },
  /** Set when the browser cannot honour a selection (e.g. Firefox output routing). */
  unsupportedNote: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'request-access'])

const current = computed(() => {
  const match = props.devices.find((device) => device.deviceId === props.modelValue)
  return match?.label || props.devices[0]?.label || props.fallbackLabel
})

/** Labels are empty strings until mic permission has been granted once. */
const needsPermission = computed(
  () => props.devices.length === 0 || props.devices.every((device) => !device.label),
)

function labelFor(device, index) {
  return device.label || `${props.title} ${index + 1}`
}

function choose(deviceId, close) {
  emit('update:modelValue', deviceId)
  close()
}
</script>

<template>
  <div class="device">
    <AppIcon :name="icon" :size="19" class="device__icon" />
    <span class="device__text">
      <span class="device__title">{{ title }}</span>
      <span class="device__value">{{ needsPermission ? fallbackLabel : current }}</span>
    </span>

    <slot name="controls" />

    <DropMenu align="end" :label="`Choose ${title.toLowerCase()}`">
      <template #trigger>
        <span class="device__gear"><AppIcon name="settings" :size="17" /></span>
      </template>

      <template #default="{ close }">
        <p class="menu__label">{{ title }}</p>

        <button
          v-if="needsPermission"
          type="button"
          class="menu__item"
          @click="
            () => {
              emit('request-access')
              close()
            }
          "
        >
          <AppIcon name="mic" :size="15" />
          <span class="menu__item-text">Allow audio access to list devices</span>
        </button>

        <button
          v-for="(device, index) in devices"
          v-else
          :key="device.deviceId"
          type="button"
          class="menu__item"
          role="menuitem"
          @click="choose(device.deviceId, close)"
        >
          <span class="menu__item-text">{{ labelFor(device, index) }}</span>
          <AppIcon
            v-if="device.deviceId === modelValue"
            name="check"
            :size="15"
            class="menu__check"
          />
        </button>

        <p v-if="unsupportedNote" class="menu__hint">{{ unsupportedNote }}</p>

        <template v-if="$slots.menu">
          <div class="menu__divider" />
          <slot name="menu" :close="close" />
        </template>
      </template>
    </DropMenu>
  </div>
</template>

<style scoped>
.device {
  display: flex;
  align-items: center;
  gap: 11px;
  flex: 1;
  min-width: 0;
  padding: 14px 16px;
}

.device__icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.device__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  line-height: 1.35;
}

.device__title {
  font-size: 13px;
  font-weight: 600;
}

.device__value {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device__gear {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition: background-color 0.15s;
}

.device__gear:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.menu__label {
  padding: 6px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.menu__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  max-width: 320px;
  padding: 8px 10px;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.menu__item:hover {
  background: var(--surface-hover);
}

.menu__item-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu__check {
  color: var(--brand-600);
}

.menu__hint {
  max-width: 280px;
  padding: 4px 10px 6px;
  font-size: 11.5px;
  color: var(--text-muted);
}

.menu__divider {
  height: 1px;
  margin: 6px 0;
  background: var(--border);
}
</style>
