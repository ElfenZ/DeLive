import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useUIStore } from '../stores/uiStore'
import { useTopicStore } from '../stores/topicStore'
import { getProjectSubtreeIds } from '../utils/projectSchema'
import type { Topic } from '../types'
import { useDialogFocus } from '../hooks/useDialogFocus'

const EMOJI_PRESETS = [
  '📖', '📚', '🎓', '💼', '🎧', '🎤', '🎵', '📝',
  '💡', '🔬', '🩺', '⚖️', '🏗️', '🎨', '🌍', '💻',
  '📊', '🗣️', '🏋️', '🎯', '🚀', '☕', '🎬', '📱',
]

interface TopicDialogProps {
  open: boolean
  topic?: Topic | null
  onClose: () => void
  onSave: (name: string, emoji: string, description?: string, parentId?: string) => void
}

export function TopicDialog({ open, topic, onClose, onSave }: TopicDialogProps) {
  const { t } = useUIStore()
  const topics = useTopicStore((state) => state.topics)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState(EMOJI_PRESETS[0])
  const [description, setDescription] = useState('')
  const [parentId, setParentId] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(open, dialogRef, onClose)

  useEffect(() => {
    if (open) {
      setName(topic?.name ?? '')
      setEmoji(topic?.emoji ?? EMOJI_PRESETS[0])
      setDescription(topic?.description ?? '')
      setParentId(topic?.parentId ?? '')
      setError('')
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open, topic])

  if (!open) return null

  const isEdit = !!topic
  const canSave = name.trim().length > 0
  const excludedParents = topic ? getProjectSubtreeIds(topics, topic.id) : new Set<string>()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (canSave) {
      try {
        onSave(name.trim(), emoji, description.trim() || undefined, parentId || undefined)
        onClose()
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        ref={dialogRef}
        aria-modal="true"
        aria-labelledby="topic-dialog-title"
        className="w-full max-w-md rounded-2xl border border-border bg-card text-card-foreground shadow-2xl dark:ring-1 dark:ring-white/[0.08]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <h3 id="topic-dialog-title" className="text-base font-semibold tracking-tight text-foreground">
            {isEdit ? t.topics.editTopic : t.topics.newTopic}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <label className="block space-y-1.5 text-sm">
            <span>{t.topics.parentProject}</span>
            <select value={parentId} onChange={(event) => setParentId(event.target.value)} className="w-full rounded-lg border border-input bg-background px-3 py-2">
              <option value="">{t.topics.rootProject}</option>
              {topics.filter((item) => !excludedParents.has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">{t.topics.topicEmoji}</label>
            <div className="flex flex-wrap gap-1.5">
              {EMOJI_PRESETS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg text-lg transition-all ${
                    emoji === e
                      ? 'bg-primary/15 ring-2 ring-primary scale-110'
                      : 'hover:bg-muted'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="topic-name" className="block text-sm font-medium text-foreground mb-1.5">
              {t.topics.topicName}
            </label>
            <input
              ref={inputRef}
              id="topic-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.topics.topicNamePlaceholder}
              maxLength={50}
              className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label htmlFor="topic-desc" className="block text-sm font-medium text-foreground mb-1.5">
              {t.topics.topicDescription}
            </label>
            <textarea
              id="topic-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.topics.topicDescriptionPlaceholder}
              maxLength={200}
              rows={2}
              className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {t.common.cancel}
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isEdit ? t.common.save : t.common.create}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
