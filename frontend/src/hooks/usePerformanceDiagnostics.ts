import { useEffect } from 'react'
import { PERFORMANCE_DIAGNOSTIC_KEY, performanceDiagnosticsEnabled, recordPerformanceDiagnostic, subscribePerformanceDiagnostics, startPerformanceSpan, type PerformanceStage } from '../../../shared/performanceDiagnostics'

export function measureNextDiagnosticFrame(stage: PerformanceStage) {
  const span = startPerformanceSpan(stage)
  if (span.enabled) window.requestAnimationFrame(() => span.finish())
}

export function usePerformanceDiagnostics() {
  useEffect(() => {
    let stopCapture: (() => void) | undefined
    const capture = (enabled: boolean) => {
      stopCapture?.()
      stopCapture = undefined
      if (!enabled) return
      let observer: PerformanceObserver | undefined
      if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        observer = new PerformanceObserver((entries) => {
          for (const entry of entries.getEntries()) recordPerformanceDiagnostic('renderer.long-task', {}, entry.duration)
        })
        observer.observe({ entryTypes: ['longtask'] })
      }
      let expected = performance.now() + 1000
      const heartbeat = window.setInterval(() => {
        const now = performance.now(), delay = Math.max(0, now - expected)
        expected = now + 1000
        if (document.visibilityState !== 'visible') return
        if (delay > 50) recordPerformanceDiagnostic('renderer.heartbeat', { maxDelayMs: delay })
      }, 1000)
      stopCapture = () => { observer?.disconnect(); window.clearInterval(heartbeat) }
    }
    const update = (enabled: boolean) => {
      capture(enabled)
      void window.electronAPI?.setPerformanceDiagnostics?.(enabled).catch(() => {
        console.warn('[PerformanceDiagnostics] Main-process capture setting unavailable')
      })
    }
    capture(performanceDiagnosticsEnabled())
    try {
      const stored = localStorage.getItem(PERFORMANCE_DIAGNOSTIC_KEY)
      if (stored === '0' || stored === '1') update(stored === '1')
    } catch { /* capture remains an in-memory opt-in if preferences cannot be read */ }
    const unsubscribe = subscribePerformanceDiagnostics(update)
    return () => { stopCapture?.(); unsubscribe() }
  }, [])
}
