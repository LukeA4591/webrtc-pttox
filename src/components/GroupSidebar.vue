<script setup>
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import PanSelect from './PanSelect.vue'
import {
  addGroup,
  connectionLabel,
  connectionState,
  groupPan,
  groups,
  isConnected,
  receiving,
  removeGroup,
  selectGroup,
  selectedGroupKey,
  setGroupPan,
  stereoRouting,
  stripPrefix,
  toggleGroupMute,
} from '@/stores/session'

const newGroup = ref('')

/** Most recently heard first, with never-heard manual entries last. */
const ordered = computed(() =>
  [...groups.value].sort((a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0)),
)

/** The group currently transmitting to us, if any. */
const liveKey = computed(() =>
  receiving.value ? stripPrefix(receiving.value.groupId).trim().toLowerCase() : null,
)

function submit() {
  if (addGroup(newGroup.value)) newGroup.value = ''
}

function heardLabel(lastHeard) {
  if (!lastHeard) return 'Added manually'
  const seconds = Math.round((Date.now() - lastHeard) / 1000)
  if (seconds < 60) return 'Heard just now'
  if (seconds < 3600) return `Heard ${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `Heard ${Math.round(seconds / 3600)}h ago`
  return `Heard ${Math.round(seconds / 86400)}d ago`
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__scroll">
      <div class="section-head">
        <p class="panel-label">Groups</p>
        <span
          class="section-head__info"
          title="Groups are remembered as they are heard, and can be added by hand."
        >
          <AppIcon name="info" :size="15" />
        </span>
      </div>

      <ul v-if="ordered.length" class="groups">
        <li v-for="group in ordered" :key="group.key">
          <div
            class="group"
            :class="{
              'group--active': group.key === selectedGroupKey,
              'group--live': group.key === liveKey,
              'group--muted': group.muted,
            }"
          >
            <div class="group__row">
              <button
                type="button"
                class="group__main"
                :aria-pressed="group.key === selectedGroupKey"
                @click="selectGroup(group.key)"
              >
                <span class="group__dot" />
                <span class="group__body">
                  <span class="group__name">{{ group.label }}</span>
                  <span class="group__meta">{{ heardLabel(group.lastHeard) }}</span>
                </span>
              </button>
              <button
                type="button"
                class="group__mute"
                :class="{ 'group__mute--on': group.muted }"
                :aria-pressed="group.muted"
                :aria-label="`${group.muted ? 'Unmute' : 'Mute'} group ${group.label}`"
                :title="group.muted ? 'Unmute this group' : 'Mute this group'"
                @click="toggleGroupMute(group.key)"
              >
                <AppIcon :name="group.muted ? 'speakerOff' : 'speaker'" :size="14" />
              </button>
              <button
                type="button"
                class="group__remove"
                :aria-label="`Remove group ${group.label}`"
                @click="removeGroup(group.key)"
              >
                <AppIcon name="trash" :size="14" />
              </button>
            </div>

            <div v-if="stereoRouting" class="group__pan">
              <span class="group__panlabel">Ear</span>
              <PanSelect
                :model-value="groupPan(group)"
                :label="`Ear for ${group.label}`"
                @update:model-value="setGroupPan(group.key, $event)"
              />
            </div>
          </div>
        </li>
      </ul>

      <div v-else class="empty-state">
        <span class="empty-state__icon"><AppIcon name="users" :size="26" /></span>
        <p class="empty-state__title">No groups yet</p>
        <p class="empty-state__body">
          {{
            isConnected
              ? 'Groups appear here as they are heard.'
              : 'Connect, or add a group by hand below.'
          }}
        </p>
      </div>

      <form class="add" @submit.prevent="submit">
        <input
          v-model="newGroup"
          class="add__input"
          type="text"
          placeholder="Add group…"
          aria-label="Add group"
        />
        <button type="submit" class="add__btn" aria-label="Add group">
          <AppIcon name="plus" :size="15" />
        </button>
      </form>
    </div>

    <div class="status card">
      <span class="status__dot" :class="`status__dot--${connectionState}`" />
      <span class="status__text">
        <span class="status__label">Status</span>
        <span class="status__value">{{ connectionLabel }}</span>
      </span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w);
  flex-shrink: 0;
  padding: 18px 16px;
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.sidebar__scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.section-head__info {
  display: grid;
  place-items: center;
  color: var(--text-faint);
  cursor: help;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.group {
  display: flex;
  flex-direction: column;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}

.group:hover {
  background: var(--surface-hover);
}

.group--active {
  background: var(--brand-50);
  border-color: var(--brand-300);
}

.group--live {
  border-color: var(--ok-500);
}

.group__row {
  display: flex;
  align-items: stretch;
}

.group__pan {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px 8px 12px;
  border-top: 1px solid var(--border);
}

.group__panlabel {
  font-size: 11.5px;
  color: var(--text-muted);
}

.group__main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  background: none;
  border: 0;
  text-align: left;
  cursor: pointer;
}

.group__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
  flex-shrink: 0;
}

.group--active .group__dot {
  background: var(--brand-600);
}

.group--live .group__dot {
  background: var(--ok-500);
  animation: blip 0.8s ease-in-out infinite;
}

@keyframes blip {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.group__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.35;
}

.group__name {
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group__meta {
  font-size: 11.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A silenced group has to read as silenced without hovering it. */
.group__mute {
  display: grid;
  place-items: center;
  width: 30px;
  flex-shrink: 0;
  background: none;
  border: 0;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0.45;
  transition:
    opacity 0.15s,
    color 0.15s;
}

.group:hover .group__mute,
.group__mute:focus-visible {
  opacity: 1;
}

.group__mute--on {
  color: var(--danger-500);
  opacity: 1;
}

.group--muted .group__main {
  opacity: 0.55;
}

.group__remove {
  display: grid;
  place-items: center;
  width: 34px;
  flex-shrink: 0;
  background: none;
  border: 0;
  border-left: 1px solid transparent;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}

.group:hover .group__remove,
.group__remove:focus-visible {
  opacity: 1;
}

.group__remove:hover {
  background: var(--danger-100);
  color: var(--danger-500);
}

.add {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-shrink: 0;
}

.add__input {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.add__input:focus {
  outline: none;
  border-color: var(--brand-600);
}

.add__btn {
  display: grid;
  place-items: center;
  width: 34px;
  background: var(--surface-hover);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.add__btn:hover {
  border-color: var(--border-strong);
}

.status {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: 16px;
  padding: 12px 14px;
  flex-shrink: 0;
}

.status__dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--text-faint);
  flex-shrink: 0;
}

.status__dot--connected {
  background: var(--ok-500);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok-500) 22%, transparent);
}

.status__dot--connecting,
.status__dot--reconnecting {
  background: var(--warn-500);
  animation: blip 1.2s ease-in-out infinite;
}

.status__text {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

.status__label {
  font-size: 11.5px;
  color: var(--text-muted);
}

.status__value {
  font-size: 13.5px;
  font-weight: 600;
}
</style>
