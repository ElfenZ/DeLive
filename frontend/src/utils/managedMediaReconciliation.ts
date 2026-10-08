import { useSessionStore } from '../stores/sessionStore'
import { useFileTranscriptionStore } from '../stores/fileTranscriptionStore'
import { sessionRepository } from './sessionRepository'
import { reconcileJobAudio, reconcileMissingSessionAudio, reconcileSessionAudio } from './managedMediaSchema'
import type { MediaListAudioResult } from '../../../shared/electronApi'
import { getDeletedSessionSnapshots } from './deletedSessionStorage'
import type { ManagedNamingState } from '../../../shared/fileStorage'
import type { TranscriptSession } from '../types'

let queue: Promise<void> = Promise.resolve()

function namingChanged(session: TranscriptSession, incoming: ManagedNamingState | undefined): boolean {
  const current = session.managedNaming
  return Boolean(incoming && incoming.titleRevision >= Math.max(session.titleRevision || 0, current?.titleRevision || 0)
    && (!current || current.status !== incoming.status || current.titleRevision !== incoming.titleRevision || current.error !== incoming.error))
}

export function reconcileManagedMedia(result?: MediaListAudioResult, isCurrent: () => boolean = () => true): Promise<void> {
  const operation = queue.catch(() => undefined).then(async () => {
    const catalog = result || await window.electronAPI?.listMediaAudio()
    if (!catalog || catalog.code === 'MEDIA_FILE_BUSY' || !isCurrent()) return
    const audios = new Map((catalog.audios || []).map((audio) => [audio.sessionId, audio]))
    const namingStates = new Map((catalog.naming || []).map((item) => [item.sessionId, item.state]))
    const ambiguous = new Set((catalog.errors || []).map((item) => item.sessionId))
    let sessionChanged = false
    try {
    for (const snapshot of sessionRepository.getSessionsSnapshot()) {
      if (!isCurrent()) break
      const naming = namingStates.get(snapshot.id)
      if (ambiguous.has(snapshot.id)) continue
      const audio = audios.get(snapshot.id)
      const missing = catalog.deleted?.find((ref) => ref.sessionId === snapshot.id)
      const patch = audio ? reconcileSessionAudio(snapshot, audio) : reconcileMissingSessionAudio(snapshot, missing, catalog.error)
      if (!patch && !namingChanged(snapshot, naming)) continue
      try {
        let recordChanged = false
        await sessionRepository.updateMetadataDurable(snapshot.id, (current) => {
          if (!isCurrent()) return {}
          const next = audio ? reconcileSessionAudio(current, audio) : reconcileMissingSessionAudio(current, missing, catalog.error)
          const updateNaming = namingChanged(current, naming)
          recordChanged = Boolean(next || updateNaming)
          return { ...(next ? { sourceMeta: { ...current.sourceMeta, ...next } } : {}), ...(updateNaming ? { managedNaming: naming } : {}) }
        })
        sessionChanged ||= recordChanged
      } catch (error) {
        if (sessionRepository.getSessionsSnapshot().some((session) => session.id === snapshot.id)) throw error
      }
    }
    } finally {
    if (sessionChanged && isCurrent()) {
      const sessions = sessionRepository.getSessionsSnapshot()
      const recoverySession = useSessionStore.getState().recoverySession
      useSessionStore.setState({ sessions, recoverySession: recoverySession ? sessions.find((session) => session.id === recoverySession.id) || null : null })
    }
    }
    if (!isCurrent()) return
    const deletedRecords = new Set((await getDeletedSessionSnapshots()).map((snapshot) => snapshot.originalSessionId))
    const store = useFileTranscriptionStore.getState()
    for (const job of store.jobs) {
      if (!job.sessionId || ambiguous.has(job.sessionId) || deletedRecords.has(job.sessionId)) continue
      const current = useFileTranscriptionStore.getState().getJob(job.id)
      if (!current) continue
      const audio = audios.get(job.sessionId)
      if (audio) {
        const patch = reconcileJobAudio(current, audio)
        if (patch) store.updateJob(job.id, patch)
      } else {
        const tombstone = catalog.deleted?.find((ref) => ref.sessionId === job.sessionId && (!current.managedAsset || ref.assetKind === current.managedAsset.assetKind))
        if (!current.audioPath && !current.managedAsset && !tombstone) continue
        if (tombstone && current.managedAsset && tombstone.revision < current.managedAsset.revision) continue
        if (current.audioAvailable === false && current.requiresSourceSelection === true && (!tombstone || (current.managedAsset?.assetKind === tombstone.assetKind && current.managedAsset.revision === tombstone.revision))) continue
        store.updateJob(job.id, { audioAvailable: false, requiresSourceSelection: true, ...(tombstone ? { managedAsset: tombstone } : {}) })
      }
    }
  })
  queue = operation
  return operation
}
