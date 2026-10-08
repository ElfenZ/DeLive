import { app, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import type {
  MediaArchivedAudio,
  MediaExtractAudioRequest,
  MediaExtractionProgress,
  MediaOperationResult,
  MediaProcessingErrorCode,
  MediaReadAudioResult,
} from '../shared/electronApi'
import { assertMainWindowSender } from './ipcSecurity'
import { getFileStorageService } from './fileStorage'
import { FileStorageError, inspectRegularFile } from './fileStorageService'
import { isSafeStorageId } from '../shared/fileStorage'

const ARCHIVE_FILE_NAME = 'source-audio.mp3'
const MAX_PROCESS_OUTPUT_LENGTH = 256 * 1024

interface RegisterMediaIpcOptions {
  ipcMain: IpcMain
  getMainWindow: () => BrowserWindow | null
}

export interface MediaIpcController {
  dispose: () => void
  ready: Promise<void>
}

interface ExtractionEntry {
  request: MediaExtractAudioRequest
  event: IpcMainInvokeEvent
  controller: AbortController
  resolve: (result: MediaOperationResult) => void
  leaseToken: string
}

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

class MediaProcessingError extends Error {
  constructor(
    public readonly code: MediaProcessingErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MediaProcessingError'
  }
}

function validateIdentifier(value: string, label: string): string {
  if (!isSafeStorageId(value)) {
    throw new MediaProcessingError('MEDIA_SOURCE_INVALID', `Invalid ${label}`)
  }
  return value
}

async function getArchivePaths(sessionIdValue: string) {
  const sessionId = validateIdentifier(sessionIdValue, 'media session id')
  const service = getFileStorageService()
  const mediaRoot = (await service.getConfiguration()).mediaRoot
  const archiveDir = await service.sessionDirectory(sessionId, true)
  return {
    sessionId,
    mediaRoot,
    archiveDir,
    archivePath: path.join(archiveDir, ARCHIVE_FILE_NAME),
  }
}

async function ensureArchiveDirectory(sessionId: string): Promise<Awaited<ReturnType<typeof getArchivePaths>>> {
  const paths = await getArchivePaths(sessionId)
  return paths
}

async function assertRegularFile(filePath: string, code: MediaProcessingErrorCode, message: string): Promise<fs.Stats> {
  try {
    const stat = await fs.promises.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message)
    return stat
  } catch {
    throw new MediaProcessingError(code, message)
  }
}

function resolveFfmpegPath(): string {
  const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  if (typeof process.resourcesPath === 'string') {
    const packagedPath = path.join(process.resourcesPath, 'ffmpeg', executableName)
    if (fs.existsSync(packagedPath)) return packagedPath
  }

  const osName = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform
  const stagedPath = path.join(app.getAppPath(), 'local-runtimes', 'ffmpeg', `${osName}-${process.arch}`, executableName)
  if (fs.existsSync(stagedPath)) return stagedPath

  try {
    const developmentPath = require('ffmpeg-static') as string | null
    if (developmentPath && fs.existsSync(developmentPath)) return developmentPath
  } catch {
    // The packaged resource check above is the supported release path.
  }

  throw new MediaProcessingError(
    'MEDIA_TOOLS_UNAVAILABLE',
    'The bundled FFmpeg tool is unavailable for this platform and architecture.',
  )
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  return next.length > MAX_PROCESS_OUTPUT_LENGTH ? next.slice(-MAX_PROCESS_OUTPUT_LENGTH) : next
}

function runProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  onStdout?: (chunk: Buffer) => void,
  onChild?: (child: ChildProcess | null) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new MediaProcessingError('MEDIA_EXTRACTION_CANCELLED', 'Media extraction was cancelled.'))
      return
    }

    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    onChild?.(child)
    let stdout = ''
    let stderr = ''
    let settled = false

    const abort = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    signal.addEventListener('abort', abort, { once: true })

    child.stdout!.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk)
      onStdout?.(chunk)
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      onChild?.(null)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      onChild?.(null)
      if (signal.aborted) {
        reject(new MediaProcessingError('MEDIA_EXTRACTION_CANCELLED', 'Media extraction was cancelled.'))
        return
      }
      resolve({ code, stdout, stderr })
    })
  })
}

