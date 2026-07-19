import { AudioProcessor } from '../utils/audioProcessor'
import type { ASRAudioProfileCapabilities, ASRProviderCapabilities } from '../types/asr'

export interface CaptureCallbacks {
  onAudioData: (data: Blob | ArrayBuffer) => void
  onTrackEnded: () => void
  onDeviceChange: () => void
}

export interface CaptureAudioOptions {
  includeMicrophone: boolean
  microphoneDeviceId?: string
  onMicrophoneUnavailable?: (reason: 'microphone-unavailable' | 'audio-context-unavailable') => void
}

type CapturePipelineCapabilities = Pick<ASRProviderCapabilities, 'audioInputMode' | 'audioProfile'>

const RECORDER_STOP_TIMEOUT_MS = 2_000

function resolvePreferredMimeTypes(profile?: ASRAudioProfileCapabilities): string[] {
  if (profile?.payloadFormat === 'wav') {
    return ['audio/wav', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  }

  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ]
}

function createCompatibleMediaRecorder(
  stream: MediaStream,
  profile?: ASRAudioProfileCapabilities,
): MediaRecorder {
  const preferredMimeTypes = resolvePreferredMimeTypes(profile)

  if (typeof MediaRecorder.isTypeSupported === 'function') {
    for (const mimeType of preferredMimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        console.log(`[CaptureManager] Using MediaRecorder format: ${mimeType}`)
        return new MediaRecorder(stream, { mimeType })
      }
    }
  }

  console.log('[CaptureManager] Falling back to browser default MediaRecorder config')
  return new MediaRecorder(stream)
}

export class CaptureManager {
  private mediaStream: MediaStream | null = null
  private mediaRecorder: MediaRecorder | null = null
  private audioProcessor: AudioProcessor | null = null
  private mixedAudioContext: AudioContext | null = null
  private mixedDestinationNode: MediaStreamAudioDestinationNode | null = null
  private mixedSourceNodes: MediaStreamAudioSourceNode[] = []
  private sourceStreams: MediaStream[] = []
  private sourceTrackEndedCleanup: Array<() => void> = []
  private deviceChangeCleanup: (() => void) | null = null
  private callbacks: CaptureCallbacks | null = null
  private _isRestarting = false
  private captureMode: 'system-audio' | 'microphone' | 'mixed' = 'system-audio'
  private pipelineGeneration = 0
  private isCapturePaused = false
  private sourceInvalid = false
  private pausePromise: Promise<void> | null = null
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null

  async start(
    capabilities: CapturePipelineCapabilities,
    callbacks: CaptureCallbacks,
    audioOptions: CaptureAudioOptions,
  ): Promise<MediaStream> {
    this.callbacks = callbacks

    const stream = await this.requestDisplayAudio(audioOptions)
    this.mediaStream = stream
    this.sourceInvalid = false

    await this.startPipeline(capabilities, stream)
    this.listenDeviceChanges()

    return stream
  }

  /**
   * Phase 1: Only request display audio (shows the source picker dialog).
   * Returns the MediaStream without starting any recording pipeline.
   * Call startWithStream() after provider connect to begin capturing.
   */
  async acquireStream(audioOptions: CaptureAudioOptions): Promise<MediaStream> {
    const stream = await this.requestDisplayAudio(audioOptions)
    this.mediaStream = stream
    this.sourceInvalid = false
    return stream
  }

  /**
   * Phase 2: Start the recording pipeline on an already-acquired stream.
   * Must be called after acquireStream().
   */
  async startWithStream(
    capabilities: CapturePipelineCapabilities,
    callbacks: CaptureCallbacks,
  ): Promise<void> {
    if (!this.mediaStream) {
      throw new Error('No stream acquired. Call acquireStream() first.')
    }
    this.callbacks = callbacks
    await this.startPipeline(capabilities, this.mediaStream)
    this.listenDeviceChanges()
  }

  get isRestarting(): boolean {
    return this._isRestarting
  }

