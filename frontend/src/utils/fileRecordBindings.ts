import { sessionRepository } from './sessionRepository'
import { getDeletedSessionSnapshots } from './deletedSessionStorage'

export async function reconcileFileRecordBindings(): Promise<void> {
  const api = window.electronAPI
  if (!api?.reconcileFileRecordBindings) return
  const contexts = sessionRepository.getSessionsSnapshot().map((session) => ({ sessionId: session.id, title: session.title, createdAt: session.createdAt, titleRevision: session.titleRevision || 0 }))
  const snapshots = await getDeletedSessionSnapshots()
  const result = await api.reconcileFileRecordBindings(contexts, snapshots.map((snapshot) => snapshot.originalSessionId))
  if (!result.ok) throw new Error(result.error || 'File record metadata reconciliation failed')
}
