import { app, BrowserWindow, ipcMain, session, Tray, globalShortcut } from 'electron'
import { registerAppIpc } from './appIpc'
import { setupAutoUpdater } from './autoUpdater'
import { registerCaptionIpc } from './captionIpc'
import { createCaptionWindowController } from './captionWindow'
import { createDesktopSourceController, registerDesktopSourceIpc } from './desktopSource'
import { createLocalRuntimeController } from './localRuntime'
import { registerLocalRuntimeIpc } from './localRuntimeIpc'
import { createMainWindow } from './mainWindow'
import { registerAppShortcuts } from './shortcuts'
import { createAppTray, findIconPath, rebuildTrayMenu } from './tray'
import { registerUpdaterIpc } from './updaterIpc'
import { installLogInterceptor, registerDiagnosticsIpc } from './diagnosticsIpc'
import { assertTrustedSender, registerTrustedWindow } from './ipcSecurity'
import { registerSafeStorageIpc } from './safeStorageIpc'
import { startVolcProxyServer, type ProxyServerRuntime } from './volcProxy'
import { registerApiIpc } from './apiIpc'
import { attachApiServer, type ApiServerAttachment } from './apiServer'
import { registerCloudBackupIpc } from './cloudBackup/cloudBackupIpc'
import { refreshElectronLang, getElectronStrings } from './i18n'
import { isAutoUpdateSupported } from './updaterSupport'
import type { AiCorrectionRecoveryRequest, AiCorrectionRecoveryResponse } from '../shared/electronApi'
import { buildAiCorrectionRecoveryHeaders } from './aiCorrectionRecovery'
import { registerMediaIpc, type MediaIpcController } from './mediaIpc'
import { registerFileStorageIpc } from './fileStorageIpc'
import { registerOriginalSourceIpc } from './originalSourceIpc'
import { registerManualExportIpc } from './manualExportIpc'

installLogInterceptor()

if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'ScreenCaptureKitAudio,ScreenCaptureKitStreamPickerSonoma')
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'PulseaudioLoopbackForScreenShare')
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let proxyServerRuntime: ProxyServerRuntime | null = null
let apiServerAttachment: ApiServerAttachment | null = null
let aiCorrectionRecoveryQueue: Promise<void> = Promise.resolve()
const aiCorrectionRecoveryControllers = new Map<string, AbortController>()
let aiCorrectionRecoveryPending = 0
let mediaIpcController: MediaIpcController | null = null
const MAX_AI_CORRECTION_RECOVERY_QUEUE = 4
const MAX_AI_CORRECTION_RECOVERY_RESPONSE_BYTES = 5 * 1024 * 1024

async function readLimitedRecoveryResponse(
  response: Response,
  controller: AbortController,
  idleTimeoutMs: number,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let body = ''
  let bytes = 0
  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => {
          controller.abort()
          reject(new Error('AI_RECOVERY_IDLE_TIMEOUT'))
        }, idleTimeoutMs)
      })
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await Promise.race([reader.read(), idle])
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > MAX_AI_CORRECTION_RECOVERY_RESPONSE_BYTES) {
        controller.abort()
        throw new Error('AI_RECOVERY_RESPONSE_TOO_LARGE')
      }
      body += decoder.decode(result.value, { stream: true })
    }
    body += decoder.decode()
    return body
  } finally {
    reader.releaseLock()
  }
}

const isDev = process.env.NODE_ENV === 'development'

const captionController = createCaptionWindowController({
  getMainWindow: () => mainWindow,
  getTray: () => tray,
  isQuitting: () => isQuitting,
  isDev,
})

registerTrustedWindow(() => mainWindow)
registerTrustedWindow(() => captionController.getWindow())

const desktopSourceController = createDesktopSourceController({
  getMainWindow: () => mainWindow,
})

const localRuntimeController = createLocalRuntimeController()

function isTrayReady(): boolean {
  return tray !== null && !tray.isDestroyed()
}

