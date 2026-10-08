import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ElectronAPI } from '../../shared/electronApi'

const native = vi.hoisted(() => ({ save: vi.fn(), userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => native.userData }, dialog: { showSaveDialog: native.save } }))

describe('explicit native manual export', () => {
  let root: string
  let invoke: (event: IpcMainInvokeEvent, request: Parameters<ElectronAPI['manualExportFile']>[0]) => ReturnType<ElectronAPI['manualExportFile']>
  let files: Awaited<ReturnType<typeof import('../../electron/fileStorage')['getFileStorageService']>>
  const main = { isDestroyed: () => false, webContents: { id: 11 } } as BrowserWindow
  const event = (id = 11) => ({ sender: { id, isDestroyed: () => false } }) as IpcMainInvokeEvent
  const request = { filename: 'transcript.txt', content: 'temporary transcript', defaultSaveProjectId: 'project1' }
  beforeEach(async () => {
    vi.resetModules()
    native.save.mockReset()
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'manual-export-'))
    native.userData = path.join(root, 'profile')
    const security = await import('../../electron/ipcSecurity')
    security.registerTrustedWindow(() => main)
    security.registerTrustedWindow(() => ({ isDestroyed: () => false, webContents: { id: 22 } }) as BrowserWindow)
    files = (await import('../../electron/fileStorage')).getFileStorageService()
    await files.getConfiguration()
    const ipcMain = { handle: (_channel: string, callback: typeof invoke) => { invoke = callback } } as unknown as IpcMain
    ;(await import('../../electron/manualExportIpc')).registerManualExportIpc({ ipcMain, getMainWindow: () => main })
  })
  afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('defaults to the frozen project directory and writes only the alternate native selection', async () => {
    const project = path.join(root, 'project')
    const global = path.join(root, 'global')
    await fs.promises.mkdir(project); await fs.promises.mkdir(global)
    await files.configureTranscriptDirectory(global)
    await files.configureTranscriptDirectory(project, 'project1')
    const target = path.join(root, 'alternate.txt')
    native.save.mockResolvedValue({ canceled: false, filePath: target })
    expect(await invoke(event(), { ...request, outputPath: path.join(root, 'renderer.txt') } as typeof request)).toEqual({ ok: true })
    expect(native.save.mock.calls[0][1].defaultPath).toBe(path.join(project, request.filename))
    expect(await fs.promises.readFile(target, 'utf8')).toBe(request.content)
    expect(fs.existsSync(path.join(root, 'renderer.txt'))).toBe(false)
    expect(await fs.promises.readdir(project)).toEqual([])
    expect(Object.keys((await files.getConfiguration()).projectTranscriptDirectories)).toEqual(['project1'])
  })
  it('uses global only for unconfigured projects; no config still opens filename-only SaveAs', async () => {
    native.save.mockResolvedValue({ canceled: true })
    expect(await invoke(event(), request)).toEqual({ ok: true, cancelled: true })
    expect(native.save.mock.calls[0][1].defaultPath).toBe(request.filename)
    const global = path.join(root, 'global')
    await fs.promises.mkdir(global)
    await files.configureTranscriptDirectory(global)
    await invoke(event(), request)
    expect(native.save.mock.calls[1][1].defaultPath).toBe(path.join(global, request.filename))
    expect(await fs.promises.readdir(global)).toEqual([])
  })
  it('fails a missing configured directory without opening SaveAs or downloading elsewhere', async () => {
    const project = path.join(root, 'project')
    await fs.promises.mkdir(project)
    await files.configureTranscriptDirectory(project, 'project1')
    await fs.promises.rmdir(project)
    expect((await invoke(event(), request)).ok).toBe(false)
    expect(native.save).not.toHaveBeenCalled()
  })
  it('rejects both preexisting files and a file created during the native picker race', async () => {
    const target = path.join(root, 'existing.txt')
    await fs.promises.writeFile(target, 'KEEP')
    native.save.mockResolvedValue({ canceled: false, filePath: target })
    expect(await invoke(event(), request)).toMatchObject({ ok: false, error: expect.stringContaining('never replaced') })
    expect(await fs.promises.readFile(target, 'utf8')).toBe('KEEP')
    const raced = path.join(root, 'race.txt')
    native.save.mockImplementation(async () => { await fs.promises.writeFile(raced, 'RACE'); return { canceled: false, filePath: raced } })
    expect((await invoke(event(), request)).ok).toBe(false)
    expect(await fs.promises.readFile(raced, 'utf8')).toBe('RACE')
  })
  it('rejects widget/untrusted senders, unsafe basenames, extensions and oversized content before native selection', async () => {
    await expect(invoke(event(22), request)).rejects.toThrow('main window required')
    await expect(invoke(event(33), request)).rejects.toThrow('untrusted sender')
    for (const filename of ['../bad.txt', 'CON.txt', 'bad.exe']) expect((await invoke(event(), { ...request, filename })).ok).toBe(false)
    expect((await invoke(event(), { ...request, content: 'x'.repeat(32 * 1024 * 1024 + 1) })).ok).toBe(false)
    expect(native.save).not.toHaveBeenCalled()
  })
  it('rechecks the main sender after native selection before writing', async () => {
    const target = path.join(root, 'stale.txt')
    native.save.mockImplementation(async () => { vi.spyOn(main, 'isDestroyed').mockReturnValue(true); return { canceled: false, filePath: target } })
    expect((await invoke(event(), request)).ok).toBe(false)
    expect(fs.existsSync(target)).toBe(false)
  })
  it('cancellation ignores even a returned native path and writes nothing', async () => {
    const target = path.join(root, 'cancelled.txt')
    native.save.mockResolvedValue({ canceled: true, filePath: target })
    expect(await invoke(event(), request)).toEqual({ ok: true, cancelled: true })
    expect(fs.existsSync(target)).toBe(false)
  })
  it('binds native filters to whitelisted export types and rejects native extension changes', async () => {
    for (const extension of ['txt', 'md', 'srt', 'vtt', 'json', 'sbv']) {
      const target = path.join(root, `selected.${extension}`)
      native.save.mockResolvedValue({ canceled: false, filePath: target })
      expect(await invoke(event(), { ...request, filename: `suggested.${extension}` })).toEqual({ ok: true })
      expect(native.save.mock.calls[native.save.mock.calls.length - 1][1].filters).toEqual([{ name: extension.toUpperCase(), extensions: [extension] }])
      expect(await fs.promises.readFile(target, 'utf8')).toBe(request.content)
    }
    native.save.mockResolvedValue({ canceled: false, filePath: path.join(root, 'wrong.exe') })
    expect((await invoke(event(), request)).ok).toBe(false)
    expect(fs.existsSync(path.join(root, 'wrong.exe'))).toBe(false)
  })
  it('routes raw, analysis and subtitle exporters through the same frozen project without registering automatic saves', async () => {
    const utilities = await import('./utils/storageUtils')
    const { downloadSubtitle } = await import('./utils/subtitleExport')
    const manualExportFile = vi.fn().mockResolvedValue({ ok: true, cancelled: true })
    const savePublishedMarkdown = vi.fn()
    vi.stubGlobal('window', { alert: vi.fn(), electronAPI: { manualExportFile, savePublishedMarkdown } })
    const session = { id: 'session1', title: 'Title', date: '2026-10-05', time: '12:00', createdAt: 1, updatedAt: 1,
      transcript: 'Raw transcript.', defaultSaveProjectId: 'frozen-project', projectIds: ['other-project', 'frozen-project'],
      postProcess: { status: 'success' as const, summary: 'Analysis summary' } }
    await utilities.exportToTxt(session)
    await utilities.exportToMarkdown(session)
    await utilities.exportAiAnalysisToTxt(session)
    await utilities.exportAiAnalysisToMarkdown(session)
    await downloadSubtitle(session, 'srt')
    await downloadSubtitle(session, 'vtt')
    expect(manualExportFile).toHaveBeenCalledTimes(6)
    for (const [payload] of manualExportFile.mock.calls) expect(payload.defaultSaveProjectId).toBe('frozen-project')
    expect(manualExportFile.mock.calls[0][0].content).toContain('Raw transcript.')
    expect(manualExportFile.mock.calls[2][0].content).toContain('Analysis summary')
    expect(manualExportFile.mock.calls[4][0].content).toContain('-->')
    expect(manualExportFile.mock.calls[5][0].content).toContain('WEBVTT')
    expect(savePublishedMarkdown).not.toHaveBeenCalled()
  })
  it('preserves browser Blob download but never falls back after desktop cancel/error', async () => {
    const { saveManualExport } = await import('./utils/storageUtils')
    const create = vi.fn(() => 'blob:temporary')
    const click = vi.fn()
    const alert = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() })
    vi.stubGlobal('document', { createElement: () => ({ click }), body: { appendChild: vi.fn(), removeChild: vi.fn() } })
    vi.stubGlobal('window', { alert })
    await saveManualExport(request, request.content, request.filename, 'text/plain')
    expect(create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce()
    const manualExportFile = vi.fn().mockResolvedValue({ ok: true, cancelled: true })
    vi.stubGlobal('window', { alert, electronAPI: { manualExportFile } })
    await saveManualExport(request, request.content, request.filename, 'text/plain')
    expect(manualExportFile).toHaveBeenCalledWith(request)
    expect(alert).not.toHaveBeenCalled()
    manualExportFile.mockRejectedValue(new Error('disk failed'))
    await expect(saveManualExport(request, request.content, request.filename, 'text/plain')).resolves.toBeUndefined()
    expect(alert).toHaveBeenCalledWith('disk failed')
    expect(create).toHaveBeenCalledOnce()
  })
})
