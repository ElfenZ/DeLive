import type {
  AiPostProcessConfig,
  AppSettings,
  CaptionStyle,
  DeletedSessionSnapshot,
  ProviderConfigData,
  Tag,
  Topic,
  TranscriptSession,
} from '../types'
import { getSessions } from './sessionStorage'
import { getSettings, getTags, getTopics, saveSettings, saveTags, saveTopics } from './settingsStorage'
import { normalizeTranscriptSessions } from './sessionSchema'
import { DELETED_SESSION_STORE, getDefaultSettings, META_KEY_SESSIONS_MIGRATED, META_STORE, openAppDatabase, SESSION_STORE, STORAGE_KEYS, supportsIndexedDb } from './storageShared'
import { generateId } from './storageUtils'
import { normalizeGlossaryEntries, normalizeMeetingContextConfig } from './meetingContext'
import { nextAiCredentialVersion } from '../services/aiProtocol'
import { normalizeProjects, validateProjectHierarchy } from './projectSchema'
import { getDeletedSessionSnapshots, normalizeDeletedSessionSnapshot, replaceDeletedSessionSnapshots } from './deletedSessionStorage'

export const CURRENT_BACKUP_VERSION = '5.0'
export const CURRENT_BACKUP_SCHEMA_VERSION = 5

export function mergeImportedAiPostProcessConfig(
  current: AiPostProcessConfig | undefined,
  incoming: AiPostProcessConfig | undefined,
): AiPostProcessConfig {
  const mergedApiKey = current?.apiKey || incoming?.apiKey
  return {
    ...(incoming || {}),
    apiKey: mergedApiKey,
    credentialVersion: nextAiCredentialVersion(
      {
        baseUrl: incoming?.baseUrl,
        apiKey: incoming?.apiKey,
        provider: incoming?.provider,
        credentialVersion: incoming?.credentialVersion,
      },
      { baseUrl: incoming?.baseUrl, apiKey: mergedApiKey, provider: incoming?.provider },
    ),
  }
}

function mergeProviderApiKeys(
  current?: Record<string, ProviderConfigData>,
  incoming?: Record<string, ProviderConfigData>,
): Record<string, ProviderConfigData> | undefined {
  if (!incoming) return current
  if (!current) return incoming

  const merged = { ...incoming }
  for (const [vendor, cfg] of Object.entries(current)) {
    if (!cfg.apiKey && !cfg.appKey && !cfg.accessKey) continue
    if (!merged[vendor]) {
      merged[vendor] = cfg
    } else {
      merged[vendor] = {
        ...merged[vendor],
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.appKey ? { appKey: cfg.appKey } : {}),
        ...(cfg.accessKey ? { accessKey: cfg.accessKey } : {}),
        ...(cfg.apiToken ? { apiToken: cfg.apiToken } : {}),
      }
    }
  }
  return merged
}

export interface BackupData {
  version: string
  schemaVersion?: number
  exportedAt: string
  sessions: TranscriptSession[]
  tags: Tag[]
  settings: AppSettings
  topics?: Topic[]
  deletedSessionSnapshots?: DeletedSessionSnapshot[]
}

