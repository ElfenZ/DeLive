import { create } from 'zustand'
import type {
  CorrectionIssue,
  CorrectionEditExpectation,
  CorrectionShardProgress,
  MeetingContextSnapshot,
  ManualCorrectionEdit,
  RecognitionConfigSnapshot,
  ResolvedCorrectionPatch,
  RecordingState,
  TranscriptAskTurn,
  TranscriptAutoPostProcessWorkflow,
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
  resolveTranscriptArtifactSourceState,
  resolveTranscriptText,
} from '../services/aiPostProcess'
import {
  CorrectionRequestError,
  createCorrectionConfigSnapshot,
  isCorrectionConfigSnapshotCurrent,
  requestCorrectionShard,
} from '../services/aiCorrection'
import {
  createCorrectionShards,
  applyManualCorrectionEdit,
  DEFAULT_CORRECTION_PATCH_LIMITS,
  materializeCorrection,
  partitionCorrectionPatchConflicts,
  resolveCorrectionPatches,
  sha256Utf8,
  setCorrectionPatchState,
  revertAllCorrectionPatches,
  validateCorrectionPatchSet,
  validateResolvedCorrectionPatch,
} from '../utils/correctionPatch'
import { sessionRepository } from '../utils/sessionRepository'
import { getDirectProjectIds, normalizeProjectIds } from '../utils/projectSchema'
import { projectRepository } from '../utils/projectRepository'
import { syncSessionFiles } from '../utils/sessionFileSync'
import { isPublishedCorrectionAutoSaveEnabled, savePublishedMarkdown } from '../utils/publishedMarkdownCoordinator'
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
import {
  generateId,
} from '../utils/storageUtils'
import {
  createRecordingTimeline,
  finalizeRecordingTimeline,
  pauseRecordingTimeline,
  resumeRecordingTimeline,
  startRecordingTimeline,
  type RecordingTimeline,
} from '../utils/recordingTimeline'
import { canTransitionRecordingState } from '../../../shared/recordingState'

const SESSION_AUTOSAVE_DELAY_MS = 1200
let sessionAutosaveTimer: ReturnType<typeof setTimeout> | null = null

interface CorrectionExecutionLease {
  runId: string
  generation: number
  controller: AbortController
  apiKey?: string
}

let correctionExecutionGeneration = 0
const correctionExecutionLeases = new Map<string, CorrectionExecutionLease>()
const correctionMutationQueues = new Map<string, Promise<unknown>>()
const correctionStartReservations = new Set<string>()
const autoPostProcessWorkflowInFlight = new Set<string>()

class CorrectionRunError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'CorrectionRunError'
  }
}

export interface RecordingArchiveRecoverySummary {
  unresolvedCount?: number
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
  transitionRecordingState: (state: RecordingState) => boolean
  recordingTimeline: RecordingTimeline
  resetRecordingTimeline: () => void
  startRecordingTimeline: (nowMs?: number) => void
  pauseRecordingTimeline: (nowMs?: number) => number
  resumeRecordingTimeline: (nowMs?: number) => void
  finalizeRecordingTimeline: (nowMs?: number) => number

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
  setCurrentCaptureMode: (captureMode: NonNullable<TranscriptSession['sourceMeta']>['captureMode']) => void
  startNewSession: (options?: {
    projectIds?: string[]
    defaultSaveProjectId?: string
    captureMode?: NonNullable<TranscriptSession['sourceMeta']>['captureMode']
    providerId?: string
    meetingContext?: MeetingContextSnapshot
    recognitionConfig?: RecognitionConfigSnapshot
  }) => string
  endCurrentSession: (options?: {
    sourceMetaPatch?: Partial<NonNullable<TranscriptSession['sourceMeta']>>
    duration?: number
  }) => string | null
  restoreRecoverySession: () => void
  dismissRecoverySession: () => void

  sessions: TranscriptSession[]
  loadSessions: () => Promise<RecordingArchiveRecoverySummary | undefined>
  updateSessionTitle: (id: string, title: string, expectedRevision?: number) => Promise<boolean>
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
  deleteSession: (id: string) => Promise<void>
  deleteSessionConversation: (sessionId: string, conversationId: string) => void
  updateSessionTags: (sessionId: string, tagIds: string[]) => void
  updateSessionTopic: (sessionId: string, topicId: string | undefined) => void
  updateSessionProjects: (sessionId: string, projectIds: string[]) => Promise<void>
  setSessionProjectAssociation: (sessionId: string, projectId: string, associated: boolean) => Promise<void>
  updateSessionDefaultSaveProject: (sessionId: string, projectId: string | undefined) => Promise<void>
  replaceAllSessions: (sessions: TranscriptSession[]) => TranscriptSession[]

  updateSessionCorrection: (sessionId: string, patch: Partial<TranscriptCorrection>) => void
  recoverStaleSessionCorrection: (sessionId: string) => void
  maybeStartAutoAiPostProcess: (sessionId: string) => Promise<void>
  retrySessionAutoExport: (sessionId: string) => Promise<void>
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
  pauseSessionCorrection: (sessionId: string) => Promise<void>
  resumeSessionCorrection: (sessionId: string) => Promise<void>
  retrySessionCorrection: (sessionId: string) => Promise<void>
  abandonSessionCorrection: (sessionId: string) => Promise<void>
  applySessionCorrectionReview: (sessionId: string, patchIds: string[], expected?: CorrectionEditExpectation) => Promise<string>
  updateSessionCorrectionDraftPatch: (sessionId: string, patchId: string, replacement: string, expected?: CorrectionEditExpectation) => Promise<void>
  saveSessionManualCorrection: (sessionId: string, edit: ManualCorrectionEdit, expected: CorrectionEditExpectation) => Promise<void>
  changeSessionCorrectionPatchState: (sessionId: string, patchId: string, state: 'applied' | 'reverted', expected: CorrectionEditExpectation, confirmedConflictIds?: string[]) => Promise<void>
  restoreSessionLegacyCorrection: (sessionId: string) => Promise<void>
  setSessionCorrectionPatchState: (sessionId: string, patchId: string, state: 'applied' | 'reverted') => Promise<void>
  revertAllSessionCorrectionPatches: (sessionId: string) => Promise<void>

  finalTokens: TranscriptToken[]
  nonFinalTokens: TranscriptToken[]
}

