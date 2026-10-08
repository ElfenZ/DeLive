import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDeletedSessionSnapshot, deleteSessionPreservingResults, getDeletedSessionSnapshots, normalizeDeletedSessionSnapshot } from './deletedSessionStorage'
import { createDraftSession } from './sessionLifecycle'
import { STORAGE_KEYS } from './storageShared'

describe('deleted record results', () => {
  let values: Map<string, string>
  beforeEach(() => {
    values = new Map()
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
  })
  const session = {
    ...createDraftSession({ id: 'deleted', title: 'Historical', projectIds: ['p'], now: 1 }),
    transcript: 'sensitive complete transcript',
    sourceMeta: { audioPath: 'C:/private/audio.wav', originalFileName: 'original.wav' },
    tokens: [{ text: 'sensitive token' }],
    postProcess: { status: 'success' as const, summary: 'Saved summary' },
    mindMap: { status: 'success' as const, markdown: '# Saved map' },
    askHistory: [{ id: 'q', question: 'Question', answer: 'Saved answer', status: 'success' as const, createdAt: 1 }],
    correction: { status: 'done' as const, mode: 'quick' as const, correctedText: 'complete correction body' },
  }

  it('retains historical results without transcript, correction, tokens or local paths', () => {
    const snapshot = buildDeletedSessionSnapshot(session, 2)
    expect(snapshot).toMatchObject({ originalSessionId: 'deleted', title: 'Historical', projectIds: ['p'], deletedAt: 2 })
    expect(snapshot.postProcess?.summary).toBe('Saved summary')
    expect(snapshot.askHistory?.[0].answer).toBe('Saved answer')
    expect(snapshot.mindMap?.markdown).toBe('# Saved map')
    expect(JSON.stringify(snapshot)).not.toMatch(/sensitive|complete correction|private|audioPath/)
    expect(normalizeDeletedSessionSnapshot({ ...snapshot, transcript: 'injected', sourceMeta: session.sourceMeta })).toEqual(snapshot)
  })

  it('persists the snapshot before deleting the original and leaves unrelated records intact', async () => {
    values.set(STORAGE_KEYS.SESSIONS, JSON.stringify([session, { id: 'other', transcript: 'retained' }]))
    await deleteSessionPreservingResults(session)
    expect(JSON.parse(values.get(STORAGE_KEYS.SESSIONS)!)).toEqual([{ id: 'other', transcript: 'retained' }])
    expect((await getDeletedSessionSnapshots())[0].postProcess?.summary).toBe('Saved summary')
  })

  it('does not delete the original when snapshot storage fails', async () => {
    const original = JSON.stringify([session])
    values.set(STORAGE_KEYS.SESSIONS, original)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw new Error('quota') },
    })
    await expect(deleteSessionPreservingResults(session)).rejects.toThrow('quota')
    expect(values.get(STORAGE_KEYS.SESSIONS)).toBe(original)
  })

  it('rejects corrupt snapshot storage instead of losing existing history', async () => {
    values.set('delive_deleted_session_snapshots', '{broken')
    await expect(deleteSessionPreservingResults(session)).rejects.toThrow()
  })
})
