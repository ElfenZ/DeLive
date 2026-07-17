import { describe, expect, it } from 'vitest'
import type { ResolvedCorrectionPatch, TranscriptSegment } from '../types'
import {
  formatCorrectionProjection,
  projectCorrectionOntoSegments,
  projectSessionCorrection,
} from './correctedSegmentProjection'
import { materializeCorrection } from './correctionPatch'

function patch(overrides: Partial<ResolvedCorrectionPatch>): ResolvedCorrectionPatch {
  return {
    id: 'patch',
    shardId: 'shard',
    op: 'replace',
    sourceStart: 0,
    sourceEnd: 0,
    sourceText: '',
    replacement: '',
    sourceTextHash: 'hash',
    category: 'homophone',
    reason: 'test',
    state: 'applied',
    ...overrides,
  }
}

const segments: TranscriptSegment[] = [
  { text: '需要侍应新的工作。', speakerId: '1', startMs: 0, endMs: 5_000 },
  { text: '我觉得可以。', speakerId: '2', startMs: 5_000, endMs: 10_000 },
]
const speakers = [{ id: '1', label: '主持人' }, { id: '2', label: '参会者' }]

function effectiveDisplayText(result: ReturnType<typeof projectCorrectionOntoSegments>): string {
  if (result.status !== 'degraded') throw new Error('Expected degraded projection')
  return result.items.flatMap((item) => item.diff)
    .filter((part) => part.type !== 'removed')
    .map((part) => part.text)
    .join('')
}