function createWindow(): void {
  const windowIconPath = findIconPath()
  desktopSourceController.attachDisplayMediaHandler()
  mainWindow = createMainWindow({
    isDev,
    windowIconPath: windowIconPath || undefined,
    shouldHideToTray: () => !isQuitting && isTrayReady(),
    onShow: () => {
      captionController.debug('mainWindow.show')
      captionController.refreshForMainWindowState('mainWindow.show')
    },
    onHide: () => {
      captionController.debug('mainWindow.hide')
      captionController.refreshForMainWindowState('mainWindow.hide')
    },
    onMinimize: () => {
      captionController.debug('mainWindow.minimize')
      captionController.refreshForMainWindowState('mainWindow.minimize')
    },
    onRestore: () => {
      captionController.debug('mainWindow.restore')
      captionController.refreshForMainWindowState('mainWindow.restore')
    },
    onFocus: () => {
      captionController.debug('mainWindow.focus')
    },
    onBlur: () => {
      captionController.debug('mainWindow.blur')
    },
    onCloseToTray: () => {
      captionController.debug('mainWindow.close', {
        willHideToTray: true,
      })
    },
    onClosed: () => {
      captionController.debug('mainWindow.closed')
      mainWindow = null
    },
  })
  captionController.debug('mainWindow.created')
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (process.platform === 'darwin') app.dock?.show()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
      try {
        const proxy = await session.defaultSession.resolveProxy('https://api.mistral.ai')
        const match = proxy.match(/^PROXY\s+(.+)$/i)
        if (match) {
          const proxyUrl = `http://${match[1]}`
          process.env.HTTPS_PROXY = proxyUrl
          process.env.HTTP_PROXY = proxyUrl
          console.log(`[Main] 检测到系统代理: ${proxyUrl}`)
        }
      } catch {
        // ignore proxy detection failure
      }
    }

    proxyServerRuntime = await startVolcProxyServer()
    apiServerAttachment = attachApiServer({ server: proxyServerRuntime.server })

    createWindow()
    tray = createAppTray({
      getMainWindow: () => mainWindow,
      onQuit: () => {
        isQuitting = true
        app.quit()
      },
      debug: (message, extra) => captionController.debug(message, extra),
    })

    registerAppShortcuts({
      getMainWindow: () => mainWindow,
      isTrayReady,
    })

    if (!isDev && isAutoUpdateSupported()) {
      setupAutoUpdater({
        getMainWindow: () => mainWindow,
        markQuitting: () => {
          isQuitting = true
        },
      })
    } else if (!isDev && process.platform === 'linux') {
      console.log('[Updater] 当前 Linux 安装方式不支持自动更新（仅 AppImage 支持）')
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  }).catch((error) => {
    console.error('[Main] 本地代理/API 服务器启动失败，应用将退出:', error)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  captionController.debug('app.window-all-closed')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  captionController.debug('app.before-quit')
  isQuitting = true
  captionController.dispose()
  globalShortcut.unregisterAll()
  mediaIpcController?.dispose()
  void localRuntimeController.stopAll()
  const apiAttachment = apiServerAttachment
  apiServerAttachment = null
  if (apiAttachment) void apiAttachment.close().catch((error) => console.warn('[Main] 关闭 API WebSocket 失败:', error))
  const runtime = proxyServerRuntime
  proxyServerRuntime = null
  if (runtime) void runtime.close().catch((error) => console.warn('[Main] 关闭代理服务器失败:', error))
})

ipcMain.handle('get-proxy-port', () => {
  if (!proxyServerRuntime) throw new Error('Local proxy server is not ready')
  return proxyServerRuntime.port
})

ipcMain.handle('ai-correction-recovery-fetch', async (event, request: AiCorrectionRecoveryRequest) => {
  assertTrustedSender(event, 'ai-correction-recovery-fetch')
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('AI correction recovery is restricted to the main window')
  }
  const parsed = new URL(request.url)
  if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(request.requestId)) {
    throw new Error('Invalid AI recovery request id')
  }
  if (request.provider !== 'openai-compatible' && request.provider !== 'anthropic-compatible') {
    throw new Error('Invalid AI recovery provider protocol')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Unsupported AI recovery URL protocol')
  if (typeof request.body !== 'string' || request.body.length > 1_000_000) throw new Error('Invalid AI recovery request body')
  if (!Number.isFinite(request.absoluteTimeoutMs) || request.absoluteTimeoutMs < 1_000 || request.absoluteTimeoutMs > 10 * 60_000) {
    throw new Error('Invalid AI recovery timeout')
  }
  if (!Number.isFinite(request.idleTimeoutMs) || request.idleTimeoutMs < 1_000 || request.idleTimeoutMs > 2 * 60_000) {
    throw new Error('Invalid AI recovery idle timeout')
  }
  if (!Number.isFinite(request.firstByteTimeoutMs) || request.firstByteTimeoutMs < 1_000 || request.firstByteTimeoutMs > 5 * 60_000) {
    throw new Error('Invalid AI recovery first-byte timeout')
  }
  if (aiCorrectionRecoveryPending >= MAX_AI_CORRECTION_RECOVERY_QUEUE) {
    throw new Error('AI correction recovery queue is full')
  }

  const execute = async (): Promise<AiCorrectionRecoveryResponse> => {
    const recoverySession = session.fromPartition('ai-correction-recovery')
    const controller = aiCorrectionRecoveryControllers.get(request.requestId)
    if (!controller) throw new Error('AI recovery request was cancelled before dispatch')
    if (controller.signal.aborted) throw new Error('AI recovery request was cancelled before dispatch')
    await recoverySession.closeAllConnections()
    if (controller.signal.aborted) throw new Error('AI recovery request was cancelled before dispatch')
    console.warn('[AI Correction Recovery] Dispatching through isolated network session', {
      endpoint: `${parsed.protocol}//${parsed.host}`,
    })
    const absoluteTimer = setTimeout(() => controller.abort(), request.absoluteTimeoutMs)
    let firstByteTimedOut = false
    const firstByteTimer = setTimeout(() => {
      firstByteTimedOut = true
      controller.abort()
    }, request.firstByteTimeoutMs)
    try {
      let response: Response
      try {
        response = await recoverySession.fetch(parsed.toString(), {
          method: 'POST',
          headers: buildAiCorrectionRecoveryHeaders(request),
          body: request.body,
          signal: controller.signal,
        })
      } catch (error) {
        if (firstByteTimedOut) throw new Error('AI_RECOVERY_FIRST_BYTE_TIMEOUT')
        throw error
      } finally {
        clearTimeout(firstByteTimer)
      }
      return {
        status: response.status,
        contentType: response.headers.get('Content-Type') || undefined,
        retryAfter: response.headers.get('Retry-After') || undefined,
        body: await readLimitedRecoveryResponse(response, controller, request.idleTimeoutMs),
      }
    } finally {
      clearTimeout(firstByteTimer)
      clearTimeout(absoluteTimer)
    }
  }

  if (aiCorrectionRecoveryControllers.has(request.requestId)) throw new Error('Duplicate AI recovery request id')
  aiCorrectionRecoveryControllers.set(request.requestId, new AbortController())
  aiCorrectionRecoveryPending += 1
  const result = aiCorrectionRecoveryQueue.then(execute, execute)
  aiCorrectionRecoveryQueue = result.then(() => undefined, () => undefined)
  try {
    return await result
  } finally {
    aiCorrectionRecoveryControllers.delete(request.requestId)
    aiCorrectionRecoveryPending = Math.max(0, aiCorrectionRecoveryPending - 1)
  }
})

