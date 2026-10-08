import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CorrectedMarkdownFileState, CorrectedMarkdownSaveRequest, LocalFileChange } from '../../../shared/fileStorage'
import type { TranscriptSession } from '../types'

const effect = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useEffect: (callback: () => (() => void) | undefined) => { effect.cleanup = callback() },
}))

function fixture(): TranscriptSession {
  return { id: 'record', schemaVersion: 8, projectIds: [], title: 'Saved title', titleRevision: 1, createdAt: 1, updatedAt: 1,
    date: '2026-10-03', time: '01:00', transcript: 'Original',
    correction: { mode: 'quick', status: 'done', published: { id: 'publication', revision: 1, formatVersion: 1,
      baseTranscriptHash: 'original', outputTextHash: 'published', correctedText: 'Published', patches: [],
      model: 'test', completedAt: 2, stats: { applied: 0, reverted: 0, rejected: 0 } } } }
}

describe('published Markdown hook with real Session repository and settings store', () => {
  beforeEach(() => {
    vi.resetModules()
    const storage = new Map<string, string>([['desktoplive_sessions', JSON.stringify([fixture()])]])
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) } })
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('window', {})
  })
  afterEach(() => { effect.cleanup?.(); effect.cleanup = undefined; vi.unstubAllGlobals() })

  async function Setup(enabled = true, initial: Partial<TranscriptSession> = {}, waiting = false) {
    const { useSessionStore } = await import('../stores/sessionStore')
    const { useSettingsStore } = await import('../stores/settingsStore')
    const { sessionRepository } = await import('../utils/sessionRepository')
    await useSessionStore.getState().loadSessions()
    if (Object.keys(initial).length) {
      const sessions = await sessionRepository.updateMetadataDurable('record', initial)
      useSessionStore.setState({ sessions })
    }
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, autoSavePublishedCorrection: enabled } }))
    const save = vi.fn(async (request: CorrectedMarkdownSaveRequest): Promise<{ ok: boolean; file: CorrectedMarkdownFileState }> => ({ ok: true, file: { status: 'saved',
      registrationId: 'owned-file',
      revision: request.publicationRevision, publicationId: request.publicationId, publicationRevision: request.publicationRevision,
      titleRevision: request.titleRevision, path: 'C:/authorized/record.md' } }))
    if (waiting) save.mockImplementationOnce(async () => ({ ok: false, file: { status: 'waiting-directory', revision: 0 } }))
    let changed: ((event: LocalFileChange) => void) | undefined
    vi.stubGlobal('window', { electronAPI: { savePublishedMarkdown: save,
      registerSessionFiles: vi.fn(async (context: { titleRevision: number }) => ({ ok: true, naming: { status: 'saved', titleRevision: context.titleRevision } })),
      getFileStorageStatus: vi.fn(async () => ({ ok: true, status: { configuration: { revision: 1 } } })),
      onFileStorageChanged: (callback: (event: LocalFileChange) => void) => { changed = callback; return () => { changed = undefined } },
    } })
    const { usePublishedMarkdownCoordinator } = await import('./usePublishedMarkdownCoordinator')
    function CoordinatorHarness() { usePublishedMarkdownCoordinator(true) }
    CoordinatorHarness()
    const patch = async (updates: Partial<TranscriptSession>) => {
      const sessions = await sessionRepository.updateMetadataDurable('record', updates)
      useSessionStore.setState({ sessions })
    }
    return { useSessionStore, useSettingsStore, save, patch, changed: (revision: number, activityOnly = false) => changed?.({ sequence: 1, configurationRevision: revision, activityOnly }) }
  }

  it('baselines loaded history, coalesces unrelated updates, and saves a new published revision', async () => {
    const test = await Setup()
    expect(test.save).not.toHaveBeenCalled()
    await test.patch({ postProcess: { status: 'success', summary: 'Unrelated' } })
    expect(test.save).not.toHaveBeenCalled()
    const correction = test.useSessionStore.getState().sessions[0].correction!
    await test.patch({ correction: { ...correction, published: { ...correction.published!, revision: 2, correctedText: 'New published', outputTextHash: 'new' } } })
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledOnce())
    expect(test.save.mock.calls[0][0].content).toContain('New published')
    expect(test.useSessionStore.getState().sessions[0].postProcess?.summary).toBe('Unrelated')
    await test.patch({ postProcess: { status: 'success', summary: 'Another unrelated update' } })
    expect(test.save).toHaveBeenCalledOnce()
  })

  it('uses the independent save toggle while AI is disabled', async () => {
    const test = await Setup(false)
    expect(test.save).not.toHaveBeenCalled()
    test.useSettingsStore.getState().updateSettings({ autoSavePublishedCorrection: true, aiPostProcess: { enabled: false } })
    expect(test.save).not.toHaveBeenCalled()
    const correction = test.useSessionStore.getState().sessions[0].correction!
    await test.patch({ correction: { ...correction, published: { ...correction.published!, revision: 2 } } })
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledOnce())
    test.useSettingsStore.getState().updateSettings({ autoSavePublishedCorrection: false })
    await test.patch({ title: 'Disabled title', titleRevision: 2 })
    expect(test.save).toHaveBeenCalledOnce()
  })

  it('defers full AI workflow until export and saves the final title only', async () => {
    const test = await Setup(false)
    await test.patch({ autoPostProcessWorkflow: { version: 1, status: 'running', step: 'briefing', correctionMode: 'quick', titleAtStart: 'Saved title', startedAt: 1, updatedAt: 1 } })
    test.useSettingsStore.getState().updateSettings({ autoSavePublishedCorrection: true })
    await test.patch({ title: 'Final title', titleRevision: 2 })
    expect(test.save).not.toHaveBeenCalled()
    const workflow = test.useSessionStore.getState().sessions[0].autoPostProcessWorkflow!
    await test.patch({ autoPostProcessWorkflow: { ...workflow, step: 'export', status: 'queued' } })
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledOnce())
    expect(test.save.mock.calls[0][0].content).toContain('Final title')
  })

  it('does not retry a file error for unrelated catalog events or overwrite external conflicts', async () => {
    const test = await Setup(true, { correctedMarkdownFile: { status: 'saved', revision: 1, registrationId: 'owned-file', path: 'C:/authorized/record.md' } })
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(test.useSessionStore.getState().sessions[0].correctedMarkdownFile?.status).toBe('saved'))
    await test.patch({ correctedMarkdownFile: { status: 'conflict', revision: 1, error: 'External edit' } })
    test.changed(2)
    expect(test.save).toHaveBeenCalledOnce()
    await test.patch({ correctedMarkdownFile: { status: 'waiting-directory', revision: 0 } })
    test.changed(2)
    expect(test.save).toHaveBeenCalledOnce()
    test.changed(3)
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledTimes(2))
    test.changed(3)
    expect(test.save).toHaveBeenCalledTimes(2)
  })

  it('does not backfill historical waiting-directory records on directory selection or enabling', async () => {
    const test = await Setup(true, { correctedMarkdownFile: { status: 'waiting-directory', revision: 0 } })
    test.changed(2)
    await Promise.resolve()
    expect(test.save).not.toHaveBeenCalled()
    test.useSettingsStore.getState().updateSettings({ autoSavePublishedCorrection: false })
    const correction = test.useSessionStore.getState().sessions[0].correction!
    await test.patch({ correction: { ...correction, published: { ...correction.published!, revision: 2 } } })
    test.useSettingsStore.getState().updateSettings({ autoSavePublishedCorrection: true })
    test.changed(3)
    await Promise.resolve()
    expect(test.save).not.toHaveBeenCalled()
  })

  it('automatically saves the first publication of a previously unpublished record', async () => {
    const test = await Setup(true, { correction: undefined })
    expect(test.save).not.toHaveBeenCalled()
    await test.patch({ correction: fixture().correction })
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledOnce())
    expect(test.save.mock.calls[0][0].publicationId).toBe('publication')
  })

  it('does not implicitly retry a registered historical conflict on startup or directory change', async () => {
    const test = await Setup(true, { correctedMarkdownFile: { status: 'conflict', revision: 1,
      registrationId: 'owned-file', path: 'C:/authorized/record.md', error: 'External edit' } })
    test.changed(2)
    await Promise.resolve()
    expect(test.save).not.toHaveBeenCalled()
    expect(test.useSessionStore.getState().sessions[0].correctedMarkdownFile?.error).toBe('External edit')
  })

  it('retries a new publication waiting for a directory but ignores activity-only events', async () => {
    const test = await Setup(true, {}, true)
    const correction = test.useSessionStore.getState().sessions[0].correction!
    await test.patch({ correction: { ...correction, published: { ...correction.published!, revision: 2 } } })
    await vi.waitFor(() => expect(test.useSessionStore.getState().sessions[0].correctedMarkdownFile?.status).toBe('waiting-directory'))
    expect(test.save).toHaveBeenCalledOnce()
    test.changed(2, true)
    await Promise.resolve()
    expect(test.save).toHaveBeenCalledOnce()
    test.changed(2)
    await vi.waitFor(() => expect(test.useSessionStore.getState().sessions[0].correctedMarkdownFile?.status).toBe('saved'))
    expect(test.save).toHaveBeenCalledTimes(2)
    test.changed(3)
    expect(test.save).toHaveBeenCalledTimes(2)
  })

  it('resumes explicit active export work but does not replay a completed historical workflow', async () => {
    const test = await Setup(true, { autoPostProcessWorkflow: { version: 1, status: 'queued', step: 'export', correctionMode: 'quick', titleAtStart: 'Saved title', startedAt: 1, updatedAt: 1 } })
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledOnce())
    effect.cleanup?.()
    effect.cleanup = undefined
    const next = await Setup(true, { correctedMarkdownFile: { status: 'waiting-directory', revision: 0 },
      autoPostProcessWorkflow: { version: 1, status: 'completed', step: 'export', correctionMode: 'quick', titleAtStart: 'Saved title', startedAt: 1, updatedAt: 1, completedAt: 2 } })
    next.changed(2)
    await Promise.resolve()
    expect(next.save).not.toHaveBeenCalled()
  })
})
