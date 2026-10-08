export const PERFORMANCE_DIAGNOSTIC_KEY = 'delive-performance-diagnostics'
export const PERFORMANCE_DIAGNOSTIC_LIMIT = 160

const stages = ['repository.metadata', 'repository.load', 'media.reconcile', 'files.sync', 'ui.navigation',
  'renderer.long-task', 'renderer.heartbeat', 'native.register-context', 'native.audio-catalog',
  'native.windows-operation', 'native.markdown-adopt', 'native.recovery', 'ui.title-editor', 'ui.topic-links', 'ui.legacy-adopt', 'ui.settings-scroll'] as const
export type PerformanceStage = typeof stages[number]
export type PerformanceStatus = 'started' | 'success' | 'error' | 'cancelled' | 'sample'
const counterKeys = ['records', 'tokens', 'segments', 'fields', 'writes', 'publications', 'events', 'bytes', 'roots',
  'domNodes', 'maxDelayMs', 'view', 'queueDelayMs'] as const
export type PerformanceCounters = Partial<Record<typeof counterKeys[number], number>>
export interface PerformanceDiagnostic {
  sequence: number
  spanId?: number
  stage: PerformanceStage
  status: PerformanceStatus
  timestamp: number
  elapsedMs?: number
  counters: PerformanceCounters
}

let override: boolean | undefined
let sequence = 0, nextSpan = 0
const records: PerformanceDiagnostic[] = []
const listeners = new Set<(enabled: boolean) => void>()

export function performanceDiagnosticsEnabled(): boolean {
  if (override !== undefined) return override
  try {
    if (typeof process !== 'undefined' && process.env.DELIVE_PERFORMANCE_DIAGNOSTICS === '1') return true
    return typeof localStorage !== 'undefined' && localStorage.getItem(PERFORMANCE_DIAGNOSTIC_KEY) === '1'
  } catch { return false }
}

export function setPerformanceDiagnosticsEnabled(enabled: boolean): void {
  override = enabled === true
  for (const listener of listeners) listener(override)
}

export function subscribePerformanceDiagnostics(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function append(stage: PerformanceStage, status: PerformanceStatus, counters: PerformanceCounters, elapsedMs?: number, spanId?: number): void {
  if (!(stages as readonly string[]).includes(stage) || !['started', 'success', 'error', 'cancelled', 'sample'].includes(status)) return
  const safe: PerformanceCounters = {}
  for (const key of counterKeys) {
    const value = counters[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) safe[key] = value
  }
  records.push({ sequence: ++sequence, spanId, stage, status, timestamp: Date.now(),
    ...(elapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? { elapsedMs: Math.round(elapsedMs * 10) / 10 } : {}), counters: safe })
  if (records.length > PERFORMANCE_DIAGNOSTIC_LIMIT) records.splice(0, records.length - PERFORMANCE_DIAGNOSTIC_LIMIT)
}

export function recordPerformanceDiagnostic(stage: PerformanceStage, counters: PerformanceCounters = {}, elapsedMs?: number): void {
  if (performanceDiagnosticsEnabled()) append(stage, 'sample', counters, elapsedMs)
}

export function startPerformanceSpan(stage: PerformanceStage, counters: PerformanceCounters = {}) {
  const enabled = performanceDiagnosticsEnabled()
  if (!enabled) return { enabled: false, finish: (_status: PerformanceStatus = 'success', _counters: PerformanceCounters = {}) => undefined }
  const began = performance.now(), id = ++nextSpan
  const initial = { ...counters }
  append(stage, 'started', initial, undefined, id)
  let finished = false
  return { enabled: true, finish: (status: PerformanceStatus = 'success', additional: PerformanceCounters = {}) => {
    if (finished) return
    finished = true
    // Complete an already-consented span even if capture is disabled while it is pending.
    append(stage, status, { ...initial, ...additional }, performance.now() - began, id)
  } }
}

export function getPerformanceDiagnostics(): PerformanceDiagnostic[] {
  return records.map((record) => ({ ...record, counters: { ...record.counters } }))
}

export function clearPerformanceDiagnostics(): void { records.length = 0 }
