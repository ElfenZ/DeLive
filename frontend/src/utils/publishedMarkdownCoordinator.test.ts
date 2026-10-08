import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, TranscriptSession, TranscriptAutoPostProcessWorkflow } from '../types'
import type { CorrectedMarkdownFileState, CorrectedMarkdownSaveRequest } from '../../../shared/fileStorage'
import { createPublishedMarkdownCoordinator, isPublishedCorrectionAutoSaveEnabled, publishedMarkdownSourceKey } from './publishedMarkdownCoordinator'
import { buildCorrectedTranscriptMarkdown } from './storageUtils'
import { getSettings } from './settingsStorage'

function makeSession(): TranscriptSession {
  return { id: 'record', title: 'First title', titleRevision: 1, createdAt: 1, updatedAt: 1,
    date: '2026-10-03', time: '01:00', transcript: 'Original body', defaultSaveProjectId: 'project',
    correction: { status: 'done', mode: 'quick', published: { id: 'publication', formatVersion: 1,
      revision: 1, baseTranscriptHash: 'original-hash', outputTextHash: 'corrected-hash', correctedText: 'Published body',
      model: 'model', completedAt: 2, patches: [], stats: { applied: 0, reverted: 0, rejected: 0 } } } }
}
function workflow(step: TranscriptAutoPostProcessWorkflow['step'], status: TranscriptAutoPostProcessWorkflow['status'] = 'running'): TranscriptAutoPostProcessWorkflow {
  return { version: 1, step, status, correctionMode: 'quick', titleAtStart: 'First title', startedAt: 1, updatedAt: 1 }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup() {
  let session: TranscriptSession | undefined = makeSession()
  let enabled = true
  const sync = vi.fn(async () => undefined)
  const save = vi.fn(async (request: CorrectedMarkdownSaveRequest): Promise<{ ok: boolean; file?: CorrectedMarkdownFileState; error?: string }> => ({ ok: true, file: {
    status: 'saved', revision: request.publicationRevision, publicationId: request.publicationId,
    publicationRevision: request.publicationRevision, titleRevision: request.titleRevision, path: 'C:/authorized/one.md',
  } }))
  const patch = vi.fn(async (_id: string, key: string, file: CorrectedMarkdownFileState) => {
    if (session && publishedMarkdownSourceKey(session) === key) session = { ...session, correctedMarkdownFile: file }
  })
  const coordinate = createPublishedMarkdownCoordinator({ read: () => session, enabled: () => enabled,
    sync, save, patch, build: (value) => buildCorrectedTranscriptMarkdown(value, 'Corrected', 'en') })
  return { coordinate, save, sync, patch, read: () => session!, replace: (value: TranscriptSession | undefined) => { session = value }, enable: (value: boolean) => { enabled = value } }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('published Markdown coordinator', () => {
  it('registers logical context without an audio rename pass before native legacy selection', async () => {
    const test = setup()
    const adopt = vi.fn(async (request: CorrectedMarkdownSaveRequest) => ({ ok: true, file: { status: 'saved' as const, revision: 1, publicationId: request.publicationId, path: 'C:/selected/legacy.md' } }))
    const coordinate = createPublishedMarkdownCoordinator({ read: test.read, enabled: () => true, sync: test.sync, save: test.save,
      adoptLegacy: adopt, patch: test.patch, build: () => 'Published body' })
    await coordinate('record', { adoptLegacy: true })
    expect(test.sync).toHaveBeenCalledWith('record', { nameFiles: false })
    expect(adopt).toHaveBeenCalledOnce()
    expect(test.save).not.toHaveBeenCalled()
  })
  it('migrates the old setting only when the independent setting is undefined', () => {
    const settings: AppSettings = { apiKey: '', languageHints: [], aiPostProcess: { autoExportCorrectedMarkdown: true } }
    expect(isPublishedCorrectionAutoSaveEnabled(settings)).toBe(true)
    expect(isPublishedCorrectionAutoSaveEnabled({ ...settings, autoSavePublishedCorrection: false })).toBe(false)
    expect(isPublishedCorrectionAutoSaveEnabled({ ...settings, aiPostProcess: { enabled: false }, autoSavePublishedCorrection: true })).toBe(true)
  })

  it('normalizes persisted settings without reviving an explicitly disabled independent switch', () => {
    let persisted: AppSettings = { apiKey: '', languageHints: [], aiPostProcess: { autoExportCorrectedMarkdown: true } }
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(persisted) })
    expect(getSettings().autoSavePublishedCorrection).toBe(true)
    persisted = { ...persisted, autoSavePublishedCorrection: false }
    expect(getSettings().autoSavePublishedCorrection).toBe(false)
  })

  it('does not save legacy corrected text or review-only unpublished candidates', async () => {
    const test = setup()
    test.replace({ ...makeSession(), correction: { mode: 'review', status: 'reviewing', correctedText: 'unpublished', legacy: { source: 'v3-corrected-text', correctedText: 'legacy' } } })
    await test.coordinate('record')
    expect(test.save).not.toHaveBeenCalled()
    expect(test.sync).not.toHaveBeenCalled()
  })

  it('uses the common builder, published source, frozen project and verified legacy path', async () => {
    const test = setup()
    test.replace({ ...test.read(), autoPostProcessWorkflow: { ...workflow('export'), exportPath: 'C:/authorized/legacy.md' } })
    const result = await test.coordinate('record')
    expect(test.save).toHaveBeenCalledWith({ sessionId: 'record', projectId: 'project', publicationId: 'publication', publicationRevision: 1,
      titleRevision: 1, content: buildCorrectedTranscriptMarkdown(makeSession(), 'Corrected', 'en'), legacyPath: 'C:/authorized/legacy.md' })
    expect(result?.status).toBe('saved')
    expect(test.read().correctedMarkdownFile?.path).toBe('C:/authorized/one.md')
  })

  it.each(['correction', 'briefing', 'title'] as const)('defers a full workflow at %s until export', async (step) => {
    const test = setup()
    test.replace({ ...test.read(), autoPostProcessWorkflow: workflow(step) })
    await test.coordinate('record')
    expect(test.save).not.toHaveBeenCalled()
    test.replace({ ...test.read(), autoPostProcessWorkflow: workflow('export') })
    await test.coordinate('record')
    expect(test.save).toHaveBeenCalledOnce()
  })

  it('does not let a prior failed AI workflow block a newly published standalone correction', async () => {
    const test = setup()
    test.replace({ ...test.read(), autoPostProcessWorkflow: workflow('briefing', 'error') })
    await test.coordinate('record')
    expect(test.save).toHaveBeenCalledOnce()
    expect(test.read().autoPostProcessWorkflow?.status).toBe('error')
  })

  it('coalesces concurrent duplicate notifications and returns the saved state to all callers', async () => {
    const test = setup()
    const first = test.coordinate('record')
    const second = test.coordinate('record')
    expect(first).toBe(second)
    await first
    expect(test.save).toHaveBeenCalledOnce()
    const duplicate = await test.coordinate('record')
    expect(duplicate?.status).toBe('saved')
    expect(test.save).toHaveBeenCalledOnce()
  })

  it('recomputes latest title/publication after registration before building the request', async () => {
    const test = setup()
    test.sync.mockImplementationOnce(async () => {
      const value = test.read()
      test.replace({ ...value, title: 'Latest title', titleRevision: 2, correction: { ...value.correction!, published: { ...value.correction!.published!, revision: 2, correctedText: 'Latest published body' } } })
    })
    await test.coordinate('record')
    expect(test.save.mock.calls[0][0]).toMatchObject({ titleRevision: 2, publicationRevision: 2 })
    expect(test.save.mock.calls[0][0].content).toContain('# Latest title')
    expect(test.save.mock.calls[0][0].content).toContain('Latest published body')
  })

  it('serializes changes arriving in flight and never patches superseded file results', async () => {
    const test = setup()
    const gate = deferred<{ ok: boolean; file: CorrectedMarkdownFileState }>()
    const started = deferred<void>()
    test.save.mockImplementationOnce(async () => { started.resolve(); return gate.promise })
    const running = test.coordinate('record')
    await started.promise
    test.replace({ ...test.read(), title: 'New title', titleRevision: 2 })
    void test.coordinate('record')
    gate.resolve({ ok: true, file: { status: 'saved', revision: 1, titleRevision: 1, path: 'C:/stale.md' } })
    await running
    expect(test.save).toHaveBeenCalledTimes(2)
    expect(test.save.mock.calls[1][0].content).toContain('New title')
    expect(test.patch.mock.calls.some((call) => call[2].path === 'C:/stale.md')).toBe(false)
    expect(test.read().correctedMarkdownFile?.titleRevision).toBe(2)
  })

  it.each(['delete', 'replace'] as const)('fences late responses after Session %s', async (kind) => {
    const test = setup()
    const gate = deferred<{ ok: boolean; file: CorrectedMarkdownFileState }>()
    const started = deferred<void>()
    test.save.mockImplementationOnce(async () => { started.resolve(); return gate.promise })
    const running = test.coordinate('record')
    await started.promise
    test.replace(kind === 'delete' ? undefined : { ...makeSession(), createdAt: 99 })
    gate.resolve({ ok: true, file: { status: 'saved', revision: 1, path: 'C:/late.md' } })
    await running
    expect(test.patch.mock.calls.some((call) => call[2].path === 'C:/late.md')).toBe(false)
    expect(test.save).toHaveBeenCalledOnce()
  })

  it('honors disable, allows explicit file-only retry, and retains AI success on conflict', async () => {
    const test = setup()
    test.enable(false)
    await test.coordinate('record')
    expect(test.save).not.toHaveBeenCalled()
    test.replace({ ...test.read(), postProcess: { status: 'success', summary: 'Retained summary' }, autoPostProcessWorkflow: workflow('export', 'completed') })
    test.save.mockResolvedValueOnce({ ok: false, file: { status: 'conflict', revision: 1, error: 'External edit' } })
    await expect(test.coordinate('record', { retry: true })).resolves.toMatchObject({ status: 'conflict' })
    expect(test.read().postProcess?.status).toBe('success')
    expect(test.read().autoPostProcessWorkflow?.status).toBe('completed')
    await test.coordinate('record', { retry: true })
    expect(test.save).toHaveBeenCalledTimes(2)
  })

  it('preserves a missing-directory status and catches native capability/cache errors without rejecting AI', async () => {
    const test = setup()
    test.save.mockResolvedValueOnce({ ok: false, file: { status: 'waiting-directory', revision: 0, error: 'Choose a directory' } })
    await expect(test.coordinate('record')).resolves.toMatchObject({ status: 'waiting-directory' })
    test.save.mockRejectedValueOnce(new Error('Native unavailable'))
    await expect(test.coordinate('record', { retry: true })).resolves.toMatchObject({ status: 'error', error: 'Native unavailable' })
    test.patch.mockRejectedValue(new Error('Storage full'))
    await expect(test.coordinate('record', { retry: true })).resolves.toMatchObject({ status: 'error', error: 'Storage full' })
  })

  it('reconciles restart through main even when the Session cache already reports saved', async () => {
    const test = setup()
    await test.coordinate('record')
    const reboot = createPublishedMarkdownCoordinator({ read: test.read, enabled: () => true, sync: test.sync,
      save: test.save, patch: test.patch, build: (session) => buildCorrectedTranscriptMarkdown(session, 'Corrected', 'en') })
    await reboot('record')
    expect(test.save).toHaveBeenCalledTimes(2)
  })
})
