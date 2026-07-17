import type {
  CorrectionIssueCategory,
  CorrectionPatchSafetyLimits,
  CorrectionShardPlan,
  ModelCorrectionPatch,
  ResolvedCorrectionPatch,
} from '../types'

export const DEFAULT_CORRECTION_PATCH_LIMITS: CorrectionPatchSafetyLimits = {
  maxPatchTextLength: 1_000,
  maxPatchesPerShard: 100,
  maxCumulativeEditRatio: 0.2,
  maxNetLengthChangeRatio: 0.1,
}

export const DEFAULT_CORRECTION_CHUNK_SIZE = 4_000
export const DEFAULT_CORRECTION_CONTEXT_SIZE = 500

const VALID_OPERATIONS = new Set(['replace', 'insert', 'delete'])
const VALID_CATEGORIES = new Set<CorrectionIssueCategory>([
  'homophone',
  'proper-noun',
  'punctuation',
  'asr-substitution',
  'asr-omission',
  'asr-duplication',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractStrictJson(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('AI returned an empty response')
  if (!trimmed.startsWith('```')) return trimmed

  const match = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)
  if (!match) throw new Error('AI response contains an invalid JSON code fence')
  return match[1]
}

export function parseModelCorrectionResponse(raw: string): ModelCorrectionPatch[] {
  let value: unknown
  try {
    value = JSON.parse(extractStrictJson(raw))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AI response')) throw error
    throw new Error('AI response is not valid JSON')
  }

  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.patches)) {
    throw new Error('AI response must be an object containing only a patches array')
  }

  return value.patches.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Patch ${index + 1} must be an object`)
    const requiredKeys = ['op', 'oldText', 'replacement', 'before', 'after', 'category', 'reason']
    if (Object.keys(item).some((key) => !requiredKeys.includes(key)) || requiredKeys.some((key) => !(key in item))) {
      throw new Error(`Patch ${index + 1} has an invalid shape`)
    }
    if (!VALID_OPERATIONS.has(String(item.op))) throw new Error(`Patch ${index + 1} has an invalid operation`)
    if (!VALID_CATEGORIES.has(item.category as CorrectionIssueCategory)) {
      throw new Error(`Patch ${index + 1} has an invalid category`)
    }
    for (const key of ['oldText', 'replacement', 'before', 'after', 'reason']) {
      if (typeof item[key] !== 'string') throw new Error(`Patch ${index + 1}.${key} must be a string`)
    }
    return item as unknown as ModelCorrectionPatch
  })
}

function graphemeBoundaries(text: string): number[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment: (value: string) => Iterable<{ index: number }> } }).Segmenter
  if (!Segmenter) {
    throw new Error('Intl.Segmenter is required for grapheme-safe correction')
  }
  const result = Array.from(
    new Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    (part) => part.index,
  )
  if (result[result.length - 1] !== text.length) result.push(text.length)
  return result
}

function graphemeBoundarySet(text: string): Set<number> {
  return new Set(graphemeBoundaries(text))
}

function boundaryAtOrBefore(boundaries: number[], target: number): number {
  let low = 0
  let high = boundaries.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (boundaries[middle] <= target) low = middle + 1
    else high = middle - 1
  }
  return boundaries[Math.max(0, high)]
}

function findNaturalBoundary(text: string, start: number, target: number, boundaries: number[]): number {
  const minimum = start + Math.floor((target - start) * 0.65)
  const candidates = ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', ' ']
  for (const marker of candidates) {
    const index = text.lastIndexOf(marker, target - 1)
    if (index >= minimum) return boundaryAtOrBefore(boundaries, index + marker.length)
  }
  return boundaryAtOrBefore(boundaries, target)
}

export function createCorrectionShards(
  text: string,
  chunkSize = DEFAULT_CORRECTION_CHUNK_SIZE,
  contextSize = DEFAULT_CORRECTION_CONTEXT_SIZE,
): CorrectionShardPlan[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error('chunkSize must be a positive integer')
  if (!Number.isInteger(contextSize) || contextSize < 0) throw new Error('contextSize must be a non-negative integer')
  if (!text) return []

  const boundaries = graphemeBoundaries(text)
  const shards: CorrectionShardPlan[] = []
  let coreStart = 0
  while (coreStart < text.length) {
    const target = Math.min(text.length, coreStart + chunkSize)
    let coreEnd = target === text.length ? target : findNaturalBoundary(text, coreStart, target, boundaries)
    if (coreEnd <= coreStart) coreEnd = boundaries.find((boundary) => boundary > coreStart) ?? text.length
    const contextStart = boundaryAtOrBefore(boundaries, Math.max(0, coreStart - contextSize))
    const contextEnd = boundaries.find((boundary) => boundary >= Math.min(text.length, coreEnd + contextSize)) ?? text.length
    shards.push({
      id: `shard-${shards.length + 1}`,
      index: shards.length,
      coreStart,
      coreEnd,
      contextStart,
      contextEnd,
    })
    coreStart = coreEnd
  }
  return shards
}

export async function sha256Utf8(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function allIndices(text: string, needle: string): number[] {
  if (!needle) return []
  const indices: number[] = []
  let offset = 0
  while (offset <= text.length - needle.length) {
    const index = text.indexOf(needle, offset)
    if (index < 0) break
    indices.push(index)
    offset = index + 1
  }
  return indices
}

function rejectedPatch(
  patch: ModelCorrectionPatch,
  shard: CorrectionShardPlan,
  sourceHash: string,
  index: number,
  reason: string,
): ResolvedCorrectionPatch {
  return {
    id: `${shard.id}-patch-${index + 1}`,
    shardId: shard.id,
    op: patch.op,
    sourceStart: shard.coreStart,
    sourceEnd: shard.coreStart,
    sourceText: '',
    replacement: patch.replacement,
    sourceTextHash: sourceHash,
    category: patch.category,
    reason: patch.reason,
    state: 'rejected',
    rejectionReason: reason,
  }
}

function resolveOnePatch(
  transcript: string,
  shard: CorrectionShardPlan,
  patch: ModelCorrectionPatch,
  sourceHash: string,
  index: number,
  limits: CorrectionPatchSafetyLimits,
  boundaries: Set<number>,
): ResolvedCorrectionPatch {
  const reject = (reason: string) => rejectedPatch(patch, shard, sourceHash, index, reason)
  if (Math.max(patch.oldText.length, patch.replacement.length, patch.before.length, patch.after.length) > limits.maxPatchTextLength) {
    return reject('patch-text-limit')
  }
  if (!patch.reason.trim()) return reject('missing-reason')
  if ((patch.op === 'replace' || patch.op === 'delete') && !patch.oldText) return reject('missing-old-text')
  if (patch.op === 'insert' && !patch.replacement) return reject('missing-replacement')
  if (patch.op === 'delete' && patch.replacement) return reject('delete-has-replacement')
  if (patch.op === 'insert' && patch.oldText) return reject('insert-has-old-text')
  if (!patch.before && !patch.after) return reject('missing-anchor')
  if (patch.op === 'replace' && patch.oldText === patch.replacement) return reject('empty-operation')

  const needle = `${patch.before}${patch.oldText}${patch.after}`
  const matches = allIndices(transcript, needle).filter((start) => {
    const editStart = start + patch.before.length
    const editEnd = editStart + patch.oldText.length
    return editStart >= shard.coreStart && editEnd <= shard.coreEnd
  })
  if (matches.length === 0) return reject('anchor-not-found-or-outside-core')
  if (matches.length > 1) return reject('anchor-not-unique')

  const sourceStart = matches[0] + patch.before.length
  const sourceEnd = sourceStart + patch.oldText.length
  if (!boundaries.has(sourceStart) || !boundaries.has(sourceEnd)) {
    return reject('invalid-unicode-boundary')
  }
  if (transcript.slice(sourceStart, sourceEnd) !== patch.oldText) return reject('source-mismatch')
  return {
    id: `${shard.id}-patch-${index + 1}`,
    shardId: shard.id,
    op: patch.op,
    sourceStart,
    sourceEnd,
    sourceText: patch.oldText,
    replacement: patch.replacement,
    sourceTextHash: sourceHash,
    category: patch.category,
    reason: patch.reason,
    state: 'proposed',
  }
}

function patchesConflict(left: ResolvedCorrectionPatch, right: ResolvedCorrectionPatch): boolean {
  if (left.state === 'rejected' || right.state === 'rejected') return false
  if (left.sourceStart === left.sourceEnd && right.sourceStart === right.sourceEnd) {
    return left.sourceStart === right.sourceStart
  }
  if (left.sourceStart === left.sourceEnd) {
    return left.sourceStart >= right.sourceStart && left.sourceStart <= right.sourceEnd
  }
  if (right.sourceStart === right.sourceEnd) {
    return right.sourceStart >= left.sourceStart && right.sourceStart <= left.sourceEnd
  }
  return left.sourceStart < right.sourceEnd && right.sourceStart < left.sourceEnd
}

export interface CorrectionPatchConflictPartition {
  accepted: ResolvedCorrectionPatch[]
  rejected: ResolvedCorrectionPatch[]
  all: ResolvedCorrectionPatch[]
}

export function partitionCorrectionPatchConflicts(
  patches: ResolvedCorrectionPatch[],
): CorrectionPatchConflictPartition {
  const conflicting = new Set<number>()
  for (let left = 0; left < patches.length; left += 1) {
    for (let right = left + 1; right < patches.length; right += 1) {
      if (patchesConflict(patches[left], patches[right])) {
        conflicting.add(left)
        conflicting.add(right)
      }
    }
  }
  const all = patches.map((patch, index) => conflicting.has(index)
    ? { ...patch, state: 'rejected' as const, rejectionReason: 'patch-conflict' }
    : patch)
  return {
    accepted: all.filter((patch) => patch.state !== 'rejected'),
    rejected: all.filter((patch) => patch.state === 'rejected'),
    all,
  }
}

export function resolveCorrectionPatches(
  transcript: string,
  shard: CorrectionShardPlan,
  patches: ModelCorrectionPatch[],
  sourceHash: string,
  limits: CorrectionPatchSafetyLimits = DEFAULT_CORRECTION_PATCH_LIMITS,
): ResolvedCorrectionPatch[] {
  if (patches.length > limits.maxPatchesPerShard) {
    return patches.map((patch, index) => rejectedPatch(patch, shard, sourceHash, index, 'patch-count-limit'))
  }
  const boundaries = graphemeBoundarySet(transcript)
  const resolved = patches.map((patch, index) => resolveOnePatch(
    transcript,
    shard,
    patch,
    sourceHash,
    index,
    limits,
    boundaries,
  ))
  return partitionCorrectionPatchConflicts(resolved).all
}

function validateResolvedPatchWithBoundaries(
  transcript: string,
  patch: ResolvedCorrectionPatch,
  expectedSourceHash: string,
  limits: CorrectionPatchSafetyLimits,
  boundaries: Set<number>,
): string | null {
  if (patch.sourceTextHash !== expectedSourceHash) return 'source-hash-mismatch'
  if (patch.sourceStart < 0 || patch.sourceEnd < patch.sourceStart || patch.sourceEnd > transcript.length) return 'invalid-source-range'
  if (!boundaries.has(patch.sourceStart) || !boundaries.has(patch.sourceEnd)) return 'invalid-unicode-boundary'
  if (transcript.slice(patch.sourceStart, patch.sourceEnd) !== patch.sourceText) return 'source-mismatch'
  if (Math.max(patch.sourceText.length, patch.replacement.length) > limits.maxPatchTextLength) return 'patch-text-limit'
  if (patch.op === 'insert' && (patch.sourceText || !patch.replacement)) return 'invalid-insert'
  if (patch.op === 'delete' && (!patch.sourceText || patch.replacement)) return 'invalid-delete'
  if (patch.op === 'replace' && (!patch.sourceText || !patch.replacement || patch.sourceText === patch.replacement)) return 'invalid-replace'
  return null
}

export function validateResolvedCorrectionPatch(
  transcript: string,
  patch: ResolvedCorrectionPatch,
  expectedSourceHash: string,
  limits: CorrectionPatchSafetyLimits = DEFAULT_CORRECTION_PATCH_LIMITS,
): string | null {
  return validateResolvedPatchWithBoundaries(
    transcript,
    patch,
    expectedSourceHash,
    limits,
    graphemeBoundarySet(transcript),
  )
}

export function updateCorrectionPatchReplacement(
  transcript: string,
  patch: ResolvedCorrectionPatch,
  replacement: string,
  expectedSourceHash: string,
  limits: CorrectionPatchSafetyLimits = DEFAULT_CORRECTION_PATCH_LIMITS,
): { patch?: ResolvedCorrectionPatch; error?: string } {
  const op = patch.sourceText
    ? replacement ? 'replace' as const : 'delete' as const
    : 'insert' as const
  const nextPatch: ResolvedCorrectionPatch = {
    ...patch,
    op,
    replacement,
    state: 'proposed',
    rejectionReason: undefined,
  }
  const error = validateResolvedCorrectionPatch(
    transcript,
    nextPatch,
    expectedSourceHash,
    limits,
  )
  return error ? { error } : { patch: nextPatch }
}

export function validateCorrectionPatchSet(
  transcript: string,
  patches: ResolvedCorrectionPatch[],
  limits: CorrectionPatchSafetyLimits = DEFAULT_CORRECTION_PATCH_LIMITS,
): string | null {
  const active = patches.filter((patch) => patch.state === 'proposed' || patch.state === 'applied')
  const editedLength = active.reduce((total, patch) => total + Math.max(patch.sourceText.length, patch.replacement.length), 0)
  const netLength = active.reduce((total, patch) => total + patch.replacement.length - patch.sourceText.length, 0)
  const denominator = Math.max(1, transcript.length)
  if (editedLength / denominator > limits.maxCumulativeEditRatio) return 'cumulative-edit-ratio-limit'
  if (Math.abs(netLength) / denominator > limits.maxNetLengthChangeRatio) return 'net-length-change-ratio-limit'
  return null
}

export function materializeCorrection(transcript: string, patches: ResolvedCorrectionPatch[]): string {
  const active = patches
    .filter((patch) => patch.state === 'applied')
    .sort((left, right) => right.sourceStart - left.sourceStart || right.sourceEnd - left.sourceEnd)
  let output = transcript
  for (const patch of active) {
    if (output.slice(patch.sourceStart, patch.sourceEnd) !== patch.sourceText) {
      throw new Error(`Patch ${patch.id} does not match the canonical transcript`)
    }
    output = `${output.slice(0, patch.sourceStart)}${patch.replacement}${output.slice(patch.sourceEnd)}`
  }
  return output
}

export interface CorrectionDiffPart {
  type: 'unchanged' | 'removed' | 'added'
  text: string
  patchId?: string
}

export function buildCorrectionDiff(transcript: string, patches: ResolvedCorrectionPatch[]): CorrectionDiffPart[] {
  const active = patches
    .filter((patch) => patch.state === 'applied')
    .sort((left, right) => left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd)
  const result: CorrectionDiffPart[] = []
  let offset = 0
  for (const patch of active) {
    if (patch.sourceStart > offset) result.push({ type: 'unchanged', text: transcript.slice(offset, patch.sourceStart) })
    if (patch.sourceText) result.push({ type: 'removed', text: patch.sourceText, patchId: patch.id })
    if (patch.replacement) result.push({ type: 'added', text: patch.replacement, patchId: patch.id })
    offset = patch.sourceEnd
  }
  if (offset < transcript.length) result.push({ type: 'unchanged', text: transcript.slice(offset) })
  return result
}

export function setCorrectionPatchState(
  patches: ResolvedCorrectionPatch[],
  patchId: string,
  state: 'applied' | 'reverted',
): ResolvedCorrectionPatch[] {
  return patches.map((patch) => patch.id === patchId && patch.state !== 'rejected' ? { ...patch, state } : patch)
}

export function revertAllCorrectionPatches(patches: ResolvedCorrectionPatch[]): ResolvedCorrectionPatch[] {
  return patches.map((patch) => patch.state === 'applied' ? { ...patch, state: 'reverted' } : patch)
}
