import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureManager } from './captureManager'

class FakeTrack {
  onended: (() => void) | null = null

  constructor(public kind: 'audio' | 'video') {}

  stop = vi.fn()

  addEventListener = vi.fn()

  removeEventListener = vi.fn()
}

class FakeMediaStream {
  constructor(private tracks: FakeTrack[] = []) {}

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio')
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'video')
  }

  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

class FakeAudioContext {
  createMediaStreamDestination() {
    return { stream: new FakeMediaStream([new FakeTrack('audio')]) }
  }

  createMediaStreamSource() {
    return { connect: vi.fn() }
  }

  close = vi.fn()
}

function installMediaMocks(options: {
  displayAudioTracks: number
  microphoneAvailable?: boolean
  audioContextAvailable?: boolean
}) {
  const displayStream = new FakeMediaStream([
    ...Array.from({ length: options.displayAudioTracks }, () => new FakeTrack('audio')),
    new FakeTrack('video'),
  ])
  const microphoneStream = new FakeMediaStream([new FakeTrack('audio')])

  vi.stubGlobal('MediaStream', FakeMediaStream)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: vi.fn().mockResolvedValue(displayStream),
      getUserMedia: options.microphoneAvailable === false
        ? vi.fn().mockRejectedValue(new Error('microphone unavailable'))
        : vi.fn().mockResolvedValue(microphoneStream),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
  vi.stubGlobal('AudioContext', options.audioContextAvailable === false ? undefined : FakeAudioContext)
  vi.stubGlobal('window', {
    AudioContext: options.audioContextAvailable === false ? undefined : FakeAudioContext,
  })
}

describe('CaptureManager source selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses system audio when microphone is disabled', async () => {
    installMediaMocks({ displayAudioTracks: 1 })
    const manager = new CaptureManager()
    const stream = await manager.acquireStream({ includeMicrophone: false })

    expect(stream.getAudioTracks()).toHaveLength(1)
    expect(manager.currentCaptureMode).toBe('system-audio')
  })

  it('mixes system and microphone audio when both are available', async () => {
    installMediaMocks({ displayAudioTracks: 1, microphoneAvailable: true })
    const manager = new CaptureManager()
    const stream = await manager.acquireStream({ includeMicrophone: true })

    expect(stream.getAudioTracks()).toHaveLength(1)
    expect(manager.currentCaptureMode).toBe('mixed')
  })

  it('falls back to microphone-only when display audio is missing', async () => {
    installMediaMocks({ displayAudioTracks: 0, microphoneAvailable: true })
    const manager = new CaptureManager()
    const stream = await manager.acquireStream({ includeMicrophone: true })

    expect(stream.getAudioTracks()).toHaveLength(1)
    expect(manager.currentCaptureMode).toBe('microphone')
  })

  it('fails when neither display audio nor microphone is available', async () => {
    installMediaMocks({ displayAudioTracks: 0, microphoneAvailable: false })
    const manager = new CaptureManager()

    await expect(manager.acquireStream({ includeMicrophone: true })).rejects.toThrow(/麦克风不可用/)
  })
})
