export interface RuntimeDiagnosticEvent {
  timestamp: string
  scope: 'capture' | 'provider-session' | 'recording'
  event: string
  details?: Record<string, unknown>
}

const MAX_RUNTIME_DIAGNOSTIC_EVENTS = 240
const runtimeDiagnosticEvents: RuntimeDiagnosticEvent[] = []

export function recordRuntimeDiagnostic(
  scope: RuntimeDiagnosticEvent['scope'],
  event: string,
  details?: Record<string, unknown>,
): void {
  runtimeDiagnosticEvents.push({
    timestamp: new Date().toISOString(),
    scope,
    event,
    ...(details ? { details } : {}),
  })

  if (runtimeDiagnosticEvents.length > MAX_RUNTIME_DIAGNOSTIC_EVENTS) {
    runtimeDiagnosticEvents.splice(0, runtimeDiagnosticEvents.length - MAX_RUNTIME_DIAGNOSTIC_EVENTS)
  }
}

export function getRuntimeDiagnostics(): RuntimeDiagnosticEvent[] {
  return runtimeDiagnosticEvents.map(entry => ({
    ...entry,
    ...(entry.details ? { details: { ...entry.details } } : {}),
  }))
}
