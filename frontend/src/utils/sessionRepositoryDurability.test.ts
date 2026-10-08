import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSession } from '../types'

const storage = vi.hoisted(() => ({
  getSessions: vi.fn(), migrateProjectSessions: vi.fn(), saveSessions: vi.fn(),
  upsertSession: vi.fn(), upsertSessionStrict: vi.fn(), upsertSessions: vi.fn(), deleteSessionById: vi.fn(),
}))
const snapshots = vi.hoisted(() => ({ deleteSessionPreservingResults: vi.fn() }))
vi.mock('./sessionStorage', () => storage)
vi.mock('./deletedSessionStorage', () => snapshots)

const original: TranscriptSession = { id: 'record', title: 'Original', date: '2026-10-02', time: '01:00', createdAt: 1, updatedAt: 1, transcript: 'body', projectIds: ['p'] }

describe('durable Session mutations', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    storage.getSessions.mockResolvedValue([original])
    storage.migrateProjectSessions.mockResolvedValue(false)
    storage.upsertSessions.mockResolvedValue(undefined)
    storage.upsertSession.mockResolvedValue(undefined)
    storage.upsertSessionStrict.mockResolvedValue(undefined)
    snapshots.deleteSessionPreservingResults.mockResolvedValue(undefined)
  })

  it('waits for commit, patches fields only and retains concurrent correction updates', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    await sessionRepository.loadForLaunch()
    let release!: () => void
    storage.upsertSessionStrict.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    let committed = false
    const write = sessionRepository.updateMetadataDurable('record', { projectIds: ['other'] })
    void write.then(() => { committed = true })
    await vi.waitFor(() => expect(storage.upsertSessionStrict).toHaveBeenCalled())
    sessionRepository.updateMetadata('record', { postProcess: { status: 'success', summary: 'Concurrent summary' } })
    expect(committed).toBe(false)
    release()
    const result = await write
    expect(result[0]).toMatchObject({ projectIds: ['other'], postProcess: { summary: 'Concurrent summary' }, transcript: 'body' })
  })

  it('manual publication waits for strict persistence, preserves metadata, survives reload, and retries after disk failure', async () => {
    vi.stubGlobal('window', { electronAPI: undefined })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    const source = { ...original, status: 'completed' as const, transcript: '需要侍应新的工作。'.repeat(4) }
    storage.getSessions.mockResolvedValue([source])
    const { sessionRepository } = await import('./sessionRepository')
    const { useSessionStore } = await import('../stores/sessionStore')
    const { sha256Utf8 } = await import('./correctionPatch')
    useSessionStore.setState({ sessions: (await sessionRepository.loadForLaunch()).sessions, correctionInFlight: {} })
    const expected = { target: 'new' as const, revision: 0, baseTranscriptHash: await sha256Utf8(source.transcript) }
    const edit = { sourceStart: 2, sourceEnd: 4, sourceText: '侍应', replacement: '适应' }
    storage.upsertSessionStrict.mockRejectedValueOnce(new Error('disk quota'))
    await expect(useSessionStore.getState().saveSessionManualCorrection(source.id, edit, expected)).rejects.toThrow('disk quota')
    expect(useSessionStore.getState().sessions[0].correction?.published).toBeUndefined()
    expect(sessionRepository.getSessionsSnapshot()[0].correction?.published).toBeUndefined()
    let commit!: () => void
    storage.upsertSessionStrict.mockImplementationOnce(() => new Promise<void>((resolve) => { commit = resolve }))
    const write = useSessionStore.getState().saveSessionManualCorrection(source.id, edit, expected)
    await vi.waitFor(() => expect(storage.upsertSessionStrict).toHaveBeenCalledTimes(2))
    expect(useSessionStore.getState().sessions[0].correction?.published).toBeUndefined()
    expect(sessionRepository.getSessionsSnapshot()[0].correction?.published).toBeUndefined()
    sessionRepository.updateMetadata(source.id, { title: 'Concurrent title' })
    commit()
    await write
    const saved = sessionRepository.getSessionsSnapshot()[0]
    expect(saved).toMatchObject({ title: 'Concurrent title', transcript: source.transcript, correction: { published: { revision: 1, model: 'manual' } } })
    storage.getSessions.mockResolvedValue([saved])
    expect((await sessionRepository.loadForLaunch()).sessions[0].correction?.published?.patches[0].origin).toBe('manual')
  })

  it('evaluates correction factories inside the repository queue, not before an earlier write commits', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    await sessionRepository.loadForLaunch()
    let release!: () => void
    storage.upsertSessionStrict.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const earlier = sessionRepository.updateMetadataDurable('record', { title: 'Queued title', transcript: 'new source' })
    await vi.waitFor(() => expect(storage.upsertSessionStrict).toHaveBeenCalledOnce())
    const factory = vi.fn(async (current: TranscriptSession) => {
      expect(current.transcript).toBe('new source')
      expect(current.title).toBe('Queued title')
      return { status: 'idle' as const, mode: 'quick' as const }
    })
    const write = sessionRepository.checkpointCorrection('record', factory)
    expect(factory).not.toHaveBeenCalled()
    release()
    await earlier
    await write
    expect(factory).toHaveBeenCalledOnce()
  })

  it('propagates failed durable writes and permits a subsequent retry', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    await sessionRepository.loadForLaunch()
    storage.upsertSessionStrict.mockRejectedValueOnce(new Error('disk'))
    await expect(sessionRepository.updateMetadataDurable('record', { projectIds: [] })).rejects.toThrow('disk')
    const failed = sessionRepository.updateMetadata('missing', {})
    expect(failed[0].projectIds).toEqual(['p'])
    const result = await sessionRepository.updateMetadataDurable('record', { projectIds: [] })
    expect(result[0].projectIds).toEqual([])
    expect(result[0].topicId).toBeUndefined()
  })

  it('preserves unrelated large-record references when changing one record and when rolling back a failed write', async () => {
    const other: TranscriptSession = { ...original, id: 'other', tokens: Array.from({ length: 2000 }, (_, index) => ({ text: `word${index}`, startMs: index * 100 })), segments: [{ text: 'untouched transcript segment' }] }
    storage.getSessions.mockResolvedValue([original, other])
    const { sessionRepository } = await import('./sessionRepository')
    const before = (await sessionRepository.loadForLaunch()).sessions
    const untouched = before.find((session) => session.id === 'other')!
    const result = await sessionRepository.updateMetadataDurable('record', { title: 'Changed title' })
    expect(result.find((session) => session.id === 'other')).toBe(untouched)
    expect(result.find((session) => session.id === 'other')?.tokens).toBe(untouched.tokens)
    expect(result.find((session) => session.id === 'other')?.segments).toBe(untouched.segments)
    storage.upsertSessionStrict.mockRejectedValueOnce(new Error('disk'))
    await expect(sessionRepository.updateMetadataDurable('record', { title: 'Failed title' })).rejects.toThrow('disk')
    expect(sessionRepository.getSessionsSnapshot().find((session) => session.id === 'other')).toBe(untouched)
    expect(sessionRepository.getSessionsSnapshot().find((session) => session.id === 'record')?.title).toBe('Changed title')
  })

  it('skips empty and already-current primitive metadata without writing or changing timestamps', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    const before = (await sessionRepository.loadForLaunch()).sessions[0]
    const empty = await sessionRepository.updateMetadataDurable('record', () => ({}))
    const same = await sessionRepository.updateMetadataDurable('record', { title: before.title })
    expect(storage.upsertSessionStrict).not.toHaveBeenCalled()
    expect(empty[0]).toBe(before)
    expect(same[0]).toBe(before)
  })

  it('blocks deletion on snapshot failure and removes cache only after durable deletion', async () => {
    const { sessionRepository } = await import('./sessionRepository')
    await sessionRepository.loadForLaunch()
    snapshots.deleteSessionPreservingResults.mockRejectedValueOnce(new Error('snapshot failed'))
    await expect(sessionRepository.deleteSessionWithResults('record')).rejects.toThrow('snapshot failed')
    expect(sessionRepository.updateMetadata('missing', {})).toHaveLength(1)
    await expect(sessionRepository.deleteSessionWithResults('record')).resolves.toEqual([])
    expect(storage.deleteSessionById).not.toHaveBeenCalled()
    expect(snapshots.deleteSessionPreservingResults).toHaveBeenCalledWith(expect.objectContaining({ id: 'record', transcript: 'body' }))
    expect(sessionRepository.updateMetadata('record', { title: 'late response' })).toEqual([])
  })
  it('keeps the saved title on disk failure and permits the same requested title to be retried', async () => {
    vi.stubGlobal('window', { electronAPI: undefined })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    const { sessionRepository } = await import('./sessionRepository')
    const { useSessionStore } = await import('../stores/sessionStore')
    const loaded = await sessionRepository.loadForLaunch()
    useSessionStore.setState({ sessions: loaded.sessions })
    storage.upsertSessionStrict.mockRejectedValueOnce(new Error('disk quota'))
    await expect(useSessionStore.getState().updateSessionTitle('record', 'New title')).rejects.toThrow('disk quota')
    expect(useSessionStore.getState().sessions[0].title).toBe('Original')
    expect(sessionRepository.getSessionsSnapshot()[0].title).toBe('Original')
    await expect(useSessionStore.getState().updateSessionTitle('record', 'New title')).resolves.toBe(true)
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ title: 'New title', titleRevision: 1 })
  })
  it('rejects an automatic title based on an old revision even after manual ABA changes', async () => {
    vi.stubGlobal('window', { electronAPI: undefined })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    const { sessionRepository } = await import('./sessionRepository')
    const { useSessionStore } = await import('../stores/sessionStore')
    useSessionStore.setState({ sessions: (await sessionRepository.loadForLaunch()).sessions })
    await useSessionStore.getState().updateSessionTitle('record', 'B')
    await useSessionStore.getState().updateSessionTitle('record', 'Original')
    await expect(useSessionStore.getState().updateSessionTitle('record', 'AI suggestion', 0)).resolves.toBe(false)
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ title: 'Original', titleRevision: 2 })
  })
})
