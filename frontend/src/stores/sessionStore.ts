import { create } from 'zustand'
import type {
  CorrectionIssue,
  RecordingState,
  TranscriptAskTurn,
  TranscriptCorrection,
  TranscriptMindMap,
  TranscriptPostProcess,
  TranscriptSegment,
  TranscriptSession,
  TranscriptSpeaker,
} from '../types'
import type { TranscriptToken } from '../types/asr'
import {
  askQuestionForSession,
  askQuestionForSessionStreaming,
  generateSessionBriefing,
  generateSessionMindMap as generateMindMapForSession,
  resolveModelForFeature,
} from '../services/aiPostProcess'
import {
  correctTranscriptQuick,
  correctTranscriptWithReview,
  detectCorrectionIssues,
} from '../services/aiCorrection'
import { sessionRepository } from '../utils/sessionRepository'
import { formatTime } from '../utils/storage'
import {
  buildRuntimeStateFromSession,
  createDraftSession,
  mergeSessionPostProcess,
} from '../utils/sessionLifecycle'
import {
  applySessionDeletion,
  applySessionMetadataUpdate,
  updateSessionInCollection,
} from '../utils/sessionMetadata'
import { resolveProviderMode } from '../utils/providerMetadata'
import {
  buildSessionSnapshot,
  buildSourceMeta,
  hasPersistenceSnapshotContent,
} from '../utils/sessionSnapshot'
import {
  applyTranscriptEvent as reduceTranscriptEvent,
  buildSegmentsFromTokens,
  buildSpeakersFromTokens,
  createEmptyTranscriptRuntimeState,
  resolveTranscriptRuntimeState,
  selectTranscriptRuntimeState,
  type TranscriptEvent,
} from '../utils/transcriptState'
import { useSettingsStore } from './settingsStore'
import { useUIStore } from './uiStore'
import { generateId } from '../utils/storageUtils'

const SESSION_AUTOSAVE_DELAY_MS = 1200
let sessionAutosaveTimer: ReturnType<typeof setTimeout> | null = null
const STALE_CORRECTION_ERROR = 'AI 纠错未完成，请重新启动纠错'

export interface RecordingArchiveRecoverySummary {
  recoveredCount: number
  linkedCount: number
  unlinkedCount: number
  skippedCount: number
}

function clearSessionAutosaveTimer(): void {
  if (sessionAutosaveTimer) {
    clearTimeout(sessionAutosaveTimer)
    sessionAutosaveTimer = null
  }
}