export function getBackupValidationErrors(data: unknown): string[] {
  if (!isRecord(data)) {
    return ['Backup payload must be an object']
  }

  const errors: string[] = []
  if (typeof data.version === 'string' && Number.parseFloat(data.version) > Number.parseFloat(CURRENT_BACKUP_VERSION)) errors.push('Unsupported future backup version')
  if (typeof data.schemaVersion === 'number' && data.schemaVersion > CURRENT_BACKUP_SCHEMA_VERSION) errors.push('Unsupported future backup schemaVersion')
  for (const key of ['topics', 'deletedSessionSnapshots']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) errors.push(`Invalid "${key}" array`)
  }

  if (typeof data.version !== 'string' || data.version.trim().length === 0) {
    errors.push('Missing or invalid "version"')
  }

  if (data.schemaVersion !== undefined && (typeof data.schemaVersion !== 'number' || !Number.isSafeInteger(data.schemaVersion) || data.schemaVersion < 1)) {
    errors.push('Invalid "schemaVersion"')
  }

  if (data.exportedAt !== undefined && typeof data.exportedAt !== 'string') {
    errors.push('Invalid "exportedAt"')
  }

  if (!Array.isArray(data.sessions)) {
    errors.push('Missing or invalid "sessions" array')
  } else {
    data.sessions.forEach((session, index) => {
      if (!isRecord(session)) {
        errors.push(`sessions[${index}] must be an object`)
      }
    })
  }

  if (!Array.isArray(data.tags)) {
    errors.push('Missing or invalid "tags" array')
  } else {
    data.tags.forEach((tag, index) => {
      if (!isRecord(tag)) {
        errors.push(`tags[${index}] must be an object`)
      }
    })
  }

  if (!isRecord(data.settings)) {
    errors.push('Missing or invalid "settings" object')
  }

  return errors
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function normalizeTag(value: unknown): Tag | null {
  if (!isRecord(value)) {
    return null
  }

  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!id || !name) {
    return null
  }

  return {
    id,
    name,
    color: typeof value.color === 'string' && value.color.trim().length > 0
      ? value.color
      : 'blue',
  }
}

function normalizeProviderConfigs(value: unknown): Record<string, ProviderConfigData> | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(value).map(([providerId, config]) => [
      providerId,
      isRecord(config) ? { ...(config as ProviderConfigData) } : {},
    ]),
  )
}

function normalizeCaptionStyle(
  value: unknown,
  fallback: CaptionStyle | undefined,
): CaptionStyle | undefined {
  if (!fallback) {
    return undefined
  }

  if (!isRecord(value)) {
    return fallback
  }

  return {
    ...fallback,
    ...(value as Partial<CaptionStyle>),
  }
}

