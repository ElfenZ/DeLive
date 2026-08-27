import { describe, expect, it } from 'vitest'
import { ASRVendor } from '../types/asr'
import { detectRealtimeStall } from './realtimeHealth'

const now = 100_000

describe('detectRealtimeStall', () => {
  it('detects a capture pipeline that stopped delivering chunks', () => {
    expect(detectRealtimeStall({
      now,
      capture: {
        pipelineStartedAt: 80_000,
        lastDeliveredAudioAt: 90_000,
        deliveredAudioChunks: 100,
        recorderState: 'recording',
        hasAudioProcessor: false,
      },
      provider: null,
      lastAudibleSourceAt: 99_000,
    })).toBe('capture')
  })

  it('detects a provider with active audio and audible input but stale results', () => {
    expect(detectRealtimeStall({
      now,
      capture: {
        pipelineStartedAt: 80_000,
        lastDeliveredAudioAt: 99_900,
        deliveredAudioChunks: 500,
        recorderState: 'recording',
        hasAudioProcessor: false,
      },
      provider: {
        providerId: ASRVendor.Soniox,
        providerState: 'recording',
        connectedAt: 70_000,
        sentAudioChunks: 500,
        lastAudioSentAt: 99_900,
        receivedEventCount: 20,
        lastEventAt: 60_000,
      },
      lastAudibleSourceAt: 99_000,
    })).toBe('provider')
  })

  it('does not treat natural silence as a provider stall', () => {
    expect(detectRealtimeStall({
      now,
      capture: {
        pipelineStartedAt: 80_000,
        lastDeliveredAudioAt: 99_900,
        deliveredAudioChunks: 500,
        recorderState: 'recording',
        hasAudioProcessor: false,
      },
      provider: {
        providerId: ASRVendor.Soniox,
        providerState: 'recording',
        connectedAt: 70_000,
        sentAudioChunks: 500,
        lastAudioSentAt: 99_900,
        receivedEventCount: 20,
        lastEventAt: 60_000,
      },
      lastAudibleSourceAt: 80_000,
    })).toBeNull()
  })
})