function getTranslationTargetLanguage(): string | undefined {
  const { settings } = useSettingsStore.getState()
  const currentVendor = settings.currentVendor || 'soniox'
  const providerConfig = settings.providerConfigs?.[currentVendor]
  const value = providerConfig?.translationTargetLanguage
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export interface SessionState {
  recordingState: RecordingState
  setRecordingState: (state: RecordingState) => void

  transcriptPrefix: string
  currentTranscript: string
  finalTranscript: string
  nonFinalTranscript: string
  currentTranslatedTranscript: string
  finalTranslatedTranscript: string
  nonFinalTranslatedTranscript: string
  currentSegments: TranscriptSegment[]
  currentSpeakers: TranscriptSpeaker[]
  currentPostProcess?: TranscriptPostProcess
  applyTranscriptEvent: (event: TranscriptEvent) => void
  updateCurrentSessionPostProcess: (patch: Partial<TranscriptPostProcess>) => void
  clearTranscript: () => void

  currentSessionId: string | null
  recoverySession: TranscriptSession | null
  currentCaptureMode: NonNullable<TranscriptSession['sourceMeta']>['captureMode']
  startNewSession: (options?: { captureMode?: NonNullable<TranscriptSession['sourceMeta']>['captureMode'] }) => string
  endCurrentSession: (options?: { sourceMetaPatch?: Partial<NonNullable<TranscriptSession['sourceMeta']>> }) => void
  restoreRecoverySession: () => void
  dismissRecoverySession: () => void

  sessions: TranscriptSession[]
  loadSessions: () => Promise<RecordingArchiveRecoverySummary | undefined>
  updateSessionTitle: (id: string, title: string) => void
  updateSessionSpeakers: (sessionId: string, speakers: TranscriptSpeaker[]) => void
  updateSessionPostProcess: (sessionId: string, patch: Partial<TranscriptPostProcess>) => void
  updateSessionMindMap: (sessionId: string, patch: Partial<TranscriptMindMap>) => void
  generateSessionMindMap: (sessionId: string) => Promise<TranscriptMindMap>
  askSessionQuestion: (
    sessionId: string,
    question: string,
    options?: { conversationId?: string },
  ) => Promise<TranscriptAskTurn>
  askSessionQuestionStreaming: (
    sessionId: string,
    question: string,
    options?: { conversationId?: string; signal?: AbortSignal },
  ) => Promise<void>
  generateSessionPostProcess: (
    sessionId: string,
    options?: { overwrite?: boolean },
  ) => Promise<TranscriptPostProcess>
  deleteSession: (id: string) => void
  deleteSessionConversation: (sessionId: string, conversationId: string) => void
  updateSessionTags: (sessionId: string, tagIds: string[]) => void
  updateSessionTopic: (sessionId: string, topicId: string | undefined) => void
  replaceAllSessions: (sessions: TranscriptSession[]) => TranscriptSession[]

  updateSessionCorrection: (sessionId: string, patch: Partial<TranscriptCorrection>) => void
  recoverStaleSessionCorrection: (sessionId: string) => void
  maybeAutoDetectSessionCorrection: (sessionId: string) => Promise<void>
  detectSessionCorrectionIssues: (sessionId: string) => Promise<CorrectionIssue[]>
  startSessionQuickCorrection: (
    sessionId: string,
    onChunk?: (text: string) => void,
  ) => Promise<string>
  startSessionReviewCorrection: (
    sessionId: string,
    acceptedIssues: CorrectionIssue[],
    onChunk?: (text: string) => void,
  ) => Promise<string>

  correctionStreamingText: Record<string, string>
  correctionInFlight: Record<string, true>
  clearCorrectionStreamingText: (sessionId: string) => void

  finalTokens: TranscriptToken[]
}

export const useSessionStore = create<SessionState>((set, get) => {
  const buildCurrentSessionSnapshot = (overrides?: {
    finalTokens?: TranscriptToken[]
    finalTranscript?: string
    nonFinalTranscript?: string
    currentTranscript?: string
    finalTranslatedTranscript?: string
    nonFinalTranslatedTranscript?: string
    currentTranslatedTranscript?: string
    currentPostProcess?: TranscriptPostProcess
    sourceMetaPatch?: Partial<NonNullable<TranscriptSession['sourceMeta']>>
  }) => {
    const state = resolveTranscriptRuntimeState(
      selectTranscriptRuntimeState(get()),
      overrides,
    )
    const providerId = useSettingsStore.getState().settings.currentVendor
    const captionDisplayMode = useSettingsStore.getState().settings.captionStyle?.displayMode ?? 'source'

    const snapshot = buildSessionSnapshot({
      runtimeState: {
        ...state,
        currentSegments: buildSegmentsFromTokens(state.finalTokens),
        currentSpeakers: buildSpeakersFromTokens(state.finalTokens),
      },
      providerId,
      providerMode: resolveProviderMode(providerId),
      platform: window.electronAPI?.platform ?? 'unknown',
      captureMode: get().currentCaptureMode || 'system-audio',
      translationTargetLanguage: getTranslationTargetLanguage(),
      captionDisplayMode,
    })

    return overrides?.sourceMetaPatch
      ? {
        ...snapshot,
        sourceMeta: {
          ...(snapshot.sourceMeta || {}),
          ...overrides.sourceMetaPatch,
        },
      }
      : snapshot
  }

  const syncCurrentSessionInMemory = (overrides?: {
    finalTokens?: TranscriptToken[]
    finalTranscript?: string
    nonFinalTranscript?: string
    currentTranscript?: string
    finalTranslatedTranscript?: string
    nonFinalTranslatedTranscript?: string
    currentTranslatedTranscript?: string
    currentPostProcess?: TranscriptPostProcess
  }) => {
    const state = get()
    if (!state.currentSessionId) return state.sessions

    const snapshot = buildCurrentSessionSnapshot(overrides)
    return updateSessionInCollection(state.sessions, state.currentSessionId, {
      transcript: snapshot.transcript,
      translatedTranscript: snapshot.translatedTranscript,
      tokens: snapshot.tokens,
      providerId: snapshot.providerId,
      speakers: snapshot.speakers,
      segments: snapshot.segments,
      sourceMeta: snapshot.sourceMeta,
      postProcess: snapshot.postProcess,
      status: 'recording',
    })
  }

  const scheduleCurrentSessionAutosave = () => {
    clearSessionAutosaveTimer()
    sessionAutosaveTimer = setTimeout(() => {
      const state = get()
      if (!state.currentSessionId) return

      const snapshot = buildCurrentSessionSnapshot()
      if (!hasPersistenceSnapshotContent(snapshot)) {
        return
      }

      const sessions = sessionRepository.saveProgress(state.currentSessionId, snapshot)
      set({ sessions })
    }, SESSION_AUTOSAVE_DELAY_MS)
  }

  const replaceSessionPostProcess = (
    sessionId: string,
    nextPostProcess: TranscriptPostProcess,
  ) => {
    const { currentSessionId, currentPostProcess, recoverySession } = get()
    const nextState = applySessionMetadataUpdate(
      get().sessions,
      sessionId,
      { postProcess: nextPostProcess },
      {
        currentSessionId,
        recoverySession,
        currentSpeakers: get().currentSpeakers,
        currentPostProcess,
      },
    )
    const sessions = sessionRepository.updateMetadata(sessionId, { postProcess: nextPostProcess })
    set({
      sessions,
      currentPostProcess: nextState.currentPostProcess,
      recoverySession: nextState.recoverySession,
    })
  }

  const replaceSessionAskHistory = (
    sessionId: string,
    askHistory: TranscriptAskTurn[],
  ) => {
    const { recoverySession } = get()
    const sessions = sessionRepository.updateMetadata(sessionId, { askHistory })
    set({
      sessions,
      recoverySession: recoverySession?.id === sessionId
        ? { ...recoverySession, askHistory }
        : recoverySession,
    })
  }

  const replaceSessionMindMap = (
    sessionId: string,
    mindMap: TranscriptMindMap,
  ) => {
    const { recoverySession } = get()
    const sessions = sessionRepository.updateMetadata(sessionId, { mindMap })
    set({
      sessions,
      recoverySession: recoverySession?.id === sessionId
        ? { ...recoverySession, mindMap }
        : recoverySession,
    })
  }

  const markCorrectionInFlight = (sessionId: string) => {
    set({ correctionInFlight: { ...get().correctionInFlight, [sessionId]: true } })
  }

  const clearCorrectionInFlight = (sessionId: string) => {
    const next = { ...get().correctionInFlight }
    delete next[sessionId]
    set({ correctionInFlight: next })
  }

  return {
    recordingState: 'idle',
    setRecordingState: (state) => set({ recordingState: state }),

    ...createEmptyTranscriptRuntimeState(),
    applyTranscriptEvent: (event) => {
      const nextTranscriptState = reduceTranscriptEvent(
        selectTranscriptRuntimeState(get()),
        event,
      )

      const sessions = syncCurrentSessionInMemory({
        finalTokens: nextTranscriptState.finalTokens,
        finalTranscript: nextTranscriptState.finalTranscript,
        nonFinalTranscript: nextTranscriptState.nonFinalTranscript,
        currentTranscript: nextTranscriptState.currentTranscript,
        finalTranslatedTranscript: nextTranscriptState.finalTranslatedTranscript,
        nonFinalTranslatedTranscript: nextTranscriptState.nonFinalTranslatedTranscript,
        currentTranslatedTranscript: nextTranscriptState.currentTranslatedTranscript,
        currentPostProcess: nextTranscriptState.currentPostProcess,
      })

      set({
        ...nextTranscriptState,
        sessions,
      })
      scheduleCurrentSessionAutosave()
    },
    updateCurrentSessionPostProcess: (patch) => {
      get().applyTranscriptEvent({ type: 'post-process', patch })
    },
    clearTranscript: () => {
      clearSessionAutosaveTimer()
      set({
        ...createEmptyTranscriptRuntimeState(),
      })
    },

    currentSessionId: null,
    recoverySession: null,
    currentCaptureMode: 'system-audio',
    startNewSession: (options) => {
      clearSessionAutosaveTimer()
      const now = Date.now()
      const { t } = useUIStore.getState()
      const { settings } = useSettingsStore.getState()
      const providerId = settings.currentVendor

      const session = createDraftSession({
        now,
        title: t.session.defaultTitle(formatTime(now)),
        providerId,
        sourceMeta: buildSourceMeta({
          providerId,
          providerMode: resolveProviderMode(providerId),
          platform: window.electronAPI?.platform ?? 'unknown',
          captureMode: options?.captureMode || 'system-audio',
        }),
      })

      const sessions = sessionRepository.createDraft(session)
      set({
        currentSessionId: session.id,
        currentCaptureMode: options?.captureMode || 'system-audio',
        sessions,
        ...createEmptyTranscriptRuntimeState(),
      })
      return session.id
    },
    endCurrentSession: (options) => {
      clearSessionAutosaveTimer()
      const { currentSessionId } = get()
      const snapshot = buildCurrentSessionSnapshot({ sourceMetaPatch: options?.sourceMetaPatch })
      const hasContent = hasPersistenceSnapshotContent(snapshot)

      if (currentSessionId && hasContent) {
        const sessions = sessionRepository.completeSession(currentSessionId, snapshot)
        set({ sessions })
        void get().maybeAutoDetectSessionCorrection(currentSessionId)
        console.log('[SessionStore] 会话已保存, 文本长度:', snapshot.transcript.length)
      } else if (currentSessionId) {
        const sessions = sessionRepository.deleteSession(currentSessionId)
        set({ sessions })
        console.log('[SessionStore] 空会话已丢弃:', currentSessionId)
      } else {
        console.log('[SessionStore] 会话未保存: currentSessionId=', currentSessionId)
      }
      set({ currentSessionId: null, currentCaptureMode: 'system-audio' })
    },
    restoreRecoverySession: () => {
      const { recoverySession } = get()
      if (!recoverySession) return

      const sessions = sessionRepository.acknowledgeInterrupted(recoverySession.id)
      set({
        recoverySession: null,
        sessions,
        currentSessionId: null,
        ...buildRuntimeStateFromSession(recoverySession),
      })
    },
    dismissRecoverySession: () => {
      const { recoverySession } = get()
      if (!recoverySession) return
      const sessions = sessionRepository.acknowledgeInterrupted(recoverySession.id)
      set({ recoverySession: null, sessions })
    },

    sessions: [],
    loadSessions: async () => {
      const { sessions, recoverableSession } = await sessionRepository.loadForLaunch()
      set({ sessions, recoverySession: recoverableSession })

      if (!window.electronAPI?.recoverRecordingArchives) return undefined

      try {
        const result = await window.electronAPI.recoverRecordingArchives()
        if (!result.ok) {
          console.warn('[SessionStore] 录音源音频恢复失败:', result.error)
          return {
            recoveredCount: 0,
            linkedCount: 0,
            unlinkedCount: 0,
            skippedCount: result.skipped?.length || 0,
          }
        }

        let linkedCount = 0
        let unlinkedCount = 0
        for (const archive of result.recovered) {
          if (!archive.sessionId || !archive.path) {
            unlinkedCount += 1
            continue
          }
          const session = get().sessions.find((item) => item.id === archive.sessionId)
          if (!session || session.sourceMeta?.audioPath) {
            unlinkedCount += 1
            continue
          }

          const sourceMeta = {
            ...(session.sourceMeta || {}),
            sourceKind: 'recording-audio' as const,
            audioPath: archive.path,
            audioMimeType: archive.mimeType || 'audio/wav',
            audioFileName: archive.fileName || 'source-audio.wav',
            audioSize: archive.size,
          }
          const nextSessions = sessionRepository.updateMetadata(session.id, { sourceMeta })
          const currentRecoverySession = get().recoverySession
          set({
            sessions: nextSessions,
            recoverySession: currentRecoverySession?.id === session.id
              ? { ...currentRecoverySession, sourceMeta }
              : currentRecoverySession,
          })
          linkedCount += 1
        }

        const summary = {
          recoveredCount: result.recovered.length,
          linkedCount,
          unlinkedCount,
          skippedCount: result.skipped?.length || 0,
        }
        return summary.recoveredCount > 0 || summary.skippedCount > 0 ? summary : undefined
      } catch (error) {
        console.warn('[SessionStore] 录音源音频恢复失败:', error)
        return {
          recoveredCount: 0,
          linkedCount: 0,
          unlinkedCount: 0,
          skippedCount: 0,
        }
      }
    },
    updateSessionTitle: (id, title) => {
      const { sessions, recoverySession, currentSessionId, currentSpeakers, currentPostProcess } = get()
      const nextSessions = sessionRepository.updateMetadata(id, { title })
      const nextState = applySessionMetadataUpdate(
        sessions,
        id,
        { title },
        {
          currentSessionId,
          recoverySession,
          currentSpeakers,
          currentPostProcess,
        },
      )
      set({
        sessions: nextSessions,
        recoverySession: nextState.recoverySession,
      })
    },
    updateSessionSpeakers: (sessionId, speakers) => {
      const { currentSessionId, currentSpeakers, recoverySession } = get()
      const nextState = applySessionMetadataUpdate(
        get().sessions,
        sessionId,
        { speakers },
        {
          currentSessionId,
          recoverySession,
          currentSpeakers,
          currentPostProcess: get().currentPostProcess,
        },
      )
      const sessions = sessionRepository.updateMetadata(sessionId, { speakers })
      set({
        sessions,
        currentSpeakers: nextState.currentSpeakers,
        recoverySession: nextState.recoverySession,
      })
    },
    updateSessionPostProcess: (sessionId, patch) => {
      const { currentSessionId, currentPostProcess, recoverySession } = get()
      const currentSession = get().sessions.find((session) => session.id === sessionId)
      const nextPostProcess = mergeSessionPostProcess(currentSession?.postProcess, patch)

      const nextState = applySessionMetadataUpdate(
        get().sessions,
        sessionId,
        { postProcess: nextPostProcess },
        {
          currentSessionId,
          recoverySession,
          currentSpeakers: get().currentSpeakers,
          currentPostProcess,
        },
      )
      const sessions = sessionRepository.updateMetadata(sessionId, { postProcess: nextPostProcess })
      set({
        sessions,
        currentPostProcess: nextState.currentPostProcess,
        recoverySession: nextState.recoverySession,
      })
    },
    updateSessionMindMap: (sessionId, patch) => {
      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session) return

      const nextMindMap: TranscriptMindMap = {
        markdown: '',
        ...(session.mindMap || {}),
        ...patch,
        updatedAt: patch.updatedAt ?? Date.now(),
      }
      replaceSessionMindMap(sessionId, nextMindMap)
    },
    generateSessionMindMap: async (sessionId) => {
      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session) {
        throw new Error('未找到要生成思维导图的会话')
      }

      const requestedAt = Date.now()
      get().updateSessionMindMap(sessionId, {
        status: 'pending',
        error: undefined,
        requestedAt,
      })

      try {
        const { mindMap } = await generateMindMapForSession(
          session,
          useSettingsStore.getState().settings,
        )
        const nextMindMap: TranscriptMindMap = {
          ...(session.mindMap || {}),
          ...mindMap,
          requestedAt,
          status: 'success',
          error: undefined,
          updatedAt: Date.now(),
        }
        replaceSessionMindMap(sessionId, nextMindMap)
        return nextMindMap
      } catch (error) {
        const message = error instanceof Error ? error.message : '思维导图生成失败'
        get().updateSessionMindMap(sessionId, {
          status: 'error',
          error: message,
          requestedAt,
          updatedAt: Date.now(),
        })
        throw error
      }
    },
    askSessionQuestion: async (sessionId, question, options) => {
      const normalizedQuestion = question.trim()
      if (!normalizedQuestion) {
        throw new Error('请输入问题')
      }

      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session) {
        throw new Error('未找到要提问的会话')
      }

      const conversationId = options?.conversationId?.trim() || 'default'
      const pendingTurn: TranscriptAskTurn = {
        id: generateId(),
        conversationId,
        question: normalizedQuestion,
        createdAt: Date.now(),
        status: 'pending',
      }

      replaceSessionAskHistory(sessionId, [...(session.askHistory || []), pendingTurn])

      try {
        const result = await askQuestionForSession(
          {
            ...session,
            askHistory: [...(session.askHistory || []), pendingTurn],
          },
          normalizedQuestion,
          useSettingsStore.getState().settings,
          { conversationId },
        )

        const latestSession = get().sessions.find((item) => item.id === sessionId)
        const nextTurn: TranscriptAskTurn = {
          ...pendingTurn,
          answer: result.answer,
          citations: result.citations,
          answeredAt: Date.now(),
          model: result.model,
          status: 'success',
          error: undefined,
        }
        const nextHistory = (latestSession?.askHistory || [pendingTurn]).map((turn) => (
          turn.id === pendingTurn.id ? nextTurn : turn
        ))
        replaceSessionAskHistory(sessionId, nextHistory)
        return nextTurn
      } catch (error) {
        const latestSession = get().sessions.find((item) => item.id === sessionId)
        const message = error instanceof Error ? error.message : '会话问答失败'
        const nextTurn: TranscriptAskTurn = {
          ...pendingTurn,
          answeredAt: Date.now(),
          status: 'error',
          error: message,
        }
        const nextHistory = (latestSession?.askHistory || [pendingTurn]).map((turn) => (
          turn.id === pendingTurn.id ? nextTurn : turn
        ))
        replaceSessionAskHistory(sessionId, nextHistory)
        throw error
      }
    },
    askSessionQuestionStreaming: async (sessionId, question, options) => {
      const normalizedQuestion = question.trim()
      if (!normalizedQuestion) throw new Error('请输入问题')

      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error('未找到要提问的会话')

      const conversationId = options?.conversationId?.trim() || 'default'
      const pendingTurn: TranscriptAskTurn = {
        id: generateId(),
        conversationId,
        question: normalizedQuestion,
        createdAt: Date.now(),
        status: 'pending',
      }

      replaceSessionAskHistory(sessionId, [...(session.askHistory || []), pendingTurn])

      const updateTurnAnswer = (partialAnswer: string) => {
        const latestSession = get().sessions.find((item) => item.id === sessionId)
        const nextHistory = (latestSession?.askHistory || [pendingTurn]).map((turn) =>
          turn.id === pendingTurn.id ? { ...turn, answer: partialAnswer } : turn,
        )
        replaceSessionAskHistory(sessionId, nextHistory)
      }

      await askQuestionForSessionStreaming(
        { ...session, askHistory: [...(session.askHistory || []), pendingTurn] },
        normalizedQuestion,
        useSettingsStore.getState().settings,
        {
          onChunk: (partialAnswer) => updateTurnAnswer(partialAnswer),
          onDone: (_fullAnswer, result) => {
            const latestSession = get().sessions.find((item) => item.id === sessionId)
            const nextTurn: TranscriptAskTurn = {
              ...pendingTurn,
              answer: result.answer,
              citations: result.citations,
              answeredAt: Date.now(),
              model: result.model,
              status: 'success',
            }
            const nextHistory = (latestSession?.askHistory || [pendingTurn]).map((turn) =>
              turn.id === pendingTurn.id ? nextTurn : turn,
            )
            replaceSessionAskHistory(sessionId, nextHistory)
          },
          onError: (error) => {
            const latestSession = get().sessions.find((item) => item.id === sessionId)
            const nextTurn: TranscriptAskTurn = {
              ...pendingTurn,
              answeredAt: Date.now(),
              status: 'error',
              error: error.message,
            }
            const nextHistory = (latestSession?.askHistory || [pendingTurn]).map((turn) =>
              turn.id === pendingTurn.id ? nextTurn : turn,
            )
            replaceSessionAskHistory(sessionId, nextHistory)
          },
        },
        { conversationId, signal: options?.signal },
      )
    },
    generateSessionPostProcess: async (sessionId, options) => {
      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session) {
        throw new Error('未找到要分析的会话')
      }

      const requestedAt = Date.now()
      get().updateSessionPostProcess(sessionId, {
        status: 'pending',
        error: undefined,
        requestedAt,
      })

      try {
        const { postProcess } = await generateSessionBriefing(
          session,
          useSettingsStore.getState().settings,
        )
        const nextPostProcess = options?.overwrite === false
          ? mergeSessionPostProcess(session.postProcess, {
            ...postProcess,
            status: 'success',
            error: undefined,
            requestedAt,
          })
          : {
            ...postProcess,
            status: 'success' as const,
            error: undefined,
            requestedAt,
          }

        replaceSessionPostProcess(sessionId, nextPostProcess)
        return nextPostProcess
      } catch (error) {
        const message = error instanceof Error ? error.message : 'AI 后处理失败'
        get().updateSessionPostProcess(sessionId, {
          status: 'error',
          error: message,
          requestedAt,
        })
        throw error
      }
    },
    deleteSession: (id) => {
      const { sessions: currentSessions, recoverySession } = get()
      const nextState = applySessionDeletion(currentSessions, id, recoverySession)
      const sessions = sessionRepository.deleteSession(id)
      set({
        sessions,
        recoverySession: nextState.recoverySession,
      })
    },
    deleteSessionConversation: (sessionId, conversationId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const nextHistory = (session.askHistory || []).filter(
        (turn) => (turn.conversationId || 'default') !== conversationId,
      )
      replaceSessionAskHistory(sessionId, nextHistory)
    },
    updateSessionTags: (sessionId, tagIds) => {
      const { sessions, recoverySession, currentSessionId, currentSpeakers, currentPostProcess } = get()
      const nextState = applySessionMetadataUpdate(
        sessions,
        sessionId,
        { tagIds },
        {
          currentSessionId,
          recoverySession,
          currentSpeakers,
          currentPostProcess,
        },
      )
      const nextSessions = sessionRepository.updateMetadata(sessionId, { tagIds })
      set({
        sessions: nextSessions,
        recoverySession: nextState.recoverySession,
      })
    },
    updateSessionTopic: (sessionId, topicId) => {
      const { sessions, recoverySession, currentSessionId, currentSpeakers, currentPostProcess } = get()
      const nextState = applySessionMetadataUpdate(
        sessions,
        sessionId,
        { topicId },
        {
          currentSessionId,
          recoverySession,
          currentSpeakers,
          currentPostProcess,
        },
      )
      const nextSessions = sessionRepository.updateMetadata(sessionId, { topicId })
      set({
        sessions: nextSessions,
        recoverySession: nextState.recoverySession,
      })
    },
    replaceAllSessions: (sessions) => {
      const persisted = sessionRepository.replaceAllSessions(sessions)
      set({ sessions: persisted })
      return persisted
    },

    correctionStreamingText: {},
    correctionInFlight: {},
    clearCorrectionStreamingText: (sessionId) => {
      const { correctionStreamingText } = get()
      if (sessionId in correctionStreamingText) {
        const next = { ...correctionStreamingText }
        delete next[sessionId]
        set({ correctionStreamingText: next })
      }
    },

    updateSessionCorrection: (sessionId, patch) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const nextCorrection: TranscriptCorrection = {
        status: 'idle',
        mode: 'quick',
        ...(session.correction || {}),
        ...patch,
      }
      const { recoverySession } = get()
      const sessions = sessionRepository.updateMetadata(sessionId, { correction: nextCorrection })
      set({
        sessions,
        recoverySession: recoverySession?.id === sessionId
          ? { ...recoverySession, correction: nextCorrection }
          : recoverySession,
      })
    },

    recoverStaleSessionCorrection: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      const status = session?.correction?.status
      if (status !== 'detecting' && status !== 'correcting') return
      if (get().correctionInFlight[sessionId]) return
      get().clearCorrectionStreamingText(sessionId)
      get().updateSessionCorrection(sessionId, {
        status: 'error',
        error: STALE_CORRECTION_ERROR,
      })
    },

    maybeAutoDetectSessionCorrection: async (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session?.transcript.trim()) return

      const settings = useSettingsStore.getState().settings
      const aiConfig = settings.aiPostProcess || {}
      if (!aiConfig.enabled || !aiConfig.autoCorrectionDetection) return
      if (!resolveModelForFeature(aiConfig, 'correction')) return
      if (get().correctionInFlight[sessionId]) return

      const status = session.correction?.status
      if (status === 'detecting' || status === 'reviewing' || status === 'correcting' || status === 'done') {
        return
      }

      try {
        await get().detectSessionCorrectionIssues(sessionId)
      } catch (error) {
        console.warn('[SessionStore] 自动 AI 纠错检测失败:', error)
      }
    },

    detectSessionCorrectionIssues: async (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) throw new Error('未找到要纠错的会话')

      markCorrectionInFlight(sessionId)

      get().updateSessionCorrection(sessionId, {
        status: 'detecting',
        error: undefined,
        requestedAt: Date.now(),
        mode: 'review',
      })

      try {
        const { issues, model } = await detectCorrectionIssues(
          session,
          useSettingsStore.getState().settings,
        )
        get().updateSessionCorrection(sessionId, {
          status: 'reviewing',
          issues,
          model,
        })
        return issues
      } catch (error) {
        const message = error instanceof Error ? error.message : '检测失败'
        get().updateSessionCorrection(sessionId, {
          status: 'error',
          error: message,
        })
        throw error
      } finally {
        clearCorrectionInFlight(sessionId)
      }
    },

    startSessionQuickCorrection: async (sessionId, onChunk) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) throw new Error('未找到要纠错的会话')

      const model = resolveModelForFeature(
        { ...useSettingsStore.getState().settings.aiPostProcess } as import('../types').AiPostProcessConfig,
        'correction',
      )

      set({ correctionStreamingText: { ...get().correctionStreamingText, [sessionId]: '' } })
      markCorrectionInFlight(sessionId)
      get().updateSessionCorrection(sessionId, {
        status: 'correcting',
        error: undefined,
        requestedAt: Date.now(),
        mode: 'quick',
        model,
      })

      return new Promise<string>((resolve, reject) => {
        correctTranscriptQuick(
          session,
          useSettingsStore.getState().settings,
          {
            onChunk: (chunk) => {
              const prev = get().correctionStreamingText[sessionId] || ''
              set({ correctionStreamingText: { ...get().correctionStreamingText, [sessionId]: prev + chunk } })
              onChunk?.(chunk)
            },
            onDone: (fullText) => {
              get().clearCorrectionStreamingText(sessionId)
              clearCorrectionInFlight(sessionId)
              get().updateSessionCorrection(sessionId, {
                status: 'done',
                correctedText: fullText,
                completedAt: Date.now(),
              })
              resolve(fullText)
            },
            onError: (err) => {
              get().clearCorrectionStreamingText(sessionId)
              clearCorrectionInFlight(sessionId)
              get().updateSessionCorrection(sessionId, {
                status: 'error',
                error: err.message,
              })
              reject(err)
            },
          },
        ).catch((err) => {
          get().clearCorrectionStreamingText(sessionId)
          clearCorrectionInFlight(sessionId)
          get().updateSessionCorrection(sessionId, {
            status: 'error',
            error: err instanceof Error ? err.message : '纠错失败',
          })
          reject(err)
        })
      })
    },

    startSessionReviewCorrection: async (sessionId, acceptedIssues, onChunk) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) throw new Error('未找到要纠错的会话')

      const model = resolveModelForFeature(
        { ...useSettingsStore.getState().settings.aiPostProcess } as import('../types').AiPostProcessConfig,
        'correction',
      )

      set({ correctionStreamingText: { ...get().correctionStreamingText, [sessionId]: '' } })
      markCorrectionInFlight(sessionId)
      get().updateSessionCorrection(sessionId, {
        status: 'correcting',
        error: undefined,
        requestedAt: Date.now(),
        mode: 'review',
        model,
        issues: session.correction?.issues?.map((issue) => {
          const acceptedIssue = acceptedIssues.find((accepted) => accepted.id === issue.id)
          return {
            ...issue,
            ...(acceptedIssue ? { suggestedText: acceptedIssue.suggestedText } : {}),
            accepted: Boolean(acceptedIssue),
          }
        }),
      })

      return new Promise<string>((resolve, reject) => {
        correctTranscriptWithReview(
          session,
          acceptedIssues,
          useSettingsStore.getState().settings,
          {
            onChunk: (chunk) => {
              const prev = get().correctionStreamingText[sessionId] || ''
              set({ correctionStreamingText: { ...get().correctionStreamingText, [sessionId]: prev + chunk } })
              onChunk?.(chunk)
            },
            onDone: (fullText) => {
              get().clearCorrectionStreamingText(sessionId)
              clearCorrectionInFlight(sessionId)
              get().updateSessionCorrection(sessionId, {
                status: 'done',
                correctedText: fullText,
                completedAt: Date.now(),
              })
              resolve(fullText)
            },
            onError: (err) => {
              get().clearCorrectionStreamingText(sessionId)
              clearCorrectionInFlight(sessionId)
              get().updateSessionCorrection(sessionId, {
                status: 'error',
                error: err.message,
              })
              reject(err)
            },
          },
        ).catch((err) => {
          get().clearCorrectionStreamingText(sessionId)
          clearCorrectionInFlight(sessionId)
          get().updateSessionCorrection(sessionId, {
            status: 'error',
            error: err instanceof Error ? err.message : '纠错失败',
          })
          reject(err)
        })
      })
    },
  }
})
