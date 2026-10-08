import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { isPublishedCorrectionAutoSaveEnabled, publishedMarkdownSourceKey, savePublishedMarkdown } from '../utils/publishedMarkdownCoordinator'

export function usePublishedMarkdownCoordinator(ready: boolean): void {
  useEffect(() => {
    if (!ready) return
    // Loading history establishes a baseline, not a request to export it.
    const observed = new Map<string, { source: string; workflow: string }>()
    const eligible = new Set<string>()
    let initialized = false
    let configurationRevision: number | undefined
    void window.electronAPI?.getFileStorageStatus?.().then((result) => {
      configurationRevision ??= result.status?.configuration.revision
    }).catch(() => undefined)
    const reconcile = () => {
      const enabled = isPublishedCorrectionAutoSaveEnabled(useSettingsStore.getState().settings)
      if (!enabled) eligible.clear()
      const sessions = useSessionStore.getState().sessions
      const ids = new Set(sessions.map((session) => session.id))
      for (const id of observed.keys()) if (!ids.has(id)) { observed.delete(id); eligible.delete(id) }
      for (const session of sessions) {
        const workflow = session.autoPostProcessWorkflow
        const source = publishedMarkdownSourceKey(session)
        const workflowKey = `${workflow?.status}:${workflow?.step}`
        const previous = observed.get(session.id)
        observed.set(session.id, { source, workflow: workflowKey })
        if (!enabled || !session.correction?.published) continue
        const activeWorkflow = workflow && ['queued', 'running', 'waiting-review'].includes(workflow.status)
        const registered = session.correctedMarkdownFile?.registrationId
        if ((initialized && previous?.source !== source) || activeWorkflow || registered) eligible.add(session.id)
        if (!eligible.has(session.id) || (previous?.source === source && previous.workflow === workflowKey)) continue
        // Do not turn a persisted conflict/error into an implicit retry on launch.
        if (!previous && registered && !activeWorkflow && !['saved', 'pending', 'saving'].includes(session.correctedMarkdownFile!.status)) continue
        void savePublishedMarkdown(session.id)
      }
      initialized = true
    }
    const unsubscribeSessions = useSessionStore.subscribe(reconcile)
    const unsubscribeSettings = useSettingsStore.subscribe(reconcile)
    const unsubscribeFiles = window.electronAPI?.onFileStorageChanged?.((event) => {
      if (event.activityOnly) return
      if (event.configurationRevision === configurationRevision) return
      configurationRevision = event.configurationRevision
      if (!isPublishedCorrectionAutoSaveEnabled(useSettingsStore.getState().settings)) return
      for (const session of useSessionStore.getState().sessions) {
        if (eligible.has(session.id) && session.correctedMarkdownFile?.status === 'waiting-directory') void savePublishedMarkdown(session.id, { retry: true })
      }
    })
    reconcile()
    return () => { unsubscribeSessions(); unsubscribeSettings(); unsubscribeFiles?.() }
  }, [ready])
}
