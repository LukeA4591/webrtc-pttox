// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { extensionFor, pickMimeType, recordClip } from '../recorder'

/** Minimal MediaRecorder stand-in — jsdom has none. */
function installMediaRecorder({ supported = ['audio/webm;codecs=opus'], throwOnNew = false } = {}) {
  const instances = []

  class FakeMediaRecorder {
    constructor(stream, options) {
      if (throwOnNew) throw new Error('unsupported')
      this.stream = stream
      this.mimeType = options?.mimeType ?? ''
      this.state = 'inactive'
      this.listeners = {}
      instances.push(this)
    }

    addEventListener(type, handler) {
      this.listeners[type] = handler
    }

    start() {
      this.state = 'recording'
    }

    stop() {
      this.state = 'inactive'
      this.listeners.stop?.()
    }

    /** Feed the recorder a chunk, as a real one would while recording. */
    emit(size) {
      this.listeners.dataavailable?.({ data: new Blob(['x'.repeat(size)]) })
    }
  }

  FakeMediaRecorder.isTypeSupported = (type) => supported.includes(type)
  globalThis.MediaRecorder = FakeMediaRecorder
  return instances
}

afterEach(() => {
  delete globalThis.MediaRecorder
  vi.useRealTimers()
})

describe('pickMimeType', () => {
  test('picks the first container the browser supports', () => {
    installMediaRecorder({ supported: ['audio/mp4'] })
    expect(pickMimeType()).toBe('audio/mp4')
  })

  test('falls back to letting the browser choose', () => {
    installMediaRecorder({ supported: [] })
    expect(pickMimeType()).toBe('')
  })

  test('returns empty without MediaRecorder rather than throwing', () => {
    expect(pickMimeType()).toBe('')
  })
})

describe('extensionFor', () => {
  test('matches the container so saved clips open', () => {
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm')
    expect(extensionFor('audio/mp4')).toBe('m4a')
    expect(extensionFor('audio/ogg;codecs=opus')).toBe('ogg')
    expect(extensionFor(undefined)).toBe('webm')
  })
})

describe('recordClip', () => {
  test('returns null when the browser cannot record, so callers can degrade', () => {
    expect(recordClip({}, vi.fn())).toBeNull()

    installMediaRecorder({ throwOnNew: true })
    expect(recordClip({}, vi.fn())).toBeNull()
  })

  test('hands back one clip per transmission', () => {
    const instances = installMediaRecorder()
    const onClip = vi.fn()

    const handle = recordClip({}, onClip)
    instances[0].emit(64)
    handle.stop()

    expect(onClip).toHaveBeenCalledTimes(1)
    expect(onClip.mock.calls[0][0].blob.size).toBeGreaterThan(0)
  })

  test('a transmission that captured nothing produces no clip', () => {
    installMediaRecorder()
    const onClip = vi.fn()

    recordClip({}, onClip).stop()
    expect(onClip).not.toHaveBeenCalled()
  })

  test('the tail keeps recording past the end of the transmission', () => {
    vi.useFakeTimers()
    const instances = installMediaRecorder()
    const onClip = vi.fn()

    const handle = recordClip({}, onClip)
    handle.stop(400)
    // The last syllable arrives after end-call.
    instances[0].emit(32)
    expect(onClip).not.toHaveBeenCalled()

    vi.advanceTimersByTime(400)
    expect(onClip).toHaveBeenCalledTimes(1)
  })

  test('stopping twice does not cut the tail short', () => {
    vi.useFakeTimers()
    const instances = installMediaRecorder()
    const onClip = vi.fn()

    const handle = recordClip({}, onClip)
    handle.stop(400)
    handle.stop(0)
    instances[0].emit(32)

    expect(onClip).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(onClip).toHaveBeenCalledTimes(1)
  })

  test('overlapping transmissions each get their own recorder', () => {
    const instances = installMediaRecorder()
    const first = vi.fn()
    const second = vi.fn()

    const a = recordClip({}, first)
    const b = recordClip({}, second)
    expect(instances).toHaveLength(2)

    instances[0].emit(16)
    instances[1].emit(16)
    b.stop()
    a.stop()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
