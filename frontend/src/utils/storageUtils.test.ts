import { describe, expect, it } from 'vitest'
import type { TranscriptSession } from '../types'
import { buildCorrectedTranscriptMarkdown } from './storageUtils'

describe('buildCorrectedTranscriptMarkdown', () => {
  it('builds the same titled Markdown body used by corrected exports', () => {
    const session: TranscriptSession = {
      id: 's1',
      title: 'Final title',
      date: '2026-07-28',
      time: '16:00',
      createdAt: 1,
      updatedAt: 1,
      transcript: '原稿',
      correction: {
        status: 'done',
        mode: 'quick',
        published: {
          id: 'result-1',
          formatVersion: 1,
          revision: 1,
          correctedText: '纠错稿',
          baseTranscriptHash: 'hash',
          outputTextHash: 'output-hash',
          patches: [],
          model: 'model',
          completedAt: 2,
          stats: { applied: 0, reverted: 0, rejected: 0 },
        },
      },
    }

    expect(buildCorrectedTranscriptMarkdown(session, '纠错后')).toBe([
      '# Final title (纠错后)',
      '',
      '> 2026-07-28 16:00',
      '',
      '---',
      '',
      '纠错稿',
      '',
    ].join('\n'))
  })
})
