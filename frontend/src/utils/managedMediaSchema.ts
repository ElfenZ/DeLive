import type { TranscriptSession, TranscriptSourceMeta } from '../types'
import type { FileTranscriptionJob } from '../types/fileTranscription'
import type { MediaArchivedAudio } from '../../../shared/electronApi'
import type { ManagedAssetReference, ManagedNamingState } from '../../../shared/fileStorage'

export function reconcileSessionNaming(session: TranscriptSession, incoming: ManagedNamingState | undefined): ManagedNamingState | undefined {
  const current = session.managedNaming
  if (!incoming || !Number.isSafeInteger(incoming.titleRevision) || incoming.titleRevision < Math.max(session.titleRevision || 0, current?.titleRevision || 0)) return undefined
  if (current && current.status === incoming.status && current.titleRevision === incoming.titleRevision && current.error === incoming.error) return undefined
  return incoming
}

export function managedAudioReference(audio: MediaArchivedAudio): ManagedAssetReference | undefined {
  if ((audio.assetKind !== 'recording-audio' && audio.assetKind !== 'extracted-audio') || !Number.isSafeInteger(audio.revision) || !audio.revision || audio.revision < 1) return undefined
  return { sessionId: audio.sessionId, assetKind: audio.assetKind, revision: audio.revision }
}

function acceptsReference(current: ManagedAssetReference | undefined, incoming: ManagedAssetReference): boolean {
  return !current || (current.sessionId === incoming.sessionId && current.assetKind === incoming.assetKind && current.revision <= incoming.revision)
}

export function reconcileSessionAudio(session: TranscriptSession, audio: MediaArchivedAudio): Partial<TranscriptSourceMeta> | undefined {
  const ref = managedAudioReference(audio)
  if (session.id !== audio.sessionId || !ref || !acceptsReference(session.sourceMeta?.managedAsset, ref)) return undefined
  const current = session.sourceMeta
  if (current?.audioPath === audio.path && current.audioFileName === audio.fileName && current.audioSize === audio.size
    && current.audioMimeType === audio.mimeType && current.managedAsset?.revision === ref.revision && current.audioAvailable === true && !current.audioError) return undefined
  return { managedAsset: ref, audioPath: audio.path, audioFileName: audio.fileName, audioSize: audio.size, audioMimeType: audio.mimeType,
    audioAvailable: true, audioError: undefined, sourceKind: ref.assetKind === 'recording-audio' ? 'recording-audio' : 'extracted-video-audio' }
}

export function reconcileJobAudio(job: FileTranscriptionJob, audio: MediaArchivedAudio): Partial<FileTranscriptionJob> | undefined {
  const ref = managedAudioReference(audio)
  if (job.sessionId !== audio.sessionId || !ref || !acceptsReference(job.managedAsset, ref)) return undefined
  if (job.audioPath === audio.path && job.audioFileName === audio.fileName && job.audioMimeType === audio.mimeType && job.audioSize === audio.size
    && job.managedAsset?.revision === ref.revision && job.audioAvailable === true && job.requiresSourceSelection === false) return undefined
  return { managedAsset: ref, audioPath: audio.path, audioFileName: audio.fileName, audioMimeType: audio.mimeType, audioSize: audio.size, audioAvailable: true, requiresSourceSelection: false }
}

export function reconcileMissingSessionAudio(session: TranscriptSession, tombstone?: ManagedAssetReference, error = 'Managed audio is unavailable'): Partial<TranscriptSourceMeta> | undefined {
  const current = session.sourceMeta
  if (!current?.managedAsset && !current?.audioPath) return undefined
  if (tombstone && !acceptsReference(current?.managedAsset, tombstone)) return undefined
  if (current.audioAvailable === false && current.audioError === error && (!tombstone || current.managedAsset?.revision === tombstone.revision)) return undefined
  return { audioAvailable: false, audioError: error, ...(tombstone ? { managedAsset: tombstone } : {}) }
}
