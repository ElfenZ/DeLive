export const VOLC_RESOURCE_V1 = 'volc.bigasr.sauc.duration'
export const VOLC_RESOURCE_V2 = 'volc.seedasr.sauc.duration'

export interface VolcProxyConfig {
  appKey: string
  accessKey: string
  language?: string
  modelV2?: boolean
  bidiStreaming?: boolean
  enableDdc?: boolean
  enableVad?: boolean
  enableNonstream?: boolean
  enableSpeakerDiarization?: boolean
}

export interface VolcResponseDiagnosticSummary {
  hasResult: boolean
  resultKeys: string[]
  utteranceCount: number
  utteranceKeys: string[]
  speakerFields: string[]
  speakerSamples: Record<string, string[]>
}

export function parseVolcProxyConfig(searchParams: URLSearchParams): VolcProxyConfig {
  return {
    appKey: searchParams.get('appKey') || '',
    accessKey: searchParams.get('accessKey') || '',
    language: searchParams.get('language') || '',
    modelV2: searchParams.get('modelV2') === 'true',
    bidiStreaming: searchParams.get('bidiStreaming') !== 'false',
    enableDdc: searchParams.get('enableDdc') !== 'false',
    enableVad: searchParams.get('enableVad') === 'true',
    enableNonstream: searchParams.get('enableNonstream') === 'true',
    enableSpeakerDiarization: searchParams.get('enableSpeakerDiarization') === 'true',
  }
}

export function buildVolcFullClientRequest(config: VolcProxyConfig): Record<string, unknown> {
  const audio: Record<string, unknown> = {
    format: 'pcm',
    rate: 16000,
    bits: 16,
    channel: 1,
  }
  if (config.language) audio.language = config.language

  const request: Record<string, unknown> = {
    model_name: 'bigmodel',
    enable_itn: true,
    enable_punc: true,
    enable_ddc: config.enableDdc !== false,
  }
  if (config.enableNonstream) request.enable_nonstream = true
  if (config.enableVad || config.enableSpeakerDiarization) request.show_utterances = true
  if (config.enableVad) {
    request.end_window_size = 800
    request.force_to_speech_time = 1000
  }
  if (config.enableSpeakerDiarization) request.enable_speaker_info = true

  return { user: { uid: config.appKey }, audio, request }
}

export function resolveVolcResourceId(modelV2: boolean | undefined): string {
  return modelV2 ? VOLC_RESOURCE_V2 : VOLC_RESOURCE_V1
}

export function buildVolcAuthHeaders(config: VolcProxyConfig, connectId: string): Record<string, string> {
  return {
    'X-Api-App-Key': config.appKey,
    'X-Api-Access-Key': config.accessKey,
    'X-Api-Resource-Id': resolveVolcResourceId(config.modelV2),
    'X-Api-Connect-Id': connectId,
  }
}

export function summarizeVolcResponseForDiagnostics(value: unknown): VolcResponseDiagnosticSummary {
  const result = isRecord(value) && isRecord(value.result) ? value.result : null
  const utterances = result && Array.isArray(result.utterances) ? result.utterances : []
  const utteranceKeys = new Set<string>()
  const speakerSamples = new Map<string, Set<string>>()

  for (const utterance of utterances) {
    if (!isRecord(utterance)) continue
    Object.keys(utterance).forEach((key) => utteranceKeys.add(key))
    collectSpeakerDiagnostics(utterance, '', 0, speakerSamples)
  }

  return {
    hasResult: Boolean(result),
    resultKeys: result ? Object.keys(result).sort() : [],
    utteranceCount: utterances.length,
    utteranceKeys: [...utteranceKeys].sort(),
    speakerFields: [...speakerSamples.keys()].sort(),
    speakerSamples: Object.fromEntries(
      [...speakerSamples.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([field, samples]) => [field, [...samples].slice(0, 5)]),
    ),
  }
}

function collectSpeakerDiagnostics(
  value: Record<string, unknown>,
  prefix: string,
  depth: number,
  samples: Map<string, Set<string>>,
): void {
  if (depth > 2) return

  for (const [key, fieldValue] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (/speaker/i.test(key)) {
      const fieldSamples = samples.get(path) ?? new Set<string>()
      fieldSamples.add(formatDiagnosticValue(fieldValue))
      samples.set(path, fieldSamples)
    }
    if (isRecord(fieldValue)) {
      collectSpeakerDiagnostics(fieldValue, path, depth + 1, samples)
    }
  }
}

function formatDiagnosticValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value.slice(0, 32)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[array:${value.length}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().join(',')}}`
  return typeof value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