function normalizeAiPostProcessConfig(value: unknown): AiPostProcessConfig | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const provider = value.provider === 'openai-compatible' || value.provider === 'anthropic-compatible'
    ? value.provider
    : 'openai-compatible'
  const thinkingMode = value.thinkingMode === 'disabled' ? 'disabled' : 'default'
  const promptLanguage = value.promptLanguage === 'en' || value.promptLanguage === 'zh'
    ? value.promptLanguage
    : undefined
  const correctionMode = value.correctionMode === 'quick' || value.correctionMode === 'review'
    ? value.correctionMode
    : undefined
  const preferCorrectedText = value.preferCorrectedText === 'auto'
    || value.preferCorrectedText === 'original'
    || value.preferCorrectedText === 'corrected'
    ? value.preferCorrectedText
    : undefined
  const glossary = value.glossary === undefined
    ? undefined
    : normalizeGlossaryEntries(value.glossary, { includeDisabled: true }).value
      .map((entry) => ({ ...entry, id: entry.id || generateId() }))
  const correctionStructuredOutput = value.correctionStructuredOutput === 'prompt-json'
    || value.correctionStructuredOutput === 'json_object'
    || value.correctionStructuredOutput === 'json_schema'
    ? provider === 'anthropic-compatible' && value.correctionStructuredOutput === 'json_object'
      ? 'prompt-json'
      : value.correctionStructuredOutput
    : undefined
  const advancedValue = isRecord(value.correctionAdvanced) ? value.correctionAdvanced : undefined
  const safetyValue = advancedValue && isRecord(advancedValue.safetyLimits) ? advancedValue.safetyLimits : undefined
  const positiveInteger = (candidate: unknown): number | undefined => (
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0 ? candidate : undefined
  )
  const nonNegativeInteger = (candidate: unknown): number | undefined => (
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 ? candidate : undefined
  )
  const nonNegativeNumber = (candidate: unknown): number | undefined => (
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined
  )
  const safetyLimits = safetyValue ? {
    maxPatchTextLength: positiveInteger(safetyValue.maxPatchTextLength),
    maxPatchesPerShard: positiveInteger(safetyValue.maxPatchesPerShard),
    maxCumulativeEditRatio: nonNegativeNumber(safetyValue.maxCumulativeEditRatio),
    maxNetLengthChangeRatio: nonNegativeNumber(safetyValue.maxNetLengthChangeRatio),
  } : undefined
  const normalizedSafetyLimits = safetyLimits && Object.values(safetyLimits).some((item) => item !== undefined)
    ? safetyLimits
    : undefined
  const correctionAdvanced = advancedValue ? {
    chunkSize: positiveInteger(advancedValue.chunkSize),
    contextSize: nonNegativeInteger(advancedValue.contextSize),
    concurrency: positiveInteger(advancedValue.concurrency),
    safetyLimits: normalizedSafetyLimits,
  } : undefined
  const normalizedCorrectionAdvanced = correctionAdvanced && Object.values(correctionAdvanced).some((item) => item !== undefined)
    ? correctionAdvanced
    : undefined

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    provider,
    thinkingMode,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : undefined,
    model: typeof value.model === 'string' ? value.model : undefined,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : undefined,
    credentialVersion: positiveInteger(value.credentialVersion),
    promptLanguage,
    availableModels: Array.isArray(value.availableModels) ? normalizeStringArray(value.availableModels) : undefined,
    selectedModels: Array.isArray(value.selectedModels) ? normalizeStringArray(value.selectedModels) : undefined,
    defaultModel: typeof value.defaultModel === 'string' ? value.defaultModel : undefined,
    modelAssignment: isRecord(value.modelAssignment) ? value.modelAssignment as AiPostProcessConfig['modelAssignment'] : undefined,
    correctionMode,
    preferCorrectedText,
    enableStreaming: typeof value.enableStreaming === 'boolean' ? value.enableStreaming : undefined,
    glossary,
    autoCorrectionDetection: typeof value.autoCorrectionDetection === 'boolean' ? value.autoCorrectionDetection : undefined,
    autoAiPostProcess: typeof value.autoAiPostProcess === 'boolean' ? value.autoAiPostProcess : undefined,
    autoExportCorrectedMarkdown: typeof value.autoExportCorrectedMarkdown === 'boolean'
      ? value.autoExportCorrectedMarkdown
      : undefined,
    autoExportDirectory: undefined,
    correctionStructuredOutput,
    correctionAdvanced: normalizedCorrectionAdvanced,
  }
}

const SECRET_SETTING_KEY = /(api.?key|api.?token|access.?key|app.?key|secret|password|token)$/i

export function sanitizeSettingsForBackup(settings: AppSettings): AppSettings {
  const providerConfigs = settings.providerConfigs
    ? Object.fromEntries(Object.entries(settings.providerConfigs).map(([providerId, config]) => [
        providerId,
        Object.fromEntries(Object.entries(config).map(([key, value]) => [
          key,
          SECRET_SETTING_KEY.test(key) ? '' : value,
        ])),
      ]))
    : undefined

  return {
    ...settings,
    apiKey: '',
    providerConfigs,
    aiPostProcess: settings.aiPostProcess
      ? { ...settings.aiPostProcess, apiKey: '', autoExportDirectory: undefined }
      : undefined,
    openApi: settings.openApi
      ? { ...settings.openApi, token: '' }
      : undefined,
    cloudBackup: settings.cloudBackup
      ? {
          ...settings.cloudBackup,
          s3: settings.cloudBackup.s3
            ? { ...settings.cloudBackup.s3, accessKeyId: '', secretAccessKey: '' }
            : undefined,
          webdav: settings.cloudBackup.webdav
            ? { ...settings.cloudBackup.webdav, password: '' }
            : undefined,
        }
      : undefined,
  }
}

