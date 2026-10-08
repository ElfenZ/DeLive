import type {
  AiProviderProtocol,
  AiThinkingMode,
  CorrectionStructuredOutputMode,
} from '../types'
import { SAFE_STORAGE_PLACEHOLDER } from '../utils/secretStorage'
import { normalizeOpenAiBaseUrl } from './openAiCompatible'

export const DEFAULT_AI_PROVIDER: AiProviderProtocol = 'openai-compatible'
export const DEFAULT_AI_THINKING_MODE: AiThinkingMode = 'default'
export const ANTHROPIC_VERSION = '2023-06-01'
export const ANTHROPIC_MAX_TOKENS = 8192

export interface AiErrorEnvelope {
  type?: string
  code?: string
  message: string
}

export interface AiRequestContext {
  provider: AiProviderProtocol
  baseUrl: string
  modelsUrl: string
  completionUrl: string
  headers: Record<string, string>
  endpoint: string
}

export interface AiUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface AiCompletionRequest {
  provider?: AiProviderProtocol
  thinkingMode?: AiThinkingMode
  model: string
  system: string
  user: string
  stream?: boolean
  temperature?: number
  structuredOutput?: CorrectionStructuredOutputMode
  jsonSchema?: Record<string, unknown>
  schemaName?: string
}

export interface AiStreamDelta {
  text?: string
  thinking: boolean
  usage?: AiUsage
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function resolveAiProvider(provider?: AiProviderProtocol): AiProviderProtocol {
  return provider === 'anthropic-compatible' ? provider : DEFAULT_AI_PROVIDER
}

export function resolveAiThinkingMode(mode?: AiThinkingMode): AiThinkingMode {
  return mode === 'disabled' ? mode : DEFAULT_AI_THINKING_MODE
}

export function normalizeAiBaseUrl(baseUrl: string, fallback = ''): string {
  return normalizeOpenAiBaseUrl(baseUrl, fallback)
}

export function nextAiCredentialVersion(
  current: { baseUrl?: string; apiKey?: string; provider?: string; credentialVersion?: number },
  next: { baseUrl?: string; apiKey?: string; provider?: string },
): number {
  const currentVersion = Math.max(1, current.credentialVersion || 1)
  const changed = normalizeAiBaseUrl(current.baseUrl || '') !== normalizeAiBaseUrl(next.baseUrl ?? current.baseUrl ?? '')
    || (current.apiKey || '') !== (next.apiKey ?? current.apiKey ?? '')
    || (current.provider || DEFAULT_AI_PROVIDER) !== (next.provider ?? current.provider ?? DEFAULT_AI_PROVIDER)
  return currentVersion + (changed ? 1 : 0)
}

export function safeAiEndpoint(baseUrl: string): string {
  try {
    const url = new URL(normalizeAiBaseUrl(baseUrl))
    return `${url.protocol}//${url.host}`
  } catch {
    return normalizeAiBaseUrl(baseUrl)
  }
}

function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function anthropicApiRoot(baseUrl: string): string {
  return /\/v1$/i.test(baseUrl) ? baseUrl : appendPath(baseUrl, 'v1')
}

export function createAiRequestContext(
  provider: AiProviderProtocol | undefined,
  baseUrl: string,
  apiKey?: string,
): AiRequestContext {
  const resolvedProvider = resolveAiProvider(provider)
  const normalized = normalizeAiBaseUrl(baseUrl)
  const trimmedKey = apiKey?.trim()
  const hasKey = Boolean(trimmedKey && trimmedKey !== SAFE_STORAGE_PLACEHOLDER)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (resolvedProvider === 'anthropic-compatible') {
    if (hasKey) headers['x-api-key'] = trimmedKey!
    headers['anthropic-version'] = ANTHROPIC_VERSION
    const apiRoot = anthropicApiRoot(normalized)
    return {
      provider: resolvedProvider,
      baseUrl: normalized,
      modelsUrl: appendPath(apiRoot, 'models'),
      completionUrl: appendPath(apiRoot, 'messages'),
      headers,
      endpoint: safeAiEndpoint(normalized),
    }
  }

  if (hasKey) headers.Authorization = `Bearer ${trimmedKey}`
  return {
    provider: resolvedProvider,
    baseUrl: normalized,
    modelsUrl: appendPath(normalized, 'models'),
    completionUrl: appendPath(normalized, 'chat/completions'),
    headers,
    endpoint: safeAiEndpoint(normalized),
  }
}

function openAiResponseFormat(
  mode: CorrectionStructuredOutputMode | undefined,
  jsonSchema: Record<string, unknown> | undefined,
  schemaName: string | undefined,
): Record<string, unknown> | undefined {
  if (mode === 'json_object') return { type: 'json_object' }
  if (mode === 'json_schema' && jsonSchema) {
    return {
      type: 'json_schema',
      json_schema: {
        name: schemaName || 'structured_output',
        strict: true,
        schema: jsonSchema,
      },
    }
  }
  return undefined
}

export function buildAiCompletionBody(request: AiCompletionRequest): Record<string, unknown> {
  const provider = resolveAiProvider(request.provider)
  const thinkingMode = resolveAiThinkingMode(request.thinkingMode)
  const thinking = thinkingMode === 'disabled' ? { thinking: { type: 'disabled' } } : {}

  if (provider === 'anthropic-compatible') {
    const outputConfig = request.structuredOutput === 'json_schema' && request.jsonSchema
      ? { output_config: { format: { type: 'json_schema', schema: request.jsonSchema } } }
      : {}
    return {
      model: request.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      ...(request.stream ? { stream: true } : {}),
      ...thinking,
      ...outputConfig,
    }
  }

  const responseFormat = openAiResponseFormat(request.structuredOutput, request.jsonSchema, request.schemaName)
  return {
    model: request.model,
    ...(thinkingMode === 'default' && request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.stream !== undefined ? { stream: request.stream } : {}),
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    ...thinking,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  }
}

export function extractAiErrorEnvelope(payload: unknown): AiErrorEnvelope | undefined {
  const record = asRecord(payload)
  if (!record) return undefined
  const nested = asRecord(record.error)
  const source = nested || (record.type === 'error' ? record : undefined)
  if (!source) return undefined
  const message = typeof source.message === 'string'
    ? source.message
    : typeof record.message === 'string' ? record.message : 'AI request failed'
  return {
    type: typeof source.type === 'string' ? source.type : undefined,
    code: typeof source.code === 'string' ? source.code : undefined,
    message,
  }
}

export function extractAiMessageContent(payload: unknown, provider?: AiProviderProtocol): string {
  const record = asRecord(payload)
  if (!record) return ''

  if (resolveAiProvider(provider) === 'anthropic-compatible') {
    const content = Array.isArray(record.content) ? record.content : []
    return content.map((part) => {
      const item = asRecord(part)
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
    }).filter(Boolean).join('\n')
  }

  const choices = Array.isArray(record.choices) ? record.choices : []
  const first = asRecord(choices[0])
  const message = asRecord(first?.message)
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    const item = asRecord(part)
    return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
  }).join('\n')
}

