import type { CorrectionDiffPart } from './correctionPatch'
import type {
  ResolvedCorrectionPatch,
  TranscriptCorrection,
  TranscriptSegment,
  TranscriptSpeaker,
} from '../types'
import { buildCorrectionDiff, materializeCorrection } from './correctionPatch'

export type CorrectionSegmentProjectionFailure =
  | 'no-speaker-segments'
  | 'segment-alignment-failed'
  | 'patch-crosses-segment-boundary'
  | 'patch-on-ambiguous-boundary'
  | 'projection-mismatch'

type BoundaryProjectionFailure = Extract<
  CorrectionSegmentProjectionFailure,
  'patch-crosses-segment-boundary' | 'patch-on-ambiguous-boundary'
>

export interface ProjectedCorrectionSegment extends TranscriptSegment {
  segmentIndex: number
  originalText: string
  correctedText: string
  diff: CorrectionDiffPart[]
}

export interface CorrectionSpeakerDisplayItem {
  kind: 'speaker'
  segmentIndex: number
  speakerId?: string
  startMs?: number
  endMs?: number
  diff: CorrectionDiffPart[]
}

export interface CorrectionUncertainContext {
  segmentIndex: number
  speakerId?: string
  startMs?: number
  endMs?: number
}

export interface CorrectionUncertainDisplayItem {
  kind: 'uncertain'
  patchId: string
  operation: ResolvedCorrectionPatch['op']
  before?: CorrectionUncertainContext
  after?: CorrectionUncertainContext
  diff: CorrectionDiffPart[]
}

export type CorrectionDisplayItem = CorrectionSpeakerDisplayItem | CorrectionUncertainDisplayItem

interface CorrectionProjectionBase {
  correctedText: string
  fullDiff: CorrectionDiffPart[]
}

export type CorrectionSegmentProjection =
  | (CorrectionProjectionBase & {
      status: 'projected'
      segments: ProjectedCorrectionSegment[]
      speakerIds: string[]
    })
  | (CorrectionProjectionBase & {
      status: 'degraded'
      reason: BoundaryProjectionFailure
      items: CorrectionDisplayItem[]
      speakerIds: string[]
    })
  | (CorrectionProjectionBase & {
      status: 'unaligned'
      reason: 'segment-alignment-failed' | 'projection-mismatch'
      originalSegments: ProjectedCorrectionSegment[]
      speakerIds: string[]
    })
  | (CorrectionProjectionBase & {
      status: 'plain-text'
      reason: 'no-speaker-segments' | 'projection-mismatch'
    })

interface SegmentRange {
  segment: TranscriptSegment
  segmentIndex: number
  start: number
  end: number
}

interface MaterializedCorrection {
  correctedText: string
  fullDiff: CorrectionDiffPart[]
  mismatch: boolean
}

function speakerIdsFromSegments(segments: TranscriptSegment[]): string[] {
  return [...new Set(segments.flatMap((segment) => segment.text.length > 0 && segment.speakerId ? [segment.speakerId] : []))]
}

function originalProjectionSegments(segments: TranscriptSegment[]): ProjectedCorrectionSegment[] {
  return segments.flatMap((segment, segmentIndex) => segment.text.length > 0 ? [{
    ...segment,
    segmentIndex,
    originalText: segment.text,
    correctedText: segment.text,
    diff: [{ type: 'unchanged' as const, text: segment.text }],
  }] : [])
}

function replacementDiff(transcript: string, correctedText: string): CorrectionDiffPart[] {
  if (transcript === correctedText) return transcript ? [{ type: 'unchanged', text: transcript }] : []
  return [
    ...(transcript ? [{ type: 'removed' as const, text: transcript }] : []),
    ...(correctedText ? [{ type: 'added' as const, text: correctedText }] : []),
  ]
}

function effectiveDiffText(parts: CorrectionDiffPart[]): string {
  return parts.filter((part) => part.type !== 'removed').map((part) => part.text).join('')
}

