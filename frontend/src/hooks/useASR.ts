/**
 * useASR — 通用 ASR Hook（编排层）
 *
 * 将 CaptureManager、ProviderSessionManager、CaptionBridge 组合在一起，
 * 对外只暴露 startRecording / stopRecording。
 */

import { useCallback, useRef, useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTopicStore } from '../stores/topicStore'
import { CaptureManager, type CaptureAudioOptions } from '../services/captureManager'
import { CaptionBridge } from '../services/captionBridge'
import { ProviderSessionManager } from '../services/providerSession'
import type { ASRVendor } from '../types/asr'
import type { ProviderConfigData, TranscriptSourceMeta } from '../types'
import { buildPcmWavBlob } from '../utils/pcmWav'
import { AudioProcessor } from '../utils/audioProcessor'

interface UseASROptions {
  onError?: (message: string) => void
  onWarning?: (message: string) => void
  onStarted?: () => void
  onFinished?: () => void
}

const SOURCE_AUDIO_FLUSH_INTERVAL_MS = 1000
const SOURCE_AUDIO_FLUSH_BYTES = 256 * 1024

function concatArrayBuffers(chunks: ArrayBuffer[], totalBytes: number): ArrayBuffer {
  if (chunks.length === 1 && chunks[0].byteLength === totalBytes) {
    return chunks[0]
  }

  const output = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  }
  return output.buffer
}

