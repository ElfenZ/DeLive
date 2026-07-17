import type {
  CorrectionIssue,
  CorrectionConfigSnapshot,
  CorrectionPatchSafetyLimits,
  CorrectionShardProgress,
  ResolvedCorrectionPatch,
  TranscriptAskTurn,
  TranscriptChapter,
  TranscriptCorrection,
  TranscriptCorrectionDraft,
  TranscriptCorrectionLegacy,
  TranscriptCorrectionPublished,
  TranscriptCorrectionStatus,
  TranscriptMindMap,
  TranscriptPostProcess,
  TranscriptQaCitation,
  TranscriptSegment,
  TranscriptSession,
  TranscriptSessionStatus,
  TranscriptSourceMeta,
  TranscriptSpeaker,
  TranscriptTokenData,
  TranscriptTranslationData,
  TranscriptTextSourceMetadata,
} from '../types'
import { formatDate, formatTime, generateId } from './storageUtils'

export const CURRENT_SESSION_SCHEMA_VERSION = 4
const DEFAULT_SESSION_STATUS: TranscriptSessionStatus = 'completed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function normalizeTranslationData(value: unknown): TranscriptTranslationData | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const text = getString(value.text)?.trim()
  if (!text) {
    return undefined
  }

  const mode = value.mode === 'inline' || value.mode === 'dual-line' || value.mode === 'output-only'
    ? value.mode
    : undefined

  return {
    text,
    targetLanguage: getString(value.targetLanguage),
    mode,
    updatedAt: getNumber(value.updatedAt),
  }
}

function normalizeSpeaker(value: unknown): TranscriptSpeaker | null {
  if (!isRecord(value)) {
    return null
  }

  const id = getString(value.id)?.trim()
  if (!id) {
    return null
  }

  return {
    id,
    label: getString(value.label)?.trim() || id,
    displayName: getString(value.displayName)?.trim() || undefined,
  }
}

function normalizeSegment(value: unknown): TranscriptSegment | null {
  if (!isRecord(value)) {
    return null
  }

  const text = getString(value.text)
  if (!text) {
    return null
  }

  return {
    text,
    translatedText: getString(value.translatedText),
    startMs: getNumber(value.startMs),
    endMs: getNumber(value.endMs),
    speakerId: getString(value.speakerId),
    language: getString(value.language),
    isFinal: typeof value.isFinal === 'boolean' ? value.isFinal : undefined,
  }
}

function normalizeToken(value: unknown): TranscriptTokenData | null {
  if (!isRecord(value)) {
    return null
  }

  const text = getString(value.text)
  if (!text) {
    return null
  }

  return {
    text,
    isFinal: typeof value.isFinal === 'boolean' ? value.isFinal : undefined,
    startMs: getNumber(value.startMs),
    endMs: getNumber(value.endMs),
    speaker: getString(value.speaker),
    language: getString(value.language),
    confidence: getNumber(value.confidence),
  }
}

