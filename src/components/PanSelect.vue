<script setup>
import { PAN_LABELS, PAN_NAMES, PAN_POSITIONS } from '@/utils/stereoRouting'

defineProps({
  /** 'left' | 'center' | 'right' */
  modelValue: { type: String, required: true },
  /** Describes what is being routed, e.g. "Ear for PMR-1". */
  label: { type: String, required: true },
})

defineEmits(['update:modelValue'])
</script>

<template>
  <div class="pan" role="group" :aria-label="label">
    <button
      v-for="position in PAN_POSITIONS"
      :key="position"
      type="button"
      class="pan__btn"
      :class="{ 'pan__btn--on': position === modelValue }"
      :aria-pressed="position === modelValue"
      :aria-label="PAN_NAMES[position]"
      :title="PAN_NAMES[position]"
      @click="$emit('update:modelValue', position)"
    >
      {{ PAN_LABELS[position] }}
    </button>
  </div>
</template>

<style scoped>
.pan {
  display: flex;
  flex-shrink: 0;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.pan__btn {
  width: 26px;
  padding: 3px 0;
  background: none;
  border: 0;
  border-left: 1px solid var(--border);
  color: var(--text-muted);
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.5;
  cursor: pointer;
}

.pan__btn:first-child {
  border-left: 0;
}

.pan__btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.pan__btn--on {
  background: var(--brand-600);
  color: #fff;
}
</style>
