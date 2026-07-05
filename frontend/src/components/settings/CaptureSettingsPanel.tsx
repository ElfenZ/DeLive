import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Mic, RefreshCw, Shield } from 'lucide-react'
import { Button, Switch } from '../ui'
import type { Translations } from '../../i18n'
import type { CaptureSettings } from '../../types'

interface CaptureSettingsPanelProps {
  t: Translations
  captureSettings: CaptureSettings
  updateCaptureSettings: (settings: CaptureSettings) => void
}

interface AudioInputDeviceOption {
  deviceId: string
  label: string
  hasHiddenLabel: boolean
}

function normalizeCaptureSettings(captureSettings: CaptureSettings): Required<CaptureSettings> {
  return {
    includeMicrophone: captureSettings.includeMicrophone !== false,
    microphoneDeviceId: captureSettings.microphoneDeviceId || '',
  }
}

export function CaptureSettingsPanel({
  t,
  captureSettings,
  updateCaptureSettings,
}: CaptureSettingsPanelProps) {
  const normalizedSettings = normalizeCaptureSettings(captureSettings)
  const [devices, setDevices] = useState<AudioInputDeviceOption[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [panelError, setPanelError] = useState('')

  const loadDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDevices([])
      setPanelError('')
      return
    }

    setIsRefreshing(true)
    setPanelError('')

    try {
      const audioInputs = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
          hasHiddenLabel: device.label === '',
        }))

      setDevices(audioInputs)
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : 'Failed to enumerate microphones')
      setDevices([])
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  const requestMicrophonePermission = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return
    }

    setIsRefreshing(true)
    setPanelError('')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      stream.getTracks().forEach((track) => track.stop())
      await loadDevices()
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : 'Failed to authorize microphone')
      setIsRefreshing(false)
    }
  }, [loadDevices])

  const hasUnnamedDevices = useMemo(
    () => devices.some((device) => device.hasHiddenLabel),
    [devices],
  )

  const handleToggleMicrophone = useCallback((enabled: boolean) => {
    updateCaptureSettings({
      ...normalizedSettings,
      includeMicrophone: enabled,
    })
  }, [normalizedSettings, updateCaptureSettings])

  const handleSelectDevice = useCallback((deviceId: string) => {
    updateCaptureSettings({
      ...normalizedSettings,
      microphoneDeviceId: deviceId,
    })
  }, [normalizedSettings, updateCaptureSettings])

  return (
    <div className="space-y-4">
      <section className="workspace-panel-muted p-4 space-y-3">
        <div className="space-y-1">
          <label className="text-sm font-medium leading-none flex items-center gap-2">
            <Mic className="w-3.5 h-3.5 text-muted-foreground" />
            {t.settings.captureTitle}
          </label>
          <p className="text-xs text-muted-foreground">{t.settings.captureDesc}</p>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t.settings.includeMicrophone}</p>
            <p className="text-xs text-muted-foreground">{t.settings.includeMicrophoneDesc}</p>
          </div>
          <Switch
            checked={normalizedSettings.includeMicrophone}
            onChange={handleToggleMicrophone}
            aria-label={t.settings.includeMicrophone}
          />
        </div>
      </section>

      <section className="workspace-panel-muted p-4 space-y-3">
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            {t.settings.microphoneDevice}
          </label>
          <select
            value={normalizedSettings.microphoneDeviceId}
            onChange={(event) => handleSelectDevice(event.target.value)}
            disabled={!normalizedSettings.includeMicrophone}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">{t.settings.defaultMicrophone}</option>
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void loadDevices()} disabled={isRefreshing}>
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t.settings.refreshMicrophones}
          </Button>

          {hasUnnamedDevices && (
            <Button variant="secondary" onClick={() => void requestMicrophonePermission()} disabled={isRefreshing}>
              <Shield className="w-4 h-4" />
              {t.settings.authorizeMicrophone}
            </Button>
          )}
        </div>

        {hasUnnamedDevices && (
          <p className="text-xs text-muted-foreground">{t.settings.microphonePermissionDesc}</p>
        )}

        <p className="text-xs text-muted-foreground">{t.settings.captureSettingsNextRecording}</p>

        {panelError && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-warning">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs leading-5">{panelError}</p>
          </div>
        )}
      </section>
    </div>
  )
}
