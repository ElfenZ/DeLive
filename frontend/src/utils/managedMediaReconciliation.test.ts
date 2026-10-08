import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSession } from '../types'
import { ASRVendor } from '../types/asr/common'
import type { MediaArchivedAudio } from '../../../shared/electronApi'

describe('managed audio reconciliation with real repositories', () => {
  beforeEach(() => {
    vi.resetModules()
    const values = new Map<string, string>()
    const session: TranscriptSession = { id: 'record1', title: 'record', date: '2026-10-03', time: '01:00', createdAt: 1, updatedAt: 1, transcript: 'original body',
      sourceMeta: { audioPath: 'C:/old/record1/source-audio.mp3', originalFileName: 'input.mp4', currentOriginalFileName: 'input-renamed.mp4' },
      postProcess: { status: 'success', summary: 'retained summary' } }
    values.set('desktoplive_sessions', JSON.stringify([session]))
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('window', { electronAPI: undefined })
  })
  const audio: MediaArchivedAudio = { sessionId: 'record1', assetKind: 'extracted-audio', revision: 2, path: 'D:/DeLive-media/record1/managed.mp3', fileName: 'managed.mp3', size: 20, mimeType: 'audio/mpeg' }

  async function setup() {
    const { useSessionStore } = await import('../stores/sessionStore')
    const { useFileTranscriptionStore } = await import('../stores/fileTranscriptionStore')
    await useSessionStore.getState().loadSessions()
    for (let i = 0; i < 2; i++) useFileTranscriptionStore.getState().addJob({ sessionId: 'record1', fileName: `original${i}.mp4`, currentOriginalFileName: 'current.mp4', fileSize: 100, mimeType: 'video/mp4', inputKind: 'video', provider: ASRVendor.Soniox })
    return { useSessionStore, useFileTranscriptionStore, reconcile: (await import('./managedMediaReconciliation')).reconcileManagedMedia }
  }

  it('patches the record and every matching job while retaining title, summary, original names and progress', async () => {
    const { useSessionStore, useFileTranscriptionStore, reconcile } = await setup()
    const first = useFileTranscriptionStore.getState().jobs[0]
    useFileTranscriptionStore.getState().updateJob(first.id, { status: 'transcribing', progress: 45 })
    await reconcile({ ok: true, audios: [audio] })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ title: 'record', transcript: 'original body', postProcess: { summary: 'retained summary' }, sourceMeta: { audioPath: audio.path, originalFileName: 'input.mp4', currentOriginalFileName: 'input-renamed.mp4', managedAsset: { revision: 2 } } })
    expect(useFileTranscriptionStore.getState().jobs.every((job) => job.audioPath === audio.path)).toBe(true)
    expect(useFileTranscriptionStore.getState().getJob(first.id)).toMatchObject({ fileName: first.fileName, currentOriginalFileName: 'current.mp4', status: 'transcribing', progress: 45 })
    await reconcile({ ok: true, audios: [{ ...audio, revision: 1, path: 'C:/late/old.mp3' }] })
    expect(useSessionStore.getState().sessions[0].sourceMeta?.audioPath).toBe(audio.path)
    expect(useFileTranscriptionStore.getState().jobs.every((job) => job.audioPath === audio.path)).toBe(true)
  })

  it('does not resurrect a deleted record and marks missing files unavailable without discarding path evidence', async () => {
    const { useSessionStore, useFileTranscriptionStore, reconcile } = await setup()
    await reconcile({ ok: true, audios: [audio] })
    await reconcile({ ok: true, audios: [], deleted: [{ sessionId: audio.sessionId, assetKind: 'extracted-audio', revision: 3 }] })
    expect(useSessionStore.getState().sessions[0].sourceMeta).toMatchObject({ audioAvailable: false, audioPath: audio.path, managedAsset: { revision: 3 } })
    await useSessionStore.getState().deleteSession('record1')
    await reconcile({ ok: true, audios: [{ ...audio, revision: 4 }] })
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useFileTranscriptionStore.getState().jobs).toHaveLength(2)
  })

  it('does not treat a busy/ambiguous or superseded catalog as proof that audio disappeared', async () => {
    const { useSessionStore, reconcile } = await setup()
    await reconcile({ ok: true, audios: [audio] })
    await reconcile({ ok: false, code: 'MEDIA_FILE_BUSY', error: 'busy' })
    await reconcile({ ok: true, audios: [], errors: [{ sessionId: 'record1', error: 'busy recording' }] })
    await reconcile({ ok: true, audios: [] }, () => false)
    expect(useSessionStore.getState().sessions[0].sourceMeta?.audioAvailable).toBe(true)
  })

  it('does not write or publish already-current audio/naming/job state on identical catalog replay', async () => {
    const { useSessionStore, useFileTranscriptionStore, reconcile } = await setup()
    const catalog = { ok: true, audios: [audio], naming: [{ sessionId: 'record1', state: { status: 'saved' as const, titleRevision: 0 } }] }
    await reconcile(catalog)
    const { sessionRepository } = await import('./sessionRepository')
    const write = vi.spyOn(sessionRepository, 'updateMetadataDurable')
    const sessionEvents = vi.fn(), jobEvents = vi.fn()
    const stopSessions = useSessionStore.subscribe(sessionEvents), stopJobs = useFileTranscriptionStore.subscribe(jobEvents)
    const before = useSessionStore.getState().sessions
    try {
      await reconcile(catalog)
      await reconcile(catalog)
      expect(write).not.toHaveBeenCalled()
      expect(sessionEvents).not.toHaveBeenCalled()
      expect(jobEvents).not.toHaveBeenCalled()
      expect(useSessionStore.getState().sessions).toBe(before)
    } finally { stopSessions(); stopJobs(); write.mockRestore() }
  })

  it('publishes successful durable changes even if a later record write fails, without publishing the failed patch', async () => {
    const { useSessionStore, reconcile } = await setup()
    const { sessionRepository } = await import('./sessionRepository')
    const sessions = await sessionRepository.importCompletedSession({ id: 'record2', title: 'record2', date: '2026-10-03', time: '01:00', createdAt: 2, updatedAt: 2, transcript: 'body2' })
    useSessionStore.setState({ sessions })
    const original = sessionRepository.updateMetadataDurable
    const write = vi.spyOn(sessionRepository, 'updateMetadataDurable').mockImplementation(async (id, patch) => {
      if (id === 'record1') throw new Error('disk failure')
      return original(id, patch)
    })
    try {
      await expect(reconcile({ ok: true, audios: [audio, { ...audio, sessionId: 'record2', path: 'D:/DeLive-media/record2/source.mp3' }] })).rejects.toThrow('disk failure')
      expect(useSessionStore.getState().sessions.find((session) => session.id === 'record2')?.sourceMeta?.audioAvailable).toBe(true)
      expect(useSessionStore.getState().sessions.find((session) => session.id === 'record1')?.sourceMeta?.audioPath).toBe('C:/old/record1/source-audio.mp3')
    } finally { write.mockRestore() }
  })
})