function normalizeSourceMeta(value: unknown): TranscriptSourceMeta | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const captureMode = value.captureMode === 'system-audio'
    || value.captureMode === 'microphone'
    || value.captureMode === 'file'
    || value.captureMode === 'mixed'
    || value.captureMode === 'unknown'
    ? value.captureMode
    : undefined

  const platform = value.platform === 'win32'
    || value.platform === 'darwin'
    || value.platform === 'linux'
    || value.platform === 'unknown'
    ? value.platform
    : undefined

  const providerMode = value.providerMode === 'realtime'
    || value.providerMode === 'full-session-retranscription'
    || value.providerMode === 'local-runtime'
    || value.providerMode === 'unknown'
    ? value.providerMode
    : undefined

  const sourceKind = value.sourceKind === 'recording-audio'
    || value.sourceKind === 'uploaded-audio'
    ? value.sourceKind
    : undefined

  const captureAudioSource = value.captureAudioSource === 'system'
    || value.captureAudioSource === 'microphone'
    || value.captureAudioSource === 'mixed'
    ? value.captureAudioSource
    : undefined

  const audioPath = getString(value.audioPath)?.trim()
  const audioMimeType = getString(value.audioMimeType)?.trim()
  const audioFileName = getString(value.audioFileName)?.trim()
  const audioSize = getNumber(value.audioSize)

  if (
    !captureMode
    && !platform
    && !providerMode
    && !getString(value.sourceId)
    && !getString(value.sourceLabel)
    && !sourceKind
    && !audioPath
    && !audioMimeType
    && !audioFileName
    && !audioSize
    && !captureAudioSource
  ) {
    return undefined
  }

  return {
    captureMode,
    sourceId: getString(value.sourceId),
    sourceLabel: getString(value.sourceLabel),
    platform,
    providerMode,
    sourceKind,
    audioPath: audioPath || undefined,
    audioMimeType: audioMimeType || undefined,
    audioFileName: audioFileName || undefined,
    audioSize,
    captureAudioSource,
  }
}

function normalizeTextSource(value: Record<string, unknown>): TranscriptTextSourceMetadata {
  const sourceKind = value.sourceKind === 'original' || value.sourceKind === 'published-correction'
    || value.sourceKind === 'legacy-correction' || value.sourceKind === 'legacy-unknown'
    ? value.sourceKind
    : undefined
  return {
    sourceKind,
    sourceTextHash: getString(value.sourceTextHash),
    sourceResultId: getString(value.sourceResultId),
  }
}

function normalizeChapter(value: unknown): TranscriptChapter | null {
  if (!isRecord(value)) {
    return null
  }

  const title = getString(value.title)?.trim()
  if (!title) {
    return null
  }

  return {
    title,
    startMs: getNumber(value.startMs),
    endMs: getNumber(value.endMs),
    summary: getString(value.summary),
  }
}

function normalizeQaCitation(value: unknown): TranscriptQaCitation | null {
  if (!isRecord(value)) {
    return null
  }

  const quote = getString(value.quote)?.trim()
  if (!quote) {
    return null
  }

  return {
    quote,
    speakerLabel: getString(value.speakerLabel)?.trim() || undefined,
  }
}

function normalizeAskTurn(value: unknown): TranscriptAskTurn | null {
  if (!isRecord(value)) {
    return null
  }

  const id = getString(value.id)?.trim()
  const question = getString(value.question)?.trim()
  if (!id || !question) {
    return null
  }

  const status = value.status === 'pending'
    || value.status === 'success'
    || value.status === 'error'
    ? value.status
    : 'success'
  const citations = Array.isArray(value.citations)
    ? value.citations
      .map(normalizeQaCitation)
      .filter((citation): citation is TranscriptQaCitation => citation !== null)
    : undefined
  const answer = getString(value.answer)?.trim() || undefined
  const source = normalizeTextSource(value)
  if (!source.sourceKind && status === 'success' && answer) source.sourceKind = 'legacy-unknown'

  return {
    id,
    conversationId: getString(value.conversationId)?.trim() || undefined,
    question,
    answer,
    citations: citations && citations.length > 0 ? citations : undefined,
    createdAt: getNumber(value.createdAt) ?? Date.now(),
    answeredAt: getNumber(value.answeredAt),
    model: getString(value.model)?.trim() || undefined,
    status,
    error: getString(value.error)?.trim() || undefined,
    ...source,
  }
}

