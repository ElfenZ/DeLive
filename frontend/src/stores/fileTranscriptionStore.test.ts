import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileTranscriptionConfig } from '../types/fileTranscription'
import { ASRVendor } from '../types/asr/common'

function createMemoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  } satisfies Storage
}

afterEach(() => {
  vi.resetModules()
  Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('fileTranscriptionStore persistence', () => {
  it('persists frozen audio/video metadata without credentials and requires live availability verification', async () => {
    const storage = createMemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    const { useFileTranscriptionStore } = await import('./fileTranscriptionStore')
    const config: FileTranscriptionConfig = {
      provider: ASRVendor.Soniox,
      meetingContext: {
        schemaVersion: 1,
        background: '',
        correctionGuidance: '',
        useForAiCorrection: true,
        useForSoniox: false,
        glossary: [],
      },
      recognitionConfig: { schemaVersion: 1, providerId: 'soniox' },
    }

    const videoJobId = useFileTranscriptionStore.getState().addJob({
      fileName: 'meeting.mp4',
      fileSize: 100,
      mimeType: 'video/mp4',
      provider: ASRVendor.Soniox,
      inputKind: 'video',
      sessionId: 'video-session-123',
      config,
    })
    useFileTranscriptionStore.getState().updateJob(videoJobId, {
      status: 'extracting',
      audioPath: 'C:/managed/source-audio.mp3',
      audioSize: 2048,
    })
    useFileTranscriptionStore.getState().addJob({
      fileName: 'audio.mp3',
      fileSize: 10,
      mimeType: 'audio/mpeg',
      provider: ASRVendor.Soniox,
      inputKind: 'audio',
      sessionId: 'audio-session-123',
      projectIds: ['project1'],
    })

    const persisted = storage.getItem('delive-file-transcription-tasks') || ''
    const persistedJobs = (JSON.parse(persisted) as { state: { jobs: Array<{ fileName: string }> } }).state.jobs
    expect(persisted).toContain('meeting.mp4')
    expect(persistedJobs.map(job => job.fileName)).toEqual(['audio.mp3', 'meeting.mp4'])
    expect(persisted).not.toMatch(/apiKey|apiToken|accessKey/i)

    vi.resetModules()
    const reloaded = await import('./fileTranscriptionStore')
    expect(reloaded.useFileTranscriptionStore.getState().jobs).toEqual([
      expect.objectContaining({ fileName: 'audio.mp3', sessionId: 'audio-session-123', projectIds: ['project1'], requiresSourceSelection: true }),
      expect.objectContaining({
        id: videoJobId,
        status: 'error',
        audioAvailable: false,
        sessionId: 'video-session-123',
      }),
    ])
  })
})
