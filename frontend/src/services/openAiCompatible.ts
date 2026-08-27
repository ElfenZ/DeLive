import { SAFE_STORAGE_PLACEHOLDER } from '../utils/secretStorage'

export interface OpenAiErrorEnvelope {
  type?: string
  code?: string
  message: string
}

export interface OpenAiRequestContext {
  baseUrl: string
  modelsUrl: string
  completionUrl: string
  headers: Record<string, string>
  endpoint: string
}

export function normalizeOpenAiBaseUrl(baseUrl: string, fallback = ''): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '') || fallback
  try {
    const url = new URL(normalized)
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/+$/, '')
  } catch {
    return normalized
  }
}

export function safeOpenAiEndpoint(baseUrl: string): string {
  try {
    const url = new URL(normalizeOpenAiBaseUrl(baseUrl))
    return `${url.protocol}//${url.host}`
  } catch {
    return normalizeOpenAiBaseUrl(baseUrl)
  }
}

export function createOpenAiRequestContext(baseUrl: string, apiKey?: string): OpenAiRequestContext {
  const normalized = normalizeOpenAiBaseUrl(baseUrl)
  const trimmedKey = apiKey?.trim()
  return {
    baseUrl: normalized,
    modelsUrl: `${normalized}/models`,
    completionUrl: `${normalized}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      ...(trimmedKey && trimmedKey !== SAFE_STORAGE_PLACEHOLDER
        ? { Authorization: `Bearer ${trimmedKey}` }
        : {}),
    },
    endpoint: safeOpenAiEndpoint(normalized),
  }
}

export function nextOpenAiCredentialVersion(
  current: { baseUrl?: string; apiKey?: string; credentialVersion?: number },
  next: { baseUrl?: string; apiKey?: string },
): number {
  const currentVersion = Math.max(1, current.credentialVersion || 1)
  const changed = normalizeOpenAiBaseUrl(current.baseUrl || '') !== normalizeOpenAiBaseUrl(next.baseUrl ?? current.baseUrl ?? '')
    || (current.apiKey || '') !== (next.apiKey ?? current.apiKey ?? '')
  return currentVersion + (changed ? 1 : 0)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function extractOpenAiErrorEnvelope(payload: unknown): OpenAiErrorEnvelope | undefined {
  const record = asRecord(payload)
  if (!record) return undefined
  const nested = asRecord(record.error)
  const source = nested || (record.type === 'error' ? record : undefined)
  if (!source) return undefined
  const message = typeof source.message === 'string'
    ? source.message
    : typeof record.message === 'string' ? record.message : 'OpenAI-compatible request failed'
  return {
    type: typeof source.type === 'string' ? source.type : undefined,
    code: typeof source.code === 'string' ? source.code : undefined,
    message,
  }
}

export function extractOpenAiMessageContent(payload: unknown): string {
  const record = asRecord(payload)
  const choices = Array.isArray(record?.choices) ? record.choices : []
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

export function isOpenAiAuthError(error: OpenAiErrorEnvelope): boolean {
  const value = `${error.type || ''} ${error.code || ''} ${error.message}`.toLowerCase()
  return /unauthori[sz]ed|authentication|invalid[_ -]?api[_ -]?key|invalid[_ -]?token|permission[_ -]?denied/.test(value)
}
