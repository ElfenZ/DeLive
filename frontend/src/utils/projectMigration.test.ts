import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateProjectSessions } from './sessionStorage'
import { normalizeTranscriptSession } from './sessionSchema'
import { STORAGE_KEYS } from './storageShared'
import type { TranscriptSession } from '../types'

describe('project Session migration', () => {
  let values: Map<string, string>
  const legacy: TranscriptSession = { id: 'legacy', title: 'Legacy', createdAt: 1, updatedAt: 1, date: '2026-10-02', time: '01:00', transcript: 'unchanged transcript', topicId: 'orphan', schemaVersion: 7 }
  beforeEach(() => {
    values = new Map([[STORAGE_KEYS.SESSIONS, JSON.stringify([legacy])], [STORAGE_KEYS.TOPICS, '[]']])
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
  })

  it('snapshots first, preserves IDs/content/orphans, verifies writes and is reentrant', async () => {
    const upgraded = normalizeTranscriptSession(legacy)
    await expect(migrateProjectSessions([legacy], [upgraded])).resolves.toBe(true)
    expect(JSON.parse(values.get('delive_project_upgrade_v1_snapshot')!)).toEqual({ sessions: [legacy], topics: '[]' })
    expect(JSON.parse(values.get(STORAGE_KEYS.SESSIONS)!)[0]).toMatchObject({ id: 'legacy', transcript: legacy.transcript, projectIds: ['orphan'] })
    expect(values.get('delive_project_upgrade_v1_completed')).toBe('true')
    await expect(migrateProjectSessions([upgraded], [upgraded])).resolves.toBe(false)
  })

  it('leaves original data untouched if the pre-upgrade snapshot cannot be saved', async () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: () => { throw new Error('quota') } })
    await expect(migrateProjectSessions([legacy], [normalizeTranscriptSession(legacy)])).rejects.toThrow('quota')
    expect(values.get(STORAGE_KEYS.SESSIONS)).toBe(JSON.stringify([legacy]))
    expect(values.has('delive_project_upgrade_v1_completed')).toBe(false)
  })

  it('does not mark a silently failed write complete and safely retries using the first snapshot', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { if (key !== STORAGE_KEYS.SESSIONS) values.set(key, value) },
    })
    const upgraded = normalizeTranscriptSession(legacy)
    await expect(migrateProjectSessions([legacy], [upgraded])).rejects.toThrow(/read-back/)
    expect(values.has('delive_project_upgrade_v1_completed')).toBe(false)
    const snapshot = values.get('delive_project_upgrade_v1_snapshot')
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
    await expect(migrateProjectSessions([legacy], [upgraded])).resolves.toBe(true)
    expect(values.get('delive_project_upgrade_v1_snapshot')).toBe(snapshot)
  })

  it('rejects ID or body changes before any disk write', async () => {
    await expect(migrateProjectSessions([legacy], [normalizeTranscriptSession({ ...legacy, id: 'changed' })])).rejects.toThrow(/content changed/)
    await expect(migrateProjectSessions([legacy], [normalizeTranscriptSession({ ...legacy, transcript: 'changed' })])).rejects.toThrow(/content changed/)
    expect(values.has('delive_project_upgrade_v1_snapshot')).toBe(false)
  })
})
