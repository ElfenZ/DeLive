import { useState, useMemo } from 'react'
import {
  Pencil,
  Check,
  X,
  FolderOpen,
} from 'lucide-react'
import type { TranscriptSession, TranscriptSpeaker } from '../../types'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { SessionProjectLinks } from '../SessionProjectLinks'
import { OriginalSourcePanel } from './OriginalSourcePanel'

const OVERVIEW_SPEAKER_COLORS = [
  { bg: 'bg-blue-500', text: 'text-white' },
  { bg: 'bg-emerald-500', text: 'text-white' },
  { bg: 'bg-amber-500', text: 'text-white' },
  { bg: 'bg-purple-500', text: 'text-white' },
  { bg: 'bg-rose-500', text: 'text-white' },
  { bg: 'bg-cyan-500', text: 'text-white' },
]

interface OverviewTabProps {
  session: TranscriptSession
}

export function OverviewTab({ session }: OverviewTabProps) {
  const { t } = useUIStore()
  const updateSessionSpeakers = useSessionStore((state) => state.updateSessionSpeakers)
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null)
  const [speakerDraftName, setSpeakerDraftName] = useState('')

  const sessionSpeakers = (session.speakers || []).filter((speaker) => speaker.id.trim())
  const speakerNameMap = Object.fromEntries(
    sessionSpeakers.map((speaker) => [
      speaker.id,
      speaker.displayName?.trim() || speaker.label?.trim() || speaker.id,
    ]),
  )
  const speakerIds = useMemo(() => sessionSpeakers.map(s => s.id), [sessionSpeakers])

  const startEditingSpeaker = (speaker: TranscriptSpeaker) => {
    setEditingSpeakerId(speaker.id)
    setSpeakerDraftName(speaker.displayName?.trim() || speaker.label?.trim() || speaker.id)
  }

  const cancelEditingSpeaker = () => {
    setEditingSpeakerId(null)
    setSpeakerDraftName('')
  }

  const saveSpeakerName = () => {
    if (!session || !editingSpeakerId) return
    const updatedSpeakers = sessionSpeakers.map((speaker) => (
      speaker.id === editingSpeakerId
        ? { ...speaker, displayName: speakerDraftName.trim() || speaker.label || speaker.id }
        : speaker
    ))
    updateSessionSpeakers(session.id, updatedSpeakers)
    cancelEditingSpeaker()
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Speaker Labels */}
      {sessionSpeakers.length > 0 && (
        <div className="rounded-xl border border-border/30 bg-card/70 p-5 space-y-4">
          <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t.preview.speakerLabels || 'Speaker labels'}
          </div>
          <div className="flex flex-wrap gap-2">
            {sessionSpeakers.map((speaker) => (
              editingSpeakerId === speaker.id ? (
                <div
                  key={speaker.id}
                  className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2"
                >
                  <input
                    type="text"
                    value={speakerDraftName}
                    onChange={(e) => setSpeakerDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveSpeakerName()
                      if (e.key === 'Escape') cancelEditingSpeaker()
                    }}
                    className="h-8 min-w-[120px] rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder={t.preview.speakerNamePlaceholder || 'Speaker name'}
                    autoFocus
                  />
                  <button
                    onClick={saveSpeakerName}
                    className="p-1.5 rounded-md text-success hover:bg-success/10 transition-colors"
                    title={t.common.save}
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    onClick={cancelEditingSpeaker}
                    className="p-1.5 rounded-md text-muted-foreground hover:bg-muted transition-colors"
                    title={t.common.cancel}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div
                  key={speaker.id}
                  className="flex items-center gap-2 rounded-full border border-border/30 bg-muted/30 px-3 py-1.5"
                >
                  {(() => {
                    const idx = speakerIds.indexOf(speaker.id)
                    const c = OVERVIEW_SPEAKER_COLORS[idx % OVERVIEW_SPEAKER_COLORS.length]
                    return (
                      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold ${c.bg} ${c.text}`}>
                        S{idx + 1}
                      </span>
                    )
                  })()}
                  <span className="text-sm font-medium text-foreground">
                    {speakerNameMap[speaker.id]}
                  </span>
                  <button
                    onClick={() => startEditingSpeaker(speaker)}
                    className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
                    title={t.preview.renameSpeaker || 'Rename speaker'}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            ))}
          </div>
        </div>
      )}

      {/* Topic */}
      <div className="rounded-xl border border-border/30 bg-card/70 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <FolderOpen className="w-3.5 h-3.5" />
            {t.topics.title}
          </div>
        </div>
        <SessionProjectLinks session={session} />
        <OriginalSourcePanel session={session} />
      </div>
    </div>
  )
}
