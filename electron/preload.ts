import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ApiRecordingStatus,
  ApiTagData,
  ApiTopicData,
  CaptionStyle,
  ElectronAPI,
  SessionDetail,
  SessionSummary,
} from '../shared/electronApi'

const electronAPI: ElectronAPI = {
  manualExportFile: (request) => ipcRenderer.invoke('manual-export-file', request),
  getFileStorageStatus: () => ipcRenderer.invoke('file-storage-status'),
  chooseMediaDirectory: () => ipcRenderer.invoke('choose-media-directory'),
  setPerformanceDiagnostics: (enabled) => ipcRenderer.invoke('set-performance-diagnostics', enabled),
  getPerformanceDiagnostics: () => ipcRenderer.invoke('get-performance-diagnostics'),
  clearPerformanceDiagnostics: () => ipcRenderer.invoke('clear-performance-diagnostics'),
  chooseTranscriptDirectory: (selection) => ipcRenderer.invoke('choose-transcript-directory', selection),
  openStorageDirectory: (target) => ipcRenderer.invoke('open-storage-directory', target),
  chooseMediaMigration: () => ipcRenderer.invoke('choose-media-migration'),
  registerSessionFiles: (context, nameFiles) => ipcRenderer.invoke('register-session-files', context, nameFiles),
  previewManagedNames: (contexts) => ipcRenderer.invoke('preview-managed-names', contexts),
  applyManagedNames: (token) => ipcRenderer.invoke('apply-managed-names', token),
  savePublishedMarkdown: (request) => ipcRenderer.invoke('save-published-markdown', request),
  relocatePublishedMarkdown: (sessionId) => ipcRenderer.invoke('relocate-published-markdown', sessionId),
  locatePublishedMarkdown: (sessionId) => ipcRenderer.invoke('locate-published-markdown', sessionId),
  adoptLegacyPublishedMarkdown: (request) => ipcRenderer.invoke('adopt-legacy-published-markdown', request),
  registerOriginalSource: (filePath, sessionId) => ipcRenderer.invoke('register-original-source', filePath, sessionId),
  listOriginalSources: () => ipcRenderer.invoke('list-original-sources'),
  acquireOriginalRead: (sourceId, sessionId) => ipcRenderer.invoke('acquire-original-read', sourceId, sessionId),
  releaseOriginalRead: (token) => ipcRenderer.invoke('release-original-read', token),
  readOriginalAudio: (token) => ipcRenderer.invoke('read-original-audio', token),
  previewOriginalRename: (sourceId, sessionId) => ipcRenderer.invoke('preview-original-rename', sourceId, sessionId),
  previewOriginalUndo: (sourceId, sessionId) => ipcRenderer.invoke('preview-original-undo', sourceId, sessionId),
  commitOriginalRename: (token) => ipcRenderer.invoke('commit-original-rename', token),
  onOriginalSourceChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, source: import('../shared/originalSources').OriginalSourceInfo) => callback(source)
    ipcRenderer.on('original-source-changed', listener)
    return () => { ipcRenderer.removeListener('original-source-changed', listener) }
  },
  markFileRecordDeletion: (sessionId, phase) => ipcRenderer.invoke('mark-file-record-deletion', sessionId, phase),
  reconcileFileRecordBindings: (contexts, deletedIds) => ipcRenderer.invoke('reconcile-file-record-bindings', contexts, deletedIds),
  applyMediaMigration: (token) => ipcRenderer.invoke('apply-media-migration', token),
  resumeMediaMigration: (id) => ipcRenderer.invoke('resume-media-migration', id),
  cleanupMediaMigration: (id) => ipcRenderer.invoke('cleanup-media-migration', id),
  abandonMediaMigration: (id) => ipcRenderer.invoke('abandon-media-migration', id),
  onFileStorageChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: import('../shared/fileStorage').LocalFileChange) => callback(payload)
    ipcRenderer.on('file-storage-changed', listener)
    return () => { ipcRenderer.removeListener('file-storage-changed', listener) }
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getProxyPort: () => ipcRenderer.invoke('get-proxy-port') as Promise<number>,
  aiCorrectionRecoveryFetch: (request) => ipcRenderer.invoke('ai-correction-recovery-fetch', request),
  cancelAiCorrectionRecoveryFetch: (requestId) => ipcRenderer.invoke('cancel-ai-correction-recovery-fetch', requestId),
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  windowMinimize: (source?: string) => ipcRenderer.invoke('window-minimize', source),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized') as Promise<boolean>,

  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch') as Promise<boolean>,
  setAutoLaunch: (enable: boolean) => ipcRenderer.invoke('set-auto-launch', enable) as Promise<boolean>,
  pickFilePath: (options) => ipcRenderer.invoke('pick-file-path', options) as Promise<string | null>,
  getPathForFile: (file) => {
    const actualPath = webUtils.getPathForFile(file)
    if (actualPath) ipcRenderer.send('native-file-selected', actualPath)
    return actualPath
  },
  pickDirectoryPath: () => ipcRenderer.invoke('pick-directory-path') as Promise<string | null>,
  pathExists: (targetPath: string) => ipcRenderer.invoke('path-exists', targetPath) as Promise<boolean>,
  writeAutoExportFile: (request) => ipcRenderer.invoke('write-auto-export-file', request),
  revealExportedFile: (targetPath: string) => ipcRenderer.invoke('reveal-exported-file', targetPath),
  saveRecordingArchive: (request) => ipcRenderer.invoke('save-recording-archive', request),
  beginRecordingArchive: (request) => ipcRenderer.invoke('begin-recording-archive', request),
  appendRecordingArchive: (request) => ipcRenderer.invoke('append-recording-archive', request),
  finalizeRecordingArchive: (request) => ipcRenderer.invoke('finalize-recording-archive', request),
  abortRecordingArchive: (request) => ipcRenderer.invoke('abort-recording-archive', request),
  recoverRecordingArchives: (activeSessionIds) => ipcRenderer.invoke('recover-recording-archives', activeSessionIds),
  listRecordingRecoveryNotices: (activeSessionIds) => ipcRenderer.invoke('list-recording-recovery-notices', activeSessionIds),
  acknowledgeRecordingRecovery: (request) => ipcRenderer.invoke('acknowledge-recording-recovery', request),
  revealRecordingArchive: (targetPath: string) => ipcRenderer.invoke('reveal-recording-archive', targetPath),
  extractMediaAudio: (request) => ipcRenderer.invoke('extract-media-audio', request),
  cancelMediaExtraction: (taskId) => ipcRenderer.invoke('cancel-media-extraction', taskId),
  getMediaAudio: (sessionId) => ipcRenderer.invoke('get-media-audio', sessionId),
  listMediaAudio: () => ipcRenderer.invoke('list-media-audio'),
  readMediaAudio: (sessionId) => ipcRenderer.invoke('read-media-audio', sessionId),
  revealMediaAudio: (sessionId) => ipcRenderer.invoke('reveal-media-audio', sessionId),
  deleteMediaAudio: (sessionId) => ipcRenderer.invoke('delete-media-audio', sessionId),
  onMediaExtractionProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]) => callback(progress)
    ipcRenderer.on('media-extraction-progress', listener)
    return () => ipcRenderer.removeListener('media-extraction-progress', listener)
  },

  localRuntimeGetStatus: (runtimeId: string, options) =>
    ipcRenderer.invoke('local-runtime-get-status', runtimeId, options),
  localRuntimeOpenModelsPath: (runtimeId: string) =>
    ipcRenderer.invoke('local-runtime-open-models-path', runtimeId),
  localRuntimeListModels: (runtimeId: string) =>
    ipcRenderer.invoke('local-runtime-list-models', runtimeId),
  localRuntimeImportModel: (runtimeId: string, sourcePath: string) =>
    ipcRenderer.invoke('local-runtime-import-model', runtimeId, sourcePath),
  localRuntimeImportBinary: (runtimeId: string, sourcePath: string) =>
    ipcRenderer.invoke('local-runtime-import-binary', runtimeId, sourcePath),
  localRuntimeDownloadModel: (runtimeId: string, urlString: string) =>
    ipcRenderer.invoke('local-runtime-download-model', runtimeId, urlString),
  localRuntimeDownloadBinary: (runtimeId: string, urlString: string) =>
    ipcRenderer.invoke('local-runtime-download-binary', runtimeId, urlString),
  localRuntimeStart: (runtimeId: string, options) =>
    ipcRenderer.invoke('local-runtime-start', runtimeId, options),
  localRuntimeStop: (runtimeId: string, options) =>
    ipcRenderer.invoke('local-runtime-stop', runtimeId, options),

  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  prepareSourceCapture: (mode) => ipcRenderer.invoke('prepare-source-capture', mode),
  selectSource: (sourceId: string) => ipcRenderer.invoke('select-source', sourceId),
  cancelSourceSelection: () => ipcRenderer.invoke('cancel-source-selection'),
  onShowSourcePicker: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('show-source-picker', listener)
    return () => ipcRenderer.removeListener('show-source-picker', listener)
  },

  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onCheckingForUpdate: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('checking-for-update', listener)
    return () => ipcRenderer.removeListener('checking-for-update', listener)
  },
  onUpdateAvailable: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, info: { version: string; releaseDate?: string; releaseNotes?: string }) => callback(info)
    ipcRenderer.on('update-available', listener)
    return () => ipcRenderer.removeListener('update-available', listener)
  },
  onUpdateNotAvailable: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, info: { version: string }) => callback(info)
    ipcRenderer.on('update-not-available', listener)
    return () => ipcRenderer.removeListener('update-not-available', listener)
  },
  onDownloadProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => callback(progress)
    ipcRenderer.on('download-progress', listener)
    return () => ipcRenderer.removeListener('download-progress', listener)
  },
  onUpdateDownloaded: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, info: { version: string }) => callback(info)
    ipcRenderer.on('update-downloaded', listener)
    return () => ipcRenderer.removeListener('update-downloaded', listener)
  },
  onUpdateError: (callback: (error: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, error: string) => callback(error)
    ipcRenderer.on('update-error', listener)
    return () => ipcRenderer.removeListener('update-error', listener)
  },

  captionToggle: (enable?: boolean, source?: string) =>
    ipcRenderer.invoke('caption-toggle', enable, source) as Promise<boolean>,
  captionGetStatus: () => ipcRenderer.invoke('caption-get-status'),
  captionUpdateText: (
    stableText: string,
    activeText: string,
    isFinal: boolean,
    translatedStableText = '',
    translatedActiveText = '',
  ) => ipcRenderer.invoke(
    'caption-update-text',
    stableText,
    activeText,
    isFinal,
    translatedStableText,
    translatedActiveText,
  ),
  captionUpdateStyle: (style) => ipcRenderer.invoke('caption-update-style', style),
  captionToggleDraggable: (draggable?: boolean) =>
    ipcRenderer.invoke('caption-toggle-draggable', draggable) as Promise<boolean>,
  captionSetInteractive: (interactive: boolean) =>
    ipcRenderer.invoke('caption-set-interactive', interactive) as Promise<boolean>,
  captionGetBounds: () => ipcRenderer.invoke('caption-get-bounds'),
  captionSetBounds: (bounds) => ipcRenderer.invoke('caption-set-bounds', bounds) as Promise<boolean>,
  captionResetPosition: () => ipcRenderer.invoke('caption-reset-position') as Promise<boolean>,
  onCaptionStatusChanged: (callback: (enabled: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean) => callback(enabled)
    ipcRenderer.on('caption-status-changed', listener)
    return () => ipcRenderer.removeListener('caption-status-changed', listener)
  },
  onCaptionTextUpdate: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        stableText: string
        activeText: string
        translatedStableText: string
        translatedActiveText: string
        text: string
        translatedText: string
        isFinal: boolean
      },
    ) => callback(data)
    ipcRenderer.on('caption-text-update', listener)
    return () => ipcRenderer.removeListener('caption-text-update', listener)
  },
  onCaptionStyleUpdate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, style: CaptionStyle) => callback(style)
    ipcRenderer.on('caption-style-update', listener)
    return () => ipcRenderer.removeListener('caption-style-update', listener)
  },
  onCaptionDraggableChanged: (callback: (draggable: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, draggable: boolean) => callback(draggable)
    ipcRenderer.on('caption-draggable-changed', listener)
    return () => ipcRenderer.removeListener('caption-draggable-changed', listener)
  },
  onCaptionInteractiveChanged: (callback: (interactive: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, interactive: boolean) => callback(interactive)
    ipcRenderer.on('caption-interactive-changed', listener)
    return () => ipcRenderer.removeListener('caption-interactive-changed', listener)
  },
  captionOpenSettings: () => ipcRenderer.invoke('caption-open-settings'),
  onOpenCaptionSettings: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('open-caption-settings', listener)
    return () => ipcRenderer.removeListener('open-caption-settings', listener)
  },

  onToggleRecording: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('toggle-recording', listener)
    return () => ipcRenderer.removeListener('toggle-recording', listener)
  },
  onToggleRecordingPause: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('toggle-recording-pause', listener)
    return () => ipcRenderer.removeListener('toggle-recording-pause', listener)
  },

  apiNotifySessionStart: (sessionId: string) => {
    ipcRenderer.send('api-notify-session-start', sessionId)
  },
  apiNotifySessionEnd: (sessionId: string) => {
    ipcRenderer.send('api-notify-session-end', sessionId)
  },

  onApiGetSessions: (callback) => {
    const listener = (event: Electron.IpcRendererEvent, requestId: string, filter?: import('../shared/apiTypes').ApiSessionFilter) => callback(event, requestId, filter)
    ipcRenderer.on('api-get-sessions', listener)
    return () => ipcRenderer.removeListener('api-get-sessions', listener)
  },
  apiRespondSessions: (sessions, requestId) => {
    ipcRenderer.send('api-respond-sessions', sessions, requestId)
  },
  onApiGetSessionDetail: (callback) => {
    const listener = (event: Electron.IpcRendererEvent, sessionId: string, requestId: string) => callback(event, sessionId, requestId)
    ipcRenderer.on('api-get-session-detail', listener)
    return () => ipcRenderer.removeListener('api-get-session-detail', listener)
  },
  apiRespondSessionDetail: (session, requestId) => {
    ipcRenderer.send('api-respond-session-detail', session, requestId)
  },
  onApiSearchSessions: (callback) => {
    const listener = (event: Electron.IpcRendererEvent, query: string, requestId: string, filter?: import('../shared/apiTypes').ApiSessionFilter) => callback(event, query, requestId, filter)
    ipcRenderer.on('api-search-sessions', listener)
    return () => ipcRenderer.removeListener('api-search-sessions', listener)
  },
  apiRespondSearchSessions: (sessions, requestId) => {
    ipcRenderer.send('api-respond-search-sessions', sessions, requestId)
  },
  onApiGetTopics: (callback) => {
    const listener = (event: Electron.IpcRendererEvent, requestId: string) => callback(event, requestId)
    ipcRenderer.on('api-get-topics', listener)
    return () => ipcRenderer.removeListener('api-get-topics', listener)
  },
  apiRespondTopics: (topics, requestId) => {
    ipcRenderer.send('api-respond-topics', topics, requestId)
  },
  onApiGetTags: (callback) => {
    const listener = (event: Electron.IpcRendererEvent, requestId: string) => callback(event, requestId)
    ipcRenderer.on('api-get-tags', listener)
    return () => ipcRenderer.removeListener('api-get-tags', listener)
  },
  apiRespondTags: (tags, requestId) => {
    ipcRenderer.send('api-respond-tags', tags, requestId)
  },
  onApiGetRecordingStatus: (callback) => {
    const listener = (event: Electron.IpcRendererEvent, requestId: string) => callback(event, requestId)
    ipcRenderer.on('api-get-recording-status', listener)
    return () => ipcRenderer.removeListener('api-get-recording-status', listener)
  },
  apiRespondRecordingStatus: (status, requestId) => {
    ipcRenderer.send('api-respond-recording-status', status, requestId)
  },

  apiUpdateOpenApiConfig: (config: { enabled: boolean; token: string }) => {
    ipcRenderer.send('api-update-open-api-config', config)
  },

  cloudBackupTest: (config) => ipcRenderer.invoke('cloud-backup-test', config),
  cloudBackupUpload: (config, jsonData) => ipcRenderer.invoke('cloud-backup-upload', config, jsonData),
  cloudBackupList: (config) => ipcRenderer.invoke('cloud-backup-list', config),
  cloudBackupDownload: (config, key) => ipcRenderer.invoke('cloud-backup-download', config, key),
  cloudBackupDelete: (config, key) => ipcRenderer.invoke('cloud-backup-delete', config, key),

  langChange: (lang: string) => ipcRenderer.invoke('lang:change', lang),

  isElectron: true,
  platform: process.platform as 'win32' | 'darwin' | 'linux',

  exportDiagnostics: (payload) => ipcRenderer.invoke('export-diagnostics', payload),

  safeStorageSet: (key: string, value: string) => ipcRenderer.invoke('safe-storage-set', key, value) as Promise<boolean>,
  safeStorageGet: (key: string) => ipcRenderer.invoke('safe-storage-get', key) as Promise<string | null>,
  safeStorageDelete: (key: string) => ipcRenderer.invoke('safe-storage-delete', key) as Promise<boolean>,
  safeStorageAvailable: () => ipcRenderer.invoke('safe-storage-available') as Promise<boolean>,

  supportsAutoLaunch: process.platform === 'win32' || process.platform === 'darwin',
  supportsAutoUpdate: process.platform !== 'linux' || Boolean(process.env.APPIMAGE),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