function normalizeSettings(value: unknown): AppSettings {
  const defaults = getDefaultSettings()
  const record = isRecord(value) ? value : {}

  return {
    ...defaults,
    autoSavePublishedCorrection: typeof record.autoSavePublishedCorrection === 'boolean' ? record.autoSavePublishedCorrection : undefined,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : defaults.apiKey,
    languageHints: Array.isArray(record.languageHints)
      ? normalizeStringArray(record.languageHints)
      : defaults.languageHints,
    currentVendor: typeof record.currentVendor === 'string' ? record.currentVendor : undefined,
    providerConfigs: normalizeProviderConfigs(record.providerConfigs),
    autoCheckUpdate: typeof record.autoCheckUpdate === 'boolean' ? record.autoCheckUpdate : undefined,
    captionStyle: normalizeCaptionStyle(record.captionStyle, defaults.captionStyle),
    colorTheme: typeof record.colorTheme === 'string' ? record.colorTheme : undefined,
    aiPostProcess: {
      ...defaults.aiPostProcess,
      ...(normalizeAiPostProcessConfig(record.aiPostProcess) || {}),
    },
    meetingContext: normalizeMeetingContextConfig(record.meetingContext).value,
    openApi: {
      ...defaults.openApi,
      ...(isRecord(record.openApi) ? {
        enabled: typeof record.openApi.enabled === 'boolean' ? record.openApi.enabled : false,
        token: typeof record.openApi.token === 'string' ? record.openApi.token : '',
      } : {}),
    },
    cloudBackup: {
      ...defaults.cloudBackup,
      ...(isRecord(record.cloudBackup) ? {
        enabled: typeof record.cloudBackup.enabled === 'boolean' ? record.cloudBackup.enabled : false,
        provider: record.cloudBackup.provider === 's3' || record.cloudBackup.provider === 'webdav'
          ? record.cloudBackup.provider : 's3',
        autoBackupOnComplete: typeof record.cloudBackup.autoBackupOnComplete === 'boolean'
          ? record.cloudBackup.autoBackupOnComplete : false,
        s3: isRecord(record.cloudBackup.s3) ? {
          endpoint: getString(record.cloudBackup.s3.endpoint),
          region: getString(record.cloudBackup.s3.region),
          bucket: getString(record.cloudBackup.s3.bucket),
          prefix: getString(record.cloudBackup.s3.prefix),
          accessKeyId: getString(record.cloudBackup.s3.accessKeyId),
          secretAccessKey: getString(record.cloudBackup.s3.secretAccessKey),
          forcePathStyle: typeof record.cloudBackup.s3.forcePathStyle === 'boolean'
            ? record.cloudBackup.s3.forcePathStyle
            : undefined,
        } : undefined,
        webdav: isRecord(record.cloudBackup.webdav) ? {
          url: getString(record.cloudBackup.webdav.url),
          username: getString(record.cloudBackup.webdav.username),
          password: getString(record.cloudBackup.webdav.password),
          basePath: getString(record.cloudBackup.webdav.basePath),
        } : undefined,
      } : {}),
    },
  }
}

export async function buildBackupData(): Promise<BackupData> {
  return upgradeBackupData({
    version: CURRENT_BACKUP_VERSION,
    schemaVersion: CURRENT_BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sessions: normalizeTranscriptSessions(await getSessions()),
    tags: getTags(),
    settings: sanitizeSettingsForBackup(getSettings()),
    topics: getTopics(),
    deletedSessionSnapshots: await getDeletedSessionSnapshots(),
  })
}

