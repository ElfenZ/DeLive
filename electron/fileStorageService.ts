import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { startPerformanceSpan } from '../shared/performanceDiagnostics'
import type { RecordingRecoveryNotice, RecordingRecoveryAcknowledgement } from '../shared/fileStorage'
import type { LocalFileConfiguration, LocalFileStatus, ManagedAssetKind, ManagedAudioAsset, StorageDirectoryStatus, FileStorageErrorCode, MediaMigrationPreview, MediaMigrationStatus } from '../shared/fileStorage'
import { isSafeStorageId } from '../shared/fileStorage'
import type { SessionFileContext, ManagedNamingState, LocalFileChange } from '../shared/fileStorage'
import { buildStorageFileName } from '../shared/fileNames'
import { protectedWindowsFileOperation } from './windowsFileHandle'

export class FileStorageError extends Error {
  constructor(public readonly code: FileStorageErrorCode, message: string) { super(message); this.name = 'FileStorageError' }
}

export interface FileIdentity { dev: string; ino: string; size: number; mtimeMs: number; birthtimeMs: number }
interface DirectoryGrant { path: string; dev: string; ino: string; birthtimeMs: number }
interface AssetManifest extends Omit<ManagedAudioAsset, 'path'> { root: string; identity: FileIdentity; deleted?: boolean }
interface PublicationIntent {
  id: string
  kind: 'publish' | 'delete' | 'case-rename'
  stageName: string
  stageIdentity: FileIdentity
  asset: AssetManifest
  committed?: boolean
  temporaryName?: string
}
interface MigrationFile {
  sourceRoot?: string
  sessionId: string
  basename: string
  source: { identity: FileIdentity; sha256: string }
  stageName: string
  assetKey?: string
  targetIdentity?: FileIdentity
  cleaned?: boolean
}
interface MigrationIntent {
  id: string
  sourceRoot: string
  targetRoot: string
  sourceGrant: DirectoryGrant
  sourceGrants?: DirectoryGrant[]
  targetGrant: DirectoryGrant
  phase: MediaMigrationStatus['phase']
  files: MigrationFile[]
  error?: string
}
interface MigrationSelection {
  preview: MediaMigrationPreview
  owner: number
  configurationRevision: number
  intent: MigrationIntent
}
interface FileStorageState {
  version: 1 | 2
  mediaRoots: string[]
  sessionRoots: Record<string, string>
  recordingRecoveryAcks?: Record<string, RecordingRecoveryAcknowledgement>
  configuration: LocalFileConfiguration
  grants: Record<string, DirectoryGrant>
  assets: Record<string, AssetManifest>
  operations: Record<string, PublicationIntent>
  migrations: Record<string, MigrationIntent>
  records: Record<string, SessionFileContext & { deleted?: boolean; deleting?: boolean; naming?: ManagedNamingState }>
}

const LEGACY_AUDIO_NAMES = ['source-audio.wav', 'source-audio.mp3', 'source-audio.m4a', 'source-audio.webm', 'source-audio.bin']
const MIME_TYPES: Record<string, string> = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.webm': 'audio/webm', '.bin': 'application/octet-stream' }
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const validIdentity = (value: FileIdentity | undefined): boolean => Boolean(value)
  && typeof value?.dev === 'string' && /^\d+$/.test(value.dev) && typeof value.ino === 'string' && /^\d+$/.test(value.ino)
  && [value.size, value.mtimeMs, value.birthtimeMs].every((part) => typeof part === 'number' && Number.isFinite(part))

export function comparePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function assertStorageBasename(value: string): void {
  if (typeof value !== 'string' || !value || value !== path.basename(value) || /[<>:"/\\|?*\x00-\x1f]/.test(value)
    || /[. ]$/.test(value) || value === '.' || value === '..' || value.length > 220
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid managed basename')
  }
}

export async function assertSafeDirectory(directory: string, create = false): Promise<void> {
  if (!path.isAbsolute(directory)) throw new FileStorageError('FILE_STORAGE_INVALID', 'Directory must be absolute')
  const resolved = path.resolve(directory)
  const root = path.parse(resolved).root
  let current = root
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    let stat: fs.Stats
    try { stat = await fs.promises.lstat(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error
      try { await fs.promises.mkdir(current) }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure }
      stat = await fs.promises.lstat(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FileStorageError('FILE_STORAGE_INVALID', 'Directory contains a symlink, junction or non-directory')
  }
  if (comparePath(await fs.promises.realpath(resolved)) !== comparePath(resolved)) {
    throw new FileStorageError('FILE_STORAGE_INVALID', 'Directory canonical path changed')
  }
}

export function fileIdentity(stat: fs.Stats | fs.BigIntStats): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), birthtimeMs: Number(stat.birthtimeMs) }
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.birthtimeMs === right.birthtimeMs
}

export async function inspectRegularFile(target: string): Promise<{ identity: FileIdentity; sha256: string }> {
  const before = await fs.promises.lstat(target, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new FileStorageError('FILE_STORAGE_INVALID', 'Expected a regular file, not a link')
  const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(await handle.stat({ bigint: true })))) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'File changed before reading')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(256 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(await handle.stat({ bigint: true })))
      || !sameFileIdentity(fileIdentity(before), fileIdentity(await fs.promises.lstat(target, { bigint: true })))) {
      throw new FileStorageError('FILE_STORAGE_CONFLICT', 'File changed while reading')
    }
    return { identity: fileIdentity(before), sha256: hash.digest('hex') }
  } finally { await handle.close() }
}

