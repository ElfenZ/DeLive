import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const electronMock = await vi.hoisted(async () => {
  const os = await import('os')
  const path = await import('path')
  const userDataPath = path.join(os.tmpdir(), 'kilo', `delive-ipc-test-${process.pid}`)
  return { userDataPath, showItemInFolder: vi.fn(), getPath: vi.fn(() => userDataPath) }
})

vi.mock('electron', () => ({
  app: {
    getPath: electronMock.getPath,
    getVersion: vi.fn(() => '0.0.0-test'),
    getLoginItemSettings: vi.fn(() => ({})),
    setLoginItemSettings: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: {
    showItemInFolder: electronMock.showItemInFolder,
  },
}))

describe('recording archive IPC', () => {
  async function setupHandlers() {
    const { registerTrustedWindow } = await import('../../electron/ipcSecurity')
    const { registerAppIpc } = await import('../../electron/appIpc')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      },
    }
    const sender = { id: 1, isDestroyed: () => false }
    registerTrustedWindow(() => ({
      isDestroyed: () => false,
      webContents: sender,
    } as never))

    registerAppIpc({
      ipcMain: ipcMain as never,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }) as never,
      isTrayReady: () => false,
      hideMainWindow: vi.fn(),
      minimizeMainWindow: vi.fn(),
      maximizeMainWindow: vi.fn(),
      unmaximizeMainWindow: vi.fn(),
      closeMainWindow: vi.fn(),
      isMainWindowMaximized: () => false,
    })

    return { handlers, sender }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await fs.promises.rm(electronMock.userDataPath, { recursive: true, force: true })
  })

  it('saves recording archives under the app media directory and reveals saved files', async () => {
    const { handlers, sender } = await setupHandlers()

    const data = new Uint8Array([1, 2, 3]).buffer
    const saveResult = await handlers.get('save-recording-archive')?.(
      { sender },
      {
        sessionId: 'recording-session-1',
        fileName: 'source-audio.wav',
        mimeType: 'audio/wav',
        data,
      },
    ) as { ok: boolean; path: string; size: number; mimeType: string; fileName: string }

    expect(saveResult).toEqual(expect.objectContaining({
      ok: true,
      size: 3,
      mimeType: 'audio/wav',
      fileName: 'source-audio.wav',
    }))
    expect(saveResult.path).toContain(path.join('media', 'recording-session-1', 'source-audio.wav'))
    expect(fs.existsSync(saveResult.path)).toBe(true)

    const revealResult = await handlers.get('reveal-recording-archive')?.({ sender }, saveResult.path) as { ok: boolean }
    expect(revealResult).toEqual({ ok: true })
    expect(electronMock.showItemInFolder).toHaveBeenCalledWith(saveResult.path)
  })

  it('returns no recovery notices or skips for independent recordings and empty directories after manual moves', async () => {
    const { handlers, sender } = await setupHandlers()
    const { getFileStorageService } = await import('../../electron/fileStorage')
    const service = getFileStorageService()
    const saved: string[] = []
    for (const sessionId of ['independent-record', 'moved-record']) {
      const result = await handlers.get('save-recording-archive')!({ sender }, {
        sessionId, fileName: 'source-audio.wav', mimeType: 'audio/wav', data: new Uint8Array([1, 2, 3]).buffer,
      }) as { ok: boolean; path: string }
      expect(result.ok).toBe(true)
      saved.push(result.path)
    }
    const movedPath = path.join(electronMock.userDataPath, 'moved-record.wav')
    await fs.promises.rename(saved[1], movedPath)
    const empty = await service.sessionDirectory('empty-record', true)
    const statePath = path.join(service.userData, 'local-file-storage', 'state.json')
    const before = await fs.promises.readFile(statePath, 'utf8')
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await handlers.get('recover-recording-archives')!({ sender }, []) as import('../../shared/electronApi').RecordingArchiveRecoverResult
      expect(result).toMatchObject({ ok: true, recovered: [], skipped: [], ignoredCount: 0, notices: [] })
    }
    expect(await fs.promises.readFile(statePath, 'utf8')).toBe(before)
    expect(await fs.promises.readFile(saved[0])).toEqual(Buffer.from([1, 2, 3]))
    expect(await fs.promises.readFile(movedPath)).toEqual(Buffer.from([1, 2, 3]))
    expect(await fs.promises.readdir(path.dirname(saved[1]))).toEqual([])
    expect(await fs.promises.readdir(empty)).toEqual([])
  })

  it('does not retry or warn for an acknowledged manually moved group, retains files and reports new groups', async () => {
    const { handlers, sender } = await setupHandlers()
    const { getFileStorageService } = await import('../../electron/fileStorage')
    const service = getFileStorageService()
    const directory = await service.sessionDirectory('moved-group', true)
    const metadata = path.join(directory, 'source-audio.json.tmp')
    await fs.promises.writeFile(metadata, '{"sessionId":"moved-group"}')
    const first = await handlers.get('recover-recording-archives')!({ sender }, []) as import('../../shared/electronApi').RecordingArchiveRecoverResult
    expect(first.skipped).toHaveLength(1)
    expect(first.notices).toHaveLength(1)
    const item = first.notices![0]
    await service.acknowledgeRecordingRecovery({ key: item.key, evidence: item.evidence, activeSessionIds: [] })
    const repeated = await handlers.get('recover-recording-archives')!({ sender }, []) as import('../../shared/electronApi').RecordingArchiveRecoverResult
    expect(repeated.skipped).toEqual([])
    expect(repeated.recovered).toEqual([])
    expect(repeated.ignoredCount).toBe(1)
    expect(repeated.notices?.filter((notice) => !notice.acknowledged)).toEqual([])
    expect(await fs.promises.readdir(directory)).toEqual(['source-audio.json.tmp'])
    expect(await fs.promises.readFile(metadata, 'utf8')).toBe('{"sessionId":"moved-group"}')
    const other = await service.sessionDirectory('new-group', true)
    await fs.promises.writeFile(path.join(other, 'source-audio.json.tmp'), '{"sessionId":"new-group"}')
    const fresh = await handlers.get('recover-recording-archives')!({ sender }, []) as import('../../shared/electronApi').RecordingArchiveRecoverResult
    expect(fresh.notices?.filter((notice) => !notice.acknowledged).map((notice) => notice.sessionId)).toEqual(['new-group'])
  })

  it('streams PCM chunks to a temp archive and finalizes a WAV atomically', async () => {
    const { handlers, sender } = await setupHandlers()

    const beginResult = await handlers.get('begin-recording-archive')?.(
      { sender },
      { sessionId: 'session-1', sampleRate: 16000, channels: 1, bitsPerSample: 16 },
    ) as { ok: boolean; path: string; size: number }

    expect(beginResult).toEqual(expect.objectContaining({ ok: true, size: 0 }))
    expect(beginResult.path).toContain(path.join('media', 'session-1', 'source-audio.pcm.tmp'))

    const firstChunk = new Int16Array([0, 1000]).buffer
    const secondChunk = new Int16Array([-1000]).buffer
    const appendOne = await handlers.get('append-recording-archive')?.({ sender }, { sessionId: 'session-1', data: firstChunk }) as { ok: boolean; size: number }
    const appendTwo = await handlers.get('append-recording-archive')?.({ sender }, { sessionId: 'session-1', data: secondChunk }) as { ok: boolean; size: number }

    expect(appendOne).toEqual(expect.objectContaining({ ok: true, size: 4 }))
    expect(appendTwo).toEqual(expect.objectContaining({ ok: true, size: 6 }))
    const metadataPath = path.join(electronMock.userDataPath, 'media', 'session-1', 'source-audio.json.tmp')
    expect(JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'))).toEqual(expect.objectContaining({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    }))

    const finalizeResult = await handlers.get('finalize-recording-archive')?.(
      { sender },
      { sessionId: 'session-1', fileName: 'source-audio.wav' },
    ) as { ok: boolean; sessionId: string; path: string; size: number; mimeType: string; fileName: string }

    expect(finalizeResult).toEqual(expect.objectContaining({
      ok: true,
      sessionId: 'session-1',
      size: 50,
      mimeType: 'audio/wav',
      fileName: 'source-audio.wav',
    }))
    const wav = await fs.promises.readFile(finalizeResult.path)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt32LE(40)).toBe(6)
    expect(fs.existsSync(path.join(path.dirname(finalizeResult.path), 'source-audio.pcm.tmp'))).toBe(false)
    expect(fs.existsSync(`${finalizeResult.path}.tmp`)).toBe(false)
  })

  it('rejects invalid identifiers rather than sanitizing them into another record directory', async () => {
    const { handlers, sender } = await setupHandlers()
    const result = await handlers.get('save-recording-archive')!({ sender }, { sessionId: '../outside', fileName: 'source-audio.wav', mimeType: 'audio/wav', data: new Uint8Array([1]).buffer }) as { ok: boolean }
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(electronMock.userDataPath, 'outside'))).toBe(false)
  })

  it('skips active recordings during recovery and retains non-empty PCM when aborting', async () => {
    const { handlers, sender } = await setupHandlers()
    const sessionId = 'active-recovery-session'
    await handlers.get('begin-recording-archive')!({ sender }, { sessionId, sampleRate: 16000, channels: 1, bitsPerSample: 16 })
    await handlers.get('append-recording-archive')!({ sender }, { sessionId, data: new Int16Array([3]).buffer })
    const result = await handlers.get('recover-recording-archives')!({ sender }) as { recovered: unknown[]; skipped: unknown[] }
    expect(result.recovered).toEqual([])
    expect(result.skipped).toEqual([{ sessionId, reason: 'active-recording' }])
    const aborted = await handlers.get('abort-recording-archive')!({ sender }, { sessionId }) as { ok: boolean }
    expect(aborted.ok).toBe(false)
    expect((await fs.promises.stat(path.join(electronMock.userDataPath, 'media', sessionId, 'source-audio.pcm.tmp'))).size).toBe(2)
  })

  it('does not truncate an active archive when begin is repeated for the same session', async () => {
    const { handlers, sender } = await setupHandlers()
    const request = { sessionId: 'same-session', sampleRate: 16000, channels: 1, bitsPerSample: 16 }

    await handlers.get('begin-recording-archive')?.({ sender }, request)
    await handlers.get('append-recording-archive')?.(
      { sender },
      { sessionId: 'same-session', data: new Int16Array([1, 2]).buffer },
    )
    const repeatedBegin = await handlers.get('begin-recording-archive')?.(
      { sender },
      request,
    ) as { ok: boolean; size: number }

    expect(repeatedBegin).toEqual(expect.objectContaining({ ok: true, size: 4 }))
    const result = await handlers.get('finalize-recording-archive')?.(
      { sender },
      { sessionId: 'same-session', fileName: 'source-audio.wav' },
    ) as { ok: boolean; path: string }
    const wav = await fs.promises.readFile(result.path)
    expect(wav.readUInt32LE(40)).toBe(4)
  })

  it('aborts an unused archive and allows a clean begin for the same session', async () => {
    const { handlers, sender } = await setupHandlers()
    const request = { sessionId: 'aborted-session', sampleRate: 16000, channels: 1, bitsPerSample: 16 }
    await handlers.get('begin-recording-archive')?.({ sender }, request)
    const aborted = await handlers.get('abort-recording-archive')?.(
      { sender },
      { sessionId: request.sessionId },
    ) as { ok: boolean }
    expect(aborted).toEqual({ ok: true })
    expect(fs.existsSync(path.join(electronMock.userDataPath, 'media', request.sessionId, 'source-audio.pcm.tmp'))).toBe(false)
    const lateAppend = await handlers.get('append-recording-archive')?.(
      { sender },
      { sessionId: request.sessionId, data: new Int16Array([9]).buffer },
    ) as { ok: boolean }
    expect(lateAppend.ok).toBe(false)
    expect(fs.existsSync(path.join(electronMock.userDataPath, 'media', request.sessionId, 'source-audio.pcm.tmp'))).toBe(false)

    const restarted = await handlers.get('begin-recording-archive')?.(
      { sender },
      request,
    ) as { ok: boolean; size: number }
    expect(restarted).toEqual(expect.objectContaining({ ok: true, size: 0 }))
  })

  it('recovers unfinished PCM archives on launch', async () => {
    const { handlers, sender } = await setupHandlers()

    await handlers.get('begin-recording-archive')?.(
      { sender },
      { sessionId: 'recover-session', sampleRate: 16000, channels: 1, bitsPerSample: 16 },
    )
    await handlers.get('append-recording-archive')?.(
      { sender },
      { sessionId: 'recover-session', data: new Int16Array([42]).buffer },
    )

    vi.resetModules()
    const { handlers: restartedHandlers } = await setupHandlers()
    const recoverResult = await restartedHandlers.get('recover-recording-archives')?.({ sender }) as {
      ok: boolean
      recovered: Array<{ ok: boolean; sessionId: string; path: string; size: number }>
    }

    expect(recoverResult.ok).toBe(true)
    expect(recoverResult.recovered).toHaveLength(1)
    expect(recoverResult.recovered[0]).toEqual(expect.objectContaining({
      ok: true,
      sessionId: 'recover-session',
      size: 46,
    }))
    expect(fs.existsSync(recoverResult.recovered[0].path)).toBe(true)
  })

  it('reports empty recovery archives without producing a WAV', async () => {
    const { handlers, sender } = await setupHandlers()

    await handlers.get('begin-recording-archive')?.(
      { sender },
      { sessionId: 'empty-session', sampleRate: 16000, channels: 1, bitsPerSample: 16 },
    )

    vi.resetModules()
    const { handlers: restartedHandlers } = await setupHandlers()
    const recoverResult = await restartedHandlers.get('recover-recording-archives')?.({ sender }) as {
      ok: boolean
      recovered: Array<{ ok: boolean; sessionId: string; path: string; size: number }>
      skipped: Array<{ sessionId: string; reason: string; error?: string }>
    }

    expect(recoverResult.ok).toBe(true)
    expect(recoverResult.recovered).toHaveLength(0)
    expect(recoverResult.skipped).toEqual([
      expect.objectContaining({ sessionId: 'empty-session', reason: 'empty-audio' }),
    ])
    expect(fs.existsSync(path.join(electronMock.userDataPath, 'media', 'empty-session', 'source-audio.wav'))).toBe(false)
  })

  it('preserves PCM archives with missing metadata instead of guessing their format', async () => {
    const { handlers, sender } = await setupHandlers()

    await handlers.get('begin-recording-archive')?.(
      { sender },
      { sessionId: 'missing-meta-session', sampleRate: 16000, channels: 1, bitsPerSample: 16 },
    )
    await handlers.get('append-recording-archive')?.(
      { sender },
      { sessionId: 'missing-meta-session', data: new Int16Array([7]).buffer },
    )
    await fs.promises.rm(path.join(electronMock.userDataPath, 'media', 'missing-meta-session', 'source-audio.json.tmp'), { force: true })

    vi.resetModules()
    const { handlers: restartedHandlers } = await setupHandlers()
    const recoverResult = await restartedHandlers.get('recover-recording-archives')?.({ sender }) as {
      ok: boolean
      recovered: Array<{ ok: boolean; sessionId: string; path: string; size: number }>
      skipped: Array<{ sessionId: string; reason: string }>
    }

    expect(recoverResult.ok).toBe(true)
    expect(recoverResult.recovered).toHaveLength(0)
    expect(recoverResult.skipped).toEqual([{ sessionId: 'missing-meta-session', reason: 'missing-metadata' }])
    expect(fs.existsSync(path.join(electronMock.userDataPath, 'media', 'missing-meta-session', 'source-audio.pcm.tmp'))).toBe(true)
  })

  it('preserves PCM and invalid metadata instead of manufacturing a recovered WAV', async () => {
    const { handlers, sender } = await setupHandlers()

    await handlers.get('begin-recording-archive')?.(
      { sender },
      { sessionId: 'empty-meta-session', sampleRate: 16000, channels: 1, bitsPerSample: 16 },
    )
    await handlers.get('append-recording-archive')?.(
      { sender },
      { sessionId: 'empty-meta-session', data: new Int16Array([7]).buffer },
    )
    await fs.promises.writeFile(path.join(electronMock.userDataPath, 'media', 'empty-meta-session', 'source-audio.json.tmp'), '')

    vi.resetModules()
    const { handlers: restartedHandlers } = await setupHandlers()
    const recoverResult = await restartedHandlers.get('recover-recording-archives')?.({ sender }) as {
      ok: boolean
      recovered: Array<{ ok: boolean; sessionId: string; path: string; size: number }>
      skipped: Array<{ sessionId: string; reason: string }>
    }

    expect(recoverResult.ok).toBe(true)
    expect(recoverResult.recovered).toHaveLength(0)
    expect(recoverResult.skipped).toEqual([expect.objectContaining({ sessionId: 'empty-meta-session', reason: 'invalid-metadata' })])
    expect(fs.existsSync(path.join(electronMock.userDataPath, 'media', 'empty-meta-session', 'source-audio.pcm.tmp'))).toBe(true)
  })
})
