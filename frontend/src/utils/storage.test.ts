import { describe, it, expect } from 'vitest'
import type { TranscriptSession } from '../types'
import { formatDate, formatTime, validateBackupData } from './storage'
import { buildAiAnalysisMarkdown, buildAiAnalysisTxt, buildTranscriptExportBody } from './storageUtils'

describe('formatDate', () => {
  it('formats timestamp as YYYY-MM-DD', () => {
    const ts = new Date('2026-03-07T14:30:00Z').getTime()
    expect(formatDate(ts)).toBe('2026-03-07')
  })

  it('handles midnight correctly', () => {
    const ts = new Date('2026-01-01T00:00:00Z').getTime()
    expect(formatDate(ts)).toBe('2026-01-01')
  })

  it('pads single-digit months and days', () => {
    const ts = new Date('2026-02-05T12:00:00Z').getTime()
    expect(formatDate(ts)).toBe('2026-02-05')
  })
})

describe('formatTime', () => {
  it('formats timestamp as HH:mm', () => {
    const ts = new Date('2026-03-07T14:30:00').getTime()
    expect(formatTime(ts)).toBe('14:30')
  })

  it('pads single-digit hours', () => {
    const ts = new Date('2026-03-07T03:05:00').getTime()
    expect(formatTime(ts)).toBe('03:05')
  })
})

describe('validateBackupData', () => {
  it('returns true for valid backup data', () => {
    expect(validateBackupData({
      version: '1.0',
      exportedAt: '2026-03-07',
      sessions: [],
      tags: [],
      settings: { apiKey: '', languageHints: [] },
    })).toBe(true)
  })

  it('returns false for null', () => {
    expect(validateBackupData(null)).toBe(false)
  })

  it('returns false for non-object', () => {
    expect(validateBackupData('string')).toBe(false)
    expect(validateBackupData(42)).toBe(false)
  })

  it('returns false when version is missing', () => {
    expect(validateBackupData({
      sessions: [],
      tags: [],
      settings: {},
    })).toBe(false)
  })

  it('returns false when sessions is not array', () => {
    expect(validateBackupData({
      version: '1.0',
      sessions: 'not-array',
      tags: [],
      settings: {},
    })).toBe(false)
  })

  it('returns false when tags is not array', () => {
    expect(validateBackupData({
      version: '1.0',
      sessions: [],
      tags: 'not-array',
      settings: {},
    })).toBe(false)
  })

  it('returns false when settings is not object', () => {
    expect(validateBackupData({
      version: '1.0',
      sessions: [],
      tags: [],
      settings: 'not-object',
    })).toBe(false)
  })

  it('returns true even with extra fields', () => {
    expect(validateBackupData({
      version: '1.0',
      exportedAt: '2026-03-07',
      sessions: [{ id: '1' }],
      tags: [{ id: '1', name: 'tag' }],
      settings: { apiKey: 'key' },
      extraField: 'allowed',
    })).toBe(true)
  })
})

describe('AI analysis export formatters', () => {
  const baseSession: TranscriptSession = {
    id: 'session-1',
    title: 'Planning Call',
    date: '2026-07-05',
    time: '21:30',
    createdAt: 1,
    updatedAt: 2,
    transcript: 'raw transcript',
    segments: [],
    speakers: [],
    status: 'completed',
  }

  it('builds TXT with available post-process sections and omits empty sections', () => {
    const output = buildAiAnalysisTxt({
      ...baseSession,
      postProcess: {
        status: 'success',
        summary: 'Ship the feature.',
        actionItems: ['Add tests', ''],
        keywords: ['AI', 'export'],
        chapters: [{ title: 'Intro', summary: 'Scope' }, { title: '', summary: '' }],
        titleSuggestion: 'Feature Plan',
        tagSuggestions: ['release'],
        model: 'qwen',
        requestedAt: 1000,
        generatedAt: 2000,
      },
      mindMap: { markdown: '# Mind map' },
      askHistory: [{ id: 'q1', question: 'Q?', createdAt: 1, status: 'success', answer: 'A' }],
    })

    expect(output).toContain('标题: Planning Call')
    expect(output).toContain('摘要')
    expect(output).toContain('Ship the feature.')
    expect(output).toContain('1. Add tests')
    expect(output).toContain('关键词')
    expect(output).toContain('AI, export')
    expect(output).toContain('章节')
    expect(output).toContain('1. Intro')
    expect(output).toContain('标签建议')
    expect(output).not.toContain('Mind map')
    expect(output).not.toContain('Q?')
  })

  it('builds Markdown only for successful useful AI analysis', () => {
    expect(buildAiAnalysisMarkdown({
      ...baseSession,
      postProcess: { status: 'pending', summary: 'Not ready' },
    })).toBe('')

    const output = buildAiAnalysisMarkdown({
      ...baseSession,
      postProcess: {
        status: 'success',
        summary: 'Ready',
        actionItems: [],
        keywords: ['planning'],
      },
    })

    expect(output).toContain('# Planning Call AI Analysis')
    expect(output).toContain('## Summary')
    expect(output).toContain('Ready')
    expect(output).toContain('## Keywords')
    expect(output).not.toContain('## Action Items')
  })
})

describe('transcript export body', () => {
  const baseSession: TranscriptSession = {
    id: 'speaker-export',
    title: 'Speaker export',
    date: '2026-07-16',
    time: '20:00',
    createdAt: 1,
    updatedAt: 2,
    transcript: '第一段。 第二段。',
    segments: [
      { text: '第一段。', speakerId: '1', startMs: 0 },
      { text: '第二段。', speakerId: '2', startMs: 5_000 },
    ],
    speakers: [
      { id: '1', label: '主持人' },
      { id: '2', label: '参会者' },
    ],
  }

  it('preserves safely aligned speaker labels and timestamps', () => {
    expect(buildTranscriptExportBody(baseSession, 'txt')).toContain('S1\n主持人\n0:00\n第一段。')
    expect(buildTranscriptExportBody(baseSession, 'markdown')).toContain('### S2 · 参会者 · 0:05')
  })

  it('falls back to the complete canonical transcript when segments cannot align', () => {
    expect(buildTranscriptExportBody({
      ...baseSession,
      transcript: '完整原文',
      segments: [{ text: '不匹配', speakerId: '1' }],
    }, 'txt')).toBe('完整原文')
  })
})
