import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const electronMock = await vi.hoisted(async () => {
  const os = await import('os')
  const path = await import('path')
  const userDataPath = path.join(os.tmpdir(), 'kilo', `delive-media-ipc-test-${process.pid}`)
  return { userDataPath, showItemInFolder: vi.fn(), getPath: vi.fn(() => userDataPath) }
})

vi.mock('electron', () => ({
  app: {
    getPath: electronMock.getPath,
    getAppPath: vi.fn(() => path.resolve(process.cwd(), '..')),
  },
  shell: {
    showItemInFolder: electronMock.showItemInFolder,
  },
}))

describe('managed media IPC', () => {
  async function setupHandlers() {
    const { registerTrustedWindow } = await import('../../electron/ipcSecurity')
    const { registerMediaIpc } = await import('../../electron/mediaIpc')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    }
    const sender = { id: 44, isDestroyed: () => false, send: vi.fn() }
    const mainWindow = { isDestroyed: () => false, webContents: sender }
    registerTrustedWindow(() => mainWindow as never)
    const controller = registerMediaIpc({ ipcMain: ipcMain as never, getMainWindow: () => mainWindow as never })
    await controller.ready
    return { handlers, sender }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await fs.promises.rm(electronMock.userDataPath, { recursive: true, force: true })
  })

  it('reads, reveals, and explicitly deletes only the fixed session audio archive', async () => {
    const { handlers, sender } = await setupHandlers()
    const sessionId = 'video-session-123'
    const archivePath = path.join(electronMock.userDataPath, 'media', sessionId, 'source-audio.mp3')
    await fs.promises.mkdir(path.dirname(archivePath), { recursive: true })
    await fs.promises.writeFile(archivePath, Buffer.from([0x49, 0x44, 0x33, 1]))

    const getResult = await handlers.get('get-media-audio')?.({ sender }, sessionId) as { ok: boolean; audio: { path: string; size: number } }
    expect(getResult).toEqual(expect.objectContaining({ ok: true }))
    expect(getResult.audio).toEqual(expect.objectContaining({ path: archivePath, size: 4 }))

    const readResult = await handlers.get('read-media-audio')?.({ sender }, sessionId) as { ok: boolean; data: ArrayBuffer }
    expect([...new Uint8Array(readResult.data)]).toEqual([0x49, 0x44, 0x33, 1])

    const listResult = await handlers.get('list-media-audio')?.({ sender }) as { ok: boolean; audios: Array<{ sessionId: string }> }
    expect(listResult).toEqual(expect.objectContaining({ ok: true }))
    expect(listResult.audios).toEqual([expect.objectContaining({ sessionId })])

    const revealResult = await handlers.get('reveal-media-audio')?.({ sender }, sessionId) as { ok: boolean }
    expect(revealResult.ok).toBe(true)
    expect(electronMock.showItemInFolder).toHaveBeenCalledWith(archivePath)

    const deleteResult = await handlers.get('delete-media-audio')?.({ sender }, sessionId) as { ok: boolean }
    expect(deleteResult.ok).toBe(true)
    expect(fs.existsSync(archivePath)).toBe(false)
  }, 30000)

  it('rejects path-shaped session ids before touching the filesystem', async () => {
    const { handlers, sender } = await setupHandlers()
    const result = await handlers.get('get-media-audio')?.({ sender }, '../outside') as { ok: boolean; code: string; error: string }
    expect(result).toEqual({
      ok: false,
      code: 'MEDIA_SOURCE_INVALID',
      error: 'Invalid media session id',
    })
  })

  it('lists and reads completed recording WAV and only deletes registered audio, not recovery or unknown files', async () => {
    const { handlers, sender } = await setupHandlers()
    const sessionId = 'recording-audio-123'
    const directory = path.join(electronMock.userDataPath, 'media', sessionId)
    await fs.promises.mkdir(directory, { recursive: true })
    await fs.promises.writeFile(path.join(directory, 'source-audio.wav'), 'wav-bytes')
    await fs.promises.writeFile(path.join(directory, 'source-audio.pcm.tmp'), 'pcm-recovery')
    await fs.promises.writeFile(path.join(directory, 'source-audio.json.tmp'), 'metadata-recovery')
    await fs.promises.writeFile(path.join(directory, 'user-file.txt'), 'user-owned')
    const listed = await handlers.get('list-media-audio')!({ sender }) as { audios: Array<{ sessionId: string; assetKind: string }> }
    expect(listed.audios).toEqual([expect.objectContaining({ sessionId, assetKind: 'recording-audio' })])
    const read = await handlers.get('read-media-audio')!({ sender }, sessionId) as { ok: boolean; data: ArrayBuffer }
    expect(read.ok).toBe(true)
    expect(Buffer.from(read.data).toString()).toBe('wav-bytes')
    const removed = await handlers.get('delete-media-audio')!({ sender }, sessionId) as { ok: boolean }
    expect(removed.ok).toBe(true)
    expect((await fs.promises.readdir(directory)).sort()).toEqual(['source-audio.json.tmp', 'source-audio.pcm.tmp', 'user-file.txt'])
    const after = await handlers.get('get-media-audio')!({ sender }, sessionId) as { code: string }
    expect(after.code).toBe('MEDIA_AUDIO_MISSING')
  }, 30000)

  it('cancels a queued extraction before FFmpeg starts', async () => {
    const { handlers, sender } = await setupHandlers()
    const inputPath = path.join(electronMock.userDataPath, 'queued-video.mp4')
    await fs.promises.mkdir(electronMock.userDataPath, { recursive: true })
    await fs.promises.writeFile(inputPath, Buffer.from('not-decoded-because-cancelled'))

    const extraction = handlers.get('extract-media-audio')?.(
      { sender },
      { taskId: 'queued-task-123', sessionId: 'queued-session-456', sourcePath: inputPath },
    ) as Promise<{ ok: boolean; code: string }>
    const cancelled = await handlers.get('cancel-media-extraction')?.({ sender }, 'queued-task-123')

    expect(cancelled).toBe(true)
    await expect(extraction).resolves.toEqual(expect.objectContaining({
      ok: false,
      code: 'MEDIA_EXTRACTION_CANCELLED',
    }))
  })

  const stagedFfmpegPath = path.resolve(
    process.cwd(),
    '..',
    'local-runtimes',
    'ffmpeg',
    process.platform === 'win32' ? 'win-x64' : process.platform === 'darwin' ? `mac-${process.arch}` : `linux-${process.arch}`,
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  )

  it.runIf(fs.existsSync(stagedFfmpegPath))('extracts a non-empty mono MP3 from a local video without copying the video', async () => {
    const { handlers, sender } = await setupHandlers()
    const inputPath = path.join(electronMock.userDataPath, 'sample-video.mp4')
    await fs.promises.mkdir(electronMock.userDataPath, { recursive: true })
    const generated = spawnSync(stagedFfmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', '-y', inputPath,
    ])
    expect(generated.status, generated.stderr.toString()).toBe(0)

    const result = await handlers.get('extract-media-audio')?.(
      { sender },
      { taskId: 'video-task-123', sessionId: 'video-session-456', sourcePath: inputPath },
    ) as { ok: boolean; audio: { path: string; mimeType: string; size: number } }

    expect(result).toEqual(expect.objectContaining({ ok: true }))
    expect(result.audio).toEqual(expect.objectContaining({ mimeType: 'audio/mpeg' }))
    expect(result.audio.size).toBeGreaterThan(0)
    expect(fs.existsSync(result.audio.path)).toBe(true)
    expect(fs.existsSync(inputPath)).toBe(true)
  })

  it.runIf(fs.existsSync(stagedFfmpegPath))('reports a video with no audio track without creating an archive', async () => {
    const { handlers, sender } = await setupHandlers()
    const inputPath = path.join(electronMock.userDataPath, 'silent-video.mp4')
    await fs.promises.mkdir(electronMock.userDataPath, { recursive: true })
    const generated = spawnSync(stagedFfmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10',
      '-t', '0.5', '-c:v', 'mpeg4', '-an', '-y', inputPath,
    ])
    expect(generated.status, generated.stderr.toString()).toBe(0)

    const result = await handlers.get('extract-media-audio')?.(
      { sender },
      { taskId: 'silent-task-123', sessionId: 'silent-session-456', sourcePath: inputPath },
    ) as { ok: boolean; code: string; error: string }

    expect(result).toEqual({
      ok: false,
      code: 'MEDIA_NO_AUDIO',
      error: 'The selected video does not contain a decodable audio track.',
    })
    expect(fs.existsSync(path.join(electronMock.userDataPath, 'media', 'silent-session-456', 'source-audio.mp3'))).toBe(false)
  })
})
