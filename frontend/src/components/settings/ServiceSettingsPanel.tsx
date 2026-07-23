import type { ReactNode } from 'react'
import {
  AlertCircle,
  Check,
  Cpu,
  Eye,
  EyeOff,
  Key,
  Loader2,
  PlayCircle,
} from 'lucide-react'
import { BundledRuntimeSetupGuide } from '../BundledRuntimeSetupGuide'
import { LocalModelSetupGuide } from '../LocalModelSetupGuide'
import { ProviderSelector } from '../ProviderSelector'
import { Switch } from '../ui'
import type { Translations } from '../../i18n'
import type { ASRProviderInfo, ProviderConfigData } from '../../types'
import type { ProviderConfigField } from '../../types/asr'
import { translateConfigField } from '../../utils/providerI18n'

interface ServiceSettingsPanelProps {
  t: Translations
  currentProvider?: ASRProviderInfo
  languageHints: string
  onLanguageHintsChange: (value: string) => void
  getProviderConsoleUrl: (provider: ASRProviderInfo | undefined) => string
  updateFormField: (fieldKey: string, value: string | boolean) => void
  getStringFieldValue: (fieldKey: string) => string
  getBooleanFieldValue: (fieldKey: string) => boolean
  revealedFields: Record<string, boolean>
  toggleFieldVisibility: (fieldKey: string) => void
  buildEditableProviderConfig: () => ProviderConfigData
  onRunConfigTest: () => Promise<void>
  testStatus: 'idle' | 'testing' | 'success' | 'error'
  testMessage: string
  onBundledRuntimePatch: (patch: Partial<ProviderConfigData>) => void
}

function getFieldIcon(field: ProviderConfigField): ReactNode {
  if (field.key.toLowerCase().includes('model')) {
    return <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
  }
  return <Key className="w-3.5 h-3.5 text-muted-foreground" />
}

function isMonospaceField(field: ProviderConfigField): boolean {
  const key = field.key.toLowerCase()
  return field.type === 'password' || key.includes('key') || key.includes('url') || key.includes('model')
}

