import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, Loader2, Pause, Play, RotateCcw, SpellCheck, Trash2, Zap } from 'lucide-react'
import type { CorrectionIssueCategory, LegacyCorrectionIssueCategory, ResolvedCorrectionPatch, TranscriptSession } from '../../types'
import type { CorrectionDiffPart } from '../../utils/correctionPatch'
import { resolveModelForFeature } from '../../services/aiPostProcess'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { projectSessionCorrection } from '../../utils/correctedSegmentProjection'
import { SpeakerCorrectionResult } from './SpeakerCorrectionResult'

interface CorrectionTabProps {
  session: TranscriptSession
}

const CATEGORY_COLORS: Record<CorrectionIssueCategory, string> = {
  homophone: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  'proper-noun': 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  punctuation: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  'asr-substitution': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  'asr-omission': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  'asr-duplication': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
}

function categoryLabel(category: LegacyCorrectionIssueCategory, isZh: boolean): string {
  const labels: Record<LegacyCorrectionIssueCategory, [string, string]> = {
    homophone: ['同音/近音', 'Homophone'],
    'proper-noun': ['专有名词', 'Proper noun'],
    punctuation: ['标点', 'Punctuation'],
    'asr-substitution': ['错词', 'Substitution'],
    'asr-omission': ['漏词', 'Omission'],
    'asr-duplication': ['重复词', 'Duplication'],
    grammar: ['历史语法项', 'Legacy grammar'],
    other: ['历史其他项', 'Legacy other'],
  }
  return labels[category][isZh ? 0 : 1]
}

function contextForPatch(transcript: string, patch: ResolvedCorrectionPatch): string {
  return transcript.slice(Math.max(0, patch.sourceStart - 36), Math.min(transcript.length, patch.sourceEnd + 36))
}

function CorrectionDiffResult({ parts }: { parts: CorrectionDiffPart[] }) {
  return (
    <div className="whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-4 text-sm leading-relaxed">
      {parts.map((part, index) => <span key={`${part.patchId || 'text'}-${index}`} className={part.type === 'removed' ? 'bg-red-100 text-red-700 line-through dark:bg-red-900/30 dark:text-red-300' : part.type === 'added' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : undefined}>{part.text}</span>)}
    </div>
  )
}

