import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FileStorageService } from '../../electron/fileStorageService'

describe.runIf(process.platform === 'win32' && fs.existsSync('D:\\'))('actual NTFS cross-volume migration', () => {
  it('copies and verifies C-volume audio on D, switches authority, then cleans only the confirmed old copy', async () => {
    const sourceBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'delive-cross-volume-'))
    // One exclusively created temporary directory; never scan or clean other D-volume contents.
    const targetParent = await fs.promises.mkdtemp('D:\\delive-migration-test-')
    try {
      expect(path.parse(sourceBase).root.toLowerCase()).not.toBe(path.parse(targetParent).root.toLowerCase())
      const files = new FileStorageService(path.join(sourceBase, 'profile'))
      const sourceDirectory = await files.sessionDirectory('cross-volume-record', true)
      const originalPath = path.join(sourceDirectory, 'source-audio.wav')
      const bytes = Buffer.from('VERIFIED AUDIO BYTES - CROSS VOLUME')
      await fs.promises.writeFile(originalPath, bytes)
      const before = await files.resolveAsset('cross-volume-record')
      const preview = await files.previewMigration(targetParent, 1)
      const id = await files.applyMigration(preview.token, 1)
      const current = await files.resolveAsset('cross-volume-record')
      expect(current.path).toContain(path.join(targetParent, 'DeLive-media'))
      expect(current.sha256).toBe(before.sha256)
      expect(current.revision).toBeGreaterThan(before.revision)
      expect(await fs.promises.readFile(current.path)).toEqual(bytes)
      expect(await fs.promises.readFile(originalPath)).toEqual(bytes)
      expect(await files.cleanupMigration(id)).toEqual([])
      expect(fs.existsSync(originalPath)).toBe(false)
      const restarted = new FileStorageService(files.userData)
      expect((await restarted.resolveAsset('cross-volume-record')).sha256).toBe(before.sha256)
      expect((await restarted.getConfiguration()).mediaRoot).toBe(preview.targetRoot)
    } finally {
      await fs.promises.rm(sourceBase, { recursive: true, force: true })
      await fs.promises.rm(targetParent, { recursive: true, force: true })
    }
  }, 30000)
})
