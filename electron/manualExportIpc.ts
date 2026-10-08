import { dialog, type BrowserWindow, type IpcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { assertMainWindowSender } from './ipcSecurity'
import { getFileStorageService } from './fileStorage'
import { assertSafeDirectory, assertStorageBasename } from './fileStorageService'
import { isSafeStorageId } from '../shared/fileStorage'
import type { ElectronAPI } from '../shared/electronApi'

const EXTENSIONS = new Set(['txt', 'md', 'srt', 'vtt', 'json', 'sbv'])
const MAX_CONTENT_BYTES = 32 * 1024 * 1024

export function registerManualExportIpc(options: { ipcMain: IpcMain; getMainWindow: () => BrowserWindow | null }): void {
  options.ipcMain.handle('manual-export-file', async (event, request: Parameters<ElectronAPI['manualExportFile']>[0]): ReturnType<ElectronAPI['manualExportFile']> => {
    assertMainWindowSender(event, 'manual-export-file', options.getMainWindow)
    try {
      if (!request || typeof request.content !== 'string' || Buffer.byteLength(request.content, 'utf8') > MAX_CONTENT_BYTES) throw new Error('Invalid export content or export exceeds 32 MiB')
      assertStorageBasename(request.filename)
      const extension = path.extname(request.filename).slice(1).toLowerCase()
      if (!EXTENSIONS.has(extension)) throw new Error('Unsupported export extension')
      const projectId = request.defaultSaveProjectId
      if (projectId !== undefined && !isSafeStorageId(projectId)) throw new Error('Invalid default export project')
      const service = getFileStorageService()
      const config = await service.getConfiguration()
      const configured = (projectId && config.projectTranscriptDirectories[projectId]) || config.defaultTranscriptDirectory
      const directory = configured ? await service.transcriptDirectory(projectId) : undefined
      const selection = await dialog.showSaveDialog(options.getMainWindow()!, {
        title: 'Export / 另存为',
        defaultPath: directory ? path.join(directory, request.filename) : request.filename,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
        properties: ['showOverwriteConfirmation'],
      })
      if (selection.canceled || !selection.filePath) return { ok: true, cancelled: true }
      assertMainWindowSender(event, 'manual-export-file', options.getMainWindow)
      const target = selection.filePath
      if (!path.isAbsolute(target)) throw new Error('Native export destination must be absolute')
      assertStorageBasename(path.basename(target))
      if (path.extname(target).slice(1).toLowerCase() !== extension) throw new Error('Selected filename must retain the export extension')
      await assertSafeDirectory(path.dirname(target))
      // Native selection authorizes only this write, not a persistent directory grant.
      const handle = await fs.promises.open(target, 'wx')
      try { await handle.writeFile(request.content, 'utf8'); await handle.sync() } finally { await handle.close() }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'File already exists; choose a new filename. Existing files are never replaced. / 文件已存在，请选择新文件名；不会覆盖原文件。'
        : error instanceof Error ? error.message : String(error) }
    }
  })
}
