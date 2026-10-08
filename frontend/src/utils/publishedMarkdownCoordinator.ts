import type { AppSettings, TranscriptSession } from '../types'
import type { CorrectedMarkdownFileState, CorrectedMarkdownSaveRequest } from '../../../shared/fileStorage'
import { buildCorrectedTranscriptMarkdown } from './storageUtils'
import { sessionRepository } from './sessionRepository'
import { syncSessionFiles } from './sessionFileSync'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

export function isPublishedCorrectionAutoSaveEnabled(settings: AppSettings): boolean {
  return settings.autoSavePublishedCorrection === undefined
    ? settings.aiPostProcess?.autoExportCorrectedMarkdown === true
    : settings.autoSavePublishedCorrection === true
}

export function publishedMarkdownSourceKey(session: TranscriptSession): string {
  const published = session.correction?.published
  return JSON.stringify([session.createdAt, published?.id, published?.revision,
    published?.outputTextHash, session.titleRevision || 0, session.title])
}

function waitsForWorkflowTitle(session: TranscriptSession): boolean {
  const workflow = session.autoPostProcessWorkflow
  return Boolean(workflow && (workflow.status === 'queued' || workflow.status === 'running' || workflow.status === 'waiting-review')
    && workflow.step !== 'export')
}

interface CoordinatorDependencies {
  read: (id: string) => TranscriptSession | undefined
  enabled: () => boolean
  sync: (id: string, options?: { nameFiles?: boolean }) => Promise<void>
  build: (session: TranscriptSession) => string
  save: (request: CorrectedMarkdownSaveRequest) => Promise<{ ok: boolean; file?: CorrectedMarkdownFileState; error?: string }>
  adoptLegacy?: CoordinatorDependencies['save']
  patch: (id: string, key: string, file: CorrectedMarkdownFileState) => Promise<void>
}

export function createPublishedMarkdownCoordinator(deps: CoordinatorDependencies) {
  const pending = new Map<string, { promise: Promise<CorrectedMarkdownFileState | undefined>; dirty: boolean; retry: boolean; adoptLegacy: boolean }>()
  const completed = new Map<string, string>()
  return function coordinate(id: string, options: { retry?: boolean; adoptLegacy?: boolean } = {}): Promise<CorrectedMarkdownFileState | undefined> {
    const existing = pending.get(id)
    if (existing) {
      existing.dirty = true
      existing.retry ||= options.retry === true
      existing.adoptLegacy ||= options.adoptLegacy === true
      return existing.promise
    }
    const work = { promise: Promise.resolve<CorrectedMarkdownFileState | undefined>(undefined), dirty: true, retry: options.retry === true || options.adoptLegacy === true, adoptLegacy: options.adoptLegacy === true }
    pending.set(id, work)
    work.promise = Promise.resolve().then(async () => {
      let result: CorrectedMarkdownFileState | undefined
      let attempted: string | undefined
      while (work.dirty) {
        work.dirty = false
        const retry = work.retry
        const adoptLegacy = work.adoptLegacy
        work.retry = false
        work.adoptLegacy = false
        let session = deps.read(id)
        if (!session?.correction?.published || (!deps.enabled() && !retry)) break
        if (waitsForWorkflowTitle(session)) break
        let key = publishedMarkdownSourceKey(session)
        if (!retry && (completed.get(id) === key || attempted === key)) { result ||= session.correctedMarkdownFile; break }
        const incarnation = session.createdAt
        try {
          // Native legacy selection needs current logical context, not a blocking audio rename pass.
          await deps.sync(id, adoptLegacy ? { nameFiles: false } : undefined)
          session = deps.read(id)
          if (!session?.correction?.published || session.createdAt !== incarnation || (!deps.enabled() && !retry)) break
          if (waitsForWorkflowTitle(session)) break
          key = publishedMarkdownSourceKey(session)
          if (!retry && (completed.get(id) === key || attempted === key)) { result ||= session.correctedMarkdownFile; break }
          attempted = key
          const published = session.correction.published
          await deps.patch(id, key, { ...session.correctedMarkdownFile, status: 'saving', revision: session.correctedMarkdownFile?.revision || 0, error: undefined })
          // Recheck after the durable status write: deletion/title/publication can race it.
          const current = deps.read(id)
          if (current && current.createdAt !== incarnation) break
          if (!current || publishedMarkdownSourceKey(current) !== key) { work.dirty = Boolean(current); continue }
          const response = await (adoptLegacy && deps.adoptLegacy ? deps.adoptLegacy : deps.save)({ sessionId: id, projectId: session.defaultSaveProjectId,
            publicationId: published.id, publicationRevision: published.revision,
            titleRevision: session.titleRevision || 0, content: deps.build(session),
            legacyPath: session.autoPostProcessWorkflow?.exportPath })
          result = response.file || { ...session.correctedMarkdownFile, status: 'error', revision: session.correctedMarkdownFile?.revision || 0,
            publicationId: published.id, publicationRevision: published.revision, titleRevision: session.titleRevision || 0,
            error: response.error || 'Corrected Markdown saving is unavailable' }
          if (!response.ok && !result.error) result = { ...result, error: response.error }
          const latest = deps.read(id)
          if (!latest || latest.createdAt !== incarnation) break
          if (publishedMarkdownSourceKey(latest) !== key) {
            work.dirty = true; continue
          }
          await deps.patch(id, key, result)
          if (response.ok && result.status === 'saved') completed.set(id, key)
        } catch (error) {
          result = { ...session?.correctedMarkdownFile, status: 'error', revision: session?.correctedMarkdownFile?.revision || 0,
            error: error instanceof Error ? error.message : String(error) }
          // File errors are not AI errors; even a failed local cache patch must not reject the AI chain.
          try { await deps.patch(id, key, result) } catch { /* main registration remains authoritative */ }
        }
      }
      return result
    }).finally(() => { if (pending.get(id) === work) pending.delete(id) })
    return work.promise
  }
}

export const savePublishedMarkdown = createPublishedMarkdownCoordinator({
  read: (id) => sessionRepository.getSessionsSnapshot().find((session) => session.id === id),
  enabled: () => isPublishedCorrectionAutoSaveEnabled(useSettingsStore.getState().settings),
  sync: syncSessionFiles,
  build: (session) => buildCorrectedTranscriptMarkdown(session, useUIStore.getState().t.preview.correctionCorrected, useUIStore.getState().language),
  save: async (request) => {
    if (!window.electronAPI?.savePublishedMarkdown) return { ok: false, error: 'Automatic file saving requires the desktop app' }
    return window.electronAPI.savePublishedMarkdown(request)
  },
  adoptLegacy: async (request) => {
    if (!window.electronAPI?.adoptLegacyPublishedMarkdown) return { ok: false, error: 'Legacy adoption requires the desktop app' }
    return await window.electronAPI.adoptLegacyPublishedMarkdown(request) || { ok: false, error: 'Legacy adoption was cancelled; no file changed' }
  },
  patch: async (id, key, file) => {
    if (!sessionRepository.getSessionsSnapshot().some((session) => session.id === id)) return
    const sessions = await sessionRepository.updateMetadataDurable(id, (session) =>
      publishedMarkdownSourceKey(session) === key ? { correctedMarkdownFile: file } : {})
    useSessionStore.setState({ sessions })
  },
})
