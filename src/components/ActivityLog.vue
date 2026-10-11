<script setup>
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { clearLog, log } from '@/stores/session'

/** Show only today's entries, matching the calendar affordance in the header. */
const todayOnly = ref(false)

const entries = computed(() => {
  if (!todayOnly.value) return log.value
  const today = new Date().toDateString()
  return log.value.filter((entry) => entry.at.toDateString() === today)
})

function timeOf(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
</script>

<template>
  <section class="log">
    <div class="log__head">
      <p class="panel-label">Log</p>
      <button
        type="button"
        class="log__filter"
        :class="{ 'log__filter--on': todayOnly }"
        :aria-pressed="todayOnly"
        title="Show today only"
        @click="todayOnly = !todayOnly"
      >
        <AppIcon name="calendar" :size="16" />
      </button>
    </div>

    <div class="log__body card">
      <ul v-if="entries.length" class="log__list">
        <li v-for="entry in entries" :key="entry.id" class="log__row">
          <span class="log__dot" :class="`log__dot--${entry.level}`" />
          <time class="log__time" :datetime="entry.at.toISOString()">{{ timeOf(entry.at) }}</time>
          <span class="log__msg">{{ entry.message }}</span>
        </li>
      </ul>

      <div v-else class="empty-state">
        <span class="empty-state__icon"><AppIcon name="file" :size="24" /></span>
        <p class="empty-state__body">
          {{ todayOnly && log.length ? 'Nothing logged today' : 'No recent activity' }}
        </p>
      </div>

      <button type="button" class="btn log__clear" :disabled="!log.length" @click="clearLog">
        <AppIcon name="trash" :size="15" />
        Clear log
      </button>
    </div>
  </section>
</template>

<style scoped>
.log {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  margin-top: 18px;
}

.log__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.log__filter {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
}

.log__filter:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.log__filter--on {
  background: var(--brand-50);
  color: var(--brand-600);
}

.log__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 160px;
  padding: 10px;
}

.log__list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 10px;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  /* Anchor to the top; newest entries are unshifted to the front. */
  align-content: flex-start;
}

.log__row {
  display: grid;
  grid-template-columns: 8px auto 1fr;
  align-items: baseline;
  gap: 8px;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.log__row:hover {
  background: var(--surface-hover);
}

.log__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  transform: translateY(-1px);
}

.log__dot--success {
  background: var(--ok-500);
}

.log__dot--warn {
  background: var(--warn-500);
}

.log__dot--error {
  background: var(--danger-500);
}

.log__time {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.log__msg {
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.log__clear {
  margin-top: auto;
  flex-shrink: 0;
}
</style>