export function CorrectionTab({ session }: CorrectionTabProps) {
  const language = useUIStore((state) => state.language)
  const isZh = language === 'zh'
  const settings = useSettingsStore((state) => state.settings)
  const liveSession = useSessionStore((state) => state.sessions.find((item) => item.id === session.id)) || session
  const correctionInFlight = useSessionStore((state) => Boolean(state.correctionInFlight[session.id]))
  const {
    detectSessionCorrectionIssues,
    startSessionQuickCorrection,
    pauseSessionCorrection,
    resumeSessionCorrection,
    retrySessionCorrection,
    abandonSessionCorrection,
    applySessionCorrectionReview,
    updateSessionCorrectionDraftPatch,
    restoreSessionLegacyCorrection,
    setSessionCorrectionPatchState,
    revertAllSessionCorrectionPatches,
  } = useSessionStore()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({})
  const [editErrors, setEditErrors] = useState<Record<string, string>>({})
  const correction = liveSession.correction
  const draft = correction?.draft
  const published = correction?.published
  const legacy = correction?.legacy
  const mode = settings.aiPostProcess?.correctionMode || 'quick'
  const configured = Boolean(settings.aiPostProcess?.enabled && resolveModelForFeature(settings.aiPostProcess || {}, 'correction'))

  useEffect(() => {
    if (draft?.runId) {
      setSelected(new Set())
      setDraftEdits({})
      setEditErrors({})
    }
  }, [draft?.runId])

  const readyReviewRunId = draft?.status === 'ready-for-review' ? draft.runId : undefined
  const readyReviewPatchIdSignature = draft?.status === 'ready-for-review'
    ? draft.proposedPatches.map((patch) => patch.id).join('\u001f')
    : ''
  useEffect(() => {
    if (!readyReviewRunId) return
    setSelected(new Set(readyReviewPatchIdSignature ? readyReviewPatchIdSignature.split('\u001f') : []))
  }, [readyReviewRunId, readyReviewPatchIdSignature])

  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const completedShards = draft?.shards.filter((shard) => shard.status === 'completed').length || 0
  const totalShards = draft?.shards.length || 0
  const percent = totalShards ? Math.round(completedShards / totalShards * 100) : 0
  const processing = correctionInFlight || draft?.status === 'queued' || draft?.status === 'running' || draft?.status === 'retrying'
  const reviewReady = draft?.status === 'ready-for-review'
  const correctedSegmentProjection = useMemo(
    () => projectSessionCorrection(liveSession.transcript, liveSession.segments, correction),
    [correction, liveSession.segments, liveSession.transcript],
  )
  const allReviewPatchesSelected = Boolean(
    draft?.proposedPatches.length
    && draft.proposedPatches.every((patch) => selected.has(patch.id)),
  )
  const persistDraftEdit = async (patch: ResolvedCorrectionPatch) => {
    const replacement = draftEdits[patch.id] ?? patch.replacement
    if (replacement === patch.replacement) return
    try {
      await updateSessionCorrectionDraftPatch(session.id, patch.id, replacement)
      setEditErrors((current) => {
        const next = { ...current }
        delete next[patch.id]
        return next
      })
    } catch (reason) {
      setEditErrors((current) => ({ ...current, [patch.id]: reason instanceof Error ? reason.message : String(reason) }))
    }
  }

  const renderCorrectionResult = () => {
    if (!correctedSegmentProjection) return null
    if (correctedSegmentProjection.status === 'projected') {
      return <SpeakerCorrectionResult projection={correctedSegmentProjection} speakers={liveSession.speakers} isZh={isZh} />
    }
    if (correctedSegmentProjection.status === 'degraded') {
      return (
        <div className="space-y-2">
          <p className="text-xs text-amber-700 dark:text-amber-300">{isZh ? '部分修正跨越说话人边界。原说话人和时间仍按原位置保留，无法可靠归属的新增内容标为 S?。' : 'Some corrections cross speaker boundaries. Original speakers and timing remain in place, while added text with uncertain ownership is marked S?.'}</p>
          <SpeakerCorrectionResult projection={correctedSegmentProjection} speakers={liveSession.speakers} isZh={isZh} />
        </div>
      )
    }
    if (correctedSegmentProjection.status === 'unaligned') {
      return (
        <div className="space-y-4">
          <p className="text-xs text-amber-700 dark:text-amber-300">{isZh ? '原说话人分段无法与完整原文安全对应。以下先保留原说话人分段，再附无法安全分段的完整修正稿。' : 'Original speaker segments could not be safely matched to the full transcript. They are preserved below, followed by the complete correction that could not be safely segmented.'}</p>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{isZh ? '原说话人分段' : 'Original speaker segments'}</p>
            <SpeakerCorrectionResult projection={correctedSegmentProjection} speakers={liveSession.speakers} isZh={isZh} />
          </div>
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{isZh ? '完整修正稿（无法安全分段）' : 'Complete correction (could not be safely segmented)'}</p>
            <CorrectionDiffResult parts={correctedSegmentProjection.fullDiff} />
          </div>
        </div>
      )
    }
    return <CorrectionDiffResult parts={correctedSegmentProjection.fullDiff} />
  }

  if (!liveSession.transcript) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">{isZh ? '当前会话没有转录内容。' : 'This session has no transcript.'}</div>
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2"><SpellCheck className="h-4 w-4 text-primary" /><h3 className="text-sm font-medium">{isZh ? 'AI 严格纠错' : 'Strict AI correction'}</h3></div>
        {draft && <button type="button" onClick={() => void run(() => abandonSessionCorrection(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-xs"><Trash2 className="h-3.5 w-3.5" />{isZh ? '放弃任务' : 'Abandon'}</button>}
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-6">
        {!draft && !published && !legacy && (
          <div className="flex flex-col items-center gap-4 py-12 text-center">
            <SpellCheck className="h-12 w-12 text-muted-foreground/40" />
            <p className="max-w-lg text-sm text-muted-foreground">{isZh ? 'AI 只返回局部 ASR 修改意图。本地会严格定位和校验 Patch，原始转录始终保持不变。' : 'AI returns local ASR edit intents only. Patches are resolved and validated locally, and the original transcript is never overwritten.'}</p>
            {!configured ? <p className="text-sm text-destructive">{isZh ? '请先启用 AI 并配置纠错模型。' : 'Enable AI and configure a correction model first.'}</p> : (
              <button type="button" onClick={() => void run(() => mode === 'quick' ? startSessionQuickCorrection(session.id) : detectSessionCorrectionIssues(session.id))} className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground"><Zap className="h-4 w-4" />{mode === 'quick' ? (isZh ? '检测并自动应用' : 'Detect and apply') : (isZh ? '检测候选' : 'Detect candidates')}</button>
            )}
          </div>
        )}

        {draft && !reviewReady && (
          <section className="space-y-4 rounded-xl border border-border bg-muted/20 p-5">
            <div className="flex items-center justify-between gap-4">
              <div><p className="text-sm font-medium">{draft.status === 'paused' ? (isZh ? '任务已暂停' : 'Task paused') : draft.status === 'failed' || draft.status === 'blocked-auth' ? (isZh ? '任务需要处理' : 'Task needs attention') : (isZh ? '正在逐片检测' : 'Detecting shard by shard')}</p><p className="mt-1 text-xs text-muted-foreground">{completedShards}/{totalShards} {isZh ? '分片完成' : 'shards completed'} · {draft.proposedPatches.length} {isZh ? '合法候选' : 'valid candidates'} · {draft.rejectedPatches.length} {isZh ? '已拒绝' : 'rejected'}</p></div>
              <div className="flex gap-2">
                {processing && <button type="button" onClick={() => void run(() => pauseSessionCorrection(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-xs"><Pause className="h-3.5 w-3.5" />{isZh ? '暂停' : 'Pause'}</button>}
                {draft.status === 'paused' && <button type="button" onClick={() => void run(() => resumeSessionCorrection(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground"><Play className="h-3.5 w-3.5" />{isZh ? '继续' : 'Resume'}</button>}
                {(draft.status === 'failed' || draft.status === 'blocked-auth') && <button type="button" onClick={() => void run(() => retrySessionCorrection(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground"><RotateCcw className="h-3.5 w-3.5" />{isZh ? '重试失败分片' : 'Retry failed shard'}</button>}
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} /></div>
            {processing && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{isZh ? '每个成功分片都会等待持久化完成。' : 'Every successful shard is checkpointed before continuing.'}</div>}
            {(draft.error || error) && <p className="flex items-start gap-2 text-xs text-destructive"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error || draft.error}</p>}
          </section>
        )}

        {reviewReady && draft && (
          <section className="space-y-4">
            <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium">{isZh ? `发现 ${draft.proposedPatches.length} 个合法候选` : `${draft.proposedPatches.length} valid candidates`}</p><p className="mt-1 text-xs text-muted-foreground">{isZh ? '默认全部选中。确认后仅在本地应用，不再调用模型。' : 'All candidates are selected by default. Confirmation applies patches locally without another model call.'}</p></div>{draft.proposedPatches.length > 0 && <button type="button" onClick={() => setSelected(allReviewPatchesSelected ? new Set() : new Set(draft.proposedPatches.map((patch) => patch.id)))} className="shrink-0 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent">{allReviewPatchesSelected ? (isZh ? '全部不选' : 'Select none') : (isZh ? '全部选中' : 'Select all')}</button>}</div>
            {draft.proposedPatches.length === 0 && <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground"><CheckCircle2 className="h-5 w-5 text-green-500" />{isZh ? '没有需要修改的候选，可直接完成。' : 'No correction candidates were found.'}</div>}
            <div className="space-y-2">
              {draft.proposedPatches.map((patch) => {
                const checked = selected.has(patch.id)
                return <div key={patch.id} className={`block rounded-lg border p-4 ${checked ? 'border-primary/40 bg-primary/5' : 'border-border'}`}>
                  <div className="flex items-start gap-3">
                    <button type="button" aria-pressed={checked} onClick={() => setSelected((current) => { const next = new Set(current); if (next.has(patch.id)) next.delete(patch.id); else next.add(patch.id); return next })} className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}>{checked && <Check className="h-3 w-3" />}</button>
                    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 font-mono text-sm"><span className="text-destructive line-through">{patch.sourceText || '∅'}</span><span>→</span><input aria-label={isZh ? '建议修改' : 'Suggested replacement'} value={draftEdits[patch.id] ?? patch.replacement} onChange={(event) => setDraftEdits((current) => ({ ...current, [patch.id]: event.target.value }))} onBlur={() => void persistDraftEdit(patch)} className={`h-8 min-w-32 flex-1 rounded-md border bg-background px-2 text-sm text-green-600 dark:text-green-400 ${editErrors[patch.id] ? 'border-destructive' : 'border-input'}`} /><span className={`rounded-full px-2 py-0.5 font-sans text-xs ${CATEGORY_COLORS[patch.category]}`}>{categoryLabel(patch.category, isZh)}</span></div>{editErrors[patch.id] && <p className="mt-1 text-xs text-destructive">{editErrors[patch.id]}</p>}<p className="mt-2 text-xs text-muted-foreground">{patch.reason}</p><pre className="mt-2 whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs">{contextForPatch(liveSession.transcript, patch)}</pre></div>
                  </div>
                </div>
              })}
            </div>
            {draft.rejectedPatches.length > 0 && <details className="rounded-lg border border-border p-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{isZh ? `${draft.rejectedPatches.length} 个非法 Patch 已拒绝` : `${draft.rejectedPatches.length} invalid patches rejected`}</summary><div className="mt-2 space-y-1">{draft.rejectedPatches.map((patch) => <p key={patch.id}>{patch.rejectionReason}: {patch.sourceText || patch.replacement}</p>)}</div></details>}
            <button type="button" disabled={Object.keys(editErrors).length > 0} onClick={() => void run(() => applySessionCorrectionReview(session.id, Array.from(selected)))} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"><Zap className="h-4 w-4" />{isZh ? `本地应用 ${selected.size} 项` : `Apply ${selected.size} locally`}</button>
          </section>
        )}

        {published && !draft && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center gap-2"><CheckCircle2 className="h-5 w-5 text-green-500" /><p className="text-sm font-medium">{isZh ? `已应用 ${published.stats.applied}，拒绝 ${published.stats.rejected}` : `${published.stats.applied} applied, ${published.stats.rejected} rejected`}</p><div className="ml-auto flex gap-2"><button type="button" onClick={() => void run(() => mode === 'quick' ? startSessionQuickCorrection(session.id) : detectSessionCorrectionIssues(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-xs"><Zap className="h-3.5 w-3.5" />{isZh ? '重新检测' : 'Run again'}</button><button type="button" onClick={() => void run(() => revertAllSessionCorrectionPatches(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-xs"><RotateCcw className="h-3.5 w-3.5" />{isZh ? '全部恢复原文' : 'Restore original'}</button></div></div>
            {renderCorrectionResult()}
            <div className="space-y-2">{published.patches.filter((patch) => patch.state !== 'rejected').map((patch) => <div key={patch.id} className="flex items-center gap-3 rounded-lg border border-border p-3 text-xs"><span className="font-mono"><span className="text-destructive line-through">{patch.sourceText || '∅'}</span> → <span className="text-green-600">{patch.replacement || '∅'}</span></span><button type="button" onClick={() => void run(() => setSessionCorrectionPatchState(session.id, patch.id, patch.state === 'applied' ? 'reverted' : 'applied'))} className="ml-auto rounded-md border border-input px-2 py-1">{patch.state === 'applied' ? (isZh ? '撤销' : 'Revert') : (isZh ? '恢复' : 'Apply')}</button></div>)}</div>
          </section>
        )}

        {legacy && !draft && !published && <section className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/20"><p className="text-sm font-medium">{isZh ? 'Legacy 全文纠错结果' : 'Legacy full-text correction result'}</p><p className="text-xs text-muted-foreground">{isZh ? '旧结果没有可信 Patch，不能单条撤销。原说话人分段会保留，并附完整历史修正稿。' : 'This result has no trusted patches and cannot be reverted item by item. Original speaker segments are preserved with the complete legacy correction.'}</p>{renderCorrectionResult()}<div className="flex gap-2"><button type="button" onClick={() => void run(() => mode === 'quick' ? startSessionQuickCorrection(session.id) : detectSessionCorrectionIssues(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground"><Zap className="h-3.5 w-3.5" />{isZh ? '重新检测' : 'Run patch detection'}</button><button type="button" onClick={() => void run(() => restoreSessionLegacyCorrection(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs"><RotateCcw className="h-3.5 w-3.5" />{isZh ? '恢复原文' : 'Restore original'}</button></div></section>}
        {error && !draft && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  )
}