function materializeForProjection(
  transcript: string,
  patches: ResolvedCorrectionPatch[],
  expectedCorrectedText?: string,
): MaterializedCorrection {
  try {
    const correctedText = materializeCorrection(transcript, patches)
    if (expectedCorrectedText !== undefined && expectedCorrectedText !== correctedText) {
      return {
        correctedText: expectedCorrectedText,
        fullDiff: replacementDiff(transcript, expectedCorrectedText),
        mismatch: true,
      }
    }
    const fullDiff = buildCorrectionDiff(transcript, patches)
    if (effectiveDiffText(fullDiff) !== correctedText) {
      return {
        correctedText,
        fullDiff: replacementDiff(transcript, correctedText),
        mismatch: true,
      }
    }
    return { correctedText, fullDiff, mismatch: false }
  } catch {
    const correctedText = expectedCorrectedText ?? transcript
    return {
      correctedText,
      fullDiff: replacementDiff(transcript, correctedText),
      mismatch: true,
    }
  }
}

function mapSegmentRanges(
  transcript: string,
  segments: TranscriptSegment[],
): { ranges?: SegmentRange[]; reason?: CorrectionSegmentProjectionFailure } {
  const candidates = segments
    .map((segment, segmentIndex) => ({ segment, segmentIndex }))
    .filter(({ segment }) => segment.text.length > 0)
  if (!candidates.length || !candidates.some(({ segment }) => Boolean(segment.speakerId))) {
    return { reason: 'no-speaker-segments' }
  }

  const ranges: SegmentRange[] = []
  let cursor = 0
  for (const { segment, segmentIndex } of candidates) {
    const start = transcript.indexOf(segment.text, cursor)
    if (start < 0 || transcript.slice(cursor, start).trim()) return { reason: 'segment-alignment-failed' }
    const end = start + segment.text.length
    ranges.push({ segment, segmentIndex, start, end })
    cursor = end
  }
  if (transcript.slice(cursor).trim()) return { reason: 'segment-alignment-failed' }
  return { ranges }
}

function findPatchOwner(
  patch: ResolvedCorrectionPatch,
  ranges: SegmentRange[],
  transcriptLength: number,
): { range: SegmentRange; index: number } | BoundaryProjectionFailure {
  if (patch.sourceStart === patch.sourceEnd) {
    if (patch.sourceStart === 0 && ranges[0]?.start === 0) return { range: ranges[0], index: 0 }
    const lastIndex = ranges.length - 1
    if (patch.sourceStart === transcriptLength && ranges[lastIndex]?.end === transcriptLength) {
      return { range: ranges[lastIndex], index: lastIndex }
    }
    const index = ranges.findIndex((range) => patch.sourceStart > range.start && patch.sourceStart < range.end)
    return index >= 0 ? { range: ranges[index], index } : 'patch-on-ambiguous-boundary'
  }

  const index = ranges.findIndex((range) => (
    patch.sourceStart >= range.start && patch.sourceEnd <= range.end
  ))
  return index >= 0 ? { range: ranges[index], index } : 'patch-crosses-segment-boundary'
}

function contextFromRange(range: SegmentRange | undefined): CorrectionUncertainContext | undefined {
  return range ? {
    segmentIndex: range.segmentIndex,
    speakerId: range.segment.speakerId,
    startMs: range.segment.startMs,
    endMs: range.segment.endMs,
  } : undefined
}

function uncertainContexts(
  patch: ResolvedCorrectionPatch,
  ranges: SegmentRange[],
): { before?: CorrectionUncertainContext; after?: CorrectionUncertainContext } {
  if (patch.sourceStart === patch.sourceEnd) {
    const before = [...ranges].reverse().find((range) => range.end <= patch.sourceStart)
    const after = ranges.find((range) => range.start >= patch.sourceEnd)
    return { before: contextFromRange(before), after: contextFromRange(after) }
  }
  const before = ranges.find((range) => patch.sourceStart >= range.start && patch.sourceStart < range.end)
    || [...ranges].reverse().find((range) => range.end <= patch.sourceStart)
  const after = ranges.find((range) => patch.sourceEnd > range.start && patch.sourceEnd <= range.end)
    || ranges.find((range) => range.start >= patch.sourceEnd)
  return { before: contextFromRange(before), after: contextFromRange(after) }
}