export function useASR(options: UseASROptions = {}) {
  const captureRef = useRef(new CaptureManager())
  const captionRef = useRef(new CaptionBridge())
  const providerSessionRef = useRef(new ProviderSessionManager())
  const isRestartingRef = useRef(false)
  const lastRestartTimeRef = useRef(0)
  const selectedVendorRef = useRef<ASRVendor | null>(null)
  const stopRecordingRef = useRef<() => Promise<void>>(async () => {})
  const microphoneWarningShownRef = useRef(false)
  const activeCaptureAudioOptionsRef = useRef<CaptureAudioOptions | null>(null)
  const sourceAudioChunksRef = useRef<Array<Blob | ArrayBuffer>>([])
  const sourceAudioMimeTypeRef = useRef('audio/wav')
  const sourceAudioProcessorRef = useRef<AudioProcessor | null>(null)
  const sourceAudioArchiveActiveRef = useRef(false)
  const sourceAudioArchiveSessionIdRef = useRef<string | null>(null)
  const sourceAudioAppendQueueRef = useRef<Promise<void>>(Promise.resolve())
  const sourceAudioArchiveFailedRef = useRef(false)
  const sourceAudioPendingChunksRef = useRef<ArrayBuffer[]>([])
  const sourceAudioPendingBytesRef = useRef(0)
  const sourceAudioFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { settings } = useSettingsStore()
  const {
    applyTranscriptEvent,
    setRecordingState,
    startNewSession,
    endCurrentSession,
  } = useSessionStore()

  const buildCaptureAudioOptions = useCallback((): CaptureAudioOptions => {
    const captureSettings = settings.capture || {}
    const t = useUIStore.getState().t

    return {
      includeMicrophone: captureSettings.includeMicrophone !== false,
      microphoneDeviceId: captureSettings.microphoneDeviceId || '',
      onMicrophoneUnavailable: () => {
        if (microphoneWarningShownRef.current) {
          return
        }

        microphoneWarningShownRef.current = true
        options.onWarning?.(t.settings.microphoneUnavailableWarning)
      },
    }
  }, [options, settings.capture])

  const clearSourceAudioFlushTimer = useCallback(() => {
    if (sourceAudioFlushTimerRef.current) {
      clearTimeout(sourceAudioFlushTimerRef.current)
      sourceAudioFlushTimerRef.current = null
    }
  }, [])

  const queueSourceAudioAppend = useCallback((sessionId: string, data: ArrayBuffer) => {
    sourceAudioAppendQueueRef.current = sourceAudioAppendQueueRef.current
      .then(async () => {
        const result = await window.electronAPI?.appendRecordingArchive?.({ sessionId, data })
        if (!result?.ok) {
          throw new Error(result?.error || '录音源音频写入失败')
        }
      })
      .catch((error) => {
        sourceAudioArchiveFailedRef.current = true
        console.warn('[useASR] 录音源音频增量写入失败:', error)
      })
    return sourceAudioAppendQueueRef.current
  }, [])

  const flushBufferedSourceAudio = useCallback((sessionId: string): Promise<void> => {
    clearSourceAudioFlushTimer()
    const chunks = sourceAudioPendingChunksRef.current
    const totalBytes = sourceAudioPendingBytesRef.current
    sourceAudioPendingChunksRef.current = []
    sourceAudioPendingBytesRef.current = 0

    if (chunks.length === 0 || totalBytes === 0) {
      return sourceAudioAppendQueueRef.current
    }

    return queueSourceAudioAppend(sessionId, concatArrayBuffers(chunks, totalBytes))
  }, [clearSourceAudioFlushTimer, queueSourceAudioAppend])

  const scheduleBufferedSourceAudioFlush = useCallback((sessionId: string) => {
    if (sourceAudioFlushTimerRef.current) return
    sourceAudioFlushTimerRef.current = setTimeout(() => {
      sourceAudioFlushTimerRef.current = null
      void flushBufferedSourceAudio(sessionId)
    }, SOURCE_AUDIO_FLUSH_INTERVAL_MS)
  }, [flushBufferedSourceAudio])

  const resetSourceAudioArchive = useCallback(() => {
    clearSourceAudioFlushTimer()
    sourceAudioChunksRef.current = []
    sourceAudioMimeTypeRef.current = 'audio/wav'
    sourceAudioArchiveActiveRef.current = false
    sourceAudioArchiveSessionIdRef.current = null
    sourceAudioAppendQueueRef.current = Promise.resolve()
    sourceAudioArchiveFailedRef.current = false
    sourceAudioPendingChunksRef.current = []
    sourceAudioPendingBytesRef.current = 0
  }, [clearSourceAudioFlushTimer])

  const stopSourceAudioArchive = useCallback(() => {
    if (sourceAudioProcessorRef.current) {
      sourceAudioProcessorRef.current.stop()
      sourceAudioProcessorRef.current = null
    }
    clearSourceAudioFlushTimer()
    sourceAudioArchiveActiveRef.current = false
  }, [clearSourceAudioFlushTimer])

  const startSourceAudioArchive = useCallback(async (sessionId: string, stream: MediaStream): Promise<boolean> => {
    stopSourceAudioArchive()
    if (!window.electronAPI?.beginRecordingArchive || !window.electronAPI.appendRecordingArchive) {
      return false
    }

    const processor = new AudioProcessor({ sampleRate: 16000, channels: 1, muted: true })

    try {
      if (sourceAudioArchiveSessionIdRef.current !== sessionId) {
        const beginResult = await window.electronAPI.beginRecordingArchive({
          sessionId,
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
        })
        if (!beginResult.ok) {
          throw new Error(beginResult.error || '录音源音频归档初始化失败')
        }
      }

      await processor.start(stream, (pcmData) => {
        const chunk = pcmData.slice(0)
        sourceAudioPendingChunksRef.current.push(chunk)
        sourceAudioPendingBytesRef.current += chunk.byteLength
        if (sourceAudioPendingBytesRef.current >= SOURCE_AUDIO_FLUSH_BYTES) {
          void flushBufferedSourceAudio(sessionId)
        } else {
          scheduleBufferedSourceAudioFlush(sessionId)
        }
      })
      sourceAudioProcessorRef.current = processor
      sourceAudioMimeTypeRef.current = 'audio/wav'
      sourceAudioArchiveActiveRef.current = true
      sourceAudioArchiveSessionIdRef.current = sessionId
      return true
    } catch (error) {
      console.warn('[useASR] 录音源音频 WAV 归档启动失败，回退到 provider 原始格式:', error)
      processor.stop()
      sourceAudioArchiveActiveRef.current = false
      return false
    }
  }, [flushBufferedSourceAudio, scheduleBufferedSourceAudioFlush, stopSourceAudioArchive])

  const appendSourceAudioChunk = useCallback((data: Blob | ArrayBuffer) => {
    if (data instanceof Blob) {
      if (data.type) sourceAudioMimeTypeRef.current = data.type
      sourceAudioChunksRef.current.push(data)
      return
    }
    sourceAudioChunksRef.current.push(data.slice(0))
    sourceAudioMimeTypeRef.current = 'audio/wav'
  }, [])

  const finalizeSourceAudioArchive = useCallback(async (
    sessionId: string | null,
    captureMode: NonNullable<TranscriptSourceMeta['captureMode']>,
  ): Promise<Partial<TranscriptSourceMeta> | undefined> => {
    if (!sessionId) return undefined
    const incrementalSessionId = sourceAudioArchiveSessionIdRef.current

    if (incrementalSessionId && window.electronAPI?.finalizeRecordingArchive) {
      try {
        await flushBufferedSourceAudio(incrementalSessionId)
        await sourceAudioAppendQueueRef.current
        const result = await window.electronAPI.finalizeRecordingArchive({
          sessionId: incrementalSessionId,
          fileName: 'source-audio.wav',
        })

        if (!result.ok || !result.path) {
          options.onWarning?.(result.error || '录音源音频保存失败')
          return undefined
        }

        const captureAudioSource = captureMode === 'mixed'
          ? 'mixed'
          : captureMode === 'microphone'
            ? 'microphone'
            : 'system'

        if (sourceAudioArchiveFailedRef.current) {
          options.onWarning?.('录音源音频曾发生写入错误，已保存可恢复的部分音频')
        }

        return {
          sourceKind: 'recording-audio',
          audioPath: result.path,
          audioMimeType: result.mimeType || 'audio/wav',
          audioFileName: result.fileName || 'source-audio.wav',
          audioSize: result.size,
          captureAudioSource,
        }
      } catch (error) {
        console.warn('[useASR] 完成录音源音频归档失败:', error)
        options.onWarning?.('录音源音频保存失败，转录文本已保留')
        return undefined
      }
    }

    if (!window.electronAPI?.saveRecordingArchive) return undefined
    const chunks = sourceAudioChunksRef.current
    if (chunks.length === 0) return undefined

    try {
      const allPcm = chunks.every((chunk) => chunk instanceof ArrayBuffer)
      const mimeType = allPcm ? 'audio/wav' : sourceAudioMimeTypeRef.current || 'audio/webm'
      const extension = mimeType.includes('wav')
        ? 'wav'
        : mimeType.includes('mp4')
          ? 'm4a'
          : mimeType.includes('webm')
            ? 'webm'
            : 'bin'
      const blob = allPcm
        ? buildPcmWavBlob(chunks as ArrayBuffer[], { sampleRate: 16000, channels: 1 })
        : new Blob(chunks, { type: mimeType })
      const fileName = `source-audio.${extension}`
      const result = await window.electronAPI.saveRecordingArchive({
        sessionId,
        fileName,
        mimeType,
        data: await blob.arrayBuffer(),
      })

      if (!result.ok || !result.path) {
        options.onWarning?.(result.error || '录音源音频保存失败')
        return undefined
      }

      const captureAudioSource = captureMode === 'mixed'
        ? 'mixed'
        : captureMode === 'microphone'
          ? 'microphone'
          : 'system'

      return {
        sourceKind: 'recording-audio',
        audioPath: result.path,
        audioMimeType: result.mimeType || mimeType,
        audioFileName: result.fileName || fileName,
        audioSize: result.size || blob.size,
        captureAudioSource,
      }
    } catch (error) {
      console.warn('[useASR] 保存录音源音频失败:', error)
      options.onWarning?.('录音源音频保存失败，转录文本已保留')
      return undefined
    }
  }, [flushBufferedSourceAudio, options])

  // ── 停止录制 ──────────────────────────────────────

  const stopRecording = useCallback(async () => {
    console.log('[useASR] 停止录制...')
    setRecordingState('stopping')
    const sessionId = useSessionStore.getState().currentSessionId
    const captureMode = captureRef.current.currentCaptureMode
    let sourceMetaPatch: Partial<TranscriptSourceMeta> | undefined

    try {
      stopSourceAudioArchive()
      captureRef.current.stop()
      sourceMetaPatch = await finalizeSourceAudioArchive(sessionId, captureMode)
      await providerSessionRef.current.disconnect()
    } finally {
      captionRef.current.clear()
      microphoneWarningShownRef.current = false
      activeCaptureAudioOptionsRef.current = null

      selectedVendorRef.current = null
      endCurrentSession({ sourceMetaPatch })
      resetSourceAudioArchive()
      setRecordingState('idle')
      console.log('[useASR] 录制已停止')
    }
  }, [setRecordingState, finalizeSourceAudioArchive, endCurrentSession, resetSourceAudioArchive, stopSourceAudioArchive])

  stopRecordingRef.current = stopRecording

  // ── 组件卸载清理 ──────────────────────────────────

  useEffect(() => {
    const capture = captureRef.current
    const providerSession = providerSessionRef.current

    return () => {
      stopSourceAudioArchive()
      capture.stop()
      void providerSession.disconnect()
    }
  }, [stopSourceAudioArchive])

  // ── Provider 事件 → Store + 字幕 ──────────────────

  const buildProviderCallbacks = useCallback(() => ({
    onTokens(tokens: import('../types/asr').TranscriptToken[]) {
      applyTranscriptEvent({ type: 'tokens', tokens })

      const s = useSessionStore.getState()
      captionRef.current.update(
        s.finalTranscript,
        s.nonFinalTranscript,
        s.finalTranslatedTranscript,
        s.nonFinalTranslatedTranscript,
      )
    },

    onPartial(text: string) {
      applyTranscriptEvent({ type: 'partial-text', text })
      const s = useSessionStore.getState()
      captionRef.current.update(
        s.finalTranscript,
        text,
        s.finalTranslatedTranscript,
        s.nonFinalTranslatedTranscript,
      )
    },

    onFinal(text: string) {
      applyTranscriptEvent({ type: 'final-text', text })
      const s = useSessionStore.getState()
      captionRef.current.update(
        s.finalTranscript,
        '',
        s.finalTranslatedTranscript,
        '',
      )
    },

    onError(error: import('../types/asr').ASRError) {
      const currentState = useSessionStore.getState().recordingState
      if (currentState === 'switching') {
        console.warn('[useASR] 配置切换中收到 Provider 错误（忽略）:', error.code, error.message)
        return
      }
      options.onError?.(`${error.code}: ${error.message}`)
      void stopRecordingRef.current()
    },

    onFinished() {
      options.onFinished?.()
    },
  }), [applyTranscriptEvent, options])

  // ── 设备变化后自动重启采集 ─────────────────────────

  const restartCapture = useCallback(async () => {
    if (isRestartingRef.current) return
    const now = Date.now()
    if (now - lastRestartTimeRef.current < 10_000) return
    const vendorId = selectedVendorRef.current
    if (!vendorId) return

    console.log('[useASR] 音频设备变化，自动重新采集')
    isRestartingRef.current = true
    lastRestartTimeRef.current = now

    try {
      const psm = providerSessionRef.current
      const setup = psm.resolveSetup(vendorId, settings)
      const needReconnect = setup.captureRestartStrategy === 'reconnect-session'
      const capture = captureRef.current
      const audioOptions = activeCaptureAudioOptionsRef.current || buildCaptureAudioOptions()

      await window.electronAPI?.prepareSourceCapture?.('reuse-if-available')
      stopSourceAudioArchive()

      if (needReconnect) {
        // WebM 流 provider（Soniox）：必须先获取新 stream，再 connect，最后启动 recorder
        // 确保新 WebSocket 接收到完整的 WebM 文件头
        await psm.disconnect()

        const stream = await capture.restartStreamOnly(audioOptions)
        const sessionId = useSessionStore.getState().currentSessionId
        if (sessionId) await startSourceAudioArchive(sessionId, stream)

        await psm.connect(vendorId, setup.connectConfig, buildProviderCallbacks())

        capture.restartRecorder(setup.providerInfo.capabilities)
        capture.finishRestart()

        stream.getAudioTracks()[0].onended = () => {
          if (capture.isRestarting) return
          console.log('[useASR] 音频轨道结束（用户停止共享）')
          void stopRecordingRef.current()
        }
      } else {
        const stream = await capture.restartPipeline(
          setup.providerInfo.capabilities,
          audioOptions,
        )
        const sessionId = useSessionStore.getState().currentSessionId
        if (sessionId) await startSourceAudioArchive(sessionId, stream)

        if (!psm.currentProvider) {
          await psm.connect(vendorId, setup.connectConfig, buildProviderCallbacks())
        }

        stream.getAudioTracks()[0].onended = () => {
          if (capture.isRestarting) return
          console.log('[useASR] 音频轨道结束（用户停止共享）')
          void stopRecordingRef.current()
        }
      }

      console.log('[useASR] 音频重新采集成功')
    } catch (error) {
      console.error('[useASR] 音频重新采集失败:', error)
      captureRef.current.finishRestart()
      stopSourceAudioArchive()
      captureRef.current.stop()
      await providerSessionRef.current.disconnect()
      endCurrentSession()
      activeCaptureAudioOptionsRef.current = null
      microphoneWarningShownRef.current = false
      setRecordingState('idle')
      options.onError?.('音频设备切换后重新捕获失败，录制已停止')
    } finally {
      isRestartingRef.current = false
    }
  }, [settings, buildCaptureAudioOptions, buildProviderCallbacks, endCurrentSession, setRecordingState, options, startSourceAudioArchive, stopSourceAudioArchive])

  // ── 开始录制 ──────────────────────────────────────

  const startRecording = useCallback(async () => {
    const vendorId = (settings.currentVendor || 'soniox') as ASRVendor
    const psm = providerSessionRef.current

    let setup: ReturnType<typeof psm.resolveSetup>
    try {
      setup = psm.resolveSetup(vendorId, settings)
    } catch (e) {
      options.onError?.((e as Error).message)
      return
    }

    captionRef.current.clear()
    resetSourceAudioArchive()
    console.log(
      `[useASR] 开始录制，提供商: ${vendorId}, transport=${setup.providerInfo.capabilities.transport.type}`,
    )

    const capture = captureRef.current
    const audioOptions = buildCaptureAudioOptions()
    activeCaptureAudioOptionsRef.current = audioOptions

    // Phase 1: Show source picker dialog BEFORE connecting to provider.
    // This prevents realtime providers (e.g. Volc) from timing out while the
    // user is choosing a desktop source.
    let acquiredStream: MediaStream
    try {
      setRecordingState('starting')
      await window.electronAPI?.prepareSourceCapture?.('prompt')
      acquiredStream = await capture.acquireStream(audioOptions)
    } catch (error) {
      stopSourceAudioArchive()
      setRecordingState('idle')
      if (error instanceof Error) {
        options.onError?.(
          error.name === 'NotAllowedError' ? '用户取消了屏幕共享' : error.message,
        )
      } else {
        options.onError?.('获取音频源失败')
      }
      activeCaptureAudioOptionsRef.current = null
      return
    }

    // Phase 2: Create the session/archive before starting the audio pipeline.
    let sessionId: string | null = null
    try {
      sessionId = startNewSession({ captureMode: capture.currentCaptureMode })
      await startSourceAudioArchive(sessionId, acquiredStream)

      const providerCallbacks = buildProviderCallbacks()
      await psm.connect(vendorId, setup.connectConfig, providerCallbacks)

      await capture.startWithStream(
        setup.providerInfo.capabilities,
        {
          onAudioData: (data) => {
            if (!sourceAudioArchiveActiveRef.current) {
              appendSourceAudioChunk(data)
            }
            psm.sendAudio(data)
          },
          onTrackEnded: () => {
            if (captureRef.current.isRestarting) {
              console.log('[useASR] Track ended during restart, ignoring')
              return
            }
            void stopRecordingRef.current()
          },
          onDeviceChange: () => {
            const currentState = useSessionStore.getState().recordingState
            if (currentState === 'recording') {
              void restartCapture()
            }
          },
        },
      )

      const activeTopicId = useTopicStore.getState().activeTopicId
      if (activeTopicId) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid) useSessionStore.getState().updateSessionTopic(sid, activeTopicId)
      }

      selectedVendorRef.current = vendorId
      setRecordingState('recording')
      options.onStarted?.()
      console.log('[useASR] 录制已开始')
    } catch (error) {
      console.error('[useASR] 启动失败:', error)
      stopSourceAudioArchive()
      capture.stop()
      await providerSessionRef.current.disconnect()
      if (useSessionStore.getState().currentSessionId) {
        endCurrentSession()
      }
      setRecordingState('idle')

      if (error instanceof Error) {
        options.onError?.(error.message)
      } else {
        options.onError?.('启动录制失败')
      }
      activeCaptureAudioOptionsRef.current = null
    }
  }, [
    settings,
    setRecordingState,
    startNewSession,
    endCurrentSession,
    options,
    buildCaptureAudioOptions,
    buildProviderCallbacks,
    appendSourceAudioChunk,
    resetSourceAudioArchive,
    restartCapture,
    startSourceAudioArchive,
    stopSourceAudioArchive,
  ])

  const switchConfig = useCallback(async (configPatch: Partial<ProviderConfigData>, changeDescription: string) => {
    const vendorId = selectedVendorRef.current
    if (!vendorId) return
    const currentState = useSessionStore.getState().recordingState
    if (currentState !== 'recording') return

    const previousConfig = useSettingsStore.getState().settings.providerConfigs?.[vendorId]

    try {
      setRecordingState('switching')

      useSettingsStore.getState().updateProviderConfig(vendorId, configPatch)

      const newSettings = useSettingsStore.getState().settings
      const psm = providerSessionRef.current
      const setup = psm.resolveSetup(vendorId, newSettings)

      applyTranscriptEvent({ type: 'config-change', description: changeDescription })

      // 关键：先停止 MediaRecorder 的数据产出，防止旧数据（无 WebM 头）被发到新连接
      captureRef.current.pauseRecorder()

      await psm.reconnect(vendorId, setup.connectConfig, buildProviderCallbacks())

      // reconnect 完成后再重启 MediaRecorder，生成新的 WebM 文件头
      captureRef.current.restartRecorder(setup.providerInfo.capabilities)

      setRecordingState('recording')
      console.log('[useASR] 配置热切换成功:', changeDescription)
    } catch (error) {
      console.error('[useASR] 配置热切换失败:', error)

      if (previousConfig) {
        useSettingsStore.getState().updateProviderConfig(vendorId, previousConfig)
      }

      try {
        const fallbackSettings = useSettingsStore.getState().settings
        const psm = providerSessionRef.current
        const fallbackSetup = psm.resolveSetup(vendorId, fallbackSettings)

        captureRef.current.pauseRecorder()
        await psm.reconnect(vendorId, fallbackSetup.connectConfig, buildProviderCallbacks())
        captureRef.current.restartRecorder(fallbackSetup.providerInfo.capabilities)

        setRecordingState('recording')
        options.onError?.('配置切换失败，已恢复之前的配置')
      } catch {
        stopSourceAudioArchive()
        captureRef.current.stop()
        await providerSessionRef.current.disconnect()
        endCurrentSession()
        activeCaptureAudioOptionsRef.current = null
        microphoneWarningShownRef.current = false
        setRecordingState('idle')
        options.onError?.('配置切换失败且无法恢复，录制已停止')
      }
    }
  }, [setRecordingState, endCurrentSession, applyTranscriptEvent, buildProviderCallbacks, options, stopSourceAudioArchive])

  const switchProvider = useCallback(async (newVendorId: ASRVendor) => {
    const oldVendorId = selectedVendorRef.current
    if (!oldVendorId || oldVendorId === newVendorId) return
    const currentState = useSessionStore.getState().recordingState
    if (currentState !== 'recording') return

    const psm = providerSessionRef.current

    let newSetup: ReturnType<typeof psm.resolveSetup>
    try {
      newSetup = psm.resolveSetup(newVendorId, useSettingsStore.getState().settings)
    } catch (e) {
      options.onError?.((e as Error).message)
      return
    }

    try {
      setRecordingState('switching')

      const oldName = oldVendorId
      const newName = newVendorId
      applyTranscriptEvent({
        type: 'config-change',
        description: `Provider: ${oldName} → ${newName}`,
      })

      captureRef.current.pauseRecorder()

      await psm.reconnect(newVendorId, newSetup.connectConfig, buildProviderCallbacks())

      await captureRef.current.switchPipeline(newSetup.providerInfo.capabilities)

      useSettingsStore.getState().setCurrentVendor(newVendorId)
      selectedVendorRef.current = newVendorId

      setRecordingState('recording')
      console.log(`[useASR] Provider 热切换成功: ${oldName} → ${newName}`)
    } catch (error) {
      console.error('[useASR] Provider 热切换失败:', error)

      try {
        const fallbackSettings = useSettingsStore.getState().settings
        const fallbackSetup = psm.resolveSetup(oldVendorId, fallbackSettings)

        captureRef.current.pauseRecorder()
        await psm.reconnect(oldVendorId, fallbackSetup.connectConfig, buildProviderCallbacks())
        await captureRef.current.switchPipeline(fallbackSetup.providerInfo.capabilities)

        selectedVendorRef.current = oldVendorId
        setRecordingState('recording')
        options.onError?.('Provider 切换失败，已恢复之前的配置')
      } catch {
        stopSourceAudioArchive()
        captureRef.current.stop()
        await providerSessionRef.current.disconnect()
        endCurrentSession()
        activeCaptureAudioOptionsRef.current = null
        microphoneWarningShownRef.current = false
        setRecordingState('idle')
        options.onError?.('Provider 切换失败且无法恢复，录制已停止')
      }
    }
  }, [setRecordingState, endCurrentSession, applyTranscriptEvent, buildProviderCallbacks, options, stopSourceAudioArchive])

  const getMediaStream = useCallback(() => captureRef.current.currentStream, [])

  return {
    startRecording,
    stopRecording,
    switchConfig,
    switchProvider,
    getMediaStream,
  }
}
