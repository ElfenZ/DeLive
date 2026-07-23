import { useEffect, useState } from 'react'
import { Mic, Pause, Play, Square, Loader2, Settings2, RefreshCw } from 'lucide-react'
import { useUIStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { buildProviderConnectConfig, isProviderConfigured } from '../utils/providerConfig'
import { getProviderName } from '../utils/providerI18n'
import { StatusIndicator, Switch } from './ui'
import type { MeetingContextOverride, ProviderConfigData } from '../types'
import type { ASRVendor } from '../types/asr'
import { MeetingContextEditor } from './MeetingContextEditor'
import { getDefaultSettings } from '../utils/storageShared'
import { supportsLiveSpeakerDiarizationQuickToggle } from '../utils/providerMetadata'

const TRANSLATION_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'vi', label: 'Tiếng Việt' },
]

interface RecordingControlsProps {
  onError: (message: string) => void
  startRecording: (meetingContextOverride?: MeetingContextOverride) => Promise<void>
  pauseRecording: () => Promise<void>
  resumeRecording: () => Promise<void>
  stopRecording: () => Promise<string | null>
  switchConfig?: (configPatch: Partial<ProviderConfigData>, description: string) => Promise<void>
  switchProvider?: (newVendorId: ASRVendor) => Promise<void>
}

