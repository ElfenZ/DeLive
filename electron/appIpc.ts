import { app, dialog, shell, type BrowserWindow, type IpcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { assertMainWindowSender, assertTrustedSender, isPathAllowed } from './ipcSecurity'
import { getFileStorageService } from './fileStorage'
import { assertStorageBasename, inspectRegularFile, fileIdentity, sameFileIdentity } from './fileStorageService'
import { isSafeStorageId } from '../shared/fileStorage'
import { getOriginalSourceService } from './originalSources'
import type {
  AutoExportFileRequest,
  RecordingArchiveAppendRequest,
  RecordingArchiveBeginRequest,
  RecordingArchiveFinalizeRequest,
  RecordingArchiveSaveRequest,
  RecordingArchiveSaveResult,
} from '../shared/electronApi'
import { validateRevealExportPath, writeAutoExportFile } from './autoExportFile'

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

interface RecordingArchiveMetadata {
  sessionId: string
  sampleRate: number
  channels: number
  bitsPerSample: number
  createdAt: number
  updatedAt: number
  finalizationStage?: string
}

const DEFAULT_RECORDING_ARCHIVE_FORMAT = {
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
} as const

async function getRecordingArchivePaths(sessionId: string, fileName = 'source-audio.wav', create = false) {
  if (!isSafeStorageId(sessionId)) throw new Error('Invalid recording session ID')
  assertStorageBasename(fileName)
  if (!/^source-audio\.(wav|m4a|webm|bin)$/.test(fileName)) throw new Error('Invalid recording audio filename')
  const archiveDir = await getFileStorageService().sessionDirectory(sessionId, create)
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

function normalizePcmFormat(request: RecordingArchiveBeginRequest): Pick<RecordingArchiveMetadata, 'sampleRate' | 'channels' | 'bitsPerSample'> {
  if (!Number.isInteger(request.sampleRate) || request.sampleRate < 8000 || request.sampleRate > 192000
    || !Number.isInteger(request.channels) || request.channels < 1 || request.channels > 8 || request.bitsPerSample !== 16) throw new Error('Invalid PCM recording format')
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

async function readRecordingArchiveMetadata(metaPath: string, sessionId: string) {
  if ((await fs.promises.lstat(metaPath)).size > 64 * 1024) throw new Error('Recording metadata is too large')
  const proof = await inspectRegularFile(metaPath)
  const raw = await fs.promises.readFile(metaPath, 'utf8')
  if (createHash('sha256').update(raw).digest('hex') !== proof.sha256) throw new Error('Recording metadata changed while reading')
  if (!raw.trim()) {
    throw new Error('Recording archive metadata is empty')
  }
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recording metadata must be an object')
  const parsed = value as Partial<RecordingArchiveMetadata>
  if (parsed.finalizationStage) {
    assertStorageBasename(parsed.finalizationStage)
    if (!/^source-audio\.[a-f0-9-]+\.tmp\.wav$/.test(parsed.finalizationStage)) throw new Error('Invalid metadata finalization stage')
  }
  if (parsed.sessionId !== sessionId || !Number.isInteger(parsed.sampleRate) || !parsed.sampleRate || parsed.sampleRate < 8000 || parsed.sampleRate > 192000
    || !Number.isInteger(parsed.channels) || !parsed.channels || parsed.channels > 8 || parsed.channels < 1 || parsed.bitsPerSample !== 16) {
    throw new Error('Recording PCM metadata is invalid; preserve recovery files and repair the format')
  }
  const metadata: RecordingArchiveMetadata = {
    sessionId,
    sampleRate: typeof parsed.sampleRate === 'number' && parsed.sampleRate > 0 ? parsed.sampleRate : DEFAULT_RECORDING_ARCHIVE_FORMAT.sampleRate,
    channels: typeof parsed.channels === 'number' && parsed.channels > 0 ? parsed.channels : DEFAULT_RECORDING_ARCHIVE_FORMAT.channels,
    bitsPerSample: typeof parsed.bitsPerSample === 'number' && parsed.bitsPerSample > 0 ? parsed.bitsPerSample : DEFAULT_RECORDING_ARCHIVE_FORMAT.bitsPerSample,
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    finalizationStage: parsed.finalizationStage,
  }
  return { metadata, proof }
}

async function writeBufferDurably(filePath: string, data: Buffer): Promise<void> {
  const handle = await fs.promises.open(filePath, 'wx')
  try {
    if (data.byteLength > 0) {
      await handle.writeFile(data)
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
  const before = await fs.promises.lstat(filePath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('PCM is not a regular file')
  const handle = await fs.promises.open(filePath, 'a')
  try {
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(await handle.stat({ bigint: true })))) throw new Error('PCM identity changed before append')
    if (data.byteLength > 0) {
      await handle.writeFile(data)
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
    const output = fs.createWriteStream(targetPath, { flags: 'wx' })
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
  if (fileNameValue !== 'source-audio.wav') throw new Error('PCM finalization requires WAV output')
  const paths = await getRecordingArchivePaths(sessionIdValue, fileNameValue)
  const metadataSnapshot = await readRecordingArchiveMetadata(paths.metaPath, paths.sessionId)
  let metadata = metadataSnapshot.metadata
  let metadataProof = metadataSnapshot.proof
  const verifyMetadata = async () => {
    const current = await inspectRegularFile(paths.metaPath)
    if (current.sha256 !== metadataProof.sha256 || !sameFileIdentity(current.identity, metadataProof.identity)) throw new Error('Recording metadata changed; recovery group retained')
  }
  const pcm = await inspectRegularFile(paths.pcmPath)
  const stat = pcm.identity
  if (stat.size <= 0) {
    throw new Error('Recording archive has no audio data')
  }
  if (stat.size % (metadata.channels * 2) !== 0 || stat.size > 0xffffffff - 36) throw new Error('PCM data is incomplete or exceeds WAV size limit; recovery data retained')

  const header = buildWavHeader(stat.size, metadata)
  const expectedHash = createHash('sha256').update(header)
  for await (const chunk of fs.createReadStream(paths.pcmPath)) expectedHash.update(chunk as Buffer)
  if ((await inspectRegularFile(paths.pcmPath)).sha256 !== pcm.sha256) throw new Error('PCM changed while finalizing')
  const digest = expectedHash.digest('hex')
  const service = getFileStorageService()
  let audio
  try { audio = await service.resolveAsset(paths.sessionId, 'recording-audio') }
  catch (error) {
    if ((error as { code?: string }).code !== 'FILE_STORAGE_MISSING' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!audio) {
    if (!metadata.finalizationStage) {
      metadata = { ...metadata, finalizationStage: `source-audio.${randomUUID()}.tmp.wav` }
      await verifyMetadata()
      await writeTextDurably(paths.metaPath, JSON.stringify(metadata))
      metadataProof = await inspectRegularFile(paths.metaPath)
    }
    let stagePath = path.join(paths.archiveDir, metadata.finalizationStage!)
    try { await inspectRegularFile(stagePath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await writeStreamToFile(paths.pcmPath, stagePath, header)
    }
    if ((await inspectRegularFile(stagePath)).sha256 !== digest) {
      // A crash can leave a partial stage. Preserve it and rebuild into a fresh exclusive name.
      metadata = { ...metadata, finalizationStage: `source-audio.${randomUUID()}.tmp.wav` }
      await verifyMetadata()
      await writeTextDurably(paths.metaPath, JSON.stringify(metadata))
      metadataProof = await inspectRegularFile(paths.metaPath)
      stagePath = path.join(paths.archiveDir, metadata.finalizationStage!)
      await writeStreamToFile(paths.pcmPath, stagePath, header)
      if ((await inspectRegularFile(stagePath)).sha256 !== digest) throw new Error('PCM changed during WAV rebuild; recovery data retained')
    }
    await syncFile(stagePath)
    audio = await service.publishAsset(paths.sessionId, 'recording-audio', path.basename(stagePath), paths.fileName)
  }
  if (audio.sha256 !== digest) throw new Error('Existing WAV does not match PCM recovery group; no file was overwritten')
  if ((await inspectRegularFile(paths.pcmPath)).sha256 !== pcm.sha256) throw new Error('PCM changed after publication; recovery group retained')
  await verifyMetadata()
  await fs.promises.rm(paths.pcmPath, { force: true })
  await fs.promises.rm(paths.metaPath, { force: true })

  return {
    ok: true,
    sessionId: paths.sessionId,
    path: audio.path,
    size: audio.size,
    mimeType: 'audio/wav',
    fileName: audio.fileName,
    managedAsset: { sessionId: audio.sessionId, assetKind: audio.assetKind, revision: audio.revision },
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
  const activeRecordingArchives = new Map<string, string>()
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

    getOriginalSourceService().rememberSelection(result.filePaths[0], event.sender.id)
    return result.filePaths[0]
  })

  options.ipcMain.handle('pick-directory-path', async (event) => {
    assertTrustedSender(event, 'pick-directory-path')
    const openDialogOptions: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    }
    const mainWindow = options.getMainWindow()
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openDialogOptions)
      : await dialog.showOpenDialog(openDialogOptions)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  options.ipcMain.handle('write-auto-export-file', async (event, request: AutoExportFileRequest) => {
    assertTrustedSender(event, 'write-auto-export-file')
    return writeAutoExportFile(request)
  })

  options.ipcMain.handle('reveal-exported-file', async (event, targetPath: string) => {
    assertTrustedSender(event, 'reveal-exported-file')
    try {
      await validateRevealExportPath(targetPath)
      shell.showItemInFolder(targetPath)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
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
    assertMainWindowSender(event, 'save-recording-archive', options.getMainWindow)
    const service = getFileStorageService()
    let token: string | undefined
    try {
      token = service.acquireUsage(request.sessionId, 'recording-save')
      return await service.withSessionLock(request.sessionId, async () => {
      const paths = await getRecordingArchivePaths(request.sessionId, request.fileName, true)
      const data = Buffer.from(new Uint8Array(request.data))
      const stageName = `source-audio.${randomUUID()}.tmp${path.extname(paths.fileName)}`
      await writeBufferDurably(path.join(paths.archiveDir, stageName), data)
      const audio = await service.publishAsset(paths.sessionId, 'recording-audio', stageName, paths.fileName)

      return {
        ok: true,
        sessionId: paths.sessionId,
        path: audio.path,
        size: audio.size,
        mimeType: audio.mimeType,
        fileName: paths.fileName,
        managedAsset: { sessionId: audio.sessionId, assetKind: audio.assetKind, revision: audio.revision },
      }
      }, token)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] save failed:', message)
      return { ok: false, error: message }
    } finally { if (token) service.releaseUsage(token) }
  })

  options.ipcMain.handle('begin-recording-archive', async (event, request: RecordingArchiveBeginRequest) => {
    assertMainWindowSender(event, 'begin-recording-archive', options.getMainWindow)
    const service = getFileStorageService()
    let token = activeRecordingArchives.get(request.sessionId)
    let newlyAcquired = false
    try {
      const format = normalizePcmFormat(request)
      if (!token) { token = service.acquireUsage(request.sessionId, 'recording'); newlyAcquired = true }
      return await service.withSessionLock(request.sessionId, async () => {
      const paths = await getRecordingArchivePaths(request.sessionId, 'source-audio.wav', true)
      if (activeRecordingArchives.has(paths.sessionId)) {
        const stat = await fs.promises.lstat(paths.pcmPath)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PCM is not a regular file')
        return {
          ok: true,
          sessionId: paths.sessionId,
          path: paths.pcmPath,
          size: stat.size,
          mimeType: 'audio/pcm',
          fileName: path.basename(paths.pcmPath),
        }
      }
      let completed
      try { completed = await service.resolveAsset(request.sessionId, 'recording-audio') }
      catch (error) {
        if ((error as { code?: string }).code !== 'FILE_STORAGE_MISSING' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (completed) throw new Error('Completed audio already belongs to this record; start a new recording')
      if (fs.existsSync(paths.pcmPath) || fs.existsSync(paths.metaPath)) throw new Error('Unfinished PCM recovery group exists; recover it before starting')
      await writeBufferDurably(paths.pcmPath, Buffer.alloc(0))
      const now = Date.now()
      const metadata: RecordingArchiveMetadata = {
        sessionId: paths.sessionId,
        ...format,
        createdAt: now,
        updatedAt: now,
      }
      await writeTextDurably(paths.metaPath, JSON.stringify(metadata, null, 2))
      activeRecordingArchives.set(paths.sessionId, token!)

      return {
        ok: true,
        sessionId: paths.sessionId,
        path: paths.pcmPath,
        size: 0,
        mimeType: 'audio/pcm',
        fileName: path.basename(paths.pcmPath),
      }
      }, token)
    } catch (error) {
      if (newlyAcquired && token) service.releaseUsage(token)
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] begin failed:', message)
      return { ok: false, error: message }
    }
  })

  options.ipcMain.handle('append-recording-archive', async (event, request: RecordingArchiveAppendRequest) => {
    assertMainWindowSender(event, 'append-recording-archive', options.getMainWindow)
    try {
      if (!activeRecordingArchives.has(request.sessionId)) {
        throw new Error('Recording archive is not active')
      }
      const token = activeRecordingArchives.get(request.sessionId)!
      return await getFileStorageService().withSessionLock(request.sessionId, async () => {
      const paths = await getRecordingArchivePaths(request.sessionId)

      const data = Buffer.from(new Uint8Array(request.data))
      if (data.byteLength === 0) {
        const stat = await fs.promises.lstat(paths.pcmPath)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PCM is not a regular file')
        return { ok: true, sessionId: paths.sessionId, path: paths.pcmPath, size: stat.size, mimeType: 'audio/pcm', fileName: path.basename(paths.pcmPath) }
      }

      await appendBufferDurably(paths.pcmPath, data)
      const stat = await fs.promises.stat(paths.pcmPath)
      return { ok: true, sessionId: paths.sessionId, path: paths.pcmPath, size: stat.size, mimeType: 'audio/pcm', fileName: path.basename(paths.pcmPath) }
      }, token)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] append failed:', message)
      return { ok: false, error: message }
    }
  })

  options.ipcMain.handle('finalize-recording-archive', async (event, request: RecordingArchiveFinalizeRequest) => {
    assertMainWindowSender(event, 'finalize-recording-archive', options.getMainWindow)
    const service = getFileStorageService()
    let token = activeRecordingArchives.get(request.sessionId)
    try {
      if (!token) token = service.acquireUsage(request.sessionId, 'finalizing')
      await service.recoverPublications(request.sessionId, token)
      const result = await service.withSessionLock(request.sessionId, () => finalizePcmRecordingArchive(request.sessionId, request.fileName || 'source-audio.wav'), token)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] finalize failed:', message)
      return { ok: false, error: message }
    } finally { activeRecordingArchives.delete(request.sessionId); if (token) service.releaseUsage(token) }
  })

  options.ipcMain.handle('abort-recording-archive', async (event, request: { sessionId: string }) => {
    assertMainWindowSender(event, 'abort-recording-archive', options.getMainWindow)
    const service = getFileStorageService()
    let token = activeRecordingArchives.get(request.sessionId)
    try {
      if (!token) token = service.acquireUsage(request.sessionId, 'aborting')
      return await service.withSessionLock(request.sessionId, async () => {
      const paths = await getRecordingArchivePaths(request.sessionId)
      const pcm = await inspectRegularFile(paths.pcmPath)
      if (pcm.identity.size > 0) throw new Error('Recording contains audio; recovery files retained')
      await inspectRegularFile(paths.metaPath)
      await Promise.all([
        fs.promises.rm(paths.pcmPath, { force: true }),
        fs.promises.rm(paths.metaPath, { force: true }),
      ])
      return { ok: true }
      }, token)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] abort failed:', message)
      return { ok: false, error: message }
    } finally { activeRecordingArchives.delete(request.sessionId); if (token) service.releaseUsage(token) }
  })

  options.ipcMain.handle('recover-recording-archives', async (event, activeSessionIds?: string[]) => {
    assertMainWindowSender(event, 'recover-recording-archives', options.getMainWindow)
    try {
      const service = getFileStorageService()
      await service.recoverPublications()
      const acknowledged = new Set((await service.listRecordingRecoveryNotices(activeSessionIds)).filter((item) => item.acknowledged).map((item) => item.sessionId))
      let ignoredCount = 0
      const recovered: RecordingArchiveSaveResult[] = []
      const skipped: Array<{ sessionId: string; reason: 'missing-pcm' | 'missing-metadata' | 'invalid-metadata' | 'active-recording' | 'empty-audio' | 'finalize-failed'; error?: string }> = []
      const entries = (await service.managedSessionDirectories()).map((entry) => ({ name: entry.sessionId }))
      for (const entry of entries) {
        if (acknowledged.has(entry.name)) { ignoredCount++; continue }
        if (activeRecordingArchives.has(entry.name)) { skipped.push({ sessionId: entry.name, reason: 'active-recording' }); continue }
        const paths = await getRecordingArchivePaths(entry.name, 'source-audio.wav')
        const hasPcm = fs.existsSync(paths.pcmPath)
        const hasMeta = fs.existsSync(paths.metaPath)
        if (!hasPcm && !hasMeta) continue
        if (!hasPcm) {
          skipped.push({ sessionId: paths.sessionId, reason: 'missing-pcm' })
          continue
        }
        if (!hasMeta) { skipped.push({ sessionId: entry.name, reason: 'missing-metadata' }); continue }
        try {
          const result = await service.withSessionLock(entry.name, () => finalizePcmRecordingArchive(entry.name, 'source-audio.wav'))
          if (result.ok) recovered.push({ ...result, fileName: result.fileName || 'source-audio.wav' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          skipped.push({
            sessionId: paths.sessionId,
            reason: message.includes('no audio data') ? 'empty-audio' : /metadata|JSON/.test(message) ? 'invalid-metadata' : 'finalize-failed',
            error: message,
          })
          console.warn('[RecordingArchive] recover skipped:', entry.name, error)
        }
      }

      return { ok: true, recovered, skipped, ignoredCount, notices: await service.listRecordingRecoveryNotices(activeSessionIds) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] recover failed:', message)
      return { ok: false, recovered: [], error: message }
    }
  })

  options.ipcMain.handle('reveal-recording-archive', async (event, targetPath: string) => {
    assertMainWindowSender(event, 'reveal-recording-archive', options.getMainWindow)
    try {
      const service = getFileStorageService()
      if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) throw new Error('Recording archive path is unavailable')
      const root = (await service.managedRoots()).find((root) => {
        const parts = path.relative(root, targetPath).split(path.sep)
        return parts.length === 2 && isSafeStorageId(parts[0])
      })
      if (!root) throw new Error('Recording archive path is unavailable')
      const parts = path.relative(root, targetPath).split(path.sep)
      if (parts.length !== 2 || !isSafeStorageId(parts[0])) throw new Error('Recording archive path is unavailable')
      await service.withSessionLock(parts[0], async () => {
        const audio = await service.resolveAsset(parts[0], 'recording-audio')
        if (path.resolve(audio.path).toLowerCase() !== path.resolve(targetPath).toLowerCase()) throw new Error('Recording archive path does not match registration')
        shell.showItemInFolder(audio.path)
      })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RecordingArchive] reveal failed:', message)
      return { ok: false, error: message }
    }
  })
}
