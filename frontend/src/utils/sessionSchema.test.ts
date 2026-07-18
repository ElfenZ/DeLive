import { describe, expect, it } from 'vitest'
import { CURRENT_SESSION_SCHEMA_VERSION, normalizeTranscriptSession } from './sessionSchema'

describe('sessionSchema', () => {
  it('normalizes ask history entries and citations', () => {
    const normalized = normalizeTranscriptSession({
      id: 'session-1',
      title: 'Session',
      date: '2026-03-10',
      time: '12:00',
      createdAt: 1,
      updatedAt: 2,
      transcript: 'Hello world',
      askHistory: [
        {
          id: 'turn-1',
          conversationId: 'conv-1',
          question: 'What happened?',
          answer: 'The team agreed to ship.',
          status: 'success',
          createdAt: 100,
          answeredAt: 200,
          citations: [
            { quote: 'We should ship it this week.', speakerLabel: 'Alice' },
          ],
        },
      ],
    })

    expect(normalized.askHistory).toEqual([
      {
        id: 'turn-1',
        conversationId: 'conv-1',
        question: 'What happened?',
        answer: 'The team agreed to ship.',
        status: 'success',
        createdAt: 100,
        answeredAt: 200,
        citations: [
          { quote: 'We should ship it this week.', speakerLabel: 'Alice' },
        ],
        sourceKind: 'legacy-unknown',
      },
    ])
  })

  it('normalizes mind map payloads', () => {
    const normalized = normalizeTranscriptSession({
      id: 'session-2',
      title: 'Mind Map Session',
      date: '2026-03-10',
      time: '12:10',
      createdAt: 1,
      updatedAt: 2,
      transcript: 'Hello world',
      mindMap: {
        markdown: '# Root\n## Branch',
        title: 'Root',
        status: 'success',
        generatedAt: 111,
        updatedAt: 222,
      },
    })

    expect(normalized.mindMap).toEqual({
      markdown: '# Root\n## Branch',
      title: 'Root',
      status: 'success',
      generatedAt: 111,
      updatedAt: 222,
      sourceKind: 'legacy-unknown',
    })
  })

  it('preserves source audio metadata and supports old sessions without it', () => {
    const normalized = normalizeTranscriptSession({
      id: 'session-3',
      title: 'Audio Session',
      date: '2026-07-05',
      time: '21:40',
      createdAt: 1,
      updatedAt: 2,
      transcript: 'Hello world',
      sourceMeta: {
        captureMode: 'microphone',
        platform: 'win32',
        providerMode: 'realtime',
        sourceKind: 'recording-audio',
        audioPath: 'C:/Users/test/AppData/Roaming/DeLive/media/session/source-audio.wav',
        audioMimeType: 'audio/wav',
        audioFileName: 'source-audio.wav',
        audioSize: 1234,
        captureAudioSource: 'microphone',
      },
    })

    expect(normalized.sourceMeta).toEqual({
      captureMode: 'microphone',
      platform: 'win32',
      providerMode: 'realtime',
      sourceId: undefined,
      sourceLabel: undefined,
      sourceKind: 'recording-audio',
      audioPath: 'C:/Users/test/AppData/Roaming/DeLive/media/session/source-audio.wav',
      audioMimeType: 'audio/wav',
      audioFileName: 'source-audio.wav',
      audioSize: 1234,
      captureAudioSource: 'microphone',
    })

    const oldSession = normalizeTranscriptSession({
      id: 'session-4',
      title: 'Old Session',
      date: '2026-07-05',
      time: '21:41',
      createdAt: 1,
      updatedAt: 2,
      transcript: 'Old transcript',
    })
    expect(oldSession.sourceMeta).toBeUndefined()
  })

  it('migrates v3 corrected text to an immutable legacy result idempotently', () => {
    const normalized = normalizeTranscriptSession({
      id: 'legacy-correction',
      schemaVersion: 3,
      title: 'Legacy',
      date: '2026-07-16',
      time: '12:00',
      createdAt: 1,
      updatedAt: 2,
      transcript: 'original',
      correction: {
        status: 'done',
        mode: 'quick',
        correctedText: 'corrected',
        model: 'legacy-model',
      },
    })
    expect(normalized.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    expect(normalized.correction?.legacy).toEqual(expect.objectContaining({ correctedText: 'corrected', source: 'v3-corrected-text' }))
    expect(normalized.correction?.published).toBeUndefined()
    expect(normalizeTranscriptSession(normalized)).toEqual(normalized)
  })

  it('drops corrupted drafts without activating partial progress', () => {
    const normalized = normalizeTranscriptSession({
      id: 'broken-draft',
      title: 'Broken',
      date: '2026-07-16',
      time: '12:00',
      createdAt: 1,
      updatedAt: 2,
      transcript: 'original',
      correction: {
        status: 'detecting',
        mode: 'review',
        draft: { runId: 'x', status: 'running' },
      } as never,
    })
    expect(normalized.correction?.draft).toBeUndefined()
    expect(normalized.correction?.status).toBe('error')
  })

  it('drops an otherwise valid draft when any persisted patch is corrupted', () => {
    const normalized = normalizeTranscriptSession({
      id: 'partially-corrupted-draft', title: 'Broken patch', date: '2026-07-16', time: '12:00',
      createdAt: 1, updatedAt: 2, transcript: 'original',
      correction: {
        status: 'detecting', mode: 'review',
        draft: {
          runId: 'run', revision: 1, trigger: 'manual-review', mode: 'review', status: 'running',
          baseTranscriptHash: 'hash', requestedAt: 1, updatedAt: 2,
          config: {
            model: 'm', baseUrl: 'http://localhost/v1', promptLanguage: 'zh', promptVersion: 'patch-v1', schemaVersion: '1',
            structuredOutput: 'prompt-json', temperature: 0.1, glossary: [], chunkSize: 4000, contextSize: 500,
            concurrency: 1, safetyLimits: { maxPatchTextLength: 1000, maxPatchesPerShard: 100, maxCumulativeEditRatio: 0.2, maxNetLengthChangeRatio: 0.1 },
            credentialRef: 'ai-post-process',
          },
          shards: [],
          proposedPatches: [
            { id: 'invalid-patch', op: 'replace' } as never,
          ],
          rejectedPatches: [],
        },
      },
    })
    expect(normalized.correction?.draft).toBeUndefined()
    expect(normalized.correction?.status).toBe('error')
  })

  it('drops semantically invalid active patches even when their shape is complete', () => {
    const invalidPatch = {
      id: 'semantic-invalid', shardId: 'shard-1', op: 'insert', sourceStart: 0, sourceEnd: 3,
      sourceText: 'bad', replacement: 'new', sourceTextHash: 'hash', category: 'asr-omission',
      reason: 'invalid insert', state: 'proposed',
    }
    const normalized = normalizeTranscriptSession({
      id: 'semantic-invalid-draft', title: 'Broken semantic patch', date: '2026-07-16', time: '12:00',
      createdAt: 1, updatedAt: 2, transcript: 'bad source',
      correction: {
        status: 'detecting', mode: 'review',
        draft: {
          runId: 'run', revision: 1, trigger: 'manual-review', mode: 'review', status: 'ready-for-review',
          baseTranscriptHash: 'hash', requestedAt: 1, updatedAt: 2,
          config: {
            model: 'm', baseUrl: 'http://localhost/v1', promptLanguage: 'zh', promptVersion: 'patch-v1', schemaVersion: '1',
            structuredOutput: 'prompt-json', temperature: 0.1, glossary: [], chunkSize: 4000, contextSize: 500,
            concurrency: 1, safetyLimits: { maxPatchTextLength: 1000, maxPatchesPerShard: 100, maxCumulativeEditRatio: 0.2, maxNetLengthChangeRatio: 0.1 },
            credentialRef: 'ai-post-process',
          },
          shards: [{ id: 'shard-1', index: 0, coreStart: 0, coreEnd: 10, contextStart: 0, contextEnd: 10, status: 'completed', attempt: 1, draftRevision: 1, patches: [invalidPatch] }],
          proposedPatches: [invalidPatch], rejectedPatches: [],
        },
      },
    } as never)
    expect(normalized.correction?.draft).toBeUndefined()
    expect(normalized.correction?.status).toBe('error')
  })

  it('round-trips valid automatic workflow state without creating it for old sessions', () => {
    const normalized = normalizeTranscriptSession({
      id: 'workflow-session', title: 'Workflow', date: '2026-07-18', time: '10:00',
      schemaVersion: 4, createdAt: 1, updatedAt: 2, transcript: 'content',
      autoPostProcessWorkflow: {
        version: 1,
        status: 'waiting-review',
        step: 'correction',
        correctionMode: 'review',
        titleAtStart: 'Workflow',
        startedAt: 10,
        updatedAt: 20,
      },
    })
    expect(normalized.schemaVersion).toBe(5)
    expect(normalized.autoPostProcessWorkflow).toEqual({
      version: 1,
      status: 'waiting-review',
      step: 'correction',
      correctionMode: 'review',
      titleAtStart: 'Workflow',
      startedAt: 10,
      updatedAt: 20,
      completedAt: undefined,
      error: undefined,
    })
    expect(normalizeTranscriptSession({
      id: 'old-session', title: 'Old', date: '2026-07-18', time: '10:00',
      schemaVersion: 4, createdAt: 1, updatedAt: 2, transcript: 'content',
    }).autoPostProcessWorkflow).toBeUndefined()
  })

  it('drops malformed automatic workflow state', () => {
    const normalized = normalizeTranscriptSession({
      id: 'bad-workflow', title: 'Bad', date: '2026-07-18', time: '10:00',
      createdAt: 1, updatedAt: 2, transcript: 'content',
      autoPostProcessWorkflow: { version: 1, status: 'running' } as never,
    })
    expect(normalized.autoPostProcessWorkflow).toBeUndefined()

    const invalidCombination = normalizeTranscriptSession({
      id: 'bad-combination', title: 'Bad', date: '2026-07-18', time: '10:00',
      createdAt: 1, updatedAt: 2, transcript: 'content',
      autoPostProcessWorkflow: {
        version: 1,
        status: 'completed',
        step: 'correction',
        correctionMode: 'quick',
        titleAtStart: 'Bad',
        startedAt: 1,
        updatedAt: 2,
      },
    })
    expect(invalidCombination.autoPostProcessWorkflow).toBeUndefined()
  })
})
