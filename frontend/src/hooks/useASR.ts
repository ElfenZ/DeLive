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
import { ProviderSessionManager, type ProviderSetup } from '../services/providerSession'
import type { ASRVendor, ProviderConfig } from '../types/asr'
import type { MeetingContextOverride, ProviderConfigData, TranscriptSourceMeta } from '../types'
import { buildPcmWavBlob } from '../utils/pcmWav'
import { AudioProcessor } from '../utils/audioProcessor'
import { readRecordingElapsedMs } from '../utils/recordingTimeline'
import { resolveMeetingContextSnapshot } from '../utils/meetingContext'

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
  const stopRecordingRef = useRef<() => Promise<string | null>>(async () => null)
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
  const sourceAudioArchiveGenerationRef = useRef(0)
  const sourceAudioArchiveFallbackRef = useRef(false)
  const captureDeliveryEnabledRef = useRef(false)
  const archiveDeliveryEnabledRef = useRef(false)
  const lockedProviderRef = useRef<{
    vendorId: ASRVendor
    setup: ProviderSetup
  } | null>(null)

  const { settings } = useSettingsStore()
  const {
    applyTranscriptEvent,
    setRecordingState,
    transitionRecordingState,
    resetRecordingTimeline,
    startRecordingTimeline,
    pauseRecordingTimeline,
    resumeRecordingTimeline,
    finalizeRecordingTimeline,
    setCurrentCaptureMode,
    startNewSession,
    endCurrentSession,
  } = useSessionStore()

  const lockProviderSetup = useCallback((vendorId: ASRVendor, setup: ProviderSetup) => {
    const meetingContext = structuredClone(setup.meetingContext)
    const connectConfig: ProviderConfig = structuredClone(setup.connectConfig)
    if (vendorId === 'soniox') connectConfig.meetingContext = meetingContext
    lockedProviderRef.current = {
      vendorId,
      setup: {
        ...setup,
        connectConfig,
        meetingContext,
        recognitionConfig: structuredClone(setup.recognitionConfig),
      },
    }
  }, [])

  const getConnectionEpochOffset = useCallback(() => {
    const store = useSessionStore.getState()
    return Math.max(
      readRecordingElapsedMs(store.recordingTimeline, Date.now()),
      providerSessionRef.current.getMaxConfirmedTokenEndMs(),
    )
  }, [])

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
        if (sourceAudioArchiveSessionIdRef.current !== sessionId) return
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
    sourceAudioArchiveGenerationRef.current += 1
    sourceAudioProcessorRef.current?.stop()
    sourceAudioProcessorRef.current = null
    clearSourceAudioFlushTimer()
    sourceAudioChunksRef.current = []
    sourceAudioMimeTypeRef.current = 'audio/wav'
    sourceAudioArchiveActiveRef.current = false
    sourceAudioArchiveSessionIdRef.current = null
    sourceAudioAppendQueueRef.current = Promise.resolve()
    sourceAudioArchiveFailedRef.current = false
    sourceAudioArchiveFallbackRef.current = false
    captureDeliveryEnabledRef.current = false
    archiveDeliveryEnabledRef.current = false
    sourceAudioPendingChunksRef.current = []
    sourceAudioPendingBytesRef.current = 0
  }, [clearSourceAudioFlushTimer])

  const stopSourceAudioArchive = useCallback(() => {
    sourceAudioArchiveGenerationRef.current += 1
    if (sourceAudioProcessorRef.current) {
      sourceAudioProcessorRef.current.stop()
      sourceAudioProcessorRef.current = null
    }
    clearSourceAudioFlushTimer()
    sourceAudioArchiveActiveRef.current = false
  }, [clearSourceAudioFlushTimer])

  const pauseSourceAudioArchive = useCallback(async (): Promise<void> => {
    const sessionId = sourceAudioArchiveSessionIdRef.current
    stopSourceAudioArchive()
    if (!sessionId) return

    try {
      await flushBufferedSourceAudio(sessionId)
      await sourceAudioAppendQueueRef.current
    } catch (error) {
      sourceAudioArchiveFailedRef.current = true
      console.warn('[useASR] 暂停录音源音频归档时冲刷失败:', error)
      options.onWarning?.('录音源音频暂停冲刷失败，转录文本已保留')
    }
  }, [flushBufferedSourceAudio, options, stopSourceAudioArchive])

  const abortSourceAudioArchive = useCallback(async (): Promise<void> => {
    const sessionId = sourceAudioArchiveSessionIdRef.current
    const appendQueue = sourceAudioAppendQueueRef.current
    stopSourceAudioArchive()
    sourceAudioPendingChunksRef.current = []
    sourceAudioPendingBytesRef.current = 0
    sourceAudioArchiveSessionIdRef.current = null
    await appendQueue
    if (sessionId) {
      try {
        const result = await window.electronAPI?.abortRecordingArchive?.({ sessionId })
        if (result && !result.ok) {
          console.warn('[useASR] 放弃录音源音频归档失败:', result.error)
        }
      } catch (error) {
        console.warn('[useASR] 放弃录音源音频归档失败:', error)
      }
    }
    sourceAudioAppendQueueRef.current = Promise.resolve()
  }, [stopSourceAudioArchive])

  const startSourceAudioArchive = useCallback(async (sessionId: string, stream: MediaStream): Promise<boolean> => {
    if (sourceAudioArchiveFallbackRef.current) return false
    if (sourceAudioArchiveActiveRef.current
      && sourceAudioArchiveSessionIdRef.current === sessionId) {
      return true
    }
    stopSourceAudioArchive()
    if (!window.electronAPI?.beginRecordingArchive || !window.electronAPI.appendRecordingArchive) {
      sourceAudioArchiveFallbackRef.current = true
      return false
    }

    const resumingExistingArchive = sourceAudioArchiveSessionIdRef.current === sessionId
    const processor = new AudioProcessor({ sampleRate: 16000, channels: 1, muted: true })
    const generation = sourceAudioArchiveGenerationRef.current

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
        // Set the guard before AudioProcessor.start() awaits AudioWorklet setup.
        // Resume must append to this run instead of truncating it with begin().
        sourceAudioArchiveSessionIdRef.current = sessionId
      }

      sourceAudioProcessorRef.current = processor
      sourceAudioArchiveActiveRef.current = true
      await processor.start(stream, (pcmData) => {
        if (sourceAudioArchiveGenerationRef.current !== generation
          || sourceAudioArchiveSessionIdRef.current !== sessionId
          || !sourceAudioArchiveActiveRef.current
          || !archiveDeliveryEnabledRef.current) {
          return
        }
        const chunk = pcmData.slice(0)
        sourceAudioPendingChunksRef.current.push(chunk)
        sourceAudioPendingBytesRef.current += chunk.byteLength
        if (sourceAudioPendingBytesRef.current >= SOURCE_AUDIO_FLUSH_BYTES) {
          void flushBufferedSourceAudio(sessionId)
        } else {
          scheduleBufferedSourceAudioFlush(sessionId)
        }
      })
      if (sourceAudioArchiveGenerationRef.current !== generation
        || sourceAudioArchiveSessionIdRef.current !== sessionId
        || !sourceAudioArchiveActiveRef.current) {
        processor.stop()
        return false
      }
      sourceAudioProcessorRef.current = processor
      sourceAudioMimeTypeRef.current = 'audio/wav'
      sourceAudioArchiveActiveRef.current = true
      return true
    } catch (error) {
      console.warn('[useASR] 录音源音频 WAV 归档启动失败，回退到 provider 原始格式:', error)
      processor.stop()
      if (sourceAudioArchiveGenerationRef.current === generation) {
        sourceAudioProcessorRef.current = null
        sourceAudioArchiveActiveRef.current = false
      }
      if (!resumingExistingArchive) {
        await abortSourceAudioArchive()
        sourceAudioArchiveFallbackRef.current = true
      }
      return false
    }
  }, [abortSourceAudioArchive, flushBufferedSourceAudio, scheduleBufferedSourceAudioFlush, stopSourceAudioArchive])

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

    if (incrementalSessionId
      && !sourceAudioArchiveFallbackRef.current
      && window.electronAPI?.finalizeRecordingArchive) {
      try {
        await flushBufferedSourceAudio(incrementalSessionId)
        await sourceAudioAppendQueueRef.current
        const result = await window.electronAPI.finalizeRecordingArchive({
          sessionId: incrementalSessionId,
          fileName: 'source-audio.wav',
        })

        if (result.ok && result.path) {
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
        }
        options.onWarning?.(result.error || '录音源音频增量归档失败，正在尝试回退格式')
      } catch (error) {
        console.warn('[useASR] 完成录音源音频归档失败:', error)
        options.onWarning?.('录音源音频增量归档失败，正在尝试回退格式')
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

  const freezeTranscriptBoundary = useCallback((promoteInterim: boolean) => {
    const before = useSessionStore.getState()
    const hasVisibleInterim = Boolean(
      before.nonFinalTranscript
      || before.nonFinalTranslatedTranscript
      || before.nonFinalTokens.length,
    )
    applyTranscriptEvent({
      type: 'pause-boundary',
      promoteInterim: promoteInterim || hasVisibleInterim,
    })
    const state = useSessionStore.getState()
    captionRef.current.update(
      state.finalTranscript,
      '',
      state.finalTranslatedTranscript,
      '',
    )
  }, [applyTranscriptEvent])

  // ── 停止录制 ──────────────────────────────────────

  const stopRecording = useCallback(async (): Promise<string | null> => {
    const initialState = useSessionStore.getState().recordingState
    if (initialState !== 'recording' && initialState !== 'paused') {
      return null
    }
    if (!transitionRecordingState('stopping')) {
      return null
    }

    console.log('[useASR] 停止录制...')
    const stopStartedAt = Date.now()
    archiveDeliveryEnabledRef.current = false
    const sessionId = useSessionStore.getState().currentSessionId
    const captureMode = captureRef.current.currentCaptureMode
    let sourceMetaPatch: Partial<TranscriptSourceMeta> | undefined
    let completedSessionId: string | null = null

    try {
      if (initialState === 'recording') {
        await captureRef.current.pauseCapture()
        captureDeliveryEnabledRef.current = false
        await pauseSourceAudioArchive()
        const drainResult = await providerSessionRef.current.drain()
        freezeTranscriptBoundary(drainResult.status !== 'finished')
      }
      const duration = finalizeRecordingTimeline(stopStartedAt)
      sourceMetaPatch = await finalizeSourceAudioArchive(sessionId, captureMode)
      captureRef.current.stop()
      await providerSessionRef.current.disconnect()
      completedSessionId = endCurrentSession({ sourceMetaPatch, duration })
    } finally {
      captureRef.current.stop()
      await providerSessionRef.current.disconnect()
      captionRef.current.clear()
      microphoneWarningShownRef.current = false
      activeCaptureAudioOptionsRef.current = null

      selectedVendorRef.current = null
      lockedProviderRef.current = null
      if (useSessionStore.getState().currentSessionId) {
        const duration = finalizeRecordingTimeline(stopStartedAt)
        completedSessionId = endCurrentSession({ sourceMetaPatch, duration })
      }
      if (!completedSessionId) {
        await abortSourceAudioArchive()
      }
      resetSourceAudioArchive()
      providerSessionRef.current.resetTimestampTracking()
      if (!transitionRecordingState('idle')) {
        setRecordingState('idle')
      }
      console.log('[useASR] 录制已停止')
    }
    return completedSessionId
  }, [
    endCurrentSession,
    abortSourceAudioArchive,
    finalizeRecordingTimeline,
    finalizeSourceAudioArchive,
    freezeTranscriptBoundary,
    pauseSourceAudioArchive,
    resetSourceAudioArchive,
    setRecordingState,
    transitionRecordingState,
  ])

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
      if (currentState === 'switching'
        || currentState === 'pausing'
        || currentState === 'paused'
        || currentState === 'resuming'
        || currentState === 'stopping') {
        console.warn('[useASR] 生命周期切换中收到 Provider 错误（忽略）:', error.code, error.message)
        return
      }
      options.onError?.(`${error.code}: ${error.message}`)
      if (currentState === 'recording') {
        void stopRecordingRef.current()
      }
    },

    onFinished() {
      options.onFinished?.()
    },
  }), [applyTranscriptEvent, options])

  const pauseRecording = useCallback(async (): Promise<void> => {
    if (!transitionRecordingState('pausing')) return

    const pauseStartedAt = Date.now()
    archiveDeliveryEnabledRef.current = false
    console.log('[useASR] 暂停录制...')
    try {
      await captureRef.current.pauseCapture()
      captureDeliveryEnabledRef.current = false
      await pauseSourceAudioArchive()
      const drainResult = await providerSessionRef.current.drain()
      freezeTranscriptBoundary(drainResult.status !== 'finished')
      pauseRecordingTimeline(pauseStartedAt)
      if (!transitionRecordingState('paused')) {
        setRecordingState('paused')
      }
      console.log('[useASR] 录制已暂停')
    } catch (error) {
      console.warn('[useASR] 暂停录制时发生错误，保留已捕获内容:', error)
      captureDeliveryEnabledRef.current = false
      archiveDeliveryEnabledRef.current = false
      await pauseSourceAudioArchive()
      await providerSessionRef.current.disconnect()
      freezeTranscriptBoundary(true)
      pauseRecordingTimeline(pauseStartedAt)
      setRecordingState('paused')
      options.onWarning?.('暂停收尾未完整完成，当前可见文本和录音已保留')
    }
  }, [
    freezeTranscriptBoundary,
    options,
    pauseRecordingTimeline,
    pauseSourceAudioArchive,
    setRecordingState,
    transitionRecordingState,
  ])

  const resumeRecording = useCallback(async (): Promise<void> => {
    if (!transitionRecordingState('resuming')) return
    captureDeliveryEnabledRef.current = false
    archiveDeliveryEnabledRef.current = false

    const locked = lockedProviderRef.current
    const sessionId = useSessionStore.getState().currentSessionId
    if (!locked || !sessionId) {
      setRecordingState('paused')
      options.onError?.('无法恢复录制：录制会话信息已失效')
      return
    }

    const capture = captureRef.current
    let providerConnected = false
    try {
      if (!capture.isRetainedStreamHealthy()) {
        options.onWarning?.(useUIStore.getState().t.recording.sourceUnavailable)
        capture.clearInvalidSource()
        await window.electronAPI?.prepareSourceCapture?.('prompt')
        const audioOptions = activeCaptureAudioOptionsRef.current || buildCaptureAudioOptions()
        await capture.acquireStream(audioOptions)
        setCurrentCaptureMode(capture.currentCaptureMode)
      }

      const epochOffsetMs = getConnectionEpochOffset()
      await providerSessionRef.current.connect(
        locked.vendorId,
        locked.setup.connectConfig,
        buildProviderCallbacks(),
        { epochOffsetMs },
      )
      providerConnected = true

      const stream = capture.currentStream
      if (!stream) throw new Error('录制源不可用')
      const requiresIncrementalArchive = sourceAudioArchiveSessionIdRef.current === sessionId
        && !sourceAudioArchiveFallbackRef.current
      const archiveStarted = await startSourceAudioArchive(sessionId, stream)
      if (requiresIncrementalArchive && !archiveStarted) {
        throw new Error('录音源音频归档恢复失败')
      }
      await capture.resumeCapture(locked.setup.providerInfo.capabilities)

      resumeRecordingTimeline(Date.now())
      captureDeliveryEnabledRef.current = true
      archiveDeliveryEnabledRef.current = true
      if (!transitionRecordingState('recording')) {
        setRecordingState('recording')
      }
      console.log('[useASR] 录制已恢复')
    } catch (error) {
      console.warn('[useASR] 恢复录制失败:', error)
      captureDeliveryEnabledRef.current = false
      archiveDeliveryEnabledRef.current = false
      try {
        await capture.pauseCapture()
      } catch {
        // The capture may still be fully paused from before this resume attempt.
      }
      await pauseSourceAudioArchive()
      if (providerConnected || providerSessionRef.current.currentProvider) {
        await providerSessionRef.current.disconnect()
      }
      setRecordingState('paused')
      const t = useUIStore.getState().t
      const cancelled = error instanceof Error
        && (error.name === 'NotAllowedError' || error.name === 'AbortError')
      if (cancelled) {
        options.onWarning?.(t.recording.resumeCancelled)
      } else {
        options.onError?.(t.recording.resumeFailed)
      }
    }
  }, [
    buildCaptureAudioOptions,
    buildProviderCallbacks,
    getConnectionEpochOffset,
    options,
    pauseSourceAudioArchive,
    resumeRecordingTimeline,
    setCurrentCaptureMode,
    setRecordingState,
    startSourceAudioArchive,
    transitionRecordingState,
  ])

  // ── 设备变化后自动重启采集 ─────────────────────────

  const restartCapture = useCallback(async () => {
    if (isRestartingRef.current) return
    const now = Date.now()
    if (now - lastRestartTimeRef.current < 10_000) return
    const vendorId = selectedVendorRef.current
    if (!vendorId) return
    if (!transitionRecordingState('switching')) return

    console.log('[useASR] 音频设备变化，自动重新采集')
    isRestartingRef.current = true
    lastRestartTimeRef.current = now

    try {
      const psm = providerSessionRef.current
      const locked = lockedProviderRef.current
      if (!locked || locked.vendorId !== vendorId) throw new Error('录制配置快照已失效')
      const setup = locked.setup
      const needReconnect = setup.captureRestartStrategy === 'reconnect-session'
      const capture = captureRef.current
      const audioOptions = activeCaptureAudioOptionsRef.current || buildCaptureAudioOptions()

      archiveDeliveryEnabledRef.current = false
      await capture.pauseCapture()
      captureDeliveryEnabledRef.current = false
      await pauseSourceAudioArchive()
      if (needReconnect) {
        const drainResult = await psm.drain()
        freezeTranscriptBoundary(drainResult.status !== 'finished')
      }
      await window.electronAPI?.prepareSourceCapture?.('reuse-if-available')

      const stream = await capture.restartStreamOnly(audioOptions)
      setCurrentCaptureMode(capture.currentCaptureMode)
      const sessionId = useSessionStore.getState().currentSessionId
      if (needReconnect) {
        await psm.connect(
          vendorId,
          setup.connectConfig,
          buildProviderCallbacks(),
          { epochOffsetMs: getConnectionEpochOffset() },
        )
      } else if (!psm.currentProvider) {
        await psm.connect(vendorId, setup.connectConfig, buildProviderCallbacks())
      }
      if (sessionId) {
        const requiresIncrementalArchive = sourceAudioArchiveSessionIdRef.current === sessionId
          && !sourceAudioArchiveFallbackRef.current
        const archiveStarted = await startSourceAudioArchive(sessionId, stream)
        if (requiresIncrementalArchive && !archiveStarted) {
          throw new Error('录音源音频归档重启失败')
        }
      }
      await capture.resumeCapture(setup.providerInfo.capabilities)
      capture.finishRestart()
      captureDeliveryEnabledRef.current = true
      archiveDeliveryEnabledRef.current = true
      if (!transitionRecordingState('recording')) setRecordingState('recording')

      console.log('[useASR] 音频重新采集成功')
    } catch (error) {
      console.error('[useASR] 音频重新采集失败:', error)
      transitionRecordingState('stopping')
      captureRef.current.finishRestart()
      await pauseSourceAudioArchive()
      const sessionId = useSessionStore.getState().currentSessionId
      const captureMode = captureRef.current.currentCaptureMode
      captureRef.current.stop()
      await providerSessionRef.current.disconnect()
      const sourceMetaPatch = await finalizeSourceAudioArchive(sessionId, captureMode)
      const duration = finalizeRecordingTimeline(Date.now())
      endCurrentSession({ sourceMetaPatch, duration })
      resetSourceAudioArchive()
      selectedVendorRef.current = null
      lockedProviderRef.current = null
      providerSessionRef.current.resetTimestampTracking()
      activeCaptureAudioOptionsRef.current = null
      microphoneWarningShownRef.current = false
      if (!transitionRecordingState('idle')) setRecordingState('idle')
      options.onError?.('音频设备切换后重新捕获失败，录制已停止')
    } finally {
      isRestartingRef.current = false
    }
  }, [
    buildCaptureAudioOptions,
    buildProviderCallbacks,
    endCurrentSession,
    finalizeRecordingTimeline,
    finalizeSourceAudioArchive,
    freezeTranscriptBoundary,
    getConnectionEpochOffset,
    options,
    pauseSourceAudioArchive,
    resetSourceAudioArchive,
    setCurrentCaptureMode,
    setRecordingState,
    startSourceAudioArchive,
    transitionRecordingState,
  ])

  // ── 开始录制 ──────────────────────────────────────

  const startRecording = useCallback(async (meetingContextOverride?: MeetingContextOverride) => {
    if (!transitionRecordingState('starting')) return
    resetRecordingTimeline()

    const vendorId = (settings.currentVendor || 'soniox') as ASRVendor
    const psm = providerSessionRef.current

    let setup: ReturnType<typeof psm.resolveSetup>
    try {
      const meetingContext = resolveMeetingContextSnapshot(
        settings.meetingContext,
        settings.aiPostProcess?.glossary,
        meetingContextOverride,
      )
      setup = psm.resolveSetup(vendorId, settings, meetingContext)
    } catch (e) {
      transitionRecordingState('idle')
      options.onError?.((e as Error).message)
      return
    }

    captionRef.current.clear()
    resetSourceAudioArchive()
    psm.resetTimestampTracking()
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
      await window.electronAPI?.prepareSourceCapture?.('prompt')
      acquiredStream = await capture.acquireStream(audioOptions)
    } catch (error) {
      stopSourceAudioArchive()
      if (!transitionRecordingState('idle')) setRecordingState('idle')
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

    // Phase 2: Prepare archive output behind a closed gate, connect the
    // provider, start capture, then open both gates at the timeline boundary.
    let sessionId: string | null = null
    try {
      sessionId = startNewSession({
        captureMode: capture.currentCaptureMode,
        providerId: vendorId,
        meetingContext: setup.meetingContext,
        recognitionConfig: setup.recognitionConfig,
      })
      await startSourceAudioArchive(sessionId, acquiredStream)

      const providerCallbacks = buildProviderCallbacks()
      await psm.connect(vendorId, setup.connectConfig, providerCallbacks, { epochOffsetMs: 0 })

      await capture.startWithStream(
        setup.providerInfo.capabilities,
        {
          onAudioData: (data) => {
            if (!captureDeliveryEnabledRef.current) return
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

      selectedVendorRef.current = vendorId
      lockProviderSetup(vendorId, setup)
      startRecordingTimeline(Date.now())
      captureDeliveryEnabledRef.current = true
      archiveDeliveryEnabledRef.current = true
      if (!transitionRecordingState('recording')) setRecordingState('recording')

      const activeTopicId = useTopicStore.getState().activeTopicId
      if (activeTopicId) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid) useSessionStore.getState().updateSessionTopic(sid, activeTopicId)
      }

      options.onStarted?.()
      console.log('[useASR] 录制已开始')
    } catch (error) {
      console.error('[useASR] 启动失败:', error)
      await abortSourceAudioArchive()
      capture.stop()
      await providerSessionRef.current.disconnect()
      if (useSessionStore.getState().currentSessionId) {
        endCurrentSession({ duration: finalizeRecordingTimeline(Date.now()) })
      }
      resetSourceAudioArchive()
      lockedProviderRef.current = null
      selectedVendorRef.current = null
      psm.resetTimestampTracking()
      if (!transitionRecordingState('idle')) setRecordingState('idle')

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
    transitionRecordingState,
    startRecordingTimeline,
    finalizeRecordingTimeline,
    startNewSession,
    endCurrentSession,
    options,
    buildCaptureAudioOptions,
    buildProviderCallbacks,
    appendSourceAudioChunk,
    abortSourceAudioArchive,
    lockProviderSetup,
    resetSourceAudioArchive,
    resetRecordingTimeline,
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
      if (!transitionRecordingState('switching')) return

      useSettingsStore.getState().updateProviderConfig(vendorId, configPatch)

      const newSettings = useSettingsStore.getState().settings
      const psm = providerSessionRef.current
      const setup = psm.resolveSetup(vendorId, newSettings, lockedProviderRef.current?.setup.meetingContext)

      await captureRef.current.pauseCapture()
      const drainResult = await psm.drain()
      freezeTranscriptBoundary(drainResult.status !== 'finished')
      applyTranscriptEvent({ type: 'config-change', description: changeDescription })
      await psm.connect(
        vendorId,
        setup.connectConfig,
        buildProviderCallbacks(),
        { epochOffsetMs: getConnectionEpochOffset() },
      )
      await captureRef.current.resumeCapture(setup.providerInfo.capabilities)
      lockProviderSetup(vendorId, setup)

      if (!transitionRecordingState('recording')) setRecordingState('recording')
      console.log('[useASR] 配置热切换成功:', changeDescription)
    } catch (error) {
      console.error('[useASR] 配置热切换失败:', error)

      if (previousConfig) {
        useSettingsStore.getState().updateProviderConfig(vendorId, previousConfig)
      }

      try {
        const fallbackSettings = useSettingsStore.getState().settings
        const psm = providerSessionRef.current
        const fallbackSetup = psm.resolveSetup(vendorId, fallbackSettings, lockedProviderRef.current?.setup.meetingContext)

        await captureRef.current.pauseCapture()
        await psm.disconnect()
        await psm.connect(
          vendorId,
          fallbackSetup.connectConfig,
          buildProviderCallbacks(),
          { epochOffsetMs: getConnectionEpochOffset() },
        )
        await captureRef.current.resumeCapture(fallbackSetup.providerInfo.capabilities)
        lockProviderSetup(vendorId, fallbackSetup)

        if (!transitionRecordingState('recording')) setRecordingState('recording')
        options.onError?.('配置切换失败，已恢复之前的配置')
      } catch {
        await pauseSourceAudioArchive()
        const sessionId = useSessionStore.getState().currentSessionId
        const captureMode = captureRef.current.currentCaptureMode
        captureRef.current.stop()
        await providerSessionRef.current.disconnect()
        const duration = finalizeRecordingTimeline(Date.now())
        const sourceMetaPatch = await finalizeSourceAudioArchive(sessionId, captureMode)
        endCurrentSession({ sourceMetaPatch, duration })
        resetSourceAudioArchive()
        selectedVendorRef.current = null
        lockedProviderRef.current = null
        activeCaptureAudioOptionsRef.current = null
        microphoneWarningShownRef.current = false
        if (!transitionRecordingState('idle')) setRecordingState('idle')
        options.onError?.('配置切换失败且无法恢复，录制已停止')
      }
    }
  }, [
    applyTranscriptEvent,
    buildProviderCallbacks,
    endCurrentSession,
    finalizeRecordingTimeline,
    finalizeSourceAudioArchive,
    freezeTranscriptBoundary,
    getConnectionEpochOffset,
    lockProviderSetup,
    options,
    pauseSourceAudioArchive,
    resetSourceAudioArchive,
    setRecordingState,
    transitionRecordingState,
  ])

  const switchProvider = useCallback(async (newVendorId: ASRVendor) => {
    const oldVendorId = selectedVendorRef.current
    if (!oldVendorId || oldVendorId === newVendorId) return
    const currentState = useSessionStore.getState().recordingState
    if (currentState !== 'recording') return

    const psm = providerSessionRef.current

    let newSetup: ReturnType<typeof psm.resolveSetup>
    try {
      newSetup = psm.resolveSetup(
        newVendorId,
        useSettingsStore.getState().settings,
        lockedProviderRef.current?.setup.meetingContext,
      )
    } catch (e) {
      options.onError?.((e as Error).message)
      return
    }

    try {
      if (!transitionRecordingState('switching')) return

      const oldName = oldVendorId
      const newName = newVendorId
      await captureRef.current.pauseCapture()
      const drainResult = await psm.drain()
      freezeTranscriptBoundary(drainResult.status !== 'finished')
      applyTranscriptEvent({
        type: 'config-change',
        description: `Provider: ${oldName} → ${newName}`,
      })
      await psm.connect(
        newVendorId,
        newSetup.connectConfig,
        buildProviderCallbacks(),
        { epochOffsetMs: getConnectionEpochOffset() },
      )

      await captureRef.current.resumeCapture(newSetup.providerInfo.capabilities)

      useSettingsStore.getState().setCurrentVendor(newVendorId)
      selectedVendorRef.current = newVendorId
      lockProviderSetup(newVendorId, newSetup)

      if (!transitionRecordingState('recording')) setRecordingState('recording')
      console.log(`[useASR] Provider 热切换成功: ${oldName} → ${newName}`)
    } catch (error) {
      console.error('[useASR] Provider 热切换失败:', error)

      try {
        const fallbackSettings = useSettingsStore.getState().settings
        const fallbackSetup = psm.resolveSetup(
          oldVendorId,
          fallbackSettings,
          lockedProviderRef.current?.setup.meetingContext,
        )

        await captureRef.current.pauseCapture()
        await psm.disconnect()
        await psm.connect(
          oldVendorId,
          fallbackSetup.connectConfig,
          buildProviderCallbacks(),
          { epochOffsetMs: getConnectionEpochOffset() },
        )
        await captureRef.current.resumeCapture(fallbackSetup.providerInfo.capabilities)

        selectedVendorRef.current = oldVendorId
        lockProviderSetup(oldVendorId, fallbackSetup)
        if (!transitionRecordingState('recording')) setRecordingState('recording')
        options.onError?.('Provider 切换失败，已恢复之前的配置')
      } catch {
        await pauseSourceAudioArchive()
        const sessionId = useSessionStore.getState().currentSessionId
        const captureMode = captureRef.current.currentCaptureMode
        captureRef.current.stop()
        await providerSessionRef.current.disconnect()
        const duration = finalizeRecordingTimeline(Date.now())
        const sourceMetaPatch = await finalizeSourceAudioArchive(sessionId, captureMode)
        endCurrentSession({ sourceMetaPatch, duration })
        resetSourceAudioArchive()
        selectedVendorRef.current = null
        lockedProviderRef.current = null
        activeCaptureAudioOptionsRef.current = null
        microphoneWarningShownRef.current = false
        if (!transitionRecordingState('idle')) setRecordingState('idle')
        options.onError?.('Provider 切换失败且无法恢复，录制已停止')
      }
    }
  }, [
    applyTranscriptEvent,
    buildProviderCallbacks,
    endCurrentSession,
    finalizeRecordingTimeline,
    finalizeSourceAudioArchive,
    freezeTranscriptBoundary,
    getConnectionEpochOffset,
    lockProviderSetup,
    options,
    pauseSourceAudioArchive,
    resetSourceAudioArchive,
    setRecordingState,
    transitionRecordingState,
  ])

  const getMediaStream = useCallback(() => captureRef.current.currentStream, [])

  return {
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    switchConfig,
    switchProvider,
    getMediaStream,
  }
}
