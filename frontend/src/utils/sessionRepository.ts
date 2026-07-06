import type { TranscriptSession } from '../types'
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

const STALE_CORRECTION_ERROR = 'AI 纠错未完成，请重新启动纠错'

export type SessionProgressSnapshot = TranscriptPersistenceSnapshot

export interface SessionLaunchState {
  sessions: TranscriptSession[]
  recoverableSession: TranscriptSession | null
}

let cachedSessions: TranscriptSession[] = []
let cacheReady = false

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

  void upsertSession(targetSession).catch((error) => {
    console.error('[sessionRepository] Failed to persist session:', error)
  })

  return nextSessions
}

function persistSessionBatch(sessionIds: string[], sessions: TranscriptSession[]): TranscriptSession[] {
  const nextSessions = updateCachedSessions(sessions)
  const targets = nextSessions.filter((session) => sessionIds.includes(session.id))

  if (targets.length === 0) {
    return nextSessions
  }

  void upsertSessions(targets).catch((error) => {
    console.error('[sessionRepository] Failed to persist session batch:', error)
  })

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

function recoverStaleCorrection(session: TranscriptSession, now: number): TranscriptSession {
  const status = session.correction?.status
  if (status !== 'detecting' && status !== 'correcting') {
    return session
  }

  return {
    ...session,
    correction: {
      ...session.correction,
      mode: session.correction?.mode ?? 'quick',
      status: 'error',
      error: STALE_CORRECTION_ERROR,
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

    const staleCorrectionSessionIds: string[] = []

    sessions = sessions.map((session) => {
      const correctionStatus = session.correction?.status
      const nextSession = correctionStatus === 'detecting' || correctionStatus === 'correcting'
        ? recoverStaleCorrection(session, now)
        : session

      if (nextSession !== session) {
        staleCorrectionSessionIds.push(session.id)
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
        ...staleCorrectionSessionIds,
      ]))
      : Array.from(new Set([...interruptedSessionIds, ...staleCorrectionSessionIds]))

    if (sessionIdsToPersist.length > 0) {
      sessions = persistSessionBatch(sessionIdsToPersist, sessions)
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

  saveProgress(sessionId: string, snapshot: SessionProgressSnapshot): TranscriptSession[] {
    const now = Date.now()
    const sessions = updateSessionCollection(getCachedSessions(), sessionId, {
      transcript: snapshot.transcript,
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
