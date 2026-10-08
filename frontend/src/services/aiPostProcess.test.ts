import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askQuestionForSession,
  askQuestionForSessionStreaming,
  fetchAvailableModels,
  generateSessionBriefing,
  generateSessionMindMap,
  parseAiBriefingResponse,
  parseSessionMindMapResponse,
  parseSessionQaResponse,
  isAiPostProcessConfigured,
  invalidateAiEndpointModels,
  reconcileAiEndpointModels,
  resolveModelForFeature,
  resolveTranscriptArtifactSourceState,
  resolveTranscriptText,
  extractSessionQaStreamChunk,
} from './aiPostProcess'
import type { AppSettings, TranscriptSession } from '../types'

describe('aiPostProcess', () => {
  it('ignores non-JSON SSE data frames but surfaces JSON error envelopes', () => {
    expect(extractSessionQaStreamChunk('ping')).toBeUndefined()
    expect(extractSessionQaStreamChunk('{"choices":[{"delta":{"content":"hello"}}]}')).toBe('hello')
    expect(extractSessionQaStreamChunk('{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}', 'anthropic-compatible')).toBe('hi')
    expect(() => extractSessionQaStreamChunk('{"error":{"message":"invalid token"}}'))
      .toThrow('invalid token')
  })

  it('parses plain json responses', () => {
    const result = parseAiBriefingResponse(JSON.stringify({
      titleSuggestion: 'Weekly Sync',
      tagSuggestions: ['planning', 'release'],
      summary: 'A concise summary',
      actionItems: ['Ship the feature'],
      keywords: ['ai', 'summary'],
      chapters: [
        { title: 'Intro', summary: 'Context' },
      ],
    }), 'gpt-test')

    expect(result.titleSuggestion).toBe('Weekly Sync')
    expect(result.tagSuggestions).toEqual(['planning', 'release'])
    expect(result.summary).toBe('A concise summary')
    expect(result.actionItems).toEqual(['Ship the feature'])
    expect(result.keywords).toEqual(['ai', 'summary'])
    expect(result.chapters).toEqual([{ title: 'Intro', summary: 'Context' }])
    expect(result.model).toBe('gpt-test')
    expect(result.status).toBe('success')
  })

  it('parses fenced json responses', () => {
    const result = parseAiBriefingResponse(
      '```json\n{"summary":"Brief","keywords":["demo"]}\n```',
      'demo-model',
    )

    expect(result.summary).toBe('Brief')
    expect(result.keywords).toEqual(['demo'])
  })

  it('detects whether ai post-process is configured', () => {
    expect(isAiPostProcessConfigured({
      apiKey: '',
      languageHints: ['zh', 'en'],
      aiPostProcess: {
        enabled: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
      },
    })).toBe(true)

    expect(isAiPostProcessConfigured({
      apiKey: '',
      languageHints: ['zh', 'en'],
      aiPostProcess: {
        enabled: false,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
      },
    })).toBe(false)
  })

  it('detects briefing model assigned through default or feature model settings', () => {
    expect(isAiPostProcessConfigured({
      apiKey: '',
      languageHints: ['zh', 'en'],
      aiPostProcess: {
        enabled: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: '',
        defaultModel: 'qwen-default',
      },
    })).toBe(true)

    expect(isAiPostProcessConfigured({
      apiKey: '',
      languageHints: ['zh', 'en'],
      aiPostProcess: {
        enabled: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: '',
        modelAssignment: { briefing: 'qwen-briefing' },
      },
    })).toBe(true)
  })

  it('invalidates all endpoint-derived model state when the base URL changes', () => {
    expect(invalidateAiEndpointModels()).toEqual({
      availableModels: [],
      selectedModels: [],
      defaultModel: '',
      model: '',
      modelAssignment: {},
    })
  })

  it('reconciles selections and feature assignments against a refreshed model list', () => {
    expect(reconcileAiEndpointModels({
      selectedModels: ['old-model', 'shared-model'],
      defaultModel: 'old-model',
      model: 'legacy-model',
      modelAssignment: {
        correction: 'old-model',
        briefing: 'shared-model',
      },
    }, ['shared-model', 'new-model'])).toEqual({
      availableModels: ['shared-model', 'new-model'],
      selectedModels: ['shared-model'],
      defaultModel: 'shared-model',
      model: '',
      modelAssignment: { briefing: 'shared-model' },
    })
  })

  it('selects a safe default when no previous model exists on the refreshed endpoint', () => {
    expect(reconcileAiEndpointModels({
      selectedModels: ['old-model'],
      defaultModel: 'old-model',
      modelAssignment: { correction: 'old-model' },
    }, ['new-a', 'new-b'])).toMatchObject({
      selectedModels: ['new-a'],
      defaultModel: 'new-a',
      modelAssignment: {},
    })
  })

  it('does not resolve stale assigned models when a current model list is known', () => {
    expect(resolveModelForFeature({
      availableModels: ['new-model'],
      modelAssignment: { correction: 'old-model' },
      defaultModel: 'new-model',
    }, 'correction')).toBe('new-model')

    expect(resolveModelForFeature({
      availableModels: ['new-model'],
      modelAssignment: { correction: 'old-model' },
      defaultModel: 'also-old',
    }, 'correction')).toBe('')
  })

  it('parses session qa responses with citations', () => {
    const result = parseSessionQaResponse(JSON.stringify({
      answer: 'Alice suggested shipping this week.',
      citations: [
        { quote: 'We should ship it this week.', speakerLabel: 'Alice' },
      ],
    }), 'qwen-test')

    expect(result).toEqual({
      answer: 'Alice suggested shipping this week.',
      citations: [
        { quote: 'We should ship it this week.', speakerLabel: 'Alice' },
      ],
      model: 'qwen-test',
    })
  })

  it('parses session mind map responses', () => {
    const result = parseSessionMindMapResponse(JSON.stringify({
      title: 'Weekly Sync',
      markdown: '# Weekly Sync\n## Decisions\n### Ship this week',
    }), 'mindmap-model')

    expect(result).toEqual({
      title: 'Weekly Sync',
      markdown: '# Weekly Sync\n## Decisions\n### Ship this week',
      model: 'mindmap-model',
      status: 'success',
      error: undefined,
      generatedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    })
  })
})

