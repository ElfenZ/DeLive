import fs from 'fs'
import path from 'path'
import { randomUUID, createHash } from 'crypto'
import { getFileStorageService } from './fileStorage'
import { inspectRegularFile, assertSafeDirectory, writeJsonDurably, sameFileIdentity, fileIdentity, comparePath, type FileIdentity } from './fileStorageService'
import { buildStorageFileName } from '../shared/fileNames'
import { isSafeStorageId, type SessionFileContext } from '../shared/fileStorage'
import type { OriginalSourceInfo, OriginalRenamePreview } from '../shared/originalSources'
import { noReplaceMove } from './noReplaceMove'

interface SourceRecord { id: string; revision: number; path: string; identity: FileIdentity; sha256: string; sessions: string[]; previousName?: string }
interface RenameJournal { sourceId: string; oldPath: string; targetPath: string; identity: FileIdentity; sha256: string; temporaryPath?: string }
interface SourceState { version: 1; sources: Record<string, SourceRecord>; journal?: RenameJournal }

export class OriginalSourceService {
  private state: SourceState = { version: 1, sources: {} }
  private ready: Promise<void> | undefined
  private selections = new Map<string, { owner: number; expiresAt: number }>()
  private previews = new Map<string, { owner: number; preview: OriginalRenamePreview; source: SourceRecord }>()
  private readers = new Map<string, string>()
  private readOwners = new Map<string, { owner: number; sessionId: string }>()
  private queue: Promise<unknown> = Promise.resolve()
  private moving = false
  private statePath: string
  constructor(userData: string) { this.statePath = path.join(userData, 'local-file-storage', 'original-sources.json') }

  private initialize(): Promise<void> {
    if (!this.ready) this.ready = (async () => {
      await getFileStorageService().getConfiguration()
      try {
        await inspectRegularFile(this.statePath)
        const parsed = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8')) as SourceState
        if (parsed.version !== 1 || !parsed.sources || Array.isArray(parsed.sources)) throw new Error('Original source registry is corrupt')
        for (const [id, source] of Object.entries(parsed.sources)) {
          if (source.id !== id || !isSafeStorageId(id) || !path.isAbsolute(source.path) || !Array.isArray(source.sessions) || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.revision)) throw new Error('Original source registration is invalid')
          if (source.previousName !== undefined && (typeof source.previousName !== 'string' || !source.previousName || source.previousName === '.' || source.previousName === '..' || /[\\/:]/.test(source.previousName))) throw new Error('Original rename history is invalid')
        }
        this.state = parsed
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (this.state.journal) await this.recoverRename()
    })()
    return this.ready
  }

