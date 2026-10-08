import type { RecordingState } from './recordingState'
import type { OriginalSourceInfo, OriginalSourceResult } from './originalSources'
import type { StorageOperationResult, StorageDirectoryTarget, TranscriptDirectorySelection, ManagedAssetReference, ManagedAssetKind, MediaMigrationResult, LocalFileChange, SessionFileContext, ManagedNamingState, CorrectedMarkdownSaveRequest, CorrectedMarkdownFileState } from './fileStorage'

export interface DesktopSource {
  id: string
  name: string
  thumbnail: string
  appIcon: string | null
  isScreen: boolean
}

export type SourceSelectionMode = 'prompt' | 'reuse-if-available'

export interface UpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
}

export interface DownloadProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export type LocalRuntimeStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface LocalRuntimeLaunchOptions {
  binaryPath?: string
  modelPath?: string
  port?: number
}

export interface LocalRuntimeSnapshot {
  runtimeId: string
  displayName: string
  status: LocalRuntimeStatus
  available: boolean
  modelsPath: string
  binaryPath: string | null
  baseUrl: string
  message?: string
}

export interface CaptionStyle {
  fontSize: number
  fontFamily: string
  textColor: string
  backgroundColor: string
  textShadow: boolean
  maxLines: number
  width: number
  displayMode?: 'source' | 'translated' | 'dual'
}

export interface CaptionStatus {
  enabled: boolean
  draggable: boolean
  style: CaptionStyle
  stableText: string
  activeText: string
  translatedStableText: string
  translatedActiveText: string
  translatedText: string
  text: string
  isFinal: boolean
}

export interface CaptionBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface FilePickerOptions {
  title?: string
  filters?: Array<{
    name: string
    extensions: string[]
  }>
}

export interface PathOperationResult {
  success: boolean
  path: string
  error?: string
}

export interface RuntimeCommandResult {
  success: boolean
  status: LocalRuntimeSnapshot
  error?: string
}

export interface UpdateCheckResult {
  success?: boolean
  version?: string
  error?: string
}

export interface DownloadUpdateResult {
  success?: boolean
  error?: string
}

export interface CaptionTextUpdatePayload {
  stableText: string
  activeText: string
  translatedStableText: string
  translatedActiveText: string
  text: string
  translatedText: string
  isFinal: boolean
}

export interface DiagnosticsExportResult {
  success: boolean
  path?: string
  reason?: string
}

export interface DiagnosticsExportPayload {
  settings: Record<string, unknown>
  localStorageKeys: string[]
  runtimeDiagnostics?: Array<{
    timestamp: string
    scope: string
    event: string
    details?: Record<string, unknown>
  }>
}

// ─── Open API types ───

export interface SessionSummary {
  id: string
  title: string
  date: string
  time: string
  createdAt: number
  updatedAt: number
  duration?: number
  status?: string
  topicId?: string
  tagIds?: string[]
  providerId?: string
  hasSummary: boolean
  hasMindMap: boolean
  transcriptLength: number
}

export interface SessionDetail {
  id: string
  title: string
  date: string
  time: string
  createdAt: number
  updatedAt: number
  duration?: number
  status?: string
  topicId?: string
  tagIds?: string[]
  providerId?: string
  transcript: string
  translatedTranscript?: {
    text: string
    targetLanguage?: string
  }
  tokens?: Array<{
    text: string
    isFinal?: boolean
    startMs?: number
    endMs?: number
    speaker?: string
  }>
  speakers?: Array<{
    id: string
    label: string
    displayName?: string
  }>
  segments?: Array<{
    text: string
    translatedText?: string
    startMs?: number
    endMs?: number
    speakerId?: string
  }>
  postProcess?: {
    summary?: string
    actionItems?: string[]
    keywords?: string[]
    titleSuggestion?: string
    tagSuggestions?: string[]
    generatedAt?: number
    status?: string
  }
  mindMap?: {
    markdown: string
    title?: string
    generatedAt?: number
    status?: string
  }
  askHistory?: Array<{
    id: string
    question: string
    answer?: string
    createdAt: number
    status: string
  }>
  correction?: {
    correctedText?: string
    status: string
    mode: string
  }
  correctionMeta?: {
    sourceKind: 'published' | 'legacy' | 'none'
    formatVersion?: number
    sourceHash?: string
    publishedStatus?: 'available' | 'none'
    draftStatus?: string
    appliedPatches?: number
    rejectedPatches?: number
    updatedAt?: number
  }
}