function normalizeMindMap(value: unknown): TranscriptMindMap | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const markdown = getString(value.markdown)?.trim()
  const title = getString(value.title)?.trim()
  const generatedAt = getNumber(value.generatedAt)
  const requestedAt = getNumber(value.requestedAt)
  const updatedAt = getNumber(value.updatedAt)
  const model = getString(value.model)?.trim()
  const status = value.status === 'pending'
    || value.status === 'success'
    || value.status === 'error'
    ? value.status
    : undefined
  const error = getString(value.error)?.trim()
  const source = normalizeTextSource(value)
  if (!source.sourceKind && markdown) source.sourceKind = 'legacy-unknown'

  if (!markdown && !title && !generatedAt && !requestedAt && !updatedAt && !model && !status && !error) {
    return undefined
  }

  return {
    markdown: markdown || '',
    title: title || undefined,
    generatedAt,
    requestedAt,
    updatedAt,
    model,
    status,
    error: error || undefined,
    ...source,
  }
}

function normalizePostProcess(value: unknown): TranscriptPostProcess | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const summary = getString(value.summary)?.trim()
  const actionItems = normalizeStringArray(value.actionItems)
  const keywords = normalizeStringArray(value.keywords)
  const titleSuggestion = getString(value.titleSuggestion)?.trim()
  const tagSuggestions = normalizeStringArray(value.tagSuggestions)
  const chapters = Array.isArray(value.chapters)
    ? value.chapters
      .map(normalizeChapter)
      .filter((chapter): chapter is TranscriptChapter => chapter !== null)
    : undefined
  const generatedAt = getNumber(value.generatedAt)
  const requestedAt = getNumber(value.requestedAt)
  const model = getString(value.model)
  const status = value.status === 'pending'
    || value.status === 'success'
    || value.status === 'error'
    ? value.status
    : undefined
  const error = getString(value.error)?.trim()
  const hasGeneratedContent = Boolean(summary || actionItems.length || keywords.length || titleSuggestion || tagSuggestions.length || chapters?.length)
  const source = normalizeTextSource(value)
  if (!source.sourceKind && hasGeneratedContent) source.sourceKind = 'legacy-unknown'

  if (
    !summary
    && actionItems.length === 0
    && keywords.length === 0
    && !titleSuggestion
    && tagSuggestions.length === 0
    && (!chapters || chapters.length === 0)
    && !model
    && !generatedAt
    && !requestedAt
    && !status
    && !error
  ) {
    return undefined
  }

  return {
    summary,
    actionItems: actionItems.length > 0 ? actionItems : undefined,
    keywords: keywords.length > 0 ? keywords : undefined,
    titleSuggestion,
    tagSuggestions: tagSuggestions.length > 0 ? tagSuggestions : undefined,
    chapters: chapters && chapters.length > 0 ? chapters : undefined,
    generatedAt,
    requestedAt,
    model,
    status,
    error,
    ...source,
  }
}

const VALID_CORRECTION_STATUSES = new Set<TranscriptCorrectionStatus>([
  'idle', 'detecting', 'reviewing', 'correcting', 'done', 'error',
])
const VALID_LEGACY_CORRECTION_CATEGORIES = new Set([
  'homophone', 'proper-noun', 'grammar', 'punctuation', 'other',
  'asr-substitution', 'asr-omission', 'asr-duplication',
])
const VALID_PATCH_CATEGORIES = new Set([
  'homophone', 'proper-noun', 'punctuation', 'asr-substitution', 'asr-omission', 'asr-duplication',
])

function normalizeCorrectionIssue(raw: unknown): CorrectionIssue | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const id = getString(obj.id)
  const originalText = getString(obj.originalText)
  const suggestedText = getString(obj.suggestedText)
  const reason = getString(obj.reason) ?? ''
  const category = getString(obj.category)
  if (!id || !originalText || !suggestedText || !category || !VALID_LEGACY_CORRECTION_CATEGORIES.has(category)) return null
  return {
    id,
    segmentIndex: getNumber(obj.segmentIndex),
    originalText,
    suggestedText,
    reason,
    accepted: typeof obj.accepted === 'boolean' ? obj.accepted : undefined,
    category: category as CorrectionIssue['category'],
  }
}

