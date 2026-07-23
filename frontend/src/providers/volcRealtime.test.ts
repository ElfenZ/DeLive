import { describe, expect, it } from 'vitest'
import { VolcProvider } from './implementations/VolcProvider'
import { SonioxProvider } from './implementations/SonioxProvider'
import { applyTranscriptEvent, createEmptyTranscriptRuntimeState } from '../utils/transcriptState'
import { buildProviderFormState } from '../utils/providerConfigForm'
import {
  buildVolcProxySearchParams,
  createVolcRealtimeState,
  reduceVolcRealtimeMessage,
} from './volcRealtime'

function utteranceMessage(
  type: 'partial' | 'final',
  utterances: Array<Record<string, unknown>>,
  text = 'fallback text must not be emitted with tokens',
) {
  return { type, text, raw: { result: { text, utterances } } }
}

describe('Volc realtime request and capabilities', () => {
  it('propagates the switch and preserves fixed V2 connection settings', () => {
    const enabled = buildVolcProxySearchParams({
      appKey: 'app',
      accessKey: 'token',
      enableSpeakerDiarization: true,
    })
    const disabled = buildVolcProxySearchParams({
      appKey: 'app',
      accessKey: 'token',
      enableSpeakerDiarization: false,
    })
    expect(enabled.get('enableSpeakerDiarization')).toBe('true')
    expect(disabled.get('enableSpeakerDiarization')).toBe('false')
    expect(enabled.get('modelV2')).toBe('true')
    expect(enabled.get('bidiStreaming')).toBe('true')
  })

  it('declares diarization, connection-relative timestamps, and a warning-free default-off field', () => {
    const info = new VolcProvider().info
    const field = info.configFields.find(
      (candidate) => candidate.key === 'enableSpeakerDiarization',
    )
    expect(info.capabilities).toMatchObject({
      supportsSpeakerDiarization: true,
      timestamps: {
        supportsTokenTimestamps: true,
        supportsSegmentTimestamps: true,
        tokenTimestampOrigin: 'connection-relative',
      },
    })
    expect(field).toMatchObject({
      type: 'boolean',
      required: false,
      defaultValue: false,
    })
    expect(field?.warning).toBeUndefined()
    expect(field?.warningWhen).toBeUndefined()
    expect(buildProviderFormState(info, { appKey: 'app', accessKey: 'token' }, {
      apiKey: '',
      languageHints: ['zh', 'en'],
    }).enableSpeakerDiarization).toBe(false)
  })

  it('leaves Soniox diarization metadata and endpoint warning unchanged', () => {
    expect(new SonioxProvider().info.configFields.find(
      (field) => field.key === 'enableSpeakerDiarization',
    )).toMatchObject({
      defaultValue: false,
      description: '开启后，Soniox 会返回按说话人区分的转录结果。',
      warning: '同时启用端点检测与说话人识别可能影响说话人区分准确率。',
      warningWhen: { fieldKey: 'enableEndpointDetection', equals: true },
    })
  })
})