export interface AiCorrectionRecoveryRequest {
  requestId: string
  url: string
  provider: 'openai-compatible' | 'anthropic-compatible'
  apiKey?: string
  body: string
  firstByteTimeoutMs: number
  idleTimeoutMs: number
  absoluteTimeoutMs: number
}

export interface AiCorrectionRecoveryResponse {
  status: number
  contentType?: string
  retryAfter?: string
  body: string
}

export interface AutoExportFileRequest {
  directory: string
  fileName: string
  content: string
}

export interface AutoExportFileResult {
  ok: boolean
  path?: string
  error?: string
}

export interface ApiRecordingStatus {
  isRecording: boolean
  currentSessionId: string | null
  recordingState: RecordingState
}

export interface ApiTopicData {
  id: string
  name: string
  emoji: string
  description?: string
  createdAt: number
  updatedAt: number
}

export interface ApiTagData {
  id: string
  name: string
  color: string
}

// ─── Cloud Backup types ───

export interface CloudBackupIpcConfig {
  provider: 's3' | 'webdav'
  s3?: {
    endpoint: string
    region: string
    bucket: string
    prefix: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle?: boolean
  }
  webdav?: {
    url: string
    username: string
    password: string
    basePath: string
  }
}

export interface CloudBackupIpcFileInfo {
  key: string
  lastModified: string
  size: number
}

export interface RecordingArchiveSaveRequest {
  sessionId: string
  fileName: string
  mimeType: string
  data: ArrayBuffer
}

export interface RecordingArchiveSaveResult {
  ok: boolean
  sessionId?: string
  path?: string
  size?: number
  mimeType?: string
  fileName?: string
  error?: string
  managedAsset?: ManagedAssetReference
}

