import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureManager } from './captureManager'
import { AudioProcessor } from '../utils/audioProcessor'

class FakeTrack {
  onended: (() => void) | null = null
  readyState: 'live' | 'ended' = 'live'
  private listeners = new Set<() => void>()

  constructor(public kind: 'audio' | 'video') {}

  stop = vi.fn(() => {
    this.readyState = 'ended'
  })

  addEventListener = vi.fn((event: string, listener: () => void) => {
    if (event === 'ended') {
      this.listeners.add(listener)
    }
  })

  removeEventListener = vi.fn((event: string, listener: () => void) => {
    if (event === 'ended') {
      this.listeners.delete(listener)
    }
  })

  end(): void {
    this.readyState = 'ended'
    this.onended?.()
    for (const listener of this.listeners) {
      listener()
    }
  }
}

class FakeAudioNode {
  connect = vi.fn()
  disconnect = vi.fn()
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

class FakeScriptProcessorNode extends FakeAudioNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null

  emit(samples = new Float32Array([0, 0.5, -0.5])): void {
    this.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples,
      },
    } as unknown as AudioProcessingEvent)
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static addModuleImplementation: () => Promise<void> = async () => {}

  sampleRate: number
  state: 'running' | 'suspended' | 'closed' = 'running'
  destination = {}
  audioWorklet = {
    addModule: vi.fn(() => FakeAudioContext.addModuleImplementation()),
  }
  scriptProcessor: FakeScriptProcessorNode | null = null
  destinationStream: FakeMediaStream | null = null
  destinationNode: (FakeAudioNode & { stream: FakeMediaStream }) | null = null
  sourceNodes: FakeAudioNode[] = []

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48_000
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamDestination() {
    this.destinationStream = new FakeMediaStream([new FakeTrack('audio')])
    this.destinationNode = Object.assign(new FakeAudioNode(), { stream: this.destinationStream })
    return this.destinationNode
  }

  createMediaStreamSource() {
    const node = new FakeAudioNode()
    this.sourceNodes.push(node)
    return node
  }

  createScriptProcessor() {
    this.scriptProcessor = new FakeScriptProcessorNode()
    return this.scriptProcessor
  }

  createGain() {
    return {
      ...new FakeAudioNode(),
      gain: { value: 1 },
    }
  }

  suspend = vi.fn(async () => {
    this.state = 'suspended'
  })

  resume = vi.fn(async () => {
    this.state = 'running'
  })

  close = vi.fn(async () => {
    this.state = 'closed'
  })
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = vi.fn(() => true)

  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private stopListeners = new Set<() => void>()

  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
    FakeMediaRecorder.instances.push(this)
  }

  start = vi.fn(() => {
    this.state = 'recording'
  })

  stop = vi.fn(() => {
    this.state = 'inactive'
  })

  addEventListener = vi.fn((event: string, listener: () => void) => {
    if (event === 'stop') {
      this.stopListeners.add(listener)
    }
  })

  removeEventListener = vi.fn((event: string, listener: () => void) => {
    if (event === 'stop') {
      this.stopListeners.delete(listener)
    }
  })

  emitData(data: Blob): void {
    this.ondataavailable?.({ data })
  }

  emitStop(): void {
    for (const listener of this.stopListeners) {
      listener()
    }
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  static instances: FakeAudioWorkletNode[] = []
  port: { onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null } = { onmessage: null }

  constructor(_context: AudioContext, _name: string, _options?: AudioWorkletNodeOptions) {
    super()
    FakeAudioWorkletNode.instances.push(this)
  }
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
  const deviceChangeListeners = new Set<() => void>()
  const mediaDevices = {
    getDisplayMedia: vi.fn().mockResolvedValue(displayStream),
    getUserMedia: options.microphoneAvailable === false
      ? vi.fn().mockRejectedValue(new Error('microphone unavailable'))
      : vi.fn().mockResolvedValue(microphoneStream),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'devicechange') {
        deviceChangeListeners.add(listener)
      }
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'devicechange') {
        deviceChangeListeners.delete(listener)
      }
    }),
    emitDeviceChange: () => {
      for (const listener of deviceChangeListeners) {
        listener()
      }
    },
  }

  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: mediaDevices.getDisplayMedia,
      getUserMedia: mediaDevices.getUserMedia,
      addEventListener: mediaDevices.addEventListener,
      removeEventListener: mediaDevices.removeEventListener,
    },
  })
  vi.stubGlobal('AudioContext', options.audioContextAvailable === false ? undefined : FakeAudioContext)
  vi.stubGlobal('window', {
    AudioContext: options.audioContextAvailable === false ? undefined : FakeAudioContext,
    location: { href: 'https://example.test/' },
  })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

  return { displayStream, microphoneStream, mediaDevices }
}

