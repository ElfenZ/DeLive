import type {
  MeetingContextSnapshot,
  ProviderConfigData,
  SonioxRecognitionSnapshot,
} from '../types'
import {
  SONIOX_DEFAULT_ASYNC_MODEL,
  SONIOX_DEFAULT_ENDPOINT_SENSITIVITY,
  SONIOX_DEFAULT_MODEL,
  SONIOX_MAX_ENDPOINT_DELAY_MS,
  SONIOX_MIN_ENDPOINT_DELAY_MS,
  type SonioxConfig,
  type SonioxContext,
  type SonioxTranslationConfig,
} from '../types/asr/vendors/soniox'
import { getSonioxContext, normalizeMeetingContextSnapshot } from './meetingContext'

export interface EffectiveSonioxConfig {
  apiKey: string
  realtimeModel: string
  asyncModel: string
  languageHints: string[]
  languageHintsStrict: boolean
  enableLanguageIdentification: boolean
  enableSpeakerDiarization: boolean
  enableEndpointDetection: boolean
  endpointSensitivity: number
  maxEndpointDelayMs?: number
  endpointLatencyAdjustmentLevel?: number
  context?: SonioxContext
  translation?: SonioxTranslationConfig
}

export interface SonioxConfigParseResult {
  value: EffectiveSonioxConfig
  diagnostics: string[]
}

export interface ParseSonioxConfigOptions {
  meetingContext?: MeetingContextSnapshot
  fallbackInvalid?: boolean
}

export class SonioxConfigValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('\n'))
    this.name = 'SonioxConfigValidationError'
  }
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function cleanLanguageHints(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item) => {
    const hint = cleanString(item)
    if (!hint) return []
    const key = hint.toLocaleLowerCase()
    if (seen.has(key)) return []
    seen.add(key)
    return [hint]
  })
}

function parseOptionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  errors: string[],
  integer = false,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    errors.push(`${field} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`)
    return undefined
  }
  return parsed
}

export function parseSonioxConfig(
  raw: ProviderConfigData,
  options: ParseSonioxConfigOptions = {},
): SonioxConfigParseResult {
  const errors: string[] = []
  const endpointSensitivity = parseOptionalNumber(
    raw.endpointSensitivity,
    'endpointSensitivity',
    -1,
    1,
    errors,
  ) ?? SONIOX_DEFAULT_ENDPOINT_SENSITIVITY
  const maxEndpointDelayMs = parseOptionalNumber(
    raw.maxEndpointDelayMs,
    'maxEndpointDelayMs',
    SONIOX_MIN_ENDPOINT_DELAY_MS,
    SONIOX_MAX_ENDPOINT_DELAY_MS,
    errors,
    true,
  )
  const endpointLatencyAdjustmentLevel = parseOptionalNumber(
    raw.endpointLatencyAdjustmentLevel,
    'endpointLatencyAdjustmentLevel',
    0,
    3,
    errors,
    true,
  )

  if (errors.length > 0 && !options.fallbackInvalid) {
    throw new SonioxConfigValidationError(errors)
  }

  const languageHints = cleanLanguageHints(raw.languageHints)
  const languageHintsStrict = Boolean(raw.languageHintsStrict) && languageHints.length > 0
  const translationTarget = cleanString(raw.translationTargetLanguage)
  const translation = raw.translationEnabled && translationTarget
    ? { type: 'one_way' as const, target_language: translationTarget }
    : undefined
  const meetingContext = options.meetingContext
    ?? (raw.meetingContext ? normalizeMeetingContextSnapshot(raw.meetingContext).value : undefined)
  const context = meetingContext ? getSonioxContext(meetingContext) : undefined

  return {
    value: {
      apiKey: cleanString(raw.apiKey) || '',
      realtimeModel: cleanString(raw.model) || SONIOX_DEFAULT_MODEL,
      asyncModel: cleanString(raw.asyncModel) || SONIOX_DEFAULT_ASYNC_MODEL,
      languageHints,
      languageHintsStrict,
      enableLanguageIdentification: raw.enableLanguageIdentification !== false,
      enableSpeakerDiarization: Boolean(raw.enableSpeakerDiarization),
      enableEndpointDetection: raw.enableEndpointDetection !== false,
      endpointSensitivity,
      ...(maxEndpointDelayMs !== undefined ? { maxEndpointDelayMs } : {}),
      ...(endpointLatencyAdjustmentLevel !== undefined ? { endpointLatencyAdjustmentLevel } : {}),
      ...(context ? { context } : {}),
      ...(translation ? { translation } : {}),
    },
    diagnostics: errors,
  }
}

export function buildSonioxRealtimeRequest(config: EffectiveSonioxConfig): SonioxConfig {
  const request: SonioxConfig = {
    api_key: config.apiKey,
    model: config.realtimeModel,
    audio_format: 'auto',
    ...(config.languageHints.length > 0 ? { language_hints: config.languageHints } : {}),
    language_hints_strict: config.languageHintsStrict,
    enable_language_identification: config.enableLanguageIdentification,
    enable_speaker_diarization: config.enableSpeakerDiarization,
    enable_endpoint_detection: config.enableEndpointDetection,
    ...(config.context ? { context: config.context } : {}),
    ...(config.translation ? { translation: config.translation } : {}),
  }

  if (config.enableEndpointDetection) {
    request.endpoint_sensitivity = config.endpointSensitivity
    if (config.maxEndpointDelayMs !== undefined) request.max_endpoint_delay_ms = config.maxEndpointDelayMs
    if (config.endpointLatencyAdjustmentLevel !== undefined) {
      request.endpoint_latency_adjustment_level = config.endpointLatencyAdjustmentLevel
    }
  }
  return request
}

export function buildSonioxAsyncRequest(
  config: EffectiveSonioxConfig,
  source: { fileId?: string; audioUrl?: string },
): Record<string, unknown> {
  return {
    model: config.asyncModel,
    ...(source.fileId ? { file_id: source.fileId } : {}),
    ...(source.audioUrl ? { audio_url: source.audioUrl } : {}),
    ...(config.languageHints.length > 0 ? { language_hints: config.languageHints } : {}),
    language_hints_strict: config.languageHintsStrict,
    ...(config.enableSpeakerDiarization ? { enable_speaker_diarization: true } : {}),
    ...(config.translation ? { translation: config.translation } : {}),
    ...(config.context ? { context: config.context } : {}),
  }
}

export function createSonioxRecognitionSnapshot(config: EffectiveSonioxConfig): SonioxRecognitionSnapshot {
  return {
    model: config.realtimeModel,
    languageHints: [...config.languageHints],
    languageHintsStrict: config.languageHintsStrict,
    enableSpeakerDiarization: config.enableSpeakerDiarization,
    enableEndpointDetection: config.enableEndpointDetection,
    ...(config.enableEndpointDetection ? { endpointSensitivity: config.endpointSensitivity } : {}),
    ...(config.enableEndpointDetection && config.maxEndpointDelayMs !== undefined
      ? { maxEndpointDelayMs: config.maxEndpointDelayMs }
      : {}),
    ...(config.enableEndpointDetection && config.endpointLatencyAdjustmentLevel !== undefined
      ? { endpointLatencyAdjustmentLevel: config.endpointLatencyAdjustmentLevel }
      : {}),
    ...(config.context ? { context: config.context } : {}),
  }
}