describe('aiPostProcess protocol requests', () => {
  const session = {
    id: 'protocol-session',
    title: 'Protocol Session',
    transcript: 'Discussed the release plan.',
    createdAt: 1,
  } as TranscriptSession
  const settings: AppSettings = {
    apiKey: '',
    languageHints: [],
    aiPostProcess: {
      enabled: true,
      provider: 'anthropic-compatible',
      thinkingMode: 'disabled',
      baseUrl: 'https://api.example.com/anthropic',
      apiKey: 'secret',
      defaultModel: 'claude-test',
      promptLanguage: 'en',
    },
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses Anthropic model discovery headers and endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'claude-test' }] })))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchAvailableModels(settings.aiPostProcess!.baseUrl!, 'secret', 'anthropic-compatible'))
      .resolves.toEqual(['claude-test'])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/anthropic/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'secret' }) }),
    )
  })

  it('routes briefing, chat, and mind map through Anthropic request and response shapes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: '{"summary":"Brief"}' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: '{"answer":"Answer"}' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: '{"title":"Map","markdown":"# Map"}' }] })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateSessionBriefing(session, settings)).resolves.toMatchObject({ postProcess: { summary: 'Brief' } })
    await expect(askQuestionForSession(session, 'What happened?', settings)).resolves.toMatchObject({ answer: 'Answer' })
    await expect(generateSessionMindMap(session, settings)).resolves.toMatchObject({ mindMap: { title: 'Map' } })

    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init.body as string)
      expect(body).toMatchObject({
        max_tokens: 8192,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user' }],
      })
      expect(body).toHaveProperty('system')
      expect(body).not.toHaveProperty('temperature')
    }
  })

  it('parses Anthropic streaming chat text', async () => {
    const stream = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"answer\\":\\"Streamed\\"}"}}',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    })))
    const onDone = vi.fn()
    await askQuestionForSessionStreaming(session, 'Question?', settings, {
      onChunk: vi.fn(),
      onDone,
      onError: vi.fn((error) => { throw error }),
    })
    expect(onDone).toHaveBeenCalledWith(
      '{"answer":"Streamed"}',
      expect.objectContaining({ answer: 'Streamed' }),
    )
  })
})

