import { describe, expect, it } from 'vitest'
import { createDraftSession } from './sessionLifecycle'
import { reconcileJobAudio, reconcileMissingSessionAudio, reconcileSessionAudio } from './managedMediaSchema'
import type { MediaArchivedAudio } from '../../../shared/electronApi'
import type { FileTranscriptionJob } from '../types/fileTranscription'
import { ASRVendor } from '../types/asr/common'

const audio: MediaArchivedAudio = { sessionId: 's1', assetKind: 'extracted-audio', revision: 3, path: 'D:/DeLive-media/s1/new.mp3', fileName: 'new.mp3', size: 30, mimeType: 'audio/mpeg' }

describe('revisioned managed audio cache patches', () => {
  it('repairs a nonempty old path without changing original names or content', () => {
    const session = { ...createDraftSession({ id: 's1', title: 'record' }), transcript: 'immutable body', sourceMeta: {
      audioPath: 'C:/old/source-audio.mp3', audioFileName: 'old.mp3', originalFileName: 'import.mp4', currentOriginalFileName: 'current-original.mp4',
      managedAsset: { sessionId: 's1', assetKind: 'extracted-audio' as const, revision: 2 },
    } }
    const patch = reconcileSessionAudio(session, audio)!
    expect(patch).toMatchObject({ audioPath: audio.path, audioAvailable: true, managedAsset: { revision: 3 } })
    expect(patch).not.toHaveProperty('originalFileName')
    expect(patch).not.toHaveProperty('currentOriginalFileName')
    expect(session.transcript).toBe('immutable body')
  })

  it('rejects late revisions and cross-record/kind updates', () => {
    const session = { ...createDraftSession({ id: 's1', title: 'record' }), sourceMeta: { managedAsset: { sessionId: 's1', assetKind: 'extracted-audio' as const, revision: 4 } } }
    expect(reconcileSessionAudio(session, audio)).toBeUndefined()
    expect(reconcileSessionAudio(session, { ...audio, sessionId: 'other', revision: 5 })).toBeUndefined()
    expect(reconcileSessionAudio(session, { ...audio, assetKind: 'recording-audio', revision: 5 })).toBeUndefined()
    expect(reconcileMissingSessionAudio(session, { sessionId: 's1', assetKind: 'extracted-audio', revision: 3 })).toBeUndefined()
  })

  it('updates only managed job fields and preserves upload progress and historical input', () => {
    const job: FileTranscriptionJob = { id: 'j1', sessionId: 's1', fileName: 'original.mp4', currentOriginalFileName: 'renamed.mp4', fileSize: 900,
      inputKind: 'video', mimeType: 'video/mp4', status: 'transcribing', progress: 45, provider: ASRVendor.Soniox, createdAt: 1 }
    const patch = reconcileJobAudio(job, audio)!
    expect({ ...job, ...patch }).toMatchObject({ fileName: 'original.mp4', fileSize: 900, currentOriginalFileName: 'renamed.mp4', progress: 45, status: 'transcribing', audioFileName: 'new.mp3', audioSize: 30 })
    expect(reconcileJobAudio({ ...job, managedAsset: { sessionId: 's1', assetKind: 'extracted-audio', revision: 4 } }, audio)).toBeUndefined()
  })
})
