import { describe, expect, it } from 'vitest'
import { buildAiCorrectionRecoveryHeaders } from '../../electron/aiCorrectionRecovery'

describe('AI correction recovery headers', () => {
  it('uses bearer authentication for OpenAI-compatible recovery', () => {
    expect(buildAiCorrectionRecoveryHeaders({ provider: 'openai-compatible', apiKey: ' secret ' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
    })
  })

  it('uses Anthropic authentication for Anthropic-compatible recovery', () => {
    expect(buildAiCorrectionRecoveryHeaders({ provider: 'anthropic-compatible', apiKey: ' secret ' })).toEqual({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'secret',
    })
  })
})
