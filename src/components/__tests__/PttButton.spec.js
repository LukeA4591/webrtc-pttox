// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const handle = {
  requestFloor: vi.fn(() => true),
  releaseFloor: vi.fn(() => true),
  readStats: vi.fn(async () => null),
  close: vi.fn(),
}
let on = {}

vi.mock('@/utils/webrtc', () => ({
  createConnection: vi.fn((options) => {
    on = options.on
    return handle
  }),
  releaseLocalStream: vi.fn(),
  stripPrefix: (value) => (typeof value === 'string' ? value.split(':').at(-1) : ''),
}))

const store = await import('@/stores/session')
const PttButton = (await import('../PttButton.vue')).default

function goLive() {
  store.connect()
  on.status('connected')
  on.ready()
}

beforeEach(() => {
  vi.clearAllMocks()
  store.disconnect()
})

describe('PttButton', () => {
  test('is disabled while disconnected and explains why', () => {
    const wrapper = mount(PttButton)
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Disconnected')
  })

  test('becomes usable once the media session is negotiated', async () => {
    const wrapper = mount(PttButton)
    goLive()
    await wrapper.vm.$nextTick()

    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('Push to Talk')
    expect(wrapper.text()).toContain('Hold to speak')
  })

  test('holding the pointer requests then releases the floor', async () => {
    const wrapper = mount(PttButton)
    goLive()
    await wrapper.vm.$nextTick()

    const button = wrapper.get('button')
    // `button`/`pointerType` are read-only in jsdom; the defaults (button 0)
    // already represent a primary press.
    await button.trigger('pointerdown')
    expect(handle.requestFloor).toHaveBeenCalledOnce()

    on.floorGrant({})
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('You are live')

    await button.trigger('pointerup')
    expect(handle.releaseFloor).toHaveBeenCalledOnce()
  })

  test('the space bar acts as a hardware PTT key', async () => {
    const wrapper = mount(PttButton, { attachTo: document.body })
    goLive()
    await wrapper.vm.$nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    expect(handle.requestFloor).toHaveBeenCalledOnce()

    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }))
    expect(handle.releaseFloor).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  test('auto-repeat from a held space bar does not re-request', async () => {
    const wrapper = mount(PttButton, { attachTo: document.body })
    goLive()
    await wrapper.vm.$nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', repeat: true }))
    expect(handle.requestFloor).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  test('losing window focus mid-transmission closes the mic', async () => {
    const wrapper = mount(PttButton, { attachTo: document.body })
    goLive()
    await wrapper.vm.$nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    on.floorGrant({})

    window.dispatchEvent(new Event('blur'))
    expect(handle.releaseFloor).toHaveBeenCalledOnce()
    expect(store.floorState.value).toBe('idle')
    wrapper.unmount()
  })

  test('unmounting while live releases the floor', async () => {
    const wrapper = mount(PttButton, { attachTo: document.body })
    goLive()
    await wrapper.vm.$nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    on.floorGrant({})

    wrapper.unmount()
    expect(handle.releaseFloor).toHaveBeenCalledOnce()
  })
})