export const useSessionStore = create<SessionState>((set, get) => {
  const buildCurrentSessionSnapshot = (overrides?: {
    finalTokens?: TranscriptToken[]
    nonFinalTokens?: TranscriptToken[]
    finalTranscript?: string
    nonFinalTranscript?: string
    currentTranscript?: string
    finalTranslatedTranscript?: string
    nonFinalTranslatedTranscript?: string
    currentTranslatedTranscript?: string
    currentPostProcess?: TranscriptPostProcess
    sourceMetaPatch?: Partial<NonNullable<TranscriptSession['sourceMeta']>>
    duration?: number
  }) => {
    const state = resolveTranscriptRuntimeState(
      selectTranscriptRuntimeState(get()),
      overrides,
    )
    const activeSession = get().sessions.find((session) => session.id === get().currentSessionId)
    const providerId = activeSession?.recognitionConfig?.providerId
      || activeSession?.providerId
      || useSettingsStore.getState().settings.currentVendor
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
      duration: overrides?.duration,
      meetingContext: activeSession?.meetingContext,
      recognitionConfig: activeSession?.recognitionConfig,
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
    nonFinalTokens?: TranscriptToken[]
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
      meetingContext: snapshot.meetingContext,
      recognitionConfig: snapshot.recognitionConfig,
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

  const checkpointCorrection = async (sessionId: string, correction: Parameters<typeof sessionRepository.checkpointCorrection>[1]) => {
    const sessions = await sessionRepository.checkpointCorrection(sessionId, correction)
    const committed = sessions.find((session) => session.id === sessionId)?.correction
    const recoverySession = get().recoverySession
    set({
      sessions,
      recoverySession: recoverySession?.id === sessionId ? { ...recoverySession, correction: committed } : recoverySession,
    })
    if (committed?.published) void savePublishedMarkdown(sessionId)
  }

  const enqueueCorrectionMutation = <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = correctionMutationQueues.get(sessionId) || Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    correctionMutationQueues.set(sessionId, current)
    void current.finally(() => {
      if (correctionMutationQueues.get(sessionId) === current) correctionMutationQueues.delete(sessionId)
    }).catch(() => undefined)
    return current
  }

  const isCurrentCorrectionLease = (sessionId: string, lease: CorrectionExecutionLease): boolean => (
    correctionExecutionLeases.get(sessionId) === lease && !lease.controller.signal.aborted
  )

  const revokeCorrectionLease = (sessionId: string): void => {
    const lease = correctionExecutionLeases.get(sessionId)
    if (!lease) return
    correctionExecutionLeases.delete(sessionId)
    lease.controller.abort()
  }

  const buildPublishedCorrection = async (
    session: TranscriptSession,
    correction: TranscriptCorrection,
    patches: ResolvedCorrectionPatch[],
    model: string,
    baseTranscriptHash: string,
  ) => {
    const finalPatches = patches.map((patch) => patch.state === 'rejected' || patch.state === 'reverted' ? patch : { ...patch, state: 'applied' as const })
    const correctedText = materializeCorrection(session.transcript, finalPatches)
    const outputTextHash = await sha256Utf8(correctedText)
    const completedAt = Date.now()
    return {
      correctedText,
      correction: {
        ...correction,
        status: 'done' as const,
        mode: correction.draft?.mode || correction.mode,
        correctedText,
        model,
        completedAt,
        error: undefined,
        legacy: undefined,
        published: {
          id: generateId(),
          formatVersion: 1 as const,
          revision: (correction.published?.revision || 0) + 1,
          baseTranscriptHash,
          outputTextHash,
          correctedText,
          patches: finalPatches,
          model,
          completedAt,
          safetyLimits: correction.draft?.config.safetyLimits || correction.published?.safetyLimits || DEFAULT_CORRECTION_PATCH_LIMITS,
          stats: {
            applied: finalPatches.filter((patch) => patch.state === 'applied').length,
            reverted: finalPatches.filter((patch) => patch.state === 'reverted').length,
            rejected: finalPatches.filter((patch) => patch.state === 'rejected').length,
          },
        },
        draft: undefined,
      },
    }
  }

  const publishCorrection = async (
    session: TranscriptSession,
    correction: TranscriptCorrection,
    patches: ResolvedCorrectionPatch[],
    model: string,
    baseTranscriptHash: string,
  ): Promise<string> => {
    const result = await buildPublishedCorrection(session, correction, patches, model, baseTranscriptHash)
    await checkpointCorrection(session.id, result.correction)
    return result.correctedText
  }

  const mutateManualCorrection = async (
    sessionId: string,
    expected: CorrectionEditExpectation,
    mutation: (session: TranscriptSession, patches: ResolvedCorrectionPatch[], sourceHash: string) => ResolvedCorrectionPatch[],
  ): Promise<void> => {
    await enqueueCorrectionMutation(sessionId, async () => {
      await checkpointCorrection(sessionId, async (session) => {
        if (session.status === 'recording' || session.status === 'interrupted'
          || get().correctionInFlight[sessionId] || correctionStartReservations.has(sessionId)) {
          throw new Error('correction-busy')
        }
        const correction = session.correction
        const draft = correction?.draft
        const published = correction?.published
        const sourceHash = await sha256Utf8(session.transcript)
        if (get().correctionInFlight[sessionId] || correctionStartReservations.has(sessionId)) throw new Error('correction-busy')
        if (sourceHash !== expected.baseTranscriptHash) throw new Error('source-hash-mismatch')
        if (expected.target === 'draft') {
          if (!draft || draft.status !== 'ready-for-review' || draft.runId !== expected.id
            || draft.revision !== expected.revision || draft.baseTranscriptHash !== sourceHash) throw new Error('correction-revision-mismatch')
        } else if (draft || correction?.legacy && !published
          || (expected.target === 'published' && (!published || published.id !== expected.id
            || published.revision !== expected.revision || published.baseTranscriptHash !== sourceHash))
          || (expected.target === 'new' && (published || expected.revision !== 0 || expected.id))) {
          throw new Error('correction-revision-mismatch')
        }
        const patches = mutation(session, expected.target === 'draft'
          ? [...draft!.proposedPatches, ...draft!.rejectedPatches] : published?.patches || [], sourceHash)
        if (expected.target === 'draft') {
          return {
            ...correction!,
            draft: {
              ...draft!, revision: draft!.revision + 1, updatedAt: Date.now(),
              proposedPatches: patches.filter((patch) => patch.state !== 'rejected'),
              rejectedPatches: patches.filter((patch) => patch.state === 'rejected'),
              shards: draft!.shards.map((shard) => ({
                ...shard,
                patches: shard.patches?.map((patch) => patches.find((item) => item.id === patch.id) || patch),
              })),
            },
          }
        }
        return (await buildPublishedCorrection(session, correction || { status: 'done', mode: 'quick' }, patches,
          published?.model || 'manual', sourceHash)).correction
      })
    })
  }

  const runCorrectionDraft = async (
    sessionId: string,
    lockedCredential?: { apiKey?: string; configIdentity?: string },
  ): Promise<string | null> => {
    const session = get().sessions.find((item) => item.id === sessionId)
    const draft = session?.correction?.draft
    if (!session || !draft) throw new Error('未找到可运行的纠错任务')
    const currentSettings = useSettingsStore.getState().settings
    if (lockedCredential) {
      if (lockedCredential.configIdentity !== draft.config.configIdentity) {
        throw new CorrectionRunError('纠错配置在任务启动前已变化，请使用当前配置重新检测', 'config-changed')
      }
    } else if (!isCorrectionConfigSnapshotCurrent(draft.config, currentSettings)) {
      throw new CorrectionRunError('已保存的 AI 配置已变化，请使用当前配置重新检测', 'config-changed')
    }
    const runId = draft.runId
    const existingLease = correctionExecutionLeases.get(sessionId)
    if (existingLease) return null
    const lease: CorrectionExecutionLease = {
      runId,
      generation: ++correctionExecutionGeneration,
      controller: new AbortController(),
      apiKey: lockedCredential ? lockedCredential.apiKey : currentSettings.aiPostProcess?.apiKey,
    }
    correctionExecutionLeases.set(sessionId, lease)
    markCorrectionInFlight(sessionId)
    try {
      await enqueueCorrectionMutation(sessionId, async () => {
        if (!isCurrentCorrectionLease(sessionId, lease)) return
        const latestSession = get().sessions.find((item) => item.id === sessionId)
        const latestDraft = latestSession?.correction?.draft
        if (!latestSession || !latestDraft || latestDraft.runId !== runId) return
        const runningDraft = {
          ...latestDraft,
          status: 'running' as const,
          pauseRequested: false,
          revision: latestDraft.revision + 1,
          updatedAt: Date.now(),
          shards: latestDraft.shards.map((shard) => shard.status === 'running' || shard.status === 'retrying'
            ? { ...shard, status: 'pending' as const, attemptId: undefined, draftRevision: latestDraft.revision + 1 }
            : shard),
        }
        await checkpointCorrection(sessionId, { ...latestSession.correction!, status: 'detecting', error: undefined, draft: runningDraft })
      })

      const claimNextShard = async (): Promise<{ session: TranscriptSession; shard: CorrectionShardProgress; config: typeof draft.config } | null> => {
        let claimed: { session: TranscriptSession; shard: CorrectionShardProgress; config: typeof draft.config } | null = null
        await enqueueCorrectionMutation(sessionId, async () => {
          if (!isCurrentCorrectionLease(sessionId, lease)) return
          const latestSession = get().sessions.find((item) => item.id === sessionId)
          const latestDraft = latestSession?.correction?.draft
          if (!latestSession || !latestDraft || latestDraft.runId !== runId || latestDraft.pauseRequested) return
          const pendingShard = latestDraft.shards.find((shard) => shard.status === 'pending')
          if (!pendingShard) return
          const revision = latestDraft.revision + 1
          const runningShard: CorrectionShardProgress = {
            ...pendingShard,
            status: 'running',
            attempt: pendingShard.attempt + 1,
            attemptId: generateId(),
            draftRevision: revision,
            error: undefined,
            errorCode: undefined,
          }
          const nextDraft = {
            ...latestDraft,
            revision,
            status: 'running' as const,
            updatedAt: Date.now(),
            shards: latestDraft.shards.map((shard) => shard.id === runningShard.id ? runningShard : shard),
          }
          await checkpointCorrection(sessionId, { ...latestSession.correction!, status: 'detecting', draft: nextDraft })
          claimed = { session: latestSession, shard: runningShard, config: latestDraft.config }
        })
        return claimed
      }

      const worker = async (): Promise<void> => {
        while (isCurrentCorrectionLease(sessionId, lease)) {
          const claimed = await claimNextShard()
          if (!claimed) return
          const { session: claimedSession, shard, config } = claimed
          let response
          try {
            response = await requestCorrectionShard({
              transcript: claimedSession.transcript,
              shard,
              snapshot: config,
              apiKey: lease.apiKey,
              signal: lease.controller.signal,
              onProgress: (progress) => {
                void enqueueCorrectionMutation(sessionId, async () => {
                  if (!isCurrentCorrectionLease(sessionId, lease)) return
                  const latestSession = get().sessions.find((item) => item.id === sessionId)
                  const latestDraft = latestSession?.correction?.draft
                  const currentShard = latestDraft?.shards.find((item) => item.id === shard.id)
                  if (!latestSession || !latestDraft || latestDraft.runId !== runId || !currentShard
                    || currentShard.status !== 'running' && currentShard.status !== 'retrying'
                    || currentShard.attemptId !== shard.attemptId || currentShard.draftRevision !== shard.draftRevision) return
                  const revision = latestDraft.revision + 1
                  const nextShard: CorrectionShardProgress = {
                    ...currentShard,
                    status: progress.stage === 'retry-countdown' ? 'retrying' : 'running',
                    attempt: progress.attempt,
                    attemptLimit: progress.maxAttempts,
                    nextRetryAt: progress.nextRetryAt,
                    stage: progress.stage,
                    stageUpdatedAt: progress.at,
                    lastActivityAt: progress.stage === 'thinking' || progress.stage === 'receiving-content'
                      ? progress.at : currentShard.lastActivityAt,
                  }
                  await checkpointCorrection(sessionId, {
                    ...latestSession.correction!,
                    status: 'detecting',
                    draft: {
                      ...latestDraft,
                      revision,
                      updatedAt: progress.at,
                      shards: latestDraft.shards.map((item) => item.id === nextShard.id ? nextShard : item),
                    },
                  })
                })
              },
            })
          } catch (error) {
            if (!isCurrentCorrectionLease(sessionId, lease)) return
            const code = error instanceof CorrectionRequestError ? error.code : 'protocol'
            const message = error instanceof Error ? error.message : String(error)
            await enqueueCorrectionMutation(sessionId, async () => {
              if (!isCurrentCorrectionLease(sessionId, lease)) return
              const latestSession = get().sessions.find((item) => item.id === sessionId)
              const latestDraft = latestSession?.correction?.draft
              const currentShard = latestDraft?.shards.find((item) => item.id === shard.id)
              if (!latestSession || !latestDraft || latestDraft.runId !== runId || !currentShard
                || currentShard.attemptId !== shard.attemptId || currentShard.draftRevision !== shard.draftRevision) return
              const revision = latestDraft.revision + 1
              const failedDraft = {
                ...latestDraft,
                revision,
                status: code === 'auth' ? 'blocked-auth' as const : 'failed' as const,
                errorCode: code,
                error: message,
                updatedAt: Date.now(),
                shards: latestDraft.shards.map((item) => item.id === shard.id
                  ? {
                      ...item,
                      status: 'failed' as const,
                      errorCode: code,
                      error: message,
                      timeoutKind: error instanceof CorrectionRequestError ? error.timeoutKind : undefined,
                      timeoutMs: error instanceof CorrectionRequestError ? error.timeoutMs : undefined,
                      draftRevision: revision,
                    }
                  : item.status === 'running' ? { ...item, status: 'pending' as const, attemptId: undefined, draftRevision: revision } : item),
              }
              await checkpointCorrection(sessionId, { ...latestSession.correction!, status: 'error', error: message, draft: failedDraft })
            })
            lease.controller.abort()
            throw error
          }

          await enqueueCorrectionMutation(sessionId, async () => {
            if (!isCurrentCorrectionLease(sessionId, lease)) return
            const latestSession = get().sessions.find((item) => item.id === sessionId)
            const latestDraft = latestSession?.correction?.draft
            const currentShard = latestDraft?.shards.find((item) => item.id === shard.id)
            if (!latestSession || !latestDraft || latestDraft.runId !== runId || !currentShard
              || currentShard.attemptId !== shard.attemptId || currentShard.draftRevision !== shard.draftRevision) return
            const resolved = resolveCorrectionPatches(latestSession.transcript, shard, response.patches, latestDraft.baseTranscriptHash, latestDraft.config.safetyLimits)
            const accepted = resolved.filter((patch) => patch.state !== 'rejected')
            const rejected = resolved.filter((patch) => patch.state === 'rejected')
            const revision = latestDraft.revision + 1
            const completedShard: CorrectionShardProgress = {
              ...currentShard,
              status: 'completed',
              patches: accepted,
              rejectedPatches: rejected,
              completedAt: Date.now(),
              draftRevision: revision,
              stage: undefined,
              nextRetryAt: undefined,
            }
            const nextDraft = {
              ...latestDraft,
              revision,
              updatedAt: Date.now(),
              shards: latestDraft.shards.map((item) => item.id === completedShard.id ? completedShard : item),
              proposedPatches: [...latestDraft.proposedPatches.filter((patch) => patch.shardId !== shard.id), ...accepted],
              rejectedPatches: [...latestDraft.rejectedPatches.filter((patch) => patch.shardId !== shard.id), ...rejected],
            }
            await checkpointCorrection(sessionId, { ...latestSession.correction!, status: 'detecting', draft: nextDraft })
          })
        }
      }

      const workerCount = Math.max(1, Math.min(draft.config.concurrency, draft.shards.length))
      await Promise.all(Array.from({ length: workerCount }, () => worker()))
      if (!isCurrentCorrectionLease(sessionId, lease)) {
        const failedDraft = get().sessions.find((item) => item.id === sessionId)?.correction?.draft
        if (failedDraft?.status === 'failed' || failedDraft?.status === 'blocked-auth') {
          throw new CorrectionRunError(failedDraft.error || '纠错任务失败', failedDraft.errorCode || 'failed')
        }
        return null
      }

      let output: string | null = null
      await enqueueCorrectionMutation(sessionId, async () => {
        if (!isCurrentCorrectionLease(sessionId, lease)) return
        const latestSession = get().sessions.find((item) => item.id === sessionId)
        const latestDraft = latestSession?.correction?.draft
        if (!latestSession || !latestDraft || latestDraft.runId !== runId) return
        if (await sha256Utf8(latestSession.transcript) !== latestDraft.baseTranscriptHash) {
          throw new CorrectionRunError('原始转录已变化，无法发布纠错结果', 'source-changed')
        }
        for (const patch of latestDraft.proposedPatches) {
          const validationError = validateResolvedCorrectionPatch(
            latestSession.transcript,
            patch,
            latestDraft.baseTranscriptHash,
            latestDraft.config.safetyLimits,
          )
          if (validationError) throw new CorrectionRunError(`Patch 校验失败: ${validationError}`, 'patch-validation')
        }
        const partition = partitionCorrectionPatchConflicts(latestDraft.proposedPatches)
        const conflictIds = new Set(partition.rejected.map((patch) => patch.id))
        const rejectedPatches = [...latestDraft.rejectedPatches, ...partition.rejected]
        const normalizedDraft = {
          ...latestDraft,
          proposedPatches: partition.accepted,
          rejectedPatches,
          shards: latestDraft.shards.map((shard) => ({
            ...shard,
            patches: shard.patches?.filter((patch) => !conflictIds.has(patch.id)),
            rejectedPatches: [
              ...(shard.rejectedPatches || []),
              ...partition.rejected.filter((patch) => patch.shardId === shard.id),
            ],
          })),
        }
        const safetyError = validateCorrectionPatchSet(latestSession.transcript, partition.accepted, latestDraft.config.safetyLimits)
        if (safetyError) throw new CorrectionRunError(`纠错结果超过安全限制: ${safetyError}`, 'safety-limit')
        if (normalizedDraft.mode === 'quick') {
          const result = await buildPublishedCorrection(
            latestSession,
            { ...latestSession.correction!, draft: normalizedDraft },
            [...partition.accepted, ...rejectedPatches],
            normalizedDraft.config.model,
            normalizedDraft.baseTranscriptHash,
          )
          if (!isCurrentCorrectionLease(sessionId, lease)) return
          await checkpointCorrection(sessionId, result.correction)
          output = result.correctedText
          return
        }
        const ready = { ...normalizedDraft, revision: normalizedDraft.revision + 1, status: 'ready-for-review' as const, updatedAt: Date.now() }
        if (!isCurrentCorrectionLease(sessionId, lease)) return
        await checkpointCorrection(sessionId, { ...latestSession.correction!, status: 'reviewing', mode: 'review', error: undefined, draft: ready })
      })
      return output
    } catch (error) {
      if (correctionExecutionLeases.get(sessionId) !== lease) return null
      lease.controller.abort()
      const latestSession = get().sessions.find((item) => item.id === sessionId)
      const latestDraft = latestSession?.correction?.draft
      if (latestSession && latestDraft?.runId === runId && latestDraft.status !== 'failed' && latestDraft.status !== 'blocked-auth') {
        const code = error instanceof CorrectionRunError
          ? error.code
          : error instanceof CorrectionRequestError ? error.code : 'finalization'
        const message = error instanceof Error ? error.message : String(error)
        try {
          await enqueueCorrectionMutation(sessionId, async () => {
            const currentSession = get().sessions.find((item) => item.id === sessionId)
            const currentDraft = currentSession?.correction?.draft
            if (!currentSession || !currentDraft || currentDraft.runId !== runId) return
            const revision = currentDraft.revision + 1
            const failed = { ...currentDraft, revision, status: code === 'auth' ? 'blocked-auth' as const : 'failed' as const, errorCode: code, error: message, updatedAt: Date.now(), shards: currentDraft.shards.map((shard) => shard.status === 'running' ? { ...shard, status: 'pending' as const, attemptId: undefined, draftRevision: revision } : shard) }
            await checkpointCorrection(sessionId, { ...currentSession.correction!, status: 'error', error: message, draft: failed })
          })
        } catch {
          // Preserve the last durable checkpoint when persisting the failure itself fails.
        }
      }
      throw error
    } finally {
      if (correctionExecutionLeases.get(sessionId) === lease) {
        correctionExecutionLeases.delete(sessionId)
        clearCorrectionInFlight(sessionId)
      }
    }
  }

  const createAndRunCorrection = async (sessionId: string, mode: 'quick' | 'review', trigger: 'manual-quick' | 'manual-review' | 'automatic') => {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session) throw new Error('未找到要纠错的会话')
    if (!session.transcript) throw new Error('当前会话没有可用于纠错的转录内容')
    if (session.correction?.draft) throw new Error('当前会话已有未完成的纠错任务')
    if (correctionStartReservations.has(sessionId)) throw new Error('纠错任务正在启动')
    correctionStartReservations.add(sessionId)
    try {
      let lockedCredential: { apiKey?: string; configIdentity?: string } | undefined
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        if (!session || session.correction?.draft) throw new Error('当前会话已有未完成的纠错任务')
        const settings = useSettingsStore.getState().settings
        const config = createCorrectionConfigSnapshot(settings, session.meetingContext)
        lockedCredential = { apiKey: settings.aiPostProcess?.apiKey, configIdentity: config.configIdentity }
        const baseTranscriptHash = await sha256Utf8(session.transcript)
        const now = Date.now()
        const draft = {
          runId: generateId(),
          revision: 1,
          trigger,
          mode,
          status: 'queued' as const,
          baseTranscriptHash,
          config,
          shards: createCorrectionShards(session.transcript, config.chunkSize, config.contextSize).map((shard) => ({
            ...shard,
            status: 'pending' as const,
            attempt: 0,
            draftRevision: 1,
          })),
          proposedPatches: [],
          rejectedPatches: [],
          requestedAt: now,
          updatedAt: now,
        }
        const correction: TranscriptCorrection = {
          status: 'detecting',
          mode,
          correctedText: session.correction?.correctedText,
          published: session.correction?.published,
          legacy: session.correction?.legacy,
          model: config.model,
          requestedAt: now,
          draft,
        }
        await checkpointCorrection(sessionId, correction)
      })
      return await runCorrectionDraft(sessionId, lockedCredential)
    } finally {
      correctionStartReservations.delete(sessionId)
    }
  }

  const replaceAutoPostProcessWorkflow = (
    sessionId: string,
    workflow: TranscriptAutoPostProcessWorkflow,
  ): void => {
    const sessions = sessionRepository.updateMetadata(sessionId, { autoPostProcessWorkflow: workflow })
    const persistedWorkflow = sessions.find((session) => session.id === sessionId)?.autoPostProcessWorkflow || workflow
    const recoverySession = get().recoverySession
    set({
      sessions,
      recoverySession: recoverySession?.id === sessionId
        ? { ...recoverySession, autoPostProcessWorkflow: persistedWorkflow }
        : recoverySession,
    })
  }

  const updateAutoPostProcessWorkflow = (
    sessionId: string,
    patch: Partial<TranscriptAutoPostProcessWorkflow>,
  ): TranscriptAutoPostProcessWorkflow | undefined => {
    const workflow = get().sessions.find((session) => session.id === sessionId)?.autoPostProcessWorkflow
    if (!workflow) return undefined
    const nextWorkflow: TranscriptAutoPostProcessWorkflow = {
      ...workflow,
      ...patch,
      version: 1,
      updatedAt: Date.now(),
    }
    replaceAutoPostProcessWorkflow(sessionId, nextWorkflow)
    return nextWorkflow
  }

  const failAutoPostProcessWorkflow = (
    sessionId: string,
    error: unknown,
    step?: TranscriptAutoPostProcessWorkflow['step'],
  ): void => {
    const message = error instanceof Error ? error.message : String(error)
    updateAutoPostProcessWorkflow(sessionId, {
      status: 'error',
      ...(step ? { step } : {}),
      error: message || '自动 AI 后处理失败',
    })
  }

  const finishAutoPostProcessTitle = async (sessionId: string): Promise<void> => {
    const session = get().sessions.find((item) => item.id === sessionId)
    const workflow = session?.autoPostProcessWorkflow
    if (!session || !workflow) return
    const titleSuggestion = session.postProcess?.titleSuggestion?.trim()
    if (!titleSuggestion) {
      failAutoPostProcessWorkflow(sessionId, 'AI 摘要未返回有效标题建议', 'title')
      return
    }

    if (workflow.titleRevisionAtStart !== undefined && (session.titleRevision || 0) === workflow.titleRevisionAtStart) {
      await get().updateSessionTitle(sessionId, titleSuggestion, workflow.titleRevisionAtStart)
    }
    const autoExportEnabled = isPublishedCorrectionAutoSaveEnabled(useSettingsStore.getState().settings)
    updateAutoPostProcessWorkflow(sessionId, autoExportEnabled
      ? { status: 'queued', step: 'export', error: undefined }
      : { status: 'completed', step: 'title', completedAt: Date.now(), error: undefined })
  }

  const exportCorrectedTranscriptMarkdown = async (sessionId: string): Promise<void> => {
    const session = get().sessions.find((item) => item.id === sessionId)
    const workflow = session?.autoPostProcessWorkflow
    if (!session || !workflow || workflow.step !== 'export') return
    const file = await savePublishedMarkdown(sessionId)
    if (!get().sessions.some((item) => item.id === sessionId)) return

    const now = Date.now()
    updateAutoPostProcessWorkflow(sessionId, {
      status: 'completed',
      step: 'export',
      ...(file?.status === 'saved' ? { exportPath: file.path, exportedAt: now } : {}),
      completedAt: now,
      error: undefined,
    })
  }

  const continueAutoPostProcessAfterCorrection = async (sessionId: string): Promise<void> => {
    const session = get().sessions.find((item) => item.id === sessionId)
    const workflow = session?.autoPostProcessWorkflow
    if (!session || !workflow || workflow.step !== 'correction'
      || workflow.status === 'error' || workflow.status === 'completed'
      || session.correction?.draft || !session.correction?.published) return
    updateAutoPostProcessWorkflow(sessionId, {
      status: 'queued',
      step: 'briefing',
      error: undefined,
    })
    await runAutoAiPostProcessWorkflow(sessionId)
  }

  async function runAutoAiPostProcessWorkflow(sessionId: string): Promise<void> {
    if (autoPostProcessWorkflowInFlight.has(sessionId)) return
    autoPostProcessWorkflowInFlight.add(sessionId)
    try {
      while (true) {
        const session = get().sessions.find((item) => item.id === sessionId)
        const workflow = session?.autoPostProcessWorkflow
        if (!session || !workflow || (workflow.status !== 'queued' && workflow.status !== 'running')) return

        if (workflow.step === 'correction') {
          if (session.correction?.draft?.status === 'paused') return
          updateAutoPostProcessWorkflow(sessionId, { status: 'running', error: undefined })

          let latestSession = get().sessions.find((item) => item.id === sessionId)
          let draft = latestSession?.correction?.draft
          if (draft?.status === 'failed' || draft?.status === 'blocked-auth') {
            throw new Error(draft.error || 'AI 纠错失败')
          }
          if (draft?.status === 'queued' || draft?.status === 'running' || draft?.status === 'retrying') {
            await runCorrectionDraft(sessionId)
          } else if (!draft) {
            const published = latestSession?.correction?.published
            const publishedByWorkflow = published && published.completedAt >= workflow.startedAt
            if (!publishedByWorkflow) {
              await createAndRunCorrection(sessionId, workflow.correctionMode, 'automatic')
            }
          }

          latestSession = get().sessions.find((item) => item.id === sessionId)
          draft = latestSession?.correction?.draft
          if (draft?.status === 'ready-for-review') {
            if (draft.proposedPatches.length === 0) {
              await get().applySessionCorrectionReview(sessionId, [])
              continue
            }
            updateAutoPostProcessWorkflow(sessionId, { status: 'waiting-review', error: undefined })
            return
          }
          if (draft?.status === 'failed' || draft?.status === 'blocked-auth') {
            throw new Error(draft.error || 'AI 纠错失败')
          }
          if (draft?.status === 'paused') return

          const published = latestSession?.correction?.published
          if (!draft && published && published.completedAt >= workflow.startedAt) {
            updateAutoPostProcessWorkflow(sessionId, {
              status: 'queued',
              step: 'briefing',
              error: undefined,
            })
            continue
          }
          return
        }

        if (workflow.step === 'briefing') {
          updateAutoPostProcessWorkflow(sessionId, { status: 'running', error: undefined })
          const latestSession = get().sessions.find((item) => item.id === sessionId)
          if (!latestSession) return
          const settings = useSettingsStore.getState().settings
          const currentSource = resolveTranscriptText(
            latestSession,
            settings.aiPostProcess?.preferCorrectedText,
          )
          const reusableBriefing = latestSession.postProcess?.status === 'success'
            && Boolean(latestSession.postProcess.generatedAt && latestSession.postProcess.generatedAt >= workflow.startedAt)
            && resolveTranscriptArtifactSourceState(latestSession.postProcess, currentSource) === 'current'
          if (!reusableBriefing) {
            await get().generateSessionPostProcess(sessionId)
          }
          updateAutoPostProcessWorkflow(sessionId, { status: 'running', step: 'title', error: undefined })
          await finishAutoPostProcessTitle(sessionId)
          continue
        }

        if (workflow.step === 'title') {
          updateAutoPostProcessWorkflow(sessionId, { status: 'running', error: undefined })
          await finishAutoPostProcessTitle(sessionId)
          continue
        }

        updateAutoPostProcessWorkflow(sessionId, { status: 'running', error: undefined })
        await exportCorrectedTranscriptMarkdown(sessionId)
        return
      }
    } catch (error) {
      failAutoPostProcessWorkflow(sessionId, error)
    } finally {
      autoPostProcessWorkflowInFlight.delete(sessionId)
    }
  }

  return {
    recordingState: 'idle',
    setRecordingState: (state) => set({ recordingState: state }),
    transitionRecordingState: (state) => {
      const current = get().recordingState
      if (!canTransitionRecordingState(current, state)) return false
      set({ recordingState: state })
      return true
    },
    recordingTimeline: createRecordingTimeline(),
    resetRecordingTimeline: () => set({ recordingTimeline: createRecordingTimeline() }),
    startRecordingTimeline: (nowMs = Date.now()) => {
      set({ recordingTimeline: startRecordingTimeline(nowMs) })
    },
    pauseRecordingTimeline: (nowMs = Date.now()) => {
      const recordingTimeline = pauseRecordingTimeline(get().recordingTimeline, nowMs)
      set({ recordingTimeline })
      return recordingTimeline.accumulatedMs
    },
    resumeRecordingTimeline: (nowMs = Date.now()) => {
      set({ recordingTimeline: resumeRecordingTimeline(get().recordingTimeline, nowMs) })
    },
    finalizeRecordingTimeline: (nowMs = Date.now()) => {
      const recordingTimeline = finalizeRecordingTimeline(get().recordingTimeline, nowMs)
      set({ recordingTimeline })
      return recordingTimeline.accumulatedMs
    },

    ...createEmptyTranscriptRuntimeState(),
    applyTranscriptEvent: (event) => {
      const nextTranscriptState = reduceTranscriptEvent(
        selectTranscriptRuntimeState(get()),
        event,
      )

      const sessions = syncCurrentSessionInMemory({
        finalTokens: nextTranscriptState.finalTokens,
        nonFinalTokens: nextTranscriptState.nonFinalTokens,
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
    setCurrentCaptureMode: (currentCaptureMode) => set({ currentCaptureMode }),
    startNewSession: (options) => {
      clearSessionAutosaveTimer()
      const now = Date.now()
      const { t } = useUIStore.getState()
      const { settings } = useSettingsStore.getState()
      const providerId = options?.providerId || settings.currentVendor
      const projects = options?.projectIds?.length ? projectRepository.read() : []
      const projectIds = options?.projectIds?.filter((id) => projects.some((project) => project.id === id) && !projectRepository.isDeleting(id))

      const session = createDraftSession({
        projectIds,
        defaultSaveProjectId: options?.defaultSaveProjectId,
        now,
        title: t.session.defaultTitle(formatTime(now)),
        providerId,
        sourceMeta: buildSourceMeta({
          providerId,
          providerMode: resolveProviderMode(providerId),
          platform: window.electronAPI?.platform ?? 'unknown',
          captureMode: options?.captureMode || 'system-audio',
        }),
        meetingContext: options?.meetingContext,
        recognitionConfig: options?.recognitionConfig,
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
      const snapshot = buildCurrentSessionSnapshot({
        sourceMetaPatch: options?.sourceMetaPatch,
        duration: options?.duration,
      })
      const hasContent = hasPersistenceSnapshotContent(snapshot)

      if (currentSessionId && hasContent) {
        const sessions = sessionRepository.completeSession(currentSessionId, snapshot)
        set({ sessions })
        void syncSessionFiles(currentSessionId).catch((error: unknown) => console.warn('[Files] Initial media naming failed:', error))
        void get().maybeStartAutoAiPostProcess(currentSessionId)
        console.log('[SessionStore] 会话已保存, 文本长度:', snapshot.transcript.length)
        set({ currentSessionId: null, currentCaptureMode: 'system-audio' })
        return currentSessionId
      } else if (currentSessionId) {
        const sessions = sessionRepository.deleteSession(currentSessionId)
        set({ sessions })
        console.log('[SessionStore] 空会话已丢弃:', currentSessionId)
      } else {
        console.log('[SessionStore] 会话未保存: currentSessionId=', currentSessionId)
      }
      set({ currentSessionId: null, currentCaptureMode: 'system-audio' })
      return null
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

      for (const session of sessions) {
        const draft = session.correction?.draft
        const currentSettings = useSettingsStore.getState().settings
        if (draft && (draft.status === 'queued' || draft.status === 'running' || draft.status === 'retrying')
          && !isCorrectionConfigSnapshotCurrent(draft.config, currentSettings)) {
          const revision = draft.revision + 1
          const message = draft.config.configIdentity
            ? '已保存的 AI 配置已变化，请使用当前配置重新检测'
            : '旧纠错任务缺少可验证配置，请使用当前配置重新检测'
          await checkpointCorrection(session.id, {
            ...session.correction!,
            status: 'error',
            error: message,
            draft: {
              ...draft,
              revision,
              status: 'failed',
              errorCode: draft.config.configIdentity ? 'config-changed' : 'legacy-config',
              error: message,
              updatedAt: Date.now(),
              shards: draft.shards.map((shard) => shard.status === 'running' || shard.status === 'retrying'
                ? { ...shard, status: 'pending', attemptId: undefined, draftRevision: revision }
                : shard),
            },
          })
          if (session.autoPostProcessWorkflow?.step === 'correction') {
            failAutoPostProcessWorkflow(session.id, message, 'correction')
          }
          continue
        }
        const workflow = session.autoPostProcessWorkflow
        if (workflow) {
          if ((workflow.status === 'queued' || workflow.status === 'running')
            && session.correction?.draft?.status !== 'paused') {
            void runAutoAiPostProcessWorkflow(session.id).catch((error) => {
              console.warn('[SessionStore] 恢复自动 AI 后处理失败:', error)
            })
          }
          continue
        }
        if (session.correction?.draft?.status !== 'queued') continue
        void runCorrectionDraft(session.id).catch((error) => {
          console.warn('[SessionStore] 恢复 AI 纠错任务失败:', error)
        })
      }

      if (!window.electronAPI?.recoverRecordingArchives) return undefined

      try {
        const result = await window.electronAPI.recoverRecordingArchives(get().sessions.map((session) => session.id))
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
          if (!session) {
            unlinkedCount += 1
            continue
          }

          const sourceMeta = {
            sourceKind: 'recording-audio' as const,
            audioPath: archive.path,
            audioMimeType: archive.mimeType || 'audio/wav',
            audioFileName: archive.fileName || 'source-audio.wav',
            audioSize: archive.size,
            managedAsset: archive.managedAsset,
          }
          const nextSessions = await sessionRepository.updateMetadataDurable(session.id, (current) => ({ sourceMeta: { ...current.sourceMeta, ...sourceMeta } }))
          const currentRecoverySession = get().recoverySession
          set({
            sessions: nextSessions,
            recoverySession: currentRecoverySession?.id === session.id
              ? nextSessions.find((item) => item.id === session.id) || currentRecoverySession
              : currentRecoverySession,
          })
          linkedCount += 1
        }

        const summary = {
          recoveredCount: result.recovered.length,
          unresolvedCount: result.notices?.filter((item) => !item.acknowledged).length,
          linkedCount,
          unlinkedCount,
          skippedCount: result.skipped?.length || 0,
        }
        return summary.recoveredCount > 0 || summary.skippedCount > 0 || summary.unresolvedCount ? summary : undefined
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
    updateSessionTitle: async (id, title, expectedRevision) => {
      const value = title.trim()
      if (!value) throw new Error('Title cannot be empty')
      let applied = false
      const durable = await sessionRepository.updateMetadataDurable(id, (current) => {
        if (expectedRevision !== undefined && (current.titleRevision || 0) !== expectedRevision) return {}
        applied = true
        return { title: value, titleRevision: (current.titleRevision || 0) + (current.title === value ? 0 : 1) }
      })
      const recoverySession = get().recoverySession
      set({ sessions: durable, recoverySession: recoverySession?.id === id ? durable.find((session) => session.id === id) || null : recoverySession })
      if (!applied) return false
      try { await syncSessionFiles(id); await savePublishedMarkdown(id) }
      catch (error) { console.warn('[Title] Title is durable; file synchronization remains retryable:', error) }
      return true
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
      if (session.askHistory?.some((turn) => turn.status === 'pending')) throw new Error('此会话已有问答正在进行')
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
          sourceKind: result.source?.sourceKind,
          sourceTextHash: result.source?.sourceTextHash,
          sourceResultId: result.source?.sourceResultId,
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
      if (session.askHistory?.some((turn) => turn.status === 'pending')) throw new Error('此会话已有问答正在进行')
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
              sourceKind: result.source?.sourceKind,
              sourceTextHash: result.source?.sourceTextHash,
              sourceResultId: result.source?.sourceResultId,
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
        const latestSession = get().sessions.find((item) => item.id === sessionId) || session
        const { postProcess } = await generateSessionBriefing(
          latestSession,
          useSettingsStore.getState().settings,
        )
        const nextPostProcess = options?.overwrite === false
          ? mergeSessionPostProcess(latestSession.postProcess, {
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
    deleteSession: async (id) => {
      if (get().currentSessionId === id) throw new Error('Stop recording before deleting this record')
      const api = window.electronAPI
      const prepared = await api?.markFileRecordDeletion?.(id, 'prepare')
      if (prepared && !prepared.ok) throw new Error(prepared.error)
      let sessions: TranscriptSession[]
      try { sessions = await sessionRepository.deleteSessionWithResults(id) }
      catch (error) { await api?.markFileRecordDeletion?.(id, 'cancel'); throw error }
      const committed = await api?.markFileRecordDeletion?.(id, 'commit')
      if (committed && !committed.ok) console.error('[RecordDeletion] Physical callbacks remain fenced pending reconciliation:', committed.error)
      const nextState = applySessionDeletion(get().sessions, id, get().recoverySession)
      set({
        sessions,
        recoverySession: nextState.recoverySession,
      })
    },
    deleteSessionConversation: (sessionId, conversationId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      if (session.askHistory?.some((turn) => turn.status === 'pending' && (turn.conversationId || 'default') === conversationId)) throw new Error('请等待此对话完成后再删除')
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
      const existing = sessions.find((session) => session.id === sessionId)
      if (topicId && !getDirectProjectIds(existing || { projectIds: [] }).includes(topicId) && (!projectRepository.read().some((project) => project.id === topicId && !project.archivedAt) || projectRepository.isDeleting(topicId))) throw new Error('Project is unavailable')
      const nextState = applySessionMetadataUpdate(
        sessions,
        sessionId,
        { projectIds: topicId ? [topicId] : [], topicId },
        {
          currentSessionId,
          recoverySession,
          currentSpeakers,
          currentPostProcess,
        },
      )
      const nextSessions = sessionRepository.updateMetadata(sessionId, { projectIds: topicId ? [topicId] : [], topicId })
      set({
        sessions: nextSessions,
        recoverySession: nextState.recoverySession,
      })
    },
    updateSessionProjects: async (sessionId, ids) => {
      const projectIds = normalizeProjectIds(ids)
      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error('Record does not exist')
      const previousIds = getDirectProjectIds(session)
      if (JSON.stringify(previousIds) === JSON.stringify(projectIds)) return
      const sessions = await sessionRepository.updateMetadataDurable(sessionId, (current) => {
        const existing = getDirectProjectIds(current)
        const projects = projectRepository.read()
        if (projectIds.some((id) => !existing.includes(id) && (!projects.some((project) => project.id === id && !project.archivedAt) || projectRepository.isDeleting(id)))) throw new Error('Project is unavailable')
        return { projectIds, topicId: projectIds[0] }
      })
      const recoverySession = get().recoverySession
      set({ sessions, recoverySession: recoverySession?.id === sessionId ? sessions.find((item) => item.id === sessionId) || null : recoverySession })
    },
    updateSessionDefaultSaveProject: async (sessionId, projectId) => {
      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session || (projectId && !getDirectProjectIds(session).includes(projectId))) throw new Error('Save project must be a direct association')
      const sessions = await sessionRepository.updateMetadataDurable(sessionId, { defaultSaveProjectId: projectId })
      set({ sessions })
    },
    setSessionProjectAssociation: async (sessionId, projectId, associated) => {
      const sessions = await sessionRepository.updateMetadataDurable(sessionId, (session) => {
        const currentIds = getDirectProjectIds(session)
        if (associated && !currentIds.includes(projectId) && (!projectRepository.read().some((project) => project.id === projectId && !project.archivedAt) || projectRepository.isDeleting(projectId))) throw new Error('Project is unavailable')
        const projectIds = associated ? normalizeProjectIds([...currentIds, projectId]) : currentIds.filter((id) => id !== projectId)
        return { projectIds, topicId: projectIds[0] }
      })
      const recoverySession = get().recoverySession
      set({ sessions, recoverySession: recoverySession?.id === sessionId ? sessions.find((item) => item.id === sessionId) || null : recoverySession })
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

    recoverStaleSessionCorrection: () => undefined,

    maybeStartAutoAiPostProcess: async (sessionId) => {
      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session?.transcript.trim() || session.autoPostProcessWorkflow) return

      const settings = useSettingsStore.getState().settings
      const aiConfig = settings.aiPostProcess || {}
      if (!aiConfig.autoAiPostProcess) {
        await get().maybeAutoDetectSessionCorrection(sessionId)
        return
      }

      const now = Date.now()
      const workflow: TranscriptAutoPostProcessWorkflow = {
        version: 1,
        status: 'queued',
        step: 'correction',
        correctionMode: aiConfig.correctionMode || 'quick',
        titleAtStart: session.title,
        titleRevisionAtStart: session.titleRevision || 0,
        startedAt: now,
        updatedAt: now,
      }
      replaceAutoPostProcessWorkflow(sessionId, workflow)

      const configurationError = !aiConfig.enabled
        ? '请先在设置中启用 AI 后处理'
        : !resolveModelForFeature(aiConfig, 'correction')
          ? '请先配置 AI 纠错模型'
          : !resolveModelForFeature(aiConfig, 'briefing')
            ? '请先配置 AI 摘要模型'
            : ''
      if (configurationError) {
        failAutoPostProcessWorkflow(sessionId, configurationError)
        return
      }

      await runAutoAiPostProcessWorkflow(sessionId)
    },

    retrySessionAutoExport: async (sessionId) => {
      await savePublishedMarkdown(sessionId, { retry: true })
    },

    maybeAutoDetectSessionCorrection: async (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session?.transcript.trim()) return

      const settings = useSettingsStore.getState().settings
      const aiConfig = settings.aiPostProcess || {}
      if (aiConfig.autoAiPostProcess) return
      if (!aiConfig.enabled || !aiConfig.autoCorrectionDetection) return
      if (!resolveModelForFeature(aiConfig, 'correction')) return
      if (get().correctionInFlight[sessionId]) return

      if (session.correction?.draft) return

      try {
        await createAndRunCorrection(sessionId, 'review', 'automatic')
      } catch (error) {
        console.warn('[SessionStore] 自动 AI 纠错检测失败:', error)
      }
    },

    detectSessionCorrectionIssues: async (sessionId) => {
      await createAndRunCorrection(sessionId, 'review', 'manual-review')
      return []
    },

    startSessionQuickCorrection: async (sessionId, onChunk) => {
      const text = await createAndRunCorrection(sessionId, 'quick', 'manual-quick') || ''
      onChunk?.(text)
      return text
    },

    startSessionReviewCorrection: async (sessionId, acceptedIssues, onChunk) => {
      const text = await get().applySessionCorrectionReview(sessionId, acceptedIssues.filter((issue) => issue.accepted !== false).map((issue) => issue.id))
      onChunk?.(text)
      return text
    },
    pauseSessionCorrection: async (sessionId) => {
      revokeCorrectionLease(sessionId)
      clearCorrectionInFlight(sessionId)
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        const draft = session?.correction?.draft
        if (!session || !draft) return
        const revision = draft.revision + 1
        const paused = {
          ...draft,
          status: 'paused' as const,
          pauseRequested: true,
          revision,
          updatedAt: Date.now(),
          shards: draft.shards.map((shard) => shard.status === 'running' || shard.status === 'retrying'
            ? { ...shard, status: 'pending' as const, attemptId: undefined, draftRevision: revision }
            : shard),
        }
        await checkpointCorrection(sessionId, { ...session.correction!, status: 'detecting', draft: paused })
      })
    },
    resumeSessionCorrection: async (sessionId) => {
      const resumableDraft = get().sessions.find((item) => item.id === sessionId)?.correction?.draft
      const resumeSettings = useSettingsStore.getState().settings
      if (resumableDraft && !isCorrectionConfigSnapshotCurrent(resumableDraft.config, resumeSettings)) {
        await get().retrySessionCorrection(sessionId)
        return
      }
      const workflow = get().sessions.find((item) => item.id === sessionId)?.autoPostProcessWorkflow
      if (workflow?.step === 'correction' && workflow.status !== 'completed') {
        updateAutoPostProcessWorkflow(sessionId, { status: 'queued', error: undefined })
      }
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        const draft = session?.correction?.draft
        if (!session || !draft) return
        const revision = draft.revision + 1
        const queued = { ...draft, status: 'queued' as const, pauseRequested: false, revision, updatedAt: Date.now(), shards: draft.shards.map((shard) => shard.status === 'running' || shard.status === 'retrying' ? { ...shard, status: 'pending' as const, attemptId: undefined, draftRevision: revision } : shard) }
        await checkpointCorrection(sessionId, { ...session.correction!, status: 'detecting', error: undefined, draft: queued })
      })
      try {
        await runCorrectionDraft(sessionId, {
          apiKey: resumeSettings.aiPostProcess?.apiKey,
          configIdentity: resumableDraft?.config.configIdentity,
        })
      } catch (error) {
        if (workflow?.step === 'correction') failAutoPostProcessWorkflow(sessionId, error, 'correction')
        throw error
      }
      if (workflow?.step === 'correction') await runAutoAiPostProcessWorkflow(sessionId)
    },
    retrySessionCorrection: async (sessionId) => {
      if (correctionStartReservations.has(sessionId)) throw new Error('纠错任务正在启动')
      correctionStartReservations.add(sessionId)
      revokeCorrectionLease(sessionId)
      const workflow = get().sessions.find((item) => item.id === sessionId)?.autoPostProcessWorkflow
      if (workflow?.step === 'correction' && workflow.status !== 'completed') {
        updateAutoPostProcessWorkflow(sessionId, { status: 'queued', error: undefined })
      }
      try {
        let lockedCredential: { apiKey?: string; configIdentity?: string } | undefined
        await enqueueCorrectionMutation(sessionId, async () => {
          const session = get().sessions.find((item) => item.id === sessionId)
          const draft = session?.correction?.draft
          if (!session || !draft) return
          const currentSettings = useSettingsStore.getState().settings
          lockedCredential = {
            apiKey: currentSettings.aiPostProcess?.apiKey,
            configIdentity: undefined,
          }
          const matchesCurrentConfig = isCorrectionConfigSnapshotCurrent(draft.config, currentSettings)
          const now = Date.now()
          if (!matchesCurrentConfig) {
            const config = createCorrectionConfigSnapshot(currentSettings, session.meetingContext)
            lockedCredential.configIdentity = config.configIdentity
            const baseTranscriptHash = await sha256Utf8(session.transcript)
            const rebuilt = {
              runId: generateId(),
              revision: 1,
              trigger: draft.trigger,
              mode: draft.mode,
              status: 'queued' as const,
              baseTranscriptHash,
              config,
              shards: createCorrectionShards(session.transcript, config.chunkSize, config.contextSize).map((shard) => ({
                ...shard,
                status: 'pending' as const,
                attempt: 0,
                draftRevision: 1,
              })),
              proposedPatches: [],
              rejectedPatches: [],
              requestedAt: now,
              updatedAt: now,
            }
            await checkpointCorrection(sessionId, {
              ...session.correction!,
              status: 'detecting',
              error: undefined,
              model: config.model,
              requestedAt: now,
              draft: rebuilt,
            })
            return
          }
          const revision = draft.revision + 1
          lockedCredential.configIdentity = draft.config.configIdentity
          const queued = {
            ...draft,
            status: 'queued' as const,
            error: undefined,
            errorCode: undefined,
            pauseRequested: false,
            revision,
            updatedAt: now,
            shards: draft.shards.map((shard) => shard.status === 'failed' || shard.status === 'running' || shard.status === 'retrying'
              ? {
                  ...shard,
                  status: 'pending' as const,
                  attempt: 0,
                  attemptId: undefined,
                  error: undefined,
                  errorCode: undefined,
                  timeoutKind: undefined,
                  timeoutMs: undefined,
                  stage: undefined,
                  nextRetryAt: undefined,
                  draftRevision: revision,
                }
              : shard),
          }
          await checkpointCorrection(sessionId, { ...session.correction!, status: 'detecting', error: undefined, draft: queued })
        })
        await runCorrectionDraft(sessionId, lockedCredential)
      } catch (error) {
        if (workflow?.step === 'correction') failAutoPostProcessWorkflow(sessionId, error, 'correction')
        throw error
      } finally {
        correctionStartReservations.delete(sessionId)
      }
      if (workflow?.step === 'correction') await runAutoAiPostProcessWorkflow(sessionId)
    },
    abandonSessionCorrection: async (sessionId) => {
      revokeCorrectionLease(sessionId)
      clearCorrectionInFlight(sessionId)
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        if (!session?.correction) return
        const next = { ...session.correction, draft: undefined, status: session.correction.published || session.correction.legacy ? 'done' as const : 'idle' as const, error: undefined }
        await checkpointCorrection(sessionId, next)
      })
      const workflow = get().sessions.find((item) => item.id === sessionId)?.autoPostProcessWorkflow
      if (workflow?.step === 'correction' && workflow.status !== 'completed') {
        failAutoPostProcessWorkflow(sessionId, 'AI 纠错任务已放弃', 'correction')
      }
    },
    applySessionCorrectionReview: async (sessionId, patchIds, expected) => {
      const requestedDraft = get().sessions.find((item) => item.id === sessionId)?.correction?.draft
      const requested = expected || (requestedDraft ? {
        target: 'draft', id: requestedDraft.runId, revision: requestedDraft.revision, baseTranscriptHash: requestedDraft.baseTranscriptHash,
      } : undefined)
      let output = ''
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        const draft = session?.correction?.draft
        if (!session || !draft || draft.status !== 'ready-for-review') throw new Error('没有可应用的 Review 候选')
        if (!requested || requested.target !== 'draft' || requested.id !== draft.runId || requested.revision !== draft.revision
          || requested.baseTranscriptHash !== draft.baseTranscriptHash) throw new Error('correction-revision-mismatch')
        if (await sha256Utf8(session.transcript) !== draft.baseTranscriptHash) throw new Error('原始转录已变化，无法应用 Review')
        const selected = new Set(patchIds)
        const patches = draft.proposedPatches.map((patch) => ({ ...patch, state: selected.has(patch.id) ? 'applied' as const : 'reverted' as const }))
        const active = patches.filter((patch) => patch.state === 'applied')
        for (const patch of active) {
          const validationError = validateResolvedCorrectionPatch(session.transcript, patch, draft.baseTranscriptHash, draft.config.safetyLimits)
          if (validationError) throw new Error(`Patch 校验失败: ${validationError}`)
        }
        if (partitionCorrectionPatchConflicts(active).rejected.length > 0) throw new Error('所选 Patch 存在冲突')
        const safetyError = validateCorrectionPatchSet(session.transcript, active, draft.config.safetyLimits)
        if (safetyError) throw new Error(`所选 Patch 超过安全限制: ${safetyError}`)
        output = await publishCorrection(session, session.correction!, [...patches, ...draft.rejectedPatches], draft.config.model, draft.baseTranscriptHash)
      })
      void continueAutoPostProcessAfterCorrection(sessionId)
      return output
    },
    updateSessionCorrectionDraftPatch: async (sessionId, patchId, replacement, expected) => {
      const draft = get().sessions.find((item) => item.id === sessionId)?.correction?.draft
      if (!draft || draft.status !== 'ready-for-review') throw new Error('没有可编辑的 Review 候选')
      const current = draft.proposedPatches.find((patch) => patch.id === patchId)
      if (!current) throw new Error('未找到要编辑的 Patch')
      await get().saveSessionManualCorrection(sessionId, {
        patchId, sourceStart: current.sourceStart, sourceEnd: current.sourceEnd, sourceText: current.sourceText, replacement,
      }, expected || { target: 'draft', id: draft.runId, revision: draft.revision, baseTranscriptHash: draft.baseTranscriptHash })
    },
    saveSessionManualCorrection: async (sessionId, edit, expected) => {
      await mutateManualCorrection(sessionId, expected, (session, patches, sourceHash) => applyManualCorrectionEdit(
        session.transcript, patches, edit, sourceHash, generateId(), expected.target === 'draft' ? 'proposed' : 'applied',
        expected.target === 'draft' ? session.correction!.draft!.config.safetyLimits
          : session.correction?.published?.safetyLimits || DEFAULT_CORRECTION_PATCH_LIMITS,
      ))
    },
    changeSessionCorrectionPatchState: async (sessionId, patchId, state, expected, confirmedConflictIds) => {
      await mutateManualCorrection(sessionId, expected, (session, patches, sourceHash) => {
        const current = patches.find((patch) => patch.id === patchId)
        if (!current || current.state === 'rejected') throw new Error('patch-not-editable')
        if (state === 'applied') {
          const next = applyManualCorrectionEdit(session.transcript, patches, {
            patchId, sourceStart: current.sourceStart, sourceEnd: current.sourceEnd, sourceText: current.sourceText,
            replacement: current.replacement, confirmedConflictIds,
          }, sourceHash, current.id, expected.target === 'draft' ? 'proposed' : 'applied',
          expected.target === 'draft' ? session.correction!.draft!.config.safetyLimits
            : session.correction?.published?.safetyLimits || DEFAULT_CORRECTION_PATCH_LIMITS)
          return next.map((patch) => patch.id === patchId ? { ...patch, origin: current.origin } : patch)
        }
        return setCorrectionPatchState(patches, patchId, 'reverted')
      })
    },
    restoreSessionLegacyCorrection: async (sessionId) => {
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        if (!session?.correction?.legacy || session.correction.draft || session.correction.published) return
        await checkpointCorrection(sessionId, {
          ...session.correction,
          status: 'idle',
          correctedText: undefined,
          legacy: undefined,
          error: undefined,
        })
      })
    },
    setSessionCorrectionPatchState: async (sessionId, patchId, state) => {
      const published = get().sessions.find((item) => item.id === sessionId)?.correction?.published
      if (!published) return
      await get().changeSessionCorrectionPatchState(sessionId, patchId, state, {
        target: 'published', id: published.id, revision: published.revision, baseTranscriptHash: published.baseTranscriptHash,
      })
    },
    revertAllSessionCorrectionPatches: async (sessionId) => {
      const published = get().sessions.find((item) => item.id === sessionId)?.correction?.published
      if (!published) return
      await mutateManualCorrection(sessionId, { target: 'published', id: published.id, revision: published.revision,
        baseTranscriptHash: published.baseTranscriptHash }, (_session, patches) => revertAllCorrectionPatches(patches))
    },
  }
})
