import type { OriginalSourceInfo } from '../../../shared/originalSources'
import { sessionRepository } from './sessionRepository'
import { useSessionStore } from '../stores/sessionStore'
import { useFileTranscriptionStore } from '../stores/fileTranscriptionStore'

export async function reconcileOriginalSource(source: OriginalSourceInfo): Promise<void> {
  for (const snapshot of sessionRepository.getSessionsSnapshot()) {
    if (snapshot.sourceMeta?.originalSourceId !== source.id || (snapshot.sourceMeta.originalSourceRevision || 0) > source.revision) continue
    if (snapshot.sourceMeta.originalSourceRevision === source.revision && snapshot.sourceMeta.currentOriginalFileName === source.fileName) continue
    const sessions = await sessionRepository.updateMetadataDurable(snapshot.id, (current) => current.sourceMeta?.originalSourceId !== source.id || (current.sourceMeta.originalSourceRevision || 0) > source.revision ? {} : {
      sourceMeta: { ...current.sourceMeta, currentOriginalFileName: source.fileName, originalSourceRevision: source.revision },
    })
    useSessionStore.setState({ sessions })
  }
  for (const job of useFileTranscriptionStore.getState().jobs) if (job.originalSourceId === source.id && (job.originalSourceRevision || 0) <= source.revision) {
    if (job.originalSourceRevision === source.revision && job.currentOriginalFileName === source.fileName) continue
    useFileTranscriptionStore.getState().updateJob(job.id, { currentOriginalFileName: source.fileName, originalSourceRevision: source.revision })
  }
}

export async function reconcileOriginalSourceCatalog(isCurrent: () => boolean = () => true): Promise<void> {
  if (!window.electronAPI?.listOriginalSources) return
  const result = await window.electronAPI.listOriginalSources()
  if (!isCurrent()) return
  if (!result.ok) throw new Error(result.error || 'Original registry unavailable; cached references retained')
  for (const source of result.sources || []) {
    if (!isCurrent()) return
    await reconcileOriginalSource(source)
  }
}
