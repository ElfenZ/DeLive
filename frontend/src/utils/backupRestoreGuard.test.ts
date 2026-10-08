import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ currentSessionId: null as string | null, sessions: [] as import('../types').TranscriptSession[], jobs: [] as unknown[] }))
vi.mock('../stores/sessionStore', () => ({ useSessionStore: { getState: () => state } }))
vi.mock('../stores/fileTranscriptionStore', () => ({ useFileTranscriptionStore: { getState: () => ({ getActiveJobs: () => state.jobs }) } }))
import { assertBackupRestoreIdle } from './backupRestoreGuard'

describe('restore entry active-work guard', () => {
  beforeEach(() => { state.currentSessionId = null; state.sessions = []; state.jobs = [] })
  it('permits an idle restore and refuses active recording or file work', () => {
    expect(() => assertBackupRestoreIdle()).not.toThrow()
    state.currentSessionId = 'recording'
    expect(() => assertBackupRestoreIdle()).toThrow(/Stop recording/)
    state.currentSessionId = null
    state.jobs = [{}]
    expect(() => assertBackupRestoreIdle()).toThrow()
  })
  it('refuses overwrite while published corrections or file writes can still return late results', () => {
    const session = { id: 's', title: 'title', createdAt: 1, updatedAt: 1, date: 'date', time: 'time', transcript: 'body' }
    state.sessions = [{ ...session, correctedMarkdownFile: { status: 'saving', revision: 1 } }]
    expect(() => assertBackupRestoreIdle()).toThrow()
    state.sessions = [{ ...session, postProcess: { status: 'pending' } }]
    expect(() => assertBackupRestoreIdle()).toThrow()
    state.sessions = [{ ...session, correctedMarkdownFile: { status: 'conflict', revision: 1 }, postProcess: { status: 'success', summary: 'retained' } }]
    expect(() => assertBackupRestoreIdle()).not.toThrow()
  })
})