function normalizeResolvedPatch(raw: unknown): ResolvedCorrectionPatch | null {
  if (!isRecord(raw)) return null
  const id = getString(raw.id)
  const shardId = getString(raw.shardId)
  const op = raw.op === 'replace' || raw.op === 'insert' || raw.op === 'delete' ? raw.op : undefined
  const sourceStart = getNumber(raw.sourceStart)
  const sourceEnd = getNumber(raw.sourceEnd)
  const sourceText = getString(raw.sourceText)
  const replacement = getString(raw.replacement)
  const sourceTextHash = getString(raw.sourceTextHash)
  const category = getString(raw.category)
  const reason = getString(raw.reason)
  const state = raw.state === 'proposed' || raw.state === 'applied' || raw.state === 'reverted' || raw.state === 'rejected'
    ? raw.state
    : undefined
  if (!id || !shardId || !op || sourceStart === undefined || sourceEnd === undefined || sourceStart < 0 || sourceEnd < sourceStart
    || sourceText === undefined || replacement === undefined || !sourceTextHash || !category
    || !VALID_PATCH_CATEGORIES.has(category) || reason === undefined || !state) return null
  if (state !== 'rejected') {
    if (sourceEnd - sourceStart !== sourceText.length) return null
    if (op === 'insert' && (sourceText || !replacement || sourceStart !== sourceEnd)) return null
    if (op === 'delete' && (!sourceText || replacement || sourceStart === sourceEnd)) return null
    if (op === 'replace' && (!sourceText || !replacement || sourceText === replacement || sourceStart === sourceEnd)) return null
  }
  return {
    id,
    shardId,
    op,
    sourceStart,
    sourceEnd,
    sourceText,
    replacement,
    sourceTextHash,
    category: category as ResolvedCorrectionPatch['category'],
    reason,
    state,
    rejectionReason: getString(raw.rejectionReason),
  }
}

function normalizePatchArrayStrict(value: unknown): ResolvedCorrectionPatch[] | null {
  if (!Array.isArray(value)) return null
  const normalized = value.map(normalizeResolvedPatch).filter((patch): patch is ResolvedCorrectionPatch => patch !== null)
  return normalized.length === value.length ? normalized : null
}

function normalizeSafetyLimits(value: unknown): CorrectionPatchSafetyLimits | null {
  if (!isRecord(value)) return null
  const maxPatchTextLength = getNumber(value.maxPatchTextLength)
  const maxPatchesPerShard = getNumber(value.maxPatchesPerShard)
  const maxCumulativeEditRatio = getNumber(value.maxCumulativeEditRatio)
  const maxNetLengthChangeRatio = getNumber(value.maxNetLengthChangeRatio)
  if (!maxPatchTextLength || !maxPatchesPerShard || maxCumulativeEditRatio === undefined || maxNetLengthChangeRatio === undefined) return null
  return { maxPatchTextLength, maxPatchesPerShard, maxCumulativeEditRatio, maxNetLengthChangeRatio }
}

function normalizeCorrectionConfig(value: unknown): CorrectionConfigSnapshot | null {
  if (!isRecord(value)) return null
  const model = getString(value.model)
  const baseUrl = getString(value.baseUrl)
  const promptLanguage = value.promptLanguage === 'en' ? 'en' : value.promptLanguage === 'zh' ? 'zh' : undefined
  const structuredOutput = value.structuredOutput === 'prompt-json' || value.structuredOutput === 'json_object' || value.structuredOutput === 'json_schema'
    ? value.structuredOutput
    : undefined
  const safetyLimits = normalizeSafetyLimits(value.safetyLimits)
  const chunkSize = getNumber(value.chunkSize)
  const contextSize = getNumber(value.contextSize)
  const concurrency = getNumber(value.concurrency)
  if (!model || !baseUrl || !promptLanguage || !structuredOutput || !safetyLimits || !chunkSize
    || contextSize === undefined || !concurrency || value.credentialRef !== 'ai-post-process') return null
  const glossary = Array.isArray(value.glossary)
    ? value.glossary.filter(isRecord).flatMap((entry) => {
      const id = getString(entry.id)
      const source = getString(entry.source)
      const target = getString(entry.target)
      return id && source && target ? [{ id, source, target, note: getString(entry.note), enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined }] : []
    })
    : []
  return {
    model,
    baseUrl,
    promptLanguage,
    promptVersion: getString(value.promptVersion) || 'patch-v1',
    schemaVersion: getString(value.schemaVersion) || '1',
    structuredOutput,
    temperature: getNumber(value.temperature) ?? 0.1,
    glossary,
    chunkSize,
    contextSize,
    concurrency,
    safetyLimits,
    credentialRef: 'ai-post-process',
  }
}

