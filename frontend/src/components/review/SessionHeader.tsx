import { useMemo, useRef, useState } from 'react'
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
} from 'lucide-react'
import type { TranscriptSession } from '../../types'
import {
  exportAiAnalysisToMarkdown,
  exportAiAnalysisToTxt,
  exportToMarkdown,
  exportToTxt,
} from '../../utils/storage'
import { downloadSubtitle } from '../../utils/subtitleExport'
import { hasPostProcessContent } from '../../utils/transcriptState'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { formatCorrectionProjection, projectSessionCorrection } from '../../utils/correctedSegmentProjection'

interface SessionHeaderProps {
  session: TranscriptSession
  onClose: () => void
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}

export function SessionHeader({
  session,
  onClose,
  sidebarCollapsed,
  onToggleSidebar,
}: SessionHeaderProps) {
  const { t } = useUIStore()
  const language = useUIStore((s) => s.language)
  const liveSession = useSessionStore(
    (s) => s.sessions.find((sess) => sess.id === session.id),
  ) ?? session
  const [showExportMenu, setShowExportMenu] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const translatedText = liveSession.translatedTranscript?.text?.trim() || ''
  const hasContent = Boolean(liveSession.transcript || translatedText)
  const correctedText = liveSession.correction?.published?.correctedText
    || liveSession.correction?.legacy?.correctedText
    || (liveSession.correction?.status === 'done' ? liveSession.correction.correctedText : undefined)
  const hasCorrectedText = Boolean(correctedText)
  const hasAiAnalysis = liveSession.postProcess?.status === 'success' && hasPostProcessContent(liveSession.postProcess)
  const sourceAudioPath = liveSession.sourceMeta?.audioPath?.trim()
  const correctedSegmentProjection = useMemo(
    () => projectSessionCorrection(liveSession.transcript, liveSession.segments, liveSession.correction),
    [liveSession.correction, liveSession.segments, liveSession.transcript],
  )

  const correctedExportBody = (format: 'txt' | 'markdown'): string => {
    if (!correctedText) return ''
    if (correctedSegmentProjection) {
      return formatCorrectionProjection(correctedSegmentProjection, liveSession.speakers, format, language)
    }
    return correctedText
  }

  const handleExportTxt = () => {
    exportToTxt(liveSession)
    setShowExportMenu(false)
  }

  const handleExportMarkdown = () => {
    exportToMarkdown(liveSession)
    setShowExportMenu(false)
  }

  const handleExportSrt = () => {
    downloadSubtitle(liveSession, 'srt')
    setShowExportMenu(false)
  }

  const handleExportVtt = () => {
    downloadSubtitle(liveSession, 'vtt')
    setShowExportMenu(false)
  }

  const handleExportCorrectedTxt = () => {
    if (!correctedText) return
    const blob = new Blob([correctedExportBody('txt')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${liveSession.title || 'transcript'}_corrected.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    setShowExportMenu(false)
  }

  const handleExportCorrectedMarkdown = () => {
    if (!correctedText) return
    const lines: string[] = []
    lines.push(`# ${liveSession.title} (${t.preview.correctionCorrected})`)
    lines.push('')
    lines.push(`> ${liveSession.date} ${liveSession.time}`)
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push(correctedExportBody('markdown'))
    lines.push('')
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${liveSession.title || 'transcript'}_corrected.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    setShowExportMenu(false)
  }

  const handleExportAiAnalysisTxt = () => {
    exportAiAnalysisToTxt(liveSession)
    setShowExportMenu(false)
  }

  const handleExportAiAnalysisMarkdown = () => {
    exportAiAnalysisToMarkdown(liveSession)
    setShowExportMenu(false)
  }

  const handleRevealSourceAudio = () => {
    if (!sourceAudioPath) return
    void window.electronAPI?.revealRecordingArchive?.(sourceAudioPath)
  }

  return (
    <div className="flex items-center justify-between px-6 py-3.5 border-b border-border bg-muted/30">
      <div className="flex items-center gap-3 min-w-0">
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
          <h2 id="session-review-title" className="text-lg font-semibold tracking-tight truncate">
            {liveSession.title}
          </h2>
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
        </div>
      </div>

      <div className="flex items-center gap-2">
        {sourceAudioPath && (
          <button
            type="button"
            onClick={handleRevealSourceAudio}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <FolderOpen className="w-4 h-4" />
            {language === 'zh' ? '打开录音文件夹' : 'Open Recording Folder'}
          </button>
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
          className="p-2 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground"
          aria-label={t.common.close}
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
