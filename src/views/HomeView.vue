<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppHeader from '@/components/AppHeader.vue'
import AppIcon from '@/components/AppIcon.vue'
import ActivityLog from '@/components/ActivityLog.vue'
import DeviceSelect from '@/components/DeviceSelect.vue'
import GroupSidebar from '@/components/GroupSidebar.vue'
import MicLevelMeter from '@/components/MicLevelMeter.vue'
import PttButton from '@/components/PttButton.vue'
import ReceivingBanner from '@/components/ReceivingBanner.vue'
import ReplayPanel from '@/components/ReplayPanel.vue'
import ToolsPanel from '@/components/ToolsPanel.vue'
import VolumeControl from '@/components/VolumeControl.vue'
import { getLocalStream } from '@/utils/webrtc'
import { createStereoRouter } from '@/utils/stereoRouting'
import {
  activePan,
  addLog,
  connect,
  connectionState,
  disconnect,
  inboundMuted,
  inputDevices,
  isConnected,
  logout,
  micDeviceId,
  micMuted,
  micTestActive,
  outputDevices,
  outputMuted,
  outputVolume,
  refreshDevices,
  remoteStream,
  setMicDevice,
  setSpeakerDevice,
  speakerDeviceId,
  startMicTest,
  stereoRouting,
  stopMicTest,
  toggleMicMute,
} from '@/stores/session'

const audio = ref(null)
/** `setSinkId` is Chromium-only; elsewhere output follows the OS default. */
const canRouteOutput =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/** Panes are tabbed on small screens and side-by-side on desktop. */
const pane = ref('talk')

/**
 * Web Audio graph that pans received audio, or null when routing is off or the
 * browser cannot do it. Playback always ends at the `<audio>` element either
 * way, so volume, mute and `setSinkId` behave identically.
 */
let router = null

watch([remoteStream, stereoRouting], attachStream)

// The store moves this per transmission; the graph follows.
watch(activePan, (value) => router?.setPan(value))

watch(speakerDeviceId, applySinkId)

// Volume and output mute apply to the element, so they work on any browser
// regardless of setSinkId support. `inboundMuted` rides along: silencing a
// group is the same mechanism, just driven by who is transmitting.
watch([outputVolume, outputMuted, inboundMuted], applyVolume, { immediate: true })

function applyVolume() {
  if (!audio.value) return
  audio.value.volume = outputVolume.value
  audio.value.muted = outputMuted.value || inboundMuted.value
}

/**
 * Point the element at the remote stream, threading it through the panner first
 * when stereo routing is on. Rebuilt from scratch on every change so there is
 * never a stale graph holding a dead stream.
 */
function attachStream() {
  router?.close()
  router = null

  const element = audio.value
  if (!element) return

  const stream = remoteStream.value
  if (!stream) {
    element.srcObject = null
    return
  }

  if (stereoRouting.value) {
    router = createStereoRouter(stream)
    if (router) router.setPan(activePan.value)
    else addLog('warn', 'Stereo routing is not supported here — using plain output')
  }

  element.srcObject = router?.stream ?? stream
  applySinkId()
  applyVolume()
  router?.resume()
  element.play().catch(() => {
    addLog('warn', 'Audio playback blocked — tap the page to enable sound')
  })
}

/** An AudioContext stays suspended until a gesture, so retry on any input. */
function resumeAudio() {
  router?.resume()
}

async function applySinkId() {
  if (!canRouteOutput || !audio.value || !speakerDeviceId.value) return
  try {
    await audio.value.setSinkId(speakerDeviceId.value)
  } catch (error) {
    addLog('warn', `Could not route audio output: ${error.message}`)
  }
}

/**
 * Device labels stay blank until the user has granted mic access once, so ask
 * for the stream before re-enumerating.
 */
async function requestDeviceAccess() {
  try {
    await getLocalStream(micDeviceId.value || undefined)
    await refreshDevices()
    addLog('success', 'Audio devices available')
  } catch (error) {
    addLog('error', `Microphone access denied: ${error.message}`)
  }
}

function toggleConnection() {
  if (isConnected.value || connectionState.value === 'connecting') disconnect()
  else connect()
}

function toggleMicTest() {
  if (micTestActive.value) stopMicTest()
  else startMicTest()
}

onMounted(() => {
  applyVolume()
  refreshDevices()
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
  window.addEventListener('pointerdown', resumeAudio)
  window.addEventListener('keydown', resumeAudio)
  addLog('info', 'Client ready')
})

onBeforeUnmount(() => {
  navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
  window.removeEventListener('pointerdown', resumeAudio)
  window.removeEventListener('keydown', resumeAudio)
  router?.close()
  router = null
  stopMicTest()
})
</script>

