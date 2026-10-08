import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSession } from '../types'
import { ASRVendor } from '../types/asr/common'

describe('authoritative original-source catalog recovery', () => {
  beforeEach(() => {
    vi.resetModules()
    const record = (id: string, revision = 1): TranscriptSession => ({ id, title: id, date: '2026-10-05', time: '01:00', createdAt: 1, updatedAt: 1, transcript: `${id} retained transcript`,
      sourceMeta: { originalSourceId: 'source1', originalSourceRevision: revision, originalFileName: 'historical-import.wav', currentOriginalFileName: revision > 2 ? 'newer.wav' : 'old.wav', audioFileName: 'managed.wav' } })
    const data = new Map([['desktoplive_sessions', JSON.stringify([record('s1'), record('s2'), record('newer', 3)])]])
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } })
    vi.stubGlobal('window', { electronAPI: { listOriginalSources: vi.fn().mockResolvedValue({ ok: true, sources: [{ id: 'source1', revision: 2, fileName: 'renamed.wav', size: 10, sha256: 'a'.repeat(64) }] }) } })
  })

  it('repairs all persisted matching references after a lost rename event, preserving imported and managed names', async () => {
    const { useSessionStore } = await import('../stores/sessionStore')
    const { useFileTranscriptionStore } = await import('../stores/fileTranscriptionStore')
    const { getSessions } = await import('./sessionStorage')
    await useSessionStore.getState().loadSessions()
    for (const id of ['s1', 's2']) useFileTranscriptionStore.getState().addJob({ sessionId: id, inputKind: 'audio', fileName: 'historical-import.wav', fileSize: 10, mimeType: 'audio/wav', provider: ASRVendor.Soniox,
      originalSourceId: 'source1', originalSourceRevision: 1, currentOriginalFileName: 'old.wav', audioFileName: 'managed.wav' })
    const { reconcileOriginalSourceCatalog } = await import('./originalSourceReconciliation')
    await reconcileOriginalSourceCatalog()
    for (const record of (await getSessions()).filter((record) => record.id !== 'newer')) expect(record.sourceMeta).toMatchObject({ originalSourceRevision: 2, currentOriginalFileName: 'renamed.wav', originalFileName: 'historical-import.wav', audioFileName: 'managed.wav' })
    expect(useSessionStore.getState().sessions.find((record) => record.id === 'newer')?.sourceMeta).toMatchObject({ originalSourceRevision: 3, currentOriginalFileName: 'newer.wav' })
    for (const job of useFileTranscriptionStore.getState().jobs) expect(job).toMatchObject({ currentOriginalFileName: 'renamed.wav', originalSourceRevision: 2, fileName: 'historical-import.wav', audioFileName: 'managed.wav' })
    // Simulate another renderer launch after durable updates; no event needs to be replayed.
    await useSessionStore.getState().loadSessions()
    await reconcileOriginalSourceCatalog()
    expect(useSessionStore.getState().sessions).toHaveLength(3)
    expect(useSessionStore.getState().sessions[0].transcript).toContain('retained transcript')
  })

  it('retains caches when the registry fails and ignores a disposed/superseded catalog', async () => {
    const { useSessionStore } = await import('../stores/sessionStore')
    await useSessionStore.getState().loadSessions()
    const { reconcileOriginalSourceCatalog } = await import('./originalSourceReconciliation')
    await reconcileOriginalSourceCatalog(() => false)
    expect(useSessionStore.getState().sessions.find((record) => record.id === 's1')?.sourceMeta?.currentOriginalFileName).toBe('old.wav')
    vi.mocked(window.electronAPI!.listOriginalSources).mockResolvedValue({ ok: false, error: 'Registry conflict' })
    await expect(reconcileOriginalSourceCatalog()).rejects.toThrow('Registry conflict')
    expect(useSessionStore.getState().sessions).toHaveLength(3)
  })
})
