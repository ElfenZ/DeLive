import type { TranscriptCorrection, TranscriptSession } from '../types'
import {
  deleteSessionById,
  getSessions,
  migrateProjectSessions,
  saveSessions,
  upsertSession,
  upsertSessionStrict,
  upsertSessions,
} from './sessionStorage'
import {
  normalizeTranscriptSession,
  upgradeTranscriptSessions,
} from './sessionSchema'
import type { TranscriptPersistenceSnapshot } from './sessionSnapshot'
import { hasPostProcessContent } from './transcriptState'
import { deleteSessionPreservingResults, getDeletedSessionSnapshots } from './deletedSessionStorage'
import { startPerformanceSpan } from '../../../shared/performanceDiagnostics'

export type SessionProgressSnapshot = TranscriptPersistenceSnapshot

export interface SessionLaunchState {
  sessions: TranscriptSession[]
  recoverableSession: TranscriptSession | null
}

let cachedSessions: TranscriptSession[] = []
let cacheReady = false
const sessionWriteQueues = new Map<string, Promise<void>>()
const deletingSessionIds = new Set<string>()
const normalizedRecords = new WeakSet<TranscriptSession>()

function enqueueSessionWrite(sessionId: string, operation: () => Promise<void>): Promise<void> {
  const previous = sessionWriteQueues.get(sessionId) || Promise.resolve()
  const write = previous.catch(() => undefined).then(operation)
  sessionWriteQueues.set(sessionId, write)
  void write.finally(() => {
    if (sessionWriteQueues.get(sessionId) === write) sessionWriteQueues.delete(sessionId)
  }).catch(() => undefined)
  return write
}

function normalizeSession(session: TranscriptSession): TranscriptSession {
  if (normalizedRecords.has(session)) return session
  const normalized = normalizeTranscriptSession(session)
  normalizedRecords.add(normalized)
  return normalized
}

function getCachedSessions(): TranscriptSession[] {
  return [...cachedSessions]
}

function updateCachedSessions(sessions: TranscriptSession[]): TranscriptSession[] {
  cachedSessions = sessions.map(normalizeSession)
  cacheReady = true
  return cachedSessions
}

function persistSessions(sessions: TranscriptSession[]): TranscriptSession[] {
  const nextSessions = updateCachedSessions(sessions)

  void saveSessions(nextSessions).catch((error) => {
    console.error('[sessionRepository] Failed to persist sessions:', error)
  })

  return nextSessions
}

function persistSingleSession(sessionId: string, sessions: TranscriptSession[]): TranscriptSession[] {
  if (deletingSessionIds.has(sessionId)) return getCachedSessions()
  const nextSessions = updateCachedSessions(sessions)
  const targetSession = nextSessions.find((session) => session.id === sessionId)

  if (!targetSession) {
    return nextSessions
  }

  void enqueueSessionWrite(sessionId, () => {
    // A metadata write queued during a checkpoint must use the committed correction,
    // not resurrect a failed checkpoint or overwrite a successful one with old data.
    const committedCorrection = cachedSessions.find((session) => session.id === sessionId)?.correction
    return upsertSession(normalizeSession({ ...targetSession, correction: committedCorrection }))
  }).catch((error) => {
    console.error('[sessionRepository] Failed to persist session:', error)
  })

  return nextSessions
}

async function persistSessionBatch(sessionIds: string[], sessions: TranscriptSession[]): Promise<TranscriptSession[]> {
  const nextSessions = updateCachedSessions(sessions)
  const targets = nextSessions.filter((session) => sessionIds.includes(session.id))

  if (targets.length === 0) {
    return nextSessions
  }

  await upsertSessions(targets)

  return nextSessions
}

function persistSessionDeletion(sessionId: string, sessions: TranscriptSession[]): TranscriptSession[] {
  const nextSessions = updateCachedSessions(sessions)

  void deleteSessionById(sessionId).catch((error) => {
    console.error('[sessionRepository] Failed to delete session:', error)
  })

  return nextSessions
}

function updateSessionCollection(
  sessions: TranscriptSession[],
  sessionId: string,
  updates: Partial<TranscriptSession>
): TranscriptSession[] {
  const now = Date.now()

  return sessions.map((session) => {
    if (session.id !== sessionId) {
      return session
    }

    return {
      ...session,
      ...updates,
      updatedAt: now,
      lastPersistedAt: updates.lastPersistedAt ?? session.lastPersistedAt ?? now,
    }
  })
}

function recoverInterruptedDraft(session: TranscriptSession, now: number): TranscriptSession {
  const draft = session.correction?.draft
  if (!draft || draft.status === 'paused' || draft.pauseRequested) return session
  if (draft.status !== 'running' && draft.status !== 'retrying') return session
  return {
    ...session,
    correction: {
      status: session.correction?.status || 'detecting',
      mode: session.correction?.mode || draft.mode,
      ...session.correction,
      draft: {
        ...draft,
        status: 'queued',
        revision: draft.revision + 1,
        updatedAt: now,
        shards: draft.shards.map((shard) => shard.status === 'running' || shard.status === 'retrying'
          ? { ...shard, status: 'pending', attemptId: undefined, nextRetryAt: undefined, draftRevision: draft.revision + 1 }
          : shard),
      },
    },
    updatedAt: now,
  }
}

