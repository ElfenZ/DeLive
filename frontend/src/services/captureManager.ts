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
  private sourceStreams: MediaStream[] = []
  private sourceTrackEndedCleanup: Array<() => void> = []
  private deviceChangeCleanup: (() => void) | null = null
  private callbacks: CaptureCallbacks | null = null
  private _isRestarting = false
  private captureMode: 'system-audio' | 'microphone' | 'mixed' = 'system-audio'

  async start(
    capabilities: CapturePipelineCapabilities,
    callbacks: CaptureCallbacks,
    audioOptions: CaptureAudioOptions,
  ): Promise<MediaStream> {
    this.callbacks = callbacks

    const stream = await this.requestDisplayAudio(audioOptions)
    this.mediaStream = stream

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
    if (capabilities.audioInputMode === 'pcm16') {
      console.log('[CaptureManager] PCM16 mode, no need to restart recorder')
      return
    }

    this.stopPipeline()

    console.log('[CaptureManager] Restarting MediaRecorder for new WebM header')
    const recorder = createCompatibleMediaRecorder(this.mediaStream, capabilities.audioProfile)
    this.mediaRecorder = recorder
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.callbacks?.onAudioData(event.data)
      }
    }
    recorder.onerror = (event) => {
      console.error('[CaptureManager] MediaRecorder error:', event)
    }
    recorder.start(capabilities.audioProfile?.preferredChunkMs ?? 100)
    console.log('[CaptureManager] MediaRecorder restarted')
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
          microphoneStream.getAudioTracks()[0].onended = () => {
            if (this._isRestarting) {
              console.log('[CaptureManager] Microphone track ended (ignored: restarting)')
              return
            }
            console.log('[CaptureManager] Microphone track ended')
            this.callbacks?.onTrackEnded()
          }
          return microphoneStream
        }
      }
      throw new Error('未能获取系统音频，且麦克风不可用。请共享系统音频，或启用可用的麦克风。')
    }

    displayStream.getVideoTracks().forEach((track) => track.stop())

    const systemAudioStream = new MediaStream(audioTracks)
    const audioStream = await this.mixMicrophoneIfAvailable(systemAudioStream, audioOptions)
    audioStream.getAudioTracks()[0].onended = () => {
      if (this._isRestarting) {
        console.log('[CaptureManager] Audio track ended (ignored: restarting)')
        return
      }
      console.log('[CaptureManager] Audio track ended')
      this.callbacks?.onTrackEnded()
    }

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
    this.sourceStreams = [systemAudioStream, microphoneStream]
    this.captureMode = 'mixed'
    const mixedStream = destination.stream

    const stopMixedStream = () => {
      mixedStream.getTracks().forEach((track) => track.stop())
    }

    this.registerSourceTrackEndedHandlers(
      [...systemAudioStream.getAudioTracks(), ...microphoneStream.getAudioTracks()],
      stopMixedStream,
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

    if (audioInputMode === 'pcm16') {
      console.log('[CaptureManager] Using AudioProcessor (PCM16)')
      const processor = new AudioProcessor({
        sampleRate: audioProfile?.sampleRateHz ?? 16000,
        channels: audioProfile?.channels ?? 1,
      })
      this.audioProcessor = processor
      await processor.start(stream, (pcmData) => {
        this.callbacks?.onAudioData(pcmData)
      })
      return
    }

    console.log('[CaptureManager] Using MediaRecorder')
    const recorder = createCompatibleMediaRecorder(stream, audioProfile)
    this.mediaRecorder = recorder
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.callbacks?.onAudioData(event.data)
      }
    }
    recorder.onerror = (event) => {
      console.error('[CaptureManager] MediaRecorder error:', event)
    }
    recorder.start(audioProfile?.preferredChunkMs ?? 100)
    console.log('[CaptureManager] MediaRecorder started')
  }

  private stopPipeline(): void {
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
    this.clearSourceTrackEndedHandlers()
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop())
      this.mediaStream = null
    }
    for (const stream of this.sourceStreams) {
      stream.getTracks().forEach((track) => track.stop())
    }
    this.sourceStreams = []
    if (this.mixedAudioContext) {
      void this.mixedAudioContext.close()
      this.mixedAudioContext = null
    }
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
    let timer: ReturnType<typeof setTimeout> | null = null
    const handler = () => {
      console.log('[CaptureManager] Detected audio device change')
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        this.callbacks?.onDeviceChange()
      }, 1500)
    }

    navigator.mediaDevices.addEventListener('devicechange', handler)
    this.deviceChangeCleanup = () => {
      navigator.mediaDevices.removeEventListener('devicechange', handler)
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private removeDeviceListener(): void {
    if (this.deviceChangeCleanup) {
      this.deviceChangeCleanup()
      this.deviceChangeCleanup = null
    }
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
