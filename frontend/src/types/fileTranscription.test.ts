import { describe, expect, it } from 'vitest'
import { getMediaInputKind, isAcceptedAudioFile } from './fileTranscription'

function mediaFile(name: string, type: string, size = 1): File {
  return { name, type, size } as File
}

describe('file transcription media classification', () => {
  it('keeps ordinary audio on the direct provider path', () => {
    expect(getMediaInputKind(mediaFile('recording.mp3', 'audio/mpeg'))).toBe('audio')
    expect(getMediaInputKind(mediaFile('recording.m4a', ''))).toBe('audio')
  })

  it('classifies common and ambiguous video containers for local extraction', () => {
    expect(getMediaInputKind(mediaFile('meeting.mov', 'video/quicktime'))).toBe('video')
    expect(getMediaInputKind(mediaFile('meeting.mkv', ''))).toBe('video')
    expect(getMediaInputKind(mediaFile('meeting.webm', ''))).toBe('video')
  })

  it('rejects empty inputs and accepts known media formats', () => {
    expect(isAcceptedAudioFile(mediaFile('empty.mp4', 'video/mp4', 0))).toBe(false)
    expect(isAcceptedAudioFile(mediaFile('meeting.mp4', 'video/mp4'))).toBe(true)
    expect(isAcceptedAudioFile(mediaFile('audio.flac', 'audio/flac'))).toBe(true)
  })
})
