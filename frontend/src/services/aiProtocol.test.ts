import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_MAX_TOKENS,
  buildAiCompletionBody,
  createAiRequestContext,
  extractAiMessageContent,
  extractAiUsage,
  parseAiStreamData,
} from './aiProtocol'

describe('aiProtocol', () => {
  it('builds OpenAI-compatible endpoints and bearer authentication', () => {
    const context = createAiRequestContext('openai-compatible', 'https://api.example.com/v1/', 'secret')
    expect(context.modelsUrl).toBe('https://api.example.com/v1/models')
    expect(context.completionUrl).toBe('https://api.example.com/v1/chat/completions')
    expect(context.headers.Authorization).toBe('Bearer secret')
    expect(context.headers).not.toHaveProperty('x-api-key')
  })

  it('builds Anthropic endpoints with or without a trailing v1', () => {
    const direct = createAiRequestContext('anthropic-compatible', 'https://api.anthropic.com', 'secret')
    const versioned = createAiRequestContext('anthropic-compatible', 'https://proxy.example.com/anthropic/v1/', 'secret')
    expect(direct.modelsUrl).toBe('https://api.anthropic.com/v1/models')
    expect(direct.completionUrl).toBe('https://api.anthropic.com/v1/messages')
    expect(versioned.completionUrl).toBe('https://proxy.example.com/anthropic/v1/messages')
    expect(direct.headers).toMatchObject({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' })
    expect(direct.headers).not.toHaveProperty('Authorization')
  })

  it('never sends the safe-storage placeholder', () => {
    expect(createAiRequestContext('openai-compatible', 'https://example.com/v1', '{{SAFE_STORAGE}}').headers)
      .not.toHaveProperty('Authorization')
    expect(createAiRequestContext('anthropic-compatible', 'https://example.com', '{{SAFE_STORAGE}}').headers)
      .not.toHaveProperty('x-api-key')
  })

  it('omits thinking controls by default and disables thinking explicitly', () => {
    const defaults = buildAiCompletionBody({
      provider: 'openai-compatible', model: 'gpt', system: 'system', user: 'user', temperature: 0.2,
    })
    const disabled = buildAiCompletionBody({
      provider: 'openai-compatible', thinkingMode: 'disabled', model: 'kimi', system: 'system', user: 'user', temperature: 0.2,
    })
    expect(defaults).not.toHaveProperty('thinking')
    expect(defaults.temperature).toBe(0.2)
    expect(disabled).toMatchObject({ thinking: { type: 'disabled' } })
    expect(disabled).not.toHaveProperty('temperature')
  })

  it('maps Anthropic request and structured output fields', () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } } }
    const body = buildAiCompletionBody({
      provider: 'anthropic-compatible',
      thinkingMode: 'disabled',
      model: 'claude',
      system: 'system',
      user: 'user',
      temperature: 0.2,
      stream: true,
      structuredOutput: 'json_schema',
      jsonSchema: schema,
    })
    expect(body).toMatchObject({
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: 'system',
      messages: [{ role: 'user', content: 'user' }],
      stream: true,
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema } },
    })
    expect(body).not.toHaveProperty('temperature')
  })

  it('extracts Anthropic visible content and usage', () => {
    const payload = {
      content: [
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text: 'visible' },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    }
    expect(extractAiMessageContent(payload, 'anthropic-compatible')).toBe('visible')
    expect(extractAiUsage(payload, 'anthropic-compatible')).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    })
  })

  it('separates Anthropic text and thinking stream deltas', () => {
    expect(parseAiStreamData(JSON.stringify({
      type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' },
    }), 'anthropic-compatible')).toEqual({ text: undefined, thinking: true, usage: undefined })
    expect(parseAiStreamData(JSON.stringify({
      type: 'content_block_delta', delta: { type: 'text_delta', text: 'visible' },
    }), 'anthropic-compatible')).toEqual({ text: 'visible', thinking: false, usage: undefined })
  })
})
