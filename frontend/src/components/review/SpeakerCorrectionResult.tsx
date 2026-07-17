import { Play } from 'lucide-react'
import type { TranscriptSpeaker } from '../../types'
import type {
  CorrectionDisplayItem,
  CorrectionSegmentProjection,
  CorrectionSpeakerDisplayItem,
  CorrectionUncertainContext,
} from '../../utils/correctedSegmentProjection'
import {
  formatCorrectionTime,
  resolveCorrectionSpeakerName,
} from '../../utils/correctedSegmentProjection'

type SpeakerProjection = Extract<
  CorrectionSegmentProjection,
  { status: 'projected' | 'degraded' | 'unaligned' }
>

interface SpeakerCorrectionResultProps {
  projection: SpeakerProjection
  speakers: TranscriptSpeaker[] | undefined
  isZh: boolean
}

const SPEAKER_COLORS = [
  { badge: 'bg-blue-500', label: 'text-blue-700 dark:text-blue-300' },
  { badge: 'bg-emerald-500', label: 'text-emerald-700 dark:text-emerald-300' },
  { badge: 'bg-amber-500', label: 'text-amber-700 dark:text-amber-300' },
  { badge: 'bg-purple-500', label: 'text-purple-700 dark:text-purple-300' },
  { badge: 'bg-rose-500', label: 'text-rose-700 dark:text-rose-300' },
  { badge: 'bg-cyan-500', label: 'text-cyan-700 dark:text-cyan-300' },
]

function displayItems(projection: SpeakerProjection): CorrectionDisplayItem[] {
  if (projection.status === 'degraded') return projection.items
  const segments = projection.status === 'projected' ? projection.segments : projection.originalSegments
  return segments.map((segment): CorrectionSpeakerDisplayItem => ({
    kind: 'speaker',
    segmentIndex: segment.segmentIndex,
    speakerId: segment.speakerId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    diff: segment.diff,
  }))
}

function diffClass(type: 'unchanged' | 'removed' | 'added'): string | undefined {
  if (type === 'removed') return 'bg-red-100 text-red-700 line-through dark:bg-red-900/30 dark:text-red-300'
  if (type === 'added') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
  return undefined
}

function contextLabel(
  context: CorrectionUncertainContext | undefined,
  speakerIds: string[],
  isZh: boolean,
): string | undefined {
  if (!context) return undefined
  const speaker = context.speakerId
    ? `S${speakerIds.indexOf(context.speakerId) + 1}`
    : isZh ? '未标注说话人' : 'Unlabeled speaker'
  const time = formatCorrectionTime(context.startMs)
  return [speaker, time].filter(Boolean).join(' ')
}

export function SpeakerCorrectionResult({ projection, speakers, isZh }: SpeakerCorrectionResultProps) {
  const items = displayItems(projection)

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-2">
      {items.map((item, index) => {
        if (item.kind === 'uncertain') {
          const before = contextLabel(item.before, projection.speakerIds, isZh)
          const after = contextLabel(item.after, projection.speakerIds, isZh)
          const context = [before, after].filter(Boolean).join(' ↔ ')
          return (
            <div key={`uncertain-${item.patchId}-${index}`} className="flex items-start gap-3 rounded-md bg-amber-50/70 px-2 py-2 dark:bg-amber-950/20">
              <div className="flex w-7 shrink-0 justify-center pt-0.5">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-[10px] font-semibold text-white">S?</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">{isZh ? '说话人不确定' : 'Speaker uncertain'}</span>
                  {context && <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{context}</span>}
                </div>
                {item.diff.length > 0
                  ? <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{item.diff.map((part, partIndex) => <span key={`${part.patchId || 'text'}-${partIndex}`} className={diffClass(part.type)}>{part.text}</span>)}</p>
                  : <p className="m-0 text-xs text-muted-foreground">{isZh ? '跨说话人删除，删除内容保留在原说话人段中。' : 'Cross-speaker deletion; removed text remains under its original speakers.'}</p>}
              </div>
            </div>
          )
        }

        const previous = items[index - 1]
        const sameSpeaker = Boolean(item.speakerId && previous?.kind === 'speaker' && previous.speakerId === item.speakerId)
        const speakerIndex = item.speakerId ? projection.speakerIds.indexOf(item.speakerId) : -1
        const colors = SPEAKER_COLORS[Math.max(0, speakerIndex) % SPEAKER_COLORS.length]
        const speakerName = item.speakerId
          ? resolveCorrectionSpeakerName(item.speakerId, speakers)
          : isZh ? '未标注说话人' : 'Unlabeled speaker'
        const time = formatCorrectionTime(item.startMs)
        return (
          <div key={`speaker-${item.segmentIndex}-${index}`} className="flex items-start gap-3 rounded-md px-2 py-2">
            <div className="flex w-7 shrink-0 justify-center pt-0.5">
              {!sameSpeaker && item.speakerId
                ? <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ${colors.badge}`}>S{speakerIndex + 1}</span>
                : !sameSpeaker
                  ? <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-400 text-[10px] font-semibold text-white">-</span>
                  : <span className="h-6 w-6" />}
            </div>
            <div className="min-w-0 flex-1">
              {!sameSpeaker && (
                <div className="mb-1 flex items-center gap-2">
                  <span className={`text-xs font-semibold ${item.speakerId ? colors.label : 'text-slate-600 dark:text-slate-300'}`}>{speakerName}</span>
                  {time !== undefined && <span className="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground"><Play className="h-2.5 w-2.5" />{time}</span>}
                </div>
              )}
              {sameSpeaker && time !== undefined && <span className="mb-0.5 inline-flex items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground/60"><Play className="h-2.5 w-2.5" />{time}</span>}
              <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {item.diff.map((part, partIndex) => <span key={`${part.patchId || 'text'}-${partIndex}`} className={diffClass(part.type)}>{part.text}</span>)}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
