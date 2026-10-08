import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { noReplaceMove } from '../../electron/noReplaceMove'
import { inspectRegularFile } from '../../electron/fileStorageService'
import { protectedWindowsFileOperation } from '../../electron/windowsFileHandle'

describe.runIf(process.platform === 'win32')('actual Windows no-replace move adapter', () => {
  let root: string
  beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'delive-move-')) })
  afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }) })
  it('moves Unicode/space/semicolon paths without shell interpretation and refuses an existing target', async () => {
    const source = path.join(root, '原件 ; 测试.wav')
    const target = path.join(root, '新名称.wav')
    await fs.promises.writeFile(source, 'original')
    const proof = await inspectRegularFile(source)
    await fs.promises.writeFile(target, 'user-owned')
    await expect(noReplaceMove(source, target, proof)).rejects.toThrow()
    expect(await fs.promises.readFile(target, 'utf8')).toBe('user-owned')
    await fs.promises.unlink(target)
    await noReplaceMove(source, target, proof)
    expect(await fs.promises.readFile(target, 'utf8')).toBe('original')
  }, 15000)
  it('allows only one winner under actual competing target races and retains every losing source', async () => {
    const target = path.join(root, 'race.wav')
    const sources = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const source = path.join(root, `source-${index}.wav`)
      await fs.promises.writeFile(source, `content-${index}`)
      return { source, proof: await inspectRegularFile(source) }
    }))
    const results = await Promise.allSettled(sources.map(({ source, proof }) => noReplaceMove(source, target, proof)))
    const evidence = JSON.stringify({ results: results.map((result) => result.status === 'rejected' ? String(result.reason) : 'success'), files: await fs.promises.readdir(root) })
    expect(results.filter((result) => result.status === 'fulfilled'), evidence).toHaveLength(1)
    for (let index = 0; index < results.length; index++) if (results[index].status === 'rejected') expect(fs.existsSync(sources[index].source), JSON.stringify(results.map((result) => result.status === 'rejected' ? String(result.reason) : 'success'))).toBe(true)
    expect(await fs.promises.readFile(target, 'utf8')).toMatch(/^content-[0-3]$/)
  }, 30000)
  it('rejects an identical-content replacement by handle identity before changing any path', async () => {
    const source = path.join(root, 'original.wav')
    const retained = path.join(root, 'old-original.wav')
    const target = path.join(root, 'renamed.wav')
    await fs.promises.writeFile(source, 'same content')
    const proof = await inspectRegularFile(source)
    await fs.promises.rename(source, retained)
    await fs.promises.writeFile(source, 'same content')
    await expect(protectedWindowsFileOperation({ action: 'move', source, target, ...proof })).rejects.toThrow(/identity|身份/i)
    expect(await fs.promises.readFile(source, 'utf8')).toBe('same content')
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(retained)).toBe(true)
  }, 15000)
})