export function ServiceSettingsPanel({
  t,
  currentProvider,
  languageHints,
  onLanguageHintsChange,
  getProviderConsoleUrl,
  updateFormField,
  getStringFieldValue,
  getBooleanFieldValue,
  revealedFields,
  toggleFieldVisibility,
  buildEditableProviderConfig,
  onRunConfigTest,
  testStatus,
  testMessage,
  onBundledRuntimePatch,
  }: ServiceSettingsPanelProps) {
  const conditionMatches = (condition: ProviderConfigField['visibleWhen']): boolean => {
    if (!condition) return true
    const value = condition.fieldKey === 'languageHints'
      ? languageHints
      : (typeof condition.equals === 'boolean'
          ? getBooleanFieldValue(condition.fieldKey)
          : getStringFieldValue(condition.fieldKey))
    if (condition.nonEmpty) {
      return Array.isArray(value) ? value.length > 0 : String(value).trim().length > 0
    }
    if (condition.equals !== undefined) {
      if (typeof condition.equals === 'boolean') return Boolean(value) === condition.equals
      return String(value) === String(condition.equals)
    }
    return true
  }

  const renderFieldWarning = (field: ProviderConfigField) => {
    if (!field.warning || !conditionMatches(field.warningWhen)) return null
    if (field.type === 'boolean' && !getBooleanFieldValue(field.key)) return null
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <span>{field.warning}</span>
      </div>
    )
  }

  const renderFieldDescription = (field: ProviderConfigField) => {
    const description = field.description?.trim()
    const docsUrl = getProviderConsoleUrl(currentProvider)
    const shouldShowDocsLink = docsUrl !== '#' && (field.key === 'apiKey' || field.key === 'appKey')

    if (!description && !shouldShowDocsLink) {
      return null
    }

    return (
      <p className="text-xs text-muted-foreground">
        {description}
        {description && shouldShowDocsLink ? ' ' : ''}
        {shouldShowDocsLink && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary font-medium hover:underline underline-offset-2"
          >
            {field.key === 'apiKey' ? t.servicePanel.viewDocs : t.servicePanel.openConsole}
          </a>
        )}
      </p>
    )
  }

  const renderProviderField = (field: ProviderConfigField) => {
    const disabled = !conditionMatches(field.enabledWhen)
    const commonInputClassName = `flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${isMonospaceField(field) ? 'font-mono' : ''}`

    if (field.type === 'boolean') {
      return (
        <div key={field.key} className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
            <div className="space-y-1">
              <label className="text-sm font-medium leading-none flex items-center gap-2">
                {getFieldIcon(field)}
                {field.label}
              </label>
              {field.description && (
                <p className="text-xs text-muted-foreground">{field.description}</p>
              )}
            </div>
            <Switch
              checked={getBooleanFieldValue(field.key)}
              onChange={(val) => updateFormField(field.key, val)}
              disabled={disabled}
              aria-label={field.label}
            />
          </div>
          {renderFieldWarning(field)}
        </div>
      )
    }

    if (field.type === 'select') {
      return (
        <div key={field.key} className="space-y-3">
          <label className="text-sm font-medium leading-none flex items-center gap-2">
            {getFieldIcon(field)}
            {field.label}
          </label>
          <select
            value={getStringFieldValue(field.key)}
            onChange={(e) => updateFormField(field.key, e.target.value)}
            disabled={disabled}
            className={commonInputClassName}
          >
            <option value="">{field.placeholder || field.label}</option>
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {renderFieldDescription(field)}
          {renderFieldWarning(field)}
        </div>
      )
    }

    const isPasswordField = field.type === 'password'
    const isRevealed = Boolean(revealedFields[field.key])
    const inputType = field.type === 'number'
      ? 'number'
      : isPasswordField && !isRevealed
      ? 'password'
      : 'text'
    const value = getStringFieldValue(field.key)
    const placeholder = field.placeholder || ''

    return (
      <div key={field.key} className="space-y-3">
        <label className="text-sm font-medium leading-none flex items-center gap-2">
          {getFieldIcon(field)}
          {field.label}
        </label>
        <div className="relative group">
          <input
            type={inputType}
            value={value}
            onChange={(e) => updateFormField(field.key, e.target.value)}
            placeholder={placeholder}
            min={field.type === 'number' ? field.min : undefined}
            max={field.type === 'number' ? field.max : undefined}
            step={field.type === 'number' ? field.step : undefined}
            disabled={disabled}
            className={`${commonInputClassName} ${isPasswordField ? 'pr-10' : ''}`}
          />
          {isPasswordField && (
            <button
              type="button"
              onClick={() => toggleFieldVisibility(field.key)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              {isRevealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          )}
        </div>
        {renderFieldDescription(field)}
        {renderFieldWarning(field)}
      </div>
    )
  }

  const renderTestButton = () => {
    if (!currentProvider?.capabilities.supportsConfigTest) {
      return null
    }

    return (
      <div className="space-y-3">
        <button
          onClick={() => void onRunConfigTest()}
          disabled={testStatus === 'testing'}
          className={`
            w-full inline-flex items-center justify-center gap-2 h-10 px-4 text-sm font-medium
            rounded-lg transition-all
            ${testStatus === 'testing'
              ? 'bg-muted text-muted-foreground cursor-not-allowed'
              : testStatus === 'success'
              ? 'bg-success/10 text-success dark:text-success border border-success/30'
              : testStatus === 'error'
              ? 'bg-destructive/10 text-destructive dark:text-destructive border border-destructive/30'
              : 'bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20'
            }
          `}
        >
          {testStatus === 'testing' ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t.settings?.testing || '正在测试...'}
            </>
          ) : testStatus === 'success' ? (
            <>
              <Check className="w-4 h-4" />
              {t.settings?.testSuccess || '配置有效'}
            </>
          ) : testStatus === 'error' ? (
            <>
              <AlertCircle className="w-4 h-4" />
              {t.settings?.testFailed || '配置无效'}
            </>
          ) : (
            <>
              <PlayCircle className="w-4 h-4" />
              {t.settings?.testConfig || '测试配置'}
            </>
          )}
        </button>

        {testMessage && (
          <div className={`
            flex items-center gap-2 p-3 rounded-lg text-xs
            ${testStatus === 'success'
              ? 'bg-success/10 text-success dark:bg-success/10 dark:text-success'
              : 'bg-destructive/10 text-destructive dark:bg-destructive/10 dark:text-destructive'
            }
          `}>
            {testStatus === 'success' ? (
              <Check className="w-4 h-4 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            )}
            <span className="break-all">{testMessage}</span>
          </div>
        )}
      </div>
    )
  }

  const localCapabilities = currentProvider?.capabilities.local
  const shouldShowLocalSetupGuide = Boolean(
    currentProvider &&
    currentProvider.type === 'local' &&
    localCapabilities?.connectionMode === 'service' &&
    localCapabilities.supportsServiceDiscovery
  )
  const shouldShowBundledRuntimeGuide = Boolean(
    currentProvider &&
    currentProvider.type === 'local' &&
    localCapabilities?.connectionMode === 'runtime' &&
    localCapabilities.runtimeId
  )
  const guideManagedFieldKeys = shouldShowBundledRuntimeGuide
    ? new Set(['binaryPath', 'modelPath'])
    : new Set<string>()
  const providerId = currentProvider?.id || ''
  const providerFields = (currentProvider?.configFields || [])
    .filter(field => field.key !== 'languageHints' && !guideManagedFieldKeys.has(field.key))
    .map(field => translateConfigField(providerId, field, t))
    .filter(field => conditionMatches(field.visibleWhen))
  const ungroupedProviderFields = providerFields.filter(field => !field.group)
  const groupedProviderFields = Array.from(
    providerFields.reduce((groups, field) => {
      if (!field.group) return groups
      const group = groups.get(field.group) || []
      group.push(field)
      groups.set(field.group, group)
      return groups
    }, new Map<string, ProviderConfigField[]>()),
  )

  const hasRightColumn = shouldShowLocalSetupGuide || shouldShowBundledRuntimeGuide

  return (
    <div className={`grid gap-6 ${hasRightColumn ? 'xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]' : ''}`}>
      <div className="space-y-6">
        <section className="workspace-panel-muted p-4">
          <div className="space-y-3">
            <label className="text-sm font-medium leading-none flex items-center gap-2">
              <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
              {t.settings?.asrProvider || '语音识别服务'}
            </label>
            <ProviderSelector />
            <p className="text-xs text-muted-foreground">
              {t.settings?.asrProviderDesc || '选择语音识别服务提供商，不同提供商有不同的特性和价格'}
            </p>
          </div>
        </section>

        {ungroupedProviderFields.length > 0 && (
          <section className="workspace-panel-muted p-4">
            <div className="grid gap-4 md:grid-cols-2">
              {ungroupedProviderFields.map(renderProviderField)}
            </div>
          </section>
        )}

        {groupedProviderFields.map(([groupId, fields]) => {
          const first = fields[0]
          const content = <div className="grid gap-4 pt-4 md:grid-cols-2">{fields.map(renderProviderField)}</div>
          if (first.groupCollapsible !== false) {
            return (
              <details
                key={groupId}
                open={first.groupDefaultOpen}
                className="workspace-panel-muted p-4"
              >
                <summary className="cursor-pointer text-sm font-semibold text-foreground">
                  {first.groupLabel || groupId}
                </summary>
                {content}
              </details>
            )
          }
          return (
            <section key={groupId} className="workspace-panel-muted p-4">
              <h3 className="text-sm font-semibold text-foreground">{first.groupLabel || groupId}</h3>
              {content}
            </section>
          )
        })}

        {renderTestButton() && (
          <section className="workspace-panel-muted p-4">
            {renderTestButton()}
          </section>
        )}

        {!hasRightColumn && (
          <section className="workspace-panel-muted p-4">
            <div className="space-y-3">
              <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                {t.settings.languageHints}
              </label>
              <input
                type="text"
                value={languageHints}
                onChange={(e) => onLanguageHintsChange(e.target.value)}
                placeholder={t.settings.languageHintsPlaceholder}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="text-xs text-muted-foreground">
                {t.settings.languageHintsDesc}
              </p>
            </div>
          </section>
        )}
      </div>

      {hasRightColumn && (
        <div className="space-y-6">
          {shouldShowLocalSetupGuide && currentProvider && (
            <section className="workspace-panel-muted p-4">
              <LocalModelSetupGuide
                provider={currentProvider}
                config={buildEditableProviderConfig()}
                onModelChange={(value) => updateFormField('model', value)}
              />
            </section>
          )}

          {shouldShowBundledRuntimeGuide && currentProvider && (
            <section className="workspace-panel-muted p-4">
              <BundledRuntimeSetupGuide
                provider={currentProvider}
                config={buildEditableProviderConfig()}
                onRunConfigTest={onRunConfigTest}
                testStatus={testStatus}
                testMessage={testMessage}
                onConfigPatch={onBundledRuntimePatch}
              />
            </section>
          )}

          <section className="workspace-panel-muted p-4">
            <div className="space-y-3">
              <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                {t.settings.languageHints}
              </label>
              <input
                type="text"
                value={languageHints}
                onChange={(e) => onLanguageHintsChange(e.target.value)}
                placeholder={t.settings.languageHintsPlaceholder}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="text-xs text-muted-foreground">
                {t.settings.languageHintsDesc}
              </p>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