function resetMediaMocks(): void {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  FakeAudioContext.instances = []
  FakeAudioContext.addModuleImplementation = async () => {}
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.isTypeSupported.mockClear()
  FakeAudioWorkletNode.instances = []
}

describe('CaptureManager source selection', () => {
  beforeEach(() => {
    resetMediaMocks()
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

describe('CaptureManager pause and resume', () => {
  beforeEach(() => {
    resetMediaMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drains the WebM tail before pause resolves and drops late data after pause', async () => {
    installMediaMocks({ displayAudioTracks: 1 })
    const manager = new CaptureManager()
    const received: Blob[] = []
    const capabilities = { audioInputMode: 'media-recorder' } as const

    await manager.acquireStream({ includeMicrophone: false })
    await manager.startWithStream(capabilities, {
      onAudioData: (data) => received.push(data as Blob),
      onTrackEnded: vi.fn(),
      onDeviceChange: vi.fn(),
    })

    const firstRecorder = FakeMediaRecorder.instances[0]
    const initialChunk = new Blob(['initial'])
    const tailChunk = new Blob(['tail'])
    firstRecorder.emitData(initialChunk)

    let pauseResolved = false
    const pause = manager.pauseCapture().then(() => {
      pauseResolved = true
    })

    expect(firstRecorder.stop).toHaveBeenCalledOnce()
    expect(manager.currentStream).not.toBeNull()
    await Promise.resolve()
    expect(pauseResolved).toBe(false)

    firstRecorder.emitData(tailChunk)
    expect(received).toEqual([initialChunk, tailChunk])

    firstRecorder.emitStop()
    await pause
    expect(pauseResolved).toBe(true)

    firstRecorder.emitData(new Blob(['late']))
    expect(received).toEqual([initialChunk, tailChunk])

    await manager.resumeCapture(capabilities)
    const secondRecorder = FakeMediaRecorder.instances[1]
    expect(secondRecorder).not.toBe(firstRecorder)
    secondRecorder.emitData(new Blob(['resumed']))
    expect(received).toHaveLength(3)
  })

  it('bounds a WebM pause when the recorder never emits stop', async () => {
    vi.useFakeTimers()
    installMediaMocks({ displayAudioTracks: 1 })
    const manager = new CaptureManager()
    const received: Blob[] = []
    const capabilities = { audioInputMode: 'media-recorder' } as const

    await manager.acquireStream({ includeMicrophone: false })
    await manager.startWithStream(capabilities, {
      onAudioData: (data) => received.push(data as Blob),
      onTrackEnded: vi.fn(),
      onDeviceChange: vi.fn(),
    })

    const recorder = FakeMediaRecorder.instances[0]
    const pause = manager.pauseCapture()
    await vi.advanceTimersByTimeAsync(2_000)
    await pause

    recorder.emitData(new Blob(['late']))
    expect(received).toHaveLength(0)
  })

  it('recreates the PCM processor on resume and when restarting a PCM pipeline', async () => {
    installMediaMocks({ displayAudioTracks: 1 })
    const manager = new CaptureManager()
    const received: ArrayBuffer[] = []
    const capabilities = { audioInputMode: 'pcm16' } as const

    await manager.acquireStream({ includeMicrophone: false })
    await manager.startWithStream(capabilities, {
      onAudioData: (data) => received.push(data as ArrayBuffer),
      onTrackEnded: vi.fn(),
      onDeviceChange: vi.fn(),
    })

    const firstContext = FakeAudioContext.instances[0]
    firstContext.scriptProcessor!.emit()
    expect(received).toHaveLength(1)

    await manager.pauseCapture()
    firstContext.scriptProcessor!.emit()
    expect(received).toHaveLength(1)

    await manager.resumeCapture(capabilities)
    const resumedContext = FakeAudioContext.instances[1]
    expect(resumedContext).not.toBe(firstContext)
    resumedContext.scriptProcessor!.emit()
    expect(received).toHaveLength(2)

    manager.pauseRecorder()
    manager.restartRecorder(capabilities)
    await Promise.resolve()
    expect(FakeAudioContext.instances).toHaveLength(3)
    expect(FakeAudioContext.instances[2].scriptProcessor).not.toBeNull()
  })

  it('keeps the mixed graph running across pause and resume without re-requesting the microphone', async () => {
    const { mediaDevices } = installMediaMocks({ displayAudioTracks: 1, microphoneAvailable: true })
    const manager = new CaptureManager()
    const capabilities = { audioInputMode: 'media-recorder' } as const

    await manager.acquireStream({ includeMicrophone: true })
    await manager.startWithStream(capabilities, {
      onAudioData: vi.fn(),
      onTrackEnded: vi.fn(),
      onDeviceChange: vi.fn(),
    })

    const mixedContext = FakeAudioContext.instances[0]
    const recorder = FakeMediaRecorder.instances[0]
    const pause = manager.pauseCapture()
    recorder.emitStop()
    await pause

    expect(mixedContext.suspend).not.toHaveBeenCalled()
    expect(mixedContext.state).toBe('running')
    expect(mixedContext.close).not.toHaveBeenCalled()
    await manager.resumeCapture(capabilities)
    expect(mixedContext.resume).not.toHaveBeenCalled()
    expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce()

    manager.stop()
    expect(mixedContext.close).toHaveBeenCalledOnce()
    expect(mixedContext.sourceNodes.every(node => node.disconnect.mock.calls.length === 1)).toBe(true)
    expect(mixedContext.destinationNode?.disconnect).toHaveBeenCalledOnce()
  })

  it('keeps a replacement mixed graph running while capture delivery remains paused', async () => {
    const { displayStream, mediaDevices } = installMediaMocks({ displayAudioTracks: 1, microphoneAvailable: true })
    const manager = new CaptureManager()
    const capabilities = { audioInputMode: 'media-recorder' } as const

    await manager.acquireStream({ includeMicrophone: true })
    await manager.startWithStream(capabilities, {
      onAudioData: vi.fn(),
      onTrackEnded: vi.fn(),
      onDeviceChange: vi.fn(),
    })
    const pause = manager.pauseCapture()
    FakeMediaRecorder.instances[0].emitStop()
    await pause
    displayStream.getAudioTracks()[0].end()
    manager.clearInvalidSource()

    const replacementDisplay = new FakeMediaStream([new FakeTrack('audio'), new FakeTrack('video')])
    const replacementMicrophone = new FakeMediaStream([new FakeTrack('audio')])
    mediaDevices.getDisplayMedia.mockResolvedValueOnce(replacementDisplay)
    mediaDevices.getUserMedia.mockResolvedValueOnce(replacementMicrophone)
    await manager.acquireStream({ includeMicrophone: true })

    const replacementContext = FakeAudioContext.instances[1]
    expect(replacementContext.suspend).not.toHaveBeenCalled()
    expect(replacementContext.resume).not.toHaveBeenCalled()
    await manager.resumeCapture(capabilities)
    expect(replacementContext.resume).not.toHaveBeenCalled()
  })

  it('marks an ended paused source invalid and ignores queued device changes', async () => {
    vi.useFakeTimers()
    const { displayStream, mediaDevices } = installMediaMocks({ displayAudioTracks: 1 })
    const manager = new CaptureManager()
    const onTrackEnded = vi.fn()
    const onDeviceChange = vi.fn()
    const capabilities = { audioInputMode: 'media-recorder' } as const

    await manager.acquireStream({ includeMicrophone: false })
    await manager.startWithStream(capabilities, {
      onAudioData: vi.fn(),
      onTrackEnded,
      onDeviceChange,
    })

    mediaDevices.emitDeviceChange()
    const recorder = FakeMediaRecorder.instances[0]
    const pause = manager.pauseCapture()
    recorder.emitStop()
    await pause

    mediaDevices.emitDeviceChange()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onDeviceChange).not.toHaveBeenCalled()

    displayStream.getAudioTracks()[0].end()
    expect(onTrackEnded).not.toHaveBeenCalled()
    expect(manager.hasInvalidSource).toBe(true)
    expect(manager.isRetainedStreamHealthy()).toBe(false)
    await expect(manager.resumeCapture(capabilities)).rejects.toThrow(/unavailable/)

    manager.clearInvalidSource()
    expect(manager.currentStream).toBeNull()
    expect(displayStream.getAudioTracks()[0].stop).toHaveBeenCalled()
  })
})

describe('AudioProcessor cancellation', () => {
  beforeEach(() => {
    resetMediaMocks()
    installMediaMocks({ displayAudioTracks: 1 })
  })

  it('does not finish an async AudioWorklet start after stop', async () => {
    let resolveModule: (() => void) | null = null
    FakeAudioContext.addModuleImplementation = () => new Promise<void>((resolve) => {
      resolveModule = resolve
    })
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)

    const processor = new AudioProcessor()
    const stream = new FakeMediaStream([new FakeTrack('audio')]) as unknown as MediaStream
    const start = processor.start(stream, vi.fn())
    processor.stop()

    resolveModule!()
    await start

    expect(FakeAudioWorkletNode.instances).toHaveLength(0)
  })
})
