import { describe, expect, it } from 'vitest'
import type { ModelCorrectionPatch } from '../types'
import {
  buildCorrectionDiff,
  applyManualCorrectionEdit,
  findCorrectionSourceMatches,
  CorrectionConflictError,
  createCorrectionShards,
  materializeCorrection,
  parseModelCorrectionResponse,
  partitionCorrectionPatchConflicts,
  resolveCorrectionPatches,
  revertAllCorrectionPatches,
  setCorrectionPatchState,
  sha256Utf8,
  updateCorrectionPatchReplacement,
  validateResolvedCorrectionPatch,
} from './correctionPatch'

function modelPatch(overrides: Partial<ModelCorrectionPatch> = {}): ModelCorrectionPatch {
  return {
    op: 'replace',
    oldText: '侍应',
    replacement: '适应',
    before: '需要',
    after: '新的',
    category: 'homophone',
    reason: '同音误识别',
    ...overrides,
  }
}

describe('correctionPatch response parsing', () => {
  it('accepts a strict object and a single JSON code fence', () => {
    const body = JSON.stringify({ patches: [modelPatch()] })
    expect(parseModelCorrectionResponse(body)).toHaveLength(1)
    expect(parseModelCorrectionResponse(`\`\`\`json\n${body}\n\`\`\``)).toHaveLength(1)
  })

  it('rejects loose extraction, extra top-level keys, and legacy categories', () => {
    const body = JSON.stringify({ patches: [modelPatch()] })
    expect(() => parseModelCorrectionResponse(`prefix ${body}`)).toThrow(/JSON/)
    expect(() => parseModelCorrectionResponse(JSON.stringify({ patches: [], extra: true }))).toThrow(/only/)
    expect(() => parseModelCorrectionResponse(JSON.stringify({ patches: [modelPatch({ category: 'grammar' as never })] }))).toThrow(/category/)
  })
})

describe('correctionPatch sharding', () => {
  it('covers the source exactly once and keeps context read-only', () => {
    const text = '第一段。\r\n\r\n第二段很长，需要继续。🙂e\u0301结束。'
    const shards = createCorrectionShards(text, 12, 4)
    expect(shards[0].coreStart).toBe(0)
    expect(shards[shards.length - 1]?.coreEnd).toBe(text.length)
    for (let index = 1; index < shards.length; index += 1) {
      expect(shards[index - 1].coreEnd).toBe(shards[index].coreStart)
    }
    expect(shards.every((shard) => shard.contextStart <= shard.coreStart && shard.contextEnd >= shard.coreEnd)).toBe(true)
    expect(shards.some((shard) => text.charCodeAt(shard.coreEnd - 1) >= 0xd800 && text.charCodeAt(shard.coreEnd - 1) <= 0xdbff)).toBe(false)
  })
})

