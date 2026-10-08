import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FileStorageService, assertStorageBasename } from '../../electron/fileStorageService'

describe('shared main-process file storage service', () => {
  let root: string
  let service: FileStorageService
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'delive-file-storage-'))
    service = new FileStorageService(path.join(root, 'userdata'))
    await service.getConfiguration()
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }) })

  async function stage(sessionId: string, name = 'recording.tmp.wav', data = 'audio-bytes') {
    const directory = await service.sessionDirectory(sessionId, true)
    await fs.promises.writeFile(path.join(directory, name), data)
    return directory
  }

  it('shares one default root, checks IDs/basenames and rejects traversal and device names', async () => {
    expect((await service.getConfiguration()).mediaRoot).toBe(path.join(root, 'userdata', 'media'))
    await expect(service.sessionDirectory('../outside', true)).rejects.toMatchObject({ code: 'FILE_STORAGE_INVALID' })
    await expect(service.sessionDirectory('..', true)).rejects.toMatchObject({ code: 'FILE_STORAGE_INVALID' })
    await expect(service.sessionDirectory('session.', true)).rejects.toMatchObject({ code: 'FILE_STORAGE_INVALID' })
    await expect(service.sessionDirectory('__proto__', true)).rejects.toMatchObject({ code: 'FILE_STORAGE_INVALID' })
    for (const name of ['../audio.wav', 'NUL.wav', 'CON', 'bad:.mp3', 'bad.wav.', 'bad.wav ']) expect(() => assertStorageBasename(name)).toThrow()
    expect(() => assertStorageBasename('会议记录.wav')).not.toThrow()
  })

  it('keeps independent and manually moved recordings quiet across managed roots and restart without changing state', async () => {
    const oldDirectory = await stage('independent-audio')
    const old = await service.withSessionLock('independent-audio', () => service.publishAsset('independent-audio', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    const parent = path.join(root, 'new-audio-root')
    await fs.promises.mkdir(parent)
    await service.configureMediaDirectory(parent)
    const movedDirectory = await stage('moved-audio')
    const moved = await service.withSessionLock('moved-audio', () => service.publishAsset('moved-audio', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    const movedPath = path.join(root, 'moved-audio.wav')
    await fs.promises.rename(moved.path, movedPath)
    const emptyDirectory = await service.sessionDirectory('empty-directory', true)
    const statePath = path.join(service.userData, 'local-file-storage', 'state.json')
    const stateBefore = await fs.promises.readFile(statePath, 'utf8')
    const notify = vi.fn(), unsubscribe = service.subscribe(notify)
    expect(await service.listRecordingRecoveryNotices([])).toEqual([])
    expect(await service.listRecordingRecoveryNotices(['independent-audio'])).toEqual([])
    const restarted = new FileStorageService(service.userData)
    expect(await restarted.listRecordingRecoveryNotices([])).toEqual([])
    expect(await restarted.listRecordingRecoveryNotices()).toEqual([])
    expect(await fs.promises.readFile(statePath, 'utf8')).toBe(stateBefore)
    expect(notify).not.toHaveBeenCalled()
    unsubscribe()
    expect(await fs.promises.readdir(oldDirectory)).toEqual(['source-audio.wav'])
    expect(await fs.promises.readFile(old.path, 'utf8')).toBe('audio-bytes')
    expect(await fs.promises.readdir(movedDirectory)).toEqual([])
    expect(await fs.promises.readdir(emptyDirectory)).toEqual([])
    expect(await fs.promises.readFile(movedPath, 'utf8')).toBe('audio-bytes')
    await expect(restarted.readAsset('moved-audio')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await restarted.listAssets()).errors).toEqual([
      expect.objectContaining({ sessionId: 'moved-audio' }),
    ])
  })

  it('still reports unsafe registered audio even without recovery files or a local Session', async () => {
    await stage('unsafe-audio')
    const audio = await service.withSessionLock('unsafe-audio', () => service.publishAsset('unsafe-audio', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    await fs.promises.rename(audio.path, path.join(root, 'safe-original.wav'))
    await fs.promises.mkdir(audio.path)
    expect(await service.listRecordingRecoveryNotices([])).toEqual([
      expect.objectContaining({ sessionId: 'unsafe-audio', reason: 'unsafe-recovery-file', acknowledged: false }),
    ])
    expect((await fs.promises.lstat(audio.path)).isDirectory()).toBe(true)
  })

  it('retains and suppresses acknowledged pending publications with an absent stage until evidence changes', async () => {
    const stageName = 'source-audio.abcdef.tmp.wav'
    const directory = await stage('pending-record', stageName)
    const finalPath = path.join(directory, 'source-audio.wav')
    await fs.promises.writeFile(finalPath, 'conflicting-audio')
    await expect(service.withSessionLock('pending-record', () => service.publishAsset('pending-record', 'recording-audio', stageName, 'source-audio.wav'))).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    const detached = path.join(root, 'detached-stage.wav')
    await fs.promises.rename(path.join(directory, stageName), detached)
    const [notice] = await service.listRecordingRecoveryNotices([])
    expect(notice).toMatchObject({ sessionId: 'pending-record', reason: 'pending-group', acknowledged: false })
    await service.acknowledgeRecordingRecovery({ key: notice.key, evidence: notice.evidence, activeSessionIds: [] })
    const statePath = path.join(service.userData, 'local-file-storage', 'state.json')
    const before = await fs.promises.readFile(statePath, 'utf8')
    const restarted = new FileStorageService(service.userData)
    expect((await restarted.listRecordingRecoveryNotices([]))[0]).toMatchObject({ evidence: notice.evidence, acknowledged: true })
    expect((await restarted.recoverPublications())[0].error).toBeUndefined()
    expect((await restarted.status()).pendingOperationCount).toBe(1)
    expect(await fs.promises.readFile(statePath, 'utf8')).toBe(before)
    expect(await fs.promises.readFile(finalPath, 'utf8')).toBe('conflicting-audio')
    await fs.promises.rename(detached, path.join(directory, stageName))
    expect((await restarted.listRecordingRecoveryNotices([]))[0].acknowledged).toBe(false)
    expect((await restarted.recoverPublications())[0].error).toBeDefined()
    expect((await restarted.status()).pendingOperationCount).toBe(1)
  })

  it('persists acknowledgement for exact recovery evidence without removing files, and resurfaces changed/new groups', async () => {
    const directory = await service.sessionDirectory('moved-record', true)
    const metadata = path.join(directory, 'source-audio.json.tmp')
    await fs.promises.writeFile(metadata, '{"sessionId":"moved-record"}')
    const [notice] = await service.listRecordingRecoveryNotices([])
    expect(notice).toMatchObject({ sessionId: 'moved-record', reason: 'missing-pcm', acknowledged: false })
    const before = await fs.promises.readFile(metadata, 'utf8')
    const notify = vi.fn(), unsubscribe = service.subscribe(notify)
    await service.acknowledgeRecordingRecovery({ key: notice.key, evidence: notice.evidence, activeSessionIds: [] })
    expect(notify).not.toHaveBeenCalled()
    unsubscribe()
    const restarted = new FileStorageService(service.userData)
    expect((await restarted.listRecordingRecoveryNotices([]))[0].acknowledged).toBe(true)
    expect(await fs.promises.readFile(metadata, 'utf8')).toBe(before)
    expect(await fs.promises.readdir(directory)).toEqual(['source-audio.json.tmp'])
    await fs.promises.writeFile(metadata, '{"sessionId":"moved-record","changed":true}')
    const [changed] = await restarted.listRecordingRecoveryNotices([])
    expect(changed.acknowledged).toBe(false)
    await expect(restarted.acknowledgeRecordingRecovery({ key: notice.key, evidence: notice.evidence, activeSessionIds: [] })).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    const newDirectory = await restarted.sessionDirectory('new-recovery', true)
    await fs.promises.writeFile(path.join(newDirectory, 'source-audio.pcm.tmp'), 'new')
    expect((await restarted.listRecordingRecoveryNotices([])).filter((item) => !item.acknowledged)).toHaveLength(2)
  })

  it('does not accept forged recovery scope/evidence or acknowledge active producers', async () => {
    const directory = await service.sessionDirectory('recover-record', true)
    await fs.promises.writeFile(path.join(directory, 'source-audio.pcm.tmp'), 'audio')
    const [notice] = await service.listRecordingRecoveryNotices([])
    await expect(service.listRecordingRecoveryNotices(['../outside'])).rejects.toMatchObject({ code: 'FILE_STORAGE_INVALID' })
    await expect(service.acknowledgeRecordingRecovery({ key: '0'.repeat(64), evidence: notice.evidence, activeSessionIds: [] })).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    await expect(service.acknowledgeRecordingRecovery({ key: notice.key, evidence: '0'.repeat(64), activeSessionIds: [] })).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    const lease = service.acquireUsage('recover-record', 'recording')
    expect(await service.listRecordingRecoveryNotices([])).toEqual([])
    await expect(service.acknowledgeRecordingRecovery({ key: notice.key, evidence: notice.evidence, activeSessionIds: [] })).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    service.releaseUsage(lease)
    expect((await service.listRecordingRecoveryNotices([]))[0].acknowledged).toBe(false)
  })

  it('changes future audio writes only, retaining old locations, names, permissions and export preferences after restart', async () => {
    const oldDirectory = await stage('old-record')
    const old = await service.withSessionLock('old-record', () => service.publishAsset('old-record', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    const parent = path.join(root, 'new audio parent')
    const documents = path.join(root, 'exports')
    await fs.promises.mkdir(parent)
    await fs.promises.mkdir(documents)
    await service.configureTranscriptDirectory(documents)
    const changed = await service.configureMediaDirectory(parent)
    expect(changed.configuration).toMatchObject({ mediaRoot: path.join(parent, 'DeLive-media'), defaultTranscriptDirectory: documents })
    expect((await service.resolveAsset('old-record')).path).toBe(old.path)
    expect(await fs.promises.readFile(old.path, 'utf8')).toBe('audio-bytes')
    const newDirectory = await stage('new-record')
    expect(newDirectory).toBe(path.join(parent, 'DeLive-media', 'new-record'))
    await service.withSessionLock('new-record', () => service.publishAsset('new-record', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    const restarted = new FileStorageService(service.userData)
    expect((await restarted.listAssets()).audios.map((audio) => audio.sessionId).sort()).toEqual(['new-record', 'old-record'])
    expect((await restarted.readAsset('old-record')).data.toString()).toBe('audio-bytes')
    await restarted.registerSessionContext({ sessionId: 'old-record', title: 'Renamed Old Audio', titleRevision: 1, createdAt: 1 }, true)
    expect(path.dirname((await restarted.resolveAsset('old-record')).path)).toBe(oldDirectory)
    await restarted.deleteAsset('old-record')
    expect((await restarted.listAssets()).audios.map((audio) => audio.sessionId)).toEqual(['new-record'])
    expect(fs.existsSync(path.join(newDirectory, 'source-audio.wav'))).toBe(true)
  }, 30000)

  it('refuses busy producers, unwritable storage and failed atomic configuration commits without changing the root', async () => {
    const parent = path.join(root, 'new-root')
    await fs.promises.mkdir(parent)
    const before = await service.getConfiguration()
    const token = service.acquireUsage('live-record', 'recording')
    await expect(service.configureMediaDirectory(parent)).rejects.toMatchObject({ code: 'FILE_STORAGE_BUSY' })
    service.releaseUsage(token)
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (path.basename(String(file)).startsWith('.delive-write-probe-')) throw Object.assign(new Error('read-only'), { code: 'EACCES' })
      return open(file, flags, mode)
    })
    await expect(service.configureMediaDirectory(parent)).rejects.toMatchObject({ code: 'FILE_STORAGE_UNAVAILABLE' })
    expect(await service.getConfiguration()).toEqual(before)
    vi.restoreAllMocks()
    const rename = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      if (String(target).endsWith('state.json')) throw new Error('configuration disk failure')
      return rename(source, target)
    })
    await expect(service.configureMediaDirectory(parent)).rejects.toThrow('configuration disk failure')
    vi.restoreAllMocks()
    expect(await new FileStorageService(service.userData).getConfiguration()).toEqual(before)
  })

  it('loads version-1 registrations without moving bytes and writes a guarded version-2 state on the next mutation', async () => {
    const directory = await stage('legacy-version')
    const asset = await service.withSessionLock('legacy-version', () => service.publishAsset('legacy-version', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    const statePath = path.join(service.userData, 'local-file-storage', 'state.json')
    const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'))
    state.version = 1
    delete state.mediaRoots
    delete state.sessionRoots
    for (const manifest of Object.values(state.assets) as Array<{ root?: string }>) delete manifest.root
    await fs.promises.writeFile(statePath, JSON.stringify(state))
    const restarted = new FileStorageService(service.userData)
    expect((await restarted.resolveAsset('legacy-version')).path).toBe(asset.path)
    expect(await fs.promises.readdir(directory)).toEqual(['source-audio.wav'])
    await restarted.registerSessionContext({ sessionId: 'legacy-version', title: 'legacy', titleRevision: 0, createdAt: 1 })
    expect(JSON.parse(await fs.promises.readFile(statePath, 'utf8')).version).toBe(2)
  })

  it('permits future writes on a new disk when registered old audio is offline and reports the missing old asset', async () => {
    await stage('offline-old')
    const old = await service.withSessionLock('offline-old', () => service.publishAsset('offline-old', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    const detached = path.join(root, 'detached')
    await fs.promises.rename(service.defaultMediaRoot, detached)
    const parent = path.join(root, 'online-new')
    await fs.promises.mkdir(parent)
    await service.configureMediaDirectory(parent)
    await stage('online-new')
    await service.withSessionLock('online-new', () => service.publishAsset('online-new', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    const restarted = new FileStorageService(service.userData)
    expect((await restarted.readAsset('online-new')).data.toString()).toBe('audio-bytes')
    const catalog = await restarted.listAssets()
    expect(catalog.errors.some((item) => item.sessionId === 'offline-old')).toBe(true)
    await expect(restarted.readAsset('offline-old')).rejects.toMatchObject({ code: 'FILE_STORAGE_UNAVAILABLE' })
    expect(fs.existsSync(service.defaultMediaRoot)).toBe(false)
    await fs.promises.rename(detached, service.defaultMediaRoot)
    expect((await restarted.resolveAsset('offline-old')).path).toBe(old.path)
  })

  it('publishes without replacement and resolves persisted manifests after restart', async () => {
    const directory = await stage('record-one')
    const audio = await service.withSessionLock('record-one', () => service.publishAsset('record-one', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    expect(audio).toMatchObject({ sessionId: 'record-one', assetKind: 'recording-audio', size: 11, revision: 1, mimeType: 'audio/wav' })
    expect(fs.existsSync(path.join(directory, 'recording.tmp.wav'))).toBe(false)
    expect((await new FileStorageService(service.userData).resolveAsset('record-one')).sha256).toBe(audio.sha256)
    expect((await service.status()).managedBytes).toBe(11)
    await fs.promises.writeFile(audio.path, 'external-edit')
    await expect(service.resolveAsset('record-one')).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
  })

  it('keeps conflicting destinations and temporary source data untouched', async () => {
    const directory = await stage('record-conflict')
    await fs.promises.writeFile(path.join(directory, 'source-audio.wav'), 'do-not-overwrite')
    await expect(service.withSessionLock('record-conflict', () => service.publishAsset('record-conflict', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    expect(await fs.promises.readFile(path.join(directory, 'source-audio.wav'), 'utf8')).toBe('do-not-overwrite')
    expect(await fs.promises.readFile(path.join(directory, 'recording.tmp.wav'), 'utf8')).toBe('audio-bytes')
    expect((await service.status()).pendingOperationCount).toBe(1)
    await expect(service.resolveAsset('record-conflict')).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
  })

  it('can register an identical non-overwritten destination and safely cleans only its own stage', async () => {
    const directory = await stage('identical')
    await fs.promises.writeFile(path.join(directory, 'source-audio.wav'), 'audio-bytes')
    await service.withSessionLock('identical', () => service.publishAsset('identical', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    expect(await fs.promises.readFile(path.join(directory, 'source-audio.wav'), 'utf8')).toBe('audio-bytes')
    expect(fs.existsSync(path.join(directory, 'recording.tmp.wav'))).toBe(false)
  })

  it('replays a crash after physical publication but before registration commit without duplicating files', async () => {
    const directory = await stage('recover-publication')
    const originalRename = fs.promises.rename.bind(fs.promises)
    let stateWrites = 0
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('state.json') && ++stateWrites === 2) throw new Error('simulated registration crash')
      return originalRename(source, destination)
    })
    await expect(service.withSessionLock('recover-publication', () => service.publishAsset('recover-publication', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))).rejects.toThrow('simulated registration crash')
    vi.restoreAllMocks()
    const restarted = new FileStorageService(service.userData)
    const recovered = await restarted.recoverPublications()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].error).toBeUndefined()
    expect(await fs.promises.readdir(directory)).toEqual(['source-audio.wav'])
    expect((await restarted.status()).pendingOperationCount).toBe(0)
    expect((await restarted.resolveAsset('recover-publication')).size).toBe(11)
  })

  it('only adopts exact unambiguous legacy names and preserves recovery/unknown files', async () => {
    const directory = await stage('legacy', 'source-audio.wav')
    await fs.promises.writeFile(path.join(directory, 'source-audio.pcm.tmp'), 'recovery-pcm')
    await fs.promises.writeFile(path.join(directory, 'source-audio.json.tmp'), 'recovery-json')
    await fs.promises.writeFile(path.join(directory, 'user-audio.mp3'), 'unknown')
    expect((await service.resolveAsset('legacy')).fileName).toBe('source-audio.wav')
    expect(await fs.promises.readdir(directory)).toHaveLength(4)
    const ambiguous = await stage('ambiguous', 'source-audio.wav')
    await fs.promises.writeFile(path.join(ambiguous, 'source-audio.mp3'), 'other-audio')
    await expect(service.resolveAsset('ambiguous')).rejects.toMatchObject({ code: 'FILE_STORAGE_CONFLICT' })
    expect(await fs.promises.readdir(ambiguous)).toHaveLength(2)
  })

  it('reloads uncertain state when rename committed before a reported write failure', async () => {
    const directory = await stage('uncertain-commit')
    const originalRename = fs.promises.rename.bind(fs.promises)
    let stateWrites = 0
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      await originalRename(source, destination)
      if (String(destination).endsWith('state.json') && ++stateWrites === 2) throw new Error('post-rename failure')
    })
    await expect(service.withSessionLock('uncertain-commit', () => service.publishAsset('uncertain-commit', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))).rejects.toThrow('post-rename failure')
    vi.restoreAllMocks()
    expect((await service.status()).managedAssetCount).toBe(1)
    expect((await service.recoverPublications())[0].error).toBeUndefined()
    expect(await fs.promises.readdir(directory)).toEqual(['source-audio.wav'])
    expect((await service.status()).pendingOperationCount).toBe(0)
  })

  it('rejects junction directories and corrupt manifests instead of scanning or falling back', async () => {
    const outside = path.join(root, 'outside')
    await fs.promises.mkdir(outside)
    await fs.promises.symlink(outside, path.join(service.defaultMediaRoot, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.sessionDirectory('junction')).rejects.toMatchObject({ code: 'FILE_STORAGE_INVALID' })
    const statePath = path.join(service.userData, 'local-file-storage', 'state.json')
    await fs.promises.writeFile(statePath, '{broken')
    await expect(new FileStorageService(service.userData).getConfiguration()).rejects.toThrow()
    expect(await fs.promises.readFile(statePath, 'utf8')).toBe('{broken')
  })

  it('serializes operations and rejects competing usage while preserving the owner lease', async () => {
    const token = service.acquireUsage('leased', 'recording')
    await expect(service.withSessionLock('leased', async () => undefined)).rejects.toMatchObject({ code: 'FILE_STORAGE_BUSY' })
    const order: number[] = []
    await Promise.all([
      service.withSessionLock('leased', async () => { await Promise.resolve(); order.push(1) }, token),
      service.withSessionLock('leased', async () => { order.push(2) }, token),
    ])
    expect(order).toEqual([1, 2])
    expect((await service.status()).busy).toBe(true)
    service.releaseUsage(token)
    expect((await service.status()).busy).toBe(false)
  })

  it('persists native directory grants, applies project preference and never silently falls back from a missing project directory', async () => {
    const globalDirectory = path.join(root, 'transcripts')
    const projectDirectory = path.join(root, 'project-transcripts')
    const otherProjectDirectory = path.join(root, 'other-project-transcripts')
    await fs.promises.mkdir(globalDirectory)
    await fs.promises.mkdir(projectDirectory)
    await fs.promises.mkdir(otherProjectDirectory)
    await service.configureTranscriptDirectory(globalDirectory)
    await service.configureTranscriptDirectory(projectDirectory, 'project')
    await service.configureTranscriptDirectory(otherProjectDirectory, 'other-project')
    const restarted = new FileStorageService(service.userData)
    expect(await restarted.transcriptDirectory('project')).toBe(projectDirectory)
    expect(await restarted.transcriptDirectory('other-project')).toBe(otherProjectDirectory)
    expect((await restarted.getConfiguration()).projectTranscriptDirectories).toEqual({ project: projectDirectory, 'other-project': otherProjectDirectory })
    expect(await restarted.transcriptDirectory('unconfigured-project')).toBe(globalDirectory)
    await fs.promises.rmdir(projectDirectory)
    await expect(restarted.transcriptDirectory('project')).rejects.toThrow()
    expect((await restarted.getConfiguration()).projectTranscriptDirectories.project).toBe(projectDirectory)
    expect(await restarted.transcriptDirectory('other-project')).toBe(otherProjectDirectory)
  })

  it('does not recreate an unavailable configured media root when a write is requested', async () => {
    await fs.promises.rmdir(service.defaultMediaRoot)
    await expect(service.sessionDirectory('new-record', true)).rejects.toThrow()
    expect(fs.existsSync(service.defaultMediaRoot)).toBe(false)
    expect((await service.status()).media.available).toBe(false)
  })

  it('replays deletion after unlink but before tombstone commit without adopting a replacement file', async () => {
    await stage('delete-replay')
    await service.withSessionLock('delete-replay', () => service.publishAsset('delete-replay', 'recording-audio', 'recording.tmp.wav', 'source-audio.wav'))
    const originalRename = fs.promises.rename.bind(fs.promises)
    let writes = 0
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('state.json') && ++writes === 2) throw new Error('delete commit failure')
      await originalRename(source, destination)
    })
    await expect(service.deleteAsset('delete-replay')).rejects.toThrow('delete commit failure')
    vi.restoreAllMocks()
    const restarted = new FileStorageService(service.userData)
    expect((await restarted.recoverPublications())[0].error).toBeUndefined()
    await expect(restarted.resolveAsset('delete-replay')).rejects.toMatchObject({ code: 'FILE_STORAGE_MISSING' })
    expect((await restarted.status()).pendingOperationCount).toBe(0)
  }, 30000)
})
