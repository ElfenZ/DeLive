import { useState } from 'react'
import type { TranscriptSession } from '../types'
import { useUIStore } from '../stores/uiStore'
import { useTopicStore } from '../stores/topicStore'
import { useSessionStore } from '../stores/sessionStore'
import { useFileTranscriptionStore } from '../stores/fileTranscriptionStore'
import { getDirectProjectIds, selectProjectSessions } from '../utils/projectSchema'
import { ActionDialog } from './ActionDialog'

export function SessionDeleteDialog({ session, onClose }: { session: TranscriptSession | null; onClose: () => void }) {
  const { t } = useUIStore()
  const topics = useTopicStore((state) => state.topics)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const affected = session ? topics.filter((project) => selectProjectSessions([session], topics, project.id).length).map((project) => project.name) : []
  const orphanIds = session ? getDirectProjectIds(session).filter((id) => !topics.some((project) => project.id === id)) : []
  const hasManagedAudio = Boolean(session?.sourceMeta?.managedAsset || session?.sourceMeta?.audioPath)
  const close = () => { if (!pending) { setError(''); onClose() } }
  const remove = async (withAudio: boolean) => {
    if (!session || pending) return
    setPending(true)
    setError('')
    try {
      // Snapshot failure must leave both the original record and media untouched.
      await useSessionStore.getState().deleteSession(session.id)
      if (withAudio) {
        const result = await window.electronAPI?.deleteMediaAudio(session.id)
        if (!result || (!result.ok && result.code !== 'MEDIA_AUDIO_MISSING')) throw new Error(result?.error || t.history.deleteAudioFailed)
        for (const job of useFileTranscriptionStore.getState().jobs.filter((item) => item.sessionId === session.id)) {
          useFileTranscriptionStore.getState().updateJob(job.id, {
            audioPath: undefined, audioFileName: undefined, audioMimeType: undefined, audioSize: undefined,
            managedAsset: undefined, audioAvailable: false, requiresSourceSelection: true,
          })
        }
      }
      onClose()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setPending(false) }
  }
  return <ActionDialog
    open={Boolean(session)} title={pending ? t.topics.deleting : t.common.delete}
    description={[session?.title, t.topics.deleteResultsHint, `${t.topics.affectedProjects}: ${[...affected, ...orphanIds].join(', ') || t.topics.noTopic}`, error].filter(Boolean).join('\n\n')}
    onClose={close}
    actions={[
      { label: t.common.cancel, onClick: close, variant: 'secondary', disabled: pending },
      { label: hasManagedAudio ? t.history.deleteKeepAudio : t.common.delete, onClick: () => void remove(false), variant: 'danger', disabled: pending },
      ...(hasManagedAudio ? [{ label: t.history.deleteWithAudio, onClick: () => void remove(true), variant: 'danger' as const, disabled: pending }] : []),
    ]}
  />
}
