import type {
  AiGlossaryEntry,
  MeetingContextConfig,
  MeetingContextOverride,
  MeetingContextSnapshot,
} from '../types'

export const MEETING_CONTEXT_SCHEMA_VERSION = 1 as const
export const MAX_MEETING_BACKGROUND_CODE_POINTS = 4_000
export const MAX_CORRECTION_GUIDANCE_CODE_POINTS = 2_000
export const MAX_GLOSSARY_ENTRIES = 100
export const MAX_GLOSSARY_SOURCE_CODE_POINTS = 200
export const MAX_GLOSSARY_TARGET_CODE_POINTS = 200
export const MAX_GLOSSARY_NOTE_CODE_POINTS = 500
export const MAX_GLOSSARY_SERIALIZED_CHARACTERS = 8_000
export const MAX_SONIOX_CONTEXT_CHARACTERS = 10_000

export const DEFAULT_MEETING_CONTEXT: MeetingContextConfig = {
  background: '',
  correctionGuidance: '',
  useForAiCorrection: true,
  useForSoniox: false,
}

export interface NormalizationResult<T> {
  value: T
  errors: string[]
}

export class MeetingContextValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('\n'))
    this.name = 'MeetingContextValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function unicodeCodePointLength(value: string): number {
  return Array.from(value).length
}

function normalizedText(
  value: unknown,
  maxCodePoints: number,
  field: string,
  errors: string[],
): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`)
    return ''
  }
  const trimmed = value.trim()
  if (unicodeCodePointLength(trimmed) > maxCodePoints) {
    errors.push(`${field} exceeds ${maxCodePoints} Unicode code points`)
    return ''
  }
  return trimmed
}

export function normalizeMeetingContextConfig(value: unknown): NormalizationResult<MeetingContextConfig> {
  const record = isRecord(value) ? value : {}
  const errors: string[] = []
  return {
    value: {
      background: normalizedText(
        record.background,
        MAX_MEETING_BACKGROUND_CODE_POINTS,
        'Meeting background',
        errors,
      ),
      correctionGuidance: normalizedText(
        record.correctionGuidance,
        MAX_CORRECTION_GUIDANCE_CODE_POINTS,
        'Correction guidance',
        errors,
      ),
      useForAiCorrection: typeof record.useForAiCorrection === 'boolean'
        ? record.useForAiCorrection
        : DEFAULT_MEETING_CONTEXT.useForAiCorrection,
      useForSoniox: typeof record.useForSoniox === 'boolean'
        ? record.useForSoniox
        : DEFAULT_MEETING_CONTEXT.useForSoniox,
    },
    errors,
  }
}

export interface NormalizeGlossaryOptions {
  includeDisabled?: boolean
}

export function normalizeGlossaryEntries(
  value: unknown,
  options: NormalizeGlossaryOptions = {},
): NormalizationResult<AiGlossaryEntry[]> {
  if (value === undefined || value === null) return { value: [], errors: [] }
  if (!Array.isArray(value)) return { value: [], errors: ['Glossary must be an array'] }

  const errors: string[] = []
  const normalized: AiGlossaryEntry[] = []
  const seen = new Set<string>()
  const sourceTargets = new Map<string, string>()

  if (value.length > MAX_GLOSSARY_ENTRIES) {
    errors.push(`Glossary exceeds ${MAX_GLOSSARY_ENTRIES} entries`)
  }

  value.slice(0, MAX_GLOSSARY_ENTRIES).forEach((rawEntry, index) => {
    if (!isRecord(rawEntry)) {
      errors.push(`Glossary entry ${index + 1} must be an object`)
      return
    }

    const enabled = typeof rawEntry.enabled === 'boolean' ? rawEntry.enabled : true
    if (!enabled && !options.includeDisabled) return

    const entryErrors: string[] = []
    const source = normalizedText(
      rawEntry.source,
      MAX_GLOSSARY_SOURCE_CODE_POINTS,
      `Glossary entry ${index + 1} source`,
      entryErrors,
    )
    const target = normalizedText(
      rawEntry.target,
      MAX_GLOSSARY_TARGET_CODE_POINTS,
      `Glossary entry ${index + 1} target`,
      entryErrors,
    )
    const note = normalizedText(
      rawEntry.note,
      MAX_GLOSSARY_NOTE_CODE_POINTS,
      `Glossary entry ${index + 1} note`,
      entryErrors,
    )

    if (!target) entryErrors.push(`Glossary entry ${index + 1} target is required`)
    errors.push(...entryErrors)
    if (entryErrors.length > 0) return

    const sourceKey = source.toLocaleLowerCase()
    const targetKey = target.toLocaleLowerCase()
    if (sourceKey && enabled) {
      const previousTarget = sourceTargets.get(sourceKey)
      if (previousTarget && previousTarget !== targetKey) {
        errors.push(`Glossary source ${JSON.stringify(source)} maps to multiple targets`)
        return
      }
      sourceTargets.set(sourceKey, targetKey)
    }

    const dedupeKey = sourceKey ? `mapping\u0000${sourceKey}\u0000${targetKey}` : `term\u0000${targetKey}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    normalized.push({
      id: typeof rawEntry.id === 'string' && rawEntry.id.trim() ? rawEntry.id.trim() : `glossary-${index + 1}`,
      ...(source ? { source } : {}),
      target,
      ...(note ? { note } : {}),
      enabled,
    })
  })

  if (JSON.stringify(normalized).length > MAX_GLOSSARY_SERIALIZED_CHARACTERS) {
    errors.push(`Glossary exceeds ${MAX_GLOSSARY_SERIALIZED_CHARACTERS} serialized characters`)
  }

  return { value: normalized, errors }
}

