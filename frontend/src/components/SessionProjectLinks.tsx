import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { TranscriptSession } from '../types'
import { useTopicStore } from '../stores/topicStore'
import { useSessionStore } from '../stores/sessionStore'
import { useUIStore } from '../stores/uiStore'
import { getDirectProjectIds } from '../utils/projectSchema'
import { measureNextDiagnosticFrame } from '../hooks/usePerformanceDiagnostics'

export function SessionProjectLinks({ session, compact = false, editable = true }: { session: TranscriptSession; compact?: boolean; editable?: boolean }) {
  const { t, setReviewFolder } = useUIStore()
  const topics = useTopicStore((state) => state.topics)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const ids = getDirectProjectIds(session)
  const run = async (operation: () => Promise<void>) => {
    if (pending) return
    setPending(true)
    setError('')
    try { await operation() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setPending(false) }
  }

  return (
    <div className={`relative ${compact ? 'text-xs' : 'space-y-3 text-sm'}`} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-2">
        {ids.map((id) => {
          const project = topics.find((item) => item.id === id)
          return <button key={id} type="button" title={project?.name || id} className="max-w-full truncate rounded-full border border-border px-2 py-1 hover:bg-accent" onClick={() => {
            if (!project) { setOpen(true); return }
            setReviewFolder({ kind: 'topic', topicId: id })
          }}>{project?.name || `${t.topics.orphanProject}: ${id}`}</button>
        })}
        {editable && <button type="button" onClick={() => { if (!open) measureNextDiagnosticFrame('ui.topic-links'); setOpen(!open) }} aria-expanded={open} className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-muted-foreground hover:bg-accent">
          <FolderOpen className="h-3.5 w-3.5" />{t.topics.manageAssociations}
        </button>}
      </div>
      {open && (
        <div className={`z-20 space-y-3 rounded-xl border border-border bg-popover p-3 shadow-lg ${compact ? 'absolute left-0 top-full mt-1 w-72' : ''}`}>
          <p className="text-xs text-muted-foreground">{t.topics.associationHint}</p>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {topics.filter((project) => !project.archivedAt || ids.includes(project.id)).map((project) => (
              <label key={project.id} className="flex items-center gap-2 py-1">
                <input type="checkbox" disabled={pending} checked={ids.includes(project.id)} onChange={(event) => {
                  const associated = event.target.checked
                  void run(() => useSessionStore.getState().setSessionProjectAssociation(session.id, project.id, associated))
                }} />
                <span>{project.name}{project.archivedAt ? ` (${t.topics.archived})` : ''}</span>
              </label>
            ))}
            {ids.filter((id) => !topics.some((project) => project.id === id)).map((id) => (
              <label key={id} className="flex items-center gap-2 py-1 text-amber-600">
                <input type="checkbox" disabled={pending} checked onChange={() => void run(() => useSessionStore.getState().setSessionProjectAssociation(session.id, id, false))} />
                {t.topics.orphanProject}: {id}
              </label>
            ))}
          </div>
          <label className="block space-y-1 text-xs">
            <span>{t.topics.defaultSaveProject}</span>
            <select disabled={pending} className="w-full rounded border border-input bg-background p-2" value={session.defaultSaveProjectId || ''} onChange={(event) => {
              const projectId = event.target.value || undefined
              void run(() => useSessionStore.getState().updateSessionDefaultSaveProject(session.id, projectId))
            }}>
              <option value="">{t.topics.globalSaveDirectory}</option>
              {session.defaultSaveProjectId && !ids.includes(session.defaultSaveProjectId) && <option value={session.defaultSaveProjectId}>{topics.find((project) => project.id === session.defaultSaveProjectId)?.name || session.defaultSaveProjectId}</option>}
              {ids.map((id) => <option key={id} value={id}>{topics.find((project) => project.id === id)?.name || id}</option>)}
            </select>
          </label>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
