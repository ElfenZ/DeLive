import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { FileStorageService } from '../../electron/fileStorageService'

describe('verified media root migration', () => {
  let root: string
  let service: FileStorageService
  let targetParent: string
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'delive-migration-'))
    service = new FileStorageService(path.join(root, 'userdata'))
    await service.getConfiguration()
    targetParent = path.join(root, 'selected-parent')
    await fs.promises.mkdir(targetParent)
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }) })
  async function audio(id = 'rec1', name = 'source-audio.wav', bytes = 'audio-bytes') {
    const directory = await service.sessionDirectory(id, true)
    await fs.promises.writeFile(path.join(directory, name), bytes)
    return directory
  }

  async function holdCatalog() {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const original = service.managedRoots.bind(service)
    vi.spyOn(service, 'managedRoots').mockImplementationOnce(async () => { entered(); await gate; return original() })
    const catalog = service.listAssets()
    await started
    return { catalog, release }
  }

  it('reports catalog activity and drains it before migration without admitting new scans or producers', async () => {
    await audio()
    const events: Array<{ activityOnly?: boolean }> = []
    service.subscribe((event) => { events.push(event) })
    const held = await holdCatalog()
    const attempt = service.previewMigration(targetParent, 1)
    let finished = false
    void attempt.then(() => { finished = true })
    try {
      expect((await service.status()).busy).toBe(true)
      expect(finished).toBe(false)
      await expect(service.listAssets()).rejects.toMatchObject({ code: 'FILE_STORAGE_BUSY' })
      await expect(service.previewMigration(targetParent, 2)).rejects.toMatchObject({ code: 'FILE_STORAGE_BUSY' })
      expect(() => service.acquireUsage('live', 'recording')).toThrow(/busy/)
    } finally { held.release() }
    await held.catalog
    const preview = await attempt
    expect(preview.fileCount).toBe(1)
    expect((await service.status()).busy).toBe(false)
    expect(events.filter((event) => event.activityOnly)).toHaveLength(4)
    expect((await service.listAssets()).audios).toHaveLength(1)
  })

  it('rechecks real session work after catalog drain and releases a failed global reservation', async () => {
    const held = await holdCatalog()
    const attempt = service.previewMigration(targetParent, 1)
    const failure = expect(attempt).rejects.toMatchObject({ code: 'FILE_STORAGE_BUSY' })
    await service.status() // Let the request reserve its catalog-drain turn.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const work = service.withSessionLock('actual-operation', () => gate)
    held.release()
    await held.catalog
    try { await failure } finally { release(); await work }
    expect((await service.status()).busy).toBe(false)
    expect((await service.previewMigration(targetParent, 1)).fileCount).toBe(0)
  })

  it('unblocks the reservation when a catalog fails and releases locks when preview validation fails', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(service, 'managedRoots').mockImplementationOnce(async () => { entered(); await gate; throw new Error('catalog failure') })
    const catalog = service.listAssets()
    const failure = expect(catalog).rejects.toThrow('catalog failure')
    await started
    const preview = service.previewMigration(targetParent, 1)
    release()
    await failure
    expect((await preview).fileCount).toBe(0)
    await expect(service.previewMigration(service.defaultMediaRoot, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_INVALID' })
    expect((await service.status()).busy).toBe(false)
    const lease = service.acquireUsage('live', 'recording')
    await expect(service.previewMigration(targetParent, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_BUSY' })
    service.releaseUsage(lease)
  })

  it('migrates exact bytes through a Chinese and space-containing selected parent', async () => {
    const directory = await audio()
    const parent = path.join(root, '\u4e2d\u6587 \u5a92\u4f53\u76ee\u5f55')
    await fs.promises.mkdir(parent)
    const preview = await service.previewMigration(parent, 1)
    expect(preview.targetRoot).toBe(path.join(await fs.promises.realpath(parent), 'DeLive-media'))
    await service.applyMigration(preview.token, 1)
    const restarted = new FileStorageService(service.userData)
    expect((await restarted.getConfiguration()).mediaRoot).toBe(preview.targetRoot)
    expect((await restarted.readAsset('rec1')).data).toEqual(Buffer.from('audio-bytes'))
    expect(await fs.promises.readFile(path.join(directory, 'source-audio.wav'))).toEqual(Buffer.from('audio-bytes'))
  }, 30000)

  it('previews and migrates all actual source roots after repeated future-only root changes, with restart recovery and explicit cleanup', async () => {
    const firstDirectory = await audio('first', 'source-audio.wav', 'first-audio')
    const secondParent = path.join(root, 'second-root')
    const thirdParent = path.join(root, 'third-root')
    await fs.promises.mkdir(secondParent)
    await fs.promises.mkdir(thirdParent)
    await service.configureMediaDirectory(secondParent)
    const secondDirectory = await audio('second', 'source-audio.mp3', 'second-audio')
    await service.configureMediaDirectory(thirdParent)
    const thirdDirectory = await audio('third', 'source-audio.wav', 'third-audio')
    service = new FileStorageService(service.userData)
    const preview = await service.previewMigration(targetParent, 1)
    expect(preview.sourceRoots?.sort()).toEqual([service.defaultMediaRoot, path.join(secondParent, 'DeLive-media'), path.join(thirdParent, 'DeLive-media')].sort())
    expect(preview.fileCount).toBe(3)
    expect(preview.totalBytes).toBe(Buffer.byteLength('first-audiosecond-audiothird-audio'))
    const copy = fs.promises.copyFile.bind(fs.promises)
    let failed = false
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (source, target, flags) => {
      if (String(source).includes(`${path.sep}second${path.sep}`) && !failed) { failed = true; throw new Error('multi-root interruption') }
      return copy(source, target, flags)
    })
    await expect(service.applyMigration(preview.token, 1)).rejects.toThrow('multi-root interruption')
    vi.restoreAllMocks()
    service = new FileStorageService(service.userData)
    await service.recoverMigrations()
    const migration = (await service.status()).migrations![0]
    expect(migration.phase).toBe('committed')
    for (const id of ['first', 'second', 'third']) expect((await service.resolveAsset(id)).path).toContain(path.join(targetParent, 'DeLive-media'))
    expect((await service.readAsset('first')).data.toString()).toBe('first-audio')
    expect((await service.readAsset('second')).data.toString()).toBe('second-audio')
    expect((await service.readAsset('third')).data.toString()).toBe('third-audio')
    expect((await service.listAssets()).audios).toHaveLength(3)
    expect(await service.cleanupMigration(migration.id)).toEqual([])
    expect(fs.existsSync(path.join(firstDirectory, 'source-audio.wav'))).toBe(false)
    expect(fs.existsSync(path.join(secondDirectory, 'source-audio.mp3'))).toBe(false)
    expect(fs.existsSync(path.join(thirdDirectory, 'source-audio.wav'))).toBe(false)
  }, 30000)

  it('reports a configured migrated root unavailable without recreating it or falling back when renamed', async () => {
    const source = await audio()
    const preview = await service.previewMigration(targetParent, 1)
    await service.applyMigration(preview.token, 1)
    const detached = path.join(targetParent, 'temporarily-detached')
    await fs.promises.rename(preview.targetRoot, detached)
    const restarted = new FileStorageService(service.userData)
    expect((await restarted.status()).media).toMatchObject({ available: false, writable: false })
    await expect(restarted.sessionDirectory('new-recording', true)).rejects.toMatchObject({ code: 'FILE_STORAGE_UNAVAILABLE' })
    await expect(restarted.readAsset('rec1')).rejects.toMatchObject({ code: 'FILE_STORAGE_UNAVAILABLE' })
    expect((await restarted.getConfiguration()).mediaRoot).toBe(preview.targetRoot)
    expect(fs.existsSync(preview.targetRoot)).toBe(false)
    expect(fs.existsSync(path.join(service.defaultMediaRoot, 'new-recording'))).toBe(false)
    expect(await fs.promises.readFile(path.join(source, 'source-audio.wav'))).toEqual(Buffer.from('audio-bytes'))
    expect(await fs.promises.readFile(path.join(detached, 'rec1', 'source-audio.wav'))).toEqual(Buffer.from('audio-bytes'))
    await fs.promises.rename(detached, preview.targetRoot)
    expect((await restarted.readAsset('rec1')).data).toEqual(Buffer.from('audio-bytes'))
  }, 30000)

  it.each(['EACCES', 'EROFS'])('rejects a simulated %s write-probe failure without changing roots or bytes', async (code) => {
    const directory = await audio()
    const before = await service.getConfiguration()
    const targetRoot = path.join(targetParent, 'DeLive-media')
    const originalOpen = fs.promises.open.bind(fs.promises)
    let injected = false
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (path.dirname(String(file)) === targetRoot && path.basename(String(file)).startsWith('.delive-write-probe-')) {
        injected = true
        throw Object.assign(new Error(`simulated ${code}`), { code })
      }
      return originalOpen(file, flags, mode)
    })
    await expect(service.previewMigration(targetParent, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_UNAVAILABLE' })
    expect(injected).toBe(true)
    expect(await service.getConfiguration()).toEqual(before)
    expect(await fs.promises.readFile(path.join(directory, 'source-audio.wav'))).toEqual(Buffer.from('audio-bytes'))
    expect(await fs.promises.readdir(targetRoot)).toEqual([])
    expect((await new FileStorageService(service.userData).status()).migrations).toEqual([])
  }, 30000)

  it('rejects simulated insufficient statfs space without copying or changing configured root', async () => {
    const directory = await audio()
    const before = await service.getConfiguration()
    const targetRoot = path.join(targetParent, 'DeLive-media')
    const originalStatfs = fs.promises.statfs.bind(fs.promises)
    let injected = false
    vi.spyOn(fs.promises, 'statfs').mockImplementation(async (directoryPath) => {
      const actual = await originalStatfs(directoryPath)
      if (String(directoryPath) !== targetRoot) return actual
      injected = true
      return { ...actual, bavail: 0 }
    })
    const copy = vi.spyOn(fs.promises, 'copyFile')
    await expect(service.previewMigration(targetParent, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_UNAVAILABLE' })
    expect(injected).toBe(true)
    expect(copy).not.toHaveBeenCalled()
    expect(await service.getConfiguration()).toEqual(before)
    expect(await fs.promises.readFile(path.join(directory, 'source-audio.wav'))).toEqual(Buffer.from('audio-bytes'))
    expect(await fs.promises.readdir(targetRoot)).toEqual([])
  }, 30000)

  it('retains a pending journal across restart when a target collides after preview, preserving both files', async () => {
    const directory = await audio()
    const before = await service.getConfiguration()
    const preview = await service.previewMigration(targetParent, 1)
    const targetDirectory = path.join(preview.targetRoot, 'rec1')
    await fs.promises.mkdir(targetDirectory)
    const target = path.join(targetDirectory, 'source-audio.wav')
    await fs.promises.writeFile(target, 'unrelated-target-bytes')
    await expect(service.applyMigration(preview.token, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    const pending = (await service.status()).migrations![0]
    expect(pending).toMatchObject({ phase: 'copying', sourceRoot: before.mediaRoot, targetRoot: preview.targetRoot })
    const restarted = new FileStorageService(service.userData)
    await expect(restarted.recoverMigrations()).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    expect((await restarted.status()).migrations![0]).toMatchObject({ id: pending.id, phase: 'copying' })
    expect(() => restarted.acquireUsage('new-recording', 'recording')).toThrow(/busy/)
    expect(await restarted.getConfiguration()).toEqual(before)
    expect(await fs.promises.readFile(path.join(directory, 'source-audio.wav'))).toEqual(Buffer.from('audio-bytes'))
    expect(await fs.promises.readFile(target)).toEqual(Buffer.from('unrelated-target-bytes'))
    expect(await fs.promises.readdir(targetDirectory)).toEqual(['source-audio.wav'])
  }, 30000)

  it('previews the dedicated child, copies exact assets/recovery groups, switches revisions and retains originals/unknown files', async () => {
    const directory = await audio()
    await fs.promises.writeFile(path.join(directory, 'source-audio.pcm.tmp'), 'pcm')
    await fs.promises.writeFile(path.join(directory, 'source-audio.json.tmp'), '{invalid-preserved-metadata')
    await fs.promises.writeFile(path.join(directory, 'user-notes.txt'), 'do-not-move')
    const original = path.join(root, 'original-video.mp4')
    await fs.promises.writeFile(original, 'original-video')
    const preview = await service.previewMigration(targetParent, 1)
    expect(preview).toMatchObject({ targetRoot: path.join(targetParent, 'DeLive-media'), fileCount: 3, unknownEntryCount: 1 })
    const id = await service.applyMigration(preview.token, 1)
    const managed = await service.resolveAsset('rec1')
    expect(managed).toMatchObject({ revision: 2, size: 11 })
    expect(managed.path).toBe(path.join(preview.targetRoot, 'rec1', 'source-audio.wav'))
    expect(await fs.promises.readFile(managed.path, 'utf8')).toBe('audio-bytes')
    expect(await fs.promises.readFile(original, 'utf8')).toBe('original-video')
    expect(fs.existsSync(path.join(preview.targetRoot, 'rec1', 'user-notes.txt'))).toBe(false)
    expect(await fs.promises.readFile(path.join(directory, 'source-audio.wav'), 'utf8')).toBe('audio-bytes')
    expect((await service.status()).migrations?.find((migration) => migration.id === id)?.phase).toBe('committed')
    const skipped = await service.cleanupMigration(id)
    expect(skipped).toEqual([])
    expect(await fs.promises.readdir(directory)).toEqual(['user-notes.txt'])
    expect((await service.status()).migrations?.[0].phase).toBe('cleaned')
  }, 30000)

  it('rejects ancestry, active leases, target conflicts and stale configuration without switching roots', async () => {
    await audio()
    await expect(service.previewMigration(service.defaultMediaRoot, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_INVALID' })
    const lease = service.acquireUsage('live', 'recording')
    await expect(service.previewMigration(targetParent, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_BUSY' })
    service.releaseUsage(lease)
    const conflicting = path.join(targetParent, 'DeLive-media', 'rec1')
    await fs.promises.mkdir(conflicting, { recursive: true })
    await fs.promises.writeFile(path.join(conflicting, 'source-audio.wav'), 'user-target')
    await expect(service.previewMigration(targetParent, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    expect(await fs.promises.readFile(path.join(conflicting, 'source-audio.wav'), 'utf8')).toBe('user-target')
    await fs.promises.unlink(path.join(conflicting, 'source-audio.wav'))
    const preview = await service.previewMigration(targetParent, 1)
    const transcriptDirectory = path.join(root, 'transcripts')
    await fs.promises.mkdir(transcriptDirectory)
    await service.configureTranscriptDirectory(transcriptDirectory)
    await expect(service.applyMigration(preview.token, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    expect((await service.getConfiguration()).mediaRoot).toBe(service.defaultMediaRoot)
  }, 30000)

  it('reuses identical targets and rejects wrong-window or expired previews', async () => {
    await audio()
    const directory = path.join(targetParent, 'DeLive-media', 'rec1')
    await fs.promises.mkdir(directory, { recursive: true })
    await fs.promises.writeFile(path.join(directory, 'source-audio.wav'), 'audio-bytes')
    const preview = await service.previewMigration(targetParent, 1)
    expect(preview).toMatchObject({ reusedFileCount: 1, requiredCopyBytes: 0 })
    expect(() => service.getMigrationPreview(preview.token, 2)).toThrow(/another window/)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
    await expect(service.applyMigration(preview.token, 1)).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    vi.restoreAllMocks()
    const fresh = await service.previewMigration(targetParent, 1)
    await service.applyMigration(fresh.token, 1)
    expect(await fs.promises.readdir(directory)).toEqual(['source-audio.wav'])
  }, 30000)

  it('replays an interrupted physical copy after restart and blocks new producers while paused', async () => {
    await audio()
    const preview = await service.previewMigration(targetParent, 1)
    const originalCopy = fs.promises.copyFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (source, target, flags) => {
      await originalCopy(source, target, flags)
      throw new Error('crash after copy')
    })
    await expect(service.applyMigration(preview.token, 1)).rejects.toThrow('crash after copy')
    expect((await service.getConfiguration()).mediaRoot).toBe(service.defaultMediaRoot)
    expect(() => service.acquireUsage('new', 'recording')).toThrow(/busy/)
    vi.restoreAllMocks()
    const restarted = new FileStorageService(service.userData)
    await restarted.recoverMigrations()
    expect((await restarted.getConfiguration()).mediaRoot).toBe(preview.targetRoot)
    expect(await fs.promises.readdir(path.join(preview.targetRoot, 'rec1'))).toEqual(['source-audio.wav'])
    expect((await restarted.resolveAsset('rec1')).revision).toBe(2)
  }, 30000)

  it('retains the new root if physical config commit succeeds before an error is reported', async () => {
    await audio()
    const preview = await service.previewMigration(targetParent, 1)
    const originalRename = fs.promises.rename.bind(fs.promises)
    let injected = false
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      const next = String(target).endsWith('state.json') ? JSON.parse(await fs.promises.readFile(source, 'utf8')) : undefined
      await originalRename(source, target)
      if (!injected && next?.configuration.mediaRoot === preview.targetRoot) { injected = true; throw new Error('post-switch uncertainty') }
    })
    await expect(service.applyMigration(preview.token, 1)).rejects.toThrow('post-switch uncertainty')
    vi.restoreAllMocks()
    expect((await service.getConfiguration()).mediaRoot).toBe(preview.targetRoot)
    expect((await service.resolveAsset('rec1')).path).toContain(preview.targetRoot)
    expect((await new FileStorageService(service.userData).status()).migrations?.[0].phase).toBe('committed')
  }, 30000)

  it('retains externally changed old copies and reports residual bytes without reverting the root', async () => {
    const directory = await audio()
    await audio('rec2', 'source-audio.mp3', 'second')
    const preview = await service.previewMigration(targetParent, 1)
    const id = await service.applyMigration(preview.token, 1)
    await fs.promises.writeFile(path.join(directory, 'source-audio.wav'), 'external-edit')
    const skipped = await service.cleanupMigration(id)
    expect(skipped).toHaveLength(1)
    expect(await fs.promises.readFile(path.join(directory, 'source-audio.wav'), 'utf8')).toBe('external-edit')
    expect(fs.existsSync(path.join(service.defaultMediaRoot, 'rec2', 'source-audio.mp3'))).toBe(false)
    expect((await service.getConfiguration()).mediaRoot).toBe(preview.targetRoot)
    expect((await service.status()).migrations?.[0]).toMatchObject({ phase: 'committed', remainingCopies: 1, remainingBytes: 11 })
  }, 30000)

  it('abandons a failed migration explicitly without deleting target residue or modifying source files', async () => {
    await audio()
    const preview = await service.previewMigration(targetParent, 1)
    vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(service.applyMigration(preview.token, 1)).rejects.toThrow('disk unavailable')
    vi.restoreAllMocks()
    const id = (await service.status()).migrations![0].id
    await service.abandonMigration(id)
    expect((await service.getConfiguration()).mediaRoot).toBe(service.defaultMediaRoot)
    const token = service.acquireUsage('new', 'recording')
    service.releaseUsage(token)
    expect((await service.status()).migrations?.[0].phase).toBe('abandoned')
  }, 30000)

  it('never cleans an old directory that has become the active root again', async () => {
    await audio()
    const first = await service.previewMigration(targetParent, 1)
    const firstId = await service.applyMigration(first.token, 1)
    const secondParent = path.join(root, 'second-parent')
    await fs.promises.mkdir(secondParent)
    const second = await service.previewMigration(secondParent, 1)
    const secondId = await service.applyMigration(second.token, 1)
    const back = await service.previewMigration(targetParent, 1)
    await service.applyMigration(back.token, 1)
    await expect(service.cleanupMigration(secondId)).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    const active = await service.resolveAsset('rec1')
    expect(await fs.promises.readFile(active.path, 'utf8')).toBe('audio-bytes')
    await service.cleanupMigration(firstId)
    expect(await fs.promises.readFile(active.path, 'utf8')).toBe('audio-bytes')
  }, 30000)
})