  private async persist(state: SourceState): Promise<void> {
    await assertSafeDirectory(path.dirname(this.statePath))
    try { await writeJsonDurably(this.statePath, state); this.state = state }
    catch (error) { this.state = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8')) as SourceState; throw error }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.catch(() => undefined).then(operation)
    this.queue = work
    return work
  }

  rememberSelection(filePath: string, owner: number): void {
    if (path.isAbsolute(filePath)) this.selections.set(comparePath(filePath), { owner, expiresAt: Date.now() + 10 * 60_000 })
  }

  private info(source: SourceRecord): OriginalSourceInfo {
    return { id: source.id, revision: source.revision, fileName: path.basename(source.path), size: source.identity.size, sha256: source.sha256 }
  }

  async register(filePath: string, sessionId: string, owner: number): Promise<OriginalSourceInfo> {
    return this.serialize(async () => {
      await this.initialize()
      if (!isSafeStorageId(sessionId)) throw new Error('Invalid original source session')
      const selection = this.selections.get(comparePath(filePath))
      if (!selection || selection.owner !== owner || selection.expiresAt < Date.now()) throw new Error('Select the original through a native file input or picker first')
      await assertSafeDirectory(path.dirname(filePath))
      const canonical = await fs.promises.realpath(filePath)
      const mediaRoots = await getFileStorageService().managedRoots(true)
      if (mediaRoots.some((root) => comparePath(canonical).startsWith(comparePath(root) + path.sep))) throw new Error('Managed audio is not an external original; use managed-media operations')
      const proof = await inspectRegularFile(canonical)
      const existing = Object.values(this.state.sources).find((source) => source.identity.dev === proof.identity.dev && source.identity.ino === proof.identity.ino && source.sha256 === proof.sha256)
      const source: SourceRecord = existing ? { ...existing, path: canonical, revision: existing.revision + (existing.path === canonical && existing.sessions.includes(sessionId) ? 0 : 1), sessions: [...new Set([...existing.sessions, sessionId])] }
        : { id: randomUUID(), revision: 1, path: canonical, ...proof, sessions: [sessionId] }
      if (existing && existing.path !== canonical) delete source.previousName
      await this.persist({ ...this.state, sources: { ...this.state.sources, [source.id]: source } })
      return this.info(source)
    })
  }

  private async verify(id: string, sessionId?: string): Promise<SourceRecord> {
    await this.initialize()
    const source = this.state.sources[id]
    if (!source || (sessionId && !source.sessions.includes(sessionId))) throw new Error('Original source requires explicit reselection on this machine')
    await assertSafeDirectory(path.dirname(source.path))
    const current = await inspectRegularFile(source.path)
    if (!sameFileIdentity(current.identity, source.identity) || current.sha256 !== source.sha256) throw new Error('Original was moved, edited or replaced; reselect and verify it')
    return source
  }

  async acquireRead(id: string, sessionId: string, owner = 0): Promise<{ token: string; path: string }> {
    return this.serialize(async () => {
    if (this.moving) throw new Error('Original rename is in progress')
    await this.assertReadableRecord(sessionId)
    const source = await this.verify(id, sessionId)
    const token = randomUUID()
    this.readers.set(token, id)
    this.readOwners.set(token, { owner, sessionId })
    return { token, path: source.path }
    })
  }

  private async assertReadableRecord(sessionId: string): Promise<void> {
    try { await getFileStorageService().getSessionContext(sessionId) }
    catch (error) {
      // A pending new file task has no saved title yet, but a deletion tombstone is authoritative.
      if ((error as { code?: string }).code !== 'FILE_STORAGE_MISSING') throw error
    }
  }
  releaseRead(token: string, owner?: number): void {
    if (owner !== undefined && this.readOwners.get(token)?.owner !== owner) throw new Error('Original read lease belongs to another window')
    this.readers.delete(token)
    this.readOwners.delete(token)
  }

  async readAudio(token: string, owner: number): Promise<{ data: Buffer; fileName: string }> {
    const lease = this.readOwners.get(token)
    const id = this.readers.get(token)
    if (!lease || lease.owner !== owner || !id) throw new Error('Original read lease is unavailable')
    await this.assertReadableRecord(lease.sessionId)
    const source = await this.verify(id, lease.sessionId)
    const selection = this.selections.get(comparePath(source.path))
    if (!selection || selection.owner !== owner || selection.expiresAt < Date.now()) throw new Error('Select the original audio through a native file input first')
    if (!['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus', '.mpga', '.aac', '.wma'].includes(path.extname(source.path).toLowerCase())) throw new Error('Original audio read requires an audio extension; video bytes cannot be uploaded')
    const handle = await fs.promises.open(source.path, 'r')
    try {
      if (!sameFileIdentity(fileIdentity(await handle.stat({ bigint: true })), source.identity)) throw new Error('Original audio identity changed')
      const data = await handle.readFile()
      if (!sameFileIdentity(fileIdentity(await handle.stat({ bigint: true })), source.identity)
        || createHash('sha256').update(data).digest('hex') !== source.sha256) throw new Error('Original audio changed during reading')
      await this.verify(id, lease.sessionId)
      await this.assertReadableRecord(lease.sessionId)
      if (this.readers.get(token) !== id) throw new Error('Original read lease ended during reading')
      return { data, fileName: path.basename(source.path) }
    } finally { await handle.close() }
  }

  async preview(id: string, context: SessionFileContext, owner: number, undo = false): Promise<OriginalRenamePreview> {
    return this.serialize(async () => {
      if (process.platform !== 'win32') throw new Error('Original rename is disabled without a verified platform no-replace adapter')
      if ([...this.readers.values()].includes(id)) throw new Error('Original is being read or uploaded; preview after it finishes')
      const source = await this.verify(id, context.sessionId)
      const directory = path.dirname(source.path)
      if (undo && !source.previousName) throw new Error('No previous original rename is available to undo')
      const newName = undo ? source.previousName! : buildStorageFileName(context, path.extname(source.path).slice(1), undefined, Math.min(220, 258 - directory.length))
      const target = path.join(directory, newName)
      if (target !== source.path && comparePath(target) !== comparePath(source.path) && fs.existsSync(target)) throw new Error('Proposed target already exists; no file will be overwritten')
      const preview: OriginalRenamePreview = { token: randomUUID(), sourceId: id, sourceRevision: source.revision, sessionId: context.sessionId, titleRevision: context.titleRevision, oldName: path.basename(source.path), newName, directory, affectedSessionIds: [...source.sessions], expiresAt: Date.now() + 5 * 60_000 }
      this.previews.set(preview.token, { owner, preview, source: structuredClone(source) })
      return preview
    })
  }

  async listInfo(): Promise<OriginalSourceInfo[]> { await this.initialize(); return Object.values(this.state.sources).map((source) => this.info(source)) }

  peek(token: string, owner: number): OriginalRenamePreview {
    const entry = this.previews.get(token)
    if (!entry || entry.owner !== owner || entry.preview.expiresAt < Date.now()) throw new Error('Original rename preview expired; preview again')
    return structuredClone(entry.preview)
  }

  cancel(token: string, owner: number): void {
    if (this.previews.get(token)?.owner === owner) this.previews.delete(token)
  }

  async commit(token: string, owner: number, currentProvider: () => Promise<SessionFileContext>): Promise<OriginalSourceInfo> {
    return this.serialize(async () => {
      const entry = this.previews.get(token)
      this.previews.delete(token)
      if (!entry) throw new Error('Original preview is missing or consumed')
      return getFileStorageService().withRecordGuard(entry.preview.sessionId, async () => {
      const current = await currentProvider()
      if (!entry || entry.owner !== owner || entry.preview.expiresAt < Date.now() || entry.preview.sessionId !== current.sessionId || entry.preview.titleRevision !== current.titleRevision) throw new Error('Title or preview changed; preview again')
      if ([...this.readers.values()].includes(entry.source.id)) throw new Error('Original is being read/uploaded; preview again later')
      const source = await this.verify(entry.source.id, current.sessionId)
      if (source.revision !== entry.preview.sourceRevision || source.path !== entry.source.path) throw new Error('Original source path or revision changed; preview again')
      const targetPath = path.join(path.dirname(source.path), entry.preview.newName)
      if (source.path === targetPath) return this.info(source)
      this.moving = true
      try {
        const journal: RenameJournal = { sourceId: source.id, oldPath: source.path, targetPath, identity: source.identity, sha256: source.sha256 }
        if (comparePath(source.path) === comparePath(targetPath)) journal.temporaryPath = path.join(path.dirname(source.path), `.delive-original-${randomUUID()}${path.extname(source.path)}`)
        await this.persist({ ...this.state, journal })
        if (journal.temporaryPath) { await noReplaceMove(source.path, journal.temporaryPath, source); await noReplaceMove(journal.temporaryPath, targetPath, await inspectRegularFile(journal.temporaryPath)) }
        else await noReplaceMove(source.path, targetPath, source)
        const updated = { ...source, ...await inspectRegularFile(targetPath), path: targetPath, previousName: path.basename(source.path), revision: source.revision + 1 }
        await this.persist({ version: 1, sources: { ...this.state.sources, [source.id]: updated } })
        return this.info(updated)
      } finally { this.moving = false }
      })
    })
  }

  private async recoverRename(): Promise<void> {
    const journal = this.state.journal!
    const source = this.state.sources[journal.sourceId]
    const matching = async (filePath: string) => {
      try { const value = await inspectRegularFile(filePath); return value.sha256 === journal.sha256 && value.identity.dev === journal.identity.dev && value.identity.ino === journal.identity.ino && value.identity.size === journal.identity.size } catch { return false }
    }
    // Reconcile an already executed move only. Never initiate an old approved rename on startup.
    const oldExists = fs.existsSync(journal.oldPath)
    const targetExists = fs.existsSync(journal.targetPath)
    const tempExists = Boolean(journal.temporaryPath && fs.existsSync(journal.temporaryPath))
    const oldAndTarget = comparePath(journal.oldPath) === comparePath(journal.targetPath) ? Number(oldExists || targetExists) : Number(oldExists) + Number(targetExists)
    if (oldAndTarget + Number(tempExists) > 1) throw new Error('Both original rename paths exist; reconciliation paused without changing files')
    if (await matching(journal.targetPath)) await this.persist({ version: 1, sources: { ...this.state.sources, [source.id]: { ...source, ...await inspectRegularFile(journal.targetPath), path: journal.targetPath, previousName: path.basename(journal.oldPath), revision: source.revision + 1 } } })
    else if (journal.temporaryPath && await matching(journal.temporaryPath)) {
      await noReplaceMove(journal.temporaryPath, journal.oldPath, await inspectRegularFile(journal.temporaryPath))
      await this.persist({ version: 1, sources: this.state.sources })
    } else if (await matching(journal.oldPath)) await this.persist({ version: 1, sources: this.state.sources })
    else throw new Error('Original rename cannot be reconciled safely; paths were preserved')
  }
}

let originalService: OriginalSourceService | undefined
export function getOriginalSourceService(): OriginalSourceService {
  return originalService ||= new OriginalSourceService(getFileStorageService().userData)
}
