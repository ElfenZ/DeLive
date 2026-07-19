import { describe, expect, it } from 'vitest'
import {
  createRecordingTimeline,
  finalizeRecordingTimeline,
  pauseRecordingTimeline,
  readRecordingElapsedMs,
  resumeRecordingTimeline,
  startRecordingTimeline,
} from './recordingTimeline'

describe('recordingTimeline', () => {
  it('excludes a long pause from elapsed time', () => {
    let timeline = startRecordingTimeline(1_000)
    timeline = pauseRecordingTimeline(timeline, 4_000)

    expect(readRecordingElapsedMs(timeline, 14_000)).toBe(3_000)

    timeline = resumeRecordingTimeline(timeline, 14_000)
    expect(readRecordingElapsedMs(timeline, 16_500)).toBe(5_500)
  })

  it('accumulates multiple active segments and finalizes idempotently', () => {
    let timeline = createRecordingTimeline()
    timeline = resumeRecordingTimeline(timeline, 100)
    timeline = pauseRecordingTimeline(timeline, 1_100)
    timeline = resumeRecordingTimeline(timeline, 5_000)
    timeline = finalizeRecordingTimeline(timeline, 7_500)

    expect(timeline).toEqual({
      accumulatedMs: 3_500,
      activeSegmentStartedAtMs: null,
    })
    expect(finalizeRecordingTimeline(timeline, 20_000)).toEqual(timeline)
  })
})
