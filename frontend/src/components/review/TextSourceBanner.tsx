import { Info, Loader2 } from 'lucide-react'
import type { TranscriptSession, TranscriptTextSourceMetadata } from '../../types'
import { resolveTranscriptArtifactSourceState, resolveTranscriptText } from '../../services/aiPostProcess'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'

interface TextSourceBannerProps {
  session: TranscriptSession
  artifact?: TranscriptTextSourceMetadata
}

export function TextSourceBanner({ session, artifact }: TextSourceBannerProps) {
  const { t, language } = useUIStore()
  const settings = useSettingsStore((state) => state.settings)
  const preference = settings.aiPostProcess?.preferCorrectedText || 'auto'

  const liveSession = useSessionStore(
    (s) => s.sessions.find((sess) => sess.id === session.id),
  )
  const correction = liveSession?.correction ?? session.correction
  const currentSession = liveSession || session
  const draftStatus = correction?.draft?.status
  const currentSource = resolveTranscriptText(currentSession, preference)

  if (artifact) {
    const state = resolveTranscriptArtifactSourceState(artifact, currentSource)
    const label = language === 'zh'
      ? state === 'current' ? '基于当前文本源' : state === 'stale' ? '文本源已变化，结果可能过期' : '旧结果，文本源未知'
      : state === 'current' ? 'Current text source' : state === 'stale' ? 'Text source changed; result may be stale' : 'Legacy result; source unknown'
    return (
      <div className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
        state === 'current'
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : state === 'stale'
            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
            : 'bg-muted text-muted-foreground'
      }`}>
        <Info className="w-3 h-3 shrink-0" />
        {label}
      </div>
    )
  }

  const isCorrecting = draftStatus === 'queued' || draftStatus === 'running' || draftStatus === 'retrying'

  const hasCorrected = currentSource.sourceKind === 'published-correction' || currentSource.sourceKind === 'legacy-correction'

  if (isCorrecting && preference !== 'original') {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
        {t.preview.aiCorrectionInProgress as string}
      </div>
    )
  }

  if (!hasCorrected) return null

  const usingCorrected = currentSource.sourceKind !== 'original'

  return (
    <div className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
      usingCorrected
        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
        : 'bg-muted text-muted-foreground'
    }`}>
      <Info className="w-3 h-3 shrink-0" />
      {usingCorrected
        ? (t.preview.aiUsingCorrectedText as string)
        : (t.preview.aiUsingOriginalText as string)
      }
    </div>
  )
}
