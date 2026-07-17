import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSession } from '../types'

const sessionStorageMock = vi.hoisted(() => ({
  getSessions: vi.fn<() => Promise<TranscriptSession[]>>(),
  saveSessions: vi.fn<(sessions: TranscriptSession[]) => Promise<void>>(),
  upsertSession: vi.fn<(session: TranscriptSession) => Promise<void>>(),
  upsertSessions: vi.fn<(sessions: TranscriptSession[]) => Promise<void>>(),
  deleteSessionById: vi.fn<(sessionId: string) => Promise<void>>(),
}))

vi.mock('./sessionStorage', () => sessionStorageMock)

function makeSession(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  return {
    id: 'session-1',
    title: 'Test Session',
    date: '2026-03-09',
    time: '12:00',
    createdAt: 1,
    updatedAt: 1,
    transcript: '',
    ...overrides,
  }
}

describe('sessionRepository persistence strategy', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    sessionStorageMock.getSessions.mockResolvedValue([])
    sessionStorageMock.saveSessions.mockResolvedValue(undefined)
    sessionStorageMock.upsertSession.mockResolvedValue(undefined)
    sessionStorageMock.upsertSessions.mockResolvedValue(undefined)
    sessionStorageMock.deleteSessionById.mockResolvedValue(undefined)
  })

  it('persists draft creation via single-session upsert', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    const draft = makeSession({ id: 'draft-1' })

    const sessions = sessionRepository.createDraft(draft)

    expect(sessions[0].id).toBe('draft-1')
    await vi.waitFor(() => expect(sessionStorageMock.upsertSession).toHaveBeenCalledTimes(1))
    expect(sessionStorageMock.upsertSession).toHaveBeenCalledTimes(1)
    expect(sessionStorageMock.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'draft-1' }),
    )
    expect(sessionStorageMock.saveSessions).not.toHaveBeenCalled()
  })

  it('persists progress updates via single-session upsert', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    const draft = makeSession({ id: 'draft-2' })

    sessionRepository.createDraft(draft)
    await vi.waitFor(() => expect(sessionStorageMock.upsertSession).toHaveBeenCalledTimes(1))
    sessionStorageMock.upsertSession.mockClear()

    const sessions = sessionRepository.saveProgress('draft-2', {
      transcript: 'hello world',
    })

    expect(sessions[0].transcript).toBe('hello world')
    await vi.waitFor(() => expect(sessionStorageMock.upsertSession).toHaveBeenCalledTimes(1))
    expect(sessionStorageMock.upsertSession).toHaveBeenCalledTimes(1)
    expect(sessionStorageMock.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'draft-2',
        transcript: 'hello world',
        status: 'recording',
      }),
    )
    expect(sessionStorageMock.saveSessions).not.toHaveBeenCalled()
  })

  it('marks interrupted sessions in batch on launch recovery', async () => {
    sessionStorageMock.getSessions.mockResolvedValue([
      makeSession({ id: 'recording-1', status: 'recording', transcript: 'alpha' }),
      makeSession({ id: 'completed-1', status: 'completed', transcript: 'beta' }),
      makeSession({ id: 'recording-2', status: 'recording', transcript: 'gamma' }),
    ])

    const { sessionRepository } = await import('./sessionRepository')
    const result = await sessionRepository.loadForLaunch()

    expect(result.sessions.filter((session) => session.status === 'interrupted')).toHaveLength(2)
    expect(sessionStorageMock.upsertSessions).toHaveBeenCalledTimes(1)
    const persistedSessions = sessionStorageMock.upsertSessions.mock.calls[0]?.[0] ?? []
    expect(persistedSessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'recording-1', status: 'interrupted' }),
      expect.objectContaining({ id: 'recording-2', status: 'interrupted' }),
    ]))
    expect(sessionStorageMock.saveSessions).not.toHaveBeenCalled()
  })

  it('restores interrupted patch drafts to queued without discarding published output', async () => {
    const draft = {
      runId: 'run-1', revision: 1, trigger: 'manual-quick', mode: 'quick', status: 'running',
      baseTranscriptHash: 'hash', requestedAt: 100, updatedAt: 100, proposedPatches: [], rejectedPatches: [],
      config: {
        model: 'm', baseUrl: 'http://localhost/v1', promptLanguage: 'zh', promptVersion: 'patch-v1', schemaVersion: '1',
        structuredOutput: 'prompt-json', temperature: 0.1, glossary: [], chunkSize: 4000, contextSize: 500,
        concurrency: 1, safetyLimits: { maxPatchTextLength: 1000, maxPatchesPerShard: 100, maxCumulativeEditRatio: 0.2, maxNetLengthChangeRatio: 0.1 },
        credentialRef: 'ai-post-process',
      },
      shards: [{ id: 's1', index: 0, coreStart: 0, coreEnd: 5, contextStart: 0, contextEnd: 5, status: 'running', attempt: 1, attemptId: 'a', draftRevision: 1 }],
    } as const
    sessionStorageMock.getSessions.mockResolvedValue([
      makeSession({
        id: 'correcting-1',
        status: 'completed',
        transcript: 'alpha',
        correction: {
          status: 'detecting',
          mode: 'quick',
          draft: draft as never,
        },
      }),
    ])

    const { sessionRepository } = await import('./sessionRepository')
    const result = await sessionRepository.loadForLaunch()

    expect(result.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'correcting-1',
        correction: expect.objectContaining({ draft: expect.objectContaining({ status: 'queued', revision: 2 }) }),
      }),
    ]))
    expect(sessionStorageMock.upsertSessions).toHaveBeenCalledTimes(1)
    expect(sessionStorageMock.upsertSessions).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'correcting-1' }),
    ]))
    expect(sessionStorageMock.saveSessions).not.toHaveBeenCalled()
  })

  it('persists upgraded sessions on launch even without interruption', async () => {
    sessionStorageMock.getSessions.mockResolvedValue([
      makeSession({ id: 'legacy-1', schemaVersion: 1, tagIds: undefined }),
    ])

    const { sessionRepository } = await import('./sessionRepository')
    const result = await sessionRepository.loadForLaunch()

    expect(result.sessions[0]).toEqual(expect.objectContaining({
      id: 'legacy-1',
      schemaVersion: 4,
      tagIds: [],
    }))
    expect(sessionStorageMock.upsertSessions).toHaveBeenCalledTimes(1)
    expect(sessionStorageMock.upsertSessions).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'legacy-1', schemaVersion: 4 }),
    ])
  })

  it('serializes awaitable correction checkpoints per session', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    const base = makeSession({ id: 'checkpoint-1', transcript: 'hello' })
    sessionRepository.createDraft(base)
    await vi.waitFor(() => expect(sessionStorageMock.upsertSession).toHaveBeenCalled())
    sessionStorageMock.upsertSession.mockClear()
    const releases: Array<() => void> = []
    sessionStorageMock.upsertSession.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)))
    const first = sessionRepository.checkpointCorrection('checkpoint-1', { status: 'detecting', mode: 'review' })
    const second = sessionRepository.checkpointCorrection('checkpoint-1', { status: 'error', mode: 'review', error: 'failed' })
    await vi.waitFor(() => expect(sessionStorageMock.upsertSession).toHaveBeenCalledTimes(1))
    releases.shift()?.()
    await vi.waitFor(() => expect(sessionStorageMock.upsertSession).toHaveBeenCalledTimes(2))
    expect(sessionStorageMock.upsertSession).toHaveBeenCalledTimes(2)
    releases.shift()?.()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('does not advance the committed cache when a correction checkpoint fails', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    const base = makeSession({ id: 'checkpoint-failure', transcript: 'hello' })
    sessionRepository.createDraft(base)
    await vi.waitFor(() => expect(sessionStorageMock.upsertSession).toHaveBeenCalled())
    sessionStorageMock.upsertSession.mockRejectedValueOnce(new Error('disk full'))

    await expect(sessionRepository.checkpointCorrection('checkpoint-failure', {
      status: 'detecting', mode: 'review',
    })).rejects.toThrow('disk full')

    sessionStorageMock.upsertSession.mockResolvedValue(undefined)
    const sessions = sessionRepository.updateMetadata('checkpoint-failure', { title: 'Still committed' })
    expect(sessions[0].correction).toBeUndefined()
  })

  it('uses full replace only for replaceAllSessions', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    const sessions = [
      makeSession({ id: 'session-a' }),
      makeSession({ id: 'session-b', createdAt: 2, updatedAt: 2 }),
    ]

    sessionRepository.replaceAllSessions(sessions)

    expect(sessionStorageMock.saveSessions).toHaveBeenCalledTimes(1)
    expect(sessionStorageMock.upsertSession).not.toHaveBeenCalled()
    expect(sessionStorageMock.upsertSessions).not.toHaveBeenCalled()
  })
})
