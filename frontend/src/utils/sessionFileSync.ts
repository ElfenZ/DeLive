import { sessionRepository } from './sessionRepository'
import { useSessionStore } from '../stores/sessionStore'
import { reconcileSessionNaming } from './managedMediaSchema'
import { startPerformanceSpan } from '../../../shared/performanceDiagnostics'

export async function syncSessionFiles(sessionId: string, options: { nameFiles?: boolean } = {}): Promise<void> {
  const session = sessionRepository.getSessionsSnapshot().find((item) => item.id === sessionId)
  if (!session || !window.electronAPI?.registerSessionFiles) return
  const span = startPerformanceSpan('files.sync')
  let successful = false, changed = false
  try {
  const result = await window.electronAPI.registerSessionFiles({ sessionId, title: session.title, createdAt: session.createdAt, titleRevision: session.titleRevision || 0 }, options.nameFiles !== false)
  const naming = result.naming || (!result.ok ? { status: 'error' as const, titleRevision: session.titleRevision || 0, error: result.error } : undefined)
  const latest = sessionRepository.getSessionsSnapshot().find((item) => item.id === sessionId)
  if (latest && reconcileSessionNaming(latest, naming)) {
    const sessions = await sessionRepository.updateMetadataDurable(sessionId, (current) => {
      const patch = reconcileSessionNaming(current, naming)
      changed = Boolean(patch)
      return patch ? { managedNaming: patch } : {}
    })
    if (changed) useSessionStore.setState({ sessions })
  }
  successful = true
  } finally { span.finish(successful ? 'success' : 'error', { writes: changed ? 1 : 0, publications: changed ? 1 : 0 }) }
}