function normalizeShard(value: unknown): CorrectionShardProgress | null {
  if (!isRecord(value)) return null
  const id = getString(value.id)
  const index = getNumber(value.index)
  const coreStart = getNumber(value.coreStart)
  const coreEnd = getNumber(value.coreEnd)
  const contextStart = getNumber(value.contextStart)
  const contextEnd = getNumber(value.contextEnd)
  const status = value.status === 'pending' || value.status === 'running' || value.status === 'retrying'
    || value.status === 'completed' || value.status === 'failed' ? value.status : undefined
  const attempt = getNumber(value.attempt)
  const draftRevision = getNumber(value.draftRevision)
  const patches = value.patches === undefined ? undefined : normalizePatchArrayStrict(value.patches)
  const rejectedPatches = value.rejectedPatches === undefined ? undefined : normalizePatchArrayStrict(value.rejectedPatches)
  if (!id || index === undefined || coreStart === undefined || coreEnd === undefined || contextStart === undefined
    || contextEnd === undefined || coreStart < contextStart || coreEnd < coreStart || contextEnd < coreEnd
    || !status || attempt === undefined || draftRevision === undefined || patches === null || rejectedPatches === null) return null
  return {
    id,
    index,
    coreStart,
    coreEnd,
    contextStart,
    contextEnd,
    status,
    attempt,
    attemptId: getString(value.attemptId),
    draftRevision,
    patches,
    rejectedPatches,
    nextRetryAt: getNumber(value.nextRetryAt),
    errorCode: getString(value.errorCode),
    error: getString(value.error),
    completedAt: getNumber(value.completedAt),
  }
}

function normalizeDraft(value: unknown): TranscriptCorrectionDraft | undefined {
  if (!isRecord(value)) return undefined
  const runId = getString(value.runId)
  const revision = getNumber(value.revision)
  const trigger = value.trigger === 'manual-quick' || value.trigger === 'manual-review' || value.trigger === 'automatic'
    ? value.trigger : undefined
  const mode = value.mode === 'quick' || value.mode === 'review' ? value.mode : undefined
  const status = value.status === 'queued' || value.status === 'running' || value.status === 'paused'
    || value.status === 'retrying' || value.status === 'blocked-auth' || value.status === 'failed'
    || value.status === 'ready-for-review' ? value.status : undefined
  const baseTranscriptHash = getString(value.baseTranscriptHash)
  const config = normalizeCorrectionConfig(value.config)
  const requestedAt = getNumber(value.requestedAt)
  const updatedAt = getNumber(value.updatedAt)
  const proposedPatches = normalizePatchArrayStrict(value.proposedPatches)
  const rejectedPatches = normalizePatchArrayStrict(value.rejectedPatches)
  if (!runId || revision === undefined || !trigger || !mode || !status || !baseTranscriptHash || !config
    || !Array.isArray(value.shards) || requestedAt === undefined || updatedAt === undefined
    || proposedPatches === null || rejectedPatches === null) return undefined
  const shards = value.shards.map(normalizeShard).filter((shard): shard is CorrectionShardProgress => shard !== null)
  if (shards.length !== value.shards.length) return undefined
  return {
    runId,
    revision,
    trigger,
    mode,
    status,
    baseTranscriptHash,
    pauseRequested: typeof value.pauseRequested === 'boolean' ? value.pauseRequested : undefined,
    config,
    shards,
    proposedPatches,
    rejectedPatches,
    requestedAt,
    updatedAt,
    errorCode: getString(value.errorCode),
    error: getString(value.error),
  }
}

