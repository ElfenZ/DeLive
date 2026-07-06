import { app, dialog, shell, type BrowserWindow, type IpcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { assertTrustedSender, isPathAllowed } from './ipcSecurity'
import type {
  RecordingArchiveAppendRequest,
  RecordingArchiveBeginRequest,
  RecordingArchiveFinalizeRequest,
  RecordingArchiveSaveRequest,
  RecordingArchiveSaveResult,
} from '../shared/electronApi'

interface RegisterAppIpcOptions {
  ipcMain: IpcMain
  getMainWindow: () => BrowserWindow | null
  isTrayReady: () => boolean
  hideMainWindow: () => void
  minimizeMainWindow: () => void
  maximizeMainWindow: () => void
  unmaximizeMainWindow: () => void
  closeMainWindow: () => void
  isMainWindowMaximized: () => boolean
  onWindowMinimize?: (source?: string) => void
  onWindowClose?: () => void
}

function isAutoLaunchSupported(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

function getAutoLaunchEnabled(): boolean {
  if (!isAutoLaunchSupported()) return false

  try {
    const settings = app.getLoginItemSettings()

    if (process.platform === 'win32') {
      const hasEnabledLaunchItem = (settings.launchItems || []).some((item) => item.enabled)
      return settings.openAtLogin || hasEnabledLaunchItem
    }

    return settings.openAtLogin
  } catch (error) {
    console.warn('[AutoLaunch] 读取开机启动状态失败:', error)
    return false
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'recording'
}

interface RecordingArchiveMetadata {
  sessionId: string
  sampleRate: number
  channels: number
  bitsPerSample: number
  createdAt: number
  updatedAt: number
}

const DEFAULT_RECORDING_ARCHIVE_FORMAT = {
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
} as const

function getRecordingArchivePaths(sessionIdValue: string, fileNameValue = 'source-audio.wav') {
  const sessionId = sanitizePathPart(sessionIdValue)
  const fileName = sanitizePathPart(fileNameValue)
  const archiveDir = path.join(app.getPath('userData'), 'media', sessionId)
  return {
    sessionId,
    fileName,
    archiveDir,
    archivePath: path.join(archiveDir, fileName),
    tempArchivePath: path.join(archiveDir, `${fileName}.tmp`),
    pcmPath: path.join(archiveDir, 'source-audio.pcm.tmp'),
    metaPath: path.join(archiveDir, 'source-audio.json.tmp'),
  }
}

function assertArchivePathAllowed(targetPath: string): void {
  if (!isPathAllowed(targetPath)) {
    throw new Error('Archive path is not allowed')
  }
}

function normalizePcmFormat(request: RecordingArchiveBeginRequest): Pick<RecordingArchiveMetadata, 'sampleRate' | 'channels' | 'bitsPerSample'> {
  const sampleRate = Number.isFinite(request.sampleRate) && request.sampleRate > 0 ? Math.floor(request.sampleRate) : DEFAULT_RECORDING_ARCHIVE_FORMAT.sampleRate
  const channels = Number.isFinite(request.channels) && request.channels > 0 ? Math.floor(request.channels) : DEFAULT_RECORDING_ARCHIVE_FORMAT.channels
  const bitsPerSample = Number.isFinite(request.bitsPerSample) && request.bitsPerSample > 0 ? Math.floor(request.bitsPerSample) : DEFAULT_RECORDING_ARCHIVE_FORMAT.bitsPerSample
  return { sampleRate, channels, bitsPerSample }
}

function buildWavHeader(pcmSize: number, metadata: Pick<RecordingArchiveMetadata, 'sampleRate' | 'channels' | 'bitsPerSample'>): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = metadata.sampleRate * metadata.channels * (metadata.bitsPerSample / 8)
  const blockAlign = metadata.channels * (metadata.bitsPerSample / 8)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcmSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(metadata.channels, 22)
  header.writeUInt32LE(metadata.sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(metadata.bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcmSize, 40)

  return header
}

async function readRecordingArchiveMetadata(metaPath: string, sessionId: string): Promise<RecordingArchiveMetadata> {
  const raw = await fs.promises.readFile(metaPath, 'utf8')
  if (!raw.trim()) {
    throw new Error('Recording archive metadata is empty')
  }
  const parsed = JSON.parse(raw) as Partial<RecordingArchiveMetadata>
  return {
    sessionId,
    sampleRate: typeof parsed.sampleRate === 'number' && parsed.sampleRate > 0 ? parsed.sampleRate : DEFAULT_RECORDING_ARCHIVE_FORMAT.sampleRate,
    channels: typeof parsed.channels === 'number' && parsed.channels > 0 ? parsed.channels : DEFAULT_RECORDING_ARCHIVE_FORMAT.channels,
    bitsPerSample: typeof parsed.bitsPerSample === 'number' && parsed.bitsPerSample > 0 ? parsed.bitsPerSample : DEFAULT_RECORDING_ARCHIVE_FORMAT.bitsPerSample,
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
  }
}

function getDefaultRecordingArchiveMetadata(sessionId: string): RecordingArchiveMetadata {
  const now = Date.now()
  return {
    sessionId,
    ...DEFAULT_RECORDING_ARCHIVE_FORMAT,
    createdAt: now,
    updatedAt: now,
  }
}

async function readRecordingArchiveMetadataWithFallback(metaPath: string, sessionId: string): Promise<RecordingArchiveMetadata> {
  try {
    return await readRecordingArchiveMetadata(metaPath, sessionId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[RecordingArchive] metadata unavailable for ${sessionId}; using default PCM format: ${message}`)
    return getDefaultRecordingArchiveMetadata(sessionId)
  }
}

async function writeBufferDurably(filePath: string, data: Buffer): Promise<void> {
  const handle = await fs.promises.open(filePath, 'w')
  try {
    if (data.byteLength > 0) {
      await handle.write(data, 0, data.byteLength, 0)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeTextDurably(filePath: string, text: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.writing`
  try {
    await writeBufferDurably(tempPath, Buffer.from(text, 'utf8'))
    await fs.promises.rename(tempPath, filePath)
    await syncFile(filePath)
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function appendBufferDurably(filePath: string, data: Buffer): Promise<void> {
  const handle = await fs.promises.open(filePath, 'a')
  try {
    if (data.byteLength > 0) {
      await handle.write(data, 0, data.byteLength)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeStreamToFile(sourcePath: string, targetPath: string, header: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(targetPath)
    const input = fs.createReadStream(sourcePath)

    const cleanup = (error?: Error) => {
      input.destroy()
      output.destroy()
      if (error) reject(error)
    }

    output.on('error', cleanup)
    input.on('error', cleanup)
    output.on('finish', resolve)
    output.write(header)
    input.pipe(output, { end: true })
  })
}

async function finalizePcmRecordingArchive(sessionIdValue: string, fileNameValue = 'source-audio.wav'): Promise<RecordingArchiveSaveResult> {
  const paths = getRecordingArchivePaths(sessionIdValue, fileNameValue)
  assertArchivePathAllowed(paths.archivePath)
  assertArchivePathAllowed(paths.tempArchivePath)
  assertArchivePathAllowed(paths.pcmPath)
  assertArchivePathAllowed(paths.metaPath)

  const metadata = await readRecordingArchiveMetadataWithFallback(paths.metaPath, paths.sessionId)
  const stat = await fs.promises.stat(paths.pcmPath)
  if (stat.size <= 0) {
    throw new Error('Recording archive has no audio data')
  }

  await fs.promises.mkdir(paths.archiveDir, { recursive: true })
  const header = buildWavHeader(stat.size, metadata)
  await writeStreamToFile(paths.pcmPath, paths.tempArchivePath, header)
  await syncFile(paths.tempArchivePath)
  await fs.promises.rename(paths.tempArchivePath, paths.archivePath)
  await syncFile(paths.archivePath)
  await fs.promises.rm(paths.pcmPath, { force: true })
  await fs.promises.rm(paths.metaPath, { force: true })

  const finalStat = await fs.promises.stat(paths.archivePath)
  return {
    ok: true,
    sessionId: paths.sessionId,
    path: paths.archivePath,
    size: finalStat.size,
    mimeType: 'audio/wav',
    fileName: paths.fileName,
  }
}

function clearWindowsAutoLaunchEntries(): void {
  if (process.platform !== 'win32') return

  const settings = app.getLoginItemSettings()
  const launchItems = settings.launchItems || []

  for (const item of launchItems) {
    if (!item.enabled) continue
    try {
      app.setLoginItemSettings({
        openAtLogin: false,
        path: item.path,
        args: item.args,
      })
    } catch (error) {
      console.warn('[AutoLaunch] 清理启动项失败:', item.path, item.args, error)
    }
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: false,
      path: process.execPath,
      args: [],
    })
  } catch (error) {
    console.warn('[AutoLaunch] 清理当前进程启动项失败:', error)
  }
}

export function registerAppIpc(options: RegisterAppIpcOptions): void {
  options.ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  options.ipcMain.handle('minimize-to-tray', () => {
    if (options.isTrayReady()) {
      options.hideMainWindow()
      if (process.platform === 'darwin') {
        app.dock?.hide()
      }
      return
    }

    options.minimizeMainWindow()
  })

  options.ipcMain.handle('window-minimize', (_event, source?: string) => {
    options.onWindowMinimize?.(source)
    options.minimizeMainWindow()
  })

  options.ipcMain.handle('window-maximize', () => {
    if (options.isMainWindowMaximized()) {
      options.unmaximizeMainWindow()
    } else {
      options.maximizeMainWindow()
    }
  })

  options.ipcMain.handle('window-close', () => {
    options.onWindowClose?.()
    options.closeMainWindow()
  })

  options.ipcMain.handle('window-is-maximized', () => {
    return options.isMainWindowMaximized()
  })

  options.ipcMain.handle('get-auto-launch', () => {
    return getAutoLaunchEnabled()
  })

  options.ipcMain.handle('set-auto-launch', (event, enable: boolean) => {
    assertTrustedSender(event, 'set-auto-launch')
    if (!isAutoLaunchSupported()) {
      return false
    }

    try {
      if (enable) {
        app.setLoginItemSettings({
          openAtLogin: true,
          ...(process.platform === 'darwin' ? { openAsHidden: true } : {}),
        })
      } else {
        app.setLoginItemSettings({
          openAtLogin: false,
        })
        clearWindowsAutoLaunchEntries()
      }
    } catch (error) {
      console.error('[AutoLaunch] 设置开机启动失败:', error)
    }

    return getAutoLaunchEnabled()
  })

  options.ipcMain.handle('pick-file-path', async (event, dialogOptions?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => {
    assertTrustedSender(event, 'pick-file-path')
    const openDialogOptions = {
      title: dialogOptions?.title,
      properties: ['openFile'] as Electron.OpenDialogOptions['properties'],
      filters: dialogOptions?.filters,
    }
    const mainWindow = options.getMainWindow()
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openDialogOptions)
      : await dialog.showOpenDialog(openDialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  options.ipcMain.handle('path-exists', (event, targetPath: string) => {
    assertTrustedSender(event, 'path-exists')
    if (!targetPath || !targetPath.trim()) {
      return false
    }
    if (!isPathAllowed(targetPath)) {
      console.warn(`[IPC Security] path-exists blocked for: ${targetPath}`)
      return false
    }

    try {
      return fs.existsSync(targetPath)
    } catch {
      return false
    }
  })

  options.ipcMain.handle('save-recording-archive', async (event, request: RecordingArchiveSaveRequest) => {
    assertTrustedSender(event, 'save-recording-archive')
    try {
      const paths = getRecordingArchivePaths(request.sessionId, request.fileName)

      assertArchivePathAllowed(paths.archivePath)

      await fs.promises.mkdir(paths.archiveDir, { recursive: true })
      const data = Buffer.from(new Uint8Array(request.data))
      await fs.promises.writeFile(paths.archivePath, data)

      return {
        ok: true,
        sessionId: paths.sessionId,
        path: paths.archivePath,
        size: data.byteLength,
        mimeType: request.mimeType,
        fileName: paths.fileName,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] save failed:', message)
      return { ok: false, error: message }
    }
  })

  options.ipcMain.handle('begin-recording-archive', async (event, request: RecordingArchiveBeginRequest) => {
    assertTrustedSender(event, 'begin-recording-archive')
    try {
      const paths = getRecordingArchivePaths(request.sessionId)
      assertArchivePathAllowed(paths.archiveDir)
      assertArchivePathAllowed(paths.pcmPath)
      assertArchivePathAllowed(paths.metaPath)

      await fs.promises.mkdir(paths.archiveDir, { recursive: true })
      await writeBufferDurably(paths.pcmPath, Buffer.alloc(0))
      const now = Date.now()
      const metadata: RecordingArchiveMetadata = {
        sessionId: paths.sessionId,
        ...normalizePcmFormat(request),
        createdAt: now,
        updatedAt: now,
      }
      await writeTextDurably(paths.metaPath, JSON.stringify(metadata, null, 2))

      return {
        ok: true,
        sessionId: paths.sessionId,
        path: paths.pcmPath,
        size: 0,
        mimeType: 'audio/pcm',
        fileName: path.basename(paths.pcmPath),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] begin failed:', message)
      return { ok: false, error: message }
    }
  })

  options.ipcMain.handle('append-recording-archive', async (event, request: RecordingArchiveAppendRequest) => {
    assertTrustedSender(event, 'append-recording-archive')
    try {
      const paths = getRecordingArchivePaths(request.sessionId)
      assertArchivePathAllowed(paths.pcmPath)
      assertArchivePathAllowed(paths.metaPath)

      const data = Buffer.from(new Uint8Array(request.data))
      if (data.byteLength === 0) {
        const stat = await fs.promises.stat(paths.pcmPath)
        return { ok: true, sessionId: paths.sessionId, path: paths.pcmPath, size: stat.size, mimeType: 'audio/pcm', fileName: path.basename(paths.pcmPath) }
      }

      await appendBufferDurably(paths.pcmPath, data)
      const stat = await fs.promises.stat(paths.pcmPath)
      return { ok: true, sessionId: paths.sessionId, path: paths.pcmPath, size: stat.size, mimeType: 'audio/pcm', fileName: path.basename(paths.pcmPath) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] append failed:', message)
      return { ok: false, error: message }
    }
  })

  options.ipcMain.handle('finalize-recording-archive', async (event, request: RecordingArchiveFinalizeRequest) => {
    assertTrustedSender(event, 'finalize-recording-archive')
    try {
      return await finalizePcmRecordingArchive(request.sessionId, request.fileName || 'source-audio.wav')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] finalize failed:', message)
      return { ok: false, error: message }
    }
  })

  options.ipcMain.handle('recover-recording-archives', async (event) => {
    assertTrustedSender(event, 'recover-recording-archives')
    try {
      const mediaDir = path.join(app.getPath('userData'), 'media')
      assertArchivePathAllowed(mediaDir)
      if (!fs.existsSync(mediaDir)) {
        return { ok: true, recovered: [] }
      }

      const recovered: RecordingArchiveSaveResult[] = []
      const skipped: Array<{ sessionId: string; reason: 'missing-pcm' | 'missing-metadata' | 'empty-audio' | 'finalize-failed'; error?: string }> = []
      const entries = await fs.promises.readdir(mediaDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const paths = getRecordingArchivePaths(entry.name, 'source-audio.wav')
        const hasPcm = fs.existsSync(paths.pcmPath)
        const hasMeta = fs.existsSync(paths.metaPath)
        if (!hasPcm && !hasMeta) continue
        if (!hasPcm) {
          skipped.push({ sessionId: paths.sessionId, reason: 'missing-pcm' })
          continue
        }
        try {
          const result = await finalizePcmRecordingArchive(entry.name, 'source-audio.wav')
          if (result.ok) recovered.push({ ...result, fileName: result.fileName || 'source-audio.wav' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          skipped.push({
            sessionId: paths.sessionId,
            reason: message.includes('no audio data') ? 'empty-audio' : 'finalize-failed',
            error: message,
          })
          console.warn('[RecordingArchive] recover skipped:', entry.name, error)
        }
      }

      return { ok: true, recovered, skipped }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] recover failed:', message)
      return { ok: false, recovered: [], error: message }
    }
  })

  options.ipcMain.handle('reveal-recording-archive', (event, targetPath: string) => {
    assertTrustedSender(event, 'reveal-recording-archive')
    try {
      if (!targetPath || !isPathAllowed(targetPath) || !fs.existsSync(targetPath)) {
        throw new Error('Recording archive path is unavailable')
      }
      shell.showItemInFolder(targetPath)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] reveal failed:', message)
      return { ok: false, error: message }
    }
  })
}
