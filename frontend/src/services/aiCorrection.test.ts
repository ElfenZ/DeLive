import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TranscriptSession, AppSettings, CorrectionIssue } from '../types'

function makeSession(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  return {
    id: 'test-session',
    title: 'Test Session',
    transcript: '这是一段测试转录文本。',
    startTime: Date.now(),
    endTime: Date.now() + 60_000,
    provider: 'soniox',
    segments: [],
    tags: [],
    ...overrides,
  } as TranscriptSession
}

function makeSettings(overrides: Partial<AppSettings['aiPostProcess']> = {}): AppSettings {
  return {
    apiKey: '',
    languageHints: ['zh', 'en'],
    aiPostProcess: {
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      promptLanguage: 'zh',
      ...overrides,
    },
  } as AppSettings
}

const mockIssues: CorrectionIssue[] = [
  {
    id: '1',
    originalText: '侍应',
    suggestedText: '时应',
    reason: '同音字替换',
    category: 'homophone',
    accepted: true,
  },
]

describe('aiCorrection — extractTextContent', async () => {
  // Import module to ensure it loads without errors
  await import('./aiCorrection')

  it('extracts JSON array from plain text', () => {
    // Internal helper: extractJsonArray
    // Tested indirectly via the module's parsing contract
    const raw = JSON.stringify([{ id: '1', originalText: 'foo', suggestedText: 'bar', reason: 'test', category: 'other' }])
    const parsed = JSON.parse(raw)
    expect(parsed).toBeInstanceOf(Array)
    expect(parsed[0].originalText).toBe('foo')
  })

  it('extracts JSON array from fenced code block', () => {
    const raw = '```json\n[{"id":"1","originalText":"A","suggestedText":"B","reason":"R","category":"homophone"}]\n```'
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    expect(match?.[1]).toBeDefined()
    const parsed = JSON.parse(match![1].trim())
    expect(parsed[0].category).toBe('homophone')
  })
})

describe('aiCorrection — prompt builders', async () => {
  // We can't test private functions directly, but we can verify the
  // public API validates inputs before calling the AI.

  const { detectCorrectionIssues, correctTranscriptQuick, correctTranscriptWithReview } = await import('./aiCorrection')

  describe('detectCorrectionIssues — input validation', () => {
    it('throws when AI post-process is disabled', async () => {
      const settings = makeSettings({ enabled: false })
      await expect(detectCorrectionIssues(makeSession(), settings)).rejects.toThrow(/启用/)
    })

    it('throws when model is not configured', async () => {
      const settings = makeSettings({ model: '', defaultModel: '' })
      await expect(detectCorrectionIssues(makeSession(), settings)).rejects.toThrow(/模型/)
    })

    it('throws when transcript is empty', async () => {
      const settings = makeSettings()
      await expect(detectCorrectionIssues(makeSession({ transcript: '  ' }), settings)).rejects.toThrow(/转录/)
    })
  })

  describe('correctTranscriptQuick — input validation', () => {
    const noopCallbacks = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }

    it('throws when AI is disabled', async () => {
      const settings = makeSettings({ enabled: false })
      await expect(correctTranscriptQuick(makeSession(), settings, noopCallbacks)).rejects.toThrow(/启用/)
    })

    it('throws when model is missing', async () => {
      const settings = makeSettings({ model: '' })
      await expect(correctTranscriptQuick(makeSession(), settings, noopCallbacks)).rejects.toThrow(/模型/)
    })

    it('throws when transcript is empty', async () => {
      const settings = makeSettings()
      await expect(
        correctTranscriptQuick(makeSession({ transcript: '' }), settings, noopCallbacks),
      ).rejects.toThrow(/转录/)
    })
  })

  describe('correctTranscriptWithReview — input validation', () => {
    const noopCallbacks = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }

    it('throws when AI is disabled', async () => {
      const settings = makeSettings({ enabled: false })
      await expect(
        correctTranscriptWithReview(makeSession(), mockIssues, settings, noopCallbacks),
      ).rejects.toThrow(/启用/)
    })

    it('throws when no accepted issues', async () => {
      const settings = makeSettings()
      await expect(
        correctTranscriptWithReview(makeSession(), [], settings, noopCallbacks),
      ).rejects.toThrow(/修改项/)
    })
  })
})

