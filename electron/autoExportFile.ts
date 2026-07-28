import fs from 'fs'
import path from 'path'
import type { AutoExportFileRequest, AutoExportFileResult } from '../shared/electronApi'

function assertSafeExportFileName(fileName: string): void {
  if (!fileName || fileName !== fileName.trim() || path.isAbsolute(fileName)
    || path.basename(fileName) !== fileName || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error('Export file name must be a safe basename')
  }
}

export async function writeAutoExportFile(
  request: AutoExportFileRequest,
): Promise<AutoExportFileResult> {
  try {
    const directory = request.directory?.trim()
    if (!directory || !path.isAbsolute(directory)) {
      throw new Error('Export directory must be an absolute path')
    }
    assertSafeExportFileName(request.fileName)
    if (typeof request.content !== 'string' || request.content.length === 0) {
      throw new Error('Export content is empty')
    }

    const stat = await fs.promises.stat(directory)
    if (!stat.isDirectory()) throw new Error('Export path is not a directory')

    const parsed = path.parse(request.fileName)
    for (let index = 0; index < 10_000; index += 1) {
      const candidateName = index === 0
        ? request.fileName
        : `${parsed.name} (${index})${parsed.ext}`
      const candidatePath = path.join(directory, candidateName)
      let handle: fs.promises.FileHandle | undefined
      try {
        handle = await fs.promises.open(candidatePath, 'wx')
        await handle.writeFile(request.content, 'utf8')
        await handle.close()
        return { ok: true, path: candidatePath }
      } catch (error) {
        await handle?.close().catch(() => undefined)
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        if (handle) await fs.promises.rm(candidatePath, { force: true }).catch(() => undefined)
        throw error
      }
    }
    throw new Error('Unable to allocate a unique export file name')
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function validateRevealExportPath(targetPath: string): Promise<void> {
  if (!targetPath || !path.isAbsolute(targetPath)) throw new Error('Export path is unavailable')
  const stat = await fs.promises.stat(targetPath)
  if (!stat.isFile()) throw new Error('Export path is not a file')
}