  async restartPipeline(
    capabilities: CapturePipelineCapabilities,
    audioOptions: CaptureAudioOptions,
  ): Promise<MediaStream> {
    this._isRestarting = true

    this.stopPipeline()
    this.clearTrackEndedHandler()
    this.stopStream()

    await new Promise((resolve) => setTimeout(resolve, 1000))

    try {
      const stream = await this.requestDisplayAudio(audioOptions)
      this.mediaStream = stream
      this.sourceInvalid = false

      await this.startPipeline(capabilities, stream)

      return stream
    } finally {
      this._isRestarting = false
    }
  }

  /**
   * 仅获取新的音频流（停掉旧流），不启动 MediaRecorder/AudioProcessor。
   * 用于需要在 provider connect 之后再启动 recorder 的场景（避免 WebM 头丢失）。
   */
  async restartStreamOnly(audioOptions: CaptureAudioOptions): Promise<MediaStream> {
    this._isRestarting = true

    this.stopPipeline()
    this.clearTrackEndedHandler()
    this.stopStream()

    await new Promise((resolve) => setTimeout(resolve, 1000))

    try {
      const stream = await this.requestDisplayAudio(audioOptions)
      this.mediaStream = stream
      this.sourceInvalid = false
      return stream
    } catch (error) {
      this._isRestarting = false
      throw error
    }
  }

  finishRestart(): void {
    this._isRestarting = false
  }

  stop(): void {
    this.removeDeviceListener()
    this.stopPipeline()
    this.stopStream()
    this.isCapturePaused = false
    this.sourceInvalid = false
    this.callbacks = null
  }

  /**
   * 仅停止 MediaRecorder / AudioProcessor 的数据产出，不释放 MediaStream。
   * 用于配置热切换：在 reconnect 新 WebSocket 前调用，防止旧 MediaRecorder
   * 产生的无头数据被发送到新连接。
   */
  pauseRecorder(): void {
    this.stopPipeline()
    console.log('[CaptureManager] Recorder paused (stream kept alive)')
  }

  /**
   * Stops audio delivery while retaining the capture source and its permissions.
   * WebM recorders are drained before this promise resolves so their final chunk
   * reaches the current consumer. Subsequent callbacks from that pipeline are
   * rejected by its generation gate.
   */
  async pauseCapture(): Promise<void> {
    if (this.pausePromise) {
      return this.pausePromise
    }
    if (this.isCapturePaused) {
      return
    }

    this.isCapturePaused = true
    this.cancelPendingDeviceChange()
    this.pausePromise = this.pauseActivePipeline()

    try {
      await this.pausePromise
    } finally {
      this.pausePromise = null
    }
  }

  /**
   * Restarts the active audio pipeline on the retained stream. Callers must
   * replace an invalid source before resuming.
   */
  async resumeCapture(capabilities: CapturePipelineCapabilities): Promise<void> {
    if (this.pausePromise) {
      await this.pausePromise
    }
    if (!this.isCapturePaused) {
      return
    }
    if (!this.isRetainedStreamHealthy()) {
      throw new Error('Retained capture source is unavailable. Acquire a new source before resuming.')
    }

    const stream = this.mediaStream!
    try {
      if (this.mixedAudioContext && this.mixedAudioContext.state !== 'running') {
        await this.mixedAudioContext.resume()
      }
      await this.startPipeline(capabilities, stream)
      this.isCapturePaused = false
      console.log('[CaptureManager] Capture resumed with retained stream')
    } catch (error) {
      this.stopPipeline()
      throw error
    }
  }

  /**
   * Returns whether the retained source can be used for resume. Calling this
   * also records a source invalidation detected without an ended event.
   */
  isRetainedStreamHealthy(): boolean {
    const streams = this.mediaStream ? [this.mediaStream, ...this.sourceStreams] : []
    const healthy = !this.sourceInvalid
      && streams.length > 0
      && streams.every((stream) => stream.getAudioTracks().some((track) => track.readyState !== 'ended'))

    if (!healthy) {
      this.markSourceInvalid()
    }

    return healthy
  }

  get hasInvalidSource(): boolean {
    return this.sourceInvalid
  }