describe('corrected segment projection', () => {
  it('keeps the strict projection for patches contained within one segment', () => {
    const transcript = '需要侍应新的工作。 我觉得可以。'
    const appliedPatch = patch({
      sourceStart: 2,
      sourceEnd: 4,
      sourceText: '侍应',
      replacement: '适应',
    })
    const result = projectCorrectionOntoSegments(transcript, segments, [appliedPatch])
    expect(result.status).toBe('projected')
    if (result.status !== 'projected') return
    expect(result.correctedText).toBe('需要适应新的工作。 我觉得可以。')
    expect(result.segments[0]).toMatchObject({ segmentIndex: 0, correctedText: '需要适应新的工作。', speakerId: '1', startMs: 0 })
    expect(result.segments[1]).toMatchObject({ segmentIndex: 1, correctedText: '我觉得可以。', speakerId: '2', startMs: 5_000 })
    expect(result.segments[0].diff.map((part) => part.type)).toContain('added')
    expect(result.segments.flatMap((segment) => segment.diff)
      .filter((part) => part.type !== 'removed')
      .map((part) => part.text)
      .join('')).toBe(result.correctedText)
  })

  it('degrades a cross-speaker replacement into speaker and S? display items', () => {
    const transcript = segments.map((segment) => segment.text).join('')
    const sourceStart = segments[0].text.length - 1
    const sourceEnd = segments[0].text.length + 2
    const appliedPatch = patch({
      sourceStart,
      sourceEnd,
      sourceText: transcript.slice(sourceStart, sourceEnd),
      replacement: '，我觉',
    })
    const result = projectCorrectionOntoSegments(transcript, segments, [appliedPatch])
    expect(result.status).toBe('degraded')
    if (result.status !== 'degraded') return

    expect(result.reason).toBe('patch-crosses-segment-boundary')
    expect(result.items.filter((item) => item.kind === 'speaker').map((item) => item.speakerId)).toEqual(expect.arrayContaining(['1', '2']))
    expect(result.items.find((item) => item.kind === 'uncertain')).toMatchObject({
      kind: 'uncertain',
      patchId: 'patch',
      before: { speakerId: '1', startMs: 0 },
      after: { speakerId: '2', startMs: 5_000 },
      diff: [{ type: 'added', text: '，我觉', patchId: 'patch' }],
    })
    expect(effectiveDisplayText(result)).toBe(materializeCorrection(transcript, [appliedPatch]))
  })

  it('keeps cross-speaker deletions under their original speakers and emits an empty S? marker', () => {
    const transcript = segments.map((segment) => segment.text).join('')
    const sourceStart = segments[0].text.length - 1
    const sourceEnd = segments[0].text.length + 2
    const appliedPatch = patch({
      op: 'delete',
      sourceStart,
      sourceEnd,
      sourceText: transcript.slice(sourceStart, sourceEnd),
      replacement: '',
    })
    const result = projectCorrectionOntoSegments(transcript, segments, [appliedPatch])
    expect(result.status).toBe('degraded')
    if (result.status !== 'degraded') return

    const removedBySpeaker = result.items
      .filter((item) => item.kind === 'speaker')
      .flatMap((item) => item.diff.filter((part) => part.type === 'removed').map((part) => ({ speakerId: item.speakerId, text: part.text })))
    expect(removedBySpeaker.map((part) => part.speakerId)).toEqual(['1', '2'])
    expect(removedBySpeaker.map((part) => part.text).join('')).toBe(appliedPatch.sourceText)
    expect(result.items.find((item) => item.kind === 'uncertain')).toMatchObject({ kind: 'uncertain', operation: 'delete', diff: [] })
    expect(effectiveDisplayText(result)).toBe(materializeCorrection(transcript, [appliedPatch]))
  })

  it('marks an insertion exactly on a speaker boundary as S?', () => {
    const transcript = segments.map((segment) => segment.text).join('')
    const boundary = segments[0].text.length
    const appliedPatch = patch({
      op: 'insert',
      sourceStart: boundary,
      sourceEnd: boundary,
      sourceText: '',
      replacement: '嗯，',
    })
    const result = projectCorrectionOntoSegments(transcript, segments, [appliedPatch])
    expect(result.status).toBe('degraded')
    if (result.status !== 'degraded') return
    expect(result.reason).toBe('patch-on-ambiguous-boundary')
    expect(result.items.find((item) => item.kind === 'uncertain')).toMatchObject({
      before: { speakerId: '1' },
      after: { speakerId: '2' },
      diff: [{ type: 'added', text: '嗯，', patchId: 'patch' }],
    })
    expect(effectiveDisplayText(result)).toBe(materializeCorrection(transcript, [appliedPatch]))
  })

  it('keeps both endpoint speakers in S? context when a patch spans the complete transcript', () => {
    const transcript = segments.map((segment) => segment.text).join('')
    const appliedPatch = patch({
      sourceStart: 0,
      sourceEnd: transcript.length,
      sourceText: transcript,
      replacement: '合并后的内容。',
    })
    const result = projectCorrectionOntoSegments(transcript, segments, [appliedPatch])
    expect(result.status).toBe('degraded')
    if (result.status !== 'degraded') return
    expect(result.items.find((item) => item.kind === 'uncertain')).toMatchObject({
      before: { speakerId: '1', startMs: 0 },
      after: { speakerId: '2', startMs: 5_000 },
    })
  })

  it('keeps multiple non-overlapping boundary patches in canonical order', () => {
    const threeSegments: TranscriptSegment[] = [
      { text: '甲一。', speakerId: '1', startMs: 0 },
      { text: '乙二。', speakerId: '2', startMs: 3_000 },
      { text: '丙三。', speakerId: '3', startMs: 6_000 },
    ]
    const transcript = threeSegments.map((segment) => segment.text).join('')
    const firstBoundary = threeSegments[0].text.length
    const secondBoundary = firstBoundary + threeSegments[1].text.length
    const patches = [
      patch({ id: 'first', op: 'insert', sourceStart: firstBoundary, sourceEnd: firstBoundary, replacement: '甲乙之间' }),
      patch({ id: 'second', op: 'insert', sourceStart: secondBoundary, sourceEnd: secondBoundary, replacement: '乙丙之间' }),
    ]
    const result = projectCorrectionOntoSegments(transcript, threeSegments, patches)
    expect(result.status).toBe('degraded')
    if (result.status !== 'degraded') return
    expect(result.items.filter((item) => item.kind === 'uncertain').map((item) => item.patchId)).toEqual(['first', 'second'])
    expect(effectiveDisplayText(result)).toBe(materializeCorrection(transcript, patches))
  })

  it('ignores reverted boundary patches', () => {
    const transcript = segments.map((segment) => segment.text).join('')
    const boundary = segments[0].text.length
    const result = projectCorrectionOntoSegments(transcript, segments, [patch({
      op: 'insert',
      sourceStart: boundary,
      sourceEnd: boundary,
      replacement: '不会显示',
      state: 'reverted',
    })])
    expect(result).toMatchObject({ status: 'projected', correctedText: transcript })
  })

  it('uses original speaker segments plus the complete correction when segment alignment fails', () => {
    const transcript = '未覆盖前缀需要侍应新的工作。'
    const appliedPatch = patch({ sourceStart: 0, sourceEnd: 5, sourceText: '未覆盖前缀', replacement: '完整前缀' })
    const result = projectCorrectionOntoSegments(transcript, [segments[0]], [appliedPatch])
    expect(result.status).toBe('unaligned')
    if (result.status !== 'unaligned') return
    expect(result.reason).toBe('segment-alignment-failed')
    expect(result.originalSegments[0]).toMatchObject({ speakerId: '1', startMs: 0, correctedText: segments[0].text })
    expect(result.correctedText).toBe(materializeCorrection(transcript, [appliedPatch]))
    expect(formatCorrectionProjection(result, speakers, 'markdown', 'zh')).toContain('## 完整修正稿（无法安全分段）')
  })

  it('uses the supplied complete correction when persisted patches cannot be materialized', () => {
    const expectedCorrectedText = '历史完整修正稿'
    const result = projectCorrectionOntoSegments('原始全文', [{ text: '原始全文', speakerId: '1', startMs: 0 }], [patch({
      sourceStart: 0,
      sourceEnd: 2,
      sourceText: '损坏',
      replacement: '修正',
    })], expectedCorrectedText)
    expect(result).toMatchObject({ status: 'unaligned', reason: 'projection-mismatch', correctedText: expectedCorrectedText })
    expect(result.fullDiff.filter((part) => part.type !== 'removed').map((part) => part.text).join('')).toBe(expectedCorrectedText)
  })

  it('falls back safely when overlapping persisted patches materialize but produce an inconsistent diff', () => {
    const transcript = 'abcd'
    const overlapping = [
      patch({ id: 'first', sourceStart: 0, sourceEnd: 2, sourceText: 'ab', replacement: 'X' }),
      patch({ id: 'second', sourceStart: 1, sourceEnd: 3, sourceText: 'bc', replacement: 'bY' }),
    ]
    const result = projectCorrectionOntoSegments(transcript, [{ text: transcript, speakerId: '1', startMs: 0 }], overlapping)
    expect(result).toMatchObject({ status: 'unaligned', reason: 'projection-mismatch', correctedText: 'XYd' })
    expect(result.fullDiff.filter((part) => part.type !== 'removed').map((part) => part.text).join('')).toBe('XYd')
  })

  it('uses an explicit projection mismatch fallback when stored corrected text disagrees with active patches', () => {
    const transcript = segments.map((segment) => segment.text).join('')
    const result = projectCorrectionOntoSegments(transcript, segments, [], '不同的修正稿')
    expect(result).toMatchObject({ status: 'unaligned', reason: 'projection-mismatch', correctedText: '不同的修正稿' })
  })

  it('projects legacy corrections without migration using original speakers plus the complete correction', () => {
    const transcript = segments.map((segment) => segment.text).join('')
    const result = projectSessionCorrection(transcript, segments, {
      status: 'done',
      mode: 'quick',
      correctedText: '历史修正全文',
      legacy: {
        correctedText: '历史修正全文',
        source: 'v3-corrected-text',
      },
    })
    expect(result).toMatchObject({
      status: 'unaligned',
      reason: 'projection-mismatch',
      correctedText: '历史修正全文',
      speakerIds: ['1', '2'],
    })
    expect(result && formatCorrectionProjection(result, speakers, 'markdown', 'zh')).toContain('### S1 · 主持人 · 0:00')
    expect(result && formatCorrectionProjection(result, speakers, 'markdown', 'zh')).toContain('## 完整修正稿（无法安全分段）\n\n历史修正全文')
  })

  it('keeps sessions without speaker data as plain text', () => {
    const transcript = '没有说话人信息。'
    const appliedPatch = patch({ sourceStart: 2, sourceEnd: 5, sourceText: '说话人', replacement: '发言者' })
    const result = projectCorrectionOntoSegments(transcript, [{ text: transcript }], [appliedPatch])
    expect(result).toMatchObject({
      status: 'plain-text',
      reason: 'no-speaker-segments',
      correctedText: materializeCorrection(transcript, [appliedPatch]),
    })
    expect(formatCorrectionProjection(result, [], 'txt', 'zh')).toBe(result.correctedText)
  })

  it('distinguishes an unlabeled original segment from uncertain correction ownership', () => {
    const mixedSegments: TranscriptSegment[] = [
      { text: '已标注。', speakerId: '1', startMs: 0 },
      { text: '未标注。', startMs: 4_000 },
    ]
    const result = projectCorrectionOntoSegments('已标注。未标注。', mixedSegments, [])
    expect(result.status).toBe('projected')
    expect(formatCorrectionProjection(result, speakers, 'markdown', 'zh')).toContain('### 未标注说话人 · 0:04')
    expect(formatCorrectionProjection(result, speakers, 'txt', 'en')).toContain('Unlabeled speaker\n0:04\n未标注。')
    expect(formatCorrectionProjection(result, speakers, 'txt', 'en')).not.toContain('S?')
  })

  it('formats strict, degraded, and unaligned TXT/Markdown in Chinese and English', () => {
    const strict = projectCorrectionOntoSegments('需要侍应新的工作。 我觉得可以。', segments, [])
    expect(strict.status).toBe('projected')
    expect(formatCorrectionProjection(strict, speakers, 'txt', 'zh')).toContain('S1\n主持人\n0:00\n需要侍应新的工作。')
    expect(formatCorrectionProjection(strict, speakers, 'markdown', 'en')).toContain('### S2 · 参会者 · 0:05')

    const transcript = segments.map((segment) => segment.text).join('')
    const boundary = segments[0].text.length
    const degraded = projectCorrectionOntoSegments(transcript, segments, [patch({
      op: 'insert',
      sourceStart: boundary,
      sourceEnd: boundary,
      replacement: '新增',
    })])
    expect(formatCorrectionProjection(degraded, speakers, 'markdown', 'zh')).toContain('### S? · 说话人不确定 · S1 0:00 ↔ S2 0:05')
    expect(formatCorrectionProjection(degraded, speakers, 'txt', 'en')).toContain('S?\nSpeaker uncertain\nS1 0:00 ↔ S2 0:05\n新增')

    const unaligned = projectCorrectionOntoSegments('完整原文', [{ text: '不匹配', speakerId: '1', startMs: 0 }], [])
    expect(formatCorrectionProjection(unaligned, speakers, 'txt', 'zh')).toContain('[DeLive] 原说话人分段无法与完整原文安全对应。')
    expect(formatCorrectionProjection(unaligned, speakers, 'markdown', 'en')).toContain('## Complete correction (could not be safely segmented)')
  })
})
