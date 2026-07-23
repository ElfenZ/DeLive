import { describe, expect, it } from 'vitest'
import {
  buildVolcAuthHeaders,
  buildVolcFullClientRequest,
  parseVolcProxyConfig,
  resolveVolcResourceId,
  summarizeVolcResponseForDiagnostics,
} from '../../../shared/volcProxyConfig'

function requestFor(enableVad: boolean, enableSpeakerDiarization: boolean): Record<string, unknown> {
  return buildVolcFullClientRequest({
    appKey: 'app-id',
    accessKey: 'access-token',
    enableVad,
    enableSpeakerDiarization,
  }).request as Record<string, unknown>
}

describe('Volc proxy configuration', () => {
  it.each([
    [false, false, false, false],
    [true, false, true, false],
    [false, true, true, true],
    [true, true, true, true],
  ])('applies VAD=%s and diarization=%s independently', (
    enableVad,
    enableSpeakerDiarization,
    showUtterances,
    speakerInfo,
  ) => {
    const request = requestFor(enableVad, enableSpeakerDiarization)
    expect(request.show_utterances === true).toBe(showUtterances)
    expect(request.enable_speaker_info === true).toBe(speakerInfo)
    expect(request.end_window_size === 800).toBe(enableVad)
    expect(request.force_to_speech_time === 1000).toBe(enableVad)
  })

  it('only treats the literal true query value as enabled', () => {
    expect(parseVolcProxyConfig(new URLSearchParams('appKey=a&accessKey=b')).enableSpeakerDiarization).toBe(false)
    expect(parseVolcProxyConfig(new URLSearchParams('enableSpeakerDiarization=false')).enableSpeakerDiarization).toBe(false)
    expect(parseVolcProxyConfig(new URLSearchParams('enableSpeakerDiarization=true')).enableSpeakerDiarization).toBe(true)
  })

  it('preserves V2 resource ID and APP ID plus Access Token headers', () => {
    const config = { appKey: 'app-id', accessKey: 'access-token', modelV2: true }
    expect(resolveVolcResourceId(true)).toBe('volc.seedasr.sauc.duration')
    expect(buildVolcAuthHeaders(config, 'connect-id')).toEqual({
      'X-Api-App-Key': 'app-id',
      'X-Api-Access-Key': 'access-token',
      'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
      'X-Api-Connect-Id': 'connect-id',
    })
  })

  it('summarizes speaker response structure without transcript text', () => {
    const summary = summarizeVolcResponseForDiagnostics({
      result: {
        text: 'sensitive transcript',
        utterances: [
          { text: 'private words', speaker: 1, start_time: 0 },
          { text: 'more private words', speaker_id: '2' },
          { text: 'nested', speaker_info: { speakerId: 3, confidence: 0.9 } },
        ],
      },
    })

    expect(summary).toEqual({
      hasResult: true,
      resultKeys: ['text', 'utterances'],
      utteranceCount: 3,
      utteranceKeys: ['speaker', 'speaker_id', 'speaker_info', 'start_time', 'text'],
      speakerFields: ['speaker', 'speaker_id', 'speaker_info', 'speaker_info.speakerId'],
      speakerSamples: {
        speaker: ['1'],
        speaker_id: ['2'],
        speaker_info: ['{confidence,speakerId}'],
        'speaker_info.speakerId': ['3'],
      },
    })
    expect(JSON.stringify(summary)).not.toContain('sensitive transcript')
    expect(JSON.stringify(summary)).not.toContain('private words')
  })
})
