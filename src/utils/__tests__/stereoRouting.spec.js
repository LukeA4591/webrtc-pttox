// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { PAN_BIAS, createStereoRouter, panValue } from '../stereoRouting'

// jsdom has no media playback; the Safari keep-alive element only needs to exist.
beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn(async () => {})
  HTMLMediaElement.prototype.pause = vi.fn()
})

/** Minimal Web Audio stand-in — jsdom has none. */
function fakeAudioContext() {
  const panner = {
    pan: { value: 0, setTargetAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
  const context = {
    state: 'suspended',
    currentTime: 0,
    panner,
    resume: vi.fn(async () => {
      context.state = 'running'
    }),
    close: vi.fn(),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createStereoPanner: vi.fn(() => panner),
    createMediaStreamDestination: vi.fn(() => ({ stream: { id: 'panned' } })),
  }
  return context
}

afterEach(() => {
  delete globalThis.AudioContext
  delete globalThis.webkitAudioContext
})

describe('panValue', () => {
  test('maps positions onto the panner scale', () => {
    expect(panValue('left')).toBe(-PAN_BIAS)
    expect(panValue('right')).toBe(PAN_BIAS)
    expect(panValue('center')).toBe(0)
  })

  test('anything unrecognised centres rather than throwing', () => {
    expect(panValue(undefined)).toBe(0)
    expect(panValue('sideways')).toBe(0)
  })

  test('never pans fully, so the far ear still carries traffic', () => {
    expect(PAN_BIAS).toBeLessThan(1)
  })
})

describe('createStereoRouter', () => {
  test('returns null without Web Audio, so callers can fall back', () => {
    expect(createStereoRouter({})).toBeNull()
  })

  test('returns null when the browser has no stereo panner', () => {
    const context = fakeAudioContext()
    context.createStereoPanner = undefined
    globalThis.AudioContext = vi.fn(() => context)

    expect(createStereoRouter({})).toBeNull()
    expect(context.close).toHaveBeenCalled()
  })

  test('hands back a panned stream and ramps rather than jumping', () => {
    const context = fakeAudioContext()
    globalThis.AudioContext = vi.fn(() => context)

    const router = createStereoRouter({})
    expect(router.stream).toEqual({ id: 'panned' })

    router.setPan(-PAN_BIAS)
    expect(context.panner.pan.setTargetAtTime).toHaveBeenCalledWith(
      -PAN_BIAS,
      0,
      expect.any(Number),
    )
  })

  test('clamps out-of-range values', () => {
    const context = fakeAudioContext()
    globalThis.AudioContext = vi.fn(() => context)

    createStereoRouter({}).setPan(4)
    expect(context.panner.pan.setTargetAtTime).toHaveBeenCalledWith(1, 0, expect.any(Number))
  })

  test('resume() lifts an autoplay-suspended context', async () => {
    const context = fakeAudioContext()
    globalThis.AudioContext = vi.fn(() => context)

    await createStereoRouter({}).resume()
    expect(context.resume).toHaveBeenCalled()
  })

  test('close() releases the context', () => {
    const context = fakeAudioContext()
    globalThis.AudioContext = vi.fn(() => context)

    createStereoRouter({}).close()
    expect(context.close).toHaveBeenCalled()
  })
})
