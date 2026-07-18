import { create } from 'zustand'
import type {
  CorrectionIssue,
  CorrectionShardProgress,
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
  requestCorrectionShard,
} from '../services/aiCorrection'
import {
  createCorrectionShards,
  materializeCorrection,
  partitionCorrectionPatchConflicts,
  resolveCorrectionPatches,
  sha256Utf8,
  setCorrectionPatchState,
  revertAllCorrectionPatches,
  validateCorrectionPatchSet,
  validateResolvedCorrectionPatch,
  updateCorrectionPatchReplacement,
} from '../utils/correctionPatch'
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

interface CorrectionExecutionLease {
  runId: string
  generation: number
  controller: AbortController
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
  maybeStartAutoAiPostProcess: (sessionId: string) => Promise<void>
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
  applySessionCorrectionReview: (sessionId: string, patchIds: string[]) => Promise<string>
  updateSessionCorrectionDraftPatch: (sessionId: string, patchId: string, replacement: string) => Promise<void>
  restoreSessionLegacyCorrection: (sessionId: string) => Promise<void>
  setSessionCorrectionPatchState: (sessionId: string, patchId: string, state: 'applied' | 'reverted') => Promise<void>
  revertAllSessionCorrectionPatches: (sessionId: string) => Promise<void>

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

  const checkpointCorrection = async (sessionId: string, correction: TranscriptCorrection) => {
    const sessions = await sessionRepository.checkpointCorrection(sessionId, correction)
    const recoverySession = get().recoverySession
    set({
      sessions,
      recoverySession: recoverySession?.id === sessionId ? { ...recoverySession, correction } : recoverySession,
    })
  }

  const enqueueCorrectionMutation = <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = correctionMutationQueues.get(sessionId) || Promise.resolve()
    const current = previous.then(operation)
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