function parseDurationMs(output: string): number | undefined {
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i)
  if (!match) return undefined
  const durationMs = ((Number(match[1]) * 60 * 60) + (Number(match[2]) * 60) + Number(match[3])) * 1000
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined
}

function parseTimestampMs(value: string): number {
  const match = value.trim().match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return 0
  return ((Number(match[1]) * 60 * 60) + (Number(match[2]) * 60) + Number(match[3])) * 1000
}

async function probeAudioStream(ffmpegPath: string, sourcePath: string, signal: AbortSignal): Promise<number | undefined> {
  const result = await runProcess(ffmpegPath, [
    '-hide_banner',
    '-nostdin',
    '-i', sourcePath,
    '-map', '0:a:0',
    '-frames:a', '1',
    '-f', 'null',
    process.platform === 'win32' ? 'NUL' : '/dev/null',
  ], signal)

  if (result.code !== 0) {
    const noAudio = /matches no streams|does not contain any stream|stream map.*no streams|audio.*not found/i.test(result.stderr)
    throw new MediaProcessingError(
      noAudio ? 'MEDIA_NO_AUDIO' : 'MEDIA_EXTRACTION_FAILED',
      noAudio ? 'The selected video does not contain a decodable audio track.' : 'The selected file could not be decoded by FFmpeg.',
    )
  }
  return parseDurationMs(result.stderr)
}

async function getArchivedAudio(sessionId: string): Promise<MediaArchivedAudio> {
  return getFileStorageService().resolveAsset(sessionId, 'extracted-audio')
}

async function extractAudio(
  request: MediaExtractAudioRequest,
  signal: AbortSignal,
  onProgress: (progress: MediaExtractionProgress) => void,
  onChild: (child: ChildProcess | null) => void,
): Promise<MediaArchivedAudio> {
  validateIdentifier(request.taskId, 'media task id')
  const paths = await ensureArchiveDirectory(request.sessionId)

  try {
    return await getArchivedAudio(request.sessionId)
  } catch (error) {
    if ((error as { code?: string }).code !== 'FILE_STORAGE_MISSING' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (typeof request.sourcePath !== 'string' || !path.isAbsolute(request.sourcePath)) {
    throw new MediaProcessingError('MEDIA_SOURCE_INVALID', 'The selected video path is invalid.')
  }
  await assertRegularFile(request.sourcePath, 'MEDIA_SOURCE_INVALID', 'The selected video is not a regular local file.')
  const ffmpegPath = resolveFfmpegPath()
  await assertRegularFile(ffmpegPath, 'MEDIA_TOOLS_UNAVAILABLE', 'The bundled FFmpeg tool is unavailable.')

  const durationMs = await probeAudioStream(ffmpegPath, request.sourcePath, signal)
  const tempPath = path.join(paths.archiveDir, `source-audio.${request.taskId}.${Date.now()}.tmp.mp3`)
  let progressBuffer = ''

  try {
    const result = await runProcess(ffmpegPath, [
      '-hide_banner',
      '-nostdin',
      '-v', 'error',
      '-i', request.sourcePath,
      '-map', '0:a:0',
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libmp3lame',
      '-b:a', '64k',
      '-n',
      '-progress', 'pipe:1',
      '-nostats',
      tempPath,
    ], signal, (chunk) => {
      progressBuffer += chunk.toString('utf8')
      const lines = progressBuffer.split(/\r?\n/)
      progressBuffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('out_time=')) continue
        const processedMs = parseTimestampMs(line.slice('out_time='.length))
        const progress = durationMs ? Math.min(99, Math.max(0, Math.round((processedMs / durationMs) * 100))) : 0
        onProgress({ taskId: request.taskId, sessionId: paths.sessionId, progress, processedMs, durationMs })
      }
    }, onChild)

    if (result.code !== 0) {
      throw new MediaProcessingError('MEDIA_EXTRACTION_FAILED', 'FFmpeg could not extract the audio track.')
    }
    const stat = await assertRegularFile(tempPath, 'MEDIA_EXTRACTION_FAILED', 'FFmpeg did not create an audio file.')
    if (stat.size <= 0) throw new MediaProcessingError('MEDIA_EXTRACTION_FAILED', 'FFmpeg created an empty audio file.')

    const audio = await getFileStorageService().publishAsset(paths.sessionId, 'extracted-audio', path.basename(tempPath), ARCHIVE_FILE_NAME)
    onProgress({ taskId: request.taskId, sessionId: paths.sessionId, progress: 100, processedMs: durationMs || 0, durationMs })
    return { ...audio, durationMs }
  } finally {
    if (!await getFileStorageService().isPendingStage(paths.sessionId, path.basename(tempPath))) await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
  }
}

