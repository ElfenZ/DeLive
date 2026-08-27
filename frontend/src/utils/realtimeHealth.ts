import type { CaptureHealthSnapshot } from '../services/captureManager'
import type { ProviderSessionHealthSnapshot } from '../services/providerSession'

export const CAPTURE_STALL_TIMEOUT_MS = 5_000
export const PROVIDER_RESULT_STALL_TIMEOUT_MS = 30_000
export const RECENT_AUDIO_SEND_WINDOW_MS = 5_000
export const RECENT_AUDIBLE_SOURCE_WINDOW_MS = 10_000

export type RealtimeStallKind = 'capture' | 'provider' | null

export function detectRealtimeStall(input: {
  now: number
  capture: CaptureHealthSnapshot
  provider: ProviderSessionHealthSnapshot | null
  lastAudibleSourceAt: number
}): RealtimeStallKind {
  const captureProgressAt = Math.max(
    input.capture.pipelineStartedAt,
    input.capture.lastDeliveredAudioAt,
  )
  if (captureProgressAt > 0
    && input.now - captureProgressAt >= CAPTURE_STALL_TIMEOUT_MS) {
    return 'capture'
  }

  const provider = input.provider
  if (!provider
    || provider.receivedEventCount === 0
    || provider.lastEventAt <= 0
    || provider.lastAudioSentAt <= 0
    || input.lastAudibleSourceAt <= 0) {
    return null
  }

  const audioStillSending = input.now - provider.lastAudioSentAt < RECENT_AUDIO_SEND_WINDOW_MS
  const sourceRecentlyAudible = input.now - input.lastAudibleSourceAt < RECENT_AUDIBLE_SOURCE_WINDOW_MS
  const resultsStalled = input.now - provider.lastEventAt >= PROVIDER_RESULT_STALL_TIMEOUT_MS
  return audioStillSending && sourceRecentlyAudible && resultsStalled ? 'provider' : null
}
