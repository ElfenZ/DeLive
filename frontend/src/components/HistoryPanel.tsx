import { useState, useMemo, useEffect, useRef } from 'react'
import { History, Calendar, Pencil, Trash2, Check, X, ChevronDown, ChevronRight, Search, FileText, Sparkles } from 'lucide-react'
import { useUIStore } from '../stores/uiStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTopicStore } from '../stores/topicStore'
import { useTagStore } from '../stores/tagStore'
import { exportToTxt } from '../utils/storage'
import { SessionDeleteDialog } from './SessionDeleteDialog'
import { SessionProjectLinks } from './SessionProjectLinks'
import { getProjectLinkOrigins, selectReviewSessions } from '../utils/projectSchema'
import { TagSelector, TagFilter } from './TagSelector'
import type { TranscriptSession } from '../types'

interface HistoryPanelProps {
  variant?: 'full' | 'rail'
  className?: string
  contentHeightClassName?: string
}

export function HistoryPanel({
  variant = 'full',
  className = '',
  contentHeightClassName,
}: HistoryPanelProps) {
  const { t, openReview, reviewFolder, reviewSessionId } = useUIStore()
  const { sessions, updateSessionTitle } = useSessionStore()
  const topics = useTopicStore((state) => state.topics)
  const projectId = reviewFolder.kind === 'topic' ? reviewFolder.topicId : undefined
  const folderLabel = projectId ? topics.find((topic) => topic.id === projectId)?.name : reviewFolder.kind === 'unclassified' ? t.reviewFolders.unclassified : t.reviewFolders.all
  const folderCount = selectReviewSessions(sessions, topics, reviewFolder).length
  const { tags, selectedTagIds, searchQuery, setSearchQuery, selectedReviewDate, setSelectedReviewDate } = useTagStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const [titleError, setTitleError] = useState('')
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const [collapsedDates, setCollapsedDates] = useState<Set<string>>(new Set())
  const [inputValue, setInputValue] = useState(searchQuery)
  const [pendingDeleteSession, setPendingDeleteSession] = useState<TranscriptSession | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync input when searchQuery changes externally (e.g. from another panel)
  useEffect(() => {
    setInputValue(searchQuery)
  }, [searchQuery])

  // Debounce setSearchQuery by 200ms for instant search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setSearchQuery(inputValue.trim())
      debounceRef.current = null
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [inputValue, setSearchQuery])

  const clearSearch = () => {
    setInputValue('')
    setSearchQuery('')
  }

  const getSessionPreviewText = (session: TranscriptSession) => {
    const summary = session.postProcess?.summary?.trim()
    if (summary) {
      return summary
    }

    const translated = session.translatedTranscript?.text?.trim()
    if (translated) {
      return translated
    }

    return session.transcript.trim()
  }

  // 按标签和搜索词筛选会话
  const filteredSessions = useMemo(() => {
    return selectReviewSessions(sessions, topics, reviewFolder, selectedTagIds, searchQuery, tags, selectedReviewDate)
  }, [sessions, topics, reviewFolder, selectedTagIds, searchQuery, tags, selectedReviewDate])

  // 按日期分组
  const groupedSessions = useMemo(() => {
    const groups: Record<string, TranscriptSession[]> = {}
    
    for (const session of filteredSessions) {
      if (!groups[session.date]) {
        groups[session.date] = []
      }
      groups[session.date].push(session)
    }

    // 按日期降序排列
    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]))
  }, [filteredSessions])

  const today = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

  const toggleDate = (date: string) => {
    const isDefault = variant === 'rail' || Boolean(projectId) || date === today || date === yesterday
    if (isDefault) {
      const next = new Set(collapsedDates)
      if (next.has(date)) {
        next.delete(date)
      } else {
        next.add(date)
      }
      setCollapsedDates(next)
    } else {
      const next = new Set(expandedDates)
      if (next.has(date)) {
        next.delete(date)
      } else {
        next.add(date)
      }
      setExpandedDates(next)
    }
  }

  const startEditing = (e: React.MouseEvent, session: TranscriptSession) => {
    e.stopPropagation()
    setEditingId(session.id)
    setEditingTitle(session.title)
    setTitleError('')
  }

  const saveTitle = () => {
    if (!editingId || !editingTitle.trim() || titleSaving) return
    setTitleSaving(true)
    setTitleError('')
    void updateSessionTitle(editingId, editingTitle.trim()).then(() => {
      setEditingId(null)
      setEditingTitle('')
    }).catch((error: unknown) => setTitleError(error instanceof Error ? error.message : String(error))).finally(() => setTitleSaving(false))
  }

  const cancelEditing = () => {
    if (titleSaving) return
    setEditingId(null)
    setEditingTitle('')
  }

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const session = sessions.find((item) => item.id === id) || null
    setPendingDeleteSession(session)
  }

  const handleExport = (e: React.MouseEvent, session: TranscriptSession) => {
    e.stopPropagation()
    exportToTxt(session, tags)
  }

  const handlePreview = (session: TranscriptSession) => {
    if (editingId) return
    openReview(session.id)
  }

  const formatDateDisplay = (dateStr: string) => {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    if (dateStr === today.toISOString().split('T')[0]) {
      return t.common.today
    } else if (dateStr === yesterday.toISOString().split('T')[0]) {
      return t.common.yesterday
    }
    return dateStr
  }

  const isExpanded = (date: string) => {
    const isDefault = variant === 'rail' || Boolean(projectId) || date === today || date === yesterday
    if (isDefault) return !collapsedDates.has(date)
    return expandedDates.has(date)
  }
  const isRail = variant === 'rail'
  const resolvedContentHeightClassName = contentHeightClassName || (isRail ? 'h-[min(62vh,44rem)]' : 'max-h-[400px]')
  const railDescription = (t.history as Record<string, unknown>).railDescription as string | undefined
    || 'Search, reopen, and organize finished sessions.'

  return (
    <>
      <div className={`workspace-panel overflow-hidden ${className}`}>
        {/* 头部 */}
        <div className={`shrink-0 space-y-3 border-b border-border/70 bg-muted/20 ${isRail ? 'px-3 py-3' : 'px-6 py-4'}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-primary/80">
                <History className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate" title={folderLabel}>{folderLabel}</span>
              </div>
              <p className={`${isRail ? 'hidden' : ''} text-xs text-muted-foreground`}>
                {projectId ? t.topics.includeDescendants : railDescription}
              </p>
            </div>
            <span className="workspace-badge">
              {(selectedTagIds.length > 0 || searchQuery.trim() || selectedReviewDate)
                ? `${filteredSessions.length}/${folderCount} ${t.common.items}`
                : `${filteredSessions.length} ${t.common.items}`
              }
            </span>
          </div>
          
          {/* 搜索框 */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={t.history.searchPlaceholder}
              className="w-full h-9 pl-9 pr-8 text-sm rounded-md border border-input bg-background
                       placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
            />
            {(inputValue || searchQuery) && (
              <button
                onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 min-h-8 min-w-8 flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          
          {/* 标签筛选栏 */}
          <TagFilter />
          {selectedReviewDate && <button className="rounded border border-border px-2 py-1 text-xs" aria-label={`${t.reviewFolders.clearDate}: ${selectedReviewDate}`} onClick={() => setSelectedReviewDate(null)}>{selectedReviewDate} <span aria-hidden="true">x</span></button>}
          {(searchQuery || selectedTagIds.length > 0 || selectedReviewDate) && <button className="text-xs text-primary" onClick={() => { clearSearch(); useTagStore.getState().clearTagFilter(); setSelectedReviewDate(null) }}>{t.reviewFolders.clearFilters}</button>}
        </div>

        {/* 内容 */}
        <div className={`${resolvedContentHeightClassName} overflow-y-auto bg-background/40`}>
          {groupedSessions.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <div className="bg-muted w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3">
                {searchQuery.trim() ? (
                  <Search className="w-8 h-8 opacity-50" />
                ) : (
                  <History className="w-8 h-8 opacity-50" />
                )}
              </div>
              <p className="text-sm">
                {searchQuery.trim() 
                  ? t.history.noSearchResults(searchQuery)
                  : selectedTagIds.length > 0 || selectedReviewDate
                    ? t.history.noMatchingRecords
                    : t.history.noRecords
                }
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {groupedSessions.map(([date, dateSessions]) => (
                <div key={date}>
                  {/* 日期头部 */}
                  <button
                    onClick={() => toggleDate(date)}
                    aria-expanded={isExpanded(date)}
                    className="w-full flex items-center gap-2 px-3 py-3 hover:bg-muted/50 transition-colors group"
                  >
                    {isExpanded(date) ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    )}
                    <Calendar className="w-4 h-4 text-primary/70" />
                    <span className="text-sm font-medium text-foreground">
                      {formatDateDisplay(date)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ({dateSessions.length})
                    </span>
                  </button>

                  {/* 会话列表 */}
                  {isExpanded(date) && (
                    <div className="px-2 pb-2 space-y-1">
                      {dateSessions.map((session) => (
                        <div
                          key={session.id}
                          role="button"
                          tabIndex={0}
                          aria-label={session.title}
                          aria-pressed={reviewSessionId === session.id}
                          onClick={() => handlePreview(session)}
                          onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handlePreview(session) } }}
                          className={`group min-w-0 flex flex-col gap-2 px-3 py-3 rounded-lg
                                   cursor-pointer interactive-card border ${reviewSessionId === session.id ? 'border-primary/30 bg-primary/10' : 'border-transparent'} hover:border-primary/20 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                        >
                          {/* 第一行：时间、标题、操作 */}
                          <div className="flex min-w-0 flex-col gap-1">
                            {/* 标题 */}
                            {editingId === session.id ? (
                              <div className="flex min-w-0 items-center gap-2" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                                <input
                                  type="text"
                                  value={editingTitle}
                                  onChange={(e) => setEditingTitle(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); saveTitle() }
                                    if (e.key === 'Escape') { e.preventDefault(); cancelEditing() }
                                  }}
                                  className="min-w-0 flex-1 h-8 px-2 text-sm border border-input rounded bg-background
                                           focus:outline-none focus:ring-1 focus:ring-ring"
                                  autoFocus
                                  aria-label={t.history.editTitle}
                                  disabled={titleSaving}
                                />
                                <button
                                  onClick={saveTitle}
                                  disabled={titleSaving}
                                  className="h-8 w-8 min-h-8 min-w-8 flex items-center justify-center text-success hover:bg-success/10 dark:hover:bg-success/10 rounded transition-colors"
                                  aria-label="Save title"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={cancelEditing}
                                  disabled={titleSaving}
                                  className="h-8 w-8 min-h-8 min-w-8 flex items-center justify-center text-muted-foreground hover:bg-muted rounded transition-colors"
                                  aria-label="Cancel editing"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            ) : (
                              <>
                                <span title={session.title} className="min-w-0 line-clamp-2 break-words text-sm font-medium text-foreground group-hover:text-primary transition-colors [overflow-wrap:anywhere]">
                                  {session.title}
                                </span>
                                <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                                <span className="mr-1 shrink-0 font-mono">{session.time}</span>
                                {session.providerId && (
                                  <span className="min-w-0 max-w-[40%] truncate rounded border border-border/70 px-1.5 py-0.5" title={session.providerId}>
                                    {session.providerId}
                                  </span>
                                )}

                                {/* 操作按钮 - hidden until hover, don't reserve space */}
                                <div className="ml-auto flex items-center gap-1 flex-shrink-0" onKeyDown={e => e.stopPropagation()}>
                                  <button
                                    onClick={(e) => startEditing(e, session)}
                                    className="h-8 w-8 min-h-8 min-w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background rounded-md transition-all shadow-sm border border-transparent hover:border-border"
                                    title={t.history.editTitle}
                                    aria-label="Edit title"
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={(e) => handleExport(e, session)}
                                    className="h-8 w-8 min-h-8 min-w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background rounded-md transition-all shadow-sm border border-transparent hover:border-border"
                                    title={t.history.exportTxt}
                                    aria-label="Export as TXT"
                                  >
                                    <FileText className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={(e) => handleDelete(e, session.id)}
                                    className="h-8 w-8 min-h-8 min-w-8 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/10 rounded-md transition-all shadow-sm border border-transparent hover:border-destructive/30 dark:hover:border-destructive/30"
                                    title={t.common.delete}
                                    aria-label="Delete session"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                </div>
                              </>
                            )}
                          </div>

                          {/* 第二行：标签 */}
                          {editingId !== session.id && (
                            <div className="min-w-0">
                              <div className="space-y-2">
                                {projectId && <p className="text-xs text-muted-foreground">{getProjectLinkOrigins(session, topics, projectId).direct ? t.topics.directAssociation : t.topics.inheritedFrom}</p>}
                                <SessionProjectLinks session={session} compact editable={!isRail} />
                                <div className="flex min-w-0 flex-wrap items-center gap-2" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                                  {isRail ? (session.tagIds || []).map((id) => {
                                    const tag = tags.find((item) => item.id === id)
                                    return tag ? <span key={id} title={tag.name} className="max-w-full truncate rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">{tag.name}</span> : null
                                  }) : <TagSelector
                                    sessionId={session.id} 
                                    sessionTagIds={session.tagIds || []}
                                    compact
                                  />}
                                  {session.postProcess?.summary && (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-primary">
                                      <Sparkles className="h-3 w-3" />
                                      AI
                                    </span>
                                  )}
                                </div>
                                {getSessionPreviewText(session) && (
                                  <p className="line-clamp-2 break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                                    {getSessionPreviewText(session)}
                                  </p>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {titleError && <p role="alert" className="px-3 py-2 text-xs text-destructive">{titleError}</p>}
      <SessionDeleteDialog key={pendingDeleteSession?.id || 'closed'} session={pendingDeleteSession} onClose={() => setPendingDeleteSession(null)} />
    </>
  )
}