function normalizePublished(value: unknown): TranscriptCorrectionPublished | undefined {
  if (!isRecord(value) || value.formatVersion !== 1) return undefined
  const id = getString(value.id)
  const revision = getNumber(value.revision)
  const baseTranscriptHash = getString(value.baseTranscriptHash)
  const outputTextHash = getString(value.outputTextHash)
  const correctedText = getString(value.correctedText)
  const model = getString(value.model)
  const completedAt = getNumber(value.completedAt)
  const patches = normalizePatchArrayStrict(value.patches)
  const stats = isRecord(value.stats) ? value.stats : undefined
  const applied = stats ? getNumber(stats.applied) : undefined
  const reverted = stats ? getNumber(stats.reverted) : undefined
  const rejected = stats ? getNumber(stats.rejected) : undefined
  if (!id || revision === undefined || !baseTranscriptHash || !outputTextHash || correctedText === undefined
    || !model || completedAt === undefined || !patches || applied === undefined || reverted === undefined || rejected === undefined) return undefined
  return { id, formatVersion: 1, revision, baseTranscriptHash, outputTextHash, correctedText, model, completedAt, patches, stats: { applied, reverted, rejected } }
}

function normalizeLegacy(value: unknown): TranscriptCorrectionLegacy | undefined {
  if (!isRecord(value) || value.source !== 'v3-corrected-text') return undefined
  const correctedText = getString(value.correctedText)
  if (!correctedText) return undefined
  const issues = Array.isArray(value.issues)
    ? value.issues.map(normalizeCorrectionIssue).filter((issue): issue is CorrectionIssue => issue !== null)
    : undefined
  return {
    correctedText,
    source: 'v3-corrected-text',
    model: getString(value.model),
    completedAt: getNumber(value.completedAt),
    interrupted: typeof value.interrupted === 'boolean' ? value.interrupted : undefined,
    issues: issues?.length ? issues : undefined,
  }
}

function normalizeCorrection(raw: unknown): TranscriptCorrection | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const statusStr = getString(obj.status)
  const status: TranscriptCorrectionStatus =
    statusStr && VALID_CORRECTION_STATUSES.has(statusStr as TranscriptCorrectionStatus)
      ? (statusStr as TranscriptCorrectionStatus)
      : 'idle'
  const mode = getString(obj.mode) === 'review' ? 'review' as const : 'quick' as const
  const correctedText = getString(obj.correctedText)
  const issues = Array.isArray(obj.issues)
    ? obj.issues.map(normalizeCorrectionIssue).filter((i): i is CorrectionIssue => i !== null)
    : undefined
  const published = normalizePublished(obj.published)
  const draft = normalizeDraft(obj.draft)
  const explicitLegacy = normalizeLegacy(obj.legacy)
  const hadDraftPayload = obj.draft !== undefined
  const corruptedDraft = hadDraftPayload && !draft
  const wasLegacyInProgress = !hadDraftPayload && (status === 'detecting' || status === 'correcting')
  const legacy = explicitLegacy || (correctedText ? {
    correctedText,
    source: 'v3-corrected-text' as const,
    model: getString(obj.model),
    completedAt: getNumber(obj.completedAt),
    interrupted: wasLegacyInProgress || undefined,
    issues: issues?.length ? issues : undefined,
  } : undefined)
  const effectiveText = published?.correctedText || legacy?.correctedText
  const effectiveStatus: TranscriptCorrectionStatus = published || legacy ? 'done' : draft
    ? draft.status === 'ready-for-review' ? 'reviewing' : draft.status === 'failed' || draft.status === 'blocked-auth' ? 'error' : 'detecting'
    : wasLegacyInProgress || corruptedDraft ? 'error' : status

  if (effectiveStatus === 'idle' && !effectiveText && !draft && (!issues || issues.length === 0)) {
    return undefined
  }

  return {
    status: effectiveStatus,
    mode,
    correctedText: effectiveText || undefined,
    issues: issues && issues.length > 0 ? issues : undefined,
    model: getString(obj.model) || undefined,
    requestedAt: getNumber(obj.requestedAt),
    completedAt: getNumber(obj.completedAt),
    error: corruptedDraft
      ? 'Correction draft was invalid and has been discarded'
      : wasLegacyInProgress ? 'Legacy correction was interrupted' : getString(obj.error) || draft?.error || undefined,
    published,
    legacy,
    draft,
  }
}

