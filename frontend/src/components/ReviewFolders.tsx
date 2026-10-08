import { useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, MoreHorizontal, Plus } from 'lucide-react'
import { useUIStore } from '../stores/uiStore'
import { useTopicStore } from '../stores/topicStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTagStore } from '../stores/tagStore'
import { getDirectProjectIds, selectReviewSessions, type ReviewFolder } from '../utils/projectSchema'
import { TopicDialog } from './TopicDialog'
import { ActionDialog } from './ActionDialog'
import { FileStoragePanel } from './settings/FileStoragePanel'
import type { Topic } from '../types'

export function ReviewFolders({ onSelect }: { onSelect?: () => void }) {
  const { t, reviewFolder, setReviewFolder, openTopicCreation } = useUIStore()
  const { topics, addTopic, updateTopic, deleteTopic, error: storeError, resumePendingDeletion } = useTopicStore()
  const sessions = useSessionStore((state) => state.sessions)
  const selectedTagIds = useTagStore((state) => state.selectedTagIds)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Topic | null>(null)
  const [managingId, setManagingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Topic | null>(null)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const managing = topics.find((topic) => topic.id === managingId)
  const select = (folder: ReviewFolder) => {
    setReviewFolder(folder)
    setManagingId((current) => current && folder.kind === 'topic' ? folder.topicId : null)
    setAdding(false)
    setQuery('')
    setError('')
    onSelect?.()
  }
  const run = async (operation: () => void | Promise<void>) => {
    if (pending) return
    setPending(true)
    setError('')
    try { await operation() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setPending(false) }
  }
  const row = (folder: ReviewFolder, label: string) => {
    const selected = reviewFolder.kind === folder.kind && (folder.kind !== 'topic' || (reviewFolder.kind === 'topic' && folder.topicId === reviewFolder.topicId))
    return <button onClick={() => select(folder)} title={label} aria-current={selected ? 'page' : undefined} className={`flex h-8 min-w-0 flex-1 items-center gap-1 rounded-lg px-1 text-left text-sm ${selected ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}>
      <FolderOpen className="h-4 w-4 shrink-0" /><span className="flex-1 truncate">{label}</span>
      <span className="shrink-0 text-xs tabular-nums">{selectReviewSessions(sessions, topics, folder, selectedTagIds).length}</span>
    </button>
  }
  const tree = (archived: boolean, parentId?: string, depth = 0): React.ReactNode => topics
    .filter((topic) => Boolean(topic.archivedAt) === archived && (parentId ? topic.parentId === parentId
      : !topic.parentId || !topics.some((parent) => parent.id === topic.parentId && Boolean(parent.archivedAt) === archived)))
    .map((topic) => {
      const children = topics.some((child) => child.parentId === topic.id && Boolean(child.archivedAt) === archived)
      return <div key={topic.id}>
        <div className="flex min-w-0 items-center gap-0.5" style={{ paddingLeft: Math.min(depth, 8) * 6 }}>
          {children ? <button aria-label={`${t.reviewFolders.toggleFolder}: ${topic.name}`} aria-expanded={!collapsed.has(topic.id)} className="shrink-0 rounded p-1 hover:bg-accent" onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(topic.id)) next.delete(topic.id); else next.add(topic.id); return next })}>{collapsed.has(topic.id) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button> : <span className="w-6 shrink-0" />}
          {row({ kind: 'topic', topicId: topic.id }, topic.name)}
          <button className="shrink-0 rounded p-1 hover:bg-accent" aria-label={`${t.reviewFolders.manageFolder}: ${topic.name}`} aria-expanded={managingId === topic.id} onClick={() => { if (managingId !== topic.id) setReviewFolder({ kind: 'topic', topicId: topic.id }); setManagingId(managingId === topic.id ? null : topic.id); setAdding(false); setQuery(''); setError('') }}><MoreHorizontal className="h-4 w-4" /></button>
        </div>
        {children && !collapsed.has(topic.id) && tree(archived, topic.id, depth + 1)}
      </div>
    })

  return <nav aria-label={t.reviewFolders.title} className="space-y-3">
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{t.reviewFolders.title}</h2><button aria-label={t.topics.newTopic} className="rounded p-2 hover:bg-accent" onClick={() => { setEditing(null); setDialogOpen(true) }}><Plus className="h-4 w-4" /></button></div>
    <p className="text-xs text-muted-foreground">{t.reviewFolders.hint}</p>
    <div>{row({ kind: 'all' }, t.reviewFolders.all)}{row({ kind: 'unclassified' }, t.reviewFolders.unclassified)}</div>
    <div>{tree(false)}</div>
    {topics.some((topic) => topic.archivedAt) && <div><button className="flex w-full items-center gap-2 rounded p-2 text-sm hover:bg-accent" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(!archivedOpen)}>{archivedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{t.topics.archived}</button>{archivedOpen && tree(true)}</div>}
    {managing && <section aria-label={`${t.reviewFolders.manageFolder}: ${managing.name}`} className="space-y-3 rounded-lg border border-border p-3 text-xs">
      <h3 className="font-semibold">{managing.name}</h3><p className="break-words text-muted-foreground">{managing.description}</p>
      {managing.parentId && <p>{t.topics.parentProject}: {topics.find((topic) => topic.id === managing.parentId)?.name}</p>}
      <div className="flex flex-wrap gap-3">
        <button className="text-primary" onClick={() => { setEditing(managing); setDialogOpen(true) }}>{t.topics.editTopic}</button>
        <button disabled={pending} onClick={() => void run(() => updateTopic(managing.id, { archivedAt: managing.archivedAt ? undefined : Date.now() }))}>{managing.archivedAt ? t.topics.restoreProject : t.topics.archiveProject}</button>
        <button className="text-destructive" disabled={pending} onClick={() => setDeleteTarget(managing)}>{t.common.delete}</button>
      </div>
      {!managing.archivedAt && <div className="flex flex-wrap gap-3">
        <button className="text-primary" onClick={() => openTopicCreation(managing.id, 'live')}>{t.topics.recordNew}</button>
        <button className="text-primary" onClick={() => openTopicCreation(managing.id, 'file')}>{t.topics.importMedia}</button>
        <button aria-expanded={adding} onClick={() => setAdding(!adding)}>{t.topics.addExisting}</button>
      </div>}
      {adding && !managing.archivedAt && <div className="space-y-2">
        <input aria-label={t.topics.addExisting} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.history.searchPlaceholder} className="w-full rounded border border-input bg-background p-2" />
        <div className="max-h-52 overflow-y-auto">{sessions.filter((session) => !getDirectProjectIds(session).includes(managing.id) && `${session.title}\n${session.transcript}`.toLowerCase().includes(query.toLowerCase())).map((session) => <button key={session.id} disabled={pending} className="block w-full truncate rounded p-2 text-left hover:bg-accent disabled:opacity-50" onClick={() => void run(() => useSessionStore.getState().setSessionProjectAssociation(session.id, managing.id, true))}>{session.title}</button>)}</div>
      </div>}
      <FileStoragePanel key={managing.id} projectId={managing.id} />
    </section>}
    {(error || storeError) && <div role="alert" className="space-y-2 text-xs text-destructive"><p>{error || storeError}</p>{storeError && <button disabled={pending} onClick={() => void run(resumePendingDeletion)}>{t.topics.resumeDeletion}</button>}</div>}
    <TopicDialog open={dialogOpen} topic={editing} onClose={() => setDialogOpen(false)} onSave={(name, emoji, description, parentId) => {
      if (editing) updateTopic(editing.id, { name, emoji, description, parentId })
      else addTopic(name, emoji, description, parentId)
    }} />
    <ActionDialog open={Boolean(deleteTarget)} title={t.topics.deleteTopic} description={deleteTarget ? `${t.topics.deleteConfirm(deleteTarget.name)}\n\n${error || storeError || ''}` : ''} onClose={() => { if (!pending) setDeleteTarget(null) }} actions={[
      { label: t.common.cancel, variant: 'secondary', disabled: pending, onClick: () => setDeleteTarget(null) },
      { label: pending ? t.topics.deleting : t.common.delete, variant: 'danger', disabled: pending, onClick: () => void run(async () => { if (deleteTarget) await deleteTopic(deleteTarget.id); setDeleteTarget(null) }) },
    ]} />
  </nav>
}
