import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useFileTranscriptionStore } from '../../stores/fileTranscriptionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { isPublishedCorrectionAutoSaveEnabled } from '../../utils/publishedMarkdownCoordinator'
import { Switch } from '../ui'
import { formatFileSize } from '../../types/fileTranscription'
import type { LocalFileStatus, StorageDirectoryTarget, TranscriptDirectorySelection, MediaMigrationPreview, MediaMigrationResult } from '../../../../shared/fileStorage'

export function FileStoragePanel({ projectId }: { projectId?: string }) {
  const { t } = useUIStore()
  const [status, setStatus] = useState<LocalFileStatus>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [preview, setPreview] = useState<MediaMigrationPreview>()
  const desktop = Boolean(window.electronAPI?.getFileStorageStatus)
  const autoSave = useSettingsStore((state) => isPublishedCorrectionAutoSaveEnabled(state.settings))
  const recordingState = useSessionStore((state) => state.recordingState)
  const jobs = useFileTranscriptionStore((state) => state.jobs)
  const creationBusy = recordingState !== 'idle' || jobs.some((job) => ['queued', 'extracting', 'uploading', 'transcribing'].includes(job.status))
  useEffect(() => {
    if (!desktop) return
    let active = true
    let running = false, dirty = false
    const refresh = async () => {
      if (running) { dirty = true; return }
      running = true
      try {
        do {
          dirty = false
          try {
            const result = await window.electronAPI!.getFileStorageStatus()
            if (!active) return
            if (result.ok && result.status) setStatus(result.status)
            else setError(result.error || t.fileStorage.unavailable)
          } catch (error) { if (active) setError(error instanceof Error ? error.message : String(error)) }
        } while (active && dirty)
      } finally { running = false }
    }
    void refresh()
    const unsubscribe = window.electronAPI!.onFileStorageChanged?.(() => { void refresh() })
    return () => { active = false; unsubscribe?.() }
  }, [desktop, projectId, t.fileStorage.unavailable])

  const run = async (operation: () => Promise<void>) => {
    if (pending) return
    setPending(true)
    setError('')
    try { await operation() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setPending(false) }
  }
  const choose = async (target: TranscriptDirectorySelection) => {
    const result = await window.electronAPI!.chooseTranscriptDirectory(target)
    if (!result) return
    if (!result.ok || !result.status) throw new Error(result.error || t.fileStorage.unavailable)
    setStatus(result.status)
  }
  const open = async (target: StorageDirectoryTarget) => {
    const result = await window.electronAPI!.openStorageDirectory(target)
    if (!result.ok) throw new Error(result.error || t.fileStorage.unavailable)
  }
  const selection: TranscriptDirectorySelection = projectId ? { kind: 'project-transcript', projectId } : { kind: 'default-transcript' }
  const migrate = async (operation: () => Promise<MediaMigrationResult | null>) => {
    const result = await operation()
    if (!result) return
    if (result.status) setStatus(result.status)
    if (!result.ok) throw new Error(result.code === 'FILE_STORAGE_BUSY' ? t.fileStorage.changeBusy : result.error || t.fileStorage.unavailable)
    if (result.preview) setPreview(result.preview)
    if (result.migrationId) setPreview(undefined)
    if (result.skipped?.length) setError(result.skipped.map((item) => `${item.path}: ${item.error}`).join('\n'))
  }
  const directory = projectId ? status?.configuration.projectTranscriptDirectories[projectId] || status?.configuration.defaultTranscriptDirectory : status?.configuration.defaultTranscriptDirectory
  const availability = projectId ? status?.projectTranscripts[projectId] || status?.transcript : status?.transcript

  return <section className="workspace-panel-muted space-y-3 p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{projectId ? t.fileStorage.projectDirectory : t.fileStorage.title}</h3>
      {desktop && <button disabled={pending} className="text-xs text-primary disabled:opacity-50" onClick={() => void run(async () => {
        const result = await window.electronAPI!.getFileStorageStatus()
        if (!result.ok || !result.status) throw new Error(result.error || t.fileStorage.unavailable)
        setStatus(result.status)
      })}>{t.fileStorage.refresh}</button>}
    </div>
    {!desktop ? <p className="text-xs text-muted-foreground">{t.fileStorage.desktopOnly}</p> : <>
      {!projectId && <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-xs font-medium">{t.fileStorage.mediaRoot}</p>
        <p className="break-all font-mono text-xs">{status?.configuration.mediaRoot || '...'}</p>
        {status && <p className={`text-xs ${status.media.available && status.media.writable ? 'text-muted-foreground' : 'text-destructive'}`}>{status.media.available && status.media.writable ? t.fileStorage.available : status.media.error || t.fileStorage.unavailable}</p>}
        <button disabled={pending || !status?.media.available} className="inline-flex items-center gap-1 text-xs text-primary disabled:opacity-50" onClick={() => void run(() => open({ kind: 'media' }))}><FolderOpen className="h-3.5 w-3.5" />{t.fileStorage.openDirectory}</button>
        {status && <p className="text-xs text-muted-foreground">{t.fileStorage.registeredAssets}: {status.managedAssetCount} / {formatFileSize(status.managedBytes)} · {t.fileStorage.pendingOperations}: {status.pendingOperationCount}{status.busy ? ` · ${t.fileStorage.busy}` : ''}</p>}
        <p className="text-xs text-muted-foreground">{t.fileStorage.mediaHint}</p>
        <button disabled={pending || creationBusy || status?.busy || Boolean(status?.pendingOperationCount)} className="rounded border border-input px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50" onClick={() => void run(async () => {
          if (creationBusy) throw new Error(t.fileStorage.changeBusy)
          const result = await window.electronAPI!.chooseMediaDirectory()
          if (!result) return
          if (!result.ok || !result.status) throw new Error(result.error || t.fileStorage.unavailable)
          setStatus(result.status)
          setPreview(undefined)
        })}>{t.fileStorage.chooseMediaDirectory}</button>
        {(creationBusy || status?.busy || Boolean(status?.pendingOperationCount)) && <p className="text-xs text-muted-foreground">{t.fileStorage.changeBusy}</p>}
        <button disabled={pending || status?.busy} className="rounded border border-input px-3 py-1.5 text-xs disabled:opacity-50" onClick={() => void run(async () => {
          const contexts = useSessionStore.getState().sessions.map((session) => ({ sessionId: session.id, title: session.title, createdAt: session.createdAt, titleRevision: session.titleRevision || 0 }))
          const preview = await window.electronAPI!.previewManagedNames(contexts)
          if (!preview.ok || !preview.token) throw new Error(preview.error)
          const result = await window.electronAPI!.applyManagedNames(preview.token)
          if (result && !result.ok) throw new Error(result.error)
        })}>{t.fileStorage.arrangeNames}</button>
        <button disabled={pending || creationBusy || status?.busy} className="rounded border border-input px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50" onClick={() => void run(() => migrate(() => window.electronAPI!.chooseMediaMigration()))}>{t.fileStorage.migrateMedia}</button>
        {preview && <div className="space-y-2 rounded-lg bg-background p-3 text-xs">
          <p className="font-medium">{t.fileStorage.migrationPreview}</p>
          {(preview.sourceRoots || [preview.sourceRoot]).map((root) => <p key={root} className="break-all">{t.fileStorage.sourceRoot}: {root}</p>)}
          <p className="break-all">{t.fileStorage.targetRoot}: {preview.targetRoot}</p>
          <p>{t.fileStorage.files}: {preview.fileCount} / {formatFileSize(preview.totalBytes)}</p>
          <p>{t.fileStorage.requiredSpace}: {formatFileSize(preview.requiredCopyBytes)} / {formatFileSize(preview.availableBytes)}</p>
          <p>{t.fileStorage.reusedFiles}: {preview.reusedFileCount}</p>
          <p>{t.fileStorage.unknownRetained}: {preview.unknownEntryCount}</p>
          <div className="flex flex-wrap gap-3"><button disabled={pending} className="text-primary" onClick={() => void run(() => migrate(() => window.electronAPI!.applyMediaMigration(preview.token)))}>{t.fileStorage.confirmMigration}</button><button disabled={pending} onClick={() => setPreview(undefined)}>{t.common.cancel}</button></div>
        </div>}
        {status?.migrations?.map((migration) => <div key={migration.id} className="space-y-2 rounded-lg border border-border p-3 text-xs">
          {(migration.sourceRoots || [migration.sourceRoot]).map((root) => <p key={root} className="break-all">{root} → {migration.targetRoot}</p>)}
          <p>{migration.phase === 'copying' ? t.fileStorage.migrationCopying : migration.phase === 'abandoned' ? t.fileStorage.migrationAbandoned : t.fileStorage.migrationDone}</p>
          <p>{migration.completedFiles}/{migration.fileCount} · {t.fileStorage.remainingCopies}: {migration.remainingCopies} / {formatFileSize(migration.remainingBytes)}</p>
          {migration.error && <p className="break-words text-destructive">{migration.error}</p>}
          <div className="flex flex-wrap gap-3">
            {migration.phase === 'copying' && <><button disabled={pending} className="text-primary" onClick={() => void run(() => migrate(() => window.electronAPI!.resumeMediaMigration(migration.id)))}>{t.fileStorage.resumeMigration}</button><button disabled={pending} onClick={() => void run(() => migrate(() => window.electronAPI!.abandonMediaMigration(migration.id)))}>{t.fileStorage.abandonMigration}</button></>}
            {migration.phase === 'committed' && migration.remainingCopies > 0 && <button disabled={pending || status.busy} className="text-primary disabled:opacity-50" onClick={() => void run(() => migrate(() => window.electronAPI!.cleanupMediaMigration(migration.id)))}>{t.fileStorage.cleanupCopies}</button>}
          </div>
        </div>)}
      </div>}
      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-xs font-medium">{projectId ? t.fileStorage.projectDirectory : t.fileStorage.transcriptDirectory}</p>
        {projectId && !status?.configuration.projectTranscriptDirectories[projectId] && <p className="text-xs text-muted-foreground">{t.fileStorage.inheritsDefault}</p>}
        <p className="break-all font-mono text-xs">{directory || t.fileStorage.unconfigured}</p>
        {directory && <p className={`text-xs ${availability?.available && availability.writable ? 'text-muted-foreground' : 'text-destructive'}`}>{availability?.available && availability.writable ? t.fileStorage.available : availability?.error || t.fileStorage.unavailable}</p>}
        <div className="flex flex-wrap gap-3 text-xs">
          <button disabled={pending} onClick={() => void run(() => choose(selection))} className="rounded border border-input px-3 py-1.5 hover:bg-accent disabled:opacity-50">{t.fileStorage.chooseDirectory}</button>
          <button disabled={pending || !directory || !availability?.available} onClick={() => void run(() => open(selection))} className="text-primary disabled:opacity-50">{t.fileStorage.openDirectory}</button>
        </div>
        <p className="text-xs text-muted-foreground">{t.fileStorage.directoryHint}</p>
        {!projectId && <>
          <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">{t.fileStorage.autoSavePublished}</p>
              <p className="text-xs text-muted-foreground">{t.fileStorage.autoSaveHint}</p>
            </div>
            <Switch checked={autoSave} disabled={!window.electronAPI?.savePublishedMarkdown} onChange={(value) => useSettingsStore.getState().updateSettings({ autoSavePublishedCorrection: value })} aria-label={t.fileStorage.autoSavePublished} />
          </div>
          {autoSave && !directory && <p role="status" className="text-xs text-muted-foreground">{t.fileStorage.autoSaveWaiting}</p>}
        </>}
      </div>
    </>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>
}