export function normalizeTranscriptSession(session: Partial<TranscriptSession>): TranscriptSession {
  const createdAt = getNumber(session.createdAt) ?? Date.now()
  const updatedAt = getNumber(session.updatedAt) ?? createdAt
  const title = getString(session.title)?.trim() || `Transcript ${formatTime(createdAt)}`
  const tokens = Array.isArray(session.tokens)
    ? session.tokens
      .map(normalizeToken)
      .filter((token): token is TranscriptTokenData => token !== null)
    : undefined
  const speakers = Array.isArray(session.speakers)
    ? session.speakers
      .map(normalizeSpeaker)
      .filter((speaker): speaker is TranscriptSpeaker => speaker !== null)
    : undefined
  const segments = Array.isArray(session.segments)
    ? session.segments
      .map(normalizeSegment)
      .filter((segment): segment is TranscriptSegment => segment !== null)
    : undefined
  const askHistory = Array.isArray(session.askHistory)
    ? session.askHistory
      .map(normalizeAskTurn)
      .filter((turn): turn is TranscriptAskTurn => turn !== null)
    : undefined
  const status = session.status === 'recording' || session.status === 'interrupted' || session.status === 'completed'
    ? session.status
    : DEFAULT_SESSION_STATUS

  return {
    id: getString(session.id)?.trim() || generateId(),
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    title,
    date: getString(session.date)?.trim() || formatDate(createdAt),
    time: getString(session.time)?.trim() || formatTime(createdAt),
    createdAt,
    updatedAt,
    transcript: getString(session.transcript) || '',
    translatedTranscript: normalizeTranslationData(session.translatedTranscript),
    duration: getNumber(session.duration),
    topicId: getString(session.topicId)?.trim() || undefined,
    tagIds: normalizeStringArray(session.tagIds),
    tokens: tokens && tokens.length > 0 ? tokens : undefined,
    speakers: speakers ?? [],
    segments: segments ?? [],
    sourceMeta: normalizeSourceMeta(session.sourceMeta),
    postProcess: normalizePostProcess(session.postProcess),
    askHistory: askHistory && askHistory.length > 0 ? askHistory : undefined,
    mindMap: normalizeMindMap(session.mindMap),
    correction: normalizeCorrection(session.correction),
    providerId: getString(session.providerId),
    status,
    lastPersistedAt: getNumber(session.lastPersistedAt) ?? updatedAt,
    wasInterrupted: typeof session.wasInterrupted === 'boolean' ? session.wasInterrupted : undefined,
  }
}

export function normalizeTranscriptSessions(sessions: TranscriptSession[]): TranscriptSession[] {
  return sessions.map(normalizeTranscriptSession)
}

export function upgradeTranscriptSessions(sessions: TranscriptSession[]): {
  sessions: TranscriptSession[]
  changed: boolean
} {
  const normalizedSessions = normalizeTranscriptSessions(sessions)
  const changed = normalizedSessions.some((session, index) => (
    JSON.stringify(session) !== JSON.stringify(sessions[index])
  ))

  return {
    sessions: normalizedSessions,
    changed,
  }
}
