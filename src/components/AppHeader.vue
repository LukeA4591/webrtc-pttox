<script setup>
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import AppLogo from './AppLogo.vue'
import DropMenu from './DropMenu.vue'
import {
  connectionState,
  displayName,
  floorState,
  isConnected,
  removeServer,
  selectedServer,
  servers,
  setDisplayName,
  setServer,
} from '@/stores/session'

const emit = defineEmits(['logout'])

const newServer = ref('')
const editingName = ref(false)
const nameDraft = ref('')

const initial = computed(() => displayName.value.trim().charAt(0).toUpperCase() || '?')

function chooseServer(domain, close) {
  setServer(domain)
  close()
}

function addServer(close) {
  const domain = newServer.value
    .trim()
    .replace(/^wss?:\/\//, '')
    .replace(/\/+$/, '')
  if (!domain) return
  setServer(domain)
  newServer.value = ''
  close()
}

function startEditingName() {
  nameDraft.value = displayName.value
  editingName.value = true
}

function commitName() {
  setDisplayName(nameDraft.value)
  editingName.value = false
}
</script>

<template>
  <header class="header">
    <AppLogo :live="floorState === 'granted'" />

    <div class="header__right">
      <DropMenu label="Select server" class="header__servers">
        <template #trigger="{ open }">
          <span class="pill" :class="{ 'pill--open': open }">
            <AppIcon name="database" :size="16" class="pill__lead" />
            <span class="pill__text">Server: {{ selectedServer || 'None' }}</span>
            <span class="pill__dot" :class="`pill__dot--${connectionState}`" />
            <AppIcon name="chevronDown" :size="16" class="pill__caret" />
          </span>
        </template>

        <template #default="{ close }">
          <p class="menu__label">Available servers</p>
          <div v-for="domain in servers" :key="domain" class="menu__row">
            <button
              type="button"
              class="menu__item"
              role="menuitem"
              @click="chooseServer(domain, close)"
            >
              <AppIcon name="database" :size="15" />
              <span class="menu__item-text">{{ domain }}</span>
              <AppIcon
                v-if="domain === selectedServer"
                name="check"
                :size="15"
                class="menu__check"
              />
            </button>
            <button
              type="button"
              class="menu__remove"
              :disabled="servers.length <= 1"
              :title="servers.length <= 1 ? 'Keep at least one server' : `Remove ${domain}`"
              :aria-label="`Remove server ${domain}`"
              @click.stop="removeServer(domain)"
            >
              <AppIcon name="trash" :size="14" />
            </button>
          </div>

          <div class="menu__divider" />
          <form class="menu__add" @submit.prevent="addServer(close)">
            <input
              v-model="newServer"
              class="menu__input"
              type="text"
              placeholder="Add server host…"
              aria-label="Add server host"
            />
            <button type="submit" class="menu__add-btn" aria-label="Add server">
              <AppIcon name="plus" :size="15" />
            </button>
          </form>
          <p v-if="isConnected" class="menu__hint">Reconnect to switch server.</p>
        </template>
      </DropMenu>

      <DropMenu label="Account menu">
        <template #trigger>
          <span class="user">
            <span class="user__avatar">{{ initial }}</span>
            <span class="user__name">{{ displayName }}</span>
            <AppIcon name="chevronDown" :size="16" class="pill__caret" />
          </span>
        </template>

        <template #default="{ close }">
          <p class="menu__label">Signed in as</p>
          <form v-if="editingName" class="menu__add" @submit.prevent="commitName">
            <input
              v-model="nameDraft"
              class="menu__input"
              type="text"
              aria-label="Display name"
              autofocus
            />
            <button type="submit" class="menu__add-btn" aria-label="Save name">
              <AppIcon name="check" :size="15" />
            </button>
          </form>
          <button v-else type="button" class="menu__item" role="menuitem" @click="startEditingName">
            <AppIcon name="users" :size="15" />
            <span class="menu__item-text">{{ displayName }}</span>
          </button>

          <div class="menu__divider" />
          <button
            type="button"
            class="menu__item menu__item--danger"
            role="menuitem"
            @click="
              () => {
                close()
                emit('logout')
              }
            "
          >
            <AppIcon name="logout" :size="15" />
            <span class="menu__item-text">Log out</span>
          </button>
        </template>
      </DropMenu>
    </div>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: var(--header-h);
  padding: 0 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.header__right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pill,
.user {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  font-size: 13px;
  font-weight: 500;
  transition: border-color 0.15s;
}

.pill:hover,
.user:hover,
.pill--open {
  border-color: var(--border-strong);
}

.pill__lead,
.pill__caret {
  color: var(--text-muted);
  flex-shrink: 0;
}

.pill__text {
  max-width: 26ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pill__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
  flex-shrink: 0;
}

.pill__dot--connected {
  background: var(--ok-500);
}

.pill__dot--connecting,
.pill__dot--reconnecting {
  background: var(--warn-500);
}

.user__avatar {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--brand-100);
  color: var(--brand-700);
  font-size: 12px;
  font-weight: 600;
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

.menu__row {
  display: flex;
  align-items: stretch;
  border-radius: var(--radius-sm);
}

.menu__row:hover {
  background: var(--surface-hover);
}

.menu__row .menu__item {
  flex: 1;
  min-width: 0;
}

.menu__remove {
  display: grid;
  place-items: center;
  width: 30px;
  flex-shrink: 0;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}

.menu__row:hover .menu__remove,
.menu__remove:focus-visible {
  opacity: 1;
}

.menu__remove:hover:not(:disabled) {
  background: var(--danger-100);
  color: var(--danger-500);
}

.menu__remove:disabled {
  cursor: not-allowed;
  opacity: 0;
}

.menu__item-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu__item--danger:hover {
  color: var(--danger-500);
}

.menu__check {
  color: var(--brand-600);
}

.menu__divider {
  height: 1px;
  margin: 6px 0;
  background: var(--border);
}

.menu__add {
  display: flex;
  gap: 6px;
  padding: 2px 4px 4px;
}

.menu__input {
  flex: 1;
  min-width: 0;
  padding: 7px 9px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.menu__input:focus {
  outline: none;
  border-color: var(--brand-600);
}

.menu__add-btn {
  display: grid;
  place-items: center;
  width: 32px;
  background: var(--surface-hover);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.menu__add-btn:hover {
  border-color: var(--border-strong);
}

.menu__hint {
  padding: 2px 10px 4px;
  font-size: 11.5px;
  color: var(--text-muted);
}

@media (max-width: 720px) {
  .pill__text {
    max-width: 12ch;
  }

  .user__name {
    display: none;
  }
}
</style>
