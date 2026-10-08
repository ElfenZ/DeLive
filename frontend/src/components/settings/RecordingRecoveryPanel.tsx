import { useEffect, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import type { RecordingRecoveryNotice } from '../../../../shared/fileStorage'

export function RecordingRecoveryPanel() {
  const t = useUIStore((state) => state.t)
  const sessions = useSessionStore((state) => state.sessions)
  const [items, setItems] = useState<RecordingRecoveryNotice[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const desktop = Boolean(window.electronAPI?.listRecordingRecoveryNotices)
  useEffect(() => {
    if (!desktop) return
    let active = true
    void window.electronAPI!.listRecordingRecoveryNotices(useSessionStore.getState().sessions.map((session) => session.id))
      .then((result) => { if (active) { if (result.ok) setItems(result.items || []); else setError(result.error || t.recordingRecovery.failed) } })
      .catch(() => { if (active) setError(t.recordingRecovery.failed) })
    return () => { active = false }
  }, [desktop, t.recordingRecovery.failed])
  const refresh = async () => {
    const result = await window.electronAPI!.listRecordingRecoveryNotices(useSessionStore.getState().sessions.map((session) => session.id))
    if (!result.ok) throw new Error(result.error || t.recordingRecovery.failed)
    setItems(result.items || [])
  }
  const run = async (action: () => Promise<void>) => {
    if (pending) return
    setPending(true); setError('')
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : t.recordingRecovery.failed) }
    finally { setPending(false) }
  }
  if (!desktop) return null
  return <section className="workspace-panel-muted space-y-3 p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{t.recordingRecovery.title}</h3><button disabled={pending} className="text-xs text-primary disabled:opacity-50" onClick={() => void run(refresh)}>{t.fileStorage.refresh}</button></div>
    <p className="text-xs text-muted-foreground">{t.recordingRecovery.hint}</p>
    {items.length === 0 && <p className="text-xs text-muted-foreground">{t.recordingRecovery.empty}</p>}
    {items.map((item) => <div key={item.key} className="space-y-2 rounded border border-border p-3 text-xs">
      <p className="break-all font-medium">{sessions.find((session) => session.id === item.sessionId)?.title || item.sessionId}</p>
      <p className="text-muted-foreground">{t.recordingRecovery.reasons[item.reason]}</p>
      {item.acknowledged ? <p className="text-muted-foreground">{t.recordingRecovery.acknowledged}</p> : <button disabled={pending} className="rounded border border-input px-3 py-1.5 hover:bg-accent disabled:opacity-50" onClick={() => void run(async () => {
        const result = await window.electronAPI!.acknowledgeRecordingRecovery({ key: item.key, evidence: item.evidence, activeSessionIds: useSessionStore.getState().sessions.map((session) => session.id) })
        if (!result.ok) throw new Error(result.error || t.recordingRecovery.failed)
        await refresh()
      })}>{t.recordingRecovery.acknowledge}</button>}
    </div>)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>
}