describe('resolveTranscriptText', () => {
  const baseSession = {
    id: 'test-1',
    title: 'Test',
    transcript: '  original raw transcript  ',
    createdAt: Date.now(),
    segments: [],
    speakers: [],
  } as unknown as TranscriptSession

  const sessionWithCorrection = {
    ...baseSession,
    correction: {
      status: 'done' as const,
      mode: 'quick' as const,
      correctedText: '  corrected clean transcript  ',
    },
  } as unknown as TranscriptSession

  const sessionCorrecting = {
    ...baseSession,
    correction: {
      status: 'correcting' as const,
      mode: 'quick' as const,
      correctedText: 'partial output',
    },
  } as unknown as TranscriptSession

  const sessionReset = {
    ...baseSession,
    correction: {
      status: 'idle' as const,
      mode: 'quick' as const,
      correctedText: undefined,
    },
  } as unknown as TranscriptSession

  const sessionEmptyCorrection = {
    ...baseSession,
    correction: {
      status: 'done' as const,
      mode: 'quick' as const,
      correctedText: '   ',
    },
  } as unknown as TranscriptSession

  it('auto: uses corrected text when available and done', () => {
    expect(resolveTranscriptText(sessionWithCorrection, 'auto')).toMatchObject({ text: '  corrected clean transcript  ', sourceKind: 'legacy-correction' })
  })

  it('auto: falls back to original when no correction', () => {
    expect(resolveTranscriptText(baseSession, 'auto')).toMatchObject({ text: '  original raw transcript  ', sourceKind: 'original' })
  })

  it('auto: falls back to original when correction is still in progress', () => {
    expect(resolveTranscriptText(sessionCorrecting, 'auto').text).toBe('  original raw transcript  ')
  })

  it('auto: falls back to original after reset (status=idle, correctedText=undefined)', () => {
    expect(resolveTranscriptText(sessionReset, 'auto').text).toBe('  original raw transcript  ')
  })

  it('auto: falls back to original when correctedText is whitespace-only', () => {
    expect(resolveTranscriptText(sessionEmptyCorrection, 'auto').text).toBe('  original raw transcript  ')
  })

  it('original: always uses original transcript even when corrected exists', () => {
    expect(resolveTranscriptText(sessionWithCorrection, 'original').text).toBe('  original raw transcript  ')
  })

  it('prefers a published correction in auto mode but honors explicit original mode', () => {
    const publishedSession = {
      ...baseSession,
      correction: {
        status: 'done',
        mode: 'quick',
        published: {
          id: 'published-1',
          correctedText: 'published correction',
          outputTextHash: 'published-hash',
        },
      },
    } as unknown as TranscriptSession
    expect(resolveTranscriptText(publishedSession, 'auto')).toEqual({
      text: 'published correction',
      sourceKind: 'published-correction',
      sourceTextHash: 'published-hash',
      sourceResultId: 'published-1',
    })
    expect(resolveTranscriptText(publishedSession, 'original').sourceKind).toBe('original')
  })

  it('corrected: uses corrected text when available', () => {
    expect(resolveTranscriptText(sessionWithCorrection, 'corrected').text).toBe('  corrected clean transcript  ')
  })

  it('corrected: falls back to original when no correction available', () => {
    expect(resolveTranscriptText(baseSession, 'corrected').text).toBe('  original raw transcript  ')
  })

  it('undefined preference defaults to auto behavior', () => {
    expect(resolveTranscriptText(sessionWithCorrection, undefined).text).toBe('  corrected clean transcript  ')
    expect(resolveTranscriptText(baseSession, undefined).text).toBe('  original raw transcript  ')
  })

  it('preserves exact source whitespace for hashing and provenance', () => {
    expect(resolveTranscriptText(baseSession, 'original').text).toBe('  original raw transcript  ')
    expect(resolveTranscriptText(sessionWithCorrection, 'corrected').text).toBe('  corrected clean transcript  ')
  })

  it('classifies persisted artifact provenance as current, stale, or unknown', () => {
    const current = resolveTranscriptText(baseSession, 'original')
    expect(resolveTranscriptArtifactSourceState({
      sourceKind: current.sourceKind,
      sourceTextHash: current.sourceTextHash,
    }, current)).toBe('current')
    expect(resolveTranscriptArtifactSourceState({
      sourceKind: current.sourceKind,
      sourceTextHash: 'different',
    }, current)).toBe('stale')
    expect(resolveTranscriptArtifactSourceState({ sourceKind: 'legacy-unknown' }, current)).toBe('unknown')
  })
})