function recoverInterruptedAutoPostProcessWorkflow(session: TranscriptSession, now: number): TranscriptSession {
  const workflow = session.autoPostProcessWorkflow
  if (!workflow || workflow.status !== 'running') return session
  return {
    ...session,
    autoPostProcessWorkflow: {
      ...workflow,
      status: 'queued',
      updatedAt: now,
    },
    updatedAt: now,
  }
}

export const sessionRepository = {
  getSessionsSnapshot(): TranscriptSession[] {
    if (!cacheReady) throw new Error('Load records before changing project relationships')
    return getCachedSessions()
  },

  async loadForLaunch(): Promise<SessionLaunchState> {
    const loadedSessions = await getSessions()
    const upgraded = upgradeTranscriptSessions(loadedSessions)
    let sessions = upgraded.sessions.map(normalizeSession)
    cachedSessions = sessions
    cacheReady = true
    const interruptedSessionIds: string[] = []
    const now = Date.now()

    const staleTaskSessionIds: string[] = []

    sessions = sessions.map((session) => {
      const recoveredDraftSession = recoverInterruptedDraft(session, now)
      const nextSession = recoverInterruptedAutoPostProcessWorkflow(recoveredDraftSession, now)

      if (nextSession !== session) {
        staleTaskSessionIds.push(session.id)
      }

      if (session.status !== 'recording') {
        return nextSession
      }

      interruptedSessionIds.push(session.id)
      return {
        ...nextSession,
        status: 'interrupted',
        wasInterrupted: true,
        updatedAt: now,
        lastPersistedAt: session.lastPersistedAt ?? now,
      }
    })

    const sessionIdsToPersist = upgraded.changed
      ? Array.from(new Set([
        ...sessions.map((session) => session.id),
        ...interruptedSessionIds,
        ...staleTaskSessionIds,
      ]))
      : Array.from(new Set([...interruptedSessionIds, ...staleTaskSessionIds]))

    const projectUpgradeCommitted = await migrateProjectSessions(loadedSessions, sessions)
    if (projectUpgradeCommitted) {
      sessions = updateCachedSessions(sessions)
    } else if (sessionIdsToPersist.length > 0) {
      sessions = await persistSessionBatch(sessionIdsToPersist, sessions)
    }

    const recoverableSession = sessions.find((session) => {
      if (session.status !== 'interrupted') {
        return false
      }

      return Boolean(
        session.transcript
        || session.tokens?.length
        || session.translatedTranscript?.text
        || hasPostProcessContent(session.postProcess),
      )
    }) || null

    return { sessions, recoverableSession }
  },

  createDraft(session: TranscriptSession): TranscriptSession[] {
    const now = Date.now()
    const draftSession = normalizeSession({
      ...session,
      status: 'recording',
      lastPersistedAt: now,
      updatedAt: now,
    })

    const baseSessions = cacheReady ? getCachedSessions() : []
    const sessions = [draftSession, ...baseSessions]
    return persistSingleSession(draftSession.id, sessions)
  },

  updateMetadata(sessionId: string, updates: Partial<TranscriptSession>): TranscriptSession[] {
    const sessions = updateSessionCollection(getCachedSessions(), sessionId, updates)
    return persistSingleSession(sessionId, sessions)
  },

  async updateMetadataDurable(sessionId: string, patch: Partial<TranscriptSession> | ((session: TranscriptSession) => Partial<TranscriptSession>)): Promise<TranscriptSession[]> {
    if (deletingSessionIds.has(sessionId)) throw new Error('Session deletion is in progress')
    const span = startPerformanceSpan('repository.metadata', { records: cachedSessions.length })
    let successful = false, writes = 0
    try {
    await enqueueSessionWrite(sessionId, async () => {
      const current = cachedSessions.find((session) => session.id === sessionId)
      if (!current) throw new Error(`Session ${sessionId} does not exist`)
      const updates = typeof patch === 'function' ? patch(normalizeTranscriptSession(current)) : patch
      if (Object.entries(updates).every(([key, value]) => Object.is(current[key as keyof TranscriptSession], value))) return
      const target = normalizeSession({ ...current, ...updates, updatedAt: Date.now() })
      updateCachedSessions(cachedSessions.map((session) => session.id === sessionId ? target : session))
      const optimistic = cachedSessions.find((session) => session.id === sessionId)
      try {
        await upsertSessionStrict(target)
        writes++
      } catch (error) {
        if (cachedSessions.find((session) => session.id === sessionId) === optimistic) {
          updateCachedSessions(cachedSessions.map((session) => session.id === sessionId ? current : session))
        }
        throw error
      }
    })
    successful = true
    return getCachedSessions()
    } finally { span.finish(successful ? 'success' : 'error', { writes }) }
  },

  async importCompletedSession(session: TranscriptSession): Promise<TranscriptSession[]> {
    if (deletingSessionIds.has(session.id)) throw new Error('Record deletion is in progress')
    if ((await getDeletedSessionSnapshots()).some((snapshot) => snapshot.originalSessionId === session.id)) {
      throw new Error('This record was deleted; import again as a new task')
    }
    const existing = cachedSessions.find((item) => item.id === session.id)
    if (existing) {
      return this.updateMetadataDurable(session.id, (current) => ({
        transcript: session.transcript, tokens: session.tokens, segments: session.segments,
        speakers: session.speakers, duration: session.duration, status: 'completed',
        sourceMeta: { ...current.sourceMeta, ...session.sourceMeta },
      }))
    }
    await enqueueSessionWrite(session.id, async () => {
      const target = normalizeSession({ ...session, status: 'completed' })
      await upsertSessionStrict(target)
      updateCachedSessions([target, ...getCachedSessions().filter((item) => item.id !== session.id)])
    })
    return getCachedSessions()
  },

  async deleteSessionWithResults(sessionId: string): Promise<TranscriptSession[]> {
    if (deletingSessionIds.has(sessionId)) throw new Error('Session deletion is already in progress')
    deletingSessionIds.add(sessionId)
    try {
      await enqueueSessionWrite(sessionId, async () => {
        const session = cachedSessions.find((item) => item.id === sessionId)
        if (!session) return
        await deleteSessionPreservingResults(session)
        updateCachedSessions(getCachedSessions().filter((item) => item.id !== sessionId))
      })
    } finally {
      deletingSessionIds.delete(sessionId)
    }
    return getCachedSessions()
  },

  async checkpointCorrection(
    sessionId: string,
    correctionOrFactory: TranscriptCorrection | ((session: TranscriptSession) => Promise<TranscriptCorrection>),
  ): Promise<TranscriptSession[]> {
    if (deletingSessionIds.has(sessionId)) throw new Error('Session deletion is in progress')
    await enqueueSessionWrite(sessionId, async () => {
      const current = cachedSessions.find((session) => session.id === sessionId)
      if (!current) throw new Error(`Session ${sessionId} was not found for correction checkpoint`)
      const correction = typeof correctionOrFactory === 'function'
        ? await correctionOrFactory(normalizeTranscriptSession(current)) : correctionOrFactory
      const target = updateSessionCollection(getCachedSessions(), sessionId, { correction }).find((session) => session.id === sessionId)!
      await upsertSessionStrict(normalizeSession(target))
      updateCachedSessions(updateSessionCollection(getCachedSessions(), sessionId, { correction }))
    })
    return getCachedSessions()
  },

  saveProgress(sessionId: string, snapshot: SessionProgressSnapshot): TranscriptSession[] {
    const now = Date.now()
    const sessions = updateSessionCollection(getCachedSessions(), sessionId, {
      transcript: snapshot.transcript,
      duration: snapshot.duration,
      tokens: snapshot.tokens,
      providerId: snapshot.providerId,
      speakers: snapshot.speakers,
      segments: snapshot.segments,
      sourceMeta: snapshot.sourceMeta,
      translatedTranscript: snapshot.translatedTranscript,
      postProcess: snapshot.postProcess,
      status: 'recording',
      lastPersistedAt: now,
    })

    return persistSingleSession(sessionId, sessions)
  },

  completeSession(sessionId: string, snapshot: SessionProgressSnapshot): TranscriptSession[] {
    const now = Date.now()
    const sessions = updateSessionCollection(getCachedSessions(), sessionId, {
      transcript: snapshot.transcript,
      duration: snapshot.duration,
      tokens: snapshot.tokens,
      providerId: snapshot.providerId,
      speakers: snapshot.speakers,
      segments: snapshot.segments,
      sourceMeta: snapshot.sourceMeta,
      translatedTranscript: snapshot.translatedTranscript,
      postProcess: snapshot.postProcess,
      status: 'completed',
      lastPersistedAt: now,
    })

    return persistSingleSession(sessionId, sessions)
  },

  acknowledgeInterrupted(sessionId: string): TranscriptSession[] {
    const sessions = updateSessionCollection(getCachedSessions(), sessionId, {
      status: 'completed',
    })

    return persistSingleSession(sessionId, sessions)
  },

  replaceAllSessions(sessions: TranscriptSession[]): TranscriptSession[] {
    return persistSessions(sessions)
  },

  deleteSession(sessionId: string): TranscriptSession[] {
    const sessions = getCachedSessions().filter((session) => session.id !== sessionId)
    return persistSessionDeletion(sessionId, sessions)
  },
}
