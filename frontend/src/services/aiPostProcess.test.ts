import { describe, expect, it } from 'vitest'
import {
  parseAiBriefingResponse,
  parseSessionMindMapResponse,
  parseSessionQaResponse,
  isAiPostProcessConfigured,
  resolveTranscriptArtifactSourceState,
  resolveTranscriptText,
} from './aiPostProcess'
import type { TranscriptSession } from '../types'

describe('aiPostProcess', () => {
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
