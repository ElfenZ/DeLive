import { dialog, shell, type BrowserWindow, type IpcMain } from 'electron'
import { assertMainWindowSender } from './ipcSecurity'
import { getFileStorageService } from './fileStorage'
import { FileStorageError } from './fileStorageService'
import { getCorrectedMarkdownService } from './correctedMarkdown'
import path from 'path'
import { clearPerformanceDiagnostics, getPerformanceDiagnostics, setPerformanceDiagnosticsEnabled, startPerformanceSpan } from '../shared/performanceDiagnostics'
import { isSafeStorageId, type StorageOperationResult, type TranscriptDirectorySelection, type StorageDirectoryTarget, type MediaMigrationResult } from '../shared/fileStorage'

interface FileStorageIpcOptions { ipcMain: IpcMain; getMainWindow: () => BrowserWindow | null }

function validateTarget(value: unknown, allowMedia: boolean): StorageDirectoryTarget {
  if (!value || typeof value !== 'object') throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid directory target')
  const target = value as Partial<StorageDirectoryTarget> & { projectId?: unknown }
  if (target.kind === 'default-transcript') return { kind: target.kind }
  if (allowMedia && target.kind === 'media') return { kind: 'media' }
  if (target.kind === 'project-transcript' && isSafeStorageId(target.projectId)) return { kind: target.kind, projectId: target.projectId }
  throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid directory role or project ID')
}

