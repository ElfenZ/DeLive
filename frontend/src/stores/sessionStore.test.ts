import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CorrectionConfigSnapshot, CorrectionEditExpectation, TranscriptCorrection, TranscriptSession } from '../types'
import type { CorrectedMarkdownSaveRequest } from '../../../shared/fileStorage'

const repository = vi.hoisted(() => ({
  loadForLaunch: vi.fn(),
  updateMetadata: vi.fn(),
  updateMetadataDurable: vi.fn(),
  getSessionsSnapshot: vi.fn(),
  checkpointCorrection: vi.fn(),
  createDraft: vi.fn(),
  saveProgress: vi.fn(),
  completeSession: vi.fn(),
  deleteSession: vi.fn(),
}))
const correction = vi.hoisted(() => ({
  createCorrectionConfigSnapshot: vi.fn(),
  isCorrectionConfigSnapshotCurrent: vi.fn(),
  requestCorrectionShard: vi.fn(),
  CorrectionRequestError: class extends Error {},
}))
const postProcess = vi.hoisted(() => ({
  generateSessionBriefing: vi.fn(),
}))

vi.mock('../utils/sessionRepository', () => ({ sessionRepository: repository }))
vi.mock('../services/aiCorrection', () => correction)
vi.mock('../services/aiPostProcess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/aiPostProcess')>()),
  generateSessionBriefing: postProcess.generateSessionBriefing,
}))

function session(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  return { id: 's1', title: 'Session', date: '2026-07-16', time: '12:00', createdAt: 1, updatedAt: 1, transcript: '需要侍应新的工作。', status: 'completed', ...overrides }
}

function configSnapshot(overrides: Partial<CorrectionConfigSnapshot> = {}): CorrectionConfigSnapshot {
  const safetyLimits = { maxPatchTextLength: 1000, maxPatchesPerShard: 100, maxCumulativeEditRatio: 1, maxNetLengthChangeRatio: 1 }
  return {
    model: 'model', baseUrl: 'http://localhost/v1', promptLanguage: 'zh', promptVersion: 'patch-v1', schemaVersion: '1',
    structuredOutput: 'prompt-json', temperature: 0.1, glossary: [], background: '', correctionGuidance: '', chunkSize: 4000, contextSize: 500, concurrency: 1,
    credentialVersion: 1, identityVersion: 1, configIdentity: 'current', transport: 'json',
    safetyLimits: { ...safetyLimits, ...overrides.safetyLimits }, credentialRef: 'ai-post-process', ...overrides,
  }
}

async function correctionExpectation(source: TranscriptSession): Promise<CorrectionEditExpectation> {
  const { sha256Utf8 } = await import('../utils/correctionPatch')
  const draft = source.correction?.draft
  const published = source.correction?.published
  return {
    target: draft ? 'draft' : published ? 'published' : 'new',
    id: draft?.runId || published?.id,
    revision: draft?.revision || published?.revision || 0,
    baseTranscriptHash: await sha256Utf8(source.transcript),
  }
}

function mockMetadataPersistence(useSessionStore: typeof import('./sessionStore').useSessionStore): void {
  repository.updateMetadata.mockImplementation((id: string, updates: Partial<TranscriptSession>) => {
    const sessions = useSessionStore.getState().sessions.map((item) => item.id === id
      ? { ...item, ...updates, updatedAt: Date.now() }
      : item)
    useSessionStore.setState({ sessions })
    return sessions
  })
  repository.getSessionsSnapshot.mockImplementation(() => useSessionStore.getState().sessions)
  repository.updateMetadataDurable.mockImplementation(async (id: string, updates: Partial<TranscriptSession> | ((current: TranscriptSession) => Partial<TranscriptSession>)) => {
    const current = useSessionStore.getState().sessions.find((item) => item.id === id)
    if (!current) throw new Error('Session missing')
    return repository.updateMetadata(id, typeof updates === 'function' ? updates(current) : updates)
  })
}

function savedFile(request: CorrectedMarkdownSaveRequest, path: string) {
  return { ok: true, file: { status: 'saved' as const, revision: 1, path,
    publicationId: request.publicationId, publicationRevision: request.publicationRevision, titleRevision: request.titleRevision } }
}

