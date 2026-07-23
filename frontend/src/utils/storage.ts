export {
  addSession,
  deleteSession,
  getSessions,
  saveSessions,
  updateSession,
} from './sessionStorage'

export {
  getSettings,
  getTags,
  getTopics,
  initStorage,
  saveSettings,
  saveTags,
  saveTopics,
} from './settingsStorage'

export {
  encryptApiKeyForStorage,
  migrateApiKeysToSafeStorage,
  resolveApiKeysFromSafeStorage,
  SAFE_STORAGE_PLACEHOLDER,
} from './secretStorage'

export {
  CURRENT_BACKUP_SCHEMA_VERSION,
  CURRENT_BACKUP_VERSION,
  exportAllData,
  getBackupValidationErrors,
  importDataMerge,
  importDataOverwrite,
  sanitizeSettingsForBackup,
  type BackupData,
  upgradeBackupData,
  validateBackupData,
} from './backupStorage'

export {
  buildSessionExportFilename,
  exportToTxt,
  exportToMarkdown,
  exportAiAnalysisToTxt,
  exportAiAnalysisToMarkdown,
  formatDate,
  formatTime,
  generateId,
} from './storageUtils'
