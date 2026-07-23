import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Settings, Check, Volume2, Palette, Bot, Globe, Cloud, HardDrive, Info, Mic, Subtitles } from 'lucide-react'
import { Button } from './ui'
import { useUIStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTagStore } from '../stores/tagStore'
import {
  exportAllData,
  getBackupValidationErrors,
  validateBackupData,
  importDataOverwrite,
  importDataMerge,
  type BackupData,
} from '../utils/storage'
import { ServiceSettingsPanel } from './settings/ServiceSettingsPanel'
import { AppearancePanel } from './settings/AppearancePanel'
import { AiPostProcessPanel } from './settings/AiPostProcessPanel'
import { OpenApiPanel } from './settings/OpenApiPanel'
import { CloudBackupPanel } from './settings/CloudBackupPanel'
import { DataManagementPanel } from './settings/DataManagementPanel'
import { AboutPanel } from './settings/AboutPanel'
import { CaptionSettingsPanel } from './settings/CaptionSettingsPanel'
import { CaptureSettingsPanel } from './settings/CaptureSettingsPanel'
import { ActionDialog } from './ActionDialog'
import type { ASRProviderInfo, ProviderConfigData } from '../types'
import { getMissingRequiredConfigLabels } from '../utils/providerConfig'
import {
  buildProviderConfigFromFormState,
  buildProviderFormState,
  formatStringArrayValue,
  type ProviderFormState,
} from '../utils/providerConfigForm'
import { testProviderConfig } from '../utils/providerConfigTest'
import { getDefaultSettings } from '../utils/storageShared'
import { assertValidMeetingContext, resolveMeetingContextSnapshot } from '../utils/meetingContext'

type SettingsGroup = 'provider' | 'capture' | 'appearance' | 'caption' | 'aiPostProcess' | 'openApi' | 'cloudBackup' | 'dataManagement' | 'about'

interface ApiKeyConfigProps {
  isOpen: boolean
  onClose: () => void
  mode?: 'modal' | 'view'
  onViewChangelog?: () => void
}

const NAV_ITEMS: { id: SettingsGroup; icon: typeof Settings; labelKey: string }[] = [
  { id: 'provider', icon: Volume2, labelKey: 'groupProvider' },
  { id: 'capture', icon: Mic, labelKey: 'groupCapture' },
  { id: 'appearance', icon: Palette, labelKey: 'groupAppearance' },
  { id: 'caption', icon: Subtitles, labelKey: 'groupCaption' },
  { id: 'aiPostProcess', icon: Bot, labelKey: 'groupAi' },
  { id: 'openApi', icon: Globe, labelKey: 'groupOpenApi' },
  { id: 'cloudBackup', icon: Cloud, labelKey: 'groupCloudBackup' },
  { id: 'dataManagement', icon: HardDrive, labelKey: 'groupDataManagement' },
  { id: 'about', icon: Info, labelKey: 'groupAbout' },
]