function appendDiffPart(parts: CorrectionDiffPart[], part: CorrectionDiffPart): void {
  if (!part.text) return
  const previous = parts[parts.length - 1]
  if (previous?.type === part.type && previous.patchId === part.patchId) {
    previous.text += part.text
    return
  }
  parts.push(part)
}

function buildDegradedItems(
  transcript: string,
  ranges: SegmentRange[],
  patches: ResolvedCorrectionPatch[],
): CorrectionDisplayItem[] {
  const items: CorrectionDisplayItem[] = []
  const ownership = ranges.map((range, index) => ({
    range,
    start: index === 0 ? 0 : range.start,
    end: index === ranges.length - 1 ? transcript.length : ranges[index + 1].start,
  }))

  const appendSpeakerPart = (range: SegmentRange, part: CorrectionDiffPart) => {
    if (!part.text) return
    const previous = items[items.length - 1]
    if (previous?.kind === 'speaker' && previous.segmentIndex === range.segmentIndex) {
      appendDiffPart(previous.diff, part)
      return
    }
    items.push({
      kind: 'speaker',
      segmentIndex: range.segmentIndex,
      speakerId: range.segment.speakerId,
      startMs: range.segment.startMs,
      endMs: range.segment.endMs,
      diff: [part],
    })
  }

  const appendSourceRange = (
    start: number,
    end: number,
    type: Extract<CorrectionDiffPart['type'], 'unchanged' | 'removed'>,
    patchId?: string,
  ) => {
    if (start >= end) return
    for (const owner of ownership) {
      const partStart = Math.max(start, owner.start)
      const partEnd = Math.min(end, owner.end)
      if (partStart < partEnd) {
        appendSpeakerPart(owner.range, {
          type,
          text: transcript.slice(partStart, partEnd),
          patchId,
        })
      }
    }
  }

  let cursor = 0
  for (const patch of patches) {
    appendSourceRange(cursor, patch.sourceStart, 'unchanged')
    const owner = findPatchOwner(patch, ranges, transcript.length)
    appendSourceRange(patch.sourceStart, patch.sourceEnd, 'removed', patch.id)
    if (typeof owner === 'string') {
      const contexts = uncertainContexts(patch, ranges)
      items.push({
        kind: 'uncertain',
        patchId: patch.id,
        operation: patch.op,
        ...contexts,
        diff: patch.replacement ? [{ type: 'added', text: patch.replacement, patchId: patch.id }] : [],
      })
    } else if (patch.replacement) {
      appendSpeakerPart(owner.range, { type: 'added', text: patch.replacement, patchId: patch.id })
    }
    cursor = patch.sourceEnd
  }
  appendSourceRange(cursor, transcript.length, 'unchanged')
  return items
}

function effectiveDisplayText(items: CorrectionDisplayItem[]): string {
  return effectiveDiffText(items.flatMap((item) => item.diff))
}

function mismatchProjection(
  segments: TranscriptSegment[],
  materialized: MaterializedCorrection,
): CorrectionSegmentProjection {
  const speakerIds = speakerIdsFromSegments(segments)
  if (!speakerIds.length) {
    return {
      status: 'plain-text',
      reason: 'projection-mismatch',
      correctedText: materialized.correctedText,
      fullDiff: materialized.fullDiff,
    }
  }
  return {
    status: 'unaligned',
    reason: 'projection-mismatch',
    originalSegments: originalProjectionSegments(segments),
    speakerIds,
    correctedText: materialized.correctedText,
    fullDiff: materialized.fullDiff,
  }
}

