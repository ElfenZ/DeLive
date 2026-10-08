import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Pause, Play, RotateCcw, SpellCheck, Trash2, Zap } from 'lucide-react'
import type { ResolvedCorrectionPatch, TranscriptSession } from '../../types'
import type { CorrectionDiffPart } from '../../utils/correctionPatch'
import { resolveModelForFeature } from '../../services/aiPostProcess'
import { isCorrectionConfigSnapshotCurrent } from '../../services/aiCorrection'
import { safeAiEndpoint } from '../../services/aiProtocol'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { projectSessionCorrection } from '../../utils/correctedSegmentProjection'
import { SpeakerCorrectionResult } from './SpeakerCorrectionResult'
import { useCorrectionReviewStore } from '../../stores/correctionReviewStore'
import { ActionDialog } from '../ActionDialog'
import { CorrectionWorkspace } from './CorrectionWorkspace'
import { correctionErrorMessage } from './correctionMessages'

interface CorrectionTabProps {
  session: TranscriptSession
}

function CorrectionDiffResult({ parts }: { parts: CorrectionDiffPart[] }) {
  return (
    <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/20 p-4 text-sm leading-relaxed">
      {parts.map((part, index) => <span key={`${part.patchId || 'text'}-${index}`} className={part.type === 'removed' ? 'bg-red-100 text-red-700 line-through dark:bg-red-900/30 dark:text-red-300' : part.type === 'added' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : undefined}>{part.text}</span>)}
    </div>
  )
}

