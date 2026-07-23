import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '../types'
import type { ASRProviderInfo, ProviderConfig } from '../types/asr'
import { ASRVendor } from '../types/asr'
import {
  shouldShowLiveSpeakerDiarization,
  supportsLiveSpeakerDiarizationQuickToggle,
} from './providerMetadata'

function provider(id: ASRVendor, supported: boolean): ASRProviderInfo {
  return {
    id,
    name: id,
    description: '',
    type: 'cloud',
    supportsStreaming: true,
    capabilities: {
      audioInputMode: 'pcm16',
      transport: { type: 'realtime' },
      supportsSpeakerDiarization: supported,
    },
    requiredConfigKeys: [],
    supportedLanguages: [],
    website: '',
    configFields: [],
  }
}

describe('live speaker display predicate', () => {
  const enabled: ProviderConfig = { enableSpeakerDiarization: true }
  const tagged: TranscriptSegment[] = [{ text: 'hello', speakerId: '1' }]

  it('requires capability, enabled config, and an actual nonblank speaker', () => {
    expect(shouldShowLiveSpeakerDiarization(provider(ASRVendor.Volc, true), enabled, tagged)).toBe(true)
    expect(shouldShowLiveSpeakerDiarization(provider(ASRVendor.Volc, false), enabled, tagged)).toBe(false)
    expect(shouldShowLiveSpeakerDiarization(
      provider(ASRVendor.Volc, true),
      { enableSpeakerDiarization: false },
      tagged,
    )).toBe(false)
    expect(shouldShowLiveSpeakerDiarization(provider(ASRVendor.Volc, true), enabled, [{ text: 'hello' }])).toBe(false)
    expect(shouldShowLiveSpeakerDiarization(
      provider(ASRVendor.Volc, true),
      enabled,
      [{ text: 'hello', speakerId: '  ' }],
    )).toBe(false)
  })

  it('keeps the recording quick toggle for Soniox but not Volc', () => {
    expect(supportsLiveSpeakerDiarizationQuickToggle(provider(ASRVendor.Soniox, true))).toBe(true)
    expect(supportsLiveSpeakerDiarizationQuickToggle(provider(ASRVendor.Volc, true))).toBe(false)
    expect(supportsLiveSpeakerDiarizationQuickToggle(provider(ASRVendor.Soniox, false))).toBe(false)
  })
})