export function projectCorrectionOntoSegments(
  transcript: string,
  segments: TranscriptSegment[] | undefined,
  patches: ResolvedCorrectionPatch[],
  expectedCorrectedText?: string,
): CorrectionSegmentProjection {
  const sourceSegments = segments || []
  const activePatches = patches
    .filter((patch) => patch.state === 'applied')
    .sort((left, right) => left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd)
  const materialized = materializeForProjection(transcript, activePatches, expectedCorrectedText)
  if (materialized.mismatch) return mismatchProjection(sourceSegments, materialized)

  const mapping = mapSegmentRanges(transcript, sourceSegments)
  if (!mapping.ranges) {
    if (mapping.reason === 'no-speaker-segments') {
      return {
        status: 'plain-text',
        reason: 'no-speaker-segments',
        correctedText: materialized.correctedText,
        fullDiff: materialized.fullDiff,
      }
    }
    return {
      status: 'unaligned',
      reason: 'segment-alignment-failed',
      originalSegments: originalProjectionSegments(sourceSegments),
      speakerIds: speakerIdsFromSegments(sourceSegments),
      correctedText: materialized.correctedText,
      fullDiff: materialized.fullDiff,
    }
  }
  const ranges = mapping.ranges

  const localPatches = ranges.map(() => [] as ResolvedCorrectionPatch[])
  let boundaryFailure: BoundaryProjectionFailure | undefined
  for (const patch of activePatches) {
    const owner = findPatchOwner(patch, ranges, transcript.length)
    if (typeof owner === 'string') {
      boundaryFailure ||= owner
      continue
    }
    localPatches[owner.index].push({
      ...patch,
      sourceStart: patch.sourceStart - owner.range.start,
      sourceEnd: patch.sourceEnd - owner.range.start,
    })
  }

  if (boundaryFailure) {
    const items = buildDegradedItems(transcript, ranges, activePatches)
    if (effectiveDisplayText(items) !== materialized.correctedText) {
      return mismatchProjection(sourceSegments, materialized)
    }
    return {
      status: 'degraded',
      reason: boundaryFailure,
      items,
      speakerIds: speakerIdsFromSegments(sourceSegments),
      correctedText: materialized.correctedText,
      fullDiff: materialized.fullDiff,
    }
  }

  let projectedSegments: ProjectedCorrectionSegment[]
  try {
    projectedSegments = ranges.map((range, index): ProjectedCorrectionSegment => {
      const segmentPatches = localPatches[index]
      const segmentCorrectedText = materializeCorrection(range.segment.text, segmentPatches)
      const leadingText = index === 0 ? transcript.slice(0, range.start) : ''
      const trailingText = transcript.slice(range.end, ranges[index + 1]?.start ?? transcript.length)
      return {
        ...range.segment,
        segmentIndex: range.segmentIndex,
        text: segmentCorrectedText,
        originalText: range.segment.text,
        correctedText: segmentCorrectedText,
        diff: [
          ...(leadingText ? [{ type: 'unchanged' as const, text: leadingText }] : []),
          ...buildCorrectionDiff(range.segment.text, segmentPatches),
          ...(trailingText ? [{ type: 'unchanged' as const, text: trailingText }] : []),
        ],
      }
    })
  } catch {
    return mismatchProjection(sourceSegments, materialized)
  }

  let cursor = 0
  let reconstructed = ''
  for (let index = 0; index < ranges.length; index += 1) {
    reconstructed += transcript.slice(cursor, ranges[index].start)
    reconstructed += projectedSegments[index].correctedText
    cursor = ranges[index].end
  }
  reconstructed += transcript.slice(cursor)
  if (
    reconstructed !== materialized.correctedText
    || effectiveDiffText(projectedSegments.flatMap((segment) => segment.diff)) !== materialized.correctedText
  ) {
    return mismatchProjection(sourceSegments, materialized)
  }

  return {
    status: 'projected',
    segments: projectedSegments,
    speakerIds: speakerIdsFromSegments(sourceSegments),
    correctedText: materialized.correctedText,
    fullDiff: materialized.fullDiff,
  }
}

export function projectSessionCorrection(
  transcript: string,
  segments: TranscriptSegment[] | undefined,
  correction: TranscriptCorrection | undefined,
): CorrectionSegmentProjection | null {
  const published = correction?.published
  if (published) {
    return projectCorrectionOntoSegments(transcript, segments, published.patches, published.correctedText)
  }
  const legacyCorrectedText = correction?.legacy?.correctedText
    || (correction?.status === 'done' ? correction.correctedText : undefined)
  return legacyCorrectedText
    ? projectCorrectionOntoSegments(transcript, segments, [], legacyCorrectedText)
    : null
}