<template>
  <div class="app">
    <AppHeader @logout="logout" />

    <main class="app__body">
      <GroupSidebar class="app__pane" :class="{ 'app__pane--active': pane === 'groups' }" />

      <section class="stage app__pane" :class="{ 'app__pane--active': pane === 'talk' }">
        <h1 class="stage__title">Push to Talk</h1>

        <div class="stage__card card">
          <ReceivingBanner />
          <PttButton />

          <MicLevelMeter />

          <div class="devices">
            <DeviceSelect
              :icon="micMuted ? 'micOff' : 'mic'"
              title="Microphone"
              fallback-label="Default Mic"
              :devices="inputDevices"
              :model-value="micDeviceId"
              @update:model-value="setMicDevice"
              @request-access="requestDeviceAccess"
            >
              <template #controls>
                <button
                  type="button"
                  class="mic-mute"
                  :class="{ 'mic-mute--on': micMuted }"
                  :aria-pressed="micMuted"
                  :aria-label="micMuted ? 'Unmute microphone' : 'Mute microphone'"
                  :title="micMuted ? 'Unmute microphone' : 'Mute microphone'"
                  @click="toggleMicMute"
                >
                  <AppIcon :name="micMuted ? 'micOff' : 'mic'" :size="17" />
                </button>
              </template>

              <template #menu="{ close }">
                <button
                  type="button"
                  class="menu-action"
                  @click="
                    () => {
                      close()
                      toggleMicTest()
                    }
                  "
                >
                  <AppIcon name="activity" :size="15" />
                  <span>{{ micTestActive ? 'Stop microphone test' : 'Test microphone' }}</span>
                </button>
              </template>
            </DeviceSelect>

            <span class="devices__divider" />

            <DeviceSelect
              icon="speaker"
              title="Speaker"
              fallback-label="Default Output"
              :devices="outputDevices"
              :model-value="speakerDeviceId"
              :unsupported-note="
                canRouteOutput ? '' : 'This browser always uses the system output device.'
              "
              @update:model-value="setSpeakerDevice"
              @request-access="requestDeviceAccess"
            >
              <template #controls>
                <VolumeControl />
              </template>
            </DeviceSelect>
          </div>
        </div>
      </section>

      <aside class="rail app__pane" :class="{ 'app__pane--active': pane === 'tools' }">
        <ToolsPanel />
        <ReplayPanel />
        <ActivityLog />

        <div class="rail__actions">
          <button
            type="button"
            class="btn"
            :class="isConnected ? 'btn--danger' : 'btn--primary'"
            @click="toggleConnection"
          >
            <AppIcon name="logout" :size="16" />
            {{ isConnected || connectionState === 'connecting' ? 'Disconnect' : 'Connect' }}
          </button>
          <button type="button" class="btn btn--danger" @click="logout">
            <AppIcon name="logout" :size="16" />
            Logout
          </button>
        </div>
      </aside>
    </main>

    <nav class="tabs" aria-label="Sections">
      <button
        v-for="tab in [
          { id: 'groups', icon: 'users', label: 'Groups' },
          { id: 'talk', icon: 'mic', label: 'Talk' },
          { id: 'tools', icon: 'settings', label: 'Tools' },
        ]"
        :key="tab.id"
        type="button"
        class="tabs__btn"
        :class="{ 'tabs__btn--on': pane === tab.id }"
        :aria-current="pane === tab.id"
        @click="pane = tab.id"
      >
        <AppIcon :name="tab.icon" :size="19" />
        {{ tab.label }}
      </button>
    </nav>

    <audio ref="audio" autoplay playsinline />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.app__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.stage {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  padding: 18px 22px 22px;
  background: var(--surface);
}

.stage__title {
  margin-bottom: 14px;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.stage__card {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.devices {
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  border-top: 1px solid var(--border);
}

.devices__divider {
  width: 1px;
  background: var(--border);
}

.mic-mute {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
}

.mic-mute:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.mic-mute--on {
  background: var(--danger-100);
  color: var(--danger-500);
}

.menu-action {
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
  white-space: nowrap;
}

.menu-action:hover {
  background: var(--surface-hover);
}

.rail {
  display: flex;
  flex-direction: column;
  width: var(--tools-w);
  flex-shrink: 0;
  min-height: 0;
  padding: 18px 16px;
  background: var(--surface);
  border-left: 1px solid var(--border);
}

.rail__actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  flex-shrink: 0;
}

.tabs {
  display: none;
}

audio {
  display: none;
}

/* Tablet: narrow the right rail, keep servers + stage side by side. */
@media (max-width: 1100px) {
  :root {
    --tools-w: 280px;
  }
}

/* Mobile: one pane at a time, switched by the bottom tab bar. */
@media (max-width: 860px) {
  .app__pane {
    display: none;
    width: 100%;
    border: 0;
  }

  .app__pane--active {
    display: flex;
    flex: 1;
  }

  .tabs {
    display: flex;
    flex-shrink: 0;
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding-bottom: env(safe-area-inset-bottom);
  }

  .tabs__btn {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 9px 4px;
    background: none;
    border: 0;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .tabs__btn--on {
    color: var(--brand-600);
  }

  .stage {
    padding: 14px 14px 16px;
  }

  .devices {
    flex-direction: column;
  }

  .devices__divider {
    width: auto;
    height: 1px;
  }
}
</style>
