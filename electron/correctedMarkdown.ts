import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { getFileStorageService } from './fileStorage'
import { inspectRegularFile, writeJsonDurably, assertSafeDirectory, sameFileIdentity, comparePath, type FileIdentity } from './fileStorageService'
import { assertStorageBasename } from './fileStorageService'
import { buildStorageFileName } from '../shared/fileNames'
import { noReplaceMove } from './noReplaceMove'
import type { CorrectedMarkdownSaveRequest, CorrectedMarkdownFileState } from '../shared/fileStorage'
import { protectedWindowsFileOperation } from './windowsFileHandle'

interface Registration { path: string; identity: FileIdentity; sha256: string; publicationId: string; publicationRevision: number; titleRevision: number; revision: number }
interface Pending { request: CorrectedMarkdownSaveRequest; target: string; old?: Registration; relocation?: boolean; temporaryPath?: string; stagePath?: string; backupPath?: string; stageProof?: { identity: FileIdentity; sha256: string }; finalTarget?: string }
interface State { version: 1; files: Record<string, Registration>; pending: Record<string, Pending> }
export class CorrectedMarkdownService {
  private state: State = { version: 1, files: {}, pending: {} }
  private ready: Promise<void> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private statePath: string
  private recoveryErrors = new Map<string, string>()
  constructor(userData: string) { this.statePath = path.join(userData, 'local-file-storage', 'corrected-files.json') }
  private initialize(): Promise<void> {
    return this.ready ||= (async () => {
      await getFileStorageService().getConfiguration()
      try {
        await inspectRegularFile(this.statePath)
        const raw = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8')) as State
        if (raw.version !== 1 || !raw.files || !raw.pending) throw new Error('Corrected-file registry is corrupt')
        this.state = raw
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const sessionId of Object.keys(this.state.pending)) {
        try { await this.recoverFile(sessionId) } catch (error) { this.recoveryErrors.set(sessionId, error instanceof Error ? error.message : String(error)); console.warn('[CorrectedFiles] Recovery paused; journal retained:', error) }
      }
    })()
  }
  private async persist(next: State): Promise<void> {
    try { await writeJsonDurably(this.statePath, next); this.state = next }
    catch (error) { this.state = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8')) as State; throw error }
  }
  async save(request: CorrectedMarkdownSaveRequest, confirmedFirstName?: string): Promise<CorrectedMarkdownFileState> {
    if (confirmedFirstName) assertStorageBasename(confirmedFirstName)
    const work = this.queue.catch(() => undefined).then(() => this.execute(request, confirmedFirstName))
    this.queue = work
    return work
  }
  async suggestFirstTarget(request: CorrectedMarkdownSaveRequest): Promise<{ existing: string; suggested: string } | undefined> {
    await this.initialize()
    if (this.state.files[request.sessionId] || request.legacyPath) return undefined
    const service = getFileStorageService()
    const context = await service.getSessionContext(request.sessionId)
    const directory = await service.transcriptDirectory(request.projectId)
    const basename = buildStorageFileName(context, 'md', 'corrected', Math.min(220, process.platform === 'win32' ? 258 - directory.length : 220))
    const alternateBase = buildStorageFileName(context, 'md', 'corrected', Math.min(208, process.platform === 'win32' ? 246 - directory.length : 208))
    const existing = path.join(directory, basename)
    if (!fs.existsSync(existing)) return undefined
    let suffix = 2
    let suggested = alternateBase.replace(/\.md$/, ` (${suffix}).md`)
    while (fs.existsSync(path.join(directory, suggested))) { suffix++; suggested = alternateBase.replace(/\.md$/, ` (${suffix}).md`) }
    return { existing, suggested }
  }
  async registeredState(sessionId: string): Promise<CorrectedMarkdownFileState | undefined> {
    await this.initialize()
    const file = this.state.files[sessionId]
    if (!file) {
      const pending = this.state.pending[sessionId]
      return pending ? { status: 'conflict', registrationId: sessionId, path: pending.target, revision: 0, error: this.recoveryErrors.get(sessionId) || 'An interrupted initial Markdown operation requires verification; no duplicate is allowed' } : undefined
    }
    return { status: this.state.pending[sessionId] ? 'conflict' : 'saved', registrationId: sessionId, path: file.path, revision: file.revision, publicationId: file.publicationId, publicationRevision: file.publicationRevision, publicationHash: file.sha256, titleRevision: file.titleRevision,
      error: this.state.pending[sessionId] ? 'An interrupted operation remains; no automatic overwrite or duplicate is allowed' : undefined }
  }
  private async deleteVerified(filePath: string, proof: { identity: FileIdentity; sha256: string }): Promise<void> {
    await protectedWindowsFileOperation({ action: 'delete', source: filePath, ...proof })
  }
  private async recoverFile(sessionId: string): Promise<void> {
    const operation = this.state.pending[sessionId]
    if (!operation) return
    const service = getFileStorageService()
    await service.getSessionContext(sessionId)
    await service.assertGrantedDirectory(path.dirname(operation.target))
    const desired = createHash('sha256').update(operation.request.content).digest('hex')
    let target: Awaited<ReturnType<typeof inspectRegularFile>> | undefined
    try { target = await inspectRegularFile(operation.target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // First publication and relocation own a complete stage, never an equal-content destination.
    if (!operation.old || operation.relocation) {
      if (!operation.stagePath || !operation.stageProof || operation.stageProof.sha256 !== desired) throw new Error('Markdown stage ownership proof is missing or incomplete; recovery paused')
      await service.assertGrantedDirectory(path.dirname(operation.stagePath))
      if (comparePath(path.dirname(operation.stagePath)) !== comparePath(path.dirname(operation.target))) throw new Error('Markdown stage parent differs from the authorized target parent')
      let stage: Awaited<ReturnType<typeof inspectRegularFile>> | undefined
      try { stage = await inspectRegularFile(operation.stagePath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (stage && (stage.sha256 !== desired || !sameFileIdentity(stage.identity, operation.stageProof.identity))) throw new Error('Markdown stage changed or is partial; recovery paused')
      if (target) {
        if (stage || target.sha256 !== desired || !sameFileIdentity(target.identity, operation.stageProof.identity)) throw new Error('The pending Markdown target conflicts with the owned stage; no overwrite or adoption allowed')
      } else {
        if (!stage) throw new Error('Markdown stage and target are missing; recovery paused')
        if (operation.relocation && operation.old) {
          await service.assertGrantedDirectory(path.dirname(operation.old.path))
          const prior = await inspectRegularFile(operation.old.path)
          if (prior.sha256 !== operation.old.sha256 || !sameFileIdentity(prior.identity, operation.old.identity)) throw new Error('Relocation source changed; recovery paused')
        }
        await noReplaceMove(operation.stagePath, operation.target, operation.stageProof)
        target = await inspectRegularFile(operation.target)
        if (target.sha256 !== desired || !sameFileIdentity(target.identity, operation.stageProof.identity)) throw new Error('Recovered Markdown target changed; recovery paused')
      }
    }
    if (!target && operation.backupPath && operation.old && !fs.existsSync(operation.old.path)) {
      const backup = await inspectRegularFile(operation.backupPath).catch(() => undefined)
      if (backup && backup.sha256 === operation.old.sha256 && backup.identity.ino === operation.old.identity.ino && backup.identity.dev === operation.old.identity.dev) {
        await noReplaceMove(operation.backupPath, operation.old.path, backup)
        target = await inspectRegularFile(operation.old.path)
      }
    }
    if (!target && operation.temporaryPath) {
      const temporary = await inspectRegularFile(operation.temporaryPath).catch(() => undefined)
      if (temporary && temporary.sha256 === desired && operation.stageProof && sameFileIdentity(temporary.identity, operation.stageProof.identity)) { await service.assertGrantedDirectory(path.dirname(operation.temporaryPath)); await noReplaceMove(operation.temporaryPath, operation.target, temporary); target = await inspectRegularFile(operation.target) }
    }
    if ((!target || target.sha256 !== desired) && operation.old) {
      const prior = await inspectRegularFile(operation.old.path).catch(() => undefined)
      if (prior?.sha256 === desired && operation.stageProof && prior.identity.ino === operation.stageProof.identity.ino && prior.identity.dev === operation.stageProof.identity.dev) {
        if (operation.target !== operation.old.path && !target) { await noReplaceMove(operation.old.path, operation.target, prior); target = await inspectRegularFile(operation.target) }
      }
    }
    if (!target || target.sha256 !== desired) return
    if (!operation.stageProof || target.identity.ino !== operation.stageProof.identity.ino || target.identity.dev !== operation.stageProof.identity.dev) return
    const file: Registration = { path: operation.target, ...target, publicationId: operation.request.publicationId, publicationRevision: operation.request.publicationRevision,
      titleRevision: operation.finalTarget && operation.finalTarget !== operation.target ? operation.old?.titleRevision || 0 : operation.request.titleRevision,
      revision: Math.max(this.state.files[sessionId]?.revision || 0, (operation.old?.revision || 0) + 1) }
    await this.persist({ ...this.state, files: { ...this.state.files, [sessionId]: file } })
    if (operation.backupPath && operation.old) {
      const backup = await inspectRegularFile(operation.backupPath).catch(() => undefined)
      if (backup) {
        if (backup.sha256 !== operation.old.sha256 || backup.identity.ino !== operation.old.identity.ino || backup.identity.dev !== operation.old.identity.dev) return
        await this.deleteVerified(operation.backupPath, backup)
      }
    }
    if (operation.relocation && operation.old && operation.old.path !== operation.target) {
      const old = await inspectRegularFile(operation.old.path).catch(() => undefined)
      if (old) {
        if (!sameFileIdentity(old.identity, operation.old.identity) || old.sha256 !== operation.old.sha256) return
        await this.deleteVerified(operation.old.path, old)
      }
    }
    const next = { ...this.state, pending: { ...this.state.pending } }
    delete next.pending[sessionId]
    await this.persist(next)
  }
  async relocate(sessionId: string, selectedDirectory: string): Promise<CorrectedMarkdownFileState> {
    const work = this.queue.catch(() => undefined).then(async () => {
      await this.initialize()
      await this.recoverFile(sessionId)
      if (this.state.pending[sessionId]) throw new Error('Resolve the pending Markdown operation before relocating again')
      const service = getFileStorageService()
      const context = await service.getSessionContext(sessionId)
      const old = this.state.files[sessionId]
      if (!old) throw new Error('Save or locate the registered Markdown before relocating')
      await service.assertGrantedDirectory(path.dirname(old.path))
      await service.authorizeLocalDirectory(selectedDirectory)
      return service.withSessionLock(sessionId, async () => {
        const original = await inspectRegularFile(old.path)
        if (original.sha256 !== old.sha256 || !sameFileIdentity(original.identity, old.identity)) throw new Error('External edits must be verified before relocating')
        const target = path.join(selectedDirectory, buildStorageFileName(context, 'md', 'corrected', Math.min(220, process.platform === 'win32' ? 258 - selectedDirectory.length : 220)))
        if (target === old.path) return this.result(old, { sessionId } as CorrectedMarkdownSaveRequest)
        const content = await fs.promises.readFile(old.path, 'utf8')
        if (createHash('sha256').update(content).digest('hex') !== old.sha256) throw new Error('Markdown changed before relocation')
        const request: CorrectedMarkdownSaveRequest = { sessionId, publicationId: old.publicationId, publicationRevision: old.publicationRevision, titleRevision: old.titleRevision, content }
        await this.persist({ ...this.state, pending: { ...this.state.pending, [sessionId]: { request, target, old, relocation: true } } })
        const operation = this.state.pending[sessionId]
        operation.stagePath = path.join(selectedDirectory, `.delive-relocate-${randomUUID()}.md`)
        await this.persist({ ...this.state, pending: { ...this.state.pending, [sessionId]: operation } })
        const handle = await fs.promises.open(operation.stagePath, 'wx')
        try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
        operation.stageProof = await inspectRegularFile(operation.stagePath)
        if (operation.stageProof.sha256 !== old.sha256) throw new Error('Relocation stage differs')
        await this.persist({ ...this.state, pending: { ...this.state.pending, [sessionId]: operation } })
        await noReplaceMove(operation.stagePath, target, operation.stageProof)
        const proof = await inspectRegularFile(target)
        const beforeDelete = await inspectRegularFile(old.path)
        if (proof.sha256 !== old.sha256 || beforeDelete.sha256 !== old.sha256 || !sameFileIdentity(beforeDelete.identity, old.identity)) throw new Error('Relocation verification failed; old file retained')
        const file = { ...old, path: target, ...proof, revision: old.revision + 1 }
        await this.persist({ ...this.state, files: { ...this.state.files, [sessionId]: file } })
        await this.deleteVerified(old.path, beforeDelete)
        const next = { ...this.state, pending: { ...this.state.pending } }
        delete next.pending[sessionId]
        await this.persist(next)
        return this.result(file, request)
      })
    })
    this.queue = work
    return work
  }
  async locate(sessionId: string, selectedFile: string): Promise<CorrectedMarkdownFileState> {
    const work = this.queue.catch(() => undefined).then(async () => {
      await this.initialize()
      await this.recoverFile(sessionId)
      if (this.state.pending[sessionId]) throw new Error('Resolve the pending Markdown operation before locating another file')
      const service = getFileStorageService()
      await service.getSessionContext(sessionId)
      const old = this.state.files[sessionId]
      if (!old) throw new Error('No existing Markdown registration to locate')
      await assertSafeDirectory(path.dirname(selectedFile))
      const proof = await inspectRegularFile(selectedFile)
      if (proof.sha256 !== old.sha256) throw new Error('Located file contains external changes; restore/verify its content before adoption')
      await service.authorizeLocalDirectory(path.dirname(selectedFile))
      const file = { ...old, ...proof, path: selectedFile, revision: old.revision + 1 }
      await this.persist({ ...this.state, files: { ...this.state.files, [sessionId]: file } })
      return this.result(file, { sessionId } as CorrectedMarkdownSaveRequest)
    })
    this.queue = work
    return work
  }
  async adoptLegacy(request: CorrectedMarkdownSaveRequest, selectedFile: string): Promise<CorrectedMarkdownFileState> {
    const work = this.queue.catch(() => undefined).then(async () => {
      await this.initialize()
      await this.recoverFile(request.sessionId)
      if (this.state.pending[request.sessionId] || this.state.files[request.sessionId]) throw new Error('A registration or pending file operation already exists; locate the registered file instead')
      const service = getFileStorageService()
      const context = await service.getSessionContext(request.sessionId)
      if (context.titleRevision !== request.titleRevision || !request.publicationId || !Number.isSafeInteger(request.publicationRevision) || request.publicationRevision < 1) throw new Error('Publication/title changed; retry latest state')
      await assertSafeDirectory(path.dirname(selectedFile))
      const proof = await inspectRegularFile(selectedFile)
      if (proof.sha256 !== createHash('sha256').update(request.content).digest('hex')) throw new Error('Legacy Markdown differs from the current published correction; no file was changed')
      await service.authorizeLocalDirectory(path.dirname(selectedFile))
      return service.withSessionLock(request.sessionId, async () => {
        const latest = await service.getSessionContext(request.sessionId)
        const actual = await inspectRegularFile(selectedFile)
        if (latest.titleRevision !== request.titleRevision || !sameFileIdentity(actual.identity, proof.identity) || actual.sha256 !== proof.sha256) throw new Error('Legacy file/title changed after native selection; adoption refused')
        const file: Registration = { path: selectedFile, ...proof, publicationId: request.publicationId, publicationRevision: request.publicationRevision, titleRevision: request.titleRevision, revision: 1 }
        await this.persist({ ...this.state, files: { ...this.state.files, [request.sessionId]: file } })
        return this.result(file, request)
      })
    })
    this.queue = work
    return work
  }
  private async execute(request: CorrectedMarkdownSaveRequest, confirmedFirstName?: string): Promise<CorrectedMarkdownFileState> {
    await this.initialize()
    const service = getFileStorageService()
    const context = await service.getSessionContext(request.sessionId)
    if (context.titleRevision !== request.titleRevision || !request.publicationId || !Number.isSafeInteger(request.publicationRevision) || request.publicationRevision < 1 || !request.content.trim()) throw new Error('Published correction or saved title changed; retry latest state')
    return service.withSessionLock(request.sessionId, async () => {
      let old = this.state.files[request.sessionId]
      let pending: Pending | undefined = this.state.pending[request.sessionId]
      if (confirmedFirstName && pending && !pending.old) {
        await service.assertGrantedDirectory(path.dirname(pending.target))
        if (!pending.stagePath || !pending.stageProof) throw new Error('Incomplete stage ownership; alternative save refused')
        const stage = await inspectRegularFile(pending.stagePath)
        const occupied = await inspectRegularFile(pending.target)
        if (!sameFileIdentity(stage.identity, pending.stageProof.identity) || stage.sha256 !== pending.stageProof.sha256 || stage.sha256 !== createHash('sha256').update(request.content).digest('hex') || sameFileIdentity(occupied.identity, pending.stageProof.identity)) throw new Error('Changed or missing stage requires verification; alternative save refused')
        await service.assertGrantedDirectory(path.dirname(pending.stagePath))
        await this.deleteVerified(pending.stagePath, pending.stageProof)
        const next = { ...this.state, pending: { ...this.state.pending } }
        delete next.pending[request.sessionId]
        await this.persist(next)
        pending = undefined
      }
      if (pending) {
        await this.recoverFile(request.sessionId)
        pending = this.state.pending[request.sessionId]
        old = this.state.files[request.sessionId]
        if (pending) {
          const proof = pending.old ? await inspectRegularFile(pending.old.path).catch(() => undefined) : undefined
          if (pending.relocation || !pending.old || !proof || proof.sha256 !== pending.old.sha256 || !sameFileIdentity(proof.identity, pending.old.identity)) throw new Error('Interrupted or externally changed Markdown requires manual verification; no duplicate created')
        }
      }
      const directory = old ? path.dirname(old.path) : await service.transcriptDirectory(request.projectId)
      await service.assertGrantedDirectory(directory)
      const basename = buildStorageFileName(context, 'md', 'corrected', Math.min(220, process.platform === 'win32' ? 258 - directory.length : 220))
      const target = path.join(directory, old && old.titleRevision === request.titleRevision ? path.basename(old.path) : confirmedFirstName && !old ? confirmedFirstName : basename)
      const hash = createHash('sha256').update(request.content).digest('hex')
      if (!old && request.legacyPath) {
        if (path.dirname(request.legacyPath) !== directory) throw new Error('Legacy file requires native directory authorization and explicit location verification')
        const proof = await inspectRegularFile(request.legacyPath)
        if (proof.sha256 !== hash) throw new Error('Legacy Markdown differs from the published correction; adoption paused')
        old = { path: request.legacyPath, ...proof, publicationId: request.publicationId, publicationRevision: request.publicationRevision, titleRevision: request.titleRevision, revision: 1 }
        await this.persist({ ...this.state, files: { ...this.state.files, [request.sessionId]: old } })
      }
      if (old) {
        await assertSafeDirectory(path.dirname(old.path))
        const actual = await inspectRegularFile(old.path)
        if (!sameFileIdentity(actual.identity, old.identity) || actual.sha256 !== old.sha256) throw new Error('Markdown was moved, edited or replaced externally; automatic update paused')
        if (old.publicationRevision > request.publicationRevision) throw new Error('An older restored publication cannot replace the registered latest file')
        if (old.sha256 === hash && old.path === target && old.titleRevision === request.titleRevision) return this.result(old, request)
      }
      const operation: Pending = { request, target: old?.path || target, finalTarget: target, old }
      await this.persist({ ...this.state, pending: { ...this.state.pending, [request.sessionId]: operation } })
      if (old) {
        if (old.sha256 !== hash) {
          operation.stagePath = path.join(directory, `.delive-corrected-new-${randomUUID()}.md`)
          operation.backupPath = path.join(directory, `.delive-corrected-old-${randomUUID()}.md`)
          await this.persist({ ...this.state, pending: { ...this.state.pending, [request.sessionId]: operation } })
          const stageHandle = await fs.promises.open(operation.stagePath, 'wx')
          try { await stageHandle.writeFile(request.content, 'utf8'); await stageHandle.sync() } finally { await stageHandle.close() }
          operation.stageProof = await inspectRegularFile(operation.stagePath)
          if (operation.stageProof.sha256 !== hash) throw new Error('Complete Markdown staging failed verification')
          await this.persist({ ...this.state, pending: { ...this.state.pending, [request.sessionId]: operation } })
          await protectedWindowsFileOperation({ action: 'replace', source: old.path, identity: old.identity, sha256: old.sha256, stage: operation.stagePath, backup: operation.backupPath, stageIdentity: operation.stageProof.identity, stageHash: hash })
        }
        const proof = await inspectRegularFile(old.path)
        if (proof.sha256 !== hash) throw new Error('Corrected Markdown write did not verify')
        if (old.path !== target) {
          const temporaryPath = comparePath(old.path) === comparePath(target) ? path.join(directory, `.delive-corrected-${randomUUID()}.md`) : undefined
          await this.persist({ ...this.state, pending: { ...this.state.pending, [request.sessionId]: { ...operation, target, temporaryPath } } })
          if (temporaryPath) {
            await noReplaceMove(old.path, temporaryPath, proof)
            await noReplaceMove(temporaryPath, target, await inspectRegularFile(temporaryPath))
          } else await noReplaceMove(old.path, target, proof)
        }
      } else {
        operation.stagePath = path.join(directory, `.delive-corrected-first-${randomUUID()}.md`)
        await this.persist({ ...this.state, pending: { ...this.state.pending, [request.sessionId]: operation } })
        const handle = await fs.promises.open(operation.stagePath, 'wx')
        try { await handle.writeFile(request.content, 'utf8'); await handle.sync() } finally { await handle.close() }
        operation.stageProof = await inspectRegularFile(operation.stagePath)
        if (operation.stageProof.sha256 !== hash) throw new Error('Initial staged Markdown did not verify')
        await this.persist({ ...this.state, pending: { ...this.state.pending, [request.sessionId]: operation } })
        await noReplaceMove(operation.stagePath, target, operation.stageProof)
      }
      const proof = await inspectRegularFile(target)
      if (proof.sha256 !== hash) throw new Error('Saved Markdown digest differs')
      const latest = await service.getSessionContext(request.sessionId)
      const registered: Registration = { path: target, ...proof, publicationId: request.publicationId, publicationRevision: request.publicationRevision, titleRevision: request.titleRevision, revision: (old?.revision || 0) + 1 }
      const next = { ...this.state, files: { ...this.state.files, [request.sessionId]: registered }, pending: { ...this.state.pending } }
      await this.persist(next)
      if (operation.backupPath && old) {
        const backup = await inspectRegularFile(operation.backupPath)
        if (backup.sha256 !== old.sha256 || backup.identity.dev !== old.identity.dev || backup.identity.ino !== old.identity.ino) throw new Error('Backup changed; cleanup paused')
        await this.deleteVerified(operation.backupPath, backup)
      }
      delete next.pending[request.sessionId]
      await this.persist(next)
      return { ...this.result(registered, request), status: latest.titleRevision === request.titleRevision ? 'saved' : 'pending' }
    })
  }
  private result(file: Registration, request: CorrectedMarkdownSaveRequest): CorrectedMarkdownFileState {
    return { status: 'saved', registrationId: request.sessionId, path: file.path, publicationId: file.publicationId, publicationRevision: file.publicationRevision, publicationHash: file.sha256, titleRevision: file.titleRevision, revision: file.revision, savedAt: Date.now() }
  }
}
let corrected: CorrectedMarkdownService | undefined
export function getCorrectedMarkdownService(): CorrectedMarkdownService { return corrected ||= new CorrectedMarkdownService(getFileStorageService().userData) }
