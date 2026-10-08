import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Topic, TranscriptSession } from '../types'
import { ASRVendor } from '../types/asr/common'

const project = (id: string, parentId?: string): Topic => ({ id, parentId, name: id, emoji: '', createdAt: 1, updatedAt: 1 })
const record = (id: string, projectIds: string[]): TranscriptSession => ({ id, projectIds, title: id, createdAt: 1, updatedAt: 1, date: '2026-10-02', time: '01:00', transcript: 'retained transcript', status: 'completed', postProcess: { status: 'success', summary: 'historical summary' } })

describe('project management with real stores and repositories', () => {
  let values: Map<string, string>
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    values = new Map([
      ['desktoplive_topics', JSON.stringify([project('root'), project('child', 'root'), project('leaf', 'child'), project('other')])],
      ['desktoplive_sessions', JSON.stringify([record('shared', ['root', 'child', 'other']), record('nested', ['leaf'])])],
    ])
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('window', { electronAPI: undefined })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
  })

  async function stores() {
    const { useSessionStore } = await import('./sessionStore')
    const { useTopicStore } = await import('./topicStore')
    useTopicStore.getState().loadTopics()
    await useSessionStore.getState().loadSessions()
    return { useSessionStore, useTopicStore }
  }

  it('links multiple projects, projects the first legacy link and unlinks only the requested association', async () => {
    const { useSessionStore } = await stores()
    await useSessionStore.getState().setSessionProjectAssociation('nested', 'other', true)
    await useSessionStore.getState().setSessionProjectAssociation('nested', 'leaf', false)
    const updated = useSessionStore.getState().sessions.find((session) => session.id === 'nested')!
    expect(updated).toMatchObject({ projectIds: ['other'], topicId: 'other', transcript: 'retained transcript' })
    expect(useSessionStore.getState().sessions).toHaveLength(2)
    expect(JSON.parse(values.get('desktoplive_sessions')!).find((session: TranscriptSession) => session.id === 'nested').projectIds).toEqual(['other'])
  })

  it('isolates browsing from explicit creation, resets global navigation and freezes draft ownership', async () => {
    const { useSessionStore, useTopicStore } = await stores()
    const { useUIStore } = await import('./uiStore')
    useUIStore.getState().setReviewFolder({ kind: 'topic', topicId: 'root' })
    expect(useTopicStore.getState().activeProjectIds).toEqual([])
    useUIStore.getState().openTopicCreation('root', 'live')
    const selection = useTopicStore.getState()
    const id = useSessionStore.getState().startNewSession({ projectIds: [...selection.activeProjectIds] })
    useUIStore.getState().setReviewFolder({ kind: 'topic', topicId: 'other' })
    expect(useSessionStore.getState().sessions.find((session) => session.id === id)?.projectIds).toEqual(['root'])
    useUIStore.getState().setView('live')
    expect(useTopicStore.getState().activeProjectIds).toEqual([])
    useTopicStore.getState().updateTopic('child', { archivedAt: 10 })
    useUIStore.getState().openTopicCreation('child', 'file')
    expect(useTopicStore.getState().activeProjectIds).toEqual([])
    useTopicStore.getState().setSelectedTopic('other')
    useUIStore.getState().setView('topics')
    expect(useUIStore.getState()).toMatchObject({ currentView: 'review', reviewFolder: { kind: 'topic', topicId: 'other' } })
    useUIStore.getState().setView('live')
    useUIStore.getState().openReview('nested')
    expect(useUIStore.getState()).toMatchObject({ currentView: 'review', reviewSessionId: 'nested', reviewFolder: { kind: 'all' } })
  })

  it('deletes organization only, reparents children and retains other links and all record content', async () => {
    const { useSessionStore, useTopicStore } = await stores()
    await useTopicStore.getState().deleteTopic('child')
    expect(useTopicStore.getState().topics.find((item) => item.id === 'leaf')?.parentId).toBe('root')
    expect(useTopicStore.getState().topics.some((item) => item.id === 'child')).toBe(false)
    expect(useSessionStore.getState().sessions.find((session) => session.id === 'shared')?.projectIds).toEqual(['root', 'other'])
    expect(useSessionStore.getState().sessions).toHaveLength(2)
    expect(values.has('delive_project_deletion_v1')).toBe(false)
    expect(JSON.parse(values.get('desktoplive_sessions')!).every((session: TranscriptSession) => session.transcript === 'retained transcript')).toBe(true)
  })

  it('uses repository authority rather than a stale UI record list during project deletion', async () => {
    const { useSessionStore, useTopicStore } = await stores()
    useSessionStore.setState({ sessions: [] })
    await useTopicStore.getState().deleteTopic('child')
    const persisted = JSON.parse(values.get('desktoplive_sessions')!) as TranscriptSession[]
    expect(persisted.find((session) => session.id === 'shared')?.projectIds).toEqual(['root', 'other'])
    expect(persisted).toHaveLength(2)
  })

  it('retains replayable deletion intent on failure and resumes without losing concurrent summary updates', async () => {
    const { useSessionStore, useTopicStore } = await stores()
    const setItem = localStorage.setItem.bind(localStorage)
    let fail = true
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { if (fail && key === 'desktoplive_sessions') throw new Error('quota'); setItem(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    await expect(useTopicStore.getState().deleteTopic('child')).rejects.toThrow('quota')
    expect(values.has('delive_project_deletion_v1')).toBe(true)
    expect(useTopicStore.getState().topics.some((item) => item.id === 'child')).toBe(true)
    fail = false
    useSessionStore.getState().updateSessionPostProcess('shared', { summary: 'new summary' })
    await useTopicStore.getState().resumePendingDeletion()
    expect(useSessionStore.getState().sessions.find((session) => session.id === 'shared')?.postProcess?.summary).toBe('new summary')
    expect(useTopicStore.getState().topics.find((item) => item.id === 'leaf')?.parentId).toBe('root')
  })

  it('freezes active multi-selection for draft creation and rejects project cycles', async () => {
    const { useSessionStore, useTopicStore } = await stores()
    useTopicStore.getState().setActiveProjects(['root', 'other'], 'other')
    const selection = useTopicStore.getState()
    const id = useSessionStore.getState().startNewSession({ projectIds: [...selection.activeProjectIds], defaultSaveProjectId: selection.defaultSaveProjectId || undefined })
    useTopicStore.getState().setActiveTopic('child')
    expect(useSessionStore.getState().sessions.find((session) => session.id === id)).toMatchObject({ projectIds: ['root', 'other'], defaultSaveProjectId: 'other' })
    expect(() => useTopicStore.getState().updateTopic('root', { parentId: 'leaf' })).toThrow(/cycles/)
  })

  it('archives without deleting links and preserves read-only results when deleting a record', async () => {
    const { useSessionStore, useTopicStore } = await stores()
    useTopicStore.getState().updateTopic('child', { archivedAt: 123 })
    await expect(useSessionStore.getState().setSessionProjectAssociation('nested', 'child', true)).rejects.toThrow('Project is unavailable')
    await expect(useSessionStore.getState().updateSessionProjects('nested', ['leaf', 'child'])).rejects.toThrow('Project is unavailable')
    expect(useSessionStore.getState().sessions.find((session) => session.id === 'shared')?.projectIds).toContain('child')
    await useSessionStore.getState().deleteSession('shared')
    const { getDeletedSessionSnapshots } = await import('../utils/deletedSessionStorage')
    expect((await getDeletedSessionSnapshots())[0]).toMatchObject({ originalSessionId: 'shared', postProcess: { summary: 'historical summary' } })
    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['nested'])
    expect(JSON.stringify(await getDeletedSessionSnapshots())).not.toContain('retained transcript')
  })

  it('repairs pending file-task links durably without resetting task progress', async () => {
    const { useTopicStore } = await stores()
    const { useFileTranscriptionStore } = await import('./fileTranscriptionStore')
    const jobId = useFileTranscriptionStore.getState().addJob({ fileName: 'video.mp4', fileSize: 1, mimeType: 'video/mp4', inputKind: 'video', provider: ASRVendor.Soniox, sessionId: 'pending-video', projectIds: ['child', 'other'], defaultSaveProjectId: 'child' })
    useFileTranscriptionStore.getState().updateJob(jobId, { status: 'transcribing', progress: 45 })
    await useTopicStore.getState().deleteTopic('child')
    expect(useFileTranscriptionStore.getState().getJob(jobId)).toMatchObject({ projectIds: ['other'], defaultSaveProjectId: 'child', status: 'transcribing', progress: 45 })
    const persisted = JSON.parse(values.get('delive-file-transcription-tasks')!)
    expect(persisted.state.jobs[0]).toMatchObject({ projectIds: ['other'], progress: 45 })
  })

  it('replays a failed file-task persist even when memory was already patched', async () => {
    const { useTopicStore } = await stores()
    const { useFileTranscriptionStore } = await import('./fileTranscriptionStore')
    useFileTranscriptionStore.getState().addJob({ fileName: 'video.mp4', fileSize: 1, mimeType: 'video/mp4', inputKind: 'video', provider: ASRVendor.Soniox, sessionId: 'pending-video', projectIds: ['child'] })
    const setItem = localStorage.setItem.bind(localStorage)
    let fail = true
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (fail && key === 'delive-file-transcription-tasks') throw new Error('task quota')
      setItem(key, value)
    })
    await expect(useTopicStore.getState().deleteTopic('child')).rejects.toThrow('task quota')
    expect(useFileTranscriptionStore.getState().jobs[0].projectIds).toEqual([])
    expect(JSON.parse(values.get('delive-file-transcription-tasks')!).state.jobs[0].projectIds).toEqual(['child'])
    fail = false
    await useTopicStore.getState().resumePendingDeletion()
    expect(JSON.parse(values.get('delive-file-transcription-tasks')!).state.jobs[0].projectIds).toEqual([])
    expect(values.has('delive_project_deletion_v1')).toBe(false)
  })
})