export function extractAiUsage(payload: unknown, provider?: AiProviderProtocol): AiUsage | undefined {
  const record = asRecord(payload)
  const usage = asRecord(record?.usage)
  if (!usage) return undefined
  if (resolveAiProvider(provider) === 'anthropic-compatible') {
    const promptTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
    const completionTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens !== undefined || completionTokens !== undefined
        ? (promptTokens || 0) + (completionTokens || 0)
        : undefined,
    }
  }
  return {
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
  }
}

export function parseAiStreamData(data: string, provider?: AiProviderProtocol): AiStreamDelta {
  if (!data || data === '[DONE]') return { thinking: false }
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return { thinking: false }
  }
  const error = extractAiErrorEnvelope(payload)
  if (error) throw new Error(error.message)
  const record = asRecord(payload)

  if (resolveAiProvider(provider) === 'anthropic-compatible') {
    const delta = asRecord(record?.delta)
    return {
      text: record?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string'
        ? delta.text
        : undefined,
      thinking: record?.type === 'content_block_delta'
        && (delta?.type === 'thinking_delta' || delta?.type === 'signature_delta'),
      usage: extractAiUsage(payload, provider),
    }
  }

  const choices = Array.isArray(record?.choices) ? record.choices : []
  const choice = asRecord(choices[0])
  const delta = asRecord(choice?.delta)
  return {
    text: typeof delta?.content === 'string' ? delta.content : undefined,
    thinking: typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0,
    usage: extractAiUsage(payload, provider),
  }
}

export function isAiAuthError(error: AiErrorEnvelope): boolean {
  const value = `${error.type || ''} ${error.code || ''} ${error.message}`.toLowerCase()
  return /unauthori[sz]ed|authentication|invalid[_ -]?api[_ -]?key|invalid[_ -]?token|permission[_ -]?denied/.test(value)
}