  /**
   * Releases only a source already known to be invalid. This lets the caller
   * prompt for a replacement while keeping the surrounding recording session
   * paused. Normal resource release remains owned by stop().
   */
  clearInvalidSource(): void {
    if (!this.sourceInvalid) {
      return
    }

    this.stopPipeline()
    this.clearTrackEndedHandler()
    this.stopStream()
  }

  /**
   * Switch the entire audio pipeline (MediaRecorder <-> AudioProcessor)
   * without re-requesting screen share. Used when switching between providers
   * that require different audio formats (e.g. WebM -> PCM16).
   */
  async switchPipeline(capabilities: CapturePipelineCapabilities): Promise<void> {
    if (!this.mediaStream) {
      console.warn('[CaptureManager] No active stream, cannot switch pipeline')
      return
    }
    this.stopPipeline()
    console.log('[CaptureManager] Switching audio pipeline for new provider')
    await this.startPipeline(capabilities, this.mediaStream)
  }

  /**
   * 重启 MediaRecorder（不重新请求屏幕共享）。
   * 用于配置热切换场景：新的 WebSocket 连接需要接收完整的 WebM 文件头，
   * 而正在运行的 MediaRecorder 只会输出后续音频段（缺少初始化段）。
   */
  restartRecorder(capabilities: CapturePipelineCapabilities): void {
    if (!this.mediaStream) {
      console.warn('[CaptureManager] No active stream, cannot restart recorder')
      return
    }
    this.stopPipeline()
    const pipelineName = capabilities.audioInputMode === 'pcm16' ? 'AudioProcessor' : 'MediaRecorder'
    console.log(`[CaptureManager] Restarting ${pipelineName} for a new pipeline generation`)
    void this.startPipeline(capabilities, this.mediaStream).catch((error) => {
      console.error(`[CaptureManager] Failed to restart ${pipelineName}:`, error)
    })
  }

  get currentStream(): MediaStream | null {
    return this.mediaStream
  }

  get currentCaptureMode(): 'system-audio' | 'microphone' | 'mixed' {
    return this.captureMode
  }

