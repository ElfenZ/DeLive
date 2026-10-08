import { useState } from 'react'
import type { TranscriptSession } from '../../types'
import type { OriginalRenamePreview } from '../../../../shared/originalSources'
import { sessionRepository } from '../../utils/sessionRepository'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { syncSessionFiles } from '../../utils/sessionFileSync'
import { reconcileOriginalSource } from '../../utils/originalSourceReconciliation'

export function OriginalSourcePanel({ session }: { session: TranscriptSession }) {
  const { language } = useUIStore()
  const zh = language === 'zh'
  const [preview, setPreview] = useState<OriginalRenamePreview>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  if (!session.sourceMeta?.originalFileName && !session.sourceMeta?.originalSourceId) return null
  const run = async (operation: () => Promise<void>) => {
    if (pending) return
    setPending(true); setError('')
    try { await operation() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setPending(false) }
  }
  const choose = async () => {
    const api = window.electronAPI
    if (!api?.registerOriginalSource) throw new Error(zh ? '请在桌面应用选择原件。' : 'Select the original in the desktop app.')
    const filePath = await api.pickFilePath({ title: zh ? '重新选择本记录的原始输入文件' : 'Reselect the original input for this record' })
    if (!filePath) return
    const result = await api.registerOriginalSource(filePath, session.id)
    if (!result.ok || !result.source) throw new Error(result.error)
    if (session.sourceMeta?.originalFileSize && result.source.size !== session.sourceMeta.originalFileSize) throw new Error(zh ? '文件大小与历史输入不一致，未绑定为原件。' : 'Size differs from the historical input; not bound.')
    const source = result.source
    const sessions = await sessionRepository.updateMetadataDurable(session.id, (current) => ({ sourceMeta: { ...current.sourceMeta, originalSourceId: source.id, originalSourceRevision: source.revision, currentOriginalFileName: source.fileName } }))
    useSessionStore.setState({ sessions })
  }
  return <section className="workspace-panel-muted space-y-3 p-4 text-sm">
    <h3 className="font-semibold">{zh ? '原始输入文件' : 'Original input'}</h3>
    <p>{zh ? '历史导入名：' : 'Imported name: '}{session.sourceMeta.originalFileName}</p>
    <p>{zh ? '当前原件名：' : 'Current original name: '}{session.sourceMeta.currentOriginalFileName || (zh ? '需本机核实' : 'Local verification required')}</p>
    <p className="text-xs text-muted-foreground">{zh ? '原件改名仅在当前目录执行，须预览及系统确认；不会随 AI 标题自动改名。' : 'Original rename stays in its directory and requires preview and native confirmation. AI titles never rename it automatically.'}</p>
    <div className="flex flex-wrap gap-3 text-xs"><button disabled={pending} onClick={() => void run(choose)} className="rounded border border-input px-3 py-2">{zh ? '重新选择并核实原件' : 'Reselect original'}</button>
      {session.sourceMeta.originalSourceId && <button disabled={pending} onClick={() => void run(async () => {
        await syncSessionFiles(session.id)
        const result = await window.electronAPI!.previewOriginalRename(session.sourceMeta!.originalSourceId!, session.id)
        if (!result.ok || !result.preview) throw new Error(result.error)
        setPreview(result.preview)
      })} className="text-primary">{zh ? '预览按标题改名' : 'Preview title-based rename'}</button>}
      {session.sourceMeta.originalSourceId && <button disabled={pending} onClick={() => void run(async () => {
        setPreview(undefined)
        await syncSessionFiles(session.id)
        const result = await window.electronAPI!.previewOriginalUndo(session.sourceMeta!.originalSourceId!, session.id)
        if (!result.ok || !result.preview) throw new Error(result.error)
        setPreview(result.preview)
      })} className="text-primary">{zh ? '预览撤销上次改名' : 'Preview undo last rename'}</button>}
    </div>
    {preview && <div className="space-y-2 rounded border border-border p-3 text-xs"><p>{preview.oldName} → {preview.newName}</p><p className="break-all">{preview.directory}</p><p>{zh ? '共享原件引用：' : 'Shared references: '}{preview.affectedSessionIds.join(', ')}</p><button disabled={pending} className="text-primary" onClick={() => void run(async () => {
      setPreview(undefined)
      const result = await window.electronAPI!.commitOriginalRename(preview.token)
      if (!result) return
      if (!result.ok || !result.source) throw new Error(result.error)
      await reconcileOriginalSource(result.source)
      setPreview(undefined)
    })}>{zh ? '系统确认后执行' : 'Execute after native confirmation'}</button><p>{zh ? '外部引用和链接无法自动修复。' : 'External references and links cannot be repaired automatically.'}</p></div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>
}