export function CorrectionTab({ session }: CorrectionTabProps) {
  const { language, t } = useUIStore()
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
    revertAllSessionCorrectionPatches,
  } = useSessionStore()
  const [error, setError] = useState<string | null>(null)
  const [editErrors, setEditErrors] = useState<Record<string, string>>({})
  const editSaveQueue = useRef<Promise<void>>(Promise.resolve())
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [controlPending, setControlPending] = useState(false)
  const controlRef = useRef(false)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [rerun, setRerun] = useState<{ kind: 'new' | 'resume' | 'retry'; runId?: string; draftRevision?: number; publishedId?: string; publishedRevision?: number; legacyText?: string } | null>(null)
  const [abandonRunId, setAbandonRunId] = useState<string | null>(null)
  const correction = liveSession.correction
  const draft = correction?.draft
  const published = correction?.published
  const legacy = correction?.legacy
  const storedReview = useCorrectionReviewStore((state) => state.reviews[session.id])
  const review = storedReview?.runId === draft?.runId ? storedReview : undefined
  const selected = new Set(review?.selectedIds || draft?.proposedPatches.filter((patch) => patch.state !== 'reverted').map((patch) => patch.id) || [])
  const draftEdits = review?.edits || {}
  const setSelected = (value: Set<string> | ((current: Set<string>) => Set<string>)) => {
    if (!draft) return
    useCorrectionReviewStore.getState().select(session.id, draft.runId, Array.from(typeof value === 'function' ? value(selected) : value))
  }
  const mode = settings.aiPostProcess?.correctionMode || 'quick'
  const configured = Boolean(settings.aiPostProcess?.enabled && resolveModelForFeature(settings.aiPostProcess || {}, 'correction'))
  const draftConfigCurrent = draft ? isCorrectionConfigSnapshotCurrent(draft.config, settings) : true
  const activeShard = draft?.shards.find((shard) => shard.status === 'running' || shard.status === 'retrying')
    || draft?.shards.find((shard) => shard.status === 'failed')
  const endpointLabel = draft ? (() => {
    try {
      return new URL(safeAiEndpoint(draft.config.baseUrl)).host
    } catch {
      return safeAiEndpoint(draft.config.baseUrl)
    }
  })() : ''

  useEffect(() => {
    if (draft?.runId) {
      setEditErrors({})
    }
  }, [draft?.runId])

  const readyReviewRunId = draft?.status === 'ready-for-review' ? draft.runId : undefined
  const readyReviewPatchIdSignature = draft?.status === 'ready-for-review'
    ? draft.proposedPatches.map((patch) => patch.id).join('\u001f')
    : ''
  const readyReviewRevertedSignature = draft?.status === 'ready-for-review'
    ? draft.proposedPatches.filter((patch) => patch.state === 'reverted').map((patch) => patch.id).join('\u001f') : ''
  useEffect(() => {
    if (!readyReviewRunId) return
    const store = useCorrectionReviewStore.getState()
    store.sync(session.id, readyReviewRunId, readyReviewPatchIdSignature ? readyReviewPatchIdSignature.split('\u001f') : [])
    if (readyReviewRevertedSignature) {
      const revertedIds = new Set(readyReviewRevertedSignature.split('\u001f'))
      store.select(session.id, readyReviewRunId, useCorrectionReviewStore.getState().reviews[session.id].selectedIds.filter((id) => !revertedIds.has(id)))
    }
  }, [session.id, readyReviewRunId, readyReviewPatchIdSignature, readyReviewRevertedSignature])

  const run = async (action: () => Promise<unknown>, control = false) => {
    if (control ? controlRef.current : pendingRef.current || workspaceBusy) return false
    if (control) { controlRef.current = true; setControlPending(true) }
    else { pendingRef.current = true; setPending(true) }
    setError(null)
    try {
      await action()
      return true
    } catch (reason) {
      setError(correctionErrorMessage(reason, isZh))
      return false
    } finally {
      if (control) { controlRef.current = false; setControlPending(false) }
      else { pendingRef.current = false; setPending(false) }
    }
  }
  const executeRun = (kind: 'new' | 'resume' | 'retry') => kind === 'resume' ? resumeSessionCorrection(session.id)
    : kind === 'retry' ? retrySessionCorrection(session.id)
      : mode === 'quick' ? startSessionQuickCorrection(session.id) : detectSessionCorrectionIssues(session.id)
  const requestRun = (kind: 'new' | 'resume' | 'retry') => {
    if (pendingRef.current || controlRef.current || workspaceBusy) return
    if (kind === 'new' ? published || legacy : !draftConfigCurrent) {
      setRerun({ kind, runId: draft?.runId, draftRevision: draft?.revision, publishedId: published?.id,
        publishedRevision: published?.revision, legacyText: legacy?.correctedText })
    } else void run(() => executeRun(kind))
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
    draft?.proposedPatches.some((patch) => patch.state !== 'reverted')
    && draft.proposedPatches.filter((patch) => patch.state !== 'reverted').every((patch) => selected.has(patch.id)),
  )
  const progressLabel = activeShard?.stage === 'connecting'
    ? (isZh ? '正在连接纠错服务…' : 'Connecting to correction service…')
    : activeShard?.stage === 'waiting-response'
      ? (isZh ? '请求已提交，等待服务端响应…' : 'Request submitted; waiting for the service response…')
    : activeShard?.stage === 'thinking'
      ? (isZh ? '模型推理中，服务仍持续返回活动…' : 'The model is reasoning and the service remains active…')
      : activeShard?.stage === 'receiving-content'
        ? (isZh ? '正在接收纠错正文…' : 'Receiving correction content…')
        : activeShard?.stage === 'retry-countdown'
          ? (isZh ? `第 ${activeShard.index + 1} 个分片等待重试` : `Shard ${activeShard.index + 1} is waiting to retry`)
          : (isZh ? '等待模型响应…' : 'Waiting for the model response…')
  const persistDraftEdit = async (patch: ResolvedCorrectionPatch) => {
    const operation = editSaveQueue.current.catch(() => undefined).then(async () => {
      const latestDraft = useSessionStore.getState().sessions.find((item) => item.id === session.id)?.correction?.draft
      if (!draft || latestDraft?.runId !== draft.runId) throw new Error('correction-revision-mismatch')
      const current = latestDraft.proposedPatches.find((item) => item.id === patch.id)
      if (!current) throw new Error('correction-revision-mismatch')
      const stored = useCorrectionReviewStore.getState().reviews[session.id]
      const replacement = stored?.runId === draft.runId ? stored.edits[patch.id] ?? current.replacement : current.replacement
      try {
        if (replacement !== current.replacement) await updateSessionCorrectionDraftPatch(session.id, patch.id, replacement, {
          target: 'draft', id: latestDraft.runId, revision: latestDraft.revision, baseTranscriptHash: latestDraft.baseTranscriptHash,
        })
        if (draft) useCorrectionReviewStore.getState().saved(session.id, draft.runId, patch.id, replacement)
        setEditErrors((current) => {
          const next = { ...current }
          delete next[patch.id]
          return next
        })
      } catch (reason) {
        setEditErrors((current) => ({ ...current, [patch.id]: reason instanceof Error ? reason.message : String(reason) }))
        throw reason
      }
    })
    editSaveQueue.current = operation
    return operation
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
        {draft && <button type="button" disabled={controlPending || workspaceBusy} onClick={() => setAbandonRunId(draft.runId)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-xs disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />{isZh ? '放弃任务' : 'Abandon'}</button>}
      </div>
      <div className="min-w-0 flex-1 space-y-5 overflow-y-auto p-3 sm:p-5">
        {!draft && !published && !legacy && (
          <div className="flex flex-col items-center gap-4 py-12 text-center">
            <SpellCheck className="h-12 w-12 text-muted-foreground/40" />
            <p className="max-w-lg text-sm text-muted-foreground">{isZh ? 'AI 只返回局部 ASR 修改意图。本地会严格定位和校验 Patch，原始转录始终保持不变。' : 'AI returns local ASR edit intents only. Patches are resolved and validated locally, and the original transcript is never overwritten.'}</p>
            {!configured ? <p className="text-sm text-destructive">{isZh ? '请先启用 AI 并配置纠错模型。' : 'Enable AI and configure a correction model first.'}</p> : (
              <button type="button" disabled={pending || workspaceBusy} onClick={() => requestRun('new')} className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50"><Zap className="h-4 w-4" />{mode === 'quick' ? (isZh ? '检测并自动应用' : 'Detect and apply') : (isZh ? '检测候选' : 'Detect candidates')}</button>
            )}
          </div>
        )}
        {!draft && !published && !legacy && <CorrectionWorkspace key={`${session.id}-new`} session={liveSession} patches={[]} isZh={isZh} disabled={pending || controlPending || liveSession.status === 'recording' || liveSession.status === 'interrupted'} onBusyChange={setWorkspaceBusy} />}

        {draft && !reviewReady && (
          <section className="space-y-4 rounded-xl border border-border bg-muted/20 p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div><p className="text-sm font-medium">{draft.status === 'paused' ? (isZh ? '任务已暂停' : 'Task paused') : draft.status === 'failed' || draft.status === 'blocked-auth' ? (isZh ? '任务需要处理' : 'Task needs attention') : (isZh ? '正在逐片检测' : 'Detecting shard by shard')}</p><p className="mt-1 text-xs text-muted-foreground">{completedShards}/{totalShards} {isZh ? '分片完成' : 'shards completed'} · {draft.proposedPatches.length} {isZh ? '合法候选' : 'valid candidates'} · {draft.rejectedPatches.length} {isZh ? '已拒绝' : 'rejected'}</p><p className="mt-1 max-w-xl truncate text-xs text-muted-foreground" title={`${draft.config.baseUrl} · ${draft.config.model}`}>{endpointLabel} · {draft.config.model} · {(draft.config.transport || 'legacy').toUpperCase()}{activeShard ? ` · ${isZh ? '分片' : 'shard'} ${activeShard.index + 1}/${totalShards} · ${isZh ? '尝试' : 'attempt'} ${activeShard.attempt}${activeShard.attemptLimit ? `/${activeShard.attemptLimit}` : ''}` : ''}</p></div>
              <div className="flex gap-2">
                {processing && <button type="button" disabled={controlPending} onClick={() => void run(() => pauseSessionCorrection(session.id), true)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-xs disabled:opacity-50"><Pause className="h-3.5 w-3.5" />{isZh ? '暂停' : 'Pause'}</button>}
                {draft.status === 'paused' && <button type="button" disabled={pending || controlPending} onClick={() => requestRun('resume')} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50"><Play className="h-3.5 w-3.5" />{isZh ? '继续' : 'Resume'}</button>}
                {(draft.status === 'failed' || draft.status === 'blocked-auth') && <button type="button" disabled={pending || controlPending} onClick={() => requestRun('retry')} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" />{draftConfigCurrent ? (isZh ? '重试失败分片' : 'Retry failed shard') : (isZh ? '使用当前配置重新检测' : 'Restart with saved configuration')}</button>}
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} /></div>
            {!draftConfigCurrent && <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">{isZh ? '此任务使用的模型、端点凭据或传输方式已失效。继续时将放弃旧候选，并使用当前已保存配置从第 1 个分片重新检测。' : 'This task no longer matches the saved model, endpoint credentials, or transport. Continuing will discard old candidates and restart from shard 1.'}</p>}
            {processing && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{progressLabel}</div>}
            {draft.status === 'blocked-auth' && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{isZh ? '当前已保存的 API Key 无法访问此端点或模型。请重新保存正确的 URL、Key 和纠错模型。' : 'The saved API key cannot access this endpoint or model. Save the correct URL, key, and correction model.'}</p>}
            {draft.errorCode === 'timeout' && activeShard && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{isZh ? `第 ${activeShard.index + 1}/${totalShards} 个分片${activeShard.timeoutKind ? `发生 ${activeShard.timeoutKind} 超时` : '请求超时'}${activeShard.timeoutMs ? `，等待 ${Math.round(activeShard.timeoutMs / 1000)} 秒` : ''}，已尝试 ${activeShard.attempt}${activeShard.attemptLimit ? `/${activeShard.attemptLimit}` : ''} 次。` : `Shard ${activeShard.index + 1}/${totalShards} timed out${activeShard.timeoutKind ? ` (${activeShard.timeoutKind})` : ''}${activeShard.timeoutMs ? ` after ${Math.round(activeShard.timeoutMs / 1000)}s` : ''}, attempt ${activeShard.attempt}${activeShard.attemptLimit ? `/${activeShard.attemptLimit}` : ''}.`}</p>}
            {(draft.error || error) && <p className="flex items-start gap-2 text-xs text-destructive"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error || draft.error}</p>}
          </section>
        )}

        {reviewReady && draft && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><p className="text-sm font-medium">{isZh ? `发现 ${draft.proposedPatches.length} 个合法候选` : `${draft.proposedPatches.length} valid candidates`}</p><p className="mt-1 text-xs text-muted-foreground">{isZh ? '默认全部选中。确认后仅在本地应用，不再调用模型。' : 'All candidates are selected by default. Confirmation applies patches locally without another model call.'}</p></div>
              {draft.proposedPatches.length > 0 && <button type="button" disabled={pending || workspaceBusy} onClick={() => setSelected(allReviewPatchesSelected ? new Set() : new Set(draft.proposedPatches.filter((patch) => patch.state !== 'reverted').map((patch) => patch.id)))} className="shrink-0 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">{allReviewPatchesSelected ? (isZh ? '全部不选' : 'Select none') : (isZh ? '全部选中' : 'Select all')}</button>}
            </div>
            {draft.proposedPatches.length === 0 && <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground"><CheckCircle2 className="h-5 w-5 text-green-500" />{isZh ? '没有需要修改的候选，可直接完成。' : 'No correction candidates were found.'}</div>}
            <CorrectionWorkspace key={`${session.id}-${draft.runId}`} session={liveSession} patches={[...draft.proposedPatches, ...draft.rejectedPatches]} isZh={isZh} disabled={pending || controlPending || Boolean(processing)} onBusyChange={setWorkspaceBusy}
              onSaved={(patchId) => setEditErrors((current) => { const next = { ...current }; delete next[patchId]; return next })} review={{
              selected, edits: draftEdits, errors: editErrors,
              onToggle: (patchId) => setSelected((current) => { const next = new Set(current); if (next.has(patchId)) next.delete(patchId); else next.add(patchId); return next }),
              onEdit: (patchId, value) => useCorrectionReviewStore.getState().edit(session.id, draft.runId, patchId, value),
              onPersist: persistDraftEdit,
            }} />
            <button type="button" disabled={pending || controlPending || workspaceBusy || correctionInFlight || Object.keys(editErrors).length > 0} onClick={() => void run(async () => {
              for (const patch of draft.proposedPatches) await persistDraftEdit(patch)
              const latestDraft = useSessionStore.getState().sessions.find((item) => item.id === session.id)?.correction?.draft
              if (latestDraft?.runId !== draft.runId) throw new Error('correction-revision-mismatch')
              const savedReview = useCorrectionReviewStore.getState().reviews[session.id]
              await applySessionCorrectionReview(session.id, savedReview?.runId === draft.runId ? savedReview.selectedIds : Array.from(selected), {
                target: 'draft', id: latestDraft.runId, revision: latestDraft.revision, baseTranscriptHash: latestDraft.baseTranscriptHash,
              })
            })} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"><Zap className="h-4 w-4" />{isZh ? `本地应用 ${selected.size} 项` : `Apply ${selected.size} locally`}</button>
          </section>
        )}

        {published && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center gap-2"><CheckCircle2 className="h-5 w-5 text-green-500" /><p className="text-sm font-medium">{draft ? (isZh ? '上一版结果（只读）' : 'Previous result (read-only)') : (isZh ? `已应用 ${published.stats.applied}，拒绝 ${published.stats.rejected}` : `${published.stats.applied} applied, ${published.stats.rejected} rejected`)}</p>{!draft && <div className="ml-auto flex flex-wrap gap-2"><button type="button" disabled={pending || workspaceBusy || !configured} onClick={() => requestRun('new')} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-xs disabled:opacity-50"><Zap className="h-3.5 w-3.5" />{isZh ? '重新检测' : 'Run again'}</button><button type="button" disabled={pending || workspaceBusy} onClick={() => void run(() => revertAllSessionCorrectionPatches(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-xs disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" />{isZh ? '全部恢复原文' : 'Restore original'}</button></div>}</div>
            {draft && <p className="text-sm text-muted-foreground">{isZh ? '新结果发布后替换此结果；失败、暂停或放弃任务不会丢失旧修正。' : 'New publication replaces this result. Failure, pause or abandonment preserves these edits.'}</p>}
            <CorrectionWorkspace key={`${session.id}-published`} session={liveSession} patches={published.patches} isZh={isZh} disabled={pending || controlPending || Boolean(processing)} readOnly={Boolean(draft)} onBusyChange={setWorkspaceBusy} />
            <div data-correction-body>{renderCorrectionResult()}</div>
          </section>
        )}

        {legacy && !published && <section className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/20"><p className="text-sm font-medium">{isZh ? 'Legacy 全文纠错结果' : 'Legacy full-text correction result'}</p><p className="text-sm text-muted-foreground">{isZh ? '旧结果没有可信 Patch，不能单条管理或追加纠错。请确认重新检测，建立 Patch 结果后再编辑。原说话人分段会保留，并附完整历史修正稿。' : 'This result has no trusted patches. Confirm redetection before adding or managing individual edits. Original speaker segments are preserved with the complete legacy correction.'}</p>{draft ? <p className="text-sm text-muted-foreground">{isZh ? '新结果发布后替换；当前历史结果仅供查看。' : 'Replacement happens only on publication. This previous result is read-only.'}</p> : <div className="flex flex-wrap gap-2"><button type="button" disabled={pending || !configured} onClick={() => requestRun('new')} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50"><Zap className="h-3.5 w-3.5" />{isZh ? '重新检测' : 'Run patch detection'}</button><button type="button" disabled={pending} onClick={() => void run(() => restoreSessionLegacyCorrection(session.id))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" />{isZh ? '恢复原文' : 'Restore original'}</button></div>}<div data-correction-body>{renderCorrectionResult()}</div></section>}
        {error && !draft && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <ActionDialog open={Boolean(abandonRunId)} title={t.preview.abandonCorrection} description={`${t.preview.abandonCorrectionHint}${error ? `\n\n${error}` : ''}`} onClose={() => { if (!controlRef.current) setAbandonRunId(null) }} actions={[
        { label: t.common.cancel, variant: 'secondary', disabled: controlPending, onClick: () => setAbandonRunId(null) },
        { label: isZh ? '放弃任务' : 'Abandon', variant: 'danger', disabled: controlPending, onClick: () => void run(async () => {
          if (useSessionStore.getState().sessions.find((item) => item.id === session.id)?.correction?.draft?.runId !== abandonRunId) throw new Error(isZh ? '任务已变化，请重新确认。' : 'Task changed; confirm again.')
          await abandonSessionCorrection(session.id)
          setAbandonRunId(null)
        }, true) },
      ]} />
      <ActionDialog open={Boolean(rerun)} title={isZh ? '重新检测并替换纠错' : 'Redetect and replace corrections'}
        description={`${isZh ? '本次检测只使用原始转录。新结果成功发布后，将替换当前已应用、已撤销及人工修正的整个纠错集合，不合并旧项。取消、失败或放弃不会丢失旧结果；原始转录保持不变。' : 'Detection uses only the original transcript. Successful publication replaces the entire applied, reverted and manual correction set, without merging old edits. Cancel, failure or abandonment preserves the previous result. The original transcript stays unchanged.'}${error ? `\n\n${error}` : ''}`}
        onClose={() => { if (!pendingRef.current) setRerun(null) }} actions={[
          { label: t.common.cancel, disabled: pending, onClick: () => setRerun(null) },
          { label: isZh ? '确认重新检测' : 'Confirm redetection', variant: 'primary', disabled: pending || workspaceBusy || !configured, onClick: () => void run(async () => {
            if (!rerun) return
            const current = useSessionStore.getState().sessions.find((item) => item.id === session.id)?.correction
            if (current?.draft?.runId !== rerun.runId || current?.draft?.revision !== rerun.draftRevision
              || current?.published?.id !== rerun.publishedId || current?.published?.revision !== rerun.publishedRevision
              || current?.legacy?.correctedText !== rerun.legacyText) throw new Error('correction-revision-mismatch')
            const kind = rerun.kind
            setRerun(null)
            await executeRun(kind)
          }) },
        ]} />
    </div>
  )
}
