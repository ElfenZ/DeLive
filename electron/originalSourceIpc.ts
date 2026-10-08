import { dialog, type IpcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { assertMainWindowSender } from './ipcSecurity'
import { getOriginalSourceService } from './originalSources'
import { getFileStorageService } from './fileStorage'
import type { OriginalSourceResult } from '../shared/originalSources'

export function registerOriginalSourceIpc(options: { ipcMain: IpcMain; getMainWindow: () => BrowserWindow | null }): void {
  options.ipcMain.on('native-file-selected', (event, filePath: string) => {
    assertMainWindowSender(event as IpcMainInvokeEvent, 'native-file-selected', options.getMainWindow)
    getOriginalSourceService().rememberSelection(filePath, event.sender.id)
  })
  const failed = (error: unknown): OriginalSourceResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
  options.ipcMain.handle('list-original-sources', async (event) => {
    assertMainWindowSender(event, 'list-original-sources', options.getMainWindow)
    try { return { ok: true, sources: await getOriginalSourceService().listInfo() } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  options.ipcMain.handle('register-original-source', async (event, filePath: string, sessionId: string): Promise<OriginalSourceResult> => {
    assertMainWindowSender(event, 'register-original-source', options.getMainWindow)
    try { return { ok: true, source: await getOriginalSourceService().register(filePath, sessionId, event.sender.id) } } catch (error) { return failed(error) }
  })
  options.ipcMain.handle('acquire-original-read', async (event, sourceId: string, sessionId: string) => {
    assertMainWindowSender(event, 'acquire-original-read', options.getMainWindow)
    try { const lease = await getOriginalSourceService().acquireRead(sourceId, sessionId, event.sender.id); return { ok: true, token: lease.token } } catch (error) { return failed(error) }
  })
  options.ipcMain.handle('release-original-read', (event, token: string) => {
    assertMainWindowSender(event, 'release-original-read', options.getMainWindow)
    getOriginalSourceService().releaseRead(token, event.sender.id)
  })
  options.ipcMain.handle('read-original-audio', async (event, token: string) => {
    assertMainWindowSender(event, 'read-original-audio', options.getMainWindow)
    try { return { ok: true, ...await getOriginalSourceService().readAudio(token, event.sender.id) } } catch (error) { return failed(error) }
  })
  options.ipcMain.handle('preview-original-rename', async (event, sourceId: string, sessionId: string): Promise<OriginalSourceResult> => {
    assertMainWindowSender(event, 'preview-original-rename', options.getMainWindow)
    try { return { ok: true, preview: await getOriginalSourceService().preview(sourceId, await getFileStorageService().getSessionContext(sessionId), event.sender.id) } } catch (error) { return failed(error) }
  })
  options.ipcMain.handle('commit-original-rename', async (event, token: string): Promise<OriginalSourceResult | null> => {
    assertMainWindowSender(event, 'commit-original-rename', options.getMainWindow)
    try {
      const service = getOriginalSourceService()
      const preview = service.peek(token, event.sender.id)
      const result = await dialog.showMessageBox(options.getMainWindow()!, { type: 'warning', title: '原件改名 / Rename Original',
        message: `${preview.oldName}\n→ ${preview.newName}`, detail: `${preview.directory}\n引用记录 / Referencing records: ${preview.affectedSessionIds.join(', ')}\n只在当前目录改名，不移动、不复制、不覆盖。\n外部引用和链接无法自动修复。 / External references and links cannot be repaired automatically.`,
        buttons: ['取消 / Cancel', '确认改名 / Confirm Rename'], defaultId: 0, cancelId: 0 })
      if (result.response !== 1) { service.cancel(token, event.sender.id); return null }
      assertMainWindowSender(event, 'commit-original-rename', options.getMainWindow)
      const source = await service.commit(token, event.sender.id, () => getFileStorageService().getSessionContext(preview.sessionId))
      options.getMainWindow()!.webContents.send('original-source-changed', source)
      return { ok: true, source }
    } catch (error) { return failed(error) }
  })
  options.ipcMain.handle('preview-original-undo', async (event, sourceId: string, sessionId: string): Promise<OriginalSourceResult> => {
    assertMainWindowSender(event, 'preview-original-undo', options.getMainWindow)
    try { return { ok: true, preview: await getOriginalSourceService().preview(sourceId, await getFileStorageService().getSessionContext(sessionId), event.sender.id, true) } } catch (error) { return failed(error) }
  })
}
