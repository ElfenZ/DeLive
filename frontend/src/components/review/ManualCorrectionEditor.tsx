import { useMemo, useRef, useState, type SyntheticEvent } from 'react'
import { X } from 'lucide-react'
import type { CorrectionEditExpectation, ManualCorrectionEdit, ResolvedCorrectionPatch } from '../../types'
import { CorrectionConflictError, findCorrectionSourceMatches } from '../../utils/correctionPatch'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { ActionDialog } from '../ActionDialog'
import { correctionErrorMessage } from './correctionMessages'

interface ManualCorrectionEditorProps {
  transcript: string
  patch?: ResolvedCorrectionPatch
  expected: CorrectionEditExpectation
  isZh: boolean
  disabled: boolean
  onSave: (edit: ManualCorrectionEdit, expected: CorrectionEditExpectation) => Promise<void>
  onClose: () => void
}

export function ManualCorrectionEditor({ transcript, patch, expected, isZh, disabled, onSave, onClose }: ManualCorrectionEditorProps) {
  const reliable = patch && (patch.state !== 'rejected' || patch.locationVerified === true)
  const initialQuery = patch?.state === 'rejected' ? patch.modelIntent?.oldText || patch.sourceText : patch?.sourceText
  const [query, setQuery] = useState(initialQuery || '')
  const [replacement, setReplacement] = useState(patch?.replacement || '')
  const [range, setRange] = useState<{ start: number; end: number } | null>(reliable ? { start: patch.sourceStart, end: patch.sourceEnd } : null)
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [method, setMethod] = useState<'search' | 'selection'>(patch?.op === 'insert' ? 'selection' : 'search')
  const [limit, setLimit] = useState(100)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState('')
  const [conflicts, setConflicts] = useState<ResolvedCorrectionPatch[] | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const close = () => { if (!savingRef.current) onClose() }
  useDialogFocus(true, dialogRef, close)
  const matches = useMemo(() => findCorrectionSourceMatches(transcript, query), [transcript, query])
  const sourceText = range ? transcript.slice(range.start, range.end) : ''
  const before = range ? transcript.slice(Math.max(0, range.start - 48), range.start) : ''
  const after = range ? transcript.slice(range.end, range.end + 48) : ''
  const readSelection = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })
  }
  const save = async (confirmedConflictIds?: string[]) => {
    if (savingRef.current || disabled) return
    if (!range) { setError(isZh ? '请先选择原文位置。' : 'Choose an original location first.'); return }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await onSave({ sourceStart: range.start, sourceEnd: range.end, sourceText, replacement,
        patchId: patch?.state !== 'rejected' ? patch?.id : undefined,
        recoveredFromPatchId: patch?.state === 'rejected' ? patch.id : undefined,
        confirmedConflictIds,
      }, expected)
      onClose()
    } catch (reason) {
      if (reason instanceof CorrectionConflictError) setConflicts(reason.conflicts)
      else { setConflicts(null); setError(correctionErrorMessage(reason, isZh)) }
    } finally { savingRef.current = false; setSaving(false) }
  }
  const title = patch?.state === 'rejected' ? (isZh ? '人工处理拒绝项' : 'Resolve rejected intent')
    : patch ? (isZh ? '编辑纠错' : 'Edit correction') : (isZh ? '追加纠错' : 'Add correction')

  return <>
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-3" onClick={close}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="manual-correction-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-4"><h3 id="manual-correction-title" className="font-semibold">{title}</h3><button type="button" disabled={saving} aria-label={isZh ? '关闭纠错表单' : 'Close correction editor'} onClick={close} className="rounded p-2 hover:bg-accent"><X className="h-4 w-4" /></button></div>
        <div className="min-h-0 space-y-4 overflow-y-auto p-4 text-sm">
          <p className="text-muted-foreground">{isZh ? '只修改本条记录。原始转录和全局词典保持不变。' : 'Edits apply to this record only. The original transcript and global glossary remain unchanged.'}</p>
          {patch?.state === 'rejected' && <div className="space-y-1 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><p>{correctionErrorMessage(patch.rejectionReason || '', isZh)}</p><p className="break-words">{isZh ? '原始原因：' : 'Original reason: '}{patch.modelIntent?.reason || patch.reason}</p>{!reliable && <p>{isZh ? '此项没有可靠原文范围，需指定原文位置。' : 'This item has no reliable source range. Choose an original location.'}</p>}</div>}
          <div className="flex flex-wrap gap-2" role="group" aria-label={isZh ? '定位方式' : 'Location method'}>
            <button type="button" aria-pressed={method === 'search'} disabled={saving} onClick={() => setMethod('search')} className="rounded border border-input px-3 py-2 aria-pressed:bg-accent">{isZh ? '检索原文' : 'Search original'}</button>
            <button type="button" aria-pressed={method === 'selection'} disabled={saving} onClick={() => setMethod('selection')} className="rounded border border-input px-3 py-2 aria-pressed:bg-accent">{isZh ? '原文选区 / 插入位置' : 'Original selection / insertion point'}</button>
          </div>
          {method === 'search' ? <div className="space-y-2">
            <label className="block">{isZh ? '要修改的原文' : 'Original text to change'}<input autoComplete="off" disabled={saving} value={query} onChange={(event) => { setQuery(event.target.value); setRange(null); setLimit(100) }} className="mt-1 w-full rounded border border-input bg-background p-2" /></label>
            <p className="text-sm text-muted-foreground">{query ? (isZh ? `找到 ${matches.length} 处，请选择一处。` : `${matches.length} matches. Choose a location.`) : (isZh ? '输入原文词句；插入请使用原文选区中的光标位置。' : 'Enter original text. For insertion, use the cursor location in the original selection.')}</p>
            <div className="max-h-40 space-y-1 overflow-y-auto" role="radiogroup" aria-label={isZh ? '原文匹配位置' : 'Original matches'}>
              {matches.slice(0, limit).map((start) => <label key={start} className="flex cursor-pointer items-start gap-2 rounded border border-border p-2 hover:bg-accent">
                <input type="radio" name="manual-source-location" disabled={saving} checked={range?.start === start && range.end === start + query.length} onChange={() => setRange({ start, end: start + query.length })} />
                <span className="min-w-0 break-words"><span className="text-muted-foreground">{isZh ? '位置' : 'Position'} {start + 1}: </span>{transcript.slice(Math.max(0, start - 28), start)}<strong>{query}</strong>{transcript.slice(start + query.length, start + query.length + 28)}</span>
              </label>)}
              {matches.length > limit && <button type="button" onClick={() => setLimit(limit + 100)} className="rounded border border-input px-3 py-2">{isZh ? '显示更多位置' : 'More locations'}</button>}
            </div>
          </div> : <div className="space-y-2">
            <label className="block">{isZh ? '原文（只读；选择文本或放置光标）' : 'Original (read-only; select text or place the cursor)'}
              <textarea readOnly disabled={saving} value={transcript} rows={6} onSelect={readSelection} onMouseUp={readSelection} onKeyUp={readSelection} className="mt-1 w-full resize-y rounded border border-input bg-background p-2" />
            </label>
            <button type="button" disabled={!selection || saving} onClick={() => { setRange(selection); setError('') }} className="rounded border border-input px-3 py-2 disabled:opacity-50">{selection?.start === selection?.end ? (isZh ? '使用此插入位置' : 'Use insertion point') : (isZh ? '使用此选区' : 'Use selection')}</button>
          </div>}
          <label className="block">{isZh ? '修改后文本（留空删除所选原文）' : 'Replacement (leave empty to delete the selection)'}<textarea disabled={saving} rows={2} value={replacement} onChange={(event) => { setReplacement(event.target.value); setError(''); setConflicts(null) }} className="mt-1 w-full resize-y rounded border border-input bg-background p-2" /></label>
          {range && <div aria-label={isZh ? '纠错预览' : 'Correction preview'} className="space-y-2 rounded border border-border bg-muted/20 p-3"><p className="text-muted-foreground">{isZh ? '预览：' : 'Preview: '}{range.start + 1}{range.end > range.start ? `-${range.end}` : (isZh ? '（插入位置）' : ' (insertion point)')}</p><p className="whitespace-pre-wrap break-words">{before}<del className="text-destructive">{sourceText}</del><ins className="text-green-700 dark:text-green-400">{replacement}</ins>{after}</p></div>}
          {error && <p role="alert" className="text-destructive">{error}</p>}
          {disabled && <p role="alert" className="text-destructive">{isZh ? '任务正在处理，暂不能保存。' : 'The task is active. Saving is temporarily unavailable.'}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border p-4"><button type="button" disabled={saving} onClick={close} className="rounded border border-input px-4 py-2">{isZh ? '取消' : 'Cancel'}</button><button type="button" disabled={saving || disabled || !range} onClick={() => void save()} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{saving ? (isZh ? '保存中…' : 'Saving...') : expected.target === 'draft' ? (isZh ? '保存候选' : 'Save candidate') : (isZh ? '保存并应用' : 'Save and apply')}</button></div>
      </div>
    </div>
    <ActionDialog open={Boolean(conflicts)} title={isZh ? '替换重叠纠错' : 'Replace overlapping corrections'}
      description={`${isZh ? '确认后将撤销以下项，并应用本次修改。取消不会改变任何纠错。' : 'Confirmation reverts the following edits and applies this edit. Cancel changes nothing.'}\n\n${conflicts?.map((item) => `${item.sourceText || '(insert)'} → ${item.replacement || '(delete)'}`).join('\n') || ''}\n\n${sourceText || '(insert)'} → ${replacement || '(delete)'}`}
      onClose={() => { if (!savingRef.current) setConflicts(null) }} actions={[
        { label: isZh ? '取消替换' : 'Cancel replacement', disabled: saving, onClick: () => setConflicts(null) },
        { label: isZh ? '撤销重叠项并应用' : 'Revert overlaps and apply', variant: 'primary', disabled: saving || disabled, onClick: () => void save(conflicts?.map((item) => item.id)) },
      ]} />
  </>
}
