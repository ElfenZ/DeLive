import { describe, expect, it } from 'vitest'
import { normalizeTranscriptSession } from './sessionSchema'

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
})
