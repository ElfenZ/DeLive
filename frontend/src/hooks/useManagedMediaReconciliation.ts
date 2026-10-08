import { useEffect } from 'react'
import { reconcileManagedMedia } from '../utils/managedMediaReconciliation'
import { reconcileOriginalSourceCatalog } from '../utils/originalSourceReconciliation'

export function useManagedMediaReconciliation(ready: boolean): void {
  useEffect(() => {
    const api = window.electronAPI
    if (!ready || !api?.listMediaAudio) return
    let disposed = false
    let running = false
    let generation = 0
    const refresh = async () => {
      generation++
      if (running) return
      running = true
      try {
        let requested: number
        do {
          requested = generation
          await reconcileOriginalSourceCatalog(() => !disposed && requested === generation).catch((error: unknown) => {
            console.warn('[OriginalSource] Registry reconciliation failed; original references retained:', error)
          })
          if (disposed) return
          const result = await api.listMediaAudio()
          if (disposed) return
          if (requested === generation) await reconcileManagedMedia(result, () => !disposed && requested === generation)
        } while (!disposed && requested !== generation)
      } catch (error) { console.warn('[ManagedMedia] Cache reconciliation failed; retry on the next file event:', error) }
      finally { running = false }
    }
    const unsubscribe = api.onFileStorageChanged?.((event) => { if (!event.activityOnly) void refresh() })
    const unsubscribeOriginal = api.onOriginalSourceChanged?.(() => { void refresh() })
    void refresh()
    return () => { disposed = true; unsubscribe?.(); unsubscribeOriginal?.() }
  }, [ready])
}
