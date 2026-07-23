import { Eraser, RotateCcw } from 'lucide-react'
import type { Translations } from '../i18n'
import type { MeetingContextConfig, MeetingContextOverride } from '../types'
import { Switch } from './ui'

interface MeetingContextEditorProps {
  t: Translations
  globalConfig: MeetingContextConfig
  value: MeetingContextOverride
  onChange: (value: MeetingContextOverride) => void
}

export function MeetingContextEditor({
  t,
  globalConfig,
  value,
  onChange,
}: MeetingContextEditorProps) {
  const effective = value.mode === 'override'
    ? { ...globalConfig, ...(value.config || {}) }
    : globalConfig

  const setOverride = (patch: Partial<MeetingContextConfig>) => {
    onChange({
      mode: 'override',
      config: { ...effective, ...patch },
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onChange({ mode: 'inherit' })}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium ${
            value.mode === 'inherit'
              ? 'bg-primary/10 text-primary ring-1 ring-primary/30'
              : 'border border-input bg-background hover:bg-accent'
          }`}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t.settings.contextModeInherit}
        </button>
        <button
          type="button"
          onClick={() => onChange({ mode: 'override', config: { ...effective } })}
          className={`h-8 rounded-md px-3 text-xs font-medium ${
            value.mode === 'override'
              ? 'bg-primary/10 text-primary ring-1 ring-primary/30'
              : 'border border-input bg-background hover:bg-accent'
          }`}
        >
          {t.settings.contextModeOverride}
        </button>
        <button
          type="button"
          onClick={() => onChange({ mode: 'clear' })}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium ${
            value.mode === 'clear'
              ? 'bg-destructive/10 text-destructive ring-1 ring-destructive/30'
              : 'border border-input bg-background hover:bg-accent'
          }`}
        >
          <Eraser className="h-3.5 w-3.5" />
          {t.settings.contextModeClear}
        </button>
      </div>

      {value.mode === 'inherit' && (
        <p className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t.settings.contextModeInheritDesc}
        </p>
      )}
      {value.mode === 'clear' && (
        <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
          {t.settings.contextModeClearDesc}
        </p>
      )}

      {value.mode === 'override' && (
        <div className="space-y-3">
          <textarea
            value={effective.background}
            onChange={(event) => setOverride({ background: event.target.value })}
            placeholder={t.settings.meetingBackgroundPlaceholder}
            rows={4}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <textarea
            value={effective.correctionGuidance}
            onChange={(event) => setOverride({ correctionGuidance: event.target.value })}
            placeholder={t.settings.correctionGuidancePlaceholder}
            rows={2}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-xs">
              <span>{t.settings.contextUseForAi}</span>
              <Switch
                checked={effective.useForAiCorrection}
                onChange={(checked) => setOverride({ useForAiCorrection: checked })}
                aria-label={t.settings.contextUseForAi}
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-xs">
              <span>{t.settings.contextUseForSoniox}</span>
              <Switch
                checked={effective.useForSoniox}
                onChange={(checked) => setOverride({ useForSoniox: checked })}
                aria-label={t.settings.contextUseForSoniox}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
