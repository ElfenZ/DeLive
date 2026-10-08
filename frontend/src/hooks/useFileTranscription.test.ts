import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileTranscriptionConfig, FileTranscriptionJob } from '../types/fileTranscription'
import { ASRVendor } from '../types/asr/common'

const provider = vi.hoisted(() => vi.fn())
vi.mock('../utils/siliconflowFileApi', () => ({ transcribeFile: provider }))
vi.mock('../stores/fileTranscriptionStore', async (original) => {
  const actual = await original<typeof import('../stores/fileTranscriptionStore')>()
  const store = actual.useFileTranscriptionStore
  return { useFileTranscriptionStore: Object.assign((selector?: (state: ReturnType<typeof store.getState>) => unknown) =>
    selector ? selector(store.getState()) : store.getState(), store) }
})
// Execute the real hook pipelines and real Zustand/repository actions without a DOM renderer.
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useDebugValue: () => undefined,
}))

const config: FileTranscriptionConfig = {
  provider: ASRVendor.SiliconFlow,
  meetingContext: { schemaVersion: 1, background: 'Frozen context', correctionGuidance: '',
    useForAiCorrection: true, useForSoniox: false, glossary: [] },
}

function managedAudio(fileName: string, mimeType: string) {
  return { sessionId: 'record', assetKind: 'extracted-audio', revision: 1, fileName, mimeType,
    path: `C:/managed/${fileName}`, size: 1, sha256: 'a'.repeat(64) }
}