  private async requestDisplayAudio(audioOptions: CaptureAudioOptions): Promise<MediaStream> {
    console.log('[CaptureManager] Requesting screen share...')
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } as MediaTrackConstraints,
    })

    const audioTracks = displayStream.getAudioTracks()
    console.log('[CaptureManager] Audio track count:', audioTracks.length)

    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((track) => track.stop())
      if (audioOptions.includeMicrophone) {
        const microphoneStream = await this.requestMicrophoneStream(audioOptions)
        if (microphoneStream) {
          this.captureMode = 'microphone'
          this.sourceStreams = [microphoneStream]
          microphoneStream.getAudioTracks()[0].onended = () => this.handleCaptureTrackEnded()
          return microphoneStream
        }
      }
      throw new Error('未能获取系统音频，且麦克风不可用。请共享系统音频，或启用可用的麦克风。')
    }

    displayStream.getVideoTracks().forEach((track) => track.stop())

    const systemAudioStream = new MediaStream(audioTracks)
    const audioStream = await this.mixMicrophoneIfAvailable(systemAudioStream, audioOptions)
    audioStream.getAudioTracks()[0].onended = () => this.handleCaptureTrackEnded()

    return audioStream
  }

  private async mixMicrophoneIfAvailable(
    systemAudioStream: MediaStream,
    audioOptions: CaptureAudioOptions,
  ): Promise<MediaStream> {
    this.sourceStreams = [systemAudioStream]
    this.captureMode = 'system-audio'

    if (!audioOptions.includeMicrophone) {
      return systemAudioStream
    }

    const microphoneStream = await this.requestMicrophoneStream(audioOptions)
    if (!microphoneStream) {
      return systemAudioStream
    }

    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) {
      console.warn('[CaptureManager] AudioContext unavailable, using system audio only')
      microphoneStream.getTracks().forEach((track) => track.stop())
      audioOptions.onMicrophoneUnavailable?.('audio-context-unavailable')
      return systemAudioStream
    }

    const audioContext = new AudioContextCtor()
    const destination = audioContext.createMediaStreamDestination()

    const connectStream = (stream: MediaStream, label: string): MediaStreamAudioSourceNode | null => {
      const tracks = stream.getAudioTracks()
      if (tracks.length === 0) return null
      const source = audioContext.createMediaStreamSource(new MediaStream(tracks))
      source.connect(destination)
      console.log(`[CaptureManager] Mixed ${label} audio track count:`, tracks.length)
      return source
    }

    const systemSource = connectStream(systemAudioStream, 'system')
    const microphoneSource = connectStream(microphoneStream, 'microphone')

    if (!systemSource || !microphoneSource) {
      microphoneStream.getTracks().forEach((track) => track.stop())
      void audioContext.close()
      return systemAudioStream
    }

    this.mixedAudioContext = audioContext
    this.mixedDestinationNode = destination
    this.mixedSourceNodes = [systemSource, microphoneSource]
    this.sourceStreams = [systemAudioStream, microphoneStream]
    this.captureMode = 'mixed'
    const mixedStream = destination.stream

    const stopMixedStream = () => {
      mixedStream.getTracks().forEach((track) => track.stop())
    }

    this.registerSourceTrackEndedHandlers(
      [...systemAudioStream.getAudioTracks(), ...microphoneStream.getAudioTracks()],
      () => {
        stopMixedStream()
        this.handleCaptureTrackEnded()
      },
    )

    return mixedStream
  }

  private async requestMicrophoneStream(audioOptions: CaptureAudioOptions): Promise<MediaStream | null> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: this.buildMicrophoneConstraints(audioOptions.microphoneDeviceId),
        video: false,
      })
    } catch (error) {
      console.warn('[CaptureManager] Microphone capture unavailable:', error)
      audioOptions.onMicrophoneUnavailable?.('microphone-unavailable')
      return null
    }
  }

  private buildMicrophoneConstraints(microphoneDeviceId?: string): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }

    if (microphoneDeviceId) {
      constraints.deviceId = { exact: microphoneDeviceId }
    }

    return constraints
  }

  private async startPipeline(
    capabilities: CapturePipelineCapabilities,
    stream: MediaStream,
  ): Promise<void> {
    const { audioInputMode, audioProfile } = capabilities
    const generation = ++this.pipelineGeneration

    if (audioInputMode === 'pcm16') {
      console.log('[CaptureManager] Using AudioProcessor (PCM16)')
      const processor = new AudioProcessor({
        sampleRate: audioProfile?.sampleRateHz ?? 16000,
        channels: audioProfile?.channels ?? 1,
      })
      this.audioProcessor = processor
      await processor.start(stream, (pcmData) => {
        this.deliverAudioData(generation, pcmData)
      })
      if (generation !== this.pipelineGeneration) {
        processor.stop()
        if (this.audioProcessor === processor) {
          this.audioProcessor = null
        }
      }
      return
    }

    console.log('[CaptureManager] Using MediaRecorder')
    const recorder = createCompatibleMediaRecorder(stream, audioProfile)
    this.mediaRecorder = recorder
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.deliverAudioData(generation, event.data)
      }
    }
    recorder.onerror = (event) => {
      console.error('[CaptureManager] MediaRecorder error:', event)
    }
    recorder.start(audioProfile?.preferredChunkMs ?? 100)
    console.log('[CaptureManager] MediaRecorder started')
  }

  private stopPipeline(): void {
    this.pipelineGeneration += 1
    if (this.audioProcessor) {
      this.audioProcessor.stop()
      this.audioProcessor = null
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }
    this.mediaRecorder = null
  }

  private stopStream(): void {
    this.clearTrackEndedHandler()
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop())
      this.mediaStream = null
    }
    for (const stream of this.sourceStreams) {
      stream.getTracks().forEach((track) => track.stop())
    }
    this.sourceStreams = []
    for (const sourceNode of this.mixedSourceNodes) {
      sourceNode.disconnect()
    }
    this.mixedSourceNodes = []
    this.mixedDestinationNode?.disconnect()
    this.mixedDestinationNode = null
    if (this.mixedAudioContext) {
      void this.mixedAudioContext.close()
      this.mixedAudioContext = null
    }
    this.sourceInvalid = false
    this.captureMode = 'system-audio'
  }

  private registerSourceTrackEndedHandlers(tracks: MediaStreamTrack[], onEnded: () => void): void {
    this.clearSourceTrackEndedHandlers()

    this.sourceTrackEndedCleanup = tracks.map((track) => {
      const handler = () => onEnded()
      track.addEventListener('ended', handler)
      return () => track.removeEventListener('ended', handler)
    })
  }

  private clearSourceTrackEndedHandlers(): void {
    for (const cleanup of this.sourceTrackEndedCleanup) {
      cleanup()
    }
    this.sourceTrackEndedCleanup = []
  }

  private listenDeviceChanges(): void {
    if (this.deviceChangeCleanup) {
      return
    }

    const handler = () => {
      if (this.isCapturePaused) {
        return
      }
      console.log('[CaptureManager] Detected audio device change')
      this.cancelPendingDeviceChange()
      this.deviceChangeTimer = setTimeout(() => {
        this.deviceChangeTimer = null
        if (this.isCapturePaused) {
          return
        }
        this.callbacks?.onDeviceChange()
      }, 1500)
    }

    navigator.mediaDevices.addEventListener('devicechange', handler)
    this.deviceChangeCleanup = () => {
      navigator.mediaDevices.removeEventListener('devicechange', handler)
      this.cancelPendingDeviceChange()
    }
  }

  private removeDeviceListener(): void {
    if (this.deviceChangeCleanup) {
      this.deviceChangeCleanup()
      this.deviceChangeCleanup = null
    }
  }

  private cancelPendingDeviceChange(): void {
    if (this.deviceChangeTimer) {
      clearTimeout(this.deviceChangeTimer)
      this.deviceChangeTimer = null
    }
  }

  private deliverAudioData(generation: number, data: Blob | ArrayBuffer): void {
    if (generation === this.pipelineGeneration) {
      this.callbacks?.onAudioData(data)
    }
  }

  private async pauseActivePipeline(): Promise<void> {
    const processor = this.audioProcessor
    const recorder = this.mediaRecorder

    this.audioProcessor = null
    this.mediaRecorder = null
    processor?.stop()

    try {
      if (recorder && recorder.state !== 'inactive') {
        await this.stopMediaRecorder(recorder)
      }
    } finally {
      // Keep the current generation until the WebM terminal chunk has been
      // delivered, then reject all late callbacks from the stopped pipeline.
      this.pipelineGeneration += 1
    }

    console.log('[CaptureManager] Capture paused (stream and mixer kept alive)')
  }

  private stopMediaRecorder(recorder: MediaRecorder): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | null = null
      const complete = () => {
        if (settled) {
          return
        }
        settled = true
        if (timeout) {
          clearTimeout(timeout)
        }
        recorder.removeEventListener('stop', complete)
        resolve()
      }
      timeout = setTimeout(complete, RECORDER_STOP_TIMEOUT_MS)

      recorder.addEventListener('stop', complete)
      recorder.stop()
    })
  }

  private handleCaptureTrackEnded(): void {
    if (this._isRestarting) {
      console.log('[CaptureManager] Audio track ended (ignored: restarting)')
      return
    }
    if (this.isCapturePaused) {
      this.markSourceInvalid()
      return
    }

    console.log('[CaptureManager] Audio track ended')
    this.callbacks?.onTrackEnded()
  }

  private markSourceInvalid(): void {
    this.sourceInvalid = true
    console.log('[CaptureManager] Retained capture source is invalid')
  }

  private clearTrackEndedHandler(): void {
    if (this.mediaStream) {
      const tracks = this.mediaStream.getAudioTracks()
      for (const track of tracks) {
        track.onended = null
      }
    }
    this.clearSourceTrackEndedHandlers()
  }
}
