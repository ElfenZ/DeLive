export interface RecordingTimeline {
  accumulatedMs: number
  activeSegmentStartedAtMs: number | null
}

export function createRecordingTimeline(): RecordingTimeline {
  return {
    accumulatedMs: 0,
    activeSegmentStartedAtMs: null,
  }
}

export function startRecordingTimeline(nowMs: number): RecordingTimeline {
  return {
    accumulatedMs: 0,
    activeSegmentStartedAtMs: nowMs,
  }
}

export function pauseRecordingTimeline(
  timeline: RecordingTimeline,
  nowMs: number,
): RecordingTimeline {
  if (timeline.activeSegmentStartedAtMs === null) return timeline

  return {
    accumulatedMs: timeline.accumulatedMs
      + Math.max(0, nowMs - timeline.activeSegmentStartedAtMs),
    activeSegmentStartedAtMs: null,
  }
}

export function resumeRecordingTimeline(
  timeline: RecordingTimeline,
  nowMs: number,
): RecordingTimeline {
  if (timeline.activeSegmentStartedAtMs !== null) return timeline
  return {
    ...timeline,
    activeSegmentStartedAtMs: nowMs,
  }
}

export function readRecordingElapsedMs(
  timeline: RecordingTimeline,
  nowMs: number,
): number {
  if (timeline.activeSegmentStartedAtMs === null) return timeline.accumulatedMs
  return timeline.accumulatedMs + Math.max(0, nowMs - timeline.activeSegmentStartedAtMs)
}

export function finalizeRecordingTimeline(
  timeline: RecordingTimeline,
  nowMs: number,
): RecordingTimeline {
  return {
    accumulatedMs: readRecordingElapsedMs(timeline, nowMs),
    activeSegmentStartedAtMs: null,
  }
}
