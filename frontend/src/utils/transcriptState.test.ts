import { describe, expect, it, vi } from 'vitest'
import {
  applyTranscriptEvent,
  buildSegmentsFromTokens,
  buildSpeakersFromTokens,
  createEmptyTranscriptRuntimeState,
  hasPostProcessContent,
} from './transcriptState'

describe('transcriptState', () => {
  it('derives speakers and segments from final tokens', () => {
    const tokens = [
      { text: 'Hello ', isFinal: true, speaker: 'speaker_1', language: 'en', startMs: 0, endMs: 400 },
      { text: 'world', isFinal: true, speaker: 'speaker_1', language: 'en', startMs: 400, endMs: 900 },
      { text: '你好', isFinal: true, speaker: 'speaker_2', language: 'zh', startMs: 900, endMs: 1300 },
    ]

    expect(buildSpeakersFromTokens(tokens)).toEqual([
      { id: 'speaker_1', label: 'speaker_1', displayName: 'speaker_1' },
      { id: 'speaker_2', label: 'speaker_2', displayName: 'speaker_2' },
    ])

    expect(buildSegmentsFromTokens(tokens)).toEqual([
      {
        text: 'Hello world',
        startMs: 0,
        endMs: 900,
        speakerId: 'speaker_1',
        language: 'en',
        isFinal: true,
      },
      {
        text: '你好',
        startMs: 900,
        endMs: 1300,
        speakerId: 'speaker_2',
        language: 'zh',
        isFinal: true,
      },
    ])
  })

  it('applies token events into a unified runtime state', () => {
    const initial = createEmptyTranscriptRuntimeState()

    const next = applyTranscriptEvent(initial, {
      type: 'tokens',
      tokens: [
        { text: 'Hello ', isFinal: true, speaker: 'speaker_1' },
        { text: 'world', isFinal: false },
        { text: 'Bonjour', isFinal: true, translationStatus: 'translation' },
        { text: ' le monde', isFinal: false, translationStatus: 'translation' },
      ],
    })

    expect(next.finalTranscript).toBe('Hello ')
    expect(next.nonFinalTranscript).toBe('world')
    expect(next.nonFinalTokens).toEqual([
      { text: 'world', isFinal: false },
      { text: ' le monde', isFinal: false, translationStatus: 'translation' },
    ])
    expect(next.currentTranscript).toBe('Hello world')
    expect(next.finalTranslatedTranscript).toBe('Bonjour')
    expect(next.nonFinalTranslatedTranscript).toBe(' le monde')
    expect(next.currentTranslatedTranscript).toBe('Bonjour le monde')
    expect(next.currentSpeakers).toHaveLength(1)
    expect(next.currentSegments).toHaveLength(1)
  })

  it('applies partial and final text events without going through token compatibility', () => {
    const withFinal = {
      ...createEmptyTranscriptRuntimeState(),
      finalTranscript: 'Hello ',
      currentTranscript: 'Hello ',
    }

    const withPartial = applyTranscriptEvent(withFinal, {
      type: 'partial-text',
      text: 'world',
    })
    expect(withPartial.nonFinalTranscript).toBe('world')
    expect(withPartial.currentTranscript).toBe('Hello world')

    const withCommittedFinal = applyTranscriptEvent(withPartial, {
      type: 'final-text',
      text: 'world.',
    })
    expect(withCommittedFinal.finalTranscript).toBe('Hello world.')
    expect(withCommittedFinal.nonFinalTranscript).toBe('')
    expect(withCommittedFinal.currentTranscript).toBe('Hello world.')
  })

  it('keeps visible partial text when an empty final payload arrives', () => {
    const withPartial = applyTranscriptEvent(createEmptyTranscriptRuntimeState(), {
      type: 'partial-text',
      text: 'Still visible',
    })

    const afterEmptyFinal = applyTranscriptEvent(withPartial, {
      type: 'final-text',
      text: '',
    })

    expect(afterEmptyFinal).toEqual(withPartial)
  })

  it('promotes text-provider interims at a timed-out pause boundary', () => {
    const withPartial = applyTranscriptEvent(createEmptyTranscriptRuntimeState(), {
      type: 'partial-text',
      text: 'Text provider interim',
    })

    const paused = applyTranscriptEvent(withPartial, {
      type: 'pause-boundary',
      promoteInterim: true,
    })

    expect(paused.finalTranscript).toBe('Text provider interim')
    expect(paused.nonFinalTranscript).toBe('')
    expect(paused.currentTranscript).toBe('Text provider interim')
  })

  it('promotes token and translation interims at a timed-out pause boundary', () => {
    const withInterims = applyTranscriptEvent(createEmptyTranscriptRuntimeState(), {
      type: 'tokens',
      tokens: [
        { text: 'Hello ', isFinal: true, speaker: 'speaker_1', startMs: 0, endMs: 400 },
        {
          text: 'world',
          isFinal: false,
          speaker: 'speaker_2',
          language: 'en',
          startMs: 400,
          endMs: 900,
          confidence: 0.92,
        },
        { text: '你好', isFinal: false, translationStatus: 'translation' },
      ],
    })

    const paused = applyTranscriptEvent(withInterims, {
      type: 'pause-boundary',
      promoteInterim: true,
    })

    expect(paused.finalTokens).toEqual([
      { text: 'Hello ', isFinal: true, speaker: 'speaker_1', startMs: 0, endMs: 400 },
      {
        text: 'world',
        isFinal: true,
        speaker: 'speaker_2',
        language: 'en',
        startMs: 400,
        endMs: 900,
        confidence: 0.92,
      },
    ])
    expect(paused.finalTranscript).toBe('Hello world')
    expect(paused.nonFinalTranscript).toBe('')
    expect(paused.finalTranslatedTranscript).toBe('你好')
    expect(paused.nonFinalTranslatedTranscript).toBe('')
    expect(paused.currentSegments).toEqual([
      {
        text: 'Hello ',
        startMs: 0,
        endMs: 400,
        speakerId: 'speaker_1',
        language: undefined,
        isFinal: true,
      },
      {
        text: 'world',
        startMs: 400,
        endMs: 900,
        speakerId: 'speaker_2',
        language: 'en',
        isFinal: true,
      },
    ])
    expect(paused.currentSpeakers).toEqual([
      { id: 'speaker_1', label: 'speaker_1', displayName: 'speaker_1' },
      { id: 'speaker_2', label: 'speaker_2', displayName: 'speaker_2' },
    ])
  })

  it('preserves translation interims for an empty final translation token', () => {
    const withTranslationInterim = applyTranscriptEvent(createEmptyTranscriptRuntimeState(), {
      type: 'tokens',
      tokens: [{ text: 'Hello', isFinal: false, translationStatus: 'translation' }],
    })

    const afterEmptyFinal = applyTranscriptEvent(withTranslationInterim, {
      type: 'tokens',
      tokens: [{ text: '', isFinal: true, translationStatus: 'translation' }],
    })

    expect(afterEmptyFinal.nonFinalTranslatedTranscript).toBe('Hello')
    expect(afterEmptyFinal.currentTranslatedTranscript).toBe('Hello')
    expect(afterEmptyFinal.nonFinalTokens).toEqual([
      { text: 'Hello', isFinal: false, translationStatus: 'translation' },
    ])
  })

  it('does not duplicate successful token finals and leaves a non-promoting boundary unchanged', () => {
    let state = applyTranscriptEvent(createEmptyTranscriptRuntimeState(), {
      type: 'tokens',
      tokens: [{ text: 'Completed text', isFinal: false, speaker: 'speaker_1' }],
    })
    state = applyTranscriptEvent(state, {
      type: 'tokens',
      tokens: [{ text: 'Completed text', isFinal: true, speaker: 'speaker_1' }],
    })

    const afterSuccessfulDrain = applyTranscriptEvent(state, {
      type: 'pause-boundary',
      promoteInterim: true,
    })
    const nonPromotingBoundary = applyTranscriptEvent(afterSuccessfulDrain, {
      type: 'pause-boundary',
    })

    expect(afterSuccessfulDrain.finalTranscript).toBe('Completed text')
    expect(nonPromotingBoundary).toBe(afterSuccessfulDrain)
  })

  it('appends each resumed interim once without adding pause markers', () => {
    let state = createEmptyTranscriptRuntimeState()

    state = applyTranscriptEvent(state, {
      type: 'tokens',
      tokens: [{ text: 'First ', isFinal: false, speaker: 'speaker_1', startMs: 0, endMs: 500 }],
    })
    state = applyTranscriptEvent(state, { type: 'pause-boundary', promoteInterim: true })
    state = applyTranscriptEvent(state, {
      type: 'tokens',
      tokens: [{ text: 'second.', isFinal: false, speaker: 'speaker_2', startMs: 500, endMs: 1100 }],
    })
    state = applyTranscriptEvent(state, { type: 'pause-boundary', promoteInterim: true })

    expect(state.finalTranscript).toBe('First second.')
    expect(state.currentTranscript).toBe('First second.')
    expect(state.finalTokens).toHaveLength(2)
    expect(state.currentSegments).toHaveLength(2)
    expect(state.finalTranscript).not.toContain('---')
    expect(state.finalTranscript).not.toContain('pause')
  })

  it('preserves text from prior providers after config-change + tokens', () => {
    let state = createEmptyTranscriptRuntimeState()

    state = applyTranscriptEvent(state, {
      type: 'tokens',
      tokens: [{ text: 'Hello from Soniox. ', isFinal: true, speaker: 's1' }],
    })
    expect(state.finalTranscript).toBe('Hello from Soniox. ')

    state = applyTranscriptEvent(state, {
      type: 'config-change',
      description: 'Provider: soniox → volcengine',
    })
    expect(state.finalTranscript).toContain('Hello from Soniox. ')
    expect(state.finalTranscript).toContain('Provider: soniox → volcengine')
    expect(state.finalTokens).toHaveLength(0)

    state = applyTranscriptEvent(state, { type: 'final-text', text: '火山引擎的文本。' })
    expect(state.finalTranscript).toContain('火山引擎的文本。')

    state = applyTranscriptEvent(state, {
      type: 'config-change',
      description: 'Provider: volcengine → soniox',
    })
    expect(state.finalTranscript).toContain('Hello from Soniox. ')
    expect(state.finalTranscript).toContain('火山引擎的文本。')

    state = applyTranscriptEvent(state, {
      type: 'tokens',
      tokens: [{ text: 'New Soniox text', isFinal: true, speaker: 's1' }],
    })
    expect(state.finalTranscript).toContain('Hello from Soniox. ')
    expect(state.finalTranscript).toContain('火山引擎的文本。')
    expect(state.finalTranscript).toContain('New Soniox text')
  })

  it('preserves non-final (partial) text from providers on config-change', () => {
    let state = createEmptyTranscriptRuntimeState()

    state = applyTranscriptEvent(state, { type: 'partial-text', text: '火山引擎的非确认文本。' })
    expect(state.nonFinalTranscript).toBe('火山引擎的非确认文本。')
    expect(state.finalTranscript).toBe('')
    expect(state.currentTranscript).toBe('火山引擎的非确认文本。')

    state = applyTranscriptEvent(state, {
      type: 'config-change',
      description: 'Provider: volcengine → soniox',
    })
    expect(state.finalTranscript).toContain('火山引擎的非确认文本。')
    expect(state.nonFinalTranscript).toBe('')

    state = applyTranscriptEvent(state, {
      type: 'tokens',
      tokens: [{ text: 'New from Soniox', isFinal: true, speaker: 's1' }],
    })
    expect(state.finalTranscript).toContain('火山引擎的非确认文本。')
    expect(state.finalTranscript).toContain('New from Soniox')
  })

  it('merges post-process patches and reports content correctly', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-09T12:00:00Z'))

    const state = applyTranscriptEvent(createEmptyTranscriptRuntimeState(), {
      type: 'post-process',
      patch: {
        summary: 'Key points',
        actionItems: ['Ship P0 transcript reducer'],
      },
    })

    expect(state.currentPostProcess).toEqual({
      summary: 'Key points',
      actionItems: ['Ship P0 transcript reducer'],
      generatedAt: new Date('2026-03-09T12:00:00Z').getTime(),
    })
    expect(hasPostProcessContent(state.currentPostProcess)).toBe(true)
    expect(hasPostProcessContent(undefined)).toBe(false)

    vi.useRealTimers()
  })
})