describe('correctionPatch resolution and materialization', () => {
  const transcript = '我们需要侍应新的工作方式。然后需要侍应新的变化。'
  const shard = createCorrectionShards(transcript, transcript.length, 0)[0]
  const sourceHash = 'source-hash'

  it('rejects a repeated full anchor instead of choosing the first match', () => {
    const [patch] = resolveCorrectionPatches(transcript, shard, [modelPatch()], sourceHash)
    expect(patch.state).toBe('rejected')
    expect(patch.rejectionReason).toBe('anchor-not-unique')
  })

  it('resolves replace, insert, and delete with exact adjacent anchors', () => {
    const patches = resolveCorrectionPatches(transcript, shard, [
      modelPatch({ before: '我们需要', after: '新的工作' }),
      modelPatch({ op: 'insert', oldText: '', replacement: '更', before: '然后需要', after: '侍应' }),
      modelPatch({ op: 'delete', oldText: '新的', replacement: '', before: '工作方式。然后需要侍应', after: '变化。', category: 'asr-duplication' }),
    ], sourceHash)
    expect(patches.every((patch) => patch.state === 'proposed')).toBe(true)
    const applied = patches.map((patch) => ({ ...patch, state: 'applied' as const }))
    expect(materializeCorrection(transcript, applied)).toBe('我们需要适应新的工作方式。然后需要更侍应变化。')
  })

  it('rejects overlapping edits as a complete conflict group', () => {
    const patches = resolveCorrectionPatches('abcdef', createCorrectionShards('abcdef', 6, 0)[0], [
      modelPatch({ oldText: 'bcd', replacement: 'X', before: 'a', after: 'ef' }),
      modelPatch({ oldText: 'cd', replacement: 'Y', before: 'ab', after: 'ef' }),
    ], sourceHash)
    expect(patches.map((patch) => patch.rejectionReason)).toEqual(['patch-conflict', 'patch-conflict'])
  })

  it('rejects same-boundary inserts across different shards', () => {
    const left = resolveCorrectionPatches('abcd', {
      id: 'left', index: 0, coreStart: 0, coreEnd: 2, contextStart: 0, contextEnd: 4,
    }, [modelPatch({ op: 'insert', oldText: '', replacement: 'X', before: 'ab', after: 'cd', category: 'asr-omission' })], sourceHash)[0]
    const right = resolveCorrectionPatches('abcd', {
      id: 'right', index: 1, coreStart: 2, coreEnd: 4, contextStart: 0, contextEnd: 4,
    }, [modelPatch({ op: 'insert', oldText: '', replacement: 'Y', before: 'ab', after: 'cd', category: 'asr-omission' })], sourceHash)[0]
    const partition = partitionCorrectionPatchConflicts([left, right])
    expect(partition.accepted).toHaveLength(0)
    expect(partition.rejected.map((patch) => patch.rejectionReason)).toEqual(['patch-conflict', 'patch-conflict'])
  })

  it.each([
    ['e\u0301', 1, 1],
    ['👍🏽', 2, 2],
    ['👩‍💻', 2, 2],
  ])('rejects patch boundaries inside a grapheme: %s', (text, start, end) => {
    const patch = {
      id: 'manual', shardId: 's', op: 'insert' as const, sourceStart: start, sourceEnd: end,
      sourceText: '', replacement: 'X', sourceTextHash: sourceHash, category: 'asr-omission' as const,
      reason: 'test', state: 'proposed' as const,
    }
    const result = updateCorrectionPatchReplacement(text, patch, 'X', sourceHash)
    expect(result.error).toBe('invalid-unicode-boundary')
  })

  it('allows a Review replacement edit and derives delete locally', () => {
    const [resolved] = resolveCorrectionPatches(transcript, shard, [modelPatch({ before: '我们需要', after: '新的工作' })], sourceHash)
    expect(updateCorrectionPatchReplacement(transcript, resolved, '适应', sourceHash).patch).toMatchObject({ op: 'replace', replacement: '适应' })
    expect(updateCorrectionPatchReplacement(transcript, resolved, '', sourceHash).patch).toMatchObject({ op: 'delete', replacement: '' })
    expect(updateCorrectionPatchReplacement(transcript, resolved, resolved.sourceText, sourceHash).error).toBe('invalid-replace')
  })

  it('supports real diff, single revert, restore, and restore-all', () => {
    const [resolved] = resolveCorrectionPatches(transcript, shard, [modelPatch({ before: '我们需要', after: '新的工作' })], sourceHash)
    const applied = [{ ...resolved, state: 'applied' as const }]
    expect(buildCorrectionDiff(transcript, applied).map((part) => part.type)).toContain('removed')
    const reverted = setCorrectionPatchState(applied, resolved.id, 'reverted')
    expect(materializeCorrection(transcript, reverted)).toBe(transcript)
    expect(materializeCorrection(transcript, setCorrectionPatchState(reverted, resolved.id, 'applied'))).toContain('适应')
    expect(materializeCorrection(transcript, revertAllCorrectionPatches(applied))).toBe(transcript)
  })

  it('hashes the exact raw UTF-8 transcript without normalization', async () => {
    expect(await sha256Utf8('a\r\n')).not.toBe(await sha256Utf8('a\n'))
    expect(await sha256Utf8('e\u0301')).not.toBe(await sha256Utf8('é'))
  })
})

