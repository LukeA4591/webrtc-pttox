<script setup>
/**
 * Scrollback of received transmissions. Each entry is a complete recording of
 * one call, replayable without touching the live session.
 */
import { onBeforeUnmount, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { clearClips, clips, replayEnabled, toggleReplay } from '@/stores/session'

const player = ref(null)
const playingId = ref(null)

/**
 * Which clip we are trying to start. Playing state is driven by the element's
 * own events rather than set optimistically: switching straight from one clip
 * to another re-runs the media load algorithm, which fires `pause` a tick later
 * and would otherwise clear the id of the clip that just started.
 */
let pendingId = null

function togglePlay(clip) {
  const element = player.value
  if (!element) return

  if (playingId.value === clip.id) {
    element.pause()
    return
  }

  pendingId = clip.id
  element.src = clip.url
  element.play().catch(() => {
    pendingId = null
    playingId.value = null
  })
}

function onPlaying() {
  playingId.value = pendingId
}

function onStopped() {
  playingId.value = null
}

/** Replay is local-only, so a plain download link is the whole export story. */
function fileName(clip) {
  const stamp = clip.at.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const group = clip.groupLabel.replace(/[^\w-]+/g, '_')
  return `${group}-${stamp}.${clip.extension}`
}

function timeOf(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function durationOf(ms) {
  const seconds = ms / 1000
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
}

onBeforeUnmount(() => player.value?.pause())
</script>

<template>
  <section class="replay">
    <div class="replay__head">
      <p class="panel-label">Replay</p>
      <button
        type="button"
        class="replay__toggle"
        :class="{ 'replay__toggle--on': replayEnabled }"
        role="switch"
        :aria-checked="replayEnabled"
        :title="replayEnabled ? 'Stop recording transmissions' : 'Record transmissions'"
        aria-label="Record transmissions"
        @click="toggleReplay"
      >
        <span class="replay__dot" />
        {{ replayEnabled ? 'Recording' : 'Off' }}
      </button>
    </div>

    <div class="replay__body card">
      <ul v-if="clips.length" class="replay__list">
        <li v-for="clip in clips" :key="clip.id" class="clip">
          <button
            type="button"
            class="clip__play"
            :class="{ 'clip__play--on': playingId === clip.id }"
            :aria-label="`${playingId === clip.id ? 'Stop' : 'Replay'} ${clip.alias} on ${clip.groupLabel}`"
            @click="togglePlay(clip)"
          >
            <AppIcon :name="playingId === clip.id ? 'pause' : 'play'" :size="13" />
          </button>

          <span class="clip__text">
            <span class="clip__who">{{ clip.alias }}</span>
            <span class="clip__meta">
              {{ clip.groupLabel }} · {{ timeOf(clip.at) }} · {{ durationOf(clip.durationMs) }}
            </span>
          </span>

          <a
            class="clip__save"
            :href="clip.url"
            :download="fileName(clip)"
            :aria-label="`Save recording of ${clip.alias}`"
            title="Save recording"
          >
            <AppIcon name="download" :size="14" />
          </a>
        </li>
      </ul>

      <div v-else class="empty-state">
        <span class="empty-state__icon"><AppIcon name="radio" :size="24" /></span>
        <p class="empty-state__body">
          {{
            replayEnabled
              ? 'Transmissions will appear here as they are heard.'
              : 'Turn on recording to keep transmissions for replay.'
          }}
        </p>
      </div>

      <button type="button" class="btn replay__clear" :disabled="!clips.length" @click="clearClips">
        <AppIcon name="trash" :size="15" />
        Clear recordings
      </button>
    </div>

    <audio ref="player" @playing="onPlaying" @ended="onStopped" @pause="onStopped" />
  </section>
</template>

<style scoped>
.replay {
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-top: 18px;
}

.replay__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.replay__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}

.replay__toggle:hover {
  border-color: var(--border-strong);
}

.replay__toggle--on {
  background: var(--danger-100);
  border-color: var(--danger-500);
  color: var(--danger-500);
}

.replay__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}

.replay__toggle--on .replay__dot {
  background: var(--danger-500);
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.replay__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px;
}

.replay__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  max-height: 190px;
  overflow-y: auto;
  list-style: none;
}

.clip {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
}

.clip:hover {
  background: var(--surface-hover);
}

.clip__play {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: 50%;
  color: var(--text-muted);
  cursor: pointer;
}

.clip__play:hover {
  border-color: var(--brand-600);
  color: var(--brand-600);
}

.clip__play--on {
  background: var(--brand-600);
  border-color: var(--brand-600);
  color: #fff;
}

.clip__text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  line-height: 1.35;
}

.clip__who {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clip__meta {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clip__save {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  color: var(--text-faint);
  opacity: 0;
  transition: opacity 0.15s;
}

.clip:hover .clip__save,
.clip__save:focus-visible {
  opacity: 1;
}

.clip__save:hover {
  background: var(--surface-sunken);
  color: var(--text);
}

.replay__clear {
  margin-top: 8px;
  flex-shrink: 0;
}

audio {
  display: none;
}
</style>
