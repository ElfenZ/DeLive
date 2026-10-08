import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerformanceCounters, PerformanceStage } from '../../../shared/performanceDiagnostics'

describe('bounded opt-in performance diagnostics', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', { getItem: () => null })
    vi.stubEnv('DELIVE_PERFORMANCE_DIAGNOSTICS', '')
  })

  it('does no capture by default and supports explicit flag/enable changes', async () => {
    const diagnostics = await import('../../../shared/performanceDiagnostics')
    const span = diagnostics.startPerformanceSpan('repository.metadata', { records: 100 })
    span.finish('success')
    expect(span.enabled).toBe(false)
    expect(diagnostics.getPerformanceDiagnostics()).toEqual([])
    const changed = vi.fn()
    const stop = diagnostics.subscribePerformanceDiagnostics(changed)
    diagnostics.setPerformanceDiagnosticsEnabled(true)
    diagnostics.recordPerformanceDiagnostic('media.reconcile', { writes: 0, publications: 0 })
    expect(diagnostics.getPerformanceDiagnostics()).toHaveLength(1)
    diagnostics.setPerformanceDiagnosticsEnabled(false)
    diagnostics.recordPerformanceDiagnostic('media.reconcile', { writes: 5 })
    expect(diagnostics.getPerformanceDiagnostics()).toHaveLength(1)
    expect(changed.mock.calls.map(([enabled]) => enabled)).toEqual([true, false])
    stop()
  })

  it('whitelists stages and numeric counters, never recording payload, title, key or raw error objects', async () => {
    const diagnostics = await import('../../../shared/performanceDiagnostics')
    diagnostics.setPerformanceDiagnosticsEnabled(true)
    const payload = { records: 10, writes: 0, bytes: -1, tokens: Infinity, transcript: 'PRIVATE BODY', apiKey: 'SECRET', title: 'PRIVATE TITLE', error: 'PRIVATE PATH' }
    diagnostics.recordPerformanceDiagnostic('repository.metadata', payload as PerformanceCounters)
    diagnostics.recordPerformanceDiagnostic('PRIVATE BODY' as PerformanceStage, payload as PerformanceCounters)
    const result = diagnostics.getPerformanceDiagnostics()
    expect(result).toHaveLength(1)
    expect(result[0].counters).toEqual({ records: 10, writes: 0 })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|apiKey|transcript/)
  })

  it('caps its ring, completes spans once, and returns defensive counter copies', async () => {
    const diagnostics = await import('../../../shared/performanceDiagnostics')
    diagnostics.setPerformanceDiagnosticsEnabled(true)
    const span = diagnostics.startPerformanceSpan('files.sync', { events: 1 })
    span.finish('success', { writes: 0 })
    span.finish('error')
    expect(diagnostics.getPerformanceDiagnostics()).toHaveLength(2)
    for (let i = 0; i < 300; i++) diagnostics.recordPerformanceDiagnostic('renderer.heartbeat', { maxDelayMs: i })
    expect(diagnostics.getPerformanceDiagnostics()).toHaveLength(diagnostics.PERFORMANCE_DIAGNOSTIC_LIMIT)
    const result = diagnostics.getPerformanceDiagnostics()
    result[0].counters.maxDelayMs = 999999
    expect(diagnostics.getPerformanceDiagnostics()[0].counters.maxDelayMs).not.toBe(999999)
    diagnostics.clearPerformanceDiagnostics()
    expect(diagnostics.getPerformanceDiagnostics()).toEqual([])
  })
})