export interface RecordingArchiveBeginRequest {
  sessionId: string
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export interface RecordingArchiveAppendRequest {
  sessionId: string
  data: ArrayBuffer
}

export interface RecordingArchiveFinalizeRequest {
  sessionId: string
  fileName?: string
}

export interface RecordingArchiveRecoverySkippedItem {
  sessionId: string
  reason: 'missing-pcm' | 'missing-metadata' | 'invalid-metadata' | 'active-recording' | 'empty-audio' | 'finalize-failed'
  error?: string
}

export interface RecordingArchiveRecoverResult {
  ok: boolean
  recovered: RecordingArchiveSaveResult[]
  skipped?: RecordingArchiveRecoverySkippedItem[]
  error?: string
  notices?: import('./fileStorage').RecordingRecoveryNotice[]
  ignoredCount?: number
}

export type MediaProcessingErrorCode =
  | 'MEDIA_TOOLS_UNAVAILABLE'
  | 'MEDIA_SOURCE_INVALID'
  | 'MEDIA_NO_AUDIO'
  | 'MEDIA_EXTRACTION_CANCELLED'
  | 'MEDIA_EXTRACTION_FAILED'
  | 'MEDIA_AUDIO_MISSING'
  | 'MEDIA_FILE_BUSY'
  | 'MEDIA_FILE_CONFLICT'
  | 'MEDIA_ROOT_UNAVAILABLE'

export interface MediaExtractAudioRequest {
  taskId: string
  sessionId: string
  sourcePath: string
}

export interface MediaArchivedAudio {
  sessionId: string
  path: string
  fileName: string
  mimeType: string
  assetKind?: ManagedAssetKind
  revision?: number
  sha256?: string
  size: number
  durationMs?: number
}

export interface MediaOperationResult {
  ok: boolean
  audio?: MediaArchivedAudio
  error?: string
  code?: MediaProcessingErrorCode
}

export interface MediaReadAudioResult extends MediaOperationResult {
  data?: ArrayBuffer
}

export interface MediaListAudioResult extends MediaOperationResult {
  audios?: MediaArchivedAudio[]
  errors?: Array<{ sessionId: string; error: string }>
  configurationRevision?: number
  changeSequence?: number
  deleted?: ManagedAssetReference[]
  naming?: Array<{ sessionId: string; state: ManagedNamingState }>
}

export interface MediaExtractionProgress {
  taskId: string
  sessionId: string
  progress: number
  processedMs: number
  durationMs?: number
}

// ─── Core types ───

export interface ElectronAPI {
  manualExportFile: (request: { filename: string; content: string; defaultSaveProjectId?: string }) => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
  getFileStorageStatus: () => Promise<StorageOperationResult>
  chooseMediaDirectory: () => Promise<StorageOperationResult | null>
  setPerformanceDiagnostics: (enabled: boolean) => Promise<{ ok: boolean }>
  getPerformanceDiagnostics: () => Promise<{ records: import('./performanceDiagnostics').PerformanceDiagnostic[] }>
  clearPerformanceDiagnostics: () => Promise<{ ok: boolean }>
  chooseTranscriptDirectory: (selection: TranscriptDirectorySelection) => Promise<StorageOperationResult | null>
  openStorageDirectory: (target: StorageDirectoryTarget) => Promise<{ ok: boolean; error?: string }>
  chooseMediaMigration: () => Promise<MediaMigrationResult | null>
  applyMediaMigration: (token: string) => Promise<MediaMigrationResult | null>
  resumeMediaMigration: (id: string) => Promise<MediaMigrationResult>
  cleanupMediaMigration: (id: string) => Promise<MediaMigrationResult | null>
  abandonMediaMigration: (id: string) => Promise<MediaMigrationResult | null>
  onFileStorageChanged: (callback: (event: LocalFileChange) => void) => () => void
  registerSessionFiles: (context: SessionFileContext, nameFiles?: boolean) => Promise<{ ok: boolean; naming?: ManagedNamingState; error?: string }>
  previewManagedNames: (contexts: SessionFileContext[]) => Promise<{ ok: boolean; token?: string; items?: Array<{ sessionId: string; oldName: string; newName: string; revision: number }>; error?: string }>
  applyManagedNames: (token: string) => Promise<{ ok: boolean; error?: string } | null>
  markFileRecordDeletion: (sessionId: string, phase: 'prepare' | 'commit' | 'cancel') => Promise<{ ok: boolean; error?: string }>
  reconcileFileRecordBindings: (contexts: SessionFileContext[], deletedIds: string[]) => Promise<{ ok: boolean; error?: string }>
  registerOriginalSource: (filePath: string, sessionId: string) => Promise<OriginalSourceResult>
  acquireOriginalRead: (sourceId: string, sessionId: string) => Promise<{ ok: boolean; token?: string; error?: string }>
  releaseOriginalRead: (token: string) => Promise<void>
  readOriginalAudio: (token: string) => Promise<{ ok: boolean; data?: Uint8Array; fileName?: string; error?: string }>
  previewOriginalRename: (sourceId: string, sessionId: string) => Promise<OriginalSourceResult>
  previewOriginalUndo: (sourceId: string, sessionId: string) => Promise<OriginalSourceResult>
  commitOriginalRename: (token: string) => Promise<OriginalSourceResult | null>
  onOriginalSourceChanged: (callback: (source: OriginalSourceInfo) => void) => () => void
  listOriginalSources: () => Promise<{ ok: boolean; sources?: OriginalSourceInfo[]; error?: string }>
  savePublishedMarkdown: (request: CorrectedMarkdownSaveRequest) => Promise<{ ok: boolean; file?: CorrectedMarkdownFileState; error?: string }>
  relocatePublishedMarkdown: (sessionId: string) => Promise<{ ok: boolean; file?: CorrectedMarkdownFileState; error?: string } | null>
  locatePublishedMarkdown: (sessionId: string) => Promise<{ ok: boolean; file?: CorrectedMarkdownFileState; error?: string } | null>
  adoptLegacyPublishedMarkdown: (request: CorrectedMarkdownSaveRequest) => Promise<{ ok: boolean; file?: CorrectedMarkdownFileState; error?: string } | null>
  getAppVersion: () => Promise<string>
  getProxyPort: () => Promise<number>
  aiCorrectionRecoveryFetch: (request: AiCorrectionRecoveryRequest) => Promise<AiCorrectionRecoveryResponse>
  cancelAiCorrectionRecoveryFetch: (requestId: string) => Promise<boolean>
  minimizeToTray: () => Promise<void>
  windowMinimize: (source?: string) => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  getAutoLaunch: () => Promise<boolean>
  setAutoLaunch: (enable: boolean) => Promise<boolean>
  pickFilePath: (options?: FilePickerOptions) => Promise<string | null>
  getPathForFile: (file: File) => string
  pickDirectoryPath: () => Promise<string | null>
  pathExists: (targetPath: string) => Promise<boolean>
  writeAutoExportFile: (request: AutoExportFileRequest) => Promise<AutoExportFileResult>
  revealExportedFile: (targetPath: string) => Promise<{ ok: boolean; error?: string }>
  saveRecordingArchive: (request: RecordingArchiveSaveRequest) => Promise<RecordingArchiveSaveResult>
  beginRecordingArchive: (request: RecordingArchiveBeginRequest) => Promise<RecordingArchiveSaveResult>
  appendRecordingArchive: (request: RecordingArchiveAppendRequest) => Promise<RecordingArchiveSaveResult>
  finalizeRecordingArchive: (request: RecordingArchiveFinalizeRequest) => Promise<RecordingArchiveSaveResult>
  abortRecordingArchive: (request: { sessionId: string }) => Promise<{ ok: boolean; error?: string }>
  recoverRecordingArchives: (activeSessionIds?: string[]) => Promise<RecordingArchiveRecoverResult>
  listRecordingRecoveryNotices: (activeSessionIds: string[]) => Promise<{ ok: boolean; items?: import('./fileStorage').RecordingRecoveryNotice[]; error?: string }>
  acknowledgeRecordingRecovery: (request: { key: string; evidence: string; activeSessionIds: string[] }) => Promise<{ ok: boolean; error?: string }>
  revealRecordingArchive: (targetPath: string) => Promise<{ ok: boolean; error?: string }>
  extractMediaAudio: (request: MediaExtractAudioRequest) => Promise<MediaOperationResult>
  cancelMediaExtraction: (taskId: string) => Promise<boolean>
  getMediaAudio: (sessionId: string) => Promise<MediaOperationResult>
  listMediaAudio: () => Promise<MediaListAudioResult>
  readMediaAudio: (sessionId: string) => Promise<MediaReadAudioResult>
  revealMediaAudio: (sessionId: string) => Promise<MediaOperationResult>
  deleteMediaAudio: (sessionId: string) => Promise<MediaOperationResult>
  onMediaExtractionProgress: (callback: (progress: MediaExtractionProgress) => void) => () => void
  localRuntimeGetStatus: (runtimeId: string, options?: LocalRuntimeLaunchOptions) => Promise<LocalRuntimeSnapshot>
  localRuntimeOpenModelsPath: (runtimeId: string) => Promise<PathOperationResult>
  localRuntimeListModels: (runtimeId: string) => Promise<string[]>
  localRuntimeImportModel: (runtimeId: string, sourcePath: string) => Promise<PathOperationResult>
  localRuntimeImportBinary: (runtimeId: string, sourcePath: string) => Promise<PathOperationResult>
  localRuntimeDownloadModel: (runtimeId: string, urlString: string) => Promise<PathOperationResult>
  localRuntimeDownloadBinary: (runtimeId: string, urlString: string) => Promise<PathOperationResult>
  localRuntimeStart: (runtimeId: string, options?: LocalRuntimeLaunchOptions) => Promise<RuntimeCommandResult>
  localRuntimeStop: (runtimeId: string, options?: LocalRuntimeLaunchOptions) => Promise<RuntimeCommandResult>
  getDesktopSources: () => Promise<DesktopSource[]>
  prepareSourceCapture: (mode: SourceSelectionMode) => Promise<void>
  selectSource: (sourceId: string) => Promise<boolean>
  cancelSourceSelection: () => Promise<void>
  onShowSourcePicker: (callback: () => void) => () => void
  checkForUpdates: () => Promise<UpdateCheckResult>
  downloadUpdate: () => Promise<DownloadUpdateResult>
  installUpdate: () => void
  onCheckingForUpdate: (callback: () => void) => () => void
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void
  onUpdateNotAvailable: (callback: (info: { version: string }) => void) => () => void
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) => () => void
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void
  onUpdateError: (callback: (error: string) => void) => () => void
  captionToggle: (enable?: boolean, source?: string) => Promise<boolean>
  captionGetStatus: () => Promise<CaptionStatus>
  captionUpdateText: (
    stableText: string,
    activeText: string,
    isFinal: boolean,
    translatedStableText?: string,
    translatedActiveText?: string,
  ) => Promise<void>
  captionUpdateStyle: (style: Partial<CaptionStyle>) => Promise<CaptionStyle>
  captionToggleDraggable: (draggable?: boolean) => Promise<boolean>
  captionSetInteractive: (interactive: boolean) => Promise<boolean>
  captionGetBounds: () => Promise<CaptionBounds | null>
  captionSetBounds: (bounds: Partial<CaptionBounds>) => Promise<boolean>
  captionResetPosition: () => Promise<boolean>
  onCaptionStatusChanged: (callback: (enabled: boolean) => void) => () => void
  onCaptionTextUpdate: (callback: (data: CaptionTextUpdatePayload) => void) => () => void
  onCaptionStyleUpdate: (callback: (style: CaptionStyle) => void) => () => void
  onCaptionDraggableChanged: (callback: (draggable: boolean) => void) => () => void
  onCaptionInteractiveChanged: (callback: (interactive: boolean) => void) => () => void
  captionOpenSettings: () => Promise<boolean>
  onOpenCaptionSettings: (callback: () => void) => () => void
  exportDiagnostics: (payload: DiagnosticsExportPayload) => Promise<DiagnosticsExportResult>
  safeStorageSet: (key: string, value: string) => Promise<boolean>
  safeStorageGet: (key: string) => Promise<string | null>
  safeStorageDelete: (key: string) => Promise<boolean>
  safeStorageAvailable: () => Promise<boolean>
  onToggleRecording: (callback: () => void) => () => void
  onToggleRecordingPause: (callback: () => void) => () => void
  apiNotifySessionStart: (sessionId: string) => void
  apiNotifySessionEnd: (sessionId: string) => void

