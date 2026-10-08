export type ManagedAssetKind = 'recording-audio' | 'extracted-audio'

export interface RecordingRecoveryNotice {
  key: string
  sessionId: string
  evidence: string
  reason: 'pending-group' | 'missing-pcm' | 'missing-metadata' | 'unsafe-recovery-file' | 'unlinked-audio'
  acknowledged: boolean
}

export interface RecordingRecoveryAcknowledgement {
  evidence: string
  acknowledgedAt: number
  decision: 'manually-moved'
}

export interface ManagedAssetReference {
  sessionId: string
  assetKind: ManagedAssetKind
  revision: number
}

export type LocalFileOperationStatus = 'pending' | 'saving' | 'saved' | 'waiting-directory' | 'conflict' | 'missing' | 'error'

// Paths are local caches, not capabilities. Main-process registrations own access.
export interface CorrectedMarkdownFileState {
  status: LocalFileOperationStatus
  registrationId?: string
  path?: string
  publicationId?: string
  publicationRevision?: number
  publicationHash?: string
  titleRevision?: number
  revision: number
  savedAt?: number
  error?: string
}

export interface LocalFileConfiguration {
  version: 1
  mediaRoot: string
  defaultTranscriptDirectory?: string
  projectTranscriptDirectories: Record<string, string>
  revision: number
}

export interface ManagedAudioAsset {
  sessionId: string
  assetKind: ManagedAssetKind
  revision: number
  path: string
  fileName: string
  mimeType: string
  size: number
  sha256: string
}

export type FileStorageErrorCode = 'FILE_STORAGE_INVALID' | 'FILE_STORAGE_BUSY' | 'FILE_STORAGE_UNAVAILABLE'
  | 'FILE_STORAGE_CONFLICT' | 'FILE_STORAGE_MISSING' | 'FILE_STORAGE_CORRUPT'

export interface StorageDirectoryStatus {
  path: string
  available: boolean
  writable: boolean
  availableBytes?: number
  error?: string
}

export interface LocalFileStatus {
  configuration: LocalFileConfiguration
  media: StorageDirectoryStatus
  transcript?: StorageDirectoryStatus
  projectTranscripts: Record<string, StorageDirectoryStatus>
  managedAssetCount: number
  managedBytes: number
  pendingOperationCount: number
  busy: boolean
  migrations?: MediaMigrationStatus[]
}

export interface MediaMigrationPreview {
  token: string
  sourceRoot: string
  sourceRoots?: string[]
  targetRoot: string
  fileCount: number
  totalBytes: number
  requiredCopyBytes: number
  availableBytes: number
  reusedFileCount: number
  unknownEntryCount: number
  expiresAt: number
}

export interface MediaMigrationStatus {
  id: string
  sourceRoot: string
  sourceRoots?: string[]
  targetRoot: string
  phase: 'copying' | 'committed' | 'cleaned' | 'abandoned'
  fileCount: number
  totalBytes: number
  completedFiles: number
  remainingCopies: number
  remainingBytes: number
  error?: string
}

export interface MediaMigrationResult extends StorageOperationResult {
  preview?: MediaMigrationPreview
  migrationId?: string
  skipped?: Array<{ path: string; error: string }>
}

export interface StorageOperationResult {
  ok: boolean
  status?: LocalFileStatus
  code?: FileStorageErrorCode
  error?: string
}

export interface LocalFileChange {
  sequence: number
  configurationRevision: number
  // Availability only: consumers must not start another file catalog scan.
  activityOnly?: boolean
}
export interface SessionFileContext { sessionId: string; title: string; createdAt: number; titleRevision: number }
export interface ManagedNamingState { status: 'queued' | 'saved' | 'error'; titleRevision: number; error?: string }
export interface CorrectedMarkdownSaveRequest {
  sessionId: string; projectId?: string; publicationId: string; publicationRevision: number; titleRevision: number; content: string; legacyPath?: string
}

export type TranscriptDirectorySelection = { kind: 'default-transcript' } | { kind: 'project-transcript'; projectId: string }
export type StorageDirectoryTarget = TranscriptDirectorySelection | { kind: 'media' }

export function isSafeStorageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && value !== '.' && value !== '..' && value !== '__proto__' && value !== 'constructor' && value !== 'prototype'
    && !/[.]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
    && /^[a-zA-Z0-9._-]+$/.test(value)
}

export function normalizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function normalizeManagedAssetReference(value: unknown): ManagedAssetReference | undefined {
  if (!value || typeof value !== 'object') return undefined
  const ref = value as Record<string, unknown>
  if (!isSafeStorageId(ref.sessionId) || (ref.assetKind !== 'recording-audio' && ref.assetKind !== 'extracted-audio')) return undefined
  return { sessionId: ref.sessionId, assetKind: ref.assetKind, revision: normalizeRevision(ref.revision) }
}

export function normalizeCorrectedMarkdownFileState(value: unknown): CorrectedMarkdownFileState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const state = value as Record<string, unknown>
  const status = state.status
  if (status !== 'pending' && status !== 'saving' && status !== 'saved' && status !== 'waiting-directory'
    && status !== 'conflict' && status !== 'missing' && status !== 'error') return undefined
  const string = (key: string) => typeof state[key] === 'string' && state[key] ? state[key] as string : undefined
  return {
    status,
    registrationId: string('registrationId'),
    path: string('path'),
    publicationId: string('publicationId'),
    publicationRevision: state.publicationRevision === undefined ? undefined : normalizeRevision(state.publicationRevision),
    publicationHash: string('publicationHash'),
    titleRevision: state.titleRevision === undefined ? undefined : normalizeRevision(state.titleRevision),
    revision: normalizeRevision(state.revision),
    savedAt: typeof state.savedAt === 'number' && Number.isFinite(state.savedAt) ? state.savedAt : undefined,
    error: string('error'),
  }
}
