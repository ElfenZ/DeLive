export type RecordingState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'stopping'
  | 'switching'

export type RecordingShortcut = 'recording-toggle' | 'pause-toggle'
export type RecordingShortcutAction = 'start' | 'stop' | 'pause' | 'resume'

const RECORDING_TRANSITIONS: Record<RecordingState, readonly RecordingState[]> = {
  idle: ['starting'],
  starting: ['recording', 'idle', 'stopping'],
  recording: ['pausing', 'stopping', 'switching'],
  pausing: ['paused', 'recording', 'stopping'],
  paused: ['resuming', 'stopping'],
  resuming: ['recording', 'paused', 'stopping'],
  stopping: ['idle'],
  switching: ['recording', 'stopping', 'idle'],
}

export function canTransitionRecordingState(
  current: RecordingState,
  next: RecordingState,
): boolean {
  return RECORDING_TRANSITIONS[current].includes(next)
}

export function resolveRecordingShortcutAction(
  shortcut: RecordingShortcut,
  state: RecordingState,
): RecordingShortcutAction | null {
  if (shortcut === 'recording-toggle') {
    if (state === 'idle') return 'start'
    if (state === 'recording' || state === 'paused') return 'stop'
    return null
  }

  if (state === 'recording') return 'pause'
  if (state === 'paused') return 'resume'
  return null
}

export function isRecordingTransitionState(state: RecordingState): boolean {
  return state === 'starting'
    || state === 'pausing'
    || state === 'resuming'
    || state === 'stopping'
    || state === 'switching'
}