  const runCorrectionDraft = async (sessionId: string): Promise<string | null> => {
    const session = get().sessions.find((item) => item.id === sessionId)
    const draft = session?.correction?.draft
    if (!session || !draft) throw new Error('未找到可运行的纠错任务')
    const runId = draft.runId
    const existingLease = correctionExecutionLeases.get(sessionId)
    if (existingLease) return null
    const lease: CorrectionExecutionLease = {
      runId,
      generation: ++correctionExecutionGeneration,
      controller: new AbortController(),
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
              apiKey: useSettingsStore.getState().settings.aiPostProcess?.apiKey,
              signal: lease.controller.signal,
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
                  ? { ...item, status: 'failed' as const, errorCode: code, error: message, draftRevision: revision }
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
      const settings = useSettingsStore.getState().settings
      const config = createCorrectionConfigSnapshot(settings)
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
      return await runCorrectionDraft(sessionId)
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

    if (session.title === workflow.titleAtStart) {
      get().updateSessionTitle(sessionId, titleSuggestion)
    }
    updateAutoPostProcessWorkflow(sessionId, {
      status: 'completed',
      step: 'title',
      completedAt: Date.now(),
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
          return
        }

        updateAutoPostProcessWorkflow(sessionId, { status: 'running', error: undefined })
        await finishAutoPostProcessTitle(sessionId)
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
        void get().maybeStartAutoAiPostProcess(currentSessionId)
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

      for (const session of sessions) {
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
        await runCorrectionDraft(sessionId)
      } catch (error) {
        if (workflow?.step === 'correction') failAutoPostProcessWorkflow(sessionId, error, 'correction')
        throw error
      }
      if (workflow?.step === 'correction') await runAutoAiPostProcessWorkflow(sessionId)
    },
    retrySessionCorrection: async (sessionId) => {
      const workflow = get().sessions.find((item) => item.id === sessionId)?.autoPostProcessWorkflow
      if (workflow?.step === 'correction' && workflow.status !== 'completed') {
        updateAutoPostProcessWorkflow(sessionId, { status: 'queued', error: undefined })
      }
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        const draft = session?.correction?.draft
        if (!session || !draft) return
        const revision = draft.revision + 1
        const queued = { ...draft, status: 'queued' as const, error: undefined, errorCode: undefined, pauseRequested: false, revision, updatedAt: Date.now(), shards: draft.shards.map((shard) => shard.status === 'failed' || shard.status === 'running' || shard.status === 'retrying' ? { ...shard, status: 'pending' as const, attemptId: undefined, error: undefined, errorCode: undefined, draftRevision: revision } : shard) }
        await checkpointCorrection(sessionId, { ...session.correction!, status: 'detecting', error: undefined, draft: queued })
      })
      try {
        await runCorrectionDraft(sessionId)
      } catch (error) {
        if (workflow?.step === 'correction') failAutoPostProcessWorkflow(sessionId, error, 'correction')
        throw error
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
    applySessionCorrectionReview: async (sessionId, patchIds) => {
      let output = ''
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        const draft = session?.correction?.draft
        if (!session || !draft || draft.status !== 'ready-for-review') throw new Error('没有可应用的 Review 候选')
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
    updateSessionCorrectionDraftPatch: async (sessionId, patchId, replacement) => {
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        const draft = session?.correction?.draft
        if (!session || !draft || draft.status !== 'ready-for-review') throw new Error('没有可编辑的 Review 候选')
        const current = draft.proposedPatches.find((patch) => patch.id === patchId)
        if (!current) throw new Error('未找到要编辑的 Patch')
        const edited = updateCorrectionPatchReplacement(session.transcript, current, replacement, draft.baseTranscriptHash, draft.config.safetyLimits)
        if (!edited.patch) throw new Error(`建议文本不合法: ${edited.error}`)
        const proposedPatches = draft.proposedPatches.map((patch) => patch.id === patchId ? edited.patch! : patch)
        if (partitionCorrectionPatchConflicts(proposedPatches).rejected.length > 0) throw new Error('编辑后的 Patch 与其他候选冲突')
        const safetyError = validateCorrectionPatchSet(session.transcript, proposedPatches, draft.config.safetyLimits)
        if (safetyError) throw new Error(`编辑后的 Patch 超过安全限制: ${safetyError}`)
        const revision = draft.revision + 1
        const nextDraft = {
          ...draft,
          revision,
          updatedAt: Date.now(),
          proposedPatches,
          shards: draft.shards.map((shard) => ({
            ...shard,
            patches: shard.patches?.map((patch) => patch.id === patchId ? edited.patch! : patch),
          })),
        }
        await checkpointCorrection(sessionId, { ...session.correction!, draft: nextDraft })
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
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        const published = session?.correction?.published
        if (!session || !published) return
        if (await sha256Utf8(session.transcript) !== published.baseTranscriptHash) throw new Error('原始转录已变化，无法修改已发布 Patch')
        const patches = setCorrectionPatchState(published.patches, patchId, state)
        const active = patches.filter((patch) => patch.state === 'applied')
        for (const patch of active) {
          const maxPatchTextLength = Math.max(1_000, patch.sourceText.length, patch.replacement.length)
          const validationError = validateResolvedCorrectionPatch(session.transcript, patch, published.baseTranscriptHash, {
            maxPatchTextLength,
            maxPatchesPerShard: Number.MAX_SAFE_INTEGER,
            maxCumulativeEditRatio: Number.MAX_SAFE_INTEGER,
            maxNetLengthChangeRatio: Number.MAX_SAFE_INTEGER,
          })
          if (validationError) throw new Error(`已发布 Patch 校验失败: ${validationError}`)
        }
        if (partitionCorrectionPatchConflicts(active).rejected.length > 0) throw new Error('已发布 Patch 状态产生冲突')
        const correctedText = materializeCorrection(session.transcript, patches)
        const nextPublished = { ...published, revision: published.revision + 1, patches, correctedText, outputTextHash: await sha256Utf8(correctedText), stats: { ...published.stats, applied: patches.filter((patch) => patch.state === 'applied').length, reverted: patches.filter((patch) => patch.state === 'reverted').length } }
        await checkpointCorrection(sessionId, { ...session.correction!, correctedText, published: nextPublished })
      })
    },
    revertAllSessionCorrectionPatches: async (sessionId) => {
      await enqueueCorrectionMutation(sessionId, async () => {
        const session = get().sessions.find((item) => item.id === sessionId)
        const published = session?.correction?.published
        if (!session || !published) return
        const patches = revertAllCorrectionPatches(published.patches)
        const outputTextHash = await sha256Utf8(session.transcript)
        await checkpointCorrection(sessionId, { ...session.correction!, correctedText: session.transcript, published: { ...published, revision: published.revision + 1, patches, correctedText: session.transcript, outputTextHash, stats: { ...published.stats, applied: 0, reverted: patches.filter((patch) => patch.state === 'reverted').length } } })
      })
    },
  }
})
