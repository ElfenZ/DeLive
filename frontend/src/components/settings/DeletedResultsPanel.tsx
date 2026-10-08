import { useState } from 'react'
import type { DeletedSessionSnapshot } from '../../types'
import { useUIStore } from '../../stores/uiStore'
import { useTopicStore } from '../../stores/topicStore'
import { getDeletedSessionSnapshots } from '../../utils/deletedSessionStorage'

export function DeletedResultsPanel() {
  const { t } = useUIStore()
  const topics = useTopicStore((state) => state.topics)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<DeletedSessionSnapshot[]>([])
  const [error, setError] = useState('')
  const toggle = async () => {
    if (loading) return
    if (open) { setOpen(false); return }
    setLoading(true)
    setError('')
    try { setResults(await getDeletedSessionSnapshots()); setOpen(true) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }
  return <section className="workspace-panel-muted space-y-3 p-4">
    <button disabled={loading} onClick={() => void toggle()} aria-expanded={open} className="text-sm font-medium hover:text-primary disabled:opacity-50">{t.topics.deletedResults}</button>
    <p className="text-xs text-muted-foreground">{t.topics.deletedSource}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {open && <div className="max-h-[60vh] overflow-y-auto space-y-3">
      {!results.length && <p className="text-sm text-muted-foreground">{t.topics.noDeletedResults}</p>}
      {results.map((snapshot) => <details key={snapshot.id} className="rounded-lg border border-border bg-background p-3">
        <summary className="cursor-pointer text-sm font-medium">{snapshot.title} <span className="text-xs font-normal text-muted-foreground">{new Date(snapshot.deletedAt).toLocaleString()}</span></summary>
        <div className="space-y-3 pt-3 text-sm">
          <p className="text-xs text-muted-foreground">{snapshot.projectIds.map((id) => topics.find((project) => project.id === id)?.name || id).join(', ')}</p>
          {snapshot.sourceLabel && <p className="text-xs text-muted-foreground">{snapshot.sourceLabel}</p>}
          {snapshot.originalFileName && <p className="text-xs text-muted-foreground">{snapshot.originalFileName}</p>}
          {snapshot.postProcess && <div className="space-y-2 whitespace-pre-wrap">
            <p>{snapshot.postProcess.summary}</p>
            {snapshot.postProcess.actionItems?.map((item, index) => <p key={index}>{item}</p>)}
            {snapshot.postProcess.keywords?.length && <p>{snapshot.postProcess.keywords.join(', ')}</p>}
            {snapshot.postProcess.chapters?.map((chapter, index) => <div key={index}><h4 className="font-medium">{chapter.title}</h4><p>{chapter.summary}</p></div>)}
          </div>}
          {snapshot.askHistory?.map((turn) => <div key={turn.id} className="space-y-1 whitespace-pre-wrap rounded-lg bg-muted/40 p-3"><h4 className="font-medium">{turn.question}</h4><p>{turn.answer || turn.error}</p>{turn.citations?.map((citation, index) => <blockquote key={index} className="border-l-2 border-border pl-3 text-xs text-muted-foreground">{citation.quote}</blockquote>)}</div>)}
          {snapshot.mindMap && <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs">{snapshot.mindMap.markdown}</pre>}
        </div>
      </details>)}
    </div>}
  </section>
}
