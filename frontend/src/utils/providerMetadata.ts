import type { TranscriptSegment, TranscriptSourceMeta } from '../types'
import { ASRVendor, type ASRProviderInfo, type ProviderConfig } from '../types/asr'
import { providerRegistry } from '../providers'

export function resolveProviderMode(providerId: string | undefined): TranscriptSourceMeta['providerMode'] {
  if (!providerId) {
    return 'unknown'
  }

  const providerInfo = providerRegistry.getInfo(providerId as ASRVendor)
  if (!providerInfo) {
    return 'unknown'
  }

  switch (providerInfo.capabilities.transport.type) {
    case 'realtime':
      return 'realtime'
    case 'full-session-retranscription':
      return 'full-session-retranscription'
    case 'local-runtime':
      return 'local-runtime'
    default:
      return 'unknown'
  }
}

export function shouldShowLiveSpeakerDiarization(
  provider: ASRProviderInfo | undefined,
  config: ProviderConfig | undefined,
  segments: TranscriptSegment[],
): boolean {
  return Boolean(
    provider?.capabilities.supportsSpeakerDiarization
    && config?.enableSpeakerDiarization
    && segments.some((segment) => Boolean(segment.speakerId?.trim())),
  )
}

export function supportsLiveSpeakerDiarizationQuickToggle(
  provider: ASRProviderInfo | undefined,
): boolean {
  return provider?.id === ASRVendor.Soniox
    && Boolean(provider.capabilities.supportsSpeakerDiarization)
}