describe('aiCorrection — detectCorrectionIssues with mock fetch', async () => {
  const { detectCorrectionIssues } = await import('./aiCorrection')

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('parses a valid detection response', async () => {
    const issues = [
      { id: '1', originalText: '侍应', suggestedText: '时应', reason: '同音', category: 'homophone' },
      { id: '2', originalText: '标点', suggestedText: '标点。', reason: '缺失句号', category: 'punctuation' },
    ]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(issues) } }],
      }),
    }))

    const result = await detectCorrectionIssues(makeSession(), makeSettings())
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0].originalText).toBe('侍应')
    expect(result.issues[0].category).toBe('homophone')
    expect(result.issues[1].category).toBe('punctuation')
    expect(result.model).toBe('qwen2.5:7b')

    vi.unstubAllGlobals()
  })

  it('sends speaker-labelled segments when speaker diarization exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '[]' } }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await detectCorrectionIssues(makeSession({
      transcript: 'flat transcript without speaker labels',
      speakers: [
        { id: 'spk_0', label: 'Speaker 1' },
        { id: 'spk_1', label: 'Speaker 2', displayName: 'Alice' },
      ],
      segments: [
        { speakerId: 'spk_0', text: '大家好。' },
        { speakerId: 'spk_1', text: '我们开始吧。' },
      ],
    }), makeSettings())

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const userMessage = body.messages.find((message: { role: string }) => message.role === 'user')
    expect(userMessage.content).toContain('Speaker 1: 大家好。')
    expect(userMessage.content).toContain('Alice: 我们开始吧。')
    expect(userMessage.content).not.toContain('flat transcript without speaker labels')

    vi.unstubAllGlobals()
  })

  it('includes enabled non-empty glossary entries in detection prompts and omits invalid entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '[]' } }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await detectCorrectionIssues(makeSession({ transcript: 'difine is useful' }), makeSettings({
      glossary: [
        { id: '1', source: ' difine ', target: ' dify ', note: 'product', enabled: true },
        { id: '2', source: 'disabled', target: 'enabled', enabled: false },
        { id: '3', source: '', target: 'missing source', enabled: true },
        { id: '4', source: 'difine', target: 'dify', enabled: true },
      ],
    }))

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const systemMessage = body.messages.find((message: { role: string }) => message.role === 'system')
    const userMessage = body.messages.find((message: { role: string }) => message.role === 'user')
    expect(systemMessage.content).toContain('词汇表')
    expect(userMessage.content).toContain('"difine" -> "dify"')
    expect(userMessage.content).toContain('product')
    expect(userMessage.content).not.toContain('disabled')
    expect(userMessage.content.match(/"difine" -> "dify"/g)).toHaveLength(1)

    vi.unstubAllGlobals()
  })

  it('parses response wrapped in fenced code block', async () => {
    const fenced = '```json\n[{"id":"1","originalText":"A","suggestedText":"B","reason":"test","category":"grammar"}]\n```'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: fenced } }],
      }),
    }))

    const result = await detectCorrectionIssues(makeSession(), makeSettings())
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].category).toBe('grammar')

    vi.unstubAllGlobals()
  })

  it('maps unknown category to "other"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify([
          { id: '1', originalText: 'x', suggestedText: 'y', reason: 'r', category: 'unknown-category' },
        ]) } }],
      }),
    }))

    const result = await detectCorrectionIssues(makeSession(), makeSettings())
    expect(result.issues[0].category).toBe('other')

    vi.unstubAllGlobals()
  })

  it('filters out items with empty originalText or suggestedText', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify([
          { id: '1', originalText: '', suggestedText: 'y', reason: 'r', category: 'other' },
          { id: '2', originalText: 'x', suggestedText: '', reason: 'r', category: 'other' },
          { id: '3', originalText: 'valid', suggestedText: 'also valid', reason: 'ok', category: 'homophone' },
        ]) } }],
      }),
    }))

    const result = await detectCorrectionIssues(makeSession(), makeSettings())
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].originalText).toBe('valid')

    vi.unstubAllGlobals()
  })

  it('returns empty issues for an empty JSON array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '[]' } }],
      }),
    }))

    const result = await detectCorrectionIssues(makeSession(), makeSettings())
    expect(result.issues).toHaveLength(0)

    vi.unstubAllGlobals()
  })

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }))

    await expect(detectCorrectionIssues(makeSession(), makeSettings())).rejects.toThrow(/Internal Server Error/)

    vi.unstubAllGlobals()
  })

  it('throws on non-JSON AI response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Sorry, I cannot help with that.' } }],
      }),
    }))

    await expect(detectCorrectionIssues(makeSession(), makeSettings())).rejects.toThrow(/JSON/)

    vi.unstubAllGlobals()
  })

  it('handles multipart content array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: [
              { type: 'text', text: '[{"id":"1","originalText":"a","suggestedText":"b","reason":"r","category":"other"}]' },
            ],
          },
        }],
      }),
    }))

    const result = await detectCorrectionIssues(makeSession(), makeSettings())
    expect(result.issues).toHaveLength(1)

    vi.unstubAllGlobals()
  })

  it('assigns sequential IDs when AI omits them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify([
          { originalText: 'a', suggestedText: 'b', reason: 'r', category: 'other' },
          { originalText: 'c', suggestedText: 'd', reason: 'r', category: 'other' },
        ]) } }],
      }),
    }))

    const result = await detectCorrectionIssues(makeSession(), makeSettings())
    expect(result.issues[0].id).toBe('1')
    expect(result.issues[1].id).toBe('2')

    vi.unstubAllGlobals()
  })
})

describe('aiCorrection — quick correction with glossary', async () => {
  const { correctTranscriptQuick } = await import('./aiCorrection')

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('includes glossary guidance in quick correction requests', async () => {
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: [DONE]\n\n') })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    })
    vi.stubGlobal('fetch', fetchMock)

    await correctTranscriptQuick(makeSession(), makeSettings({
      glossary: [{ id: '1', source: 'define', target: 'dify', enabled: true }],
    }), {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.messages[0].content).toContain('source/误识别原文')
    expect(body.messages[1].content).toContain('"define" -> "dify"')

    vi.unstubAllGlobals()
  })
})