ipcMain.handle('cancel-ai-correction-recovery-fetch', (event, requestId: unknown) => {
  assertTrustedSender(event, 'cancel-ai-correction-recovery-fetch')
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return false
  if (typeof requestId !== 'string') return false
  const controller = aiCorrectionRecoveryControllers.get(requestId)
  if (!controller) return false
  controller.abort()
  return true
})

registerLocalRuntimeIpc({
  ipcMain,
  controller: localRuntimeController,
})

registerDesktopSourceIpc({
  ipcMain,
  controller: desktopSourceController,
})

registerAppIpc({
  ipcMain,
  getMainWindow: () => mainWindow,
  isTrayReady,
  hideMainWindow: () => {
    mainWindow?.hide()
  },
  minimizeMainWindow: () => {
    mainWindow?.minimize()
  },
  maximizeMainWindow: () => {
    mainWindow?.maximize()
  },
  unmaximizeMainWindow: () => {
    mainWindow?.unmaximize()
  },
  closeMainWindow: () => {
    mainWindow?.close()
  },
  isMainWindowMaximized: () => mainWindow?.isMaximized() ?? false,
  onWindowMinimize: (source) => {
    captionController.debug('ipc.window-minimize', { source: source || 'unknown' })
  },
  onWindowClose: () => {
    captionController.debug('ipc.window-close')
  },
})

registerFileStorageIpc({ ipcMain, getMainWindow: () => mainWindow })
registerOriginalSourceIpc({ ipcMain, getMainWindow: () => mainWindow })
registerManualExportIpc({ ipcMain, getMainWindow: () => mainWindow })

mediaIpcController = registerMediaIpc({
  ipcMain,
  getMainWindow: () => mainWindow,
})

registerUpdaterIpc({
  ipcMain,
  isDev,
  isAutoUpdateSupported,
  getMainWindow: () => mainWindow,
  markQuitting: () => {
    isQuitting = true
  },
})

registerCaptionIpc({
  ipcMain,
  controller: captionController,
})

registerDiagnosticsIpc({
  ipcMain,
  getMainWindow: () => mainWindow,
})

registerSafeStorageIpc(ipcMain)
registerCloudBackupIpc(ipcMain)

registerApiIpc({
  ipcMain,
  getMainWindow: () => mainWindow,
})

ipcMain.handle('lang:change', (_event, lang: string) => {
  if (lang === 'zh' || lang === 'en') {
    refreshElectronLang(lang as 'zh' | 'en')
  } else {
    refreshElectronLang()
  }
  if (tray && !tray.isDestroyed()) {
    rebuildTrayMenu(tray, {
      getMainWindow: () => mainWindow,
      onQuit: () => {
        isQuitting = true
        app.quit()
      },
      debug: (message, extra) => captionController.debug(message, extra),
    })
  }
})