export function ApiKeyConfig({ isOpen, onClose, mode = 'modal', onViewChangelog }: ApiKeyConfigProps) {
  const isViewMode = mode === 'view'
  const { t, language, setLanguage, colorTheme, setColorTheme } = useUIStore()
  const {
    settings,
    updateSettings,
    updateAiPostProcessConfig,
    updateMeetingContextConfig,
    updateOpenApiConfig,
    updateCloudBackupConfig,
    availableProviders,
    updateProviderConfig,
  } = useSettingsStore()
  const { loadSessions } = useSessionStore()
  const { loadTags } = useTagStore()

  const [activeGroup, setActiveGroup] = useState<SettingsGroup>('provider')

  const currentVendor = settings.currentVendor || 'soniox'
  const currentProvider = availableProviders.find(p => p.id === currentVendor)
  const currentStoredConfig = settings.providerConfigs?.[currentVendor]

  const [formState, setFormState] = useState<ProviderFormState>(() => (
    buildProviderFormState(currentProvider, currentStoredConfig, settings)
  ))
  const [revealedFields, setRevealedFields] = useState<Record<string, boolean>>({})
  const [languageHints, setLanguageHints] = useState(() => (
    formatStringArrayValue(currentStoredConfig?.languageHints, settings.languageHints || ['zh', 'en'])
  ))
  const [aiPostProcessConfig, setAiPostProcessConfig] = useState(
    settings.aiPostProcess || getDefaultSettings().aiPostProcess || {},
  )
  const [meetingContextConfig, setMeetingContextConfig] = useState(
    settings.meetingContext || getDefaultSettings().meetingContext!,
  )

  const [importMessage, setImportMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [pendingImportData, setPendingImportData] = useState<{ data: BackupData } | null>(null)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'not-available' | 'error'>('idle')
  const [appVersion, setAppVersion] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const supportsAutoLaunch = !!window.electronAPI?.supportsAutoLaunch
  const supportsAutoUpdate = !!window.electronAPI?.supportsAutoUpdate

  const snapshotRef = useRef({ formState, languageHints, aiPostProcessConfig, meetingContextConfig, currentVendor: settings.currentVendor })

  useEffect(() => {
    const newFormState = buildProviderFormState(currentProvider, currentStoredConfig, settings)
    const newLanguageHints = formatStringArrayValue(currentStoredConfig?.languageHints, settings.languageHints || ['zh', 'en'])
    const newAiConfig = settings.aiPostProcess || getDefaultSettings().aiPostProcess || {}
    const newMeetingContext = settings.meetingContext || getDefaultSettings().meetingContext!
    setFormState(newFormState)
    setLanguageHints(newLanguageHints)
    setAiPostProcessConfig(newAiConfig)
    setMeetingContextConfig(newMeetingContext)
    setRevealedFields({})
    setTestStatus('idle')
    setTestMessage('')
    snapshotRef.current = { formState: newFormState, languageHints: newLanguageHints, aiPostProcessConfig: newAiConfig, meetingContextConfig: newMeetingContext, currentVendor: settings.currentVendor || 'soniox' }
  }, [currentProvider, currentStoredConfig, settings])

  const isDirty = useMemo(() => {
    const snap = snapshotRef.current
    return (
      JSON.stringify(formState) !== JSON.stringify(snap.formState) ||
      languageHints !== snap.languageHints ||
      JSON.stringify(aiPostProcessConfig) !== JSON.stringify(snap.aiPostProcessConfig) ||
      JSON.stringify(meetingContextConfig) !== JSON.stringify(snap.meetingContextConfig) ||
      (settings.currentVendor || 'soniox') !== snap.currentVendor
    )
  }, [formState, languageHints, aiPostProcessConfig, meetingContextConfig, settings.currentVendor])

  useEffect(() => {
    if (isOpen && window.electronAPI) {
      if (window.electronAPI.supportsAutoLaunch) {
        window.electronAPI.getAutoLaunch?.().then(setAutoLaunch).catch(() => {
          setAutoLaunch(false)
        })
      } else {
        setAutoLaunch(false)
      }
      window.electronAPI.getAppVersion?.().then(setAppVersion)
    }
  }, [isOpen])

  const handleAutoLaunchChange = async (enable: boolean) => {
    if (!window.electronAPI?.setAutoLaunch || !supportsAutoLaunch) return
    try {
      const result = await window.electronAPI.setAutoLaunch(enable)
      setAutoLaunch(result)
    } catch (error) {
      console.error('Failed to set auto launch:', error)
    }
  }

  const handleCheckUpdate = useCallback(async () => {
    if (!window.electronAPI?.checkForUpdates) return
    setUpdateStatus('checking')
    const result = await window.electronAPI.checkForUpdates()
    if (result.error) {
      setUpdateStatus('error')
      setTimeout(() => setUpdateStatus('idle'), 3000)
    } else if (result.success) {
      setTimeout(() => {
        if (updateStatus === 'checking') {
          setUpdateStatus('not-available')
          setTimeout(() => setUpdateStatus('idle'), 3000)
        }
      }, 5000)
    }
  }, [updateStatus])

  const updateFormField = (fieldKey: string, value: string | boolean) => {
    setFormState(prev => ({ ...prev, [fieldKey]: value }))
    if (testStatus !== 'idle' || testMessage) {
      setTestStatus('idle')
      setTestMessage('')
    }
  }

  const toggleFieldVisibility = (fieldKey: string) => {
    setRevealedFields(prev => ({ ...prev, [fieldKey]: !prev[fieldKey] }))
  }

  const getStringFieldValue = (fieldKey: string): string => {
    const value = formState[fieldKey]
    return typeof value === 'string' ? value : ''
  }

  const getBooleanFieldValue = (fieldKey: string): boolean => {
    return Boolean(formState[fieldKey])
  }

  const buildEditableProviderConfig = (): ProviderConfigData => (
    buildProviderConfigFromFormState(currentProvider, formState, languageHints)
  )

  const getProviderConsoleUrl = (provider: ASRProviderInfo | undefined): string => {
    switch (provider?.id) {
      case 'soniox': return 'https://console.soniox.com'
      case 'volc': return 'https://console.volcengine.com/speech/app'
      case 'local_openai': return 'https://platform.openai.com/docs/api-reference/audio'
      default: return provider?.website || '#'
    }
  }

  const handleTestConfig = async () => {
    if (!currentProvider?.capabilities.supportsConfigTest) return
    setTestStatus('testing')
    setTestMessage('')
    try {
      const providerConfig = buildEditableProviderConfig()
      const missingLabels = getMissingRequiredConfigLabels(currentProvider, providerConfig)
      if (missingLabels.length > 0) {
        throw new Error(`Please fill: ${missingLabels.join(', ')}`)
      }
      const testConfig = currentVendor === 'soniox'
        ? {
            ...providerConfig,
            meetingContext: resolveMeetingContextSnapshot(
              meetingContextConfig,
              aiPostProcessConfig.glossary,
            ),
          }
        : providerConfig
      await testProviderConfig(currentProvider, testConfig)
      setTestStatus('success')
      setTestMessage(t.settings?.testSuccess || 'Configuration verified!')
      setTimeout(() => { setTestStatus('idle'); setTestMessage('') }, 3000)
    } catch (error) {
      setTestStatus('error')
      setTestMessage(error instanceof Error ? error.message : 'Verification failed')
    }
  }

  const handleSave = async () => {
    try {
      const providerConfig = buildEditableProviderConfig()
      const normalizedHints = Array.isArray(providerConfig.languageHints)
        ? providerConfig.languageHints.map((item) => String(item).trim()).filter(Boolean)
        : []
      const missingLabels = getMissingRequiredConfigLabels(currentProvider, providerConfig)
      if (missingLabels.length > 0) {
        throw new Error(`Please fill: ${missingLabels.join(', ')}`)
      }
      updateProviderConfig(currentVendor, providerConfig)
      const shouldSyncLegacyApiKey = currentProvider?.requiredConfigKeys.includes('apiKey')
      updateSettings({
        apiKey: shouldSyncLegacyApiKey && typeof providerConfig.apiKey === 'string'
          ? providerConfig.apiKey.trim()
          : settings.apiKey,
        languageHints: normalizedHints,
      })
      const normalizedAiConfig = aiPostProcessConfig.autoAiPostProcess
        ? { ...aiPostProcessConfig, autoCorrectionDetection: false }
        : aiPostProcessConfig
      assertValidMeetingContext(meetingContextConfig, normalizedAiConfig.glossary, { includeDisabled: true })
      updateMeetingContextConfig(meetingContextConfig)
      await updateAiPostProcessConfig(normalizedAiConfig)
      onClose()
    } catch (error) {
      setTestStatus('error')
      setTestMessage(error instanceof Error ? error.message : 'Invalid settings')
    }
  }

  const handleExport = async () => {
    try {
      await exportAllData()
      setImportMessage({ type: 'success', text: t.settings.dataExported })
      setTimeout(() => setImportMessage(null), 3000)
    } catch {
      setImportMessage({ type: 'error', text: t.settings.importFailed })
    }
  }

  const handleImportClick = () => { fileInputRef.current?.click() }

  const handleExportDiagnostics = async () => {
    if (!window.electronAPI?.exportDiagnostics) return
    const settingsData = { ...settings } as Record<string, unknown>
    const localStorageKeys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key) localStorageKeys.push(key)
    }
    const result = await window.electronAPI.exportDiagnostics({ settings: settingsData, localStorageKeys })
    if (result.success) {
      setImportMessage({ type: 'success', text: t.settings.diagnosticsExported })
      setTimeout(() => setImportMessage(null), 3000)
    } else if (result.reason !== 'cancelled') {
      setImportMessage({ type: 'error', text: `${t.settings.diagnosticsExportFailed}: ${result.reason}` })
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const validationErrors = getBackupValidationErrors(data)
      if (!validateBackupData(data)) {
        setImportMessage({
          type: 'error',
          text: validationErrors.length > 0
            ? `${t.settings.invalidBackupFile}: ${validationErrors[0]}`
            : t.settings.invalidBackupFile,
        })
        return
      }
      setPendingImportData({ data })
    } catch (error) {
      const message = error instanceof SyntaxError
        ? `${t.settings.invalidBackupFile}: invalid JSON`
        : error instanceof Error ? error.message : t.settings.importFailed
      setImportMessage({ type: 'error', text: message })
    }
    e.target.value = ''
  }

  const handleApplyImport = useCallback(async (importMode: 'overwrite' | 'merge') => {
    if (!pendingImportData) return
    try {
      if (importMode === 'overwrite') {
        const result = await importDataOverwrite(pendingImportData.data)
        setImportMessage({ type: 'success', text: t.settings.importedOverwrite(result.sessions, result.tags) })
      } else {
        const result = await importDataMerge(pendingImportData.data)
        setImportMessage({ type: 'success', text: t.settings.importedMerge(result.newSessions, result.newTags) })
      }
      await loadSessions()
      loadTags()
    } catch (error) {
      setImportMessage({ type: 'error', text: error instanceof Error ? error.message : t.settings.importFailed })
    } finally {
      setPendingImportData(null)
    }
  }, [loadSessions, loadTags, pendingImportData, t.settings])

  useEffect(() => {
    if (!isOpen) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen && !isViewMode) return null

  const settingsContent = (
    <div className="flex h-full">
      {/* Left navigation */}
      <nav className="w-48 shrink-0 border-r border-border/40 p-3 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon
          const label = (t.settings as unknown as Record<string, string>)?.[item.labelKey] ?? item.id
          const active = activeGroup === item.id
          return (
            <button
              key={item.id}
              onClick={() => setActiveGroup(item.id)}
              className={`
                w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors
                ${active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }
              `}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          )
        })}
      </nav>

      {/* Right content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl space-y-6">
            {activeGroup === 'provider' && (
              <ServiceSettingsPanel
                t={t}
                currentProvider={currentProvider}
                languageHints={languageHints}
                onLanguageHintsChange={(value) => {
                  setLanguageHints(value)
                  if (testStatus !== 'idle' || testMessage) {
                    setTestStatus('idle')
                    setTestMessage('')
                  }
                }}
                getProviderConsoleUrl={getProviderConsoleUrl}
                updateFormField={updateFormField}
                getStringFieldValue={getStringFieldValue}
                getBooleanFieldValue={getBooleanFieldValue}
                revealedFields={revealedFields}
                toggleFieldVisibility={toggleFieldVisibility}
                buildEditableProviderConfig={buildEditableProviderConfig}
                onRunConfigTest={handleTestConfig}
                testStatus={testStatus}
                testMessage={testMessage}
                onBundledRuntimePatch={(patch) => {
                  for (const [key, value] of Object.entries(patch)) {
                    if (typeof value === 'boolean') updateFormField(key, value)
                    else if (typeof value === 'number') updateFormField(key, String(value))
                    else if (typeof value === 'string') updateFormField(key, value)
                  }
                }}
              />
            )}

            {activeGroup === 'appearance' && (
              <AppearancePanel
                t={t}
                language={language}
                setLanguage={setLanguage}
                colorTheme={colorTheme}
                setColorTheme={setColorTheme}
              />
            )}

            {activeGroup === 'capture' && (
              <CaptureSettingsPanel
                t={t}
                captureSettings={settings.capture || getDefaultSettings().capture || { includeMicrophone: true, microphoneDeviceId: '' }}
                updateCaptureSettings={(capture) => updateSettings({ capture })}
              />
            )}

            {activeGroup === 'caption' && (
              <CaptionSettingsPanel t={t} />
            )}

            {activeGroup === 'aiPostProcess' && (
              <AiPostProcessPanel
                t={t}
                language={language}
                aiPostProcessConfig={aiPostProcessConfig}
                updateAiPostProcessConfig={(patch) => {
                  setAiPostProcessConfig((prev) => ({ ...prev, ...patch }))
                }}
                meetingContextConfig={meetingContextConfig}
                updateMeetingContextConfig={(patch) => {
                  setMeetingContextConfig((prev) => ({ ...prev, ...patch }))
                }}
              />
            )}

            {activeGroup === 'openApi' && (
              <OpenApiPanel
                t={t}
                openApiConfig={settings.openApi || { enabled: false, token: '' }}
                updateOpenApiConfig={updateOpenApiConfig}
              />
            )}

            {activeGroup === 'cloudBackup' && (
              <CloudBackupPanel
                t={t}
                cloudBackupConfig={settings.cloudBackup || { enabled: false, provider: 's3' }}
                updateCloudBackupConfig={updateCloudBackupConfig}
              />
            )}

            {activeGroup === 'dataManagement' && (
              <DataManagementPanel
                t={t}
                handleExport={handleExport}
                handleImportClick={handleImportClick}
                fileInputRef={fileInputRef}
                handleFileChange={handleFileChange}
                importMessage={importMessage}
                handleExportDiagnostics={handleExportDiagnostics}
              />
            )}

            {activeGroup === 'about' && (
              <AboutPanel
                t={t}
                language={language}
                settings={settings}
                updateSettings={updateSettings}
                supportsAutoLaunch={supportsAutoLaunch}
                autoLaunch={autoLaunch}
                handleAutoLaunchChange={handleAutoLaunchChange}
                supportsAutoUpdate={supportsAutoUpdate}
                appVersion={appVersion}
                updateStatus={updateStatus}
                handleCheckUpdate={handleCheckUpdate}
                onViewChangelog={onViewChangelog}
              />
            )}
          </div>
        </div>

        {/* Save bar — only shown for groups that need manual save */}
        {(activeGroup === 'provider' || activeGroup === 'aiPostProcess') && (
          <div className="flex items-center justify-end gap-3 px-6 py-3 bg-muted/30 border-t border-border shrink-0">
            {isDirty && (
              <span className="mr-auto text-xs text-warning font-medium">
                {t.electron.unsavedChanges}
              </span>
            )}
            <Button variant="primary" onClick={() => void handleSave()}>
              <Check className="w-4 h-4" />
              {t.common.save}
            </Button>
          </div>
        )}
      </div>

      <ActionDialog
        open={pendingImportData !== null}
        title={t.electron.chooseImportMode}
        description={pendingImportData
          ? t.settings.importConfirm(pendingImportData.data.sessions.length, pendingImportData.data.tags.length)
          : ''
        }
        onClose={() => setPendingImportData(null)}
        actions={[
          { label: t.common.cancel, onClick: () => setPendingImportData(null), variant: 'secondary' },
          { label: t.electron.mergeImport, onClick: () => void handleApplyImport('merge'), variant: 'secondary' },
          { label: t.electron.overwriteImport, onClick: () => void handleApplyImport('overwrite'), variant: 'primary' },
        ]}
      />
    </div>
  )

  if (isViewMode) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-card text-card-foreground">
        {settingsContent}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm dark:bg-black/60 animate-in fade-in duration-200">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className="mx-4 flex h-[min(92vh,58rem)] w-full max-w-[min(78rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl dark:ring-1 dark:ring-white/[0.08] animate-in zoom-in-95 duration-200"
      >
        {settingsContent}
      </div>
    </div>
  )
}