function toResult(error: unknown): MediaOperationResult {
  if (error instanceof FileStorageError) {
    const code: MediaProcessingErrorCode = error.code === 'FILE_STORAGE_MISSING' ? 'MEDIA_AUDIO_MISSING'
      : error.code === 'FILE_STORAGE_BUSY' ? 'MEDIA_FILE_BUSY' : error.code === 'FILE_STORAGE_CONFLICT' || error.code === 'FILE_STORAGE_CORRUPT' ? 'MEDIA_FILE_CONFLICT'
        : error.code === 'FILE_STORAGE_INVALID' ? 'MEDIA_SOURCE_INVALID' : 'MEDIA_ROOT_UNAVAILABLE'
    return { ok: false, code, error: error.message }
  }
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, code: 'MEDIA_AUDIO_MISSING', error: 'Managed audio is unavailable' }
  if (error instanceof MediaProcessingError) {
    return { ok: false, code: error.code, error: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'MEDIA_EXTRACTION_FAILED', error: message }
}

async function cleanupStaleExtractionFiles(): Promise<void> {
  const service = getFileStorageService()
  await service.recoverPublications()
  await service.recoverMigrations()
  try {
    const entries = await service.managedSessionDirectories()
    await Promise.all(entries.map(async (entry) => {
      await service.withSessionLock(entry.sessionId, async () => {
      const archiveDir = entry.directory
      const files = await fs.promises.readdir(archiveDir, { withFileTypes: true }).catch(() => [])
      await Promise.all(files
        .filter(file => file.isFile() && /^source-audio\..+\.tmp\.mp3$/.test(file.name))
        .map(async (file) => {
          if (!await service.isPendingStage(entry.sessionId, file.name)) { await inspectRegularFile(path.join(archiveDir, file.name)); await fs.promises.rm(path.join(archiveDir, file.name), { force: true }) }
        }))
      }).catch((error: unknown) => { if ((error as FileStorageError).code !== 'FILE_STORAGE_BUSY') throw error })
    }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[MediaProcessing] Failed to clean stale extraction files:', error)
    }
  }
}

export function registerMediaIpc(options: RegisterMediaIpcOptions): MediaIpcController {
  const queue: ExtractionEntry[] = []
  const controllers = new Map<string, AbortController>()
  const activeChildren = new Map<string, ChildProcess>()
  let active = false
  const cleanupReady = cleanupStaleExtractionFiles().catch((error: unknown) => {
    console.warn('[MediaProcessing] Storage recovery unavailable:', error)
  })

  const runNext = () => {
    if (active) return
    const entry = queue.shift()
    if (!entry) return
    active = true
    const { request, event, controller } = entry
    const service = getFileStorageService()
    void cleanupReady.then(async () => {
      await service.recoverPublications(request.sessionId, entry.leaseToken)
      return service.withSessionLock(request.sessionId, () => extractAudio(
        request,
        controller.signal,
        progress => {
          if (!event.sender.isDestroyed()) event.sender.send('media-extraction-progress', progress)
        },
        child => {
          if (child) activeChildren.set(request.taskId, child)
          else activeChildren.delete(request.taskId)
        },
      ), entry.leaseToken)
    })
      .then(audio => entry.resolve({ ok: true, audio }))
      .catch(error => entry.resolve(toResult(error)))
      .finally(() => {
        service.releaseUsage(entry.leaseToken)
        controllers.delete(request.taskId)
        activeChildren.delete(request.taskId)
        active = false
        runNext()
      })
  }

  options.ipcMain.handle('extract-media-audio', (event, request: MediaExtractAudioRequest) => {
    assertMainWindowSender(event, 'extract-media-audio', options.getMainWindow)
    validateIdentifier(request?.taskId, 'media task id')
    validateIdentifier(request?.sessionId, 'media session id')
    if (controllers.has(request.taskId)) {
      return Promise.resolve<MediaOperationResult>({
        ok: false,
        code: 'MEDIA_EXTRACTION_FAILED',
        error: 'This media extraction task is already running.',
      })
    }
    const controller = new AbortController()
    let leaseToken: string
    try { leaseToken = getFileStorageService().acquireUsage(request.sessionId, 'extracting') }
    catch (error) { return Promise.resolve(toResult(error)) }
    controllers.set(request.taskId, controller)
    return new Promise<MediaOperationResult>((resolve) => {
      queue.push({ request, event, controller, resolve, leaseToken })
      runNext()
    })
  })

  options.ipcMain.handle('cancel-media-extraction', (event, taskId: string) => {
    assertMainWindowSender(event, 'cancel-media-extraction', options.getMainWindow)
    validateIdentifier(taskId, 'media task id')
    const controller = controllers.get(taskId)
    if (!controller) return false
    controller.abort()
    activeChildren.get(taskId)?.kill('SIGTERM')
    return true
  })

  options.ipcMain.handle('get-media-audio', async (event, sessionId: string): Promise<MediaOperationResult> => {
    assertMainWindowSender(event, 'get-media-audio', options.getMainWindow)
    try {
      validateIdentifier(sessionId, 'media session id')
      const service = getFileStorageService()
      return { ok: true, audio: await service.withSessionLock(sessionId, () => service.resolveAsset(sessionId)) }
    } catch (error) {
      return toResult(error)
    }
  })

  options.ipcMain.handle('list-media-audio', async (event) => {
    assertMainWindowSender(event, 'list-media-audio', options.getMainWindow)
    try {
      const result = await getFileStorageService().listAssets()
      return { ok: true, ...result }
    } catch (error) {
      return toResult(error)
    }
  })

  options.ipcMain.handle('read-media-audio', async (event, sessionId: string): Promise<MediaReadAudioResult> => {
    assertMainWindowSender(event, 'read-media-audio', options.getMainWindow)
    try {
      validateIdentifier(sessionId, 'media session id')
      const { audio, data: buffer } = await getFileStorageService().readAsset(sessionId)
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      return { ok: true, audio, data }
    } catch (error) {
      return toResult(error)
    }
  })

  options.ipcMain.handle('reveal-media-audio', async (event, sessionId: string): Promise<MediaOperationResult> => {
    assertMainWindowSender(event, 'reveal-media-audio', options.getMainWindow)
    try {
      validateIdentifier(sessionId, 'media session id')
      const service = getFileStorageService()
      const audio = await service.withSessionLock(sessionId, async () => {
        const asset = await service.resolveAsset(sessionId)
        shell.showItemInFolder(asset.path)
        return asset
      })
      return { ok: true, audio }
    } catch (error) {
      return toResult(error)
    }
  })

  options.ipcMain.handle('delete-media-audio', async (event, sessionId: string): Promise<MediaOperationResult> => {
    assertMainWindowSender(event, 'delete-media-audio', options.getMainWindow)
    try {
      validateIdentifier(sessionId, 'media session id')
      await getFileStorageService().deleteAsset(sessionId)
      return { ok: true }
    } catch (error) {
      return toResult(error)
    }
  })

  return {
    ready: cleanupReady,
    dispose: () => {
      for (const controller of controllers.values()) controller.abort()
      for (const child of activeChildren.values()) child.kill('SIGTERM')
      queue.splice(0).forEach(entry => {
        getFileStorageService().releaseUsage(entry.leaseToken)
        entry.resolve({
        ok: false,
        code: 'MEDIA_EXTRACTION_CANCELLED',
        error: 'Media extraction was cancelled because the application is closing.',
        })
      })
    },
  }
}