export function assertValidMeetingContext(
  config: unknown,
  glossary: unknown,
  options: NormalizeGlossaryOptions = {},
): { config: MeetingContextConfig; glossary: AiGlossaryEntry[] } {
  const normalizedConfig = normalizeMeetingContextConfig(config)
  const normalizedGlossary = normalizeGlossaryEntries(glossary, options)
  const errors = [...normalizedConfig.errors, ...normalizedGlossary.errors]
  if (errors.length > 0) throw new MeetingContextValidationError(errors)
  return { config: normalizedConfig.value, glossary: normalizedGlossary.value }
}

export function resolveMeetingContextSnapshot(
  globalConfig: unknown,
  globalGlossary: unknown,
  override?: MeetingContextOverride,
): MeetingContextSnapshot {
  const mode = override?.mode ?? 'inherit'
  if (mode === 'clear') {
    return {
      schemaVersion: MEETING_CONTEXT_SCHEMA_VERSION,
      ...DEFAULT_MEETING_CONTEXT,
      useForAiCorrection: false,
      glossary: [],
    }
  }

  const base = normalizeMeetingContextConfig(globalConfig).value
  const effectiveConfig = mode === 'override' ? { ...base, ...(override?.config || {}) } : base
  const effectiveGlossary = mode === 'override' && override?.glossary !== undefined
    ? override.glossary
    : globalGlossary
  const normalized = assertValidMeetingContext(effectiveConfig, effectiveGlossary)

  return {
    schemaVersion: MEETING_CONTEXT_SCHEMA_VERSION,
    ...normalized.config,
    glossary: normalized.glossary.filter((entry) => entry.enabled !== false),
  }
}

export function normalizeMeetingContextSnapshot(value: unknown): NormalizationResult<MeetingContextSnapshot> {
  const record = isRecord(value) ? value : {}
  const normalizedConfig = normalizeMeetingContextConfig(record)
  const normalizedGlossary = normalizeGlossaryEntries(record.glossary)
  return {
    value: {
      schemaVersion: MEETING_CONTEXT_SCHEMA_VERSION,
      ...normalizedConfig.value,
      glossary: normalizedGlossary.value,
    },
    errors: [...normalizedConfig.errors, ...normalizedGlossary.errors],
  }
}

export function getSonioxContext(snapshot: MeetingContextSnapshot): { text?: string; terms?: string[] } | undefined {
  if (!snapshot.useForSoniox) return undefined
  const text = snapshot.background.trim()
  const seenTerms = new Set<string>()
  const terms = snapshot.glossary.flatMap((entry) => {
    const target = entry.target.trim()
    const key = target.toLocaleLowerCase()
    if (!target || seenTerms.has(key)) return []
    seenTerms.add(key)
    return [target]
  })
  const context = {
    ...(text ? { text } : {}),
    ...(terms.length > 0 ? { terms } : {}),
  }
  if (!context.text && !context.terms) return undefined
  if (JSON.stringify(context).length > MAX_SONIOX_CONTEXT_CHARACTERS) {
    throw new MeetingContextValidationError([
      `Soniox context exceeds ${MAX_SONIOX_CONTEXT_CHARACTERS} serialized characters`,
    ])
  }
  return context
}
