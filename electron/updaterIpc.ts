import type { BrowserWindow, IpcMain } from 'electron'
import { assertTrustedSender } from './ipcSecurity'
import { getAutoUpdater, isMissingAppUpdateConfigError } from './updaterSupport'

interface RegisterUpdaterIpcOptions {
  ipcMain: IpcMain
  isDev: boolean
  isAutoUpdateSupported: () => boolean
  getMainWindow: () => BrowserWindow | null
  markQuitting: () => void
}

export function registerUpdaterIpc(options: RegisterUpdaterIpcOptions): void {
  options.ipcMain.handle('check-for-updates', async () => {
    if (options.isDev) {
      return { error: '开发模式下不支持自动更新' }
    }
    if (!options.isAutoUpdateSupported()) {
      return { error: '当前安装方式不支持自动更新（Linux 仅 AppImage 支持）' }
    }
    try {
      const autoUpdater = getAutoUpdater()
      const result = await autoUpdater.checkForUpdates()
      return {
        success: true,
        version: result?.updateInfo.version,
      }
    } catch (error) {
      console.error('检查更新失败:', error)
      if (isMissingAppUpdateConfigError(error)) {
        return { error: '当前安装方式不支持自动更新' }
      }
      return {
        error: error instanceof Error ? error.message : '检查更新失败',
      }
    }
  })

  options.ipcMain.handle('download-update', async (event) => {
    assertTrustedSender(event, 'download-update')
    if (options.isDev) {
      return { error: '开发模式下不支持自动更新' }
    }
    if (!options.isAutoUpdateSupported()) {
      return { error: '当前安装方式不支持自动更新（Linux 仅 AppImage 支持）' }
    }
    try {
      const autoUpdater = getAutoUpdater()
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (error) {
      console.error('下载更新失败:', error)
      if (isMissingAppUpdateConfigError(error)) {
        return { error: '当前安装方式不支持自动更新' }
      }
      return {
        error: error instanceof Error ? error.message : '下载更新失败',
      }
    }
  })

  options.ipcMain.handle('install-update', (event) => {
    assertTrustedSender(event, 'install-update')
    if (!options.isAutoUpdateSupported()) {
      const mainWindow = options.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-error', '当前安装方式不支持自动更新（Linux 仅 AppImage 支持）')
      }
      return
    }
    options.markQuitting()
    const autoUpdater = getAutoUpdater()
    autoUpdater.quitAndInstall(false, true)
  })
}
