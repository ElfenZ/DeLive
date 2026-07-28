import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateRevealExportPath, writeAutoExportFile } from './autoExportFile'

const tempDirectories: string[] = []

async function createTempDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'delive-export-'))
  tempDirectories.push(directory)
  return directory
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )))
})

describe('autoExportFile', () => {
  it('writes UTF-8 Markdown and allocates unique names without overwriting', async () => {
    const directory = await createTempDirectory()
    const first = await writeAutoExportFile({ directory, fileName: 'meeting_corrected.md', content: '# 一' })
    const second = await writeAutoExportFile({ directory, fileName: 'meeting_corrected.md', content: '# 二' })

    expect(first).toEqual({ ok: true, path: path.join(directory, 'meeting_corrected.md') })
    expect(second).toEqual({ ok: true, path: path.join(directory, 'meeting_corrected (1).md') })
    await expect(fs.promises.readFile(first.path!, 'utf8')).resolves.toBe('# 一')
    await expect(fs.promises.readFile(second.path!, 'utf8')).resolves.toBe('# 二')
  })

  it.each(['../outside.md', 'nested/file.md', 'nested\\file.md'])('rejects unsafe file name %s', async (fileName) => {
    const directory = await createTempDirectory()
    await expect(writeAutoExportFile({ directory, fileName, content: 'text' }))
      .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/basename/) }))
  })

  it('rejects missing directories, non-directories, and empty content', async () => {
    const directory = await createTempDirectory()
    const filePath = path.join(directory, 'not-a-directory')
    await fs.promises.writeFile(filePath, 'file')

    expect((await writeAutoExportFile({ directory: path.join(directory, 'missing'), fileName: 'x.md', content: 'x' })).ok).toBe(false)
    expect((await writeAutoExportFile({ directory: filePath, fileName: 'x.md', content: 'x' })).ok).toBe(false)
    expect((await writeAutoExportFile({ directory, fileName: 'x.md', content: '' })).ok).toBe(false)
  })

  it('returns write failures without leaving a partial file', async () => {
    const directory = await createTempDirectory()
    vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))

    const result = await writeAutoExportFile({ directory, fileName: 'failed.md', content: 'text' })

    expect(result).toEqual({ ok: false, error: 'denied' })
    await expect(fs.promises.stat(path.join(directory, 'failed.md'))).rejects.toThrow()
  })

  it('validates reveal targets as existing files', async () => {
    const directory = await createTempDirectory()
    const filePath = path.join(directory, 'export.md')
    await fs.promises.writeFile(filePath, 'text')

    await expect(validateRevealExportPath(filePath)).resolves.toBeUndefined()
    await expect(validateRevealExportPath(directory)).rejects.toThrow(/not a file/)
    await expect(validateRevealExportPath(path.join(directory, 'missing.md'))).rejects.toThrow()
  })
})
