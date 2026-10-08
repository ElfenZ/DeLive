import type { ASRVendor } from './asr/common'
import type { MeetingContextSnapshot, RecognitionConfigSnapshot } from './index'
import type { ManagedAssetReference } from '../../../shared/fileStorage'

export type FileTranscriptionJobStatus =
  | 'queued'
  | 'extracting'
  | 'audio-ready'
  | 'uploading'
  | 'transcribing'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface FileTranscriptionJob {
  id: string
  fileName: string
  fileSize: number
  mimeType: string
  status: FileTranscriptionJobStatus
  progress: number
  provider: ASRVendor
  inputKind: 'audio' | 'video'
  config?: FileTranscriptionConfig
  /** Soniox-specific remote file ID */
  sonioxFileId?: string
  /** Soniox-specific remote transcription ID */
  sonioxTranscriptionId?: string
  /** Mistral-specific uploaded file ID (for large-file workflow) */
  mistralFileId?: string
  /** Gladia-specific remote transcription job ID */
  gladiaTranscriptionId?: string
  sessionId?: string
  projectIds?: string[]
  defaultSaveProjectId?: string
  managedAsset?: ManagedAssetReference
  originalSourceId?: string
  originalSourceRevision?: number
  currentOriginalFileName?: string
  audioPath?: string
  audioFileName?: string
  audioMimeType?: string
  audioSize?: number
  audioAvailable?: boolean
  requiresSourceSelection?: boolean
  error?: string
  createdAt: number
  completedAt?: number
  audioDurationMs?: number
}

export interface FileTranscriptionConfig {
  provider: ASRVendor
  languageHints?: string[]
  translationEnabled?: boolean
  translationTargetLanguage?: string
  enableSpeakerDiarization?: boolean
  model?: string
  languageHintsStrict?: boolean
  meetingContext: MeetingContextSnapshot
  recognitionConfig?: RecognitionConfigSnapshot
}

export const ACCEPTED_AUDIO_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus',
  '.mpga', '.aac', '.wma',
] as const

export const CANDIDATE_VIDEO_EXTENSIONS = [
  '.mp4', '.webm', '.mov', '.mkv', '.mpeg', '.mpg', '.m4v',
  '.avi', '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.3gp', '.ogv',
] as const

export const ACCEPTED_MEDIA_EXTENSIONS = [
  ...ACCEPTED_AUDIO_EXTENSIONS,
  ...CANDIDATE_VIDEO_EXTENSIONS,
] as const

export const ACCEPTED_AUDIO_MIME_TYPES = [
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
  'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/flac',
  'audio/ogg', 'audio/webm', 'audio/opus', 'audio/aac',
  'audio/x-aac', 'audio/wma', 'audio/x-ms-wma',
] as const

export const CANDIDATE_VIDEO_MIME_TYPES = [
  'video/mp4', 'video/mpeg', 'video/webm', 'video/quicktime',
  'video/x-matroska', 'video/x-msvideo', 'video/x-ms-wmv',
] as const

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

export function getMediaInputKind(file: Pick<File, 'name' | 'type'>): 'audio' | 'video' {
  const extension = getFileExtension(file.name)
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('video/')) return 'video'
  if (ACCEPTED_AUDIO_EXTENSIONS.includes(extension as typeof ACCEPTED_AUDIO_EXTENSIONS[number])) return 'audio'
  return 'video'
}

export function isAcceptedAudioFile(file: File): boolean {
  if (!file.name || file.size <= 0) return false
  if (ACCEPTED_AUDIO_MIME_TYPES.includes(file.type as typeof ACCEPTED_AUDIO_MIME_TYPES[number])) {
    return true
  }
  if (CANDIDATE_VIDEO_MIME_TYPES.includes(file.type as typeof CANDIDATE_VIDEO_MIME_TYPES[number])) {
    return true
  }
  const extension = getFileExtension(file.name)
  if (ACCEPTED_MEDIA_EXTENSIONS.includes(extension as typeof ACCEPTED_MEDIA_EXTENSIONS[number])) return true
  // The desktop app lets FFmpeg make the final format decision for uncommon containers.
  return typeof window !== 'undefined' && Boolean(window.electronAPI?.getPathForFile)
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