async function configureAutomaticWorkflow(
  mode: 'quick' | 'review' = 'quick',
  autoExportDirectory?: string,
): Promise<void> {
  const { useSettingsStore } = await import('./settingsStore')
  const current = useSettingsStore.getState().settings
  useSettingsStore.setState({
    settings: {
      ...current,
      autoSavePublishedCorrection: Boolean(autoExportDirectory),
      aiPostProcess: {
        enabled: true,
        autoAiPostProcess: true,
        autoCorrectionDetection: true,
        correctionMode: mode,
        modelAssignment: { correction: 'model', briefing: 'model' },
        autoExportCorrectedMarkdown: Boolean(autoExportDirectory),
        autoExportDirectory: autoExportDirectory || '',
      },
    },
  })
}

describe('sessionStore patch correction runner', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals()
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { electronAPI: undefined })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    correction.createCorrectionConfigSnapshot.mockReturnValue(configSnapshot())
    correction.isCorrectionConfigSnapshotCurrent.mockImplementation((snapshot: CorrectionConfigSnapshot) => snapshot.configIdentity === 'current')
    correction.requestCorrectionShard.mockResolvedValue({ patches: [{ op: 'replace', oldText: '侍应', replacement: '适应', before: '需要', after: '新的', category: 'homophone', reason: '同音' }] })
    postProcess.generateSessionBriefing.mockResolvedValue({
      postProcess: { status: 'success', summary: '摘要', titleSuggestion: 'AI 标题', model: 'model' },
      source: { text: '需要适应新的工作。', sourceKind: 'published-correction', sourceTextHash: 'hash' },
    })
    repository.checkpointCorrection.mockImplementation(async (_id: string, next: TranscriptCorrection | ((session: TranscriptSession) => Promise<TranscriptCorrection>)) => {
      const { useSessionStore } = await import('./sessionStore')
      const current = useSessionStore.getState().sessions[0]
      const sessions = [{ ...current, correction: typeof next === 'function' ? await next(current) : next }]
      useSessionStore.setState({ sessions })
      return sessions
    })
  })

  it('returns the completed session id and persists effective recording duration', async () => {
    vi.stubGlobal('window', { electronAPI: undefined })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ status: 'recording', transcript: 'hello' })
    repository.completeSession.mockImplementation((_id, snapshot) => [{
      ...source,
      ...snapshot,
      status: 'completed',
    }])
    useSessionStore.setState({
      sessions: [source],
      currentSessionId: source.id,
      finalTranscript: 'hello',
      currentTranscript: 'hello',
    })

    const completedId = useSessionStore.getState().endCurrentSession({ duration: 3_250 })

    expect(completedId).toBe(source.id)
    expect(repository.completeSession).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({ transcript: 'hello', duration: 3_250 }),
    )
    expect(useSessionStore.getState().currentSessionId).toBeNull()
  }, 10_000)

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

  it('publishes manual-only edits without AI configuration and produces new durable revision, hash and stats', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, aiPostProcess: { enabled: false } } })
    const source = session({ transcript: '需要侍应新的工作。'.repeat(4) })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    const edit = { sourceStart: 2, sourceEnd: 4, sourceText: '侍应', replacement: '适应' }
    await useSessionStore.getState().saveSessionManualCorrection(source.id, edit, await correctionExpectation(source))
    const current = useSessionStore.getState().sessions[0]
    expect(current.transcript).toBe(source.transcript)
    expect(current.correction?.published).toMatchObject({ revision: 1, model: 'manual', stats: { applied: 1, reverted: 0, rejected: 0 } })
    expect(current.correction?.published?.patches[0]).toMatchObject({ origin: 'manual', locationVerified: true })
    expect(current.correction?.correctedText).toBe(`需要适应新的工作。${'需要侍应新的工作。'.repeat(3)}`)
    expect(correction.requestCorrectionShard).not.toHaveBeenCalled()
    expect(repository.checkpointCorrection).toHaveBeenCalledWith(source.id, expect.any(Function))
    const patchId = current.correction!.published!.patches[0].id
    const hash = current.correction!.published!.outputTextHash
    await useSessionStore.getState().saveSessionManualCorrection(source.id, { ...edit, patchId, replacement: '适配' }, await correctionExpectation(current))
    const edited = useSessionStore.getState().sessions[0]
    expect(edited.correction?.published?.patches).toHaveLength(1)
    expect(edited.correction?.published?.revision).toBe(2)
    expect(edited.correction?.published?.outputTextHash).not.toBe(hash)
    await useSessionStore.getState().changeSessionCorrectionPatchState(source.id, patchId, 'reverted', await correctionExpectation(edited))
    expect(useSessionStore.getState().sessions[0].correction?.correctedText).toBe(source.transcript)
    await useSessionStore.getState().changeSessionCorrectionPatchState(source.id, patchId, 'applied', await correctionExpectation(useSessionStore.getState().sessions[0]))
    expect(useSessionStore.getState().sessions[0].correction?.published?.revision).toBe(4)
  })

  it('does not publish failed manual writes or poison the correction mutation queue for a retry', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ transcript: '需要侍应新的工作。'.repeat(4) })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    const expected = await correctionExpectation(source)
    const edit = { sourceStart: 2, sourceEnd: 4, sourceText: '侍应', replacement: '适应' }
    repository.checkpointCorrection.mockRejectedValueOnce(new Error('disk full'))
    await expect(useSessionStore.getState().saveSessionManualCorrection(source.id, edit, expected)).rejects.toThrow('disk full')
    expect(useSessionStore.getState().sessions[0]).toBe(source)
    await useSessionStore.getState().saveSessionManualCorrection(source.id, edit, expected)
    expect(useSessionStore.getState().sessions[0].correction?.published?.revision).toBe(1)
  })

  it('rejects concurrent old revision, stale source hash and busy manual changes without losing the first edit', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ transcript: '需要侍应新的工作。'.repeat(4) })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    const expected = await correctionExpectation(source)
    const edit = { sourceStart: 2, sourceEnd: 4, sourceText: '侍应', replacement: '适应' }
    const first = useSessionStore.getState().saveSessionManualCorrection(source.id, edit, expected)
    const late = useSessionStore.getState().saveSessionManualCorrection(source.id, { ...edit, replacement: '适配' }, expected)
    await first
    await expect(late).rejects.toThrow('revision-mismatch')
    const current = useSessionStore.getState().sessions[0]
    await expect(useSessionStore.getState().saveSessionManualCorrection(source.id, edit, { ...await correctionExpectation(current), baseTranscriptHash: 'old' })).rejects.toThrow('source-hash-mismatch')
    useSessionStore.setState({ correctionInFlight: { [source.id]: true } })
    await expect(useSessionStore.getState().saveSessionManualCorrection(source.id, edit, await correctionExpectation(current))).rejects.toThrow('busy')
    expect(useSessionStore.getState().sessions[0].correction?.published?.revision).toBe(1)
    useSessionStore.setState({ correctionInFlight: {} })
  })

  it('keeps rejected evidence and adds one linked manual recovery; technical rejections cannot toggle applied', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ transcript: '需要侍应新的工作。'.repeat(4) })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().startSessionQuickCorrection(source.id)
    const rejected = useSessionStore.getState().sessions[0].correction!.published!.patches[0]
    expect(rejected.state).toBe('rejected')
    await expect(useSessionStore.getState().setSessionCorrectionPatchState(source.id, rejected.id, 'applied')).rejects.toThrow('not-editable')
    const edit = { sourceStart: 2, sourceEnd: 4, sourceText: '侍应', replacement: '适应', recoveredFromPatchId: rejected.id }
    await useSessionStore.getState().saveSessionManualCorrection(source.id, edit, await correctionExpectation(useSessionStore.getState().sessions[0]))
    const recovered = useSessionStore.getState().sessions[0]
    expect(recovered.correction!.published!.patches).toHaveLength(2)
    expect(recovered.correction!.published!.patches[0]).toEqual(rejected)
    await expect(useSessionStore.getState().saveSessionManualCorrection(source.id, edit, await correctionExpectation(recovered))).rejects.toThrow('already-recovered')
    expect(useSessionStore.getState().sessions[0]).toBe(recovered)
  })

  it('saves manual review candidates without publication and refuses an old run after rerun', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ transcript: '需要侍应新的工作。'.repeat(4) })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().detectSessionCorrectionIssues(source.id)
    const expected = await correctionExpectation(useSessionStore.getState().sessions[0])
    await useSessionStore.getState().saveSessionManualCorrection(source.id, { sourceStart: 2, sourceEnd: 4, sourceText: '侍应', replacement: '适应' }, expected)
    const current = useSessionStore.getState().sessions[0]
    expect(current.correction?.published).toBeUndefined()
    expect(current.correction?.draft?.proposedPatches[0]).toMatchObject({ state: 'proposed', origin: 'manual' })
    await useSessionStore.getState().applySessionCorrectionReview(source.id, current.correction!.draft!.proposedPatches.map((patch) => patch.id))
    expect(useSessionStore.getState().sessions[0].correction?.published?.patches.some((patch) => patch.origin === 'manual')).toBe(true)
    await useSessionStore.getState().detectSessionCorrectionIssues(source.id)
    await expect(useSessionStore.getState().saveSessionManualCorrection(source.id, { sourceStart: 2, sourceEnd: 4, sourceText: '侍应', replacement: '适配' }, expected)).rejects.toThrow('revision-mismatch')
  })

  it('requires conflict confirmation before one atomic published change and leaves summary provenance stale', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const { resolveTranscriptText, resolveTranscriptArtifactSourceState } = await import('../services/aiPostProcess')
    const source = session({ transcript: '需要侍应新的工作。'.repeat(4) })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().saveSessionManualCorrection(source.id, { sourceStart: 2, sourceEnd: 4, sourceText: '侍应', replacement: '适应' }, await correctionExpectation(source))
    const current = useSessionStore.getState().sessions[0]
    const oldSource = resolveTranscriptText(current, 'auto')
    const summary = { status: 'success' as const, summary: 'Existing summary', sourceKind: oldSource.sourceKind, sourceTextHash: oldSource.sourceTextHash, sourceResultId: oldSource.sourceResultId }
    useSessionStore.setState({ sessions: [{ ...current, postProcess: summary }] })
    const expected = await correctionExpectation(current)
    const conflict = { sourceStart: 1, sourceEnd: 4, sourceText: '要侍应', replacement: '要适配' }
    await expect(useSessionStore.getState().saveSessionManualCorrection(source.id, conflict, expected)).rejects.toThrow('confirmation-required')
    expect(useSessionStore.getState().sessions[0].correction?.published?.revision).toBe(1)
    const id = current.correction!.published!.patches[0].id
    await useSessionStore.getState().saveSessionManualCorrection(source.id, { ...conflict, confirmedConflictIds: [id] }, expected)
    const changed = useSessionStore.getState().sessions[0]
    expect(changed.correction?.published?.patches.map((patch) => patch.state)).toEqual(['reverted', 'applied'])
    expect(changed.postProcess).toEqual(summary)
    expect(resolveTranscriptArtifactSourceState(summary, resolveTranscriptText(changed, 'auto'))).toBe('stale')
  })
  it('blocks duplicate streaming/non-streaming questions and deletion of the pending thread before any request or mutation', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const original = session({ askHistory: [{ id: 'pending', question: 'waiting', conversationId: 'side-panel-s1', createdAt: 1, status: 'pending' }] })
    useSessionStore.setState({ sessions: [original] })
    await expect(useSessionStore.getState().askSessionQuestion('s1', 'new', { conversationId: 'other' })).rejects.toThrow(/正在进行/)
    await expect(useSessionStore.getState().askSessionQuestionStreaming('s1', 'new', { conversationId: 'other' })).rejects.toThrow(/正在进行/)
    expect(() => useSessionStore.getState().deleteSessionConversation('s1', 'side-panel-s1')).toThrow(/完成/)
    expect(useSessionStore.getState().sessions[0]).toBe(original)
    expect(repository.updateMetadata).not.toHaveBeenCalled()
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

  it('locks the API key for the full correction lease when settings change mid-run', async () => {
    correction.createCorrectionConfigSnapshot.mockReturnValue(configSnapshot({ chunkSize: 4, contextSize: 0, concurrency: 1 }))
    let releaseFirst!: () => void
    correction.requestCorrectionShard
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ patches: [] })
      }))
      .mockResolvedValue({ patches: [] })
    const { useSessionStore } = await import('./sessionStore')
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        aiPostProcess: { ...useSettingsStore.getState().settings.aiPostProcess, apiKey: 'old-key' },
      },
    })
    const source = session({ transcript: 'abcdefgh' })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    const running = useSessionStore.getState().detectSessionCorrectionIssues(source.id)
    await vi.waitFor(() => expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(1))
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        aiPostProcess: { ...useSettingsStore.getState().settings.aiPostProcess, apiKey: 'new-key' },
      },
    })
    releaseFirst()
    await running

    expect(correction.requestCorrectionShard.mock.calls.map(([request]) => request.apiKey)).toEqual(['old-key', 'old-key'])
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

  it('retries only failed shards when the saved correction configuration still matches', async () => {
    correction.createCorrectionConfigSnapshot.mockReturnValue(configSnapshot({ chunkSize: 4, contextSize: 0, concurrency: 1 }))
    correction.requestCorrectionShard
      .mockResolvedValueOnce({ patches: [] })
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue({ patches: [] })
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ transcript: 'abcdefgh' })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await expect(useSessionStore.getState().detectSessionCorrectionIssues(source.id)).rejects.toThrow('temporary failure')
    const failedRunId = useSessionStore.getState().sessions[0].correction!.draft!.runId

    await useSessionStore.getState().retrySessionCorrection(source.id)

    expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(3)
    expect(useSessionStore.getState().sessions[0].correction?.draft).toMatchObject({
      runId: failedRunId,
      status: 'ready-for-review',
    })
  })

  it('rebuilds every shard with a new run id when the saved correction configuration changed', async () => {
    correction.createCorrectionConfigSnapshot.mockReturnValue(configSnapshot({ chunkSize: 4, contextSize: 0, concurrency: 1 }))
    correction.requestCorrectionShard
      .mockResolvedValueOnce({ patches: [] })
      .mockRejectedValueOnce(new Error('old endpoint failed'))
      .mockResolvedValue({ patches: [] })
    const { useSessionStore } = await import('./sessionStore')
    const source = session({ transcript: 'abcdefgh' })
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await expect(useSessionStore.getState().detectSessionCorrectionIssues(source.id)).rejects.toThrow('old endpoint failed')
    const oldRunId = useSessionStore.getState().sessions[0].correction!.draft!.runId
    correction.isCorrectionConfigSnapshotCurrent.mockReturnValue(false)
    correction.createCorrectionConfigSnapshot.mockReturnValue(configSnapshot({
      baseUrl: 'https://new.example.com/v1',
      model: 'new-model',
      configIdentity: 'new-current',
      chunkSize: 4,
      contextSize: 0,
      concurrency: 1,
    }))

    await useSessionStore.getState().retrySessionCorrection(source.id)

    const rebuilt = useSessionStore.getState().sessions[0].correction!.draft!
    expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(4)
    expect(rebuilt.runId).not.toBe(oldRunId)
    expect(rebuilt.config).toMatchObject({ baseUrl: 'https://new.example.com/v1', model: 'new-model' })
    expect(rebuilt.proposedPatches).toEqual([])
    expect(rebuilt.rejectedPatches).toEqual([])
    expect(rebuilt.status).toBe('ready-for-review')
  })

  it('rejects a concurrent published toggle from the old revision and permits retry against the committed revision', async () => {
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
    const results = await Promise.allSettled(ids.map((id) => useSessionStore.getState().setSessionCorrectionPatchState(source.id, id, 'reverted')))
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'correction-revision-mismatch' }) })
    await useSessionStore.getState().setSessionCorrectionPatchState(source.id, ids[1], 'reverted')
    const published = useSessionStore.getState().sessions[0].correction!.published!
    expect(published.patches.filter((patch) => patch.state === 'reverted')).toHaveLength(2)
    expect(published.correctedText).toBe(source.transcript)
  })

  it('runs the complete Quick workflow once and briefs the published correction', async () => {
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    await configureAutomaticWorkflow('quick')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })

    await Promise.all([
      useSessionStore.getState().maybeStartAutoAiPostProcess(source.id),
      useSessionStore.getState().maybeStartAutoAiPostProcess(source.id),
    ])

    const completed = useSessionStore.getState().sessions[0]
    expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(1)
    expect(postProcess.generateSessionBriefing).toHaveBeenCalledTimes(1)
    expect(postProcess.generateSessionBriefing.mock.calls[0][0].correction?.published?.correctedText)
      .toBe('需要适应新的工作。')
    expect(completed.title).toBe('AI 标题')
    expect(completed.autoPostProcessWorkflow).toEqual(expect.objectContaining({ status: 'completed', step: 'title' }))
  })

  it('exports corrected Markdown after the final title and persists the actual path', async () => {
    const savePublishedMarkdown = vi.fn(async (request: CorrectedMarkdownSaveRequest) => savedFile(request, 'D:\\Exports\\final_corrected.md'))
    const writeAutoExportFile = vi.fn()
    vi.stubGlobal('window', { electronAPI: { savePublishedMarkdown, writeAutoExportFile } })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    await configureAutomaticWorkflow('quick', 'D:\\Exports')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })

    await useSessionStore.getState().maybeStartAutoAiPostProcess(source.id)

    expect(writeAutoExportFile).not.toHaveBeenCalled()
    expect(savePublishedMarkdown).toHaveBeenCalledTimes(1)
    expect(savePublishedMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: source.id,
      publicationRevision: 1,
      titleRevision: 1,
      content: expect.stringContaining('# AI 标题'),
    }))
    expect(useSessionStore.getState().sessions[0].autoPostProcessWorkflow).toEqual(expect.objectContaining({
      status: 'completed',
      step: 'export',
      exportPath: 'D:\\Exports\\final_corrected.md',
      exportedAt: expect.any(Number),
    }))
  })

  it('retries only a failed file save and retains a completed AI workflow', async () => {
    const nativeSave = vi.fn()
      .mockResolvedValueOnce({ ok: false, file: { status: 'waiting-directory', revision: 0, error: 'disk unavailable' } })
      .mockImplementationOnce(async (request: CorrectedMarkdownSaveRequest) => savedFile(request, 'E:\\New\\retry_corrected.md'))
    const writeAutoExportFile = vi.fn()
    vi.stubGlobal('window', { electronAPI: { savePublishedMarkdown: nativeSave, writeAutoExportFile } })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    await configureAutomaticWorkflow('quick', 'D:\\Old')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })

    await useSessionStore.getState().maybeStartAutoAiPostProcess(source.id)
    expect(useSessionStore.getState().sessions[0].autoPostProcessWorkflow).toEqual(expect.objectContaining({
      status: 'completed', step: 'export',
    }))
    expect(useSessionStore.getState().sessions[0].correctedMarkdownFile).toMatchObject({ status: 'waiting-directory', error: 'disk unavailable' })

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        aiPostProcess: {
          ...useSettingsStore.getState().settings.aiPostProcess,
          autoExportDirectory: 'E:\\New',
        },
      },
    })
    const { savePublishedMarkdown } = await import('../utils/publishedMarkdownCoordinator')
    await savePublishedMarkdown(source.id, { retry: true })

    expect(correction.requestCorrectionShard).toHaveBeenCalledTimes(1)
    expect(postProcess.generateSessionBriefing).toHaveBeenCalledTimes(1)
    expect(writeAutoExportFile).not.toHaveBeenCalled()
    expect(nativeSave).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().sessions[0].autoPostProcessWorkflow).toEqual(expect.objectContaining({
      status: 'completed', step: 'export',
    }))
    expect(useSessionStore.getState().sessions[0].correctedMarkdownFile).toMatchObject({ status: 'saved', path: 'E:\\New\\retry_corrected.md' })
  })

  it('does not block the AI workflow when native saving is unavailable', async () => {
    const { useSessionStore } = await import('./sessionStore')
    await configureAutomaticWorkflow('quick', 'D:\\Exports')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().maybeStartAutoAiPostProcess(source.id)
    const completed = useSessionStore.getState().sessions[0]
    expect(completed.autoPostProcessWorkflow?.status).toBe('completed')
    expect(completed.postProcess?.status).toBe('success')
    expect(completed.correction?.published).toBeDefined()
    expect(completed.correctedMarkdownFile).toMatchObject({ status: 'error' })
    expect(correction.requestCorrectionShard).toHaveBeenCalledOnce()
    expect(postProcess.generateSessionBriefing).toHaveBeenCalledOnce()
  })

  it('saves standalone Quick publication and patch toggles through the same coordinator', async () => {
    const nativeSave = vi.fn(async (request: CorrectedMarkdownSaveRequest) => savedFile(request, 'D:\\Exports\\single.md'))
    vi.stubGlobal('window', { electronAPI: { savePublishedMarkdown: nativeSave } })
    const { useSessionStore } = await import('./sessionStore')
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, autoSavePublishedCorrection: true } }))
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().startSessionQuickCorrection(source.id)
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0].correctedMarkdownFile?.status).toBe('saved'))
    const published = useSessionStore.getState().sessions[0].correction!.published!
    await useSessionStore.getState().setSessionCorrectionPatchState(source.id, published.patches[0].id, 'reverted')
    await vi.waitFor(() => expect(nativeSave).toHaveBeenCalledTimes(2))
    expect(nativeSave.mock.calls[1][0]).toMatchObject({ publicationRevision: 2 })
    expect(nativeSave.mock.calls[1][0].content).toContain(source.transcript)
    expect(correction.requestCorrectionShard).toHaveBeenCalledOnce()
  })

  it('does not save Review candidates before local publication', async () => {
    const nativeSave = vi.fn(async (request: CorrectedMarkdownSaveRequest) => savedFile(request, 'D:\\Exports\\single.md'))
    vi.stubGlobal('window', { electronAPI: { savePublishedMarkdown: nativeSave } })
    const { useSessionStore } = await import('./sessionStore')
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, autoSavePublishedCorrection: true } }))
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })
    await useSessionStore.getState().detectSessionCorrectionIssues(source.id)
    expect(nativeSave).not.toHaveBeenCalled()
    await useSessionStore.getState().applySessionCorrectionReview(source.id, [])
    await vi.waitFor(() => expect(nativeSave).toHaveBeenCalledOnce())
    expect(correction.requestCorrectionShard).toHaveBeenCalledOnce()
  })

  it('waits for Review confirmation before briefing and then continues', async () => {
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    await configureAutomaticWorkflow('review')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })

    await useSessionStore.getState().maybeStartAutoAiPostProcess(source.id)
    const waiting = useSessionStore.getState().sessions[0]
    expect(waiting.autoPostProcessWorkflow?.status).toBe('waiting-review')
    expect(postProcess.generateSessionBriefing).not.toHaveBeenCalled()

    const patchIds = waiting.correction!.draft!.proposedPatches.map((patch) => patch.id)
    await useSessionStore.getState().applySessionCorrectionReview(source.id, patchIds)
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0].autoPostProcessWorkflow?.status).toBe('completed'))
    expect(postProcess.generateSessionBriefing).toHaveBeenCalledTimes(1)
  })

  it('publishes a zero-candidate Review locally and continues automatically', async () => {
    correction.requestCorrectionShard.mockResolvedValue({ patches: [] })
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    await configureAutomaticWorkflow('review')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })

    await useSessionStore.getState().maybeStartAutoAiPostProcess(source.id)

    const completed = useSessionStore.getState().sessions[0]
    expect(completed.correction?.published?.correctedText).toBe(source.transcript)
    expect(completed.autoPostProcessWorkflow?.status).toBe('completed')
    expect(postProcess.generateSessionBriefing).toHaveBeenCalledTimes(1)
  })

  it('preserves a manual title change made while briefing is running', async () => {
    let releaseBriefing!: () => void
    postProcess.generateSessionBriefing.mockImplementation(() => new Promise((resolve) => {
      releaseBriefing = () => resolve({
        postProcess: { status: 'success', summary: '摘要', titleSuggestion: 'AI 标题', model: 'model' },
        source: { text: 'corrected', sourceKind: 'published-correction', sourceTextHash: 'hash' },
      })
    }))
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    await configureAutomaticWorkflow('quick')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })

    const running = useSessionStore.getState().maybeStartAutoAiPostProcess(source.id)
    await vi.waitFor(() => expect(postProcess.generateSessionBriefing).toHaveBeenCalledTimes(1))
    await useSessionStore.getState().updateSessionTitle(source.id, '手动标题')
    releaseBriefing()
    await running

    expect(useSessionStore.getState().sessions[0].title).toBe('手动标题')
    expect(useSessionStore.getState().sessions[0].autoPostProcessWorkflow?.status).toBe('completed')
  })

  it('records configuration and briefing failures without changing the title', async () => {
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    const { useSettingsStore } = await import('./settingsStore')
    const current = useSettingsStore.getState().settings
    useSettingsStore.setState({
      settings: {
        ...current,
        aiPostProcess: {
          enabled: true,
          autoAiPostProcess: true,
          modelAssignment: { correction: 'model' },
        },
      },
    })
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })

    await useSessionStore.getState().maybeStartAutoAiPostProcess(source.id)
    expect(useSessionStore.getState().sessions[0].autoPostProcessWorkflow).toEqual(expect.objectContaining({
      status: 'error',
      step: 'correction',
      error: expect.stringMatching(/摘要模型/),
    }))
    expect(correction.requestCorrectionShard).not.toHaveBeenCalled()

    useSessionStore.setState({ sessions: [session({ id: 's2' })] })
    await configureAutomaticWorkflow('quick')
    postProcess.generateSessionBriefing.mockRejectedValueOnce(new Error('briefing failed'))
    await useSessionStore.getState().maybeStartAutoAiPostProcess('s2')
    const failed = useSessionStore.getState().sessions[0]
    expect(failed.correction?.published).toBeDefined()
    expect(failed.title).toBe('Session')
    expect(failed.autoPostProcessWorkflow).toEqual(expect.objectContaining({
      status: 'error',
      step: 'briefing',
      error: 'briefing failed',
    }))
  })

  it('keeps a successful briefing but marks an empty title suggestion as an error', async () => {
    postProcess.generateSessionBriefing.mockResolvedValueOnce({
      postProcess: { status: 'success', summary: '摘要', model: 'model' },
      source: { text: 'corrected', sourceKind: 'published-correction', sourceTextHash: 'hash' },
    })
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    await configureAutomaticWorkflow('quick')
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })

    await useSessionStore.getState().maybeStartAutoAiPostProcess(source.id)

    const failed = useSessionStore.getState().sessions[0]
    expect(failed.postProcess?.summary).toBe('摘要')
    expect(failed.title).toBe(source.title)
    expect(failed.autoPostProcessWorkflow).toEqual(expect.objectContaining({ status: 'error', step: 'title' }))
  })

  it('keeps legacy automatic Review detection when the full workflow is disabled', async () => {
    const { useSessionStore } = await import('./sessionStore')
    const { useSettingsStore } = await import('./settingsStore')
    const current = useSettingsStore.getState().settings
    useSettingsStore.setState({
      settings: {
        ...current,
        aiPostProcess: {
          enabled: true,
          autoAiPostProcess: false,
          autoCorrectionDetection: true,
          modelAssignment: { correction: 'model' },
        },
      },
    })
    const source = session()
    useSessionStore.setState({ sessions: [source], correctionInFlight: {} })

    await useSessionStore.getState().maybeStartAutoAiPostProcess(source.id)

    expect(useSessionStore.getState().sessions[0].correction?.draft?.status).toBe('ready-for-review')
    expect(useSessionStore.getState().sessions[0].autoPostProcessWorkflow).toBeUndefined()
    expect(postProcess.generateSessionBriefing).not.toHaveBeenCalled()
  })

  it('resumes only a queued marked workflow from the briefing step at launch', async () => {
    vi.stubGlobal('window', { electronAPI: undefined })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const queued = session({
      autoPostProcessWorkflow: {
        version: 1,
        status: 'queued',
        step: 'briefing',
        correctionMode: 'quick',
        titleAtStart: 'Session',
        titleRevisionAtStart: 0,
        startedAt: 10,
        updatedAt: 20,
      },
    })
    repository.loadForLaunch.mockResolvedValue({ sessions: [queued], recoverableSession: null })
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    await configureAutomaticWorkflow('quick')

    await useSessionStore.getState().loadSessions()
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0].autoPostProcessWorkflow?.status).toBe('completed'))

    expect(correction.requestCorrectionShard).not.toHaveBeenCalled()
    expect(postProcess.generateSessionBriefing).toHaveBeenCalledTimes(1)
  })

  it('reuses a current persisted briefing after a crash instead of requesting it twice', async () => {
    vi.stubGlobal('window', { electronAPI: undefined })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const { resolveTranscriptText } = await import('../services/aiPostProcess')
    const base = session()
    const source = resolveTranscriptText(base, 'auto')
    const queued = session({
      postProcess: {
        status: 'success',
        summary: '已持久化摘要',
        titleSuggestion: '恢复标题',
        generatedAt: 30,
        sourceKind: source.sourceKind,
        sourceTextHash: source.sourceTextHash,
        sourceResultId: source.sourceResultId,
      },
      autoPostProcessWorkflow: {
        version: 1,
        status: 'queued',
        step: 'briefing',
        correctionMode: 'quick',
        titleAtStart: 'Session',
        titleRevisionAtStart: 0,
        startedAt: 10,
        updatedAt: 20,
      },
    })
    repository.loadForLaunch.mockResolvedValue({ sessions: [queued], recoverableSession: null })
    const { useSessionStore } = await import('./sessionStore')
    mockMetadataPersistence(useSessionStore)
    await configureAutomaticWorkflow('quick')

    await useSessionStore.getState().loadSessions()
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0].autoPostProcessWorkflow?.status).toBe('completed'))

    expect(postProcess.generateSessionBriefing).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].title).toBe('恢复标题')
  })
})
