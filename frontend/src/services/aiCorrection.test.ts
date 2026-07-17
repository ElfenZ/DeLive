import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, TranscriptSession } from '../types'
import { createCorrectionShards } from '../utils/correctionPatch'
import {
  CorrectionRequestError,
  buildCorrectionRequestBody,
  createCorrectionConfigSnapshot,
  detectCorrectionIssues,
  normalizeAiCorrectionGlossary,
  requestCorrectionShard,
} from './aiCorrection'

function session(transcript = '需要侍应新的工作。'): TranscriptSession {
  return {
    id: 'session-1',
    title: 'Session',
    date: '2026-07-16',
    time: '12:00',
    createdAt: 1,
    updatedAt: 1,
    transcript,
  }
}

function settings(overrides: Partial<NonNullable<AppSettings['aiPostProcess']>> = {}): AppSettings {
  return {
    apiKey: '',
    languageHints: [],
    aiPostProcess: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1/',
      defaultModel: 'qwen',
      promptLanguage: 'zh',
      correctionStructuredOutput: 'prompt-json',
      ...overrides,
    },
  }
}

function response(content: string, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
    text: async () => content,
  }
}

const validPatch = {
  op: 'replace',
  oldText: '侍应',
  replacement: '适应',
  before: '需要',
  after: '新的',
  category: 'homophone',
  reason: '同音误识别',
}

describe('aiCorrection config and body', () => {
  it('validates configuration and snapshots without credentials', () => {
    const snapshot = createCorrectionConfigSnapshot(settings({ apiKey: 'secret' }))
    expect(snapshot.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(snapshot.concurrency).toBe(1)
    expect(snapshot).not.toHaveProperty('apiKey')
    expect(snapshot.credentialRef).toBe('ai-post-process')
  })

  it('normalizes and deduplicates glossary entries', () => {
    expect(normalizeAiCorrectionGlossary([
      { id: '1', source: ' difine ', target: ' Dify ', enabled: true },
      { id: '2', source: 'difine', target: 'dify', enabled: true },
      { id: '3', source: 'disabled', target: 'x', enabled: false },
    ])).toEqual([{ id: '1', source: 'difine', target: 'Dify', enabled: true, note: undefined }])
  })

  it.each([
    ['prompt-json', undefined],
    ['json_object', 'json_object'],
    ['json_schema', 'json_schema'],
  ] as const)('builds %s response format without streaming', (mode, expected) => {
    const transcript = 'before CORE after'
    const snapshot = createCorrectionConfigSnapshot(settings({ correctionStructuredOutput: mode }))
    const body = buildCorrectionRequestBody({
      transcript,
      shard: { id: 's', index: 0, contextStart: 0, coreStart: 7, coreEnd: 11, contextEnd: transcript.length },
      snapshot,
    })
    expect(body.stream).toBe(false)
    expect((body.response_format as { type?: string } | undefined)?.type).toBe(expected)
    const user = (body.messages as Array<{ role: string; content: string }>)[1].content
    expect(user).toContain('<EDITABLE_CORE>\nCORE\n</EDITABLE_CORE>')
    expect(user).toContain('<READ_ONLY_BEFORE>\nbefore ')
  })
})

describe('aiCorrection transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('parses strict patches and extracts usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(JSON.stringify({ patches: [validPatch] }))))
    const transcript = session().transcript
    const result = await requestCorrectionShard({
      transcript,
      shard: createCorrectionShards(transcript)[0],
      snapshot: createCorrectionConfigSnapshot(settings()),
    })
    expect(result.patches).toEqual([validPatch])
    expect(result.usage?.totalTokens).toBe(30)
    expect(result.attempt).toBe(1)
  })

  it('never sends the safe-storage placeholder as an authorization token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify({ patches: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const transcript = session().transcript
    await requestCorrectionShard({
      transcript,
      shard: createCorrectionShards(transcript)[0],
      snapshot: createCorrectionConfigSnapshot(settings()),
      apiKey: '{{SAFE_STORAGE}}',
    })
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })

  it('retries 429 and respects Retry-After', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response('busy', 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(response(JSON.stringify({ patches: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const transcript = session().transcript
    const promise = requestCorrectionShard({
      transcript,
      shard: createCorrectionShards(transcript)[0],
      snapshot: createCorrectionConfigSnapshot(settings()),
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(promise).resolves.toMatchObject({ attempt: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 403, 404])('does not retry HTTP %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(response('bad request', status))
    vi.stubGlobal('fetch', fetchMock)
    const transcript = session().transcript
    await expect(requestCorrectionShard({
      transcript,
      shard: createCorrectionShards(transcript)[0],
      snapshot: createCorrectionConfigSnapshot(settings()),
    })).rejects.toBeInstanceOf(CorrectionRequestError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not downgrade json_schema after a protocol error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('unsupported response_format', 400))
    vi.stubGlobal('fetch', fetchMock)
    const transcript = session().transcript
    await expect(requestCorrectionShard({
      transcript,
      shard: createCorrectionShards(transcript)[0],
      snapshot: createCorrectionConfigSnapshot(settings({ correctionStructuredOutput: 'json_schema' })),
    })).rejects.toMatchObject({ code: 'protocol' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry invalid structured responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('{"patches":[]} trailing'))
    vi.stubGlobal('fetch', fetchMock)
    const transcript = session().transcript
    await expect(requestCorrectionShard({
      transcript,
      shard: createCorrectionShards(transcript)[0],
      snapshot: createCorrectionConfigSnapshot(settings()),
    })).rejects.toMatchObject({ code: 'parse' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('enforces the endpoint concurrency limit across queued shard requests', async () => {
    let releaseFirst!: () => void
    const firstResponse = new Promise<ReturnType<typeof response>>((resolve) => {
      releaseFirst = () => resolve(response(JSON.stringify({ patches: [] })))
    })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(response(JSON.stringify({ patches: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const transcript = session().transcript
    const snapshot = { ...createCorrectionConfigSnapshot(settings()), concurrency: 1 }
    const shard = createCorrectionShards(transcript)[0]
    const first = requestCorrectionShard({ transcript, shard, snapshot })
    const second = requestCorrectionShard({ transcript, shard, snapshot })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the compatibility detector on canonical transcript text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify({ patches: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const source = session('raw\r\ntranscript')
    source.segments = [{ text: 'different segment', speakerId: 'speaker-1' }]
    await detectCorrectionIssues(source, settings())
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.messages[1].content).toContain('raw\r\ntranscript')
    expect(body.messages[1].content).not.toContain('different segment')
  })
})