  onApiGetSessions: (callback: (event: unknown, requestId: string, filter?: import('./apiTypes').ApiSessionFilter) => void) => () => void
  apiRespondSessions: (sessions: SessionSummary[], requestId: string) => void
  onApiGetSessionDetail: (callback: (event: unknown, sessionId: string, requestId: string) => void) => () => void
  apiRespondSessionDetail: (session: SessionDetail | null, requestId: string) => void
  onApiSearchSessions: (callback: (event: unknown, query: string, requestId: string, filter?: import('./apiTypes').ApiSessionFilter) => void) => () => void
  apiRespondSearchSessions: (sessions: SessionSummary[], requestId: string) => void
  onApiGetTopics: (callback: (event: unknown, requestId: string) => void) => () => void
  apiRespondTopics: (topics: ApiTopicData[], requestId: string) => void
  onApiGetTags: (callback: (event: unknown, requestId: string) => void) => () => void
  apiRespondTags: (tags: ApiTagData[], requestId: string) => void
  onApiGetRecordingStatus: (callback: (event: unknown, requestId: string) => void) => () => void
  apiRespondRecordingStatus: (status: ApiRecordingStatus, requestId: string) => void

  apiUpdateOpenApiConfig: (config: { enabled: boolean; token: string }) => void

  cloudBackupTest: (config: CloudBackupIpcConfig) => Promise<{ ok: boolean; error?: string }>
  cloudBackupUpload: (config: CloudBackupIpcConfig, jsonData: string) => Promise<{ ok: boolean; key?: string; error?: string }>
  cloudBackupList: (config: CloudBackupIpcConfig) => Promise<{ ok: boolean; files?: CloudBackupIpcFileInfo[]; error?: string }>
  cloudBackupDownload: (config: CloudBackupIpcConfig, key: string) => Promise<{ ok: boolean; data?: string; error?: string }>
  cloudBackupDelete: (config: CloudBackupIpcConfig, key: string) => Promise<{ ok: boolean; error?: string }>

  langChange: (lang: string) => Promise<void>

  isElectron: boolean
  platform: 'win32' | 'darwin' | 'linux'
  supportsAutoLaunch: boolean
  supportsAutoUpdate: boolean
}