describe('file retry hook with restored AUDIO metadata and real repositories', () => {
  let values: Map<string, string>
  beforeEach(() => {
    vi.resetModules()
    provider.mockReset().mockResolvedValue({ text: 'New transcript' })
    values = new Map()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('window', {})
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  async function Setup(inputKind: 'audio' | 'video' = 'audio') {
    const restored: FileTranscriptionJob = { id: 'job', sessionId: 'record', fileName: inputKind === 'audio' ? 'historical.wav' : 'historical.mp4',
      fileSize: 999, mimeType: inputKind === 'audio' ? 'audio/wav' : 'video/mp4', inputKind,
      status: 'uploading', progress: 50, createdAt: 1, provider: config.provider,
      config: structuredClone(config), projectIds: ['frozen-project'], defaultSaveProjectId: 'frozen-project',
      originalSourceId: 'untrusted-restored-pointer', audioPath: 'C:/untrusted/backup-path.wav' }
    values.set('delive-file-transcription-tasks', JSON.stringify({ version: 1, state: { jobs: [restored] } }))
    const { useFileTranscriptionStore: jobs } = await import('../stores/fileTranscriptionStore')
    await jobs.persist.rehydrate()
    const { useSettingsStore: settings } = await import('../stores/settingsStore')
    const { useSessionStore: sessions } = await import('../stores/sessionStore')
    const { useTopicStore: topics } = await import('../stores/topicStore')
    const { sessionRepository: repository } = await import('../utils/sessionRepository')
    await sessions.getState().loadSessions()
    vi.spyOn(settings.getState(), 'getProviderConfig').mockReturnValue({ apiKey: 'test-only' })
    vi.spyOn(sessions.getState(), 'maybeStartAutoAiPostProcess').mockResolvedValue(undefined)
    topics.setState({ activeProjectIds: ['current-project'], defaultSaveProjectId: 'current-project' })
    const api = {
      platform: 'win32', getPathForFile: vi.fn(() => 'C:/native/selected.wav'),
      registerOriginalSource: vi.fn(async () => ({ ok: true, source: { id: 'registered-source', revision: 3, fileName: 'current.wav' } })),
      acquireOriginalRead: vi.fn(async () => ({ ok: true, token: 'lease' })),
      releaseOriginalRead: vi.fn(async () => undefined),
      readOriginalAudio: vi.fn(async () => ({ ok: true, data: new Uint8Array([1, 2]), fileName: 'current.wav' })),
      readMediaAudio: vi.fn(async () => ({ ok: false, error: 'Missing managed audio' })),
      cancelMediaExtraction: vi.fn(async () => ({ ok: true })),
      extractMediaAudio: vi.fn(async () => ({ ok: true, audio: { sessionId: 'record', assetKind: 'extracted-audio', revision: 1,
        path: 'C:/managed/extracted.mp3', fileName: 'extracted.mp3', mimeType: 'audio/mpeg', size: 3, sha256: 'a'.repeat(64) } })),
    }
    vi.stubGlobal('window', { electronAPI: api })
    const { useFileTranscription } = await import('./useFileTranscription')
    function HookHarness() { return useFileTranscription() }
    return { hook: HookHarness(), jobs, sessions, topics, repository, api }
  }

  it('restores AUDIO tasks and explicitly reselects without guessing a backup pointer or changing frozen projects', async () => {
    const test = await Setup()
    expect(test.jobs.getState().getJob('job')?.requiresSourceSelection).toBe(true)
    await test.hook.retryJob('job')
    expect(test.api.readMediaAudio).toHaveBeenCalledWith('record')
    expect(provider).not.toHaveBeenCalled()
    expect(test.api.acquireOriginalRead).not.toHaveBeenCalled()
    await test.hook.reselectOriginal('job', new File(['selected'], 'current.wav', { type: 'audio/wav' }))
    expect(test.api.acquireOriginalRead).toHaveBeenCalledWith('registered-source', 'record')
    expect(test.api.readOriginalAudio).toHaveBeenCalledWith('lease')
    expect(test.api.releaseOriginalRead).toHaveBeenCalledOnce()
    const session = test.repository.getSessionsSnapshot()[0]
    expect(session.projectIds).toEqual(['frozen-project'])
    expect(session.defaultSaveProjectId).toBe('frozen-project')
    expect(session.sourceMeta).toMatchObject({ originalFileName: 'historical.wav', originalFileSize: 999,
      currentOriginalFileName: 'current.wav', originalSourceId: 'registered-source' })
    expect(session.meetingContext?.background).toBe('Frozen context')
    expect(session.sourceMeta?.audioPath).toBeUndefined()
    expect(session.sourceMeta?.audioFileName).toBeUndefined()
    expect(JSON.parse(values.get('delive-file-transcription-tasks')!).state.jobs[0].fileName).toBe('historical.wav')
  })

  it('reads managed AUDIO by session ID despite stale path and preserves concurrent title, project links and correction', async () => {
    const test = await Setup()
    await test.hook.reselectOriginal('job', new File(['selected'], 'current.wav', { type: 'audio/wav' }))
    const correction = { mode: 'quick' as const, status: 'done' as const }
    await test.repository.updateMetadataDurable('record', { title: 'Manual title', titleRevision: 4, projectIds: ['manual-project'], correction })
    test.api.readMediaAudio.mockResolvedValue({ ok: true, audio: managedAudio('managed.wav', 'audio/wav'), data: new Uint8Array([3]) } as never)
    await test.hook.retryJob('job', { ...config, meetingContext: { ...config.meetingContext, background: 'New UI context' } })
    await vi.waitFor(() => expect(test.jobs.getState().getJob('job')?.status).toBe('completed'))
    const current = test.repository.getSessionsSnapshot()[0]
    expect(current.title).toBe('Manual title')
    expect(current.projectIds).toEqual(['manual-project'])
    expect(current.correction?.status).toBe('done')
    expect(current.sourceMeta?.originalFileName).toBe('historical.wav')
    expect(current.meetingContext?.background).toBe('Frozen context')
    expect(provider.mock.calls[1][1].name).toBe('managed.wav')
  })

  it('holds the original lease across provider work and releases on provider failure', async () => {
    const test = await Setup()
    let reject!: (reason: Error) => void
    provider.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const running = test.hook.reselectOriginal('job', new File(['a'], 'a.wav', { type: 'audio/wav' }))
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce())
    expect(test.api.releaseOriginalRead).not.toHaveBeenCalled()
    reject(new Error('Provider failed'))
    await running
    expect(test.api.releaseOriginalRead).toHaveBeenCalledOnce()
    expect(test.jobs.getState().getJob('job')?.error).toBe('Provider failed')
    expect(test.repository.getSessionsSnapshot()).toEqual([])
  })

  it('releases after cancellation and ignores a late successful provider result', async () => {
    const test = await Setup()
    let resolve!: (value: { text: string }) => void
    provider.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const running = test.hook.reselectOriginal('job', new File(['a'], 'a.wav', { type: 'audio/wav' }))
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce())
    test.hook.cancelJob('job')
    expect(test.api.releaseOriginalRead).not.toHaveBeenCalled()
    resolve({ text: 'Late result' })
    await running
    expect(test.api.releaseOriginalRead).toHaveBeenCalledOnce()
    expect(test.jobs.getState().getJob('job')?.status).toBe('cancelled')
    expect(test.repository.getSessionsSnapshot()).toEqual([])
  })

  it('releases the lease when native AUDIO reading fails', async () => {
    const test = await Setup()
    test.api.readOriginalAudio.mockRejectedValueOnce(new Error('Identity changed'))
    await test.hook.reselectOriginal('job', new File(['a'], 'a.wav', { type: 'audio/wav' }))
    expect(test.api.releaseOriginalRead).toHaveBeenCalledOnce()
    expect(provider).not.toHaveBeenCalled()
    expect(test.jobs.getState().getJob('job')?.requiresSourceSelection).toBe(true)
  })

  it('rejects deleted-record retry and reselection before any file operation', async () => {
    const test = await Setup()
    values.set('delive_deleted_session_snapshots', JSON.stringify([{ version: 1, id: 'record', originalSessionId: 'record', deletedAt: 1 }]))
    await expect(test.hook.retryJob('job')).rejects.toThrow(/new task/)
    await expect(test.hook.reselectOriginal('job', new File(['a'], 'a.wav', { type: 'audio/wav' }))).rejects.toThrow(/new task/)
    expect(test.api.registerOriginalSource).not.toHaveBeenCalled()
    expect(test.api.readMediaAudio).not.toHaveBeenCalled()
    expect(test.api.extractMediaAudio).not.toHaveBeenCalled()
    expect(test.repository.getSessionsSnapshot()).toEqual([])
  })

  it('extracts VIDEO under the source lease and uploads only managed MP3, never selected video bytes', async () => {
    const test = await Setup('video')
    test.api.readMediaAudio.mockResolvedValueOnce({ ok: true, audio: managedAudio('extracted.mp3', 'audio/mpeg'), data: new Uint8Array([3]) } as never)
    await test.hook.reselectOriginal('job', new File(['RAW VIDEO'], 'current.mp4', { type: 'video/mp4' }))
    expect(test.api.readOriginalAudio).not.toHaveBeenCalled()
    expect(test.api.extractMediaAudio).toHaveBeenCalledWith({ taskId: 'job', sessionId: 'record', sourcePath: 'C:/native/selected.wav' })
    const upload = provider.mock.calls[0][1] as File
    expect(upload.name).toBe('extracted.mp3')
    expect(upload.type).toBe('audio/mpeg')
    expect(upload.size).toBe(1)
    expect(test.api.releaseOriginalRead).toHaveBeenCalledOnce()
  })

  it('freezes AUDIO creation projects and config before asynchronous native registration', async () => {
    const test = await Setup()
    let registered!: (value: { ok: boolean; source: { id: string; revision: number; fileName: string } }) => void
    test.api.registerOriginalSource.mockImplementationOnce(() => new Promise((done) => { registered = done }))
    const submittedConfig = structuredClone(config)
    const id = await test.hook.submitFile(new File(['a'], 'initial.wav', { type: 'audio/wav' }), submittedConfig)
    await vi.waitFor(() => expect(test.api.registerOriginalSource).toHaveBeenCalledOnce())
    test.topics.setState({ activeProjectIds: ['later-project'], defaultSaveProjectId: 'later-project' })
    submittedConfig.meetingContext.background = 'Mutated caller config'
    registered({ ok: true, source: { id: 'selected', revision: 1, fileName: 'initial.wav' } })
    await vi.waitFor(() => expect(test.jobs.getState().getJob(id)?.status).toBe('completed'))
    await vi.waitFor(() => expect(test.api.releaseOriginalRead).toHaveBeenCalledOnce())
    const session = test.repository.getSessionsSnapshot()[0]
    expect(session.projectIds).toEqual(['current-project'])
    expect(session.defaultSaveProjectId).toBe('current-project')
    expect(session.meetingContext?.background).toBe('Frozen context')
  })

  it('releases VIDEO lease on extraction failure and does not upload original bytes', async () => {
    const test = await Setup('video')
    test.api.extractMediaAudio.mockRejectedValueOnce(new Error('Extraction failed'))
    await test.hook.reselectOriginal('job', new File(['RAW'], 'input.mp4', { type: 'video/mp4' }))
    expect(test.api.releaseOriginalRead).toHaveBeenCalledOnce()
    expect(test.jobs.getState().getJob('job')?.status).toBe('error')
    expect(provider).not.toHaveBeenCalled()
  })

  it('rejects a non-MP3 managed result for VIDEO retry rather than uploading it', async () => {
    const test = await Setup('video')
    test.api.readMediaAudio.mockResolvedValueOnce({ ok: true, audio: managedAudio('wrong.mp4', 'video/mp4'), data: new Uint8Array([3]) } as never)
    await test.hook.retryJob('job')
    expect(test.jobs.getState().getJob('job')?.error).toMatch(/managed extracted MP3/)
    expect(provider).not.toHaveBeenCalled()
    expect(test.api.acquireOriginalRead).not.toHaveBeenCalled()
  })

  it('rejects a mismatched or older managed pointer without replacing the current task reference', async () => {
    const test = await Setup()
    test.jobs.getState().updateJob('job', { managedAsset: { sessionId: 'record', assetKind: 'extracted-audio', revision: 9 } })
    test.api.readMediaAudio.mockResolvedValueOnce({ ok: true, audio: { ...managedAudio('other.wav', 'audio/wav'), sessionId: 'other-record' }, data: new Uint8Array([3]) } as never)
    await test.hook.retryJob('job')
    expect(test.jobs.getState().getJob('job')?.managedAsset?.revision).toBe(9)
    test.api.readMediaAudio.mockResolvedValueOnce({ ok: true, audio: managedAudio('older.wav', 'audio/wav'), data: new Uint8Array([3]) } as never)
    await test.hook.retryJob('job')
    expect(test.jobs.getState().getJob('job')?.managedAsset?.revision).toBe(9)
    expect(provider).not.toHaveBeenCalled()
  })
})
