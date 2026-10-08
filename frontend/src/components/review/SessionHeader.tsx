import { useEffect, useRef, useState } from 'react'
import {
  X,
  Download,
  Calendar,
  Clock,
  FileText,
  FolderOpen,
  SpellCheck,
  Sparkles,
  Subtitles,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Trash2,
} from 'lucide-react'
import type { TranscriptSession } from '../../types'
import {
  buildSessionExportFilename,
  buildCorrectedTranscriptExportBody,
  buildCorrectedTranscriptMarkdown,
  exportAiAnalysisToMarkdown,
  exportAiAnalysisToTxt,
  exportToMarkdown,
  exportToTxt,
} from '../../utils/storage'
import { downloadSubtitle } from '../../utils/subtitleExport'
import { saveManualExport } from '../../utils/storageUtils'
import { hasPostProcessContent } from '../../utils/transcriptState'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { SessionDeleteDialog } from '../SessionDeleteDialog'
import { sessionRepository } from '../../utils/sessionRepository'
import { savePublishedMarkdown } from '../../utils/publishedMarkdownCoordinator'
import { measureNextDiagnosticFrame } from '../../hooks/usePerformanceDiagnostics'

interface SessionHeaderProps {
  session: TranscriptSession
  onClose: () => void
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  closeLabel?: string
}

