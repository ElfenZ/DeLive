import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { FolderOpen, X, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useUIStore, DEFAULT_REVIEW_LIST_WIDTH, MIN_REVIEW_LIST_WIDTH, MAX_REVIEW_LIST_WIDTH, DEFAULT_REVIEW_FOLDER_WIDTH, MIN_REVIEW_FOLDER_WIDTH, MAX_REVIEW_FOLDER_WIDTH } from '../stores/uiStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTagStore } from '../stores/tagStore'
import { PreviewModal } from './PreviewModal'
import { HistoryPanel } from './HistoryPanel'
import { ActivityHeatmap } from './ActivityHeatmap'
import { useTopicStore } from '../stores/topicStore'
import { selectReviewSessions } from '../utils/projectSchema'
import { ReviewFolders } from './ReviewFolders'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { ReviewPaneSeparator } from './ReviewPaneSeparator'

export function ReviewDeskView({ ready = false }: { ready?: boolean }) {
  const { t, reviewSessionId, reviewDocumentOpen, reviewFolder, reviewListWidth, setReviewListWidth, reviewFolderWidth, setReviewFolderWidth, setReviewSelection, setView } = useUIStore()
  const sessions = useSessionStore((s) => s.sessions)
  const topics = useTopicStore((state) => state.topics)
  const { searchQuery, selectedReviewDate, setSelectedReviewDate, selectedTagIds, tags } = useTagStore()
  const [listCollapsed, setListCollapsed] = useState(false)
  const [foldersOpen, setFoldersOpen] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [containerWidth, setContainerWidth] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const explicitlyClosed = useRef<string | null>(null)
  useDialogFocus(drawerOpen, drawerRef, () => setDrawerOpen(false))
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width))
    observer.observe(root)
    return () => observer.disconnect()
  }, [])
  const scopedSessions = useMemo(() => selectReviewSessions(sessions, topics, reviewFolder, selectedTagIds), [sessions, topics, reviewFolder, selectedTagIds])
  const visibleSessions = useMemo(() => selectReviewSessions(sessions, topics, reviewFolder, selectedTagIds, searchQuery, tags, selectedReviewDate), [sessions, topics, reviewFolder, selectedTagIds, searchQuery, tags, selectedReviewDate])
  const candidatesKey = JSON.stringify([reviewFolder, searchQuery, selectedTagIds, selectedReviewDate, visibleSessions.map((item) => item.id)])
  const session = visibleSessions.find((item) => item.id === reviewSessionId) ?? null
  useEffect(() => {
    if (!ready) return
    if (reviewFolder.kind === 'topic' && !topics.some((topic) => topic.id === reviewFolder.topicId)) {
      useUIStore.getState().setReviewFolder({ kind: 'all' })
      return
    }
    if (session || (!reviewSessionId && explicitlyClosed.current === candidatesKey)) return
    const nextId = visibleSessions[0]?.id ?? null
    if (reviewSessionId !== nextId) setReviewSelection(nextId)
  }, [ready, reviewFolder, topics, session, reviewSessionId, candidatesKey, visibleSessions, setReviewSelection])
  const closeDocument = useCallback(() => {
    if (useUIStore.getState().reviewSessionId !== reviewSessionId) return
    explicitlyClosed.current = candidatesKey
    setListCollapsed(false)
    setView('review')
  }, [candidatesKey, reviewSessionId, setView])
  const handleDateClick = useCallback((date: string) => {
    setSelectedReviewDate(selectedReviewDate === date ? null : date)
  }, [selectedReviewDate, setSelectedReviewDate])
  const maxFolderWidth = Math.max(MIN_REVIEW_FOLDER_WIDTH, Math.min(MAX_REVIEW_FOLDER_WIDTH, containerWidth - MIN_REVIEW_LIST_WIDTH - 480 - 16))
  const effectiveFolderWidth = Math.min(reviewFolderWidth, maxFolderWidth)
  const navigationWidth = foldersOpen ? effectiveFolderWidth + 8 : 0
  const split = containerWidth >= (foldersOpen ? MIN_REVIEW_FOLDER_WIDTH + 8 : 0) + MIN_REVIEW_LIST_WIDTH + 480 + 8
  const maxListWidth = Math.max(MIN_REVIEW_LIST_WIDTH, Math.min(MAX_REVIEW_LIST_WIDTH, containerWidth - navigationWidth - 480 - 8))
  const effectiveWidth = Math.min(reviewListWidth, maxListWidth)
  const folderLabel = reviewFolder.kind === 'all' ? t.reviewFolders.all : reviewFolder.kind === 'unclassified' ? t.reviewFolders.unclassified : topics.find((topic) => topic.id === reviewFolder.topicId)?.name
  const showList = split ? !listCollapsed || !session : !reviewDocumentOpen || !session
  useEffect(() => {
    if (split) setDrawerOpen(false)
  }, [split])

  return <div ref={rootRef} className="h-full min-w-0 flex flex-col animate-view-enter" data-review-layout={split ? 'split' : 'single'}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      {split ? <button aria-expanded={foldersOpen} aria-controls="review-folders" onClick={() => setFoldersOpen(!foldersOpen)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent">{foldersOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{foldersOpen ? t.reviewFolders.collapseFolders : t.reviewFolders.expandFolders}</button>
        : <button aria-expanded={drawerOpen} aria-controls="review-folders" onClick={() => setDrawerOpen(true)} className="inline-flex items-center gap-2 rounded border border-input px-2 py-1.5 text-xs"><FolderOpen className="h-4 w-4" />{t.reviewFolders.showFolders}</button>}
      <span className="min-w-0 truncate text-sm font-medium">{folderLabel}</span>
      {split && <button aria-expanded={showList} aria-controls="review-session-list" onClick={() => setListCollapsed(!listCollapsed)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent">{showList ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}{showList ? t.reviewFolders.hideList : t.reviewFolders.showList}</button>}
      {reviewFolder.kind === 'all' && <button aria-expanded={activityOpen} aria-controls="review-activity" onClick={() => setActivityOpen(!activityOpen)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent">{activityOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{t.reviewFolders.activity}</button>}
      {selectedReviewDate && <button onClick={() => setSelectedReviewDate(null)} aria-label={`${t.reviewFolders.clearDate}: ${selectedReviewDate}`} className="rounded border border-border px-2 py-1 text-xs">{selectedReviewDate} <X className="inline h-3 w-3" /></button>}
    </div>
    {reviewFolder.kind === 'all' && activityOpen && <div id="review-activity" className="max-h-[35vh] shrink-0 overflow-auto border-b border-border p-3"><ActivityHeatmap sessions={scopedSessions} onDateClick={handleDateClick} activeDate={selectedReviewDate} /></div>}
    <div className="flex min-h-0 min-w-0 flex-1">
      {drawerOpen && !split && <div className="fixed inset-0 z-[80] bg-black/40" onClick={() => setDrawerOpen(false)} />}
      <aside id="review-folders" ref={drawerRef} role={drawerOpen && !split ? 'dialog' : undefined} aria-modal={drawerOpen && !split || undefined} aria-label={t.reviewFolders.title}
        style={split && foldersOpen ? { width: effectiveFolderWidth } : undefined}
        className={`${!split && drawerOpen ? 'fixed inset-y-0 left-0 z-[90] flex w-[min(90vw,380px)] bg-background' : split && foldersOpen ? 'flex bg-muted/20' : 'hidden'} min-h-0 min-w-0 shrink-0 flex-col overflow-y-auto border-r border-border p-2`}>
        {!split && drawerOpen && <button aria-label={t.reviewFolders.hideFolders} onClick={() => setDrawerOpen(false)} className="self-end rounded p-3"><X className="h-5 w-5" /></button>}
        {split && foldersOpen && <button onClick={() => setReviewFolderWidth(DEFAULT_REVIEW_FOLDER_WIDTH)} className="mb-1 self-end text-xs text-muted-foreground hover:text-primary">{t.reviewFolders.resetFolderWidth}</button>}
        <ReviewFolders onSelect={() => setDrawerOpen(false)} />
      </aside>
      {split && foldersOpen && <ReviewPaneSeparator width={effectiveFolderWidth} minWidth={MIN_REVIEW_FOLDER_WIDTH} maxWidth={maxFolderWidth}
        label={t.reviewFolders.resizeFolders} controls="review-folders" onResize={setReviewFolderWidth} onReset={() => setReviewFolderWidth(DEFAULT_REVIEW_FOLDER_WIDTH)} />}
      <section id="review-session-list" aria-label={t.reviewFolders.sessions} className={`${showList ? 'flex' : 'hidden'} min-h-0 min-w-0 shrink-0 flex-col border-r border-border bg-background`} style={{ width: split ? effectiveWidth : '100%' }}>
        <div className="flex items-center justify-between gap-2 px-3 py-2"><h2 className="text-xs font-semibold">{t.reviewFolders.sessions}</h2>{split && <button className="text-xs text-muted-foreground hover:text-primary" onClick={() => setReviewListWidth(DEFAULT_REVIEW_LIST_WIDTH)}>{t.reviewFolders.resetWidth}</button>}</div>
        <HistoryPanel variant="rail" className="min-h-0 flex-1 flex flex-col rounded-none border-0" contentHeightClassName="min-h-0 flex-1" />
      </section>
      {split && showList && <ReviewPaneSeparator width={effectiveWidth} minWidth={MIN_REVIEW_LIST_WIDTH} maxWidth={maxListWidth}
        label={t.reviewFolders.resizeList} controls="review-session-list" onResize={setReviewListWidth} onReset={() => setReviewListWidth(DEFAULT_REVIEW_LIST_WIDTH)} />}
      <section aria-label={t.reviewFolders.document} className={`${split || reviewDocumentOpen && session ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card`}>
        {session ? <PreviewModal key={session.id} session={session} onClose={closeDocument} mode="view" closeLabel={t.reviewFolders.backToList} />
          : <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{visibleSessions.length ? t.reviewFolders.selectSession : t.history.noMatchingRecords}</div>}
      </section>
    </div>
  </div>
}
