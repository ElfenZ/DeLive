import type { AiCorrectionRecoveryRequest } from '../shared/electronApi'

export function buildAiCorrectionRecoveryHeaders(
  request: Pick<AiCorrectionRecoveryRequest, 'provider' | 'apiKey'>,
): Record<string, string> {
  const apiKey = request.apiKey?.trim()
  if (request.provider === 'anthropic-compatible') {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    }
  }
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}
