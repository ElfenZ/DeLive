import { useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { PERFORMANCE_DIAGNOSTIC_KEY, clearPerformanceDiagnostics, getPerformanceDiagnostics, performanceDiagnosticsEnabled, setPerformanceDiagnosticsEnabled } from '../../../../shared/performanceDiagnostics'

export function PerformanceDiagnosticsPanel() {
  const t = useUIStore((state) => state.t)
  const [enabled, setEnabled] = useState(performanceDiagnosticsEnabled)
  const [message, setMessage] = useState('')
  const toggle = (value: boolean) => {
    try { localStorage.setItem(PERFORMANCE_DIAGNOSTIC_KEY, value ? '1' : '0') } catch { /* capture works in memory even when preferences are unavailable */ }
    setPerformanceDiagnosticsEnabled(value)
    setEnabled(value)
    setMessage('')
  }
  const copy = async () => {
    try {
      const native = await window.electronAPI?.getPerformanceDiagnostics?.()
      await navigator.clipboard.writeText(JSON.stringify({ version: 1, renderer: getPerformanceDiagnostics(), native: native?.records || [] }, null, 2))
      setMessage(t.performanceDiagnostics.copied)
    } catch { setMessage(t.performanceDiagnostics.copyFailed) }
  }
  const clear = async () => {
    clearPerformanceDiagnostics()
    try { await window.electronAPI?.clearPerformanceDiagnostics?.(); setMessage(t.performanceDiagnostics.cleared) }
    catch { setMessage(t.performanceDiagnostics.clearFailed) }
  }
  return <section className="workspace-panel-muted space-y-3 p-4">
    <label className="flex items-center justify-between gap-3 text-sm font-semibold">{t.performanceDiagnostics.title}
      <input type="checkbox" checked={enabled} onChange={(event) => toggle(event.target.checked)} />
    </label>
    <p className="text-xs text-muted-foreground">{t.performanceDiagnostics.hint}</p>
    <div className="flex flex-wrap gap-3"><button className="rounded border border-input px-3 py-1.5 text-xs hover:bg-accent" onClick={() => void copy()}>{t.performanceDiagnostics.copy}</button><button className="rounded border border-input px-3 py-1.5 text-xs hover:bg-accent" onClick={() => void clear()}>{t.performanceDiagnostics.clear}</button></div>
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </section>
}