export async function exportAllData(): Promise<void> {
  const data = await buildBackupData()

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `desktoplive_backup_${new Date().toISOString().split('T')[0]}.json`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function validateBackupData(data: unknown): data is BackupData {
  return getBackupValidationErrors(data).length === 0
}

export function upgradeBackupData(data: BackupData): BackupData {
  const errors = getBackupValidationErrors(data)
  if (errors.length) throw new Error(errors.join('; '))
  const topics = normalizeProjects(data.topics ?? [])
  validateProjectHierarchy(topics)
  const snapshots = (data.deletedSessionSnapshots ?? []).map(normalizeDeletedSessionSnapshot)
  if (snapshots.some((snapshot) => !snapshot)) throw new Error('Invalid or unsupported deleted-result snapshot')
  const sessions = normalizeTranscriptSessions(data.sessions).map((session) => ({
    ...session,
    sourceMeta: session.sourceMeta ? { ...session.sourceMeta, audioPath: undefined, audioAvailable: false, audioError: 'Requires local verification', originalSourceId: undefined, originalSourceRevision: undefined } : undefined,
    correctedMarkdownFile: session.correctedMarkdownFile ? { status: 'missing' as const, revision: 0, publicationId: session.correctedMarkdownFile.publicationId, publicationRevision: session.correctedMarkdownFile.publicationRevision, error: 'Requires local verification' } : undefined,
    autoPostProcessWorkflow: session.autoPostProcessWorkflow ? { ...session.autoPostProcessWorkflow, exportPath: undefined, exportedAt: undefined } : undefined,
  }))
  for (const [label, records] of [['Session', sessions], ['snapshot', snapshots], ['tag', data.tags]] as const) {
    const ids = records.map((record) => record?.id)
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} IDs in backup`)
  }
  if (sessions.some((session) => snapshots.some((snapshot) => snapshot?.id === session.id))) throw new Error('Session ID conflicts with deleted-result snapshot')
  return {
    version: CURRENT_BACKUP_VERSION,
    schemaVersion: CURRENT_BACKUP_SCHEMA_VERSION,
    exportedAt: data.exportedAt || new Date().toISOString(),
    sessions,
    tags: data.tags
      .map(normalizeTag)
      .filter((tag): tag is Tag => tag !== null),
    settings: normalizeSettings(data.settings),
    topics,
    deletedSessionSnapshots: snapshots as DeletedSessionSnapshot[],
  }
}

async function restoreRecords(sessions: TranscriptSession[], snapshots: DeletedSessionSnapshot[]): Promise<void> {
  if (!supportsIndexedDb()) {
    await replaceDeletedSessionSnapshots(snapshots)
    const serialized = JSON.stringify(sessions)
    localStorage.setItem(STORAGE_KEYS.SESSIONS, serialized)
    if (localStorage.getItem(STORAGE_KEYS.SESSIONS) !== serialized) throw new Error('Session restore verification failed')
    return
  }
  const db = await openAppDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([SESSION_STORE, DELETED_SESSION_STORE, META_STORE], 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Backup restore failed'))
    transaction.onabort = () => reject(transaction.error || new Error('Backup restore aborted'))
    const sessionStore = transaction.objectStore(SESSION_STORE)
    const snapshotStore = transaction.objectStore(DELETED_SESSION_STORE)
    sessionStore.clear()
    snapshotStore.clear()
    sessions.forEach((session) => sessionStore.put(session))
    snapshots.forEach((snapshot) => snapshotStore.put(snapshot))
    transaction.objectStore(META_STORE).put({ key: META_KEY_SESSIONS_MIGRATED, value: true })
  })
  localStorage.removeItem(STORAGE_KEYS.SESSIONS)
  if (localStorage.getItem(STORAGE_KEYS.SESSIONS) !== null) throw new Error('Cannot clear legacy Session restore cache')
}

function verifyRestoredValue(key: string, value: unknown): void {
  if (localStorage.getItem(key) !== JSON.stringify(value)) throw new Error(`Backup restore write verification failed: ${key}`)
}

export async function importDataOverwrite(
  data: BackupData,
): Promise<{ sessions: number; tags: number; topics: number }> {
  const normalized = upgradeBackupData(data)
  await restoreRecords(normalized.sessions, normalized.deletedSessionSnapshots ?? [])
  saveTags(normalized.tags)
  verifyRestoredValue(STORAGE_KEYS.TAGS, normalized.tags)
  saveTopics(normalized.topics ?? [])

  const currentSettings = getSettings()
  const mergedProviderConfigs = mergeProviderApiKeys(
    currentSettings.providerConfigs,
    normalized.settings.providerConfigs,
  )
  const baseS3 = normalized.settings.cloudBackup?.s3 || currentSettings.cloudBackup?.s3
  const mergedS3 = baseS3 ? {
    ...baseS3,
    accessKeyId: currentSettings.cloudBackup?.s3?.accessKeyId || baseS3.accessKeyId,
    secretAccessKey: currentSettings.cloudBackup?.s3?.secretAccessKey || baseS3.secretAccessKey,
  } : undefined
  const baseWebdav = normalized.settings.cloudBackup?.webdav || currentSettings.cloudBackup?.webdav
  const mergedWebdav = baseWebdav ? {
    ...baseWebdav,
    password: currentSettings.cloudBackup?.webdav?.password || baseWebdav.password,
  } : undefined
  const restoredSettings: AppSettings = {
    ...normalized.settings,
    apiKey: currentSettings.apiKey || normalized.settings.apiKey,
    providerConfigs: mergedProviderConfigs,
    aiPostProcess: mergeImportedAiPostProcessConfig(
      currentSettings.aiPostProcess,
      normalized.settings.aiPostProcess,
    ),
    openApi: {
      ...(normalized.settings.openApi || {}),
      token: currentSettings.openApi?.token || normalized.settings.openApi?.token,
    },
    cloudBackup: {
      ...(normalized.settings.cloudBackup || {}),
      s3: mergedS3,
      webdav: mergedWebdav,
    },
  }
  saveSettings(restoredSettings)
  verifyRestoredValue(STORAGE_KEYS.SETTINGS, restoredSettings)

  return {
    sessions: normalized.sessions.length,
    tags: normalized.tags.length,
    topics: normalized.topics?.length ?? 0,
  }
}

export async function importDataMerge(
  data: BackupData,
): Promise<{ sessions: number; tags: number; topics: number; newSessions: number; newTags: number; newTopics: number }> {
  const normalized = upgradeBackupData(data)
  const existingSessions = await getSessions()
  const existingTags = getTags()
  const existingTopics = getTopics()
  const existingSnapshots = await getDeletedSessionSnapshots()
  for (const [label, incoming, existing] of [
    ['Session', normalized.sessions, [...existingSessions, ...existingSnapshots]],
    ['project', normalized.topics ?? [], existingTopics],
    ['tag', normalized.tags, existingTags],
    ['snapshot', normalized.deletedSessionSnapshots ?? [], [...existingSnapshots, ...existingSessions]],
  ] as const) {
    const ids = new Set(existing.map((record) => record.id))
    const conflicts = incoming.filter((record) => ids.has(record.id)).map((record) => record.id)
    if (conflicts.length) throw new Error(`Backup merge ${label} ID conflicts: ${conflicts.join(', ')}`)
  }
  validateProjectHierarchy([...existingTopics, ...(normalized.topics ?? [])])

  const existingSessionIds = new Set(existingSessions.map((session) => session.id))
  const newSessions = normalized.sessions.filter((session) => !existingSessionIds.has(session.id))
  const mergedSessions = [...existingSessions, ...newSessions]
  await restoreRecords(mergedSessions, [...existingSnapshots, ...(normalized.deletedSessionSnapshots ?? [])])

  const existingTagIds = new Set(existingTags.map((tag) => tag.id))
  const newTags = normalized.tags.filter((tag) => !existingTagIds.has(tag.id))
  const mergedTags = [...existingTags, ...newTags]
  saveTags(mergedTags)
  verifyRestoredValue(STORAGE_KEYS.TAGS, mergedTags)

  const existingTopicIds = new Set(existingTopics.map((topic) => topic.id))
  const incomingTopics = normalized.topics ?? []
  const newTopicsArr = incomingTopics.filter((topic) => !existingTopicIds.has(topic.id))
  const mergedTopics = [...existingTopics, ...newTopicsArr]
  saveTopics(mergedTopics)

  return {
    sessions: mergedSessions.length,
    tags: mergedTags.length,
    topics: mergedTopics.length,
    newSessions: newSessions.length,
    newTags: newTags.length,
    newTopics: newTopicsArr.length,
  }
}