export function RecordingControls({
  onError,
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  switchConfig,
  switchProvider,
}: RecordingControlsProps) {
  const { t } = useUIStore()
  const { settings, availableProviders } = useSettingsStore()
  const { recordingState, currentTranscript } = useSessionStore()
  const [showQuickSettings, setShowQuickSettings] = useState(false)
  const [meetingContextOverride, setMeetingContextOverride] = useState<MeetingContextOverride>({ mode: 'inherit' })

  const currentVendor = settings.currentVendor || 'soniox'
  const currentProvider = availableProviders.find(p => p.id === currentVendor)
  const currentConfig = settings.providerConfigs?.[currentVendor]
  const normalizedConfig = buildProviderConnectConfig(currentProvider, currentConfig, settings)
  const hasApiKey = isProviderConfigured(currentProvider, normalizedConfig)

  const isIdle = recordingState === 'idle'
  const isRecording = recordingState === 'recording'
  const isPaused = recordingState === 'paused'
  const isStarting = recordingState === 'starting'
  const isPausing = recordingState === 'pausing'
  const isResuming = recordingState === 'resuming'
  const isStopping = recordingState === 'stopping'
  const isSwitching = recordingState === 'switching'
  const isTransitioning = isStarting || isPausing || isResuming || isStopping || isSwitching

  const supportsTranslation = currentProvider?.capabilities.supportsTranslation ?? false
  const supportsDiarizationQuickToggle = supportsLiveSpeakerDiarizationQuickToggle(currentProvider)

  const configuredProviders = availableProviders.filter(p => {
    const cfg = settings.providerConfigs?.[p.id]
    return isProviderConfigured(p, buildProviderConnectConfig(p, cfg, settings))
  })
  const canSwitchProvider = configuredProviders.length > 1

  const hasLiveFeatures = supportsTranslation || supportsDiarizationQuickToggle || canSwitchProvider

  const translationEnabled = Boolean(currentConfig?.translationEnabled)
  const translationTarget = (currentConfig?.translationTargetLanguage as string) || 'en'
  const diarizationEnabled = Boolean(currentConfig?.enableSpeakerDiarization)

  useEffect(() => {
    if (!isRecording) {
      setShowQuickSettings(false)
    }
  }, [isRecording])

  const handleStart = () => {
    if (isIdle) {
      if (!hasApiKey) {
        onError(t.recording.configureApiFirst)
        return
      }
      void startRecording(meetingContextOverride)
      setMeetingContextOverride({ mode: 'inherit' })
    }
  }

  const progressLabel = isStarting
    ? t.recording.starting
    : isPausing
      ? t.recording.pausing
      : isResuming
        ? t.recording.resuming
        : isStopping
          ? t.recording.stopping
          : t.recording.switching

  const handleToggleTranslation = async () => {
    if (!switchConfig) return
    const newEnabled = !translationEnabled
    const desc = newEnabled
      ? (t.recording?.translationEnabled || 'Translation enabled')
      : (t.recording?.translationDisabled || 'Translation disabled')
    await switchConfig(
      { translationEnabled: newEnabled, translationTargetLanguage: translationTarget },
      desc,
    )
  }

  const handleChangeTranslationTarget = async (target: string) => {
    if (!switchConfig || !translationEnabled) return
    await switchConfig(
      { translationEnabled: true, translationTargetLanguage: target },
      `${t.recording?.translationTarget || 'Target'}: ${target}`,
    )
  }

  const handleToggleDiarization = async () => {
    if (!switchConfig) return
    const newEnabled = !diarizationEnabled
    const desc = newEnabled
      ? (t.recording?.diarizationEnabled || 'Speaker identification enabled')
      : (t.recording?.diarizationDisabled || 'Speaker identification disabled')
    await switchConfig({ enableSpeakerDiarization: newEnabled }, desc)
  }

  return (
    <div className="space-y-3">
      <div className={`flex ${isIdle ? 'flex-col items-center gap-3' : 'items-center gap-5'}`}>
        <div className="flex items-center gap-2">
          {isTransitioning ? (
            <button
              disabled
              aria-label={progressLabel}
              className="relative flex shrink-0 items-center gap-2.5 rounded-full bg-muted px-6 py-3 text-sm font-semibold tracking-wide text-muted-foreground shadow-md disabled:cursor-not-allowed disabled:opacity-80"
            >
              {isSwitching ? (
                <RefreshCw className="h-4.5 w-4.5 animate-spin" />
              ) : (
                <Loader2 className="h-4.5 w-4.5 animate-spin" />
              )}
              <span>{progressLabel}</span>
            </button>
          ) : isIdle ? (
            <button
              onClick={handleStart}
              aria-label={t.recording.startRecording}
              className="relative flex shrink-0 items-center gap-2.5 rounded-full bg-primary px-6 py-3 text-sm font-semibold tracking-wide text-primary-foreground shadow-md ring-2 ring-primary/20 transition-all duration-200 hover:bg-primary/90 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 animate-glow-pulse"
            >
              <Mic className="h-4.5 w-4.5" />
              <span>{t.recording.startRecording}</span>
            </button>
          ) : (
            <>
              <button
                onClick={() => void (isRecording ? pauseRecording() : resumeRecording())}
                aria-label={isRecording ? t.recording.pauseRecording : t.recording.resumeRecording}
                className="relative flex shrink-0 items-center gap-2.5 rounded-full bg-primary px-5 py-3 text-sm font-semibold tracking-wide text-primary-foreground shadow-md ring-2 ring-primary/20 transition-all duration-200 hover:bg-primary/90 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {isRecording ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
                <span>{isRecording ? t.recording.pauseRecording : t.recording.resumeRecording}</span>
              </button>
              <button
                onClick={() => void stopRecording()}
                aria-label={t.recording.stopRecording}
                className="relative flex shrink-0 items-center gap-2.5 rounded-full bg-destructive px-5 py-3 text-sm font-semibold tracking-wide text-destructive-foreground shadow-md ring-2 ring-destructive/20 transition-all duration-200 hover:bg-destructive/90 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 animate-glow-pulse-destructive"
              >
                <Square className="h-4 w-4 fill-current" />
                <span>{t.recording.stopRecording}</span>
              </button>
            </>
          )}

          {isRecording && hasLiveFeatures && (
            <button
              onClick={() => setShowQuickSettings(prev => !prev)}
              className={`
                p-2.5 rounded-full transition-all
                ${showQuickSettings
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/80'
                }
              `}
              aria-label={t.recording.quickSettings}
              aria-expanded={showQuickSettings}
            >
              <Settings2 className="h-4.5 w-4.5" />
            </button>
          )}
        </div>

        <div className={`text-sm ${isIdle ? 'text-center' : 'min-w-0 flex-1'}`}>
          {isTransitioning && (
            <p className="flex items-center gap-2 text-warning" role="status">
              <StatusIndicator status={recordingState} />
              <span className="font-medium">{isStarting ? t.recording.selectSource : progressLabel}</span>
            </p>
          )}
          {isPaused && (
            <p className="flex items-center gap-2 text-warning" role="status">
              <StatusIndicator status="paused" />
              <span className="font-medium">{t.recording.paused}</span>
            </p>
          )}
          {isRecording && (
            <div className="flex items-center gap-2 text-success">
              <StatusIndicator status="recording" />
              <span className="font-medium">{t.recording.capturingAudio}</span>
              {!currentTranscript && (
                <span className="text-xs text-muted-foreground">{t.recording.waitingForAudio}</span>
              )}
            </div>
          )}
          {isIdle && !hasApiKey && (
            <p className="text-warning">{t.recording.clickToConfigureApi}</p>
          )}
        </div>
      </div>

      {/* Config summary tags (idle state) */}
      {isIdle && hasApiKey && hasLiveFeatures && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>{currentProvider ? getProviderName(currentProvider, t) : currentVendor}</span>
          <span className="text-border">·</span>
          <span>{t.recording.translation}: {translationEnabled ? translationTarget.toUpperCase() : 'OFF'}</span>
          <span className="text-border">·</span>
          <span>{t.recording.speakerDiarization}: {diarizationEnabled ? 'ON' : 'OFF'}</span>
        </div>
      )}

      {isIdle && hasApiKey && (
        <details className="rounded-xl border border-border/70 bg-muted/20 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-foreground">
            {t.settings.oneShotContextTitle}
          </summary>
          <div className="pt-4">
            <MeetingContextEditor
              t={t}
              globalConfig={settings.meetingContext || getDefaultSettings().meetingContext!}
              value={meetingContextOverride}
              onChange={setMeetingContextOverride}
            />
          </div>
        </details>
      )}

      {/* Quick settings panel (recording state) */}
      {showQuickSettings && isRecording && hasLiveFeatures && (
        <div className="rounded-xl border border-border/70 bg-muted/20 p-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">
              {t.recording.quickSettings}
            </h4>
            <span className="text-xs text-muted-foreground">
              {currentProvider ? getProviderName(currentProvider, t) : currentVendor}
            </span>
          </div>

          {canSwitchProvider && switchProvider && (
            <div className="flex items-center gap-2">
              <label className="text-sm text-foreground shrink-0">
                Provider
              </label>
              <select
                value={currentVendor}
                onChange={(e) => void switchProvider(e.target.value as ASRVendor)}
                className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {configuredProviders.map(p => (
                  <option key={p.id} value={p.id}>{getProviderName(p, t)}</option>
                ))}
              </select>
            </div>
          )}

          {supportsTranslation && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm text-foreground">
                  {t.recording.translation}
                </label>
                <Switch
                  checked={translationEnabled}
                  onChange={() => void handleToggleTranslation()}
                  aria-label={t.recording.translation}
                />
              </div>
              {translationEnabled && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground shrink-0">
                    {t.recording.translationTarget}
                  </label>
                  <select
                    value={translationTarget}
                    onChange={(e) => void handleChangeTranslationTarget(e.target.value)}
                    className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {TRANSLATION_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {supportsDiarizationQuickToggle && (
            <div className="flex items-center justify-between">
              <label className="text-sm text-foreground">
                {t.recording.speakerDiarization}
              </label>
              <Switch
                checked={diarizationEnabled}
                onChange={() => void handleToggleDiarization()}
                aria-label={t.recording.speakerDiarization}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
