import type { TranscriptCorrection, TranscriptSession } from '../types'
import {
  deleteSessionById,
  getSessions,
  saveSessions,
  upsertSession,
  upsertSessions,
} from './sessionStorage'
import {
  normalizeTranscriptSession,
  upgradeTranscriptSessions,
} from './sessionSchema'
import type { TranscriptPersistenceSnapshot } from './sessionSnapshot'
import { hasPostProcessContent } from './transcriptState'

export type SessionProgressSnapshot = TranscriptPersistenceSnapshot

export interface SessionLaunchState {
  sessions: TranscriptSession[]
  recoverableSession: TranscriptSession | null
}

let cachedSessions: TranscriptSession[] = []
let cacheReady = false
const sessionWriteQueues = new Map<string, Promise<void>>()
const pendingCorrections = new Map<string, TranscriptCorrection>()

function enqueueSessionWrite(sessionId: string, operation: () => Promise<void>): Promise<void> {
  const previous = sessionWriteQueues.get(sessionId) || Promise.resolve()
  const write = previous.then(operation)
  sessionWriteQueues.set(sessionId, write)
  void write.finally(() => {
    if (sessionWriteQueues.get(sessionId) === write) sessionWriteQueues.delete(sessionId)
  }).catch(() => undefined)
  return write
}

function normalizeSession(session: TranscriptSession): TranscriptSession {
  return normalizeTranscriptSession(session)
}

function getCachedSessions(): TranscriptSession[] {
  return cachedSessions.map(normalizeSession)
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
  const nextSessions = updateCachedSessions(sessions)
  const targetSession = nextSessions.find((session) => session.id === sessionId)

  if (!targetSession) {
    return nextSessions
  }

  const pendingCorrection = pendingCorrections.get(sessionId)
  const durableTarget = pendingCorrection
    ? normalizeSession({ ...targetSession, correction: pendingCorrection })
    : targetSession
  void enqueueSessionWrite(sessionId, () => upsertSession(durableTarget)).catch((error) => {
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

    if (sessionIdsToPersist.length > 0) {
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

  async checkpointCorrection(sessionId: string, correction: NonNullable<TranscriptSession['correction']>): Promise<TranscriptSession[]> {
    const sessions = updateSessionCollection(getCachedSessions(), sessionId, { correction })
    const target = sessions.find((session) => session.id === sessionId)
    if (!target) throw new Error(`Session ${sessionId} was not found for correction checkpoint`)
    pendingCorrections.set(sessionId, correction)
    try {
      await enqueueSessionWrite(sessionId, () => upsertSession(target))
      const committed = updateSessionCollection(getCachedSessions(), sessionId, { correction })
      return updateCachedSessions(committed)
    } finally {
      if (pendingCorrections.get(sessionId) === correction) pendingCorrections.delete(sessionId)
    }
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