describe('manual canonical correction safety', () => {
  const transcript = '我们需要侍应新的工作方式。然后需要侍应新的变化。'
  const edit = { sourceStart: 4, sourceEnd: 6, sourceText: '侍应', replacement: '适应' }

  it('retains bounded original model intent and explicitly marks unresolved coordinates', () => {
    const [rejected] = resolveCorrectionPatches(transcript, createCorrectionShards(transcript)[0], [modelPatch()], 'hash')
    expect(rejected).toMatchObject({ state: 'rejected', origin: 'ai', locationVerified: false, modelIntent: modelPatch() })
    expect(updateCorrectionPatchReplacement(transcript, rejected, '适应', 'hash').error).toContain('manual-recovery')
    expect(validateResolvedCorrectionPatch(transcript, rejected, 'hash')).toContain('manual-recovery')
    const [bounded] = resolveCorrectionPatches(transcript, createCorrectionShards(transcript)[0], [modelPatch({ before: 'a'.repeat(1001) })], 'hash')
    expect(bounded.modelIntent?.before).toHaveLength(1000)
  })

  it('returns all repeated word locations, never chooses the first, and ignores partial graphemes', () => {
    expect(findCorrectionSourceMatches(transcript, '侍应')).toEqual([4, 17])
    expect(findCorrectionSourceMatches('e\u0301e\u0301', 'e')).toEqual([])
    expect(findCorrectionSourceMatches('👍🏽👍🏽', '👍')).toEqual([])
    expect(findCorrectionSourceMatches('👩‍💻👩‍💻', '👩‍💻')).toEqual([0, 5])
  })

  it('supports canonical replacement, deletion and explicit insertion without modifying input patches', () => {
    const next = applyManualCorrectionEdit(transcript, [], edit, 'hash', 'manual', 'applied')
    expect(next[0]).toMatchObject({ origin: 'manual', locationVerified: true, op: 'replace' })
    const deleted = applyManualCorrectionEdit(transcript, next, { ...edit, patchId: 'manual', replacement: '' }, 'hash', 'ignored', 'applied')
    expect(deleted).toHaveLength(1)
    expect(deleted[0].op).toBe('delete')
    expect(next[0].replacement).toBe('适应')
    const inserted = applyManualCorrectionEdit(transcript, [], { sourceStart: 0, sourceEnd: 0, sourceText: '', replacement: '今天' }, 'hash', 'insert', 'applied')
    expect(materializeCorrection(transcript, inserted)).toBe(`今天${transcript}`)
  })

  it.each([
    [{ ...edit, replacement: '侍应' }, 'invalid-replace'],
    [{ ...edit, sourceText: 'wrong' }, 'source-mismatch'],
    [{ ...edit, sourceStart: -1 }, 'invalid-source-range'],
    [{ ...edit, sourceEnd: 4.5 }, 'invalid-source-range'],
    [{ ...edit, replacement: 'x'.repeat(1001) }, 'patch-text-limit'],
  ])('rejects invalid manual edits before changing the set', (input, error) => {
    expect(() => applyManualCorrectionEdit(transcript, [], input, 'hash', 'm', 'applied')).toThrow(error)
  })

  it('rejects split emoji, aggregate/net safety excess and stale hashes', () => {
    expect(() => applyManualCorrectionEdit('a👍🏽'.repeat(10), [], { sourceStart: 2, sourceEnd: 2, sourceText: '', replacement: 'x' }, 'hash', 'm', 'applied')).toThrow('invalid-unicode-boundary')
    expect(() => applyManualCorrectionEdit('abcd', [], { sourceStart: 0, sourceEnd: 2, sourceText: 'ab', replacement: 'xy' }, 'hash', 'm', 'applied')).toThrow('cumulative-edit-ratio-limit')
    expect(() => applyManualCorrectionEdit('a'.repeat(20), [], { sourceStart: 0, sourceEnd: 0, sourceText: '', replacement: 'xyz' }, 'hash', 'm', 'applied')).toThrow('net-length-change-ratio-limit')
    const next = applyManualCorrectionEdit(transcript, [], edit, 'hash', 'm', 'applied')
    expect(() => applyManualCorrectionEdit(transcript, next, { sourceStart: 17, sourceEnd: 19, sourceText: '侍应', replacement: '适应' }, 'new-hash', 'n', 'applied')).toThrow('source-hash-mismatch')
  })

  it('keeps reliably located conflict rejections distinct from historical placeholders and links manual recovery once', () => {
    const [resolved] = resolveCorrectionPatches(transcript, createCorrectionShards(transcript)[0], [modelPatch({ before: '我们需要', after: '新的工作' })], 'hash')
    const rejected = { ...resolved, state: 'rejected' as const, rejectionReason: 'patch-conflict' }
    expect(rejected.locationVerified).toBe(true)
    const recovered = applyManualCorrectionEdit(transcript, [rejected], { ...edit, recoveredFromPatchId: rejected.id }, 'hash', 'm', 'applied')
    expect(recovered[0]).toBe(rejected)
    expect(recovered[1].recoveredFromPatchId).toBe(rejected.id)
    expect(() => applyManualCorrectionEdit(transcript, recovered, { ...edit, recoveredFromPatchId: rejected.id }, 'hash', 'n', 'applied')).toThrow('already-recovered')
  })

  it('cancels conflicts without mutation and atomically reverts exact confirmed conflicts on retry', () => {
    const next = applyManualCorrectionEdit(transcript, [], edit, 'hash', 'm', 'applied')
    const conflict = { sourceStart: 3, sourceEnd: 6, sourceText: '要侍应', replacement: '要适应' }
    expect(() => applyManualCorrectionEdit(transcript, next, conflict, 'hash', 'n', 'applied')).toThrow(CorrectionConflictError)
    expect(next[0].state).toBe('applied')
    const confirmed = applyManualCorrectionEdit(transcript, next, { ...conflict, confirmedConflictIds: ['m'] }, 'hash', 'n', 'applied')
    expect(confirmed.map((patch) => patch.state)).toEqual(['reverted', 'applied'])
    expect(materializeCorrection(transcript, confirmed)).toContain('要适应')
    const sameRange = applyManualCorrectionEdit(transcript, next, { ...edit, replacement: '适配' }, 'hash', 'other', 'applied')
    expect(sameRange).toHaveLength(1)
    expect(sameRange[0].id).toBe('m')
  })
  it('rechecks the hash and original text before trusting a verified rejection or existing edit range', () => {
    const [resolved] = resolveCorrectionPatches(transcript, createCorrectionShards(transcript)[0], [modelPatch({ before: '我们需要', after: '新的工作' })], 'hash')
    const rejected = { ...resolved, state: 'rejected' as const, rejectionReason: 'patch-conflict' }
    expect(() => applyManualCorrectionEdit(transcript, [{ ...rejected, sourceTextHash: 'expired' }], { ...edit, recoveredFromPatchId: rejected.id }, 'hash', 'm', 'applied')).toThrow('source-hash-mismatch')
    expect(() => applyManualCorrectionEdit(transcript, [{ ...rejected, sourceText: 'wrong' }], { ...edit, recoveredFromPatchId: rejected.id }, 'hash', 'm', 'applied')).toThrow('source-mismatch')
    expect(() => applyManualCorrectionEdit(transcript, [{ ...resolved, sourceTextHash: 'expired' }], { ...edit, patchId: resolved.id }, 'hash', 'm', 'applied')).toThrow('source-hash-mismatch')
  })
})
