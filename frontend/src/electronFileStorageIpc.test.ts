import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const electron = vi.hoisted(() => ({ userData: '', showOpenDialog: vi.fn(), showMessageBox: vi.fn(), openPath: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  dialog: { showOpenDialog: electron.showOpenDialog, showMessageBox: electron.showMessageBox },
  shell: { openPath: electron.openPath },
}))

describe('narrow local directory IPC', () => {
  let root: string
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'delive-directory-ipc-'))
    electron.userData = path.join(root, 'userdata')
    electron.openPath.mockResolvedValue('')
    electron.showMessageBox.mockResolvedValue({ response: 0 })
  })
  afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }) })

  async function handlers() {
    const { registerFileStorageIpc } = await import('../../electron/fileStorageIpc')
    const { registerTrustedWindow } = await import('../../electron/ipcSecurity')
    const sender = { id: 5, isDestroyed: () => false, send: vi.fn() }
    const mainWindow = { webContents: sender, isDestroyed: () => false }
    const widget = { id: 6, isDestroyed: () => false }
    registerTrustedWindow(() => mainWindow as never)
    registerTrustedWindow(() => ({ webContents: widget, isDestroyed: () => false }) as never)
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerFileStorageIpc({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, getMainWindow: () => mainWindow as never })
    return { map, sender, mainWindow, widget }
  }

  it('rejects trusted non-main windows and malformed roles before opening any dialog', async () => {
    const { map, widget, sender } = await handlers()
    await expect(map.get('choose-transcript-directory')!({ sender: widget }, { kind: 'default-transcript' })).rejects.toThrow(/main window/)
    await expect(map.get('choose-transcript-directory')!({ sender }, { kind: 'project-transcript', projectId: '../outside' })).resolves.toMatchObject({ ok: false, code: 'FILE_STORAGE_INVALID' })
    expect(electron.showOpenDialog).not.toHaveBeenCalled()
  })

  it('returns null on native cancellation without creating a configuration or grant', async () => {
    const { map, sender } = await handlers()
    electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(map.get('choose-transcript-directory')!({ sender }, { kind: 'default-transcript' })).resolves.toBeNull()
    expect(fs.existsSync(electron.userData)).toBe(false)
  })

  it('changes future audio roots only from native selection, with cancellation, confirmation and main-window checks', async () => {
    const { map, sender, widget } = await handlers()
    const { getFileStorageService } = await import('../../electron/fileStorage')
    const service = getFileStorageService()
    const before = await service.getConfiguration()
    const statePath = path.join(electron.userData, 'local-file-storage', 'state.json')
    const originalState = await fs.promises.readFile(statePath, 'utf8')
    await expect(map.get('choose-media-directory')!({ sender: widget })).rejects.toThrow(/main window/)
    electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await map.get('choose-media-directory')!({ sender })).toBeNull()
    expect(await fs.promises.readFile(statePath, 'utf8')).toBe(originalState)
    const selected = path.join(root, 'native-audio')
    const injected = path.join(root, 'injected-audio')
    await fs.promises.mkdir(selected)
    await fs.promises.mkdir(injected)
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })
    expect(await map.get('choose-media-directory')!({ sender }, injected)).toBeNull()
    expect(await service.getConfiguration()).toEqual(before)
    expect(fs.existsSync(path.join(selected, 'DeLive-media'))).toBe(false)
    electron.showMessageBox.mockResolvedValue({ response: 1 })
    const changed = await map.get('choose-media-directory')!({ sender }, injected) as { ok: boolean; status: { configuration: { mediaRoot: string } } }
    expect(changed.ok).toBe(true)
    expect(changed.status.configuration.mediaRoot).toBe(path.join(selected, 'DeLive-media'))
    expect((await fs.promises.readFile(statePath, 'utf8'))).not.toContain(injected.replace(/\\/g, '\\\\'))
    const token = service.acquireUsage('busy-record', 'recording')
    electron.showOpenDialog.mockClear()
    expect(await map.get('choose-media-directory')!({ sender })).toMatchObject({ ok: false, code: 'FILE_STORAGE_BUSY' })
    expect(electron.showOpenDialog).not.toHaveBeenCalled()
    service.releaseUsage(token)
  })

  it('restricts recovery decisions and diagnostic access to the main window and verifies recovery evidence', async () => {
    const { map, sender, widget } = await handlers()
    const { getFileStorageService } = await import('../../electron/fileStorage')
    const service = getFileStorageService()
    const directory = await service.sessionDirectory('known-moved', true)
    await fs.promises.writeFile(path.join(directory, 'source-audio.pcm.tmp'), 'retained')
    await expect(map.get('list-recording-recovery-notices')!({ sender: widget }, [])).rejects.toThrow(/main window/)
    await expect(map.get('get-performance-diagnostics')!({ sender: widget })).rejects.toThrow(/main window/)
    const list = await map.get('list-recording-recovery-notices')!({ sender }, []) as { ok: boolean; items: import('../../shared/fileStorage').RecordingRecoveryNotice[] }
    expect(list.ok).toBe(true)
    const item = list.items[0]
    expect(await map.get('acknowledge-recording-recovery')!({ sender }, { key: item.key, evidence: '0'.repeat(64), activeSessionIds: [] })).toMatchObject({ ok: false, code: 'FILE_STORAGE_CONFLICT' })
    expect(await map.get('acknowledge-recording-recovery')!({ sender }, { key: item.key, evidence: item.evidence, activeSessionIds: [] })).toEqual({ ok: true })
    expect(await fs.promises.readFile(path.join(directory, 'source-audio.pcm.tmp'), 'utf8')).toBe('retained')
    expect(await map.get('set-performance-diagnostics')!({ sender }, true)).toEqual({ ok: true })
    expect(await map.get('get-performance-diagnostics')!({ sender })).toHaveProperty('records')
    expect(await map.get('clear-performance-diagnostics')!({ sender })).toEqual({ ok: true })
    expect(await map.get('set-performance-diagnostics')!({ sender }, false)).toEqual({ ok: true })
  })

  it('grants only the native picker path, ignoring renderer paths, and opens only role-resolved directories', async () => {
    const { map, sender, mainWindow } = await handlers()
    const selected = path.join(root, 'native-selected')
    const injected = path.join(root, 'renderer-injected')
    await fs.promises.mkdir(selected)
    await fs.promises.mkdir(injected)
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })
    const result = await map.get('choose-transcript-directory')!({ sender }, { kind: 'default-transcript', path: injected }) as { ok: boolean; status: { configuration: { defaultTranscriptDirectory: string } } }
    expect(result).toMatchObject({ ok: true })
    expect(result.status.configuration.defaultTranscriptDirectory).toBe(selected)
    expect(electron.showOpenDialog).toHaveBeenCalledWith(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    await map.get('open-storage-directory')!({ sender }, { kind: 'default-transcript', path: injected })
    expect(electron.openPath).toHaveBeenCalledWith(selected)
    const stored = await fs.promises.readFile(path.join(electron.userData, 'local-file-storage', 'state.json'), 'utf8')
    expect(stored).not.toContain(injected.replace(/\\/g, '\\\\'))
  })

  it('requires native confirmation to switch roots and a separate confirmation to clean old copies', async () => {
    const { map, sender } = await handlers()
    const sourceDirectory = path.join(electron.userData, 'media', 'record1')
    await fs.promises.mkdir(sourceDirectory, { recursive: true })
    await fs.promises.writeFile(path.join(sourceDirectory, 'source-audio.wav'), 'audio')
    const selected = path.join(root, 'target')
    await fs.promises.mkdir(selected)
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })
    const chosen = await map.get('choose-media-migration')!({ sender }) as { preview: { token: string; targetRoot: string } }
    const refused = await map.get('apply-media-migration')!({ sender }, { confirmed: true, targetRoot: chosen.preview.targetRoot }) as { ok: boolean }
    expect(refused.ok).toBe(false)
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    const cancelled = await map.get('apply-media-migration')!({ sender }, chosen.preview.token)
    expect(cancelled).toBeNull()
    expect(fs.existsSync(path.join(sourceDirectory, 'source-audio.wav'))).toBe(true)
    electron.showMessageBox.mockResolvedValue({ response: 1 })
    const applied = await map.get('apply-media-migration')!({ sender }, chosen.preview.token) as { ok: boolean; migrationId: string; status: { configuration: { mediaRoot: string } } }
    expect(applied.ok).toBe(true)
    expect(applied.status.configuration.mediaRoot).toBe(chosen.preview.targetRoot)
    expect(fs.existsSync(path.join(sourceDirectory, 'source-audio.wav'))).toBe(true)
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    await expect(map.get('cleanup-media-migration')!({ sender }, applied.migrationId)).resolves.toBeNull()
    expect(fs.existsSync(path.join(sourceDirectory, 'source-audio.wav'))).toBe(true)
    electron.showMessageBox.mockResolvedValue({ response: 1 })
    await expect(map.get('cleanup-media-migration')!({ sender }, applied.migrationId)).resolves.toMatchObject({ ok: true, skipped: [] })
    expect(fs.existsSync(path.join(sourceDirectory, 'source-audio.wav'))).toBe(false)
    expect(sender.send).toHaveBeenCalledWith('file-storage-changed', expect.objectContaining({ configurationRevision: 1 }))
  }, 30000)

  it('rechecks main-window identity after a native confirmation resolves', async () => {
    const { map, sender, mainWindow } = await handlers()
    const selected = path.join(root, 'target')
    await fs.promises.mkdir(selected)
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })
    const chosen = await map.get('choose-media-migration')!({ sender }) as { preview: { token: string } }
    electron.showMessageBox.mockImplementation(async () => { mainWindow.isDestroyed = () => true; return { response: 1 } })
    await expect(map.get('apply-media-migration')!({ sender }, chosen.preview.token)).resolves.toMatchObject({ ok: false })
    const stored = JSON.parse(await fs.promises.readFile(path.join(electron.userData, 'local-file-storage', 'state.json'), 'utf8'))
    expect(stored.configuration.mediaRoot).toBe(path.join(electron.userData, 'media'))
  })
})