export function SessionHeader({
  session,
  onClose,
  sidebarCollapsed,
  onToggleSidebar,
  closeLabel,
}: SessionHeaderProps) {
  const { t } = useUIStore()
  const language = useUIStore((s) => s.language)
  const liveSession = useSessionStore(
    (s) => s.sessions.find((sess) => sess.id === session.id),
  ) ?? session
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const [titleError, setTitleError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const translatedText = liveSession.translatedTranscript?.text?.trim() || ''
  const hasContent = Boolean(liveSession.transcript || translatedText)
  const correctedText = liveSession.correction?.published?.correctedText
    || liveSession.correction?.legacy?.correctedText
    || (liveSession.correction?.status === 'done' ? liveSession.correction.correctedText : undefined)
  const hasCorrectedText = Boolean(correctedText)
  const hasAiAnalysis = liveSession.postProcess?.status === 'success' && hasPostProcessContent(liveSession.postProcess)
  const sourceAudioPath = liveSession.sourceMeta?.audioPath?.trim()
  const isExtractedVideoAudio = liveSession.sourceMeta?.sourceKind === 'extracted-video-audio'
  const [sourceAudioAvailable, setSourceAudioAvailable] = useState<boolean | undefined>(
    liveSession.sourceMeta?.audioAvailable,
  )

  useEffect(() => {
    if (!sourceAudioPath) {
      setSourceAudioAvailable(false)
      return
    }
    let disposed = false
    void window.electronAPI?.getMediaAudio(liveSession.id).then((result) => {
      if (!disposed) setSourceAudioAvailable(Boolean(result?.ok))
    }).catch(() => { if (!disposed) setSourceAudioAvailable(false) })
    return () => { disposed = true }
  }, [liveSession.id, sourceAudioPath, liveSession.sourceMeta?.managedAsset?.revision, liveSession.sourceMeta?.audioAvailable])
  const handleExportTxt = () => {
    void exportToTxt(liveSession)
    setShowExportMenu(false)
  }

  const handleExportMarkdown = () => {
    void exportToMarkdown(liveSession)
    setShowExportMenu(false)
  }

  const handleExportSrt = () => {
    void downloadSubtitle(liveSession, 'srt')
    setShowExportMenu(false)
  }

  const handleExportVtt = () => {
    void downloadSubtitle(liveSession, 'vtt')
    setShowExportMenu(false)
  }

  const handleExportCorrectedTxt = () => {
    if (!correctedText) return
    void saveManualExport(liveSession, buildCorrectedTranscriptExportBody(liveSession, 'txt', language), buildSessionExportFilename(liveSession, 'txt', 'corrected'), 'text/plain;charset=utf-8')
    setShowExportMenu(false)
  }

  const handleExportCorrectedMarkdown = () => {
    if (!correctedText) return
    const content = buildCorrectedTranscriptMarkdown(
      liveSession,
      t.preview.correctionCorrected,
      language,
    )
    void saveManualExport(liveSession, content, buildSessionExportFilename(liveSession, 'md', 'corrected'), 'text/markdown;charset=utf-8')
    setShowExportMenu(false)
  }

  const handleExportAiAnalysisTxt = () => {
    void exportAiAnalysisToTxt(liveSession)
    setShowExportMenu(false)
  }

  const handleExportAiAnalysisMarkdown = () => {
    void exportAiAnalysisToMarkdown(liveSession)
    setShowExportMenu(false)
  }

  const handleRevealSourceAudio = async () => {
    if (!sourceAudioPath) return
    const result = await window.electronAPI?.revealMediaAudio?.(liveSession.id)
    if (!result?.ok) { setSourceAudioAvailable(false); window.alert(result?.error || t.fileStorage.unavailable) }
  }

  return (
    <>
    <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 border-b border-border bg-muted/30">
      <div className="flex basis-[240px] flex-1 items-center gap-3 min-w-0">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="hidden lg:inline-flex items-center justify-center h-8 w-8 shrink-0 rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={sidebarCollapsed ? 'Show session library' : 'Hide session library'}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>
        )}
        <div className="p-2 bg-primary/10 rounded-lg flex-shrink-0 border border-primary/20">
          <FileText className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          {editingTitle ? <form onSubmit={(event) => {
            event.preventDefault()
            if (titleSaving || !titleDraft.trim()) return
            setTitleSaving(true)
            setTitleError('')
            void useSessionStore.getState().updateSessionTitle(liveSession.id, titleDraft.trim()).then(() => setEditingTitle(false)).catch((error: unknown) => {
              setTitleError(`${language === 'zh' ? '未确认标题保存成功，请重试。' : 'Title save was not confirmed; retry.'} ${error instanceof Error ? error.message : String(error)}`)
            }).finally(() => setTitleSaving(false))
          }} className="flex items-center gap-2">
            <input autoFocus disabled={titleSaving} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return } if (event.key === 'Escape') { event.stopPropagation(); if (!titleSaving) setEditingTitle(false) } }} className="min-w-0 rounded border border-input bg-background px-2 py-1 text-sm" aria-label={t.history.editTitle} />
            <button type="submit" disabled={titleSaving} className="text-xs text-primary disabled:opacity-50">{t.common.save}</button>
          </form> : <h2 id="session-review-title" title={liveSession.title} className="text-lg font-semibold tracking-tight truncate">{liveSession.title}</h2>}
          {titleError && <p role="alert" className="text-xs text-destructive">{titleError}</p>}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              {liveSession.date}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {liveSession.time}
            </span>
            <span className="text-xs text-muted-foreground">
              {liveSession.transcript?.length || 0} {t.common.characters}
            </span>
          </div>
          {liveSession.correctedMarkdownFile && <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" role="status">
            <span className={liveSession.correctedMarkdownFile.error ? 'text-destructive' : 'text-muted-foreground'}>
              {language === 'zh' ? '纠错稿文件：' : 'Corrected file: '}
              {liveSession.correctedMarkdownFile.status === 'saved' ? (language === 'zh' ? '已保存' : 'Saved')
                : liveSession.correctedMarkdownFile.status === 'saving' ? (language === 'zh' ? '正在保存' : 'Saving')
                  : liveSession.correctedMarkdownFile.status === 'waiting-directory' ? (language === 'zh' ? '等待配置转录目录' : 'Choose a transcript directory')
                    : liveSession.correctedMarkdownFile.error || liveSession.correctedMarkdownFile.status}
            </span>
            {liveSession.correctedMarkdownFile.status !== 'saved' && liveSession.correctedMarkdownFile.status !== 'saving' && <button type="button" onClick={() => void savePublishedMarkdown(liveSession.id, { retry: true })} className="text-primary hover:underline">
              {language === 'zh' ? '仅重试文件保存' : 'Retry file only'}
            </button>}
            {liveSession.correctedMarkdownFile.path && <span className="max-w-full break-all text-muted-foreground">{liveSession.correctedMarkdownFile.path}</span>}
            {!liveSession.correctedMarkdownFile.registrationId && liveSession.correction?.published && <button type="button" className="text-primary hover:underline" onClick={() => {
              measureNextDiagnosticFrame('ui.legacy-adopt')
              void savePublishedMarkdown(liveSession.id, { retry: true, adoptLegacy: true }).catch((error: unknown) => window.alert(error instanceof Error ? error.message : String(error)))
            }}>{language === 'zh' ? '选择并接管旧纠错稿' : 'Select and adopt legacy Markdown'}</button>}
            {liveSession.correctedMarkdownFile.registrationId && <>
              <button type="button" className="text-primary hover:underline" onClick={() => void (async () => {
                const result = await window.electronAPI?.locatePublishedMarkdown(liveSession.id)
                if (!result) return
                if (!result.ok || !result.file) { window.alert(result.error); return }
                const sessions = await sessionRepository.updateMetadataDurable(liveSession.id, { correctedMarkdownFile: result.file })
                useSessionStore.setState({ sessions })
              })().catch((error: unknown) => window.alert(error instanceof Error ? error.message : String(error)))}>{language === 'zh' ? '定位已有稿件' : 'Locate file'}</button>
              <button type="button" className="text-primary hover:underline" onClick={() => void (async () => {
                const result = await window.electronAPI?.relocatePublishedMarkdown(liveSession.id)
                if (!result) return
                if (!result.ok || !result.file) { window.alert(result.error); return }
                const sessions = await sessionRepository.updateMetadataDurable(liveSession.id, { correctedMarkdownFile: result.file })
                useSessionStore.setState({ sessions })
                await savePublishedMarkdown(liveSession.id, { retry: true })
              })().catch((error: unknown) => window.alert(error instanceof Error ? error.message : String(error)))}>{language === 'zh' ? '重新选择保存位置' : 'Relocate file'}</button>
            </>}
          </div>}
          {liveSession.managedNaming?.status === 'error' && <p role="alert" className="text-xs text-destructive">{liveSession.managedNaming.error}</p>}
          {!liveSession.correctedMarkdownFile && liveSession.correction?.published && <button type="button" className="mt-1 text-xs text-primary hover:underline" onClick={() => {
            measureNextDiagnosticFrame('ui.legacy-adopt')
            void savePublishedMarkdown(liveSession.id, { retry: true, adoptLegacy: true }).catch((error: unknown) => window.alert(error instanceof Error ? error.message : String(error)))
          }}>{language === 'zh' ? '选择并接管旧纠错稿' : 'Select and adopt legacy Markdown'}</button>}
        </div>
      </div>

      <div className="flex max-w-full flex-wrap items-center gap-2">
        <button onClick={() => { measureNextDiagnosticFrame('ui.title-editor'); setTitleDraft(liveSession.title); setEditingTitle(true) }} title={t.history.editTitle} aria-label={t.history.editTitle} className="rounded-lg p-2 hover:bg-accent"><Pencil className="h-4 w-4" /></button>
        <button onClick={() => setDeleting(true)} title={t.common.delete} aria-label={t.common.delete} className="rounded-lg p-2 text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /></button>
        {sourceAudioPath && sourceAudioAvailable && (
          <button
            type="button"
            onClick={handleRevealSourceAudio}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <FolderOpen className="w-4 h-4" />
            {isExtractedVideoAudio
              ? (language === 'zh' ? '打开提取音频文件夹' : 'Open Extracted Audio Folder')
              : (language === 'zh' ? '打开录音文件夹' : 'Open Recording Folder')}
          </button>
        )}
        {sourceAudioPath && sourceAudioAvailable === false && (
          <span className="inline-flex items-center rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {language === 'zh' ? '本地音频不可用' : 'Local audio unavailable'}
          </span>
        )}
        {hasContent && (
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Download className="w-4 h-4" />
              {t.common.export}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {showExportMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border bg-card p-1 shadow-lg animate-dropdown-in">
                  <button
                    onClick={handleExportTxt}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <FileText className="w-4 h-4" />
                    {t.preview.exportTxt}
                  </button>
                  <button
                    onClick={handleExportMarkdown}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <FileText className="w-4 h-4" />
                    Markdown
                  </button>
                  <button
                    onClick={handleExportSrt}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <Subtitles className="w-4 h-4" />
                    SRT
                  </button>
                  <button
                    onClick={handleExportVtt}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <Subtitles className="w-4 h-4" />
                    VTT
                  </button>
                  {hasCorrectedText && (
                    <>
                      <div className="mx-1 my-1 border-t border-border" />
                      <button
                        onClick={handleExportCorrectedTxt}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-primary transition-colors hover:bg-accent"
                      >
                        <SpellCheck className="w-4 h-4" />
                        TXT ({t.preview.correctionCorrected})
                      </button>
                      <button
                        onClick={handleExportCorrectedMarkdown}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-primary transition-colors hover:bg-accent"
                      >
                        <SpellCheck className="w-4 h-4" />
                        Markdown ({t.preview.correctionCorrected})
                      </button>
                    </>
                  )}
                  {hasAiAnalysis && (
                    <>
                      <div className="mx-1 my-1 border-t border-border" />
                      <button
                        onClick={handleExportAiAnalysisTxt}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-primary transition-colors hover:bg-accent"
                      >
                        <Sparkles className="w-4 h-4" />
                        TXT (AI Analysis)
                      </button>
                      <button
                        onClick={handleExportAiAnalysisMarkdown}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-primary transition-colors hover:bg-accent"
                      >
                        <Sparkles className="w-4 h-4" />
                        Markdown (AI Analysis)
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        <button
          onClick={onClose}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap p-2 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground"
          aria-label={closeLabel || t.common.close}
        >
          <X className="w-5 h-5" />
          {closeLabel && <span className="text-xs">{closeLabel}</span>}
        </button>
      </div>
    </div>
    <SessionDeleteDialog key={deleting ? liveSession.id : 'closed'} session={deleting ? liveSession : null} onClose={() => {
      setDeleting(false)
      if (!useSessionStore.getState().sessions.some((item) => item.id === liveSession.id)) onClose()
    }} />
    </>
  )
}
