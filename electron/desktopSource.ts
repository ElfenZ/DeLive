import { desktopCapturer, session, type BrowserWindow, type IpcMain } from 'electron'
import type { SourceSelectionMode } from '../shared/electronApi'

// Electron 的 display media callback 类型在这里不稳定，沿用主进程旧实现的宽类型。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DisplayMediaCallback = (result: any) => void

interface DesktopSourceControllerOptions {
  getMainWindow: () => BrowserWindow | null
}

export function createDesktopSourceController(options: DesktopSourceControllerOptions) {
  let pendingDisplayMediaCallback: DisplayMediaCallback | null = null
  let lastSelectedSourceId: string | null = null
  let sourceSelectionMode: SourceSelectionMode = 'prompt'

  function resetSourceSelectionMode(): void {
    sourceSelectionMode = 'prompt'
  }

  function resolvePendingCallback(result: unknown): void {
    const callback = pendingDisplayMediaCallback
    pendingDisplayMediaCallback = null
    resetSourceSelectionMode()
    callback?.(result)
  }

  async function tryReuseLastSource(callback: DisplayMediaCallback): Promise<boolean> {
    if (!lastSelectedSourceId) {
      return false
    }

    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const savedSource = sources.find((source) => source.id === lastSelectedSourceId)

      if (!savedSource) {
        console.log('[DisplayMedia] 上次选择的源已不可用，回退到选择器')
        return false
      }

      console.log('[DisplayMedia] 自动复用上次选择的源:', lastSelectedSourceId)
      resetSourceSelectionMode()
      callback({ video: savedSource, audio: 'loopback' as const })
      return true
    } catch (error) {
      console.error('[DisplayMedia] 自动复用源失败:', error)
      return false
    }
  }

  function promptForSourceSelection(callback: DisplayMediaCallback): void {
    pendingDisplayMediaCallback = callback

    const mainWindow = options.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.warn('[DisplayMedia] 主窗口不可用，取消本次源选择')
      resolvePendingCallback({})
      return
    }

    mainWindow.webContents.send('show-source-picker')
  }

  function attachDisplayMediaHandler(): void {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      if (pendingDisplayMediaCallback) {
        console.warn('[DisplayMedia] 收到新的 capture 请求，取消旧的待处理 callback')
        resolvePendingCallback({})
      }

      if (sourceSelectionMode === 'reuse-if-available' && await tryReuseLastSource(callback)) {
        return
      }

      promptForSourceSelection(callback)
    })
  }

  function prepareSourceCapture(mode: SourceSelectionMode): void {
    sourceSelectionMode = mode
  }

  async function selectSource(sourceId: string): Promise<boolean> {
    if (!pendingDisplayMediaCallback) return false

    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const selectedSource = sources.find((source) => source.id === sourceId)

      if (selectedSource) {
        lastSelectedSourceId = sourceId
        resolvePendingCallback({ video: selectedSource, audio: 'loopback' as const })
        return true
      }

      resolvePendingCallback({})
      return false
    } catch (error) {
      console.error('选择源失败:', error)
      resolvePendingCallback({})
      return false
    }
  }

  function cancelSourceSelection(): void {
    if (pendingDisplayMediaCallback) {
      resolvePendingCallback({})
    }
  }

  async function listDesktopSources() {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    })

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.toDataURL() || null,
      isScreen: source.id.startsWith('screen:'),
    }))
  }

  return {
    attachDisplayMediaHandler,
    prepareSourceCapture,
    selectSource,
    cancelSourceSelection,
    listDesktopSources,
  }
}

interface RegisterDesktopSourceIpcOptions {
  ipcMain: IpcMain
  controller: ReturnType<typeof createDesktopSourceController>
}

export function registerDesktopSourceIpc({ ipcMain, controller }: RegisterDesktopSourceIpcOptions): void {
  ipcMain.removeHandler('prepare-source-capture')
  ipcMain.handle('prepare-source-capture', (_event, mode: SourceSelectionMode) => {
    controller.prepareSourceCapture(mode)
  })

  ipcMain.removeHandler('select-source')
  ipcMain.handle('select-source', async (_event, sourceId: string) => {
    return controller.selectSource(sourceId)
  })

  ipcMain.removeHandler('cancel-source-selection')
  ipcMain.handle('cancel-source-selection', () => {
    controller.cancelSourceSelection()
  })

  ipcMain.handle('get-desktop-sources', async () => {
    try {
      return await controller.listDesktopSources()
    } catch (error) {
      console.error('获取桌面源失败:', error)
      return []
    }
  })
}
