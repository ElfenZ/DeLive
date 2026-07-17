import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CorrectionConfigSnapshot, TranscriptCorrection, TranscriptSession } from '../types'

const repository = vi.hoisted(() => ({
  loadForLaunch: vi.fn(),
  updateMetadata: vi.fn(),
  checkpointCorrection: vi.fn(),
}))
const correction = vi.hoisted(() => ({
  createCorrectionConfigSnapshot: vi.fn(),
  requestCorrectionShard: vi.fn(),
  CorrectionRequestError: class extends Error {},
}))

vi.mock('../utils/sessionRepository', () => ({ sessionRepository: repository }))
vi.mock('../services/aiCorrection', () => correction)

function session(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  return { id: 's1', title: 'Session', date: '2026-07-16', time: '12:00', createdAt: 1, updatedAt: 1, transcript: '需要侍应新的工作。', status: 'completed', ...overrides }
}

function configSnapshot(overrides: Partial<CorrectionConfigSnapshot> = {}): CorrectionConfigSnapshot {
  const safetyLimits = { maxPatchTextLength: 1000, maxPatchesPerShard: 100, maxCumulativeEditRatio: 1, maxNetLengthChangeRatio: 1 }
  return {
    model: 'model', baseUrl: 'http://localhost/v1', promptLanguage: 'zh', promptVersion: 'patch-v1', schemaVersion: '1',
    structuredOutput: 'prompt-json', temperature: 0.1, glossary: [], chunkSize: 4000, contextSize: 500, concurrency: 1,
    safetyLimits: { ...safetyLimits, ...overrides.safetyLimits }, credentialRef: 'ai-post-process', ...overrides,
  }
}

