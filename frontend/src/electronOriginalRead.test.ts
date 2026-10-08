import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

const environment = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => environment.userData }, dialog: {} }))

describe('registered original AUDIO reads on actual temporary files', () => {
  let root: string
  beforeEach(async () => {
    vi.resetModules()
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'delive-original-read-'))
    environment.userData = path.join(root, 'profile')
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }) })

  async function setup(extension = '.wav') {
    const files = (await import('../../electron/fileStorage')).getFileStorageService()
    await files.getConfiguration()
    const service = new (await import('../../electron/originalSources')).OriginalSourceService(environment.userData)
    const input = path.join(root, `input${extension}`)
    await fs.promises.writeFile(input, 'ORIGINAL AUDIO')
    service.rememberSelection(input, 42)
    const source = await service.register(input, 'task', 42)
    const lease = await service.acquireRead(source.id, 'task', 42)
    return { files, service, input, source, lease }
  }

  it('reads only an owner-bound lease, preserves bytes, and blocks rename until release', async () => {
    const { service, source, lease, input } = await setup()
    await expect(service.readAudio(input, 42)).rejects.toThrow(/lease/)
    await expect(service.readAudio(lease.token, 43)).rejects.toThrow(/lease/)
    expect(() => service.releaseRead(lease.token, 43)).toThrow(/another window/)
    const result = await service.readAudio(lease.token, 42)
    expect(result.data.toString()).toBe('ORIGINAL AUDIO')
    expect(result.fileName).toBe('input.wav')
    const context = { sessionId: 'task', title: 'Title', titleRevision: 0, createdAt: 1 }
    await expect(service.preview(source.id, context, 42)).rejects.toThrow(/read|upload/)
    service.releaseRead(lease.token, 42)
    await expect(service.readAudio(lease.token, 42)).rejects.toThrow(/lease/)
    expect(await fs.promises.readFile(input, 'utf8')).toBe('ORIGINAL AUDIO')
  })

  it('rejects original VIDEO even with a valid native pick and read lease', async () => {
    const { service, lease } = await setup('.mp4')
    await expect(service.readAudio(lease.token, 42)).rejects.toThrow(/audio extension/)
    service.releaseRead(lease.token, 42)
  })

  it('requires a fresh native-pick grant after restart, not a restored source pointer', async () => {
    const { service, source, lease, input } = await setup()
    service.releaseRead(lease.token, 42)
    const restarted = new (await import('../../electron/originalSources')).OriginalSourceService(environment.userData)
    const restoredLease = await restarted.acquireRead(source.id, 'task', 42)
    await expect(restarted.readAudio(restoredLease.token, 42)).rejects.toThrow(/native file input/)
    restarted.releaseRead(restoredLease.token, 42)
    restarted.rememberSelection(input, 42)
    await restarted.register(input, 'task', 42)
    const selectedLease = await restarted.acquireRead(source.id, 'task', 42)
    expect((await restarted.readAudio(selectedLease.token, 42)).data.toString()).toBe('ORIGINAL AUDIO')
    restarted.releaseRead(selectedLease.token, 42)
  })

  it('rejects same-content replacement and changed content rather than trusting cached paths', async () => {
    const { service, input, lease } = await setup()
    await fs.promises.rename(input, `${input}.old`)
    await fs.promises.writeFile(input, 'ORIGINAL AUDIO')
    await expect(service.readAudio(lease.token, 42)).rejects.toThrow(/replaced/)
    service.releaseRead(lease.token, 42)
  })

  it('rejects reads and new leases after deletion without recreating a record or asset', async () => {
    const { service, files, source, lease, input } = await setup()
    await files.recordDeletion('task', 'commit')
    await expect(service.readAudio(lease.token, 42)).rejects.toThrow(/deleted/)
    await expect(service.acquireRead(source.id, 'task', 42)).rejects.toThrow(/deleted/)
    service.releaseRead(lease.token, 42)
    expect(await fs.promises.readFile(input, 'utf8')).toBe('ORIGINAL AUDIO')
    expect((await files.listAssets()).audios).toEqual([])
  })

  it('checks the actual held AUDIO handle and rejects content changes during its read', async () => {
    const { service, lease, input } = await setup()
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args)
      if (args[0] === input) {
        const readFile = handle.readFile.bind(handle)
        vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs: Parameters<typeof handle.readFile>) => {
          const bytes = await readFile(...readArgs)
          await fs.promises.writeFile(input, 'CHANGED! AUDIO')
          return bytes
        })
      }
      return handle
    })
    await expect(service.readAudio(lease.token, 42)).rejects.toThrow(/changed/)
    service.releaseRead(lease.token, 42)
  })

  it('READ IPC rejects trusted widgets and raw paths, and accepts only the main window lease', async () => {
    const { service, lease, input } = await setup()
    vi.spyOn(await import('../../electron/originalSources'), 'getOriginalSourceService').mockReturnValue(service)
    const security = await import('../../electron/ipcSecurity')
    const main = { isDestroyed: () => false, webContents: { id: 42 } } as unknown as BrowserWindow
    const widget = { isDestroyed: () => false, webContents: { id: 43 } } as unknown as BrowserWindow
    security.registerTrustedWindow(() => main)
    security.registerTrustedWindow(() => widget)
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
    const { registerOriginalSourceIpc } = await import('../../electron/originalSourceIpc')
    registerOriginalSourceIpc({ ipcMain: { on: vi.fn(), handle: (name: string, callback: Parameters<IpcMain['handle']>[1]) => handlers.set(name, callback) } as unknown as IpcMain,
      getMainWindow: () => main })
    const event = (id: number) => ({ sender: { id, isDestroyed: () => false } }) as IpcMainInvokeEvent
    await expect(handlers.get('list-original-sources')!(event(43))).rejects.toThrow(/main window/)
    const catalog = await handlers.get('list-original-sources')!(event(42))
    expect(catalog).toMatchObject({ ok: true, sources: [{ fileName: 'input.wav', revision: 1 }] })
    expect(catalog.sources[0]).not.toHaveProperty('path')
    expect(catalog.sources[0]).not.toHaveProperty('sessions')
    await expect(handlers.get('read-original-audio')!(event(43), lease.token)).rejects.toThrow(/main window/)
    expect(await handlers.get('read-original-audio')!(event(42), input)).toMatchObject({ ok: false })
    const result = await handlers.get('read-original-audio')!(event(42), lease.token)
    expect(result.ok).toBe(true)
    expect(result.data.toString()).toBe('ORIGINAL AUDIO')
    expect(result).not.toHaveProperty('path')
    await handlers.get('release-original-read')!(event(42), lease.token)
    expect(await handlers.get('read-original-audio')!(event(42), lease.token)).toMatchObject({ ok: false })
  })
})
