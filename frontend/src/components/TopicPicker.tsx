import { useState, useRef, useEffect } from 'react'
import { FolderOpen, Plus } from 'lucide-react'
import { useUIStore } from '../stores/uiStore'
import { useTopicStore } from '../stores/topicStore'
import { TopicDialog } from './TopicDialog'

export function TopicPicker() {
  const { t } = useUIStore()
  const { topics, activeProjectIds, defaultSaveProjectId, setActiveProjects, addTopic } = useTopicStore()
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const activeTopics = topics.filter((project) => activeProjectIds.includes(project.id))

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative flex items-center justify-center" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="max-w-[260px] truncate">{activeTopics.length ? activeTopics.map((project) => project.name).join(', ') : t.topics.selectTopic}</span>
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-20 w-64 rounded-xl border border-border bg-popover py-1 shadow-xl">
          <div className="px-3 py-2 text-xs font-medium text-muted-foreground">{t.topics.selectTopic}</div>
          {topics.length > 0 ? (
            <div className="max-h-48 overflow-y-auto">
              {topics.filter((project) => !project.archivedAt).map((tp) => (
                <label
                  key={tp.id}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                >
                  <input type="checkbox" checked={activeProjectIds.includes(tp.id)} onChange={(event) => setActiveProjects(event.target.checked ? [...activeProjectIds, tp.id] : activeProjectIds.filter((id) => id !== tp.id), defaultSaveProjectId)} />
                  <span>{tp.emoji}</span>
                  <span className="truncate flex-1 text-left">{tp.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="px-3 py-3 text-xs text-muted-foreground text-center">{t.topics.noTopics}</div>
          )}
          <label className="block px-3 py-2 text-xs space-y-2">
            <span>{t.topics.defaultSaveProject}</span>
            <select className="w-full rounded border border-input bg-background p-2" value={defaultSaveProjectId || ''} onChange={(event) => setActiveProjects(activeProjectIds, event.target.value || null)}>
              {activeTopics.length === 0 && <option value="">{t.topics.globalSaveDirectory}</option>}
              {activeTopics.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <p className="text-muted-foreground">{t.topics.defaultSaveHint}</p>
          </label>
          <div className="border-t border-border mt-1 pt-1">
            <button
              onClick={() => { setOpen(false); setDialogOpen(true) }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-primary transition-colors hover:bg-accent"
            >
              <Plus className="h-3.5 w-3.5" />
              {t.topics.newTopic}
            </button>
          </div>
        </div>
      )}

      <TopicDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={(name, emoji, description, parentId) => {
          const newTopic = addTopic(name, emoji, description, parentId)
          setActiveProjects([...activeProjectIds, newTopic.id], defaultSaveProjectId || newTopic.id)
        }}
      />
    </div>
  )
}