describe('sessionStore patch correction runner', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals()
    vi.resetModules()
    vi.clearAllMocks()
    correction.createCorrectionConfigSnapshot.mockReturnValue(configSnapshot())
    correction.requestCorrectionShard.mockResolvedValue({ patches: [{ op: 'replace', oldText: '侍应', replacement: '适应', before: '需要', after: '新的', category: 'homophone', reason: '同音' }] })
    repository.checkpointCorrection.mockImplementation(async (_id: string, next: TranscriptCorrection) => {
      const { useSessionStore } = await import('./sessionStore')
      const current = useSessionStore.getState().sessions[0]
      const sessions = [{ ...current, correction: next }]
      useSessionStore.setState({ sessions })
      return sessions
    })
  })

  it('quick mode checkpoints shards then atomically publishes deterministic text', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    const result = await useSessionStore.getState().startSessionQuickCorrection(source.id)
    expect(result).toBe('需要适应新的工作。')
    expect(repository.checkpointCorrection).toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].transcript).toBe(source.transcript)
    expect(useSessionStore.getState().sessions[0].correction?.published?.correctedText).toBe(result)
  })

  it('rejects a concurrent double-start before a second draft can overwrite the first', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    const first = useSessionStore.getState().startSessionQuickCorrection(source.id)
    const second = useSessionStore.getState().startSessionQuickCorrection(source.id)
    await expect(second).rejects.toThrow(/正在启动|未完成/)
    await expect(first).resolves.toBe('需要适应新的工作。')
    expect(useSessionStore.getState().sessions[0].correction?.draft).toBeUndefined()
  })

  it('review mode can apply zero selected patches locally without a second request', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().detectSessionCorrectionIssues(source.id)
    expect(useSessionStore.getState().sessions[0].correction?.draft?.status).toBe('ready-for-review')
    expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(1)
    const result = await useSessionStore.getState().applySessionCorrectionReview(source.id, [])
    expect(result).toBe(source.transcript)
    expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(1)
  })

  it('keeps a previous published result while a rerun draft is active', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ correction: { status: 'done', mode: 'quick', correctedText: 'old result', legacy: { correctedText: 'old result', source: 'v3-corrected-text' } } })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().detectSessionCorrectionIssues(source.id)
    const current = useSessionStore.getState().sessions[0].correction
    expect(current?.correctedText).toBe('old result')
    expect(current?.draft?.status).toBe('ready-for-review')
  })

  it('persists a valid Review replacement edit and applies it without another request', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().detectSessionCorrectionIssues(source.id)
    const patchId = useSessionStore.getState().sessions[0].correction!.draft!.proposedPatches[0].id
    await useSessionStore.getState().updateSessionCorrectionDraftPatch(source.id, patchId, '适配')
    const result = await useSessionStore.getState().applySessionCorrectionReview(source.id, [patchId])
    expect(result).toBe('需要适配新的工作。')
    expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(1)
  })

  it('persists finalization safety failures instead of leaving the draft running', async () => {
    correction.createCorrectionConfigSnapshot.mockReturnValue(configSnapshot({
      safetyLimits: { maxPatchTextLength: 1000, maxPatchesPerShard: 100, maxCumulativeEditRatio: 0.01, maxNetLengthChangeRatio: 1 },
    }))
    const { useSessionStore } = await import('./sessionStore')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await expect(useSessionStore.getState().startSessionQuickCorrection(source.id)).rejects.toThrow(/安全限制/)
    expect(useSessionStore.getState().sessions[0].correction?.draft).toMatchObject({ status: 'failed', errorCode: 'safety-limit' })
  })

  it('runs remote shards with the configured bounded worker concurrency', async () => {
    correction.createCorrectionConfigSnapshot.mockReturnValue(configSnapshot({ chunkSize: 4, contextSize: 0, concurrency: 2 }))
    const releases: Array<() => void> = []
    correction.requestCorrectionShard.mockImplementation(() => new Promise((resolve) => {
      releases.push(() => resolve({ patches: [] }))
    }))
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ transcript: 'abcdefgh' })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    const running = useSessionStore.getState().startSessionQuickCorrection(source.id)
    await vi.waitFor(() => expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(2))
    releases.splice(0).forEach((release) => release())
    await expect(running).resolves.toBe(source.transcript)
  })

  it('auto-resumes only queued drafts loaded at launch', async () => {
    vi.stubGlobal('window', { electronAPI: undefined })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    correction.requestCorrectionShard.mockResolvedValue({ patches: [] })
    const source = session({ transcript: 'resume' })
    const { sha256Utf8 } = await import('../utils/correctionPatch')
    const queued = session({
      transcript: source.transcript,
      correction: {
        status: 'detecting', mode: 'review',
        draft: {
          runId: 'resume-run', revision: 1, trigger: 'manual-review', mode: 'review', status: 'queued',
          baseTranscriptHash: await sha256Utf8(source.transcript), config: configSnapshot(),
          shards: [{ id: 'shard-1', index: 0, coreStart: 0, coreEnd: source.transcript.length, contextStart: 0, contextEnd: source.transcript.length, status: 'pending', attempt: 0, draftRevision: 1 }],
          proposedPatches: [], rejectedPatches: [], requestedAt: 1, updatedAt: 1,
        },
      },
    })
    repository.loadForLaunch.mockResolvedValue({ sessions: [queued], recoverableSession: null })
    const { useSessionStore } = await import('./sessionStore')
    await useSessionStore.getState().loadSessions()
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0].correction?.draft?.status).toBe('ready-for-review'))
    expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(1)
  })

  it('fences a late response after pause before it can checkpoint patches', async () => {
    let release!: () => void
    correction.requestCorrectionShard.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ patches: [{ op: 'replace', oldText: '侍应', replacement: '适应', before: '需要', after: '新的', category: 'homophone', reason: '同音' }] })
    }))
    const { useSessionStore } = await import('./sessionStore')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    const running = useSessionStore.getState().detectSessionCorrectionIssues(source.id)
    await vi.waitFor(() => expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(1))
    await useSessionStore.getState().pauseSessionCorrection(source.id)
    release()
    await running
    expect(useSessionStore.getState().sessions[0].correction?.draft).toMatchObject({ status: 'paused', proposedPatches: [] })
  })

  it('serializes concurrent published patch toggles against the latest revision', async () => {
    correction.requestCorrectionShard.mockResolvedValue({ patches: [
      { op: 'replace', oldText: '侍应', replacement: '适应', before: '甲需要', after: '新的', category: 'homophone', reason: '同音' },
      { op: 'replace', oldText: '侍应', replacement: '适应', before: '乙需要', after: '其他', category: 'homophone', reason: '同音' },
    ] })
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ transcript: '甲需要侍应新的工作。乙需要侍应其他工作。' })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().detectSessionCorrectionIssues(source.id)
    const ids = useSessionStore.getState().sessions[0].correction!.draft!.proposedPatches.map((patch) => patch.id)
    await useSessionStore.getState().applySessionCorrectionReview(source.id, ids)
    await Promise.all(ids.map((id) => useSessionStore.getState().setSessionCorrectionPatchState(source.id, id, 'reverted')))
    const published = useSessionStore.getState().sessions[0].correction!.published!
    expect(published.patches.filter((patch) => patch.state === 'reverted')).toHaveLength(2)
    expect(published.correctedText).toBe(source.transcript)
  })
})
