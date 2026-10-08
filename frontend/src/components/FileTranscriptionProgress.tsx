import { FileAudio, Check, AlertCircle, Loader2, X, ArrowRight, FolderOpen, RotateCcw, Trash2 } from 'lucide-react'
import type { FileTranscriptionJob } from '../types/fileTranscription'
import { formatFileSize } from '../types/fileTranscription'
import { useUIStore } from '../stores/uiStore'

interface FileTranscriptionProgressProps {
  jobs: FileTranscriptionJob[]
  onCancel: (jobId: string) => void
  onOpenResult: (jobId: string) => void
  onRemove: (jobId: string) => void
  onRetry: (jobId: string) => void
  onReselectOriginal: (jobId: string) => void
  onRevealAudio: (jobId: string) => void
  onDeleteAudio: (jobId: string) => void
}

export function FileTranscriptionProgress({
  jobs,
  onCancel,
  onOpenResult,
  onRemove,
  onRetry,
  onReselectOriginal,
  onRevealAudio,
  onDeleteAudio,
}: FileTranscriptionProgressProps) {
  const { t, language } = useUIStore()

  const statusLabels = {
    queued: t.file?.statusQueued || 'Queued',
    extracting: t.file?.statusExtracting || 'Extracting audio',
    'audio-ready': t.file?.statusAudioReady || 'Audio ready',
    uploading: t.file?.statusUploading || 'Uploading',
    transcribing: t.file?.statusTranscribing || 'Transcribing',
    completed: t.file?.statusCompleted || 'Completed',
    error: t.file?.statusError || 'Error',
    cancelled: t.file?.statusCancelled || 'Cancelled',
  }

  if (jobs.length === 0) return null

  const JobStatusIcon = ({ status }: { status: string }) => {
    switch (status) {
      case 'completed':
        return <Check className="h-4 w-4 text-emerald-500" />
      case 'error':
        return <AlertCircle className="h-4 w-4 text-destructive" />
      case 'cancelled':
        return <X className="h-4 w-4 text-muted-foreground" />
      default:
        return <Loader2 className="h-4 w-4 text-primary animate-spin" />
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {t.file?.progressTitle || 'Transcription Tasks'}
      </p>
      {jobs.map((job) => (
        <div
          key={job.id}
          className={`flex items-center gap-3 rounded-lg border p-3 transition-all ${
            job.status === 'completed'
              ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-800/50 dark:bg-emerald-950/20'
              : job.status === 'error'
                ? 'border-destructive/30 bg-destructive/5'
                : 'border-border bg-card'
          }`}
        >
          <FileAudio className="h-4 w-4 text-muted-foreground flex-shrink-0" />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium truncate">{job.fileName}</p>
              <span className="text-xs text-muted-foreground">{formatFileSize(job.fileSize)}</span>
              {job.inputKind === 'video' && job.audioSize && (
                <span className="text-xs text-muted-foreground">
                  · {t.file?.extractedAudioSize?.(formatFileSize(job.audioSize)) || `Audio ${formatFileSize(job.audioSize)}`}
                </span>
              )}
            </div>

            {job.currentOriginalFileName && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {language === 'en' ? 'Current original: ' : '原件当前名称：'}{job.currentOriginalFileName}
              </p>
            )}
            {job.audioAvailable && job.audioFileName && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {language === 'en' ? 'Managed audio: ' : '受管音频名称：'}{job.audioFileName}
              </p>
            )}

            <div className="mt-1 flex items-center gap-2">
              <JobStatusIcon status={job.status} />
                <span className="text-xs text-muted-foreground">
                  {statusLabels[job.status as keyof typeof statusLabels] || job.status}
                </span>
              {job.audioDurationMs && job.status === 'completed' && (
                <span className="text-xs text-muted-foreground">
                  · {Math.round(job.audioDurationMs / 1000)}s
                </span>
              )}
            </div>

            {(job.status === 'extracting' || job.status === 'uploading' || job.status === 'transcribing' || job.status === 'queued') && (
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
            )}

            {job.error && (
              <p className="mt-1 text-xs text-destructive truncate">{job.error}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5 flex-shrink-0 max-w-[45%]">
            {job.status === 'completed' && job.sessionId && (
              <button
                onClick={() => onOpenResult(job.id)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary hover:text-primary-foreground transition-all"
              >
                {t.file?.viewTranscript || 'View Transcript'}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
            {job.inputKind === 'video' && job.audioAvailable && (
              <button
                onClick={() => onRevealAudio(job.id)}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title={t.file?.openAudioFolder || 'Open audio folder'}
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            )}
            {!job.requiresSourceSelection && ['audio-ready', 'error', 'cancelled'].includes(job.status) && (
              <button
                onClick={() => onRetry(job.id)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary hover:text-primary-foreground transition-all"
                title={t.file?.retrySelectedProvider || 'Retry with selected provider'}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t.file?.retry || 'Retry'}
              </button>
            )}
            {(job.requiresSourceSelection || !job.audioAvailable) && ['audio-ready', 'error', 'cancelled'].includes(job.status) && (
              <button
                onClick={() => onReselectOriginal(job.id)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary hover:text-primary-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {language === 'en' ? 'Reselect original and retry' : '重新选择原文件并重试'}
              </button>
            )}
            {job.inputKind === 'video' && job.audioAvailable && ['completed', 'error', 'cancelled', 'audio-ready'].includes(job.status) && (
              <button
                onClick={() => onDeleteAudio(job.id)}
                className="rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                title={t.file?.deleteLocalAudio || 'Delete local audio'}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            {(job.status === 'extracting' || job.status === 'uploading' || job.status === 'transcribing' || job.status === 'queued') && (
              <button
                onClick={() => onCancel(job.id)}
                className="rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                title={t.file?.cancel || 'Cancel'}
              >
                <X className="h-4 w-4" />
              </button>
            )}
            {(job.status === 'completed' || job.status === 'error' || job.status === 'cancelled' || job.status === 'audio-ready') && (
              <button
                onClick={() => onRemove(job.id)}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title={t.file?.remove || 'Remove'}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
