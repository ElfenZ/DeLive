import { useEffect, useRef, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import type { CorrectionEditExpectation, ManualCorrectionEdit, ResolvedCorrectionPatch, TranscriptSession } from '../../types'
import { CorrectionConflictError, sha256Utf8 } from '../../utils/correctionPatch'
import { useSessionStore } from '../../stores/sessionStore'
import { useCorrectionReviewStore } from '../../stores/correctionReviewStore'
import { ActionDialog } from '../ActionDialog'
import { ManualCorrectionEditor } from './ManualCorrectionEditor'
import { correctionErrorMessage } from './correctionMessages'

interface CorrectionWorkspaceProps {
  session: TranscriptSession
  patches: ResolvedCorrectionPatch[]
  isZh: boolean
  disabled: boolean
  readOnly?: boolean
  onBusyChange?: (busy: boolean) => void
  onSaved?: (patchId: string) => void
  review?: {
    selected: Set<string>
    edits: Record<string, string>
    errors: Record<string, string>
    onToggle: (patchId: string) => void
    onEdit: (patchId: string, value: string) => void
    onPersist: (patch: ResolvedCorrectionPatch) => Promise<void>
  }
}

export function CorrectionWorkspace({ session, patches, isZh, disabled, readOnly = false, review, onBusyChange, onSaved }: CorrectionWorkspaceProps) {
  const [filter, setFilter] = useState<'applied' | 'reverted' | 'rejected'>('applied')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const filterRef = useRef<HTMLDivElement>(null)
  const focusFilter = () => filterRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
  const mounted = useRef(false)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<{ transcript: string; patch?: ResolvedCorrectionPatch; expected: CorrectionEditExpectation } | null>(null)
  const [stateConflict, setStateConflict] = useState<{ patch: ResolvedCorrectionPatch; expected: CorrectionEditExpectation; conflicts: ResolvedCorrectionPatch[] } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const latest = () => useSessionStore.getState().sessions.find((item) => item.id === session.id) || session
  const expectation = async (source: TranscriptSession): Promise<CorrectionEditExpectation> => {
    const draft = review ? source.correction?.draft : undefined
    const published = source.correction?.published
    return { target: draft ? 'draft' : published ? 'published' : 'new', id: draft?.runId || published?.id,
      revision: draft?.revision || published?.revision || 0,
      baseTranscriptHash: draft?.baseTranscriptHash || published?.baseTranscriptHash || await sha256Utf8(source.transcript) }
  }
  const markBusy = (value: boolean) => { busyRef.current = value; if (mounted.current) setBusy(value); onBusyChange?.(value) }
  const syncReview = () => {
    const draft = latest().correction?.draft
    if (!review || !draft) return
    const store = useCorrectionReviewStore.getState()
    store.sync(session.id, draft.runId, draft.proposedPatches.map((patch) => patch.id))
    const selected = useCorrectionReviewStore.getState().reviews[session.id]?.selectedIds || []
    store.select(session.id, draft.runId, selected.filter((id) => draft.proposedPatches.some((patch) => patch.id === id && patch.state !== 'reverted')))
  }
  const openEditor = async (patch?: ResolvedCorrectionPatch) => {
    if (busyRef.current || disabled || readOnly) return
    markBusy(true)
    setError('')
    try {
      const before = latest().correction
      if (review && patch && patch.state !== 'rejected') await review.onPersist(patch)
      const source = latest()
      if (source.correction?.draft?.runId !== before?.draft?.runId || source.correction?.published?.id !== before?.published?.id) throw new Error('correction-revision-mismatch')
      const expected = await expectation(source)
      const available = review ? source.correction?.draft ? [...source.correction.draft.proposedPatches, ...source.correction.draft.rejectedPatches] : [] : source.correction?.published?.patches || []
      const currentPatch = patch ? available.find((item) => item.id === patch.id) : undefined
      if (patch && !currentPatch) throw new Error('correction-revision-mismatch')
      if (mounted.current) setEditor({ transcript: source.transcript,
        patch: currentPatch,
        expected })
    } catch (reason) { if (mounted.current) setError(correctionErrorMessage(reason, isZh)) }
    finally { markBusy(false) }
  }
  const saveEdit = async (edit: ManualCorrectionEdit, expected: CorrectionEditExpectation) => {
    markBusy(true)
    try {
      await useSessionStore.getState().saveSessionManualCorrection(session.id, edit, expected)
      syncReview()
      const savedPatch = (review ? latest().correction?.draft?.proposedPatches : latest().correction?.published?.patches)
        ?.find((patch) => patch.state !== 'rejected' && patch.sourceStart === edit.sourceStart && patch.sourceEnd === edit.sourceEnd)
      if (savedPatch) {
        if (review) {
          const store = useCorrectionReviewStore.getState()
          store.edit(session.id, expected.id!, savedPatch.id, edit.replacement)
          store.saved(session.id, expected.id!, savedPatch.id, edit.replacement)
        }
        onSaved?.(savedPatch.id)
      }
    } finally { markBusy(false) }
  }
  const changeState = async (patch: ResolvedCorrectionPatch, expected?: CorrectionEditExpectation, conflicts?: string[]) => {
    if (busyRef.current || disabled || readOnly) return
    markBusy(true)
    setError('')
    let requested = expected
    try {
      requested = expected || await expectation(latest())
      await useSessionStore.getState().changeSessionCorrectionPatchState(session.id, patch.id, patch.state === 'applied' ? 'reverted' : 'applied', requested, conflicts)
      syncReview()
      if (review && patch.state === 'reverted') {
        const store = useCorrectionReviewStore.getState()
        store.select(session.id, requested.id!, [...(store.reviews[session.id]?.selectedIds || []), patch.id])
      }
      if (mounted.current) setStateConflict(null)
      focusFilter()
    } catch (reason) {
      if (!mounted.current) return
      if (reason instanceof CorrectionConflictError && requested) setStateConflict({ patch, expected: requested, conflicts: reason.conflicts })
      else { setStateConflict(null); setError(correctionErrorMessage(reason, isZh)) }
    } finally { markBusy(false) }
  }
  const stateOf = (patch: ResolvedCorrectionPatch) => patch.state === 'rejected' ? 'rejected'
    : review ? review.selected.has(patch.id) ? 'applied' : 'reverted' : patch.state === 'applied' ? 'applied' : 'reverted'
  const filters = [
    { id: 'applied' as const, label: review ? (isZh ? '待应用' : 'Selected') : (isZh ? '已应用' : 'Applied') },
    { id: 'reverted' as const, label: review ? (isZh ? '未选中' : 'Unselected') : (isZh ? '已撤销' : 'Reverted') },
    { id: 'rejected' as const, label: isZh ? '被拒绝' : 'Rejected' },
  ]
  const visible = patches.filter((patch) => stateOf(patch) === filter)
  const locked = disabled || busy || readOnly

  return <section data-correction-workspace aria-label={isZh ? '纠错工作区' : 'Correction workspace'} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{isZh ? '纠错工作区' : 'Correction workspace'}</h4>{!readOnly && <button type="button" disabled={locked} onClick={() => void openEditor()} className="inline-flex items-center gap-1 rounded-md border border-input px-3 py-1.5 text-sm disabled:opacity-50"><Plus className="h-4 w-4" />{isZh ? '追加纠错' : 'Add correction'}</button>}</div>
    <div ref={filterRef} className="flex flex-wrap items-center gap-2" role="group" aria-label={isZh ? '纠错状态筛选' : 'Correction status filters'}>
      {filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} className="rounded-md border border-input px-3 py-1.5 text-sm aria-pressed:border-primary/40 aria-pressed:bg-primary/10">{item.label} <span className="tabular-nums">{patches.filter((patch) => stateOf(patch) === item.id).length}</span></button>)}
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="ml-auto rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent">{expanded ? (isZh ? '收起列表' : 'Compact list') : (isZh ? '展开列表' : 'Expand list')}</button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div tabIndex={0} aria-label={isZh ? '纠错项列表' : 'Correction items'} className={`overflow-y-auto overscroll-contain rounded-lg border border-border p-2 ${expanded ? 'max-h-[65vh]' : 'max-h-72'}`}>
      {!visible.length ? <p className="p-3 text-sm text-muted-foreground">{patches.length ? (isZh ? '此状态没有纠错项。' : 'No edits in this state.') : (isZh ? '没有纠错项。可直接追加人工纠错，无需 AI 配置。' : 'No edits yet. Add a manual correction without AI configuration.')}</p>
        : <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,18rem),1fr))' }}>{visible.map((patch) => {
          const rejected = patch.state === 'rejected'
          const recovered = rejected ? patches.find((item) => item.recoveredFromPatchId === patch.id) : undefined
          const original = rejected ? patch.modelIntent?.oldText || patch.sourceText : patch.sourceText
          const reliable = !rejected || patch.locationVerified === true
          return <article key={patch.id} data-correction-patch={patch.id} className="min-w-0 space-y-2 rounded-md border border-border bg-background p-3 text-sm">
            <div className="flex items-start gap-2">
              {review && !rejected && <button type="button" disabled={locked} aria-label={`${isZh ? '审核候选' : 'Review candidate'}: ${patch.sourceText}`} aria-pressed={review.selected.has(patch.id)} onClick={() => { if (patch.state === 'reverted' && !review.selected.has(patch.id)) void changeState(patch); else { review.onToggle(patch.id); focusFilter() } }} className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-input aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground">{review.selected.has(patch.id) && <Check className="h-3 w-3" />}</button>}
              <div className="min-w-0 flex-1 space-y-1"><p className="whitespace-pre-wrap break-words"><span className="text-destructive line-through">{original || (patch.op === 'insert' ? '∅' : isZh ? '未提供原文' : 'Original unavailable')}</span><span className="mx-1 text-muted-foreground">→</span><span className="text-green-700 dark:text-green-400">{patch.replacement || '∅'}</span></p>
                {review && !rejected && <textarea rows={1} disabled={locked} aria-label={isZh ? '建议修改' : 'Suggested replacement'} value={review.edits[patch.id] ?? patch.replacement} onChange={(event) => review.onEdit(patch.id, event.target.value)} onBlur={() => { void review.onPersist(patch).catch(() => undefined) }} className="min-h-8 w-full resize-y rounded border border-input bg-background px-2 py-1 text-sm" />}
              </div>
            </div>
            {review?.errors[patch.id] && <p role="alert" className="text-destructive">{correctionErrorMessage(review.errors[patch.id], isZh)}</p>}
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{patch.origin === 'manual' ? (isZh ? '人工修正' : 'Manual') : 'AI'}{patch.recoveredFromPatchId ? (isZh ? ' · 拒绝项恢复' : ' · Recovered rejection') : ''}</span>
              {!readOnly && (rejected ? recovered
                ? <span className="min-w-0 break-all text-xs text-green-700 dark:text-green-400">{isZh ? '已人工处理' : 'Manually handled'} · <code>{recovered.id}</code></span>
                : <button type="button" disabled={locked} onClick={() => void openEditor(patch)} className="ml-auto rounded border border-input px-2 py-1 disabled:opacity-50">{reliable ? (isZh ? '重新校验并应用' : 'Revalidate and apply') : (isZh ? '指定位置并应用' : 'Locate and apply')}</button>
                : <><button type="button" disabled={locked} onClick={() => void openEditor(patch)} className="ml-auto rounded border border-input px-2 py-1 disabled:opacity-50">{isZh ? '编辑' : 'Edit'}</button>{!review && <button type="button" disabled={locked} onClick={() => void changeState(patch)} className="rounded border border-input px-2 py-1 disabled:opacity-50">{patch.state === 'applied' ? (isZh ? '撤销' : 'Revert') : (isZh ? '恢复' : 'Apply')}</button>}</>)}
            </div>
            {rejected && <p className="break-words text-amber-700 dark:text-amber-300">{correctionErrorMessage(patch.rejectionReason || '', isZh)}</p>}
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{isZh ? '原因与上下文' : 'Reason and context'}</summary><p className="mt-2 whitespace-pre-wrap break-words">{patch.reason}</p><p className="mt-2 whitespace-pre-wrap break-words">{reliable ? session.transcript.slice(Math.max(0, patch.sourceStart - 36), patch.sourceEnd + 36) : patch.modelIntent ? `${patch.modelIntent.before}${patch.modelIntent.oldText}${patch.modelIntent.after}` : (isZh ? '需指定原文位置' : 'Original location required')}</p>{rejected && <p className="mt-1"><code>{patch.rejectionReason}</code></p>}</details>
          </article>
        })}</div>}
    </div>
    {editor && <ManualCorrectionEditor key={`${session.id}-${editor.expected.id || 'new'}-${editor.patch?.id || 'add'}`} {...editor} isZh={isZh} disabled={disabled || readOnly} onSave={saveEdit} onClose={() => { setEditor(null); focusFilter() }} />}
    <ActionDialog open={Boolean(stateConflict)} title={isZh ? '替换重叠纠错' : 'Replace overlapping corrections'}
      description={`${isZh ? '恢复此项将撤销以下重叠项。取消不会改变结果。' : 'Restoring this edit reverts the following overlapping edits. Cancel changes nothing.'}\n\n${stateConflict?.conflicts.map((patch) => `${patch.sourceText || '∅'} → ${patch.replacement || '∅'}`).join('\n') || ''}\n\n${stateConflict?.patch.sourceText || ''} → ${stateConflict?.patch.replacement || ''}`}
      onClose={() => { if (!busyRef.current) setStateConflict(null) }} actions={[
        { label: isZh ? '取消' : 'Cancel', disabled: busy, onClick: () => setStateConflict(null) },
        { label: isZh ? '撤销重叠项并恢复' : 'Revert overlaps and restore', variant: 'primary', disabled: locked, onClick: () => { if (stateConflict) void changeState(stateConflict.patch, stateConflict.expected, stateConflict.conflicts.map((patch) => patch.id)) } },
      ]} />
  </section>
}
