/**
 * Soniox 特定类型定义
 * 保留原有的 Soniox API 类型，用于内部实现
 */

// Soniox Token 格式（原始 API 响应）
export interface SonioxToken {
  text: string
  start_ms?: number
  end_ms?: number
  confidence?: number
  is_final: boolean
  speaker?: string
  language?: string
  translation_status?: 'none' | 'original' | 'translation'
  source_language?: string
}

// Soniox API 响应格式
export interface SonioxResponse {
  tokens?: SonioxToken[]
  final_audio_proc_ms?: number
  total_audio_proc_ms?: number
  finished?: boolean
  error_code?: string
  error_message?: string
}

// Soniox WebSocket 配置
export interface SonioxConfig {
  api_key: string
  model: string
  audio_format: string
  sample_rate?: number
  num_channels?: number
  language_hints?: string[]
  language_hints_strict?: boolean
  enable_language_identification?: boolean
  enable_speaker_diarization?: boolean
  enable_endpoint_detection?: boolean
  endpoint_sensitivity?: number
  max_endpoint_delay_ms?: number
  endpoint_latency_adjustment_level?: number
  context?: SonioxContext
  translation?: SonioxTranslationConfig
}

export type SonioxTranslationConfig =
  | { type: 'one_way'; target_language: string }
  | { type: 'two_way'; language_a: string; language_b: string }

export interface SonioxContext {
  general?: Array<{ key: string; value: string }>
  text?: string
  terms?: string[]
  translation_terms?: Array<{ source: string; target: string }>
}

// Soniox 提供商特定配置
export interface SonioxProviderConfig {
  apiKey: string
  languageHints?: string[]
  model?: string
  enableLanguageIdentification?: boolean
  enableSpeakerDiarization?: boolean
  enableEndpointDetection?: boolean
  languageHintsStrict?: boolean
  endpointSensitivity?: number
  maxEndpointDelayMs?: number
  endpointLatencyAdjustmentLevel?: number
  context?: SonioxContext
  translationEnabled?: boolean
  translationTargetLanguage?: string
}

// Soniox 常量
export const SONIOX_WEBSOCKET_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
export const SONIOX_DEFAULT_MODEL = 'stt-rt-v5'
export const SONIOX_DEFAULT_ASYNC_MODEL = 'stt-async-v5'
export const SONIOX_DEFAULT_ENDPOINT_SENSITIVITY = -0.5
export const SONIOX_MIN_ENDPOINT_DELAY_MS = 500
export const SONIOX_MAX_ENDPOINT_DELAY_MS = 3000