function failure(error: unknown): StorageOperationResult {
  return { ok: false, code: error instanceof FileStorageError ? error.code : 'FILE_STORAGE_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) }
}

export function registerFileStorageIpc(options: FileStorageIpcOptions): void {
  options.ipcMain.handle('list-recording-recovery-notices', async (event, activeSessionIds) => {
    assertMainWindowSender(event, 'list-recording-recovery-notices', options.getMainWindow)
    try { return { ok: true, items: await getFileStorageService().listRecordingRecoveryNotices(activeSessionIds) } }
    catch (error) { return failure(error) }
  })
  options.ipcMain.handle('acknowledge-recording-recovery', async (event, request) => {
    assertMainWindowSender(event, 'acknowledge-recording-recovery', options.getMainWindow)
    try { await getFileStorageService().acknowledgeRecordingRecovery(request); return { ok: true } }
    catch (error) { return failure(error) }
  })
  options.ipcMain.handle('set-performance-diagnostics', async (event, enabled) => {
    assertMainWindowSender(event, 'set-performance-diagnostics', options.getMainWindow)
    if (typeof enabled !== 'boolean') throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid diagnostic preference')
    setPerformanceDiagnosticsEnabled(enabled)
    return { ok: true }
  })
  options.ipcMain.handle('get-performance-diagnostics', async (event) => {
    assertMainWindowSender(event, 'get-performance-diagnostics', options.getMainWindow)
    return { records: getPerformanceDiagnostics() }
  })
  options.ipcMain.handle('clear-performance-diagnostics', async (event) => {
    assertMainWindowSender(event, 'clear-performance-diagnostics', options.getMainWindow)
    clearPerformanceDiagnostics()
    return { ok: true }
  })
  options.ipcMain.handle('adopt-legacy-published-markdown', async (event, request) => {
    assertMainWindowSender(event, 'adopt-legacy-published-markdown', options.getMainWindow)
    try {
      const selected = await dialog.showOpenDialog(options.getMainWindow()!, { title: '接管旧纠错稿 / Adopt Existing Corrected Markdown', properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (selected.canceled || !selected.filePaths.length) return null
      const confirmed = await dialog.showMessageBox(options.getMainWindow()!, { type: 'warning', title: '确认接管 / Confirm Adoption', message: selected.filePaths[0],
        detail: '仅在文件内容与当前已发布纠错稿完全一致时接管，保留当前位置和名称，不改变默认目录，不复制或覆盖文件。', buttons: ['取消 / Cancel', '核实并接管 / Verify and Adopt'], defaultId: 0, cancelId: 0 })
      if (confirmed.response !== 1) return null
      assertMainWindowSender(event, 'adopt-legacy-published-markdown', options.getMainWindow)
      const span = startPerformanceSpan('native.markdown-adopt')
      let successful = false
      try {
        const file = await getCorrectedMarkdownService().adoptLegacy(request, selected.filePaths[0])
        successful = true
        return { ok: true, file }
      } finally { span.finish(successful ? 'success' : 'error') }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  options.ipcMain.handle('locate-published-markdown', async (event, sessionId: string) => {
    assertMainWindowSender(event, 'locate-published-markdown', options.getMainWindow)
    try {
      const selected = await dialog.showOpenDialog(options.getMainWindow()!, { properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (selected.canceled || !selected.filePaths.length) return null
      assertMainWindowSender(event, 'locate-published-markdown', options.getMainWindow)
      return { ok: true, file: await getCorrectedMarkdownService().locate(sessionId, selected.filePaths[0]) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  options.ipcMain.handle('relocate-published-markdown', async (event, sessionId: string) => {
    assertMainWindowSender(event, 'relocate-published-markdown', options.getMainWindow)
    try {
      const service = getCorrectedMarkdownService()
      const registered = await service.registeredState(sessionId)
      if (!registered?.path) throw new Error('No registered Markdown to relocate')
      const selected = await dialog.showOpenDialog(options.getMainWindow()!, { properties: ['openDirectory', 'createDirectory'] })
      if (selected.canceled || !selected.filePaths.length) return null
      const confirmed = await dialog.showMessageBox(options.getMainWindow()!, { type: 'warning', title: '重新选择稿件保存位置 / Relocate Markdown', message: `${registered.path}\n→ ${selected.filePaths[0]}`, detail: '仅迁移未被外部修改的已登记稿件，不覆盖目标。成功后只维护新位置。', buttons: ['取消 / Cancel', '确认迁移 / Confirm'], defaultId: 0, cancelId: 0 })
      if (confirmed.response !== 1) return null
      assertMainWindowSender(event, 'relocate-published-markdown', options.getMainWindow)
      return { ok: true, file: await service.relocate(sessionId, selected.filePaths[0]) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  options.ipcMain.handle('save-published-markdown', async (event, request) => {
    assertMainWindowSender(event, 'save-published-markdown', options.getMainWindow)
    try {
      const service = getCorrectedMarkdownService()
      const suggestion = await service.suggestFirstTarget(request)
      let confirmedName: string | undefined
      if (suggestion) {
        const confirmation = await dialog.showMessageBox(options.getMainWindow()!, { type: 'warning', title: '稿件重名 / Markdown Name Conflict', message: suggestion.existing,
          detail: `已有文件不覆盖。保存为 / Save without overwrite:\n${path.join(path.dirname(suggestion.existing), suggestion.suggested)}`, buttons: ['取消 / Cancel', '使用新名称 / Use New Name'], defaultId: 0, cancelId: 0 })
        if (confirmation.response !== 1) return { ok: false, error: 'Filename conflict requires an explicit non-overwriting choice', file: { status: 'conflict', revision: 0, error: 'Existing file retained' } }
        assertMainWindowSender(event, 'save-published-markdown', options.getMainWindow)
        confirmedName = suggestion.suggested
      }
      return { ok: true, file: await service.save(request, confirmedName) }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const prior = await getCorrectedMarkdownService().registeredState(request?.sessionId).catch(() => undefined)
      const status = error instanceof FileStorageError && error.code === 'FILE_STORAGE_UNAVAILABLE' ? 'waiting-directory'
        : /externally|differs|exists|interrupted|replaced|changed|older restored/i.test(message) || (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'conflict' : 'error'
      return { ok: false, error: message, file: { ...prior, status, revision: prior?.revision || 0, error: message } }
    }
  })
  getFileStorageService().subscribe((event) => {
    const window = options.getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send('file-storage-changed', event)
  })
  options.ipcMain.handle('register-session-files', async (event, context, nameFiles = false) => {
    assertMainWindowSender(event, 'register-session-files', options.getMainWindow)
    try { return { ok: true, naming: await getFileStorageService().registerSessionContext(context, nameFiles === true) } }
    catch (error) { return failure(error) }
  })
  options.ipcMain.handle('preview-managed-names', async (event, contexts) => {
    assertMainWindowSender(event, 'preview-managed-names', options.getMainWindow)
    try { return { ok: true, ...await getFileStorageService().previewManagedNames(contexts, event.sender.id) } } catch (error) { return failure(error) }
  })
  options.ipcMain.handle('apply-managed-names', async (event, token: string) => {
    assertMainWindowSender(event, 'apply-managed-names', options.getMainWindow)
    try {
      const service = getFileStorageService()
      const preview = service.getManagedNamingPreview(token, event.sender.id)
      const confirmed = await dialog.showMessageBox(options.getMainWindow()!, { type: 'warning', title: '整理受管文件名 / Arrange Managed Names', message: `${preview.items.length} files`, detail: preview.items.map((item) => `${item.oldName} → ${item.newName}`).join('\n'), buttons: ['取消 / Cancel', '确认整理 / Confirm'], defaultId: 0, cancelId: 0 })
      if (confirmed.response !== 1) return null
      assertMainWindowSender(event, 'apply-managed-names', options.getMainWindow)
      await service.applyManagedNames(token, event.sender.id)
      return { ok: true }
    } catch (error) { return failure(error) }
  })
  options.ipcMain.handle('mark-file-record-deletion', async (event, sessionId: string, phase: string) => {
    assertMainWindowSender(event, 'mark-file-record-deletion', options.getMainWindow)
    try {
      if (phase !== 'prepare' && phase !== 'commit' && phase !== 'cancel') throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid deletion phase')
      await getFileStorageService().recordDeletion(sessionId, phase)
      return { ok: true }
    } catch (error) { return failure(error) }
  })
  options.ipcMain.handle('reconcile-file-record-bindings', async (event, contexts, deletedIds) => {
    assertMainWindowSender(event, 'reconcile-file-record-bindings', options.getMainWindow)
    try { await getFileStorageService().reconcileRecordBindings(contexts, deletedIds); return { ok: true } }
    catch (error) { return failure(error) }
  })
  options.ipcMain.handle('file-storage-status', async (event): Promise<StorageOperationResult> => {
    assertMainWindowSender(event, 'file-storage-status', options.getMainWindow)
    try { return { ok: true, status: await getFileStorageService().status() } }
    catch (error) { return failure(error) }
  })

  options.ipcMain.handle('choose-media-directory', async (event): Promise<StorageOperationResult | null> => {
    assertMainWindowSender(event, 'choose-media-directory', options.getMainWindow)
    try {
      const service = getFileStorageService()
      const current = await service.status()
      if (current.busy || current.pendingOperationCount) throw new FileStorageError('FILE_STORAGE_BUSY', 'Finish recording, transcription or pending file operations before changing audio storage')
      const result = await dialog.showOpenDialog(options.getMainWindow()!, {
        title: '选择新音频存储位置 / Choose Future Audio Storage', properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || !result.filePaths.length) return null
      const confirmed = await dialog.showMessageBox(options.getMainWindow()!, {
        type: 'info', title: '仅更改新音频位置 / Future Audio Only', message: path.join(result.filePaths[0], 'DeLive-media'),
        detail: '新录音和导入音频写入此专用子目录。旧音频不搬动，自动导出目录不变。 / New audio only; existing audio stays registered in place. Text export is unchanged.',
        buttons: ['取消 / Cancel', '使用此位置 / Use Location'], defaultId: 0, cancelId: 0,
      })
      if (confirmed.response !== 1) return null
      assertMainWindowSender(event, 'choose-media-directory', options.getMainWindow)
      return { ok: true, status: await service.configureMediaDirectory(result.filePaths[0]) }
    } catch (error) { return failure(error) }
  })

  options.ipcMain.handle('choose-transcript-directory', async (event, request: TranscriptDirectorySelection): Promise<StorageOperationResult | null> => {
    assertMainWindowSender(event, 'choose-transcript-directory', options.getMainWindow)
    try {
      const target = validateTarget(request, false)
      const result = await dialog.showOpenDialog(options.getMainWindow()!, { properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled || !result.filePaths.length) return null
      // The only path source is this native dialog; renderer/backup paths never become grants.
      const status = await getFileStorageService().configureTranscriptDirectory(result.filePaths[0], target.kind === 'project-transcript' ? target.projectId : undefined)
      return { ok: true, status }
    } catch (error) { return failure(error) }
  })

  options.ipcMain.handle('open-storage-directory', async (event, request: StorageDirectoryTarget) => {
    assertMainWindowSender(event, 'open-storage-directory', options.getMainWindow)
    try {
      const target = validateTarget(request, true)
      const service = getFileStorageService()
      const directory = target.kind === 'media' ? (await service.getConfiguration()).mediaRoot
        : await service.transcriptDirectory(target.kind === 'project-transcript' ? target.projectId : undefined)
      await service.assertGrantedDirectory(directory)
      const error = await shell.openPath(directory)
      return error ? { ok: false, error } : { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })

  options.ipcMain.handle('choose-media-migration', async (event): Promise<MediaMigrationResult | null> => {
    assertMainWindowSender(event, 'choose-media-migration', options.getMainWindow)
    try {
      const result = await dialog.showOpenDialog(options.getMainWindow()!, { properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled || !result.filePaths.length) return null
      const preview = await getFileStorageService().previewMigration(result.filePaths[0], event.sender.id)
      return { ok: true, preview }
    } catch (error) { return failure(error) }
  })

  options.ipcMain.handle('apply-media-migration', async (event, token: string): Promise<MediaMigrationResult | null> => {
    assertMainWindowSender(event, 'apply-media-migration', options.getMainWindow)
    try {
      const service = getFileStorageService()
      const preview = service.getMigrationPreview(token, event.sender.id)
      const confirmation = await dialog.showMessageBox(options.getMainWindow()!, {
        type: 'warning', title: '迁移受管音频 / Migrate Managed Audio',
        message: `${(preview.sourceRoots || [preview.sourceRoot]).join('\n')}\n→ ${preview.targetRoot}`,
        detail: `${preview.fileCount} files / ${preview.totalBytes} bytes\n原件、外部稿件、数据库及模型不移动。旧副本保留，清理需另行确认。`,
        buttons: ['取消 / Cancel', '复制并切换 / Copy and Switch'], defaultId: 0, cancelId: 0,
      })
      if (confirmation.response !== 1) return null
      assertMainWindowSender(event, 'apply-media-migration', options.getMainWindow)
      const id = await service.applyMigration(token, event.sender.id)
      return { ok: true, migrationId: id, status: await service.status() }
    } catch (error) { return { ...failure(error), status: await getFileStorageService().status().catch(() => undefined) } }
  })

  options.ipcMain.handle('resume-media-migration', async (event, id: string): Promise<MediaMigrationResult> => {
    assertMainWindowSender(event, 'resume-media-migration', options.getMainWindow)
    try {
      if (!isSafeStorageId(id)) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid migration ID')
      await getFileStorageService().resumeMigration(id)
      return { ok: true, migrationId: id, status: await getFileStorageService().status() }
    } catch (error) { return { ...failure(error), status: await getFileStorageService().status().catch(() => undefined) } }
  })

  for (const action of ['cleanup', 'abandon'] as const) options.ipcMain.handle(`${action}-media-migration`, async (event, id: string): Promise<MediaMigrationResult | null> => {
    assertMainWindowSender(event, `${action}-media-migration`, options.getMainWindow)
    try {
      if (!isSafeStorageId(id)) throw new FileStorageError('FILE_STORAGE_INVALID', 'Invalid migration ID')
      const service = getFileStorageService()
      const migration = (await service.status()).migrations?.find((item) => item.id === id)
      if (!migration) throw new FileStorageError('FILE_STORAGE_MISSING', 'Migration journal is unavailable')
      const confirmation = await dialog.showMessageBox(options.getMainWindow()!, {
        type: 'warning', title: action === 'cleanup' ? '清理已验证旧副本 / Clean Old Copies' : '放弃未完成迁移 / Abandon Migration',
        message: action === 'cleanup' ? `${(migration.sourceRoots || [migration.sourceRoot]).join('\n')}\n${migration.remainingCopies} copies / ${migration.remainingBytes} bytes` : `${(migration.sourceRoots || [migration.sourceRoot]).join('\n')}\n保留原目录，目标残留不删除：${migration.targetRoot}`,
        detail: '未知或已改变文件不删除。此操作不撤销已成功切换的媒体根。',
        buttons: ['取消 / Cancel', action === 'cleanup' ? '确认清理 / Confirm Cleanup' : '保留原目录 / Keep Source'], defaultId: 0, cancelId: 0,
      })
      if (confirmation.response !== 1) return null
      assertMainWindowSender(event, `${action}-media-migration`, options.getMainWindow)
      const skipped = action === 'cleanup' ? await service.cleanupMigration(id) : undefined
      if (action === 'abandon') await service.abandonMigration(id)
      return { ok: true, migrationId: id, skipped, status: await service.status() }
    } catch (error) { return { ...failure(error), status: await getFileStorageService().status().catch(() => undefined) } }
  })
}
