import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSession } from '../types'

const sessionRepositoryMock = vi.hoisted(() => ({
  loadForLaunch: vi.fn(),
  updateMetadata: vi.fn(),
}))

const aiCorrectionMock = vi.hoisted(() => ({
  detectCorrectionIssues: vi.fn(),
  correctTranscriptQuick: vi.fn(),
  correctTranscriptWithReview: vi.fn(),
}))

vi.mock('../utils/sessionRepository', () => ({
  sessionRepository: sessionRepositoryMock,
}))

vi.mock('../services/aiCorrection', () => aiCorrectionMock)

function makeSession(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  return {
    id: 'session-1',
    title: 'Test Session',
    date: '2026-07-05',
    time: '19:30',
    createdAt: 1,
    updatedAt: 1,
    transcript: 'hello world',
    segments: [],
    speakers: [],
    status: 'completed',
    ...overrides,
  }
}

describe('sessionStore correction recovery', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recovers stale correcting state when no correction request is in flight', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const staleSession = makeSession({
      correction: {
        status: 'correcting',
        mode: 'quick',
        requestedAt: 100,
      },
    })
    sessionRepositoryMock.updateMetadata.mockImplementation((_sessionId: string, updates: Partial<TranscriptSession>) => [
      { ...staleSession, ...updates },
    ])

    useSessionStore.setState({
      sessions: [staleSession],
      recoverySession: null,
      correctionStreamingText: { 'session-1': 'partial text' },
      correctionInFlight: {},
    })

    useSessionStore.getState().recoverStaleSessionCorrection('session-1')

    expect(sessionRepositoryMock.updateMetadata).toHaveBeenCalledWith('session-1', {
      correction: expect.objectContaining({
        status: 'error',
        mode: 'quick',
        error: expect.stringContaining('AI 纠错未完成'),
      }),
    })
    expect(useSessionStore.getState().sessions[0].correction).toEqual(expect.objectContaining({
      status: 'error',
      mode: 'quick',
    }))
    expect(useSessionStore.getState().correctionStreamingText['session-1']).toBeUndefined()
  })

  it('keeps correcting state when a correction request is still in flight', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const activeSession = makeSession({
      correction: {
        status: 'correcting',
        mode: 'quick',
        requestedAt: 100,
      },
    })

    useSessionStore.setState({
      sessions: [activeSession],
      recoverySession: null,
      correctionStreamingText: { 'session-1': 'partial text' },
      correctionInFlight: { 'session-1': true },
    })

    useSessionStore.getState().recoverStaleSessionCorrection('session-1')

    expect(sessionRepositoryMock.updateMetadata).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].correction?.status).toBe('correcting')
    expect(useSessionStore.getState().correctionStreamingText['session-1']).toBe('partial text')
  })

  it('auto-detects correction issues only when enabled and eligible', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const { useSettingsStore } = await import('./settingsStore')
    const session = makeSession()
    aiCorrectionMock.detectCorrectionIssues.mockResolvedValue({
      model: 'qwen2.5',
      issues: [{
        id: '1',
        originalText: 'difine',
        suggestedText: 'dify',
        reason: 'glossary',
        category: 'proper-noun',
      }],
    })
    sessionRepositoryMock.updateMetadata.mockImplementation((_sessionId: string, updates: Partial<TranscriptSession>) => [
      { ...session, ...updates },
    ])

    useSettingsStore.setState({
      settings: {
        apiKey: '',
        languageHints: [],
        aiPostProcess: {
          enabled: true,
          autoCorrectionDetection: true,
          model: 'qwen2.5',
        },
      } as never,
    })
    useSessionStore.setState({
      sessions: [session],
      correctionInFlight: {},
    })

    await useSessionStore.getState().maybeAutoDetectSessionCorrection('session-1')

    expect(aiCorrectionMock.detectCorrectionIssues).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        aiPostProcess: expect.objectContaining({ autoCorrectionDetection: true }),
      }),
    )
    expect(sessionRepositoryMock.updateMetadata).toHaveBeenLastCalledWith('session-1', {
      correction: expect.objectContaining({
        status: 'reviewing',
        mode: 'review',
        model: 'qwen2.5',
      }),
    })

    aiCorrectionMock.detectCorrectionIssues.mockClear()
    useSettingsStore.setState({
      settings: {
        apiKey: '',
        languageHints: [],
        aiPostProcess: {
          enabled: true,
          autoCorrectionDetection: false,
          model: 'qwen2.5',
        },
      } as never,
    })
    await useSessionStore.getState().maybeAutoDetectSessionCorrection('session-1')
    expect(aiCorrectionMock.detectCorrectionIssues).not.toHaveBeenCalled()
  })

  it('persists edited review suggestions before applying accepted issues', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const { useSettingsStore } = await import('./settingsStore')
    const session = makeSession({
      correction: {
        status: 'reviewing',
        mode: 'review',
        issues: [
          {
            id: '1',
            originalText: 'difine',
            suggestedText: 'define',
            reason: 'AI guess',
            category: 'proper-noun',
          },
          {
            id: '2',
            originalText: 'keep',
            suggestedText: 'skip',
            reason: 'Rejected',
            category: 'other',
          },
        ],
      },
    })
    aiCorrectionMock.correctTranscriptWithReview.mockImplementation((_session, issues, _settings, callbacks) => {
      callbacks.onDone(`corrected with ${issues[0].suggestedText}`)
      return Promise.resolve()
    })
    sessionRepositoryMock.updateMetadata.mockImplementation((_sessionId: string, updates: Partial<TranscriptSession>) => [
      { ...session, ...updates },
    ])
    useSettingsStore.setState({
      settings: {
        apiKey: '',
        languageHints: [],
        aiPostProcess: { enabled: true, model: 'qwen2.5' },
      } as never,
    })
    useSessionStore.setState({
      sessions: [session],
      correctionInFlight: {},
      correctionStreamingText: {},
    })

    await useSessionStore.getState().startSessionReviewCorrection('session-1', [
      {
        id: '1',
        originalText: 'difine',
        suggestedText: 'dify',
        reason: 'edited',
        category: 'proper-noun',
        accepted: true,
      },
    ])

    expect(aiCorrectionMock.correctTranscriptWithReview).toHaveBeenCalledWith(
      session,
      [expect.objectContaining({ id: '1', suggestedText: 'dify' })],
      expect.anything(),
      expect.anything(),
    )
    expect(sessionRepositoryMock.updateMetadata).toHaveBeenCalledWith('session-1', {
      correction: expect.objectContaining({
        status: 'correcting',
        issues: [
          expect.objectContaining({ id: '1', suggestedText: 'dify', accepted: true }),
          expect.objectContaining({ id: '2', suggestedText: 'skip', accepted: false }),
        ],
      }),
    })
  })

  it('returns recording archive recovery summary and links recovered audio to matching sessions', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const session = makeSession({
      sourceMeta: {
        captureMode: 'system-audio',
        sourceKind: 'recording-audio',
      },
    })
    const recoverRecordingArchives = vi.fn().mockResolvedValue({
      ok: true,
      recovered: [
        {
          ok: true,
          sessionId: 'session-1',
          path: 'C:/Users/test/AppData/Roaming/DeLive/media/session-1/source-audio.wav',
          mimeType: 'audio/wav',
          fileName: 'source-audio.wav',
          size: 46,
        },
        {
          ok: true,
          sessionId: 'missing-session',
          path: 'C:/Users/test/AppData/Roaming/DeLive/media/missing-session/source-audio.wav',
          mimeType: 'audio/wav',
          fileName: 'source-audio.wav',
          size: 46,
        },
      ],
      skipped: [{ sessionId: 'empty-session', reason: 'empty-audio' }],
    })
    vi.stubGlobal('window', { electronAPI: { recoverRecordingArchives } })
    sessionRepositoryMock.loadForLaunch.mockResolvedValue({ sessions: [session], recoverableSession: null })
    sessionRepositoryMock.updateMetadata.mockImplementation((_sessionId: string, updates: Partial<TranscriptSession>) => [
      { ...session, ...updates },
    ])

    const summary = await useSessionStore.getState().loadSessions()

    expect(summary).toEqual({
      recoveredCount: 2,
      linkedCount: 1,
      unlinkedCount: 1,
      skippedCount: 1,
    })
    expect(sessionRepositoryMock.updateMetadata).toHaveBeenCalledWith('session-1', {
      sourceMeta: expect.objectContaining({
        audioPath: 'C:/Users/test/AppData/Roaming/DeLive/media/session-1/source-audio.wav',
        audioMimeType: 'audio/wav',
        audioFileName: 'source-audio.wav',
        audioSize: 46,
      }),
    })
  })
})
