import { describe, expect, it } from 'vitest'
import type { RecordingState } from '../../../shared/recordingState'
import {
  canTransitionRecordingState,
  resolveRecordingShortcutAction,
} from '../../../shared/recordingState'

const states: RecordingState[] = [
  'idle',
  'starting',
  'recording',
  'pausing',
  'paused',
  'resuming',
  'stopping',
  'switching',
]

describe('recording state', () => {
  it('maps recording and pause shortcuts without acting during transitions', () => {
    expect(states.map((state) => resolveRecordingShortcutAction('recording-toggle', state)))
      .toEqual(['start', null, 'stop', null, 'stop', null, null, null])
    expect(states.map((state) => resolveRecordingShortcutAction('pause-toggle', state)))
      .toEqual([null, null, 'pause', null, 'resume', null, null, null])
  })

  it('accepts only declared recording lifecycle transitions', () => {
    expect(canTransitionRecordingState('recording', 'pausing')).toBe(true)
    expect(canTransitionRecordingState('pausing', 'paused')).toBe(true)
    expect(canTransitionRecordingState('paused', 'resuming')).toBe(true)
    expect(canTransitionRecordingState('paused', 'idle')).toBe(false)
    expect(canTransitionRecordingState('stopping', 'recording')).toBe(false)
  })
})