describe('Volc realtime response reduction', () => {
  it('keeps the original text path when the switch is disabled', () => {
    const partial = reduceVolcRealtimeMessage(createVolcRealtimeState(false), utteranceMessage('partial', [
      { text: 'token', definite: true, speaker: 1 },
    ], 'plain partial'))
    const final = reduceVolcRealtimeMessage(partial.state, utteranceMessage('final', [
      { text: 'token', definite: true, speaker: 1 },
    ], 'plain final'))
    expect(partial.event).toEqual({ type: 'partial-text', text: 'plain partial' })
    expect(final.event).toEqual({ type: 'final-text', text: 'plain final' })
    expect(final.terminal).toBe(true)
  })

  it('clears utterance-free text interim on an empty fallback snapshot', () => {
    let transcriptState = createEmptyTranscriptRuntimeState()
    const partial = reduceVolcRealtimeMessage(createVolcRealtimeState(true), {
      type: 'partial',
      text: 'draft',
    })
    expect(partial.event).toEqual({ type: 'partial-text', text: 'draft' })
    if (partial.event) transcriptState = applyTranscriptEvent(transcriptState, partial.event)

    const terminal = reduceVolcRealtimeMessage(partial.state, { type: 'final', text: '' })
    expect(terminal.event).toEqual({ type: 'partial-text', text: '' })
    if (terminal.event) transcriptState = applyTranscriptEvent(transcriptState, terminal.event)
    expect(transcriptState.currentTranscript).toBe('')
    expect(terminal.terminal).toBe(true)
  })

  it('does not append unrelated top-level text through a one-character overlap', () => {
    const result = reduceVolcRealtimeMessage(createVolcRealtimeState(true), utteranceMessage('partial', [
      { text: 'hello', start_time: 0, end_time: 100, definite: false, speaker: 1 },
    ], 'orange'))
    expect(result.event).toEqual({
      type: 'tokens',
      tokens: [{ text: 'hello', isFinal: false, startMs: 0, endMs: 100, speaker: '1' }],
    })
  })

  it('normalizes string, number, null, and invalid speakers plus timestamps', () => {
    const result = reduceVolcRealtimeMessage(createVolcRealtimeState(true), utteranceMessage('partial', [
      { text: 'A', start_time: 0, end_time: 100, definite: true, speaker: ' guest ' },
      { text: 'B', start_time: '100', end_time: '200', definite: false, speaker: 2 },
      { text: 'C', start_time: 200, end_time: 300, definite: false, speaker: null },
      { text: 'D', start_time: -1, end_time: 'bad', definite: false, speaker: { id: 3 } },
      { text: 'E', start_time: 300, end_time: 400, definite: false, additions: { speaker_id: 0 } },
      { text: 'F', start_time: 400, end_time: 500, definite: false, speaker_id: 'speaker-2' },
    ]))
    expect(result.event).toEqual({
      type: 'tokens',
      tokens: [
        { text: 'A', isFinal: true, startMs: 0, endMs: 100, speaker: 'guest' },
        { text: 'B', isFinal: false, startMs: 100, endMs: 200, speaker: '2' },
        { text: 'C', isFinal: false, startMs: 200, endMs: 300, speaker: undefined },
        { text: 'D', isFinal: false, startMs: undefined, endMs: undefined, speaker: undefined },
        { text: 'E', isFinal: false, startMs: 300, endMs: 400, speaker: '0' },
        { text: 'F', isFinal: false, startMs: 400, endMs: 500, speaker: 'speaker-2' },
      ],
    })
  })

  it('replaces interim hypotheses, deduplicates cumulative finals, and finalizes terminal utterances', () => {
    let providerState = createVolcRealtimeState(true)
    let transcriptState = createEmptyTranscriptRuntimeState()

    for (const message of [
      utteranceMessage('partial', [
        { text: '甲。', start_time: 0, end_time: 500, definite: true, speaker: 1 },
        { text: '乙', start_time: 500, end_time: 800, definite: false, speaker: 2 },
      ]),
      utteranceMessage('partial', [
        { text: '甲。', start_time: 0, end_time: 500, definite: true, speaker: 1 },
        { text: '乙更新', start_time: 500, end_time: 900, definite: false, speaker: 2 },
      ]),
    ]) {
      const reduction = reduceVolcRealtimeMessage(providerState, message)
      providerState = reduction.state
      if (reduction.event?.type === 'tokens') transcriptState = applyTranscriptEvent(transcriptState, reduction.event)
    }
    expect(transcriptState.finalTranscript).toBe('甲。')
    expect(transcriptState.nonFinalTranscript).toBe('乙更新')

    const terminal = reduceVolcRealtimeMessage(providerState, utteranceMessage('final', [
      { text: '甲。', start_time: 0, end_time: 500, definite: true, speaker: 1 },
      { text: '乙更新。', start_time: 500, end_time: 1000, definite: false, speaker: 2 },
    ]))
    expect(terminal.terminal).toBe(true)
    expect(terminal.event).toEqual({
      type: 'tokens',
      tokens: [{ text: '乙更新。', isFinal: true, startMs: 500, endMs: 1000, speaker: '2' }],
    })
    if (terminal.event?.type === 'tokens') transcriptState = applyTranscriptEvent(transcriptState, terminal.event)
    expect(transcriptState.finalTranscript).toBe('甲。乙更新。')
    expect(transcriptState.nonFinalTranscript).toBe('')

    const duplicate = reduceVolcRealtimeMessage(terminal.state, utteranceMessage('final', [
      { text: '甲。', start_time: 0, end_time: 500, definite: true, speaker: 1 },
      { text: '乙更新。', start_time: 500, end_time: 1000, definite: true, speaker: 2 },
    ]))
    expect(duplicate.event).toEqual({ type: 'tokens', tokens: [] })
  })

  it('falls back without utterances and stays on token events after token mode begins', () => {
    const plainFinal = reduceVolcRealtimeMessage(createVolcRealtimeState(true), { type: 'final', text: '你好' })
    expect(plainFinal.event).toEqual({ type: 'final-text', text: '你好' })

    const tokenResult = reduceVolcRealtimeMessage(createVolcRealtimeState(true), utteranceMessage('partial', [
      { text: '你好', start_time: 0, end_time: 500, definite: true, speaker: 1 },
    ]))
    const fallback = reduceVolcRealtimeMessage(tokenResult.state, {
      type: 'final',
      text: '你好世界',
      raw: { result: { text: '你好世界' } },
    })
    expect(fallback.event).toEqual({ type: 'tokens', tokens: [{ text: '世界', isFinal: true }] })
  })

  it('clears a retracted interim when the latest cumulative snapshot contains only committed finals', () => {
    let providerState = createVolcRealtimeState(true)
    let transcriptState = createEmptyTranscriptRuntimeState()

    const initial = reduceVolcRealtimeMessage(providerState, utteranceMessage('partial', [
      { text: '已确认。', start_time: 0, end_time: 500, definite: true, speaker: 1 },
      { text: '待撤回', start_time: 500, end_time: 900, definite: false, speaker: 2 },
    ], '已确认。待撤回'))
    providerState = initial.state
    if (initial.event?.type === 'tokens') transcriptState = applyTranscriptEvent(transcriptState, initial.event)
    expect(transcriptState.nonFinalTranscript).toBe('待撤回')

    const retracted = reduceVolcRealtimeMessage(providerState, utteranceMessage('partial', [
      { text: '已确认。', start_time: 0, end_time: 500, definite: true, speaker: 1 },
    ], '已确认。'))
    expect(retracted.event).toEqual({ type: 'tokens', tokens: [] })
    if (retracted.event?.type === 'tokens') transcriptState = applyTranscriptEvent(transcriptState, retracted.event)
    expect(transcriptState.finalTranscript).toBe('已确认。')
    expect(transcriptState.nonFinalTranscript).toBe('')
  })

  it('emits an uncovered terminal text tail as a final token after valid utterances', () => {
    const first = reduceVolcRealtimeMessage(createVolcRealtimeState(true), utteranceMessage('partial', [
      { text: '你好', start_time: 0, end_time: 500, definite: true, speaker: 1 },
    ], '你好'))
    const terminal = reduceVolcRealtimeMessage(first.state, utteranceMessage('final', [
      { text: '你好', start_time: 0, end_time: 500, definite: true, speaker: 1 },
    ], '你好世界'))
    expect(terminal.event).toEqual({
      type: 'tokens',
      tokens: [{ text: '世界', isFinal: true }],
    })
  })

  it('deduplicates a repeated incremental final payload with an uncovered tail', () => {
    const first = reduceVolcRealtimeMessage(createVolcRealtimeState(true), utteranceMessage('partial', [
      { text: 'A', start_time: 0, end_time: 100, definite: true, speaker: 1 },
    ], 'A'))
    const terminalMessage = utteranceMessage('final', [
      { text: 'B', start_time: 100, end_time: 200, definite: true, speaker: 2 },
    ], 'B-tail')
    const terminal = reduceVolcRealtimeMessage(first.state, terminalMessage)
    expect(terminal.event).toEqual({
      type: 'tokens',
      tokens: [
        { text: 'B', isFinal: true, startMs: 100, endMs: 200, speaker: '2' },
        { text: '-tail', isFinal: true },
      ],
    })
    expect(terminal.state.committedText).toBe('AB-tail')

    const duplicate = reduceVolcRealtimeMessage(terminal.state, terminalMessage)
    expect(duplicate.event).toEqual({ type: 'tokens', tokens: [] })
    expect(duplicate.state.committedText).toBe('AB-tail')
  })

  it('clears token-mode interim text when an utterance-free fallback retracts it', () => {
    let transcriptState = createEmptyTranscriptRuntimeState()
    const initial = reduceVolcRealtimeMessage(createVolcRealtimeState(true), utteranceMessage('partial', [
      { text: '已确认。', start_time: 0, end_time: 500, definite: true, speaker: 1 },
      { text: '临时尾部', start_time: 500, end_time: 900, definite: false, speaker: 2 },
    ], '已确认。临时尾部'))
    if (initial.event?.type === 'tokens') transcriptState = applyTranscriptEvent(transcriptState, initial.event)

    const fallback = reduceVolcRealtimeMessage(initial.state, {
      type: 'partial',
      text: '已确认。',
      raw: { result: { text: '已确认。' } },
    })
    expect(fallback.event).toEqual({ type: 'tokens', tokens: [] })
    if (fallback.event?.type === 'tokens') transcriptState = applyTranscriptEvent(transcriptState, fallback.event)
    expect(transcriptState.finalTranscript).toBe('已确认。')
    expect(transcriptState.nonFinalTranscript).toBe('')
  })

  it('reconciles overlap in utterance-free incremental partial and final payloads', () => {
    const initial = reduceVolcRealtimeMessage(createVolcRealtimeState(true), utteranceMessage('partial', [
      { text: 'AB', start_time: 0, end_time: 200, definite: true, speaker: 1 },
    ], 'AB'))
    const incrementalMessage = {
      text: 'B-tail',
      raw: { result: { text: 'B-tail' } },
    }

    const partial = reduceVolcRealtimeMessage(initial.state, { type: 'partial', ...incrementalMessage })
    expect(partial.event).toEqual({
      type: 'tokens',
      tokens: [{ text: '-tail', isFinal: false }],
    })

    const terminal = reduceVolcRealtimeMessage(partial.state, { type: 'final', ...incrementalMessage })
    expect(terminal.event).toEqual({
      type: 'tokens',
      tokens: [{ text: '-tail', isFinal: true }],
    })
    expect(terminal.state.committedText).toBe('AB-tail')

    const duplicate = reduceVolcRealtimeMessage(terminal.state, { type: 'final', ...incrementalMessage })
    expect(duplicate.event).toEqual({ type: 'tokens', tokens: [] })
    expect(duplicate.state.committedText).toBe('AB-tail')
  })

  it('resets deduplication and mode for every new connection state', () => {
    const message = utteranceMessage('final', [
      { text: '可再次提交', start_time: 0, end_time: 500, definite: true, speaker: 1 },
    ])
    const first = reduceVolcRealtimeMessage(createVolcRealtimeState(true), message)
    expect(reduceVolcRealtimeMessage(first.state, message).event).toEqual({ type: 'tokens', tokens: [] })
    expect(reduceVolcRealtimeMessage(createVolcRealtimeState(true), message).event).toMatchObject({
      type: 'tokens',
      tokens: [{ text: '可再次提交' }],
    })
  })
})