export async function writeJsonDurably(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${randomUUID()}.writing`
  const handle = await fs.promises.open(temporary, 'wx')
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() }
  catch (error) { await handle.close(); await fs.promises.rm(temporary, { force: true }); throw error }
  await handle.close()
  try {
    await fs.promises.rename(temporary, target)
    const check = await fs.promises.readFile(target, 'utf8')
    if (check !== JSON.stringify(value)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Durable state read-back failed')
  } finally { await fs.promises.rm(temporary, { force: true }).catch(() => undefined) }
}

function assetKey(sessionId: string, kind: ManagedAssetKind): string { return `${sessionId}:${kind}` }
function assertSessionId(value: string): void {
  if (!isSafeStorageId(value)) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid media session ID')
}

export class FileStorageService {
  private state!: FileStorageState
  private ready: Promise<void> | undefined
  private stateFault: Error | undefined
  private stateQueue: Promise<void> = Promise.resolve()
  private sessionQueues = new Map<string, Promise<unknown>>()
  private usage = new Map<string, { sessionId: string; kind: string }>()
  private migrationLocked = false
  private globalFileRequest = false
  private migrationSelections = new Map<string, MigrationSelection>()
  private changeListeners = new Set<(event: LocalFileChange) => void>()
  private changeSequence = 0
  private batchNaming = new Map<string, { owner: number; expiresAt: number; contexts: SessionFileContext[]; items: Array<{ sessionId: string; oldName: string; newName: string; revision: number }> }>()
  private catalogReaders = 0
  private catalogDrainWaiters = new Set<() => void>()
  private recordGuards = new Map<string, Promise<unknown>>()
  private stateDirectory: string
  private statePath: string
  readonly defaultMediaRoot: string

  constructor(readonly userData: string) {
    if (!path.isAbsolute(userData)) throw new FileStorageError('FILE_STORAGE_INVALID', 'userData must be absolute')
    this.defaultMediaRoot = path.join(userData, 'media')
    this.stateDirectory = path.join(userData, 'local-file-storage')
    this.statePath = path.join(this.stateDirectory, 'state.json')
  }

  private initialize(): Promise<void> {
    if (this.stateFault) return Promise.reject(this.stateFault)
    if (!this.ready) this.ready = this.load()
    return this.ready
  }

  private async load(): Promise<void> {
    await assertSafeDirectory(this.stateDirectory, true)
    try {
      const stat = await fs.promises.lstat(this.statePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'File storage state is not a regular file')
      const raw = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8')) as FileStorageState
      if ((raw.version !== 1 && raw.version !== 2) || raw.configuration?.version !== 1 || !path.isAbsolute(raw.configuration.mediaRoot)
        || !isObject(raw.grants) || !isObject(raw.assets) || !isObject(raw.operations) || !isObject(raw.configuration.projectTranscriptDirectories)
        || !Number.isSafeInteger(raw.configuration.revision) || raw.configuration.revision < 0) {
        throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid file storage state')
      }
      if (raw.version === 1) {
        raw.mediaRoots = [raw.configuration.mediaRoot]
        raw.sessionRoots = {}
        for (const asset of Object.values(raw.assets)) asset.root = raw.configuration.mediaRoot
        for (const intent of Object.values(raw.operations)) intent.asset.root = raw.configuration.mediaRoot
      }
      if (!Array.isArray(raw.mediaRoots) || !raw.mediaRoots.every((root) => typeof root === 'string' && path.isAbsolute(root)) || !isObject(raw.sessionRoots)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid managed roots')
      for (const [id, root] of Object.entries(raw.sessionRoots)) if (!isSafeStorageId(id) || typeof root !== 'string' || !path.isAbsolute(root) || !raw.mediaRoots.some((value) => comparePath(value) === comparePath(root))) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid session directory binding')
      for (const [key, asset] of Object.entries(raw.assets)) this.validateManifest(key, asset)
      for (const [id, directory] of Object.entries(raw.configuration.projectTranscriptDirectories)) {
        if (!isSafeStorageId(id) || typeof directory !== 'string' || !path.isAbsolute(directory)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid project directory configuration')
      }
      for (const [key, grant] of Object.entries(raw.grants)) {
        if (!grant || typeof grant.path !== 'string' || !path.isAbsolute(grant.path) || key !== comparePath(grant.path)
          || typeof grant.dev !== 'string' || !/^\d+$/.test(grant.dev) || typeof grant.ino !== 'string' || !/^\d+$/.test(grant.ino)
          || !Number.isFinite(grant.birthtimeMs)) {
          throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid directory grant')
        }
      }
      for (const [key, operation] of Object.entries(raw.operations)) {
        if (operation.id !== key || !['publish', 'delete', 'case-rename'].includes(operation.kind)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid file operation journal')
        if (!validIdentity(operation.stageIdentity)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid publication source identity')
        assertStorageBasename(operation.stageName)
        if (operation.kind === 'case-rename') {
          if (!operation.temporaryName || !/^\.delive-case-[a-f0-9-]+\.[a-z0-9]+$/.test(operation.temporaryName)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid case-rename intermediate')
          assertStorageBasename(operation.temporaryName)
        }
        this.validateManifest(assetKey(operation.asset.sessionId, operation.asset.assetKind), operation.asset)
      }
      for (const directory of [...raw.mediaRoots, ...Object.values(raw.assets).map((asset) => asset.root), ...Object.values(raw.operations).map((intent) => intent.asset.root), raw.configuration.mediaRoot, raw.configuration.defaultTranscriptDirectory, ...Object.values(raw.configuration.projectTranscriptDirectories)]) {
        if (!directory) continue
        if (comparePath(directory) === comparePath(this.defaultMediaRoot)) continue
        const grant = raw.grants[comparePath(directory)]
        if (!grant || comparePath(grant.path) !== comparePath(directory)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Directory is not granted in local configuration')
      }
      raw.migrations ??= {}
      raw.records ??= {}
      if (!isObject(raw.records)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid record file ledger')
      for (const [id, record] of Object.entries(raw.records)) {
        if (!record || id !== record.sessionId || !isSafeStorageId(id) || typeof record.title !== 'string' || !Number.isFinite(record.createdAt)
          || !Number.isSafeInteger(record.titleRevision) || record.titleRevision < 0) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid record title receipt')
      }
      if (!isObject(raw.migrations)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid migration journal')
      for (const [id, migration] of Object.entries(raw.migrations)) {
        if (!migration || migration.id !== id || !isSafeStorageId(id) || !path.isAbsolute(migration.sourceRoot) || !path.isAbsolute(migration.targetRoot)
          || !['copying', 'committed', 'cleaned', 'abandoned'].includes(migration.phase) || !Array.isArray(migration.files)
          || !migration.sourceGrant || !migration.targetGrant) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid migration intent')
        if (comparePath(migration.sourceGrant.path) !== comparePath(migration.sourceRoot) || comparePath(migration.targetGrant.path) !== comparePath(migration.targetRoot)
          || comparePath(migration.sourceRoot) === comparePath(migration.targetRoot)
          || comparePath(migration.sourceRoot).startsWith(comparePath(migration.targetRoot) + path.sep)
          || comparePath(migration.targetRoot).startsWith(comparePath(migration.sourceRoot) + path.sep)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Migration root/grant mismatch')
        if (migration.sourceGrants !== undefined && (!Array.isArray(migration.sourceGrants) || !migration.sourceGrants.length)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid migration source grants')
        const sourceGrants = migration.sourceGrants || [migration.sourceGrant]
        for (const grant of sourceGrants) {
          if (!grant || typeof grant.path !== 'string' || !path.isAbsolute(grant.path) || typeof grant.dev !== 'string' || !/^\d+$/.test(grant.dev) || typeof grant.ino !== 'string' || !/^\d+$/.test(grant.ino) || !Number.isFinite(grant.birthtimeMs)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid migration source directory proof')
          const source = comparePath(grant.path), target = comparePath(migration.targetRoot)
          if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid migration source ancestry')
        }
        for (const file of migration.files) {
          if (file.sourceRoot !== undefined && (typeof file.sourceRoot !== 'string' || !path.isAbsolute(file.sourceRoot))) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid migration file root')
          if (!sourceGrants.some((grant) => comparePath(grant.path) === comparePath(file.sourceRoot || migration.sourceRoot))) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Migration file lacks source grant')
          assertSessionId(file.sessionId)
          assertStorageBasename(file.basename)
          assertStorageBasename(file.stageName)
          if (!validIdentity(file.source?.identity) || !/^[a-f0-9]{64}$/.test(file.source?.sha256) || (file.targetIdentity && !validIdentity(file.targetIdentity))) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid migration file proof')
          if (file.assetKey ? !raw.assets[file.assetKey] || raw.assets[file.assetKey].sessionId !== file.sessionId
            : !['source-audio.pcm.tmp', 'source-audio.json.tmp'].includes(file.basename) && !/^source-audio\.[a-f0-9-]+\.tmp\.wav$/.test(file.basename)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Migration file is not an owned asset/recovery artifact')
        }
      }
      if (raw.recordingRecoveryAcks === undefined) raw.recordingRecoveryAcks = {}
      if (!isObject(raw.recordingRecoveryAcks)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid recording recovery decisions')
      for (const [key, acknowledgement] of Object.entries(raw.recordingRecoveryAcks)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !acknowledgement || !/^[a-f0-9]{64}$/.test(acknowledgement.evidence) || acknowledgement.decision !== 'manually-moved' || !Number.isFinite(acknowledgement.acknowledgedAt)) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid recording recovery decision')
      }
      raw.version = 2
      this.state = raw
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = { version: 2, mediaRoots: [this.defaultMediaRoot], sessionRoots: {}, configuration: { version: 1, mediaRoot: this.defaultMediaRoot, projectTranscriptDirectories: {}, revision: 0 }, grants: {}, assets: {}, operations: {}, migrations: {}, records: {} }
      await assertSafeDirectory(this.defaultMediaRoot, true)
      await writeJsonDurably(this.statePath, this.state)
    }
  }

  private validateManifest(key: string, asset: AssetManifest): void {
    if (!asset || typeof asset.root !== 'string' || !path.isAbsolute(asset.root) || !isSafeStorageId(asset.sessionId) || (asset.assetKind !== 'recording-audio' && asset.assetKind !== 'extracted-audio')
      || key !== assetKey(asset.sessionId, asset.assetKind) || !Number.isSafeInteger(asset.revision) || asset.revision < 1
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !validIdentity(asset.identity)) {
      throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid media manifest')
    }
    assertStorageBasename(asset.fileName)
    if (MIME_TYPES[path.extname(asset.fileName).toLowerCase()] !== asset.mimeType || asset.identity.size !== asset.size) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Invalid managed audio extension or size')
  }

  private async mutate(operation: (state: FileStorageState) => void): Promise<void> {
    await this.initialize()
    const work = this.stateQueue.catch(() => undefined).then(async () => {
      if (this.stateFault) throw this.stateFault
      const next = structuredClone(this.state)
      operation(next)
      await assertSafeDirectory(this.stateDirectory)
      try {
        await writeJsonDurably(this.statePath, next)
        this.state = next
      } catch (error) {
        // Rename may have committed before read-back failed; never overwrite it from stale memory.
        try { await fs.promises.lstat(this.statePath); await this.load() }
        catch { this.stateFault = new FileStorageError('FILE_STORAGE_CORRUPT', 'File state cannot be verified; restart after repairing storage') }
        throw error
      }
    })
    this.stateQueue = work
    await work
  }

  async getConfiguration(): Promise<LocalFileConfiguration> { await this.initialize(); return structuredClone(this.state.configuration) }

  subscribe(listener: (event: LocalFileChange) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  private notifyChanged(activityOnly = false): void {
    const event: LocalFileChange = { sequence: ++this.changeSequence, configurationRevision: this.state?.configuration.revision || 0,
      ...(activityOnly ? { activityOnly: true } : {}) }
    for (const listener of this.changeListeners) {
      try { listener(event) } catch (error) { console.warn('[FileStorage] Change notification failed:', error) }
    }
  }

  async assertGrantedDirectory(directory: string): Promise<void> {
    await this.initialize()
    const isDefault = comparePath(directory) === comparePath(this.defaultMediaRoot)
    try { await assertSafeDirectory(directory) }
    catch (error) {
      if (error instanceof FileStorageError) throw error
      throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', `Configured directory is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isDefault) {
      const grant = this.state.grants[comparePath(directory)]
      const stat = await fs.promises.lstat(directory, { bigint: true })
      if (!grant || grant.dev !== String(stat.dev) || grant.ino !== String(stat.ino) || grant.birthtimeMs !== Number(stat.birthtimeMs)) {
        throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Granted directory identity changed; select it again')
      }
    }
  }

  async sessionDirectory(sessionId: string, create = false, selectedRoot?: string): Promise<string> {
    assertSessionId(sessionId)
    const config = await this.getConfiguration()
    if (create) this.assertMediaMutationAvailable()
    const roots = [...new Set(Object.values(this.state.assets).filter((asset) => asset.sessionId === sessionId && !asset.deleted).map((asset) => asset.root))]
    if (!selectedRoot && roots.length > 1) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Session assets have multiple registered roots')
    const root = selectedRoot || this.state.sessionRoots[sessionId] || roots[0] || config.mediaRoot
    await this.assertGrantedDirectory(root)
    const directory = path.join(root, sessionId)
    await assertSafeDirectory(directory, create)
    if (create && !selectedRoot && !this.state.sessionRoots[sessionId]) await this.mutate((state) => { state.sessionRoots[sessionId] = root })
    return directory
  }

  async managedRoots(includeRetired = false): Promise<string[]> {
    await this.initialize()
    if (includeRetired) return [...this.state.mediaRoots]
    return [...new Map([this.state.configuration.mediaRoot, ...Object.values(this.state.assets).filter((asset) => !asset.deleted).map((asset) => asset.root), ...Object.values(this.state.sessionRoots)].map((root) => [comparePath(root), root])).values()]
  }

  async managedSessionDirectories(): Promise<Array<{ sessionId: string; directory: string }>> {
    const directories: Array<{ sessionId: string; directory: string }> = []
    const seen = new Set<string>()
    for (const root of await this.managedRoots()) {
      try {
      await this.assertGrantedDirectory(root)
      for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !isSafeStorageId(entry.name) || seen.has(entry.name)) continue
        const binding = this.state.sessionRoots[entry.name] || Object.values(this.state.assets).find((asset) => asset.sessionId === entry.name && !asset.deleted)?.root || this.state.configuration.mediaRoot
        if (comparePath(binding) !== comparePath(root)) continue
        directories.push({ sessionId: entry.name, directory: await this.sessionDirectory(entry.name, false, root) })
        seen.add(entry.name)
      }
      } catch (error) {
        if ((error as FileStorageError).code !== 'FILE_STORAGE_UNAVAILABLE') throw error
        console.warn('[FileStorage] Managed recovery directory unavailable:', root)
      }
    }
    return directories
  }

  async listRecordingRecoveryNotices(activeSessionIds?: string[]): Promise<RecordingRecoveryNotice[]> {
    await this.initialize()
    if (activeSessionIds !== undefined && (!Array.isArray(activeSessionIds) || activeSessionIds.length > 10000 || activeSessionIds.some((id) => !isSafeStorageId(id)))) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid recording recovery scope')
    const active = new Set(activeSessionIds || Object.entries(this.state.records).filter(([, record]) => !record.deleted && !record.deleting).map(([id]) => id))
    const items: RecordingRecoveryNotice[] = []
    const span = startPerformanceSpan('native.recovery')
    let successful = false
    try {
      for (const { sessionId, directory } of await this.managedSessionDirectories()) {
        if ([...this.usage.values()].some((lease) => lease.sessionId === sessionId)) continue
        const files: Array<{ name: string; proof: unknown; unsafe: boolean }> = []
        const inspect = async (name: string) => {
          assertStorageBasename(name)
          try {
            const stat = await fs.promises.lstat(path.join(directory, name), { bigint: true })
            const unsafe = !stat.isFile() || stat.isSymbolicLink()
            const file = { name, unsafe, proof: { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), birthtimeNs: String(stat.birthtimeNs), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } }
            files.push(file)
            return file
          } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
        }
        const pcm = await inspect('source-audio.pcm.tmp'), metadata = await inspect('source-audio.json.tmp')
        const pendingStages = Object.values(this.state.operations).filter((intent) => intent.asset.sessionId === sessionId && intent.asset.assetKind === 'recording-audio' && /^source-audio\.[a-f0-9-]+\.tmp\.wav$/.test(intent.stageName))
        for (const intent of pendingStages) await inspect(intent.stageName)
        const group = Boolean(pcm || metadata || pendingStages.length)
        const asset = this.state.assets[assetKey(sessionId, 'recording-audio')]
        if (!group && (active.has(sessionId) || !asset || asset.deleted)) continue
        if (asset && !asset.deleted && comparePath(path.dirname(directory)) === comparePath(asset.root)) await inspect(asset.fileName)
        const unsafe = files.some((file) => file.unsafe)
        // Audio and transcripts may be organized independently; only recovery evidence needs a notice.
        if (!group && !unsafe) continue
        const reason: RecordingRecoveryNotice['reason'] = unsafe ? 'unsafe-recovery-file'
          : !pcm && metadata ? 'missing-pcm' : pcm && !metadata ? 'missing-metadata' : 'pending-group'
        const root = comparePath(path.dirname(directory)), directoryStat = await fs.promises.lstat(directory, { bigint: true })
        const key = createHash('sha256').update(JSON.stringify([root, sessionId])).digest('hex')
        const evidence = createHash('sha256').update(JSON.stringify({ root, sessionId, group, files,
          directory: [String(directoryStat.dev), String(directoryStat.ino), String(directoryStat.birthtimeNs)],
          createdAt: this.state.records[sessionId]?.createdAt, asset: asset && !asset.deleted ? asset : undefined,
          pendingStages: pendingStages.map((intent) => [intent.id, intent.stageName, intent.stageIdentity]) })).digest('hex')
        items.push({ key, evidence, sessionId, reason, acknowledged: this.state.recordingRecoveryAcks?.[key]?.evidence === evidence })
      }
      successful = true
      return items
    } finally { span.finish(successful ? 'success' : 'error', { records: items.length }) }
  }

  async acknowledgeRecordingRecovery(request: { key: string; evidence: string; activeSessionIds: string[] }): Promise<void> {
    if (!request || typeof request.key !== 'string' || typeof request.evidence !== 'string' || !Array.isArray(request.activeSessionIds) || !/^[a-f0-9]{64}$/.test(request.key) || !/^[a-f0-9]{64}$/.test(request.evidence)) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid recording recovery decision')
    const item = (await this.listRecordingRecoveryNotices(request.activeSessionIds)).find((item) => item.key === request.key)
    if (!item || item.evidence !== request.evidence) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Recovery item changed; refresh before acknowledging')
    await this.withSessionLock(item.sessionId, async () => {
      const latest = (await this.listRecordingRecoveryNotices(request.activeSessionIds)).find((candidate) => candidate.key === request.key)
      if (!latest || latest.evidence !== request.evidence) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Recovery item changed; refresh before acknowledging')
      await this.mutate((state) => { state.recordingRecoveryAcks ||= {}; state.recordingRecoveryAcks[request.key] = { evidence: request.evidence, decision: 'manually-moved', acknowledgedAt: Date.now() } })
    })
  }

  async configureMediaDirectory(nativeSelectedParent: string): Promise<LocalFileStatus> {
    await this.withGlobalFileLock(async () => {
      if (Object.keys(this.state.operations).length) throw new FileStorageError('FILE_STORAGE_BUSY', 'Recover pending file operations before changing audio storage')
      await assertSafeDirectory(nativeSelectedParent)
      const root = path.join(await fs.promises.realpath(nativeSelectedParent), 'DeLive-media')
      for (const previous of this.state.mediaRoots) {
        if (comparePath(root) === comparePath(previous)) continue
        if (comparePath(root).startsWith(comparePath(previous) + path.sep) || comparePath(previous).startsWith(comparePath(root) + path.sep)) throw new FileStorageError('FILE_STORAGE_INVALID', 'Managed roots cannot contain one another')
      }
      // Freeze discoverable legacy/recovery locations without requiring old audio to be online.
      const bindings: Record<string, string> = {}
      for (const previous of await this.managedRoots()) {
        try {
          await this.assertGrantedDirectory(previous)
          for (const entry of await fs.promises.readdir(previous, { withFileTypes: true })) {
            if (!entry.isDirectory() || !isSafeStorageId(entry.name) || this.state.sessionRoots[entry.name]) continue
            const directory = await this.sessionDirectory(entry.name, false, previous)
            const names = await fs.promises.readdir(directory)
            if (names.some((name) => LEGACY_AUDIO_NAMES.includes(name) || ['source-audio.pcm.tmp', 'source-audio.json.tmp'].includes(name))) {
              if (bindings[entry.name] && comparePath(bindings[entry.name]) !== comparePath(previous)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Legacy session exists in multiple roots; repair before changing storage')
              bindings[entry.name] = previous
            }
          }
        } catch (error) {
          if ((error as FileStorageError).code !== 'FILE_STORAGE_UNAVAILABLE' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error
        }
      }
      await assertSafeDirectory(root, true)
      const grant = await this.captureDirectory(root)
      const availability = await this.directoryStatus(root, false)
      if (!availability.writable || availability.availableBytes === undefined || availability.availableBytes < 16 * 1024 * 1024) throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', availability.error || 'Audio storage has insufficient verified writable space')
      await this.probeNonReplaceCommit(root)
      await this.verifyDirectory(grant)
      await this.mutate((state) => {
        state.grants[comparePath(root)] = grant
        Object.assign(state.sessionRoots, bindings)
        if (!state.mediaRoots.some((value) => comparePath(value) === comparePath(root))) state.mediaRoots.push(root)
        state.configuration.mediaRoot = root
        state.configuration.revision++
      })
    })
    this.notifyChanged()
    return this.status()
  }

  async directoryStatus(directory: string, requireGrant = true): Promise<StorageDirectoryStatus> {
    try {
      if (requireGrant) await this.assertGrantedDirectory(directory)
      else await assertSafeDirectory(directory)
      let writable = false
      let error: string | undefined
      const probe = path.join(directory, `.delive-write-probe-${randomUUID()}`)
      try {
        const handle = await fs.promises.open(probe, 'wx')
        try { await handle.sync() } finally { await handle.close() }
        await fs.promises.unlink(probe)
        writable = true
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
      const space = await fs.promises.statfs(directory).catch(() => undefined)
      return { path: directory, available: true, writable, availableBytes: space ? space.bavail * space.bsize : undefined, error }
    } catch (error) { return { path: directory, available: false, writable: false, error: error instanceof Error ? error.message : String(error) } }
  }

  async configureTranscriptDirectory(selectedDirectory: string, projectId?: string): Promise<LocalFileStatus> {
    if (projectId !== undefined) assertSessionId(projectId)
    await assertSafeDirectory(selectedDirectory)
    const canonical = await fs.promises.realpath(selectedDirectory)
    const status = await this.directoryStatus(canonical, false)
    if (!status.writable) throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', status.error || 'Selected directory is not writable')
    const stat = await fs.promises.lstat(canonical, { bigint: true })
    await this.mutate((state) => {
      state.grants[comparePath(canonical)] = { path: canonical, dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: Number(stat.birthtimeMs) }
      if (projectId) state.configuration.projectTranscriptDirectories[projectId] = canonical
      else state.configuration.defaultTranscriptDirectory = canonical
      state.configuration.revision++
    })
    this.notifyChanged()
    return this.status()
  }

  async authorizeLocalDirectory(selectedDirectory: string): Promise<void> {
    await assertSafeDirectory(selectedDirectory)
    const grant = await this.captureDirectory(selectedDirectory)
    const status = await this.directoryStatus(grant.path, false)
    if (!status.writable) throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', 'Selected directory is not writable')
    await this.mutate((state) => { state.grants[comparePath(grant.path)] = grant })
  }

  async transcriptDirectory(projectId?: string): Promise<string> {
    const config = await this.getConfiguration()
    const directory = (projectId && config.projectTranscriptDirectories[projectId]) || config.defaultTranscriptDirectory
    if (!directory) throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', 'Choose a transcript directory first')
    await this.assertGrantedDirectory(directory)
    return directory
  }

  async status(): Promise<LocalFileStatus> {
    const configuration = await this.getConfiguration()
    const assets = Object.values(this.state.assets).filter((asset) => !asset.deleted)
    const projectTranscripts: Record<string, StorageDirectoryStatus> = {}
    for (const [id, directory] of Object.entries(configuration.projectTranscriptDirectories)) projectTranscripts[id] = await this.directoryStatus(directory)
    return {
      configuration, media: await this.directoryStatus(configuration.mediaRoot),
      transcript: configuration.defaultTranscriptDirectory ? await this.directoryStatus(configuration.defaultTranscriptDirectory) : undefined,
      projectTranscripts,
      managedAssetCount: assets.length, managedBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
      pendingOperationCount: Object.keys(this.state.operations).length,
      busy: this.usage.size > 0 || this.sessionQueues.size > 0 || this.catalogReaders > 0 || this.globalFileRequest || this.migrationLocked || this.hasCopyingMigration(),
      migrations: Object.values(this.state.migrations).map((migration) => ({
        id: migration.id, sourceRoot: migration.sourceRoot, targetRoot: migration.targetRoot, phase: migration.phase,
        sourceRoots: (migration.sourceGrants || [migration.sourceGrant]).map((grant) => grant.path),
        fileCount: migration.files.length, totalBytes: migration.files.reduce((sum, file) => sum + file.source.identity.size, 0),
        completedFiles: migration.files.filter((file) => file.targetIdentity).length,
        remainingCopies: migration.phase === 'copying' ? 0 : migration.files.filter((file) => !file.cleaned).length,
        remainingBytes: migration.phase === 'copying' ? 0 : migration.files.filter((file) => !file.cleaned).reduce((sum, file) => sum + file.source.identity.size, 0),
        error: migration.error,
      })),
    }
  }

  acquireUsage(sessionId: string, kind: string): string {
    assertSessionId(sessionId)
    if (this.globalFileRequest || this.migrationLocked || this.hasCopyingMigration() || this.sessionQueues.has(sessionId) || [...this.usage.values()].some((usage) => usage.sessionId === sessionId)) {
      throw new FileStorageError('FILE_STORAGE_BUSY', 'Media is busy; retry when the current operation finishes')
    }
    const token = randomUUID()
    this.usage.set(token, { sessionId, kind })
    return token
  }

  releaseUsage(token: string): void {
    const sessionId = this.usage.get(token)?.sessionId
    this.usage.delete(token)
    this.notifyChanged()
    if (sessionId) void this.drainManagedNaming(sessionId).catch((error: unknown) => console.warn('[FileNaming] Deferred naming failed:', error))
  }

  async withSessionLock<T>(sessionId: string, operation: () => Promise<T>, ownerToken?: string): Promise<T> {
    assertSessionId(sessionId)
    if (this.migrationLocked || [...this.usage.entries()].some(([token, usage]) => usage.sessionId === sessionId && token !== ownerToken)
      || (ownerToken && this.usage.get(ownerToken)?.sessionId !== sessionId)) {
      throw new FileStorageError('FILE_STORAGE_BUSY', 'Media has an active recording, extraction or read lease')
    }
    const previous = this.sessionQueues.get(sessionId) || Promise.resolve()
    const work = previous.catch(() => undefined).then(() => {
      if (ownerToken && this.usage.get(ownerToken)?.sessionId !== sessionId) throw new FileStorageError('FILE_STORAGE_BUSY', 'Producer lease expired before operation dispatch')
      return operation()
    })
    this.sessionQueues.set(sessionId, work)
    try { return await work }
    finally { if (this.sessionQueues.get(sessionId) === work) this.sessionQueues.delete(sessionId) }
  }

  private async descriptor(asset: AssetManifest): Promise<ManagedAudioAsset> {
    const directory = await this.sessionDirectory(asset.sessionId, false, asset.root)
    const target = path.join(directory, asset.fileName)
    const actual = await inspectRegularFile(target)
    if (actual.sha256 !== asset.sha256 || !sameFileIdentity(actual.identity, asset.identity)) {
      throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Managed audio was modified or replaced externally')
    }
    return { sessionId: asset.sessionId, assetKind: asset.assetKind, revision: asset.revision, path: target, fileName: asset.fileName, mimeType: asset.mimeType, size: asset.size, sha256: asset.sha256 }
  }

  async resolveAsset(sessionId: string, kind?: ManagedAssetKind): Promise<ManagedAudioAsset> {
    assertSessionId(sessionId)
    await this.initialize()
    const manifests = Object.values(this.state.assets).filter((asset) => asset.sessionId === sessionId && (!kind || asset.assetKind === kind))
    const live = manifests.filter((asset) => !asset.deleted)
    if (live.length > 1) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Multiple managed assets; choose an asset kind')
    if (live.length === 1) return this.descriptor(live[0])
    if (manifests.length) throw new FileStorageError('FILE_STORAGE_MISSING', 'Managed audio was explicitly deleted')
    if (Object.values(this.state.operations).some((intent) => intent.asset.sessionId === sessionId && (!kind || intent.asset.assetKind === kind))) {
      throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Pending publication requires recovery before legacy discovery')
    }
    const binding = this.state.sessionRoots[sessionId]
    const candidates: Array<{ root: string; fileName: string; identity: FileIdentity; sha256: string }> = []
    let unavailable: unknown
    for (const root of binding ? [binding] : this.state.mediaRoots) {
      let directory: string
      try { directory = await this.sessionDirectory(sessionId, false, root) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        if ((error as FileStorageError).code === 'FILE_STORAGE_UNAVAILABLE') { unavailable = error; continue }
        throw error
      }
      for (const fileName of LEGACY_AUDIO_NAMES) {
        try { candidates.push({ root, fileName, ...await inspectRegularFile(path.join(directory, fileName)) }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    }
    if (unavailable) throw unavailable
    if (candidates.length !== 1) throw new FileStorageError(candidates.length ? 'FILE_STORAGE_CONFLICT' : 'FILE_STORAGE_MISSING', 'Legacy audio is missing or ambiguous; no file was guessed')
    const candidate = candidates[0]
    if (!candidate.identity.size) throw new FileStorageError('FILE_STORAGE_MISSING', 'Managed audio is empty')
    const assetKind: ManagedAssetKind = path.extname(candidate.fileName) === '.mp3' ? 'extracted-audio' : 'recording-audio'
    if (kind && kind !== assetKind) throw new FileStorageError('FILE_STORAGE_MISSING', 'Requested asset kind is unavailable')
    const asset: AssetManifest = { ...candidate, sessionId, assetKind, revision: 1, size: candidate.identity.size, mimeType: MIME_TYPES[path.extname(candidate.fileName)] }
    await this.mutate((state) => { state.assets[assetKey(sessionId, assetKind)] = asset; state.sessionRoots[sessionId] ??= candidate.root })
    return this.descriptor(asset)
  }

  async publishAsset(sessionId: string, kind: ManagedAssetKind, stageName: string, fileName: string): Promise<ManagedAudioAsset> {
    await this.initialize()
    this.assertMediaMutationAvailable()
    this.assertRecordWritable(sessionId)
    assertStorageBasename(stageName)
    assertStorageBasename(fileName)
    if (!MIME_TYPES[path.extname(fileName).toLowerCase()] || stageName === fileName) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid managed publication names')
    const directory = await this.sessionDirectory(sessionId)
    const stage = await inspectRegularFile(path.join(directory, stageName))
    const handle = await fs.promises.open(path.join(directory, stageName), 'r+')
    try {
      if (!sameFileIdentity(stage.identity, fileIdentity(await handle.stat({ bigint: true })))) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Publication stage identity changed')
      await handle.sync()
    } finally { await handle.close() }
    if (stage.identity.size <= 0) throw new FileStorageError('FILE_STORAGE_MISSING', 'Cannot publish empty audio')
    const existing = this.state.assets[assetKey(sessionId, kind)]
    if (existing && !existing.deleted) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'An asset registration already exists; do not overwrite it')
    if (Object.values(this.state.operations).some((intent) => intent.asset.sessionId === sessionId && intent.asset.assetKind === kind)) {
      throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Recover the existing operation before publishing again')
    }
    const intent: PublicationIntent = {
      id: randomUUID(), kind: 'publish', stageName, stageIdentity: stage.identity,
      asset: { root: path.dirname(directory), sessionId, assetKind: kind, fileName, mimeType: MIME_TYPES[path.extname(fileName).toLowerCase()], size: stage.identity.size, revision: (existing?.revision || 0) + 1, identity: stage.identity, sha256: stage.sha256 },
    }
    await this.mutate((state) => { state.operations[intent.id] = intent })
    return this.finishPublication(intent)
  }

  private async finishPublication(intent: PublicationIntent): Promise<ManagedAudioAsset> {
    this.assertRecordWritable(intent.asset.sessionId)
    const directory = await this.sessionDirectory(intent.asset.sessionId, false, intent.asset.root)
    const stagePath = path.join(directory, intent.stageName)
    const finalPath = path.join(directory, intent.asset.fileName)
    if (comparePath(stagePath) === comparePath(finalPath)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Publication source aliases destination; no cleanup allowed')
    if (!intent.committed) {
      try {
        const stage = await inspectRegularFile(stagePath)
        if (stage.sha256 !== intent.asset.sha256 || !sameFileIdentity(stage.identity, intent.asset.identity)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Publication temporary file changed')
        // Same-directory hard-link creation is atomic and never replaces an existing target.
        await fs.promises.link(stagePath, finalPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const actual = await inspectRegularFile(finalPath)
      if (actual.sha256 !== intent.asset.sha256 || actual.identity.size !== intent.asset.size) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Publication destination differs; nothing was overwritten')
      const asset = { ...intent.asset, identity: actual.identity }
      await this.mutate((state) => {
        const record = state.records[asset.sessionId]
        if (record?.deleted || record?.deleting) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Record deletion prevents file publication')
        state.assets[assetKey(asset.sessionId, asset.assetKind)] = asset
        state.operations[intent.id] = { ...intent, asset, committed: true }
      })
      intent = { ...intent, asset, committed: true }
    }
    const result = await this.descriptor(intent.asset)
    try {
      const stage = await inspectRegularFile(stagePath)
      if (stage.sha256 !== intent.asset.sha256 || !sameFileIdentity(stage.identity, intent.stageIdentity)) {
        throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Publication temporary file changed; cleanup paused')
      }
      await fs.promises.unlink(stagePath)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await this.mutate((state) => { delete state.operations[intent.id] })
    return result
  }

  private async finishCaseRename(intent: PublicationIntent): Promise<ManagedAudioAsset> {
    this.assertRecordWritable(intent.asset.sessionId)
    if (process.platform !== 'win32' || !intent.temporaryName) throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', 'Protected case rename is unavailable')
    const directory = await this.sessionDirectory(intent.asset.sessionId, false, intent.asset.root)
    const source = path.join(directory, intent.stageName)
    const target = path.join(directory, intent.asset.fileName)
    const temporary = path.join(directory, intent.temporaryName)
    if (comparePath(source) !== comparePath(target) || intent.stageName === intent.asset.fileName) throw new FileStorageError('FILE_STORAGE_INVALID', 'Not a case-only naming intent')
    const verify = async (file: string) => {
      const proof = await inspectRegularFile(file)
      if (proof.sha256 !== intent.asset.sha256 || proof.identity.size !== intent.asset.size
        || proof.identity.dev !== intent.stageIdentity.dev || proof.identity.ino !== intent.stageIdentity.ino) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Case-rename source changed; files retained')
      return proof
    }
    let names = await fs.promises.readdir(directory)
    const hasTemporary = names.includes(intent.temporaryName)
    const matchingNames = names.filter((name) => name.toLowerCase() === intent.asset.fileName.toLowerCase())
    if (matchingNames.length > 1 || (hasTemporary && matchingNames.length)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Multiple case-rename paths exist; files retained')
    if (!names.includes(intent.asset.fileName)) {
      if (!hasTemporary) {
        if (!names.includes(intent.stageName)) throw new FileStorageError('FILE_STORAGE_MISSING', 'Case-rename source and intermediate are missing')
        const proof = await verify(source)
        await protectedWindowsFileOperation({ action: 'move', source, target: temporary, ...proof })
      }
      const proof = await verify(temporary)
      this.assertRecordWritable(intent.asset.sessionId)
      await protectedWindowsFileOperation({ action: 'move', source: temporary, target, ...proof })
    }
    names = await fs.promises.readdir(directory)
    if (!names.includes(intent.asset.fileName) || names.includes(intent.temporaryName)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Case-rename target spelling did not commit')
    const proof = await verify(target)
    const asset = { ...intent.asset, identity: proof.identity }
    await this.mutate((state) => {
      const record = state.records[asset.sessionId]
      if (record?.deleted || record?.deleting) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Deleted record cannot commit naming')
      state.assets[assetKey(asset.sessionId, asset.assetKind)] = asset
      delete state.operations[intent.id]
    })
    return this.descriptor(asset)
  }

  private hasCopyingMigration(): boolean {
    return Boolean(this.state?.migrations && Object.values(this.state.migrations).some((migration) => migration.phase === 'copying'))
  }

  private assertRecordWritable(sessionId: string): void {
    if (this.state.records[sessionId]?.deleted || this.state.records[sessionId]?.deleting) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Record was deleted; file callbacks cannot recreate it')
  }

  async registerSessionContext(context: SessionFileContext, nameFiles = false): Promise<ManagedNamingState | undefined> {
    assertSessionId(context.sessionId)
    if (!context.title.trim() || !Number.isSafeInteger(context.titleRevision) || context.titleRevision < 0 || !Number.isFinite(context.createdAt)) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid saved-title context')
    await this.initialize()
    this.assertRecordWritable(context.sessionId)
    const span = startPerformanceSpan('native.register-context')
    let successful = false, needsNaming = false, writes = 0
    try {
    await this.withRecordGuard(context.sessionId, async () => {
      this.assertRecordWritable(context.sessionId)
      const previous = this.state.records[context.sessionId]
      if (previous && previous.titleRevision > context.titleRevision) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Saved-title revision is stale')
      if (previous && previous.titleRevision === context.titleRevision && previous.title !== context.title) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Equal title revision has different content')
      const same = previous?.titleRevision === context.titleRevision && previous.title === context.title && previous.createdAt === context.createdAt
      const filesCurrent = Object.values(this.state.assets).filter((asset) => asset.sessionId === context.sessionId && !asset.deleted).every((asset) => {
        const directory = path.join(asset.root, context.sessionId)
        try { return asset.fileName === buildStorageFileName(context, path.extname(asset.fileName).slice(1), undefined, Math.min(220, process.platform === 'win32' ? 258 - directory.length : 220)) }
        catch { return false }
      })
      const producerActive = [...this.usage.values()].some((lease) => lease.sessionId === context.sessionId)
      if (same && (!nameFiles || (previous.naming?.status === 'saved' && filesCurrent && !producerActive))) return
      needsNaming = nameFiles
      await this.mutate((state) => { state.records[context.sessionId] = { ...state.records[context.sessionId], ...context, ...(nameFiles ? { naming: { status: 'queued', titleRevision: context.titleRevision } } : {}) } })
      writes++
    })
    if (needsNaming) await this.drainManagedNaming(context.sessionId)
    successful = true
    return this.state.records[context.sessionId]?.naming
    } finally { span.finish(successful ? 'success' : 'error', { writes }) }
  }

  async recordDeletion(sessionId: string, phase: 'prepare' | 'commit' | 'cancel'): Promise<void> {
    assertSessionId(sessionId)
    await this.withRecordGuard(sessionId, () => this.mutate((state) => {
      const record = state.records[sessionId] || { sessionId, title: sessionId, createdAt: 0, titleRevision: 0 }
      state.records[sessionId] = { ...record, deleting: phase === 'prepare', deleted: phase === 'commit' || record.deleted === true, naming: undefined }
    }))
    this.notifyChanged()
  }

  async getSessionContext(sessionId: string): Promise<SessionFileContext> {
    await this.initialize()
    this.assertRecordWritable(sessionId)
    const record = this.state.records[sessionId]
    if (!record) throw new FileStorageError('FILE_STORAGE_MISSING', 'Record must be registered before file operations')
    return { sessionId, title: record.title, createdAt: record.createdAt, titleRevision: record.titleRevision }
  }

  async withRecordGuard<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    assertSessionId(sessionId)
    const previous = this.recordGuards.get(sessionId) || Promise.resolve()
    const work = previous.catch(() => undefined).then(operation)
    this.recordGuards.set(sessionId, work)
    try { return await work } finally { if (this.recordGuards.get(sessionId) === work) this.recordGuards.delete(sessionId) }
  }

  async reconcileRecordBindings(contexts: SessionFileContext[], deletedIds: string[]): Promise<void> {
    if (!Array.isArray(contexts) || !Array.isArray(deletedIds) || contexts.length > 10000 || deletedIds.length > 10000) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid file record binding scope')
    await this.initialize()
    const deleted = new Set(deletedIds)
    for (const context of contexts) {
      assertSessionId(context.sessionId)
      if (!context.title.trim() || !Number.isFinite(context.createdAt) || !Number.isSafeInteger(context.titleRevision) || context.titleRevision < 0) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid record context')
      if (deleted.has(context.sessionId)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Active record conflicts with deleted-result snapshot')
      await this.withRecordGuard(context.sessionId, async () => {
        const existing = this.state.records[context.sessionId]
        if (existing && !existing.deleted && !existing.deleting && existing.titleRevision === context.titleRevision && existing.title === context.title && existing.createdAt === context.createdAt) return
        await this.mutate((state) => {
        // IndexedDB restore/load is authoritative for logical metadata, never for directory/source grants.
        const previous = state.records[context.sessionId]
        const pending = previous?.naming?.status === 'queued' && !previous.deleted && !previous.deleting
        const sameContext = previous?.titleRevision === context.titleRevision && previous.title === context.title && previous.createdAt === context.createdAt
        state.records[context.sessionId] = { ...context, deleted: false, deleting: false,
          naming: pending ? { status: 'queued', titleRevision: context.titleRevision } : sameContext ? previous?.naming : undefined }
        })
      })
    }
    for (const id of deletedIds) await this.recordDeletion(id, 'commit')
    await this.recoverPublications()
    for (const context of contexts) await this.drainManagedNaming(context.sessionId)
  }

  async previewManagedNames(contexts: SessionFileContext[], owner: number) {
    if (!Array.isArray(contexts) || contexts.length > 10000) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid naming scope')
    const items: Array<{ sessionId: string; oldName: string; newName: string; revision: number }> = []
    for (const context of contexts) {
      await this.registerSessionContext(context, false)
      let asset: ManagedAudioAsset
      try { asset = await this.withSessionLock(context.sessionId, () => this.resolveAsset(context.sessionId)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as FileStorageError).code === 'FILE_STORAGE_MISSING') continue; throw error }
      const directory = path.dirname(asset.path)
      const name = buildStorageFileName(context, path.extname(asset.fileName).slice(1), undefined, Math.min(220, process.platform === 'win32' ? 258 - directory.length : 220))
      if (name !== asset.fileName) items.push({ sessionId: context.sessionId, oldName: asset.fileName, newName: name, revision: asset.revision })
    }
    const token = randomUUID()
    this.batchNaming.set(token, { owner, expiresAt: Date.now() + 5 * 60_000, contexts: structuredClone(contexts), items })
    return { token, items }
  }

  getManagedNamingPreview(token: string, owner: number) {
    const preview = this.batchNaming.get(token)
    if (!preview || preview.owner !== owner || preview.expiresAt < Date.now()) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Naming preview expired')
    return structuredClone(preview)
  }

  async applyManagedNames(token: string, owner: number): Promise<void> {
    const preview = this.getManagedNamingPreview(token, owner)
    this.batchNaming.delete(token)
    for (const item of preview.items) {
      const current = await this.resolveAsset(item.sessionId)
      const expected = preview.contexts.find((context) => context.sessionId === item.sessionId)!
      const context = await this.getSessionContext(item.sessionId)
      if (current.revision !== item.revision || context.titleRevision !== expected.titleRevision || context.title !== expected.title) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Title/asset changed; preview again')
    }
    for (const item of preview.items) await this.registerSessionContext(preview.contexts.find((context) => context.sessionId === item.sessionId)!, true)
  }

  async drainManagedNaming(sessionId: string): Promise<void> {
    await this.initialize()
    const record = this.state.records[sessionId]
    if (!record?.naming || record.naming.status !== 'queued' || record.deleted || record.deleting) return
    if (this.migrationLocked || this.hasCopyingMigration() || [...this.usage.values()].some((lease) => lease.sessionId === sessionId)) return
    try {
      await this.withSessionLock(sessionId, async () => {
        const current = this.state.records[sessionId]
        if (!current?.naming || current.deleted || current.deleting) return
        if (Object.values(this.state.operations).some((intent) => intent.asset.sessionId === sessionId)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Existing file journal must finish before another naming intent')
        const revision = current.titleRevision
        const assets = Object.values(this.state.assets).filter((asset) => asset.sessionId === sessionId && !asset.deleted)
        for (const asset of assets) {
          const directory = await this.sessionDirectory(sessionId, false, asset.root)
          const limit = Math.min(220, process.platform === 'win32' ? 258 - directory.length : 220)
          const basename = buildStorageFileName(current, path.extname(asset.fileName).slice(1), undefined, limit)
          if (basename === asset.fileName) continue
          const caseOnly = process.platform === 'win32' && asset.fileName.toLowerCase() === basename.toLowerCase()
          const intent: PublicationIntent = { id: randomUUID(), kind: caseOnly ? 'case-rename' : 'publish', stageName: asset.fileName, stageIdentity: asset.identity,
            ...(caseOnly ? { temporaryName: `.delive-case-${randomUUID()}${path.extname(asset.fileName).toLowerCase()}` } : {}),
            asset: { ...asset, fileName: basename, revision: asset.revision + 1 } }
          await this.mutate((state) => { state.operations[intent.id] = intent })
          if (caseOnly) await this.finishCaseRename(intent)
          else await this.finishPublication(intent)
        }
        await this.mutate((state) => { const latest = state.records[sessionId]; if (latest.titleRevision === revision) latest.naming = { status: 'saved', titleRevision: revision } })
      })
    } catch (error) {
      await this.mutate((state) => { const latest = state.records[sessionId]; if (latest) latest.naming = { status: 'error', titleRevision: latest.titleRevision, error: error instanceof Error ? error.message : String(error) } })
    }
    this.notifyChanged()
  }

  private assertMediaMutationAvailable(): void {
    if (this.globalFileRequest || this.migrationLocked || this.hasCopyingMigration()) throw new FileStorageError('FILE_STORAGE_BUSY', 'Resolve the pending media migration before modifying audio')
  }

  private async withGlobalFileLock<T>(operation: () => Promise<T>, allowCopying = false): Promise<T> {
    await this.initialize()
    if (this.globalFileRequest || this.migrationLocked || this.usage.size || (!this.catalogReaders && this.sessionQueues.size)
      || (!allowCopying && this.hasCopyingMigration())) throw new FileStorageError('FILE_STORAGE_BUSY', 'Recording or file operations are still active')
    // Reserve before waiting: scans triggered by file events must not starve a user request.
    this.globalFileRequest = true
    this.notifyChanged(true)
    try {
      if (this.catalogReaders) await new Promise<void>((resolve) => { this.catalogDrainWaiters.add(resolve) })
      // An actual file operation may have started while the catalog was finishing.
      if (this.usage.size || this.sessionQueues.size || (!allowCopying && this.hasCopyingMigration())) {
        throw new FileStorageError('FILE_STORAGE_BUSY', 'Recording or file operations are still active')
      }
      this.migrationLocked = true
      return await operation()
    } finally {
      this.migrationLocked = false
      this.globalFileRequest = false
      this.notifyChanged(true)
    }
  }

  private async captureDirectory(directory: string): Promise<DirectoryGrant> {
    await assertSafeDirectory(directory)
    const stat = await fs.promises.lstat(directory, { bigint: true })
    return { path: await fs.promises.realpath(directory), dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: Number(stat.birthtimeMs) }
  }

  private async verifyDirectory(grant: DirectoryGrant): Promise<void> {
    const current = await this.captureDirectory(grant.path)
    if (current.dev !== grant.dev || current.ino !== grant.ino || current.birthtimeMs !== grant.birthtimeMs || comparePath(current.path) !== comparePath(grant.path)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Migration directory identity changed')
  }

  private async collectMigrationFiles(): Promise<{ files: MigrationFile[]; unknown: number }> {
    const roots = await this.managedRoots()
    const files: MigrationFile[] = []
    let unknown = 0
    for (const root of roots) {
    await this.assertGrantedDirectory(root)
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isSafeStorageId(entry.name)) { unknown++; continue }
      const directory = await this.sessionDirectory(entry.name, false, root)
      const known = new Set<string>()
      let manifests = Object.entries(this.state.assets).filter(([, asset]) => asset.sessionId === entry.name)
      const names = await fs.promises.readdir(directory)
      const binding = this.state.sessionRoots[entry.name]
      const isBoundRoot = !binding || comparePath(binding) === comparePath(root)
      if (!manifests.length && isBoundRoot && names.some((name) => LEGACY_AUDIO_NAMES.includes(name))) {
        if (!binding) await this.mutate((state) => { state.sessionRoots[entry.name] = root })
        try { await this.resolveAsset(entry.name); manifests = Object.entries(this.state.assets).filter(([, asset]) => asset.sessionId === entry.name) }
        catch (error) { if ((error as FileStorageError).code !== 'FILE_STORAGE_MISSING' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      for (const [key, asset] of manifests.filter(([, asset]) => !asset.deleted && comparePath(asset.root) === comparePath(root))) {
        await this.descriptor(asset)
        known.add(asset.fileName)
        files.push({ sourceRoot: root, sessionId: entry.name, basename: asset.fileName, assetKey: key, source: { identity: asset.identity, sha256: asset.sha256 }, stageName: `.delive-migrate-${randomUUID()}.tmp` })
      }
      for (const basename of isBoundRoot ? ['source-audio.pcm.tmp', 'source-audio.json.tmp'] : []) {
        try {
          const proof = await inspectRegularFile(path.join(directory, basename))
          if (!this.state.sessionRoots[entry.name]) await this.mutate((state) => { state.sessionRoots[entry.name] = root })
          known.add(basename)
          files.push({ sourceRoot: root, sessionId: entry.name, basename, source: proof, stageName: `.delive-migrate-${randomUUID()}.tmp` })
          if (basename === 'source-audio.json.tmp' && proof.identity.size <= 64 * 1024) {
            let metadata: { sessionId?: string; finalizationStage?: string } | undefined
            try { metadata = JSON.parse(await fs.promises.readFile(path.join(directory, basename), 'utf8')) as typeof metadata } catch { /* Preserve invalid metadata without interpreting PCM. */ }
            if (metadata?.sessionId === entry.name && typeof metadata.finalizationStage === 'string' && /^source-audio\.[a-f0-9-]+\.tmp\.wav$/.test(metadata.finalizationStage)) {
              try {
                const stage = await inspectRegularFile(path.join(directory, metadata.finalizationStage))
                known.add(metadata.finalizationStage)
                files.push({ sourceRoot: root, sessionId: entry.name, basename: metadata.finalizationStage, source: stage, stageName: `.delive-migrate-${randomUUID()}.tmp` })
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      unknown += (await fs.promises.readdir(directory)).filter((name) => !known.has(name)).length
    }
    }
    for (const asset of Object.values(this.state.assets).filter((asset) => !asset.deleted)) await this.descriptor(asset)
    const destinations = new Set<string>()
    for (const file of files) {
      const key = comparePath(path.join(file.sessionId, file.basename))
      if (destinations.has(key)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Multiple managed sources target the same session filename')
      destinations.add(key)
    }
    return { files, unknown }
  }

  private async probeNonReplaceCommit(directory: string): Promise<void> {
    const source = path.join(directory, `.delive-commit-probe-${randomUUID()}`)
    const target = `${source}.link`
    await fs.promises.writeFile(source, 'probe', { flag: 'wx' })
    try { await fs.promises.link(source, target) }
    catch { throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', 'Target filesystem does not support safe non-replacing publication; choose an NTFS-compatible directory') }
    finally { await fs.promises.unlink(target).catch(() => undefined); await fs.promises.unlink(source).catch(() => undefined) }
  }

  async previewMigration(nativeSelectedParent: string, owner: number): Promise<MediaMigrationPreview> {
    return this.withGlobalFileLock(async () => {
      if (Object.keys(this.state.operations).length) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Recover pending file operations before migration')
      await assertSafeDirectory(nativeSelectedParent)
      const sourceRoot = this.state.configuration.mediaRoot
      const sourceRoots = await this.managedRoots()
      const targetRoot = path.join(await fs.promises.realpath(nativeSelectedParent), 'DeLive-media')
      const targetKey = comparePath(targetRoot)
      for (const root of sourceRoots) {
        const sourceKey = comparePath(root)
        if (sourceKey === targetKey || sourceKey.startsWith(targetKey + path.sep) || targetKey.startsWith(sourceKey + path.sep)) throw new FileStorageError('FILE_STORAGE_INVALID', 'Source and target cannot be equal or ancestors of one another')
      }
      await assertSafeDirectory(targetRoot, true)
      const sourceGrant = await this.captureDirectory(sourceRoot)
      const sourceGrants = await Promise.all(sourceRoots.map((root) => this.captureDirectory(root)))
      const targetGrant = await this.captureDirectory(targetRoot)
      const { files, unknown } = await this.collectMigrationFiles()
      let reusedFileCount = 0
      let requiredCopyBytes = 0
      for (const file of files) {
        const directory = path.join(targetRoot, file.sessionId)
        try {
          await assertSafeDirectory(directory)
          const target = await inspectRegularFile(path.join(directory, file.basename))
          if (target.sha256 !== file.source.sha256 || target.identity.size !== file.source.identity.size) throw new FileStorageError('FILE_STORAGE_CONFLICT', `Migration target conflicts: ${file.basename}`)
          reusedFileCount++
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          requiredCopyBytes += file.source.identity.size
        }
      }
      const status = await this.directoryStatus(targetRoot, false)
      if (!status.writable || status.availableBytes === undefined || status.availableBytes < requiredCopyBytes + 16 * 1024 * 1024) throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', status.error || 'Target has insufficient verified writable space')
      await this.probeNonReplaceCommit(targetRoot)
      const token = randomUUID()
      const preview: MediaMigrationPreview = { token, sourceRoot, sourceRoots, targetRoot, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.source.identity.size, 0), requiredCopyBytes, availableBytes: status.availableBytes, reusedFileCount, unknownEntryCount: unknown, expiresAt: Date.now() + 10 * 60_000 }
      for (const [key, selection] of this.migrationSelections) if (selection.owner === owner || selection.preview.expiresAt < Date.now()) this.migrationSelections.delete(key)
      this.migrationSelections.set(token, { owner, preview, configurationRevision: this.state.configuration.revision, intent: { id: randomUUID(), sourceRoot, targetRoot, sourceGrant, sourceGrants, targetGrant, phase: 'copying', files } })
      return structuredClone(preview)
    })
  }

  async applyMigration(token: string, owner: number): Promise<string> {
    const selection = this.migrationSelections.get(token)
    this.migrationSelections.delete(token)
    if (!selection || selection.owner !== owner || selection.preview.expiresAt < Date.now()) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Migration preview expired or belongs to another window')
    const id = selection.intent.id
    try { await this.withGlobalFileLock(async () => {
      if (this.state.configuration.revision !== selection.configurationRevision || comparePath(this.state.configuration.mediaRoot) !== comparePath(selection.intent.sourceRoot)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Directory configuration changed; preview again')
      await this.verifyDirectory(selection.intent.sourceGrant)
      for (const grant of selection.intent.sourceGrants || []) await this.verifyDirectory(grant)
      await this.verifyDirectory(selection.intent.targetGrant)
      await this.mutate((state) => { state.migrations[id] = selection.intent; state.grants[comparePath(selection.intent.targetRoot)] = selection.intent.targetGrant })
      await this.finishMigration(id)
    }) } finally { this.notifyChanged() }
    return id
  }

  getMigrationPreview(token: string, owner: number): MediaMigrationPreview {
    const selection = this.migrationSelections.get(token)
    if (!selection || selection.owner !== owner || selection.preview.expiresAt < Date.now()) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Migration preview expired or belongs to another window')
    return structuredClone(selection.preview)
  }

  private async finishMigration(id: string): Promise<void> {
    const migration = this.state.migrations[id]
    if (!migration || migration.phase !== 'copying') return
    try {
      if (comparePath(this.state.configuration.mediaRoot) !== comparePath(migration.sourceRoot)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Migration source no longer matches configured root')
      await this.verifyDirectory(migration.sourceGrant)
      for (const grant of migration.sourceGrants || []) await this.verifyDirectory(grant)
      await this.verifyDirectory(migration.targetGrant)
      for (let index = 0; index < migration.files.length; index++) {
        let file = this.state.migrations[id].files[index]
        const sourcePath = path.join(file.sourceRoot || migration.sourceRoot, file.sessionId, file.basename)
        await assertSafeDirectory(path.dirname(sourcePath))
        const source = await inspectRegularFile(sourcePath)
        if (source.sha256 !== file.source.sha256 || !sameFileIdentity(source.identity, file.source.identity)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Migration source changed; no root switch')
        const directory = path.join(migration.targetRoot, file.sessionId)
        await assertSafeDirectory(directory, true)
        const targetPath = path.join(directory, file.basename)
        let target: Awaited<ReturnType<typeof inspectRegularFile>> | undefined
        try { target = await inspectRegularFile(targetPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (!target) {
          let stagePath = path.join(directory, file.stageName)
          let stage: Awaited<ReturnType<typeof inspectRegularFile>> | undefined
          try { stage = await inspectRegularFile(stagePath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          if (stage && (stage.sha256 !== file.source.sha256 || stage.identity.size !== file.source.identity.size)) {
            const fresh = `.delive-migrate-${randomUUID()}.tmp`
            await this.mutate((state) => { state.migrations[id].files[index].stageName = fresh })
            file = this.state.migrations[id].files[index]
            stagePath = path.join(directory, fresh)
            stage = undefined
          }
          if (!stage) { await fs.promises.copyFile(sourcePath, stagePath, fs.constants.COPYFILE_EXCL); stage = await inspectRegularFile(stagePath) }
          if (stage.sha256 !== file.source.sha256 || stage.identity.size !== file.source.identity.size) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Copied audio failed size/hash verification')
          const handle = await fs.promises.open(stagePath, 'r+')
          try { if (!sameFileIdentity(stage.identity, fileIdentity(await handle.stat({ bigint: true })))) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Migration stage changed'); await handle.sync() } finally { await handle.close() }
          try { await fs.promises.link(stagePath, targetPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
          target = await inspectRegularFile(targetPath)
        }
        if (target.sha256 !== file.source.sha256 || target.identity.size !== file.source.identity.size) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Target changed; nothing was overwritten')
        if (file.targetIdentity && !sameFileIdentity(target.identity, file.targetIdentity)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Previously committed target was replaced')
        await this.mutate((state) => { state.migrations[id].files[index].targetIdentity = target!.identity })
        const stagePath = path.join(directory, file.stageName)
        try {
          const stage = await inspectRegularFile(stagePath)
          if (stage.sha256 === file.source.sha256 && stage.identity.ino === target.identity.ino && stage.identity.dev === target.identity.dev) await fs.promises.unlink(stagePath)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      const currentScope = (await this.collectMigrationFiles()).files
      const sourceKey = (file: MigrationFile) => comparePath(path.join(file.sourceRoot || migration.sourceRoot, file.sessionId, file.basename))
      const expected = new Map(migration.files.map((file) => [sourceKey(file), file]))
      if (currentScope.length !== expected.size || currentScope.some((file) => {
        const before = expected.get(sourceKey(file))
        return !before || before.source.sha256 !== file.source.sha256 || !sameFileIdentity(before.source.identity, file.source.identity)
      })) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Source scope changed; no root switch')
      await this.verifyDirectory(migration.sourceGrant)
      for (const grant of migration.sourceGrants || []) await this.verifyDirectory(grant)
      await this.verifyDirectory(migration.targetGrant)
      for (const file of this.state.migrations[id].files) {
        await assertSafeDirectory(path.join(migration.targetRoot, file.sessionId))
        const target = await inspectRegularFile(path.join(migration.targetRoot, file.sessionId, file.basename))
        if (!file.targetIdentity || !sameFileIdentity(target.identity, file.targetIdentity) || target.sha256 !== file.source.sha256) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Target changed before root commit')
      }
      await this.mutate((state) => {
        const intent = state.migrations[id]
        for (const file of intent.files) {
          if (!file.assetKey) continue
          const asset = state.assets[file.assetKey]
          if (!asset || asset.sha256 !== file.source.sha256 || !sameFileIdentity(asset.identity, file.source.identity) || !file.targetIdentity) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Asset changed before root switch')
          state.assets[file.assetKey] = { ...asset, root: intent.targetRoot, identity: file.targetIdentity, revision: asset.revision + 1 }
        }
        for (const file of intent.files) state.sessionRoots[file.sessionId] = intent.targetRoot
        if (!state.mediaRoots.some((root) => comparePath(root) === comparePath(intent.targetRoot))) state.mediaRoots.push(intent.targetRoot)
        state.configuration.mediaRoot = intent.targetRoot
        state.configuration.revision++
        intent.phase = 'committed'
        intent.error = undefined
      })
    } catch (error) {
      await this.mutate((state) => { if (state.migrations[id]) state.migrations[id].error = error instanceof Error ? error.message : String(error) }).catch(() => undefined)
      throw error
    }
  }

  async resumeMigration(id: string): Promise<void> {
    try { await this.withGlobalFileLock(() => this.finishMigration(id), true) } finally { this.notifyChanged() }
  }

  async recoverMigrations(): Promise<void> {
    await this.initialize()
    for (const migration of Object.values(this.state.migrations).filter((item) => item.phase === 'copying')) await this.resumeMigration(migration.id)
  }

  async abandonMigration(id: string): Promise<void> {
    await this.withGlobalFileLock(async () => {
      if (this.state.migrations[id]?.phase !== 'copying') throw new FileStorageError('FILE_STORAGE_INVALID', 'Only an incomplete migration can be abandoned')
      await this.mutate((state) => { state.migrations[id].phase = 'abandoned'; state.migrations[id].error = 'Source retained; copied target residue was not deleted' })
    }, true)
    this.notifyChanged()
  }

  async cleanupMigration(id: string): Promise<Array<{ path: string; error: string }>> {
    return this.withGlobalFileLock(async () => {
      const migration = this.state.migrations[id]
      if (!migration || !['committed', 'cleaned'].includes(migration.phase)) throw new FileStorageError('FILE_STORAGE_INVALID', 'Migration has not committed')
      if (comparePath(migration.sourceRoot) === comparePath(this.state.configuration.mediaRoot)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Old-copy directory is now the active root; cleanup refused')
      const skipped: Array<{ path: string; error: string }> = []
      for (let index = 0; index < migration.files.length; index++) {
        const file = this.state.migrations[id].files[index]
        if (file.cleaned) continue
        const sourceRoot = file.sourceRoot || migration.sourceRoot
        const sourcePath = path.join(sourceRoot, file.sessionId, file.basename)
        try {
          if (comparePath(sourceRoot) === comparePath(this.state.configuration.mediaRoot)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Old-copy directory is now the active root; retained')
          const grant = (migration.sourceGrants || [migration.sourceGrant]).find((item) => comparePath(item.path) === comparePath(sourceRoot))
          if (!grant) throw new FileStorageError('FILE_STORAGE_CORRUPT', 'Missing migration source directory proof')
          await this.verifyDirectory(grant)
          await assertSafeDirectory(path.dirname(sourcePath))
          const source = await inspectRegularFile(sourcePath)
          if (source.sha256 !== file.source.sha256 || !sameFileIdentity(source.identity, file.source.identity)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Old copy changed; retained')
          if (file.assetKey) {
            const asset = this.state.assets[file.assetKey]
            if (!asset || asset.deleted) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Current asset cannot verify preservation; old copy retained')
            const current = await this.descriptor(asset)
            if (comparePath(current.path) === comparePath(sourcePath)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Old copy is now the active asset; retained')
            if (current.sha256 !== source.sha256) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Current audio differs; old copy retained')
          } else {
            await this.verifyDirectory(migration.targetGrant)
            const target = await inspectRegularFile(path.join(migration.targetRoot, file.sessionId, file.basename))
            if (!file.targetIdentity || !sameFileIdentity(target.identity, file.targetIdentity) || target.sha256 !== source.sha256) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Recovery copy changed or consumed; retained')
          }
          if (process.platform !== 'win32') throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', 'Verified old-copy deletion is unavailable on this platform')
          await protectedWindowsFileOperation({ action: 'delete', source: sourcePath, identity: source.identity, sha256: source.sha256 })
          await this.mutate((state) => { state.migrations[id].files[index].cleaned = true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(sourcePath)) await this.mutate((state) => { state.migrations[id].files[index].cleaned = true })
          else skipped.push({ path: sourcePath, error: error instanceof Error ? error.message : String(error) })
        }
      }
      await this.mutate((state) => { const intent = state.migrations[id]; if (intent.files.every((file) => file.cleaned)) intent.phase = 'cleaned'; intent.error = skipped.length ? `${skipped.length} old copies retained` : undefined })
      return skipped
    })
  }

  async listAssets() {
    const config = await this.getConfiguration()
    if (this.globalFileRequest || this.migrationLocked) throw new FileStorageError('FILE_STORAGE_BUSY', 'Media migration is in progress')
    this.catalogReaders++
    if (this.catalogReaders === 1) this.notifyChanged(true)
    const changeSequence = this.changeSequence
    const span = startPerformanceSpan('native.audio-catalog')
    let successful = false, records = 0, bytes = 0
    try {
    const audios: ManagedAudioAsset[] = []
    const errors: Array<{ sessionId: string; error: string }> = []
    const ids = new Set(Object.values(this.state.assets).filter((asset) => !asset.deleted).map((asset) => asset.sessionId))
    for (const root of await this.managedRoots()) {
      try {
        await this.assertGrantedDirectory(root)
        for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
          if (entry.isDirectory() && isSafeStorageId(entry.name)) ids.add(entry.name)
        }
      } catch (error) { errors.push({ sessionId: '', error: error instanceof Error ? error.message : String(error) }) }
    }
    for (const id of ids) {
      try { const audio = await this.withSessionLock(id, () => this.resolveAsset(id)); audios.push(audio); records++; bytes += audio.size }
      catch (error) {
        if (Object.values(this.state.assets).some((asset) => asset.sessionId === id && !asset.deleted) || ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as FileStorageError).code !== 'FILE_STORAGE_MISSING')) errors.push({ sessionId: id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    successful = true
    return { audios, errors, configurationRevision: config.revision, changeSequence,
      naming: Object.values(this.state.records).filter((record) => record.naming && !record.deleted).map((record) => ({ sessionId: record.sessionId, state: record.naming! })),
      deleted: Object.values(this.state.assets).filter((asset) => asset.deleted).map((asset) => ({ sessionId: asset.sessionId, assetKind: asset.assetKind, revision: asset.revision })) }
    } finally {
      this.catalogReaders--
      if (!this.catalogReaders) {
        for (const resolve of this.catalogDrainWaiters) resolve()
        this.catalogDrainWaiters.clear()
        this.notifyChanged(true)
      }
      span.finish(successful ? 'success' : 'error', { records, bytes })
    }
  }

  async readAsset(sessionId: string): Promise<{ audio: ManagedAudioAsset; data: Buffer }> {
    return this.withSessionLock(sessionId, async () => {
      const audio = await this.resolveAsset(sessionId)
      const data = await fs.promises.readFile(audio.path)
      if (createHash('sha256').update(data).digest('hex') !== audio.sha256) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Audio changed during read')
      await this.resolveAsset(sessionId, audio.assetKind)
      return { audio, data }
    })
  }

  async deleteAsset(sessionId: string): Promise<void> {
    await this.initialize()
    this.assertMediaMutationAvailable()
    await this.withSessionLock(sessionId, async () => {
      const audio = await this.resolveAsset(sessionId)
      const asset = this.state.assets[assetKey(sessionId, audio.assetKind)]
      const intent: PublicationIntent = { id: randomUUID(), kind: 'delete', stageName: asset.fileName, stageIdentity: asset.identity, asset }
      await this.mutate((state) => { state.operations[intent.id] = intent })
      await this.finishDeletion(intent)
    })
    this.notifyChanged()
  }

  private async finishDeletion(intent: PublicationIntent): Promise<void> {
    if (!intent.committed) {
      const directory = await this.sessionDirectory(intent.asset.sessionId, false, intent.asset.root)
      const target = path.join(directory, intent.asset.fileName)
      try {
        const actual = await inspectRegularFile(target)
        if (actual.sha256 !== intent.asset.sha256 || !sameFileIdentity(actual.identity, intent.asset.identity)) throw new FileStorageError('FILE_STORAGE_CONFLICT', 'Audio changed; deletion paused')
        if (process.platform !== 'win32') throw new FileStorageError('FILE_STORAGE_UNAVAILABLE', 'Verified media deletion is unavailable on this platform')
        await protectedWindowsFileOperation({ action: 'delete', source: target, identity: actual.identity, sha256: actual.sha256 })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await this.mutate((state) => {
        state.assets[assetKey(intent.asset.sessionId, intent.asset.assetKind)] = { ...intent.asset, revision: intent.asset.revision + 1, deleted: true }
        state.operations[intent.id] = { ...intent, committed: true }
      })
    }
    await this.mutate((state) => { delete state.operations[intent.id] })
  }

  async isPendingStage(sessionId: string, basename: string): Promise<boolean> {
    await this.initialize()
    return Object.values(this.state.operations).some((intent) => intent.asset.sessionId === sessionId && intent.stageName === basename)
  }

  async recoverPublications(sessionId?: string, ownerToken?: string): Promise<Array<{ id: string; error?: string }>> {
    await this.initialize()
    const results: Array<{ id: string; error?: string }> = []
    for (const intent of Object.values(this.state.operations)) {
      if (sessionId && intent.asset.sessionId !== sessionId) continue
      try { await this.withSessionLock(intent.asset.sessionId, async () => {
        if (!this.state.operations[intent.id] || [...this.usage.values()].some((lease) => lease.sessionId === intent.asset.sessionId)) return
        if (intent.asset.assetKind === 'recording-audio' && /^source-audio\.[a-f0-9-]+\.tmp\.wav$/.test(intent.stageName) && Object.keys(this.state.recordingRecoveryAcks || {}).length) {
          if ((await this.listRecordingRecoveryNotices()).some((item) => item.sessionId === intent.asset.sessionId && item.acknowledged)) return
        }
        if (intent.kind === 'delete') await this.finishDeletion(intent)
        else if (intent.kind === 'case-rename') await this.finishCaseRename(intent)
        else await this.finishPublication(intent)
        if (intent.kind !== 'delete') await this.mutate((state) => {
          const record = state.records[intent.asset.sessionId]
          if (record && !record.deleted && !record.deleting && record.naming?.status === 'error') record.naming = { status: 'queued', titleRevision: record.titleRevision }
        })
      }, ownerToken); results.push({ id: intent.id }) }
      catch (error) { results.push({ id: intent.id, error: error instanceof Error ? error.message : String(error) }) }
    }
    return results
  }
}