export function formatCorrectionTime(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  const totalSeconds = Math.floor(ms / 1_000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

export function resolveCorrectionSpeakerName(
  speakerId: string,
  speakers: TranscriptSpeaker[] | undefined,
): string {
  const speaker = (speakers || []).find((candidate) => candidate.id === speakerId)
  return speaker?.displayName?.trim() || speaker?.label?.trim() || speakerId
}

function speakerHeader(
  speakerId: string | undefined,
  startMs: number | undefined,
  speakerIds: string[],
  speakers: TranscriptSpeaker[] | undefined,
  language: 'zh' | 'en',
): string[] {
  if (!speakerId) {
    return [language === 'zh' ? '未标注说话人' : 'Unlabeled speaker', formatCorrectionTime(startMs)]
      .filter((value): value is string => Boolean(value))
  }
  return [
    `S${speakerIds.indexOf(speakerId) + 1}`,
    resolveCorrectionSpeakerName(speakerId, speakers),
    formatCorrectionTime(startMs),
  ].filter((value): value is string => Boolean(value))
}

function contextHeader(
  context: CorrectionUncertainContext | undefined,
  speakerIds: string[],
  language: 'zh' | 'en',
): string | undefined {
  if (!context) return undefined
  const speaker = context.speakerId
    ? `S${speakerIds.indexOf(context.speakerId) + 1}`
    : language === 'zh' ? '未标注说话人' : 'Unlabeled speaker'
  const time = formatCorrectionTime(context.startMs)
  return [speaker, time].filter(Boolean).join(' ')
}

function formatBlock(header: string[], text: string, format: 'txt' | 'markdown'): string {
  if (format === 'markdown') {
    return `${header.length ? `### ${header.join(' · ')}\n\n` : ''}${text}`
  }
  return `${header.length ? `${header.join('\n')}\n` : ''}${text}`
}

function correctedItemText(item: CorrectionDisplayItem): string {
  return item.diff.filter((part) => part.type !== 'removed').map((part) => part.text).join('')
}

export function formatCorrectionProjection(
  projection: CorrectionSegmentProjection,
  speakers: TranscriptSpeaker[] | undefined,
  format: 'txt' | 'markdown',
  language: 'zh' | 'en' = 'en',
): string {
  if (projection.status === 'plain-text') return projection.correctedText

  if (projection.status === 'unaligned') {
    const original = projection.originalSegments.map((segment) => formatBlock(
      speakerHeader(segment.speakerId, segment.startMs, projection.speakerIds, speakers, language),
      segment.correctedText,
      format,
    )).join('\n\n')
    const warning = language === 'zh'
      ? '原说话人分段无法与完整原文安全对应。以下先保留原分段，再附无法安全分段的完整修正稿。'
      : 'Original speaker segments could not be safely matched to the full transcript. The original segments are preserved above, followed by the complete correction that could not be safely segmented.'
    const title = language === 'zh' ? '完整修正稿（无法安全分段）' : 'Complete correction (could not be safely segmented)'
    if (format === 'markdown') {
      return `${original}\n\n---\n\n> ${warning}\n\n## ${title}\n\n${projection.correctedText}`
    }
    return `${original}\n\n${'='.repeat(50)}\n[DeLive] ${warning}\n${title}\n${'-'.repeat(50)}\n${projection.correctedText}`
  }

  if (projection.status === 'projected') {
    return projection.segments.map((segment) => formatBlock(
      speakerHeader(segment.speakerId, segment.startMs, projection.speakerIds, speakers, language),
      segment.correctedText,
      format,
    )).join('\n\n')
  }

  return projection.items.flatMap((item) => {
    const text = correctedItemText(item)
    if (item.kind === 'uncertain') {
      if (!text) return []
      const before = contextHeader(item.before, projection.speakerIds, language)
      const after = contextHeader(item.after, projection.speakerIds, language)
      const context = [before, after].filter(Boolean).join(' ↔ ')
      return [formatBlock([
        'S?',
        language === 'zh' ? '说话人不确定' : 'Speaker uncertain',
        context,
      ].filter(Boolean), text, format)]
    }
    return [formatBlock(
      speakerHeader(item.speakerId, item.startMs, projection.speakerIds, speakers, language),
      text,
      format,
    )]
  }).join('\n\n')
}
