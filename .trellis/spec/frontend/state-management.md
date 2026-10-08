# State Management

> How state is managed in this project.

---

## Overview

Session automation is orchestrated in the Zustand `sessionStore`. React components may trigger store actions, but must not own durable workflow transitions or resume logic.

## Scenario: Durable Session Automation

### 1. Scope / Trigger

Use this contract when a completed `TranscriptSession` starts a multi-step renderer workflow that must survive page changes or application restarts. Examples include correction followed by briefing and title application.

Do not add a second correction executor. Reuse the correction draft runner, leases, mutation queue, and checkpoint path owned by `sessionStore` and `sessionRepository`.

### 2. Signatures

The persistent state belongs to `TranscriptSession` and is normalized in `sessionSchema.ts`:

```ts
interface TranscriptAutoPostProcessWorkflow {
  version: 1
  status: 'queued' | 'running' | 'waiting-review' | 'error' | 'completed'
  step: 'correction' | 'briefing' | 'title' | 'export'
  correctionMode: 'quick' | 'review'
  titleAtStart: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  exportPath?: string
  exportedAt?: number
  error?: string
}
```

The completion boundaries call one store action:

```ts
maybeStartAutoAiPostProcess(sessionId: string): Promise<void>
```

### 3. Contracts

- Full automation wins when both automation settings are true; legacy review-only detection must not run in parallel.
- Snapshot the correction mode and title at workflow creation. Briefing uses the latest persisted session and current saved AI settings.
- Persist workflow transitions with `sessionRepository.updateMetadata`; await existing correction checkpoints when later steps depend on a published correction.
- `running` becomes `queued` only during launch recovery, not during general schema normalization.
- A Review workflow stops at `waiting-review` until local publication. An empty patch list is published locally and continues without a meaningless confirmation.
- A briefing recovered at the `briefing` step is reusable only when it was generated after `startedAt` and its source provenance still matches `resolveTranscriptText`.
- Do not increment the IndexedDB version for fields stored inside existing Session records.
- Corrected Markdown automatic saving consumes published corrections through one idempotent coordinator, independently of full AI automation. Full automation waits until the title step before submitting to that same coordinator. Manual export and automatic saving share `buildCorrectedTranscriptMarkdown`.
- Automatic publication folders are granted only by main-window native role selectors. `savePublishedMarkdown` resolves persisted directory capabilities and owns the registration; the old writeAutoExportFile API is not an automatic-save fallback. Never expand the general isPathAllowed whitelist.
- First saves choose an exclusive non-overwriting name and register it once. Subsequent publication/title updates target that same registered file, with main-process identity/hash checks and replayable intent.
- An export retry reads the latest Session and reruns only the file coordinator, never AI. A persisted `exportPath` alone is not proof of durable saving or authorization. External changes/moves pause updates rather than overwrite edits or generate duplicates.
- Automatic saving is prospective: baseline already loaded publications, including old `waiting-directory` entries. Hook mount, enable toggles and directory selection must not first-save unchanged historical publications. Observe changes even while disabled so enabling does not backfill work performed while off.
- Newly published/edited corrections while enabled are eligible, as are already registered automatic-file maintenance and explicitly active workflow recovery. Directory changes retry only eligible waiting-directory records, not the historical sweep. Explicit per-record export/retry remains available; changing defaults never moves registered files or deletes prior exports.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| AI disabled or correction/briefing model missing | Persist workflow `error` at `correction`; do not start correction |
| Correction fails or is abandoned | Persist workflow `error`; do not brief or rename |
| Review has proposed patches | Persist `waiting-review`; resume only after publication |
| Briefing fails | Keep published correction, persist workflow `error` at `briefing`, keep title |
| Briefing has no non-empty title suggestion | Keep briefing, persist workflow `error` at `title`, keep title |
| Current titleRevision differs from titleRevisionAtStart (including ABA) | Preserve manual title and complete normally; legacy workflow without a frozen revision cannot apply an automatic title |
| Automatic file save lacks Electron support or a configured directory | Keep published correction/AI results; show waiting-directory and permit a file-only retry |
| Export directory becomes invalid or writing fails | Keep correction, briefing, and title; persist `error` at `export` |
| Persisted export workflow already has `exportPath` | Complete without writing another file |
| Persisted `completed` workflow is not at `title` or `export` | Reject the workflow during schema normalization |
| Persisted `waiting-review` is not Review correction | Reject the workflow during schema normalization |
| Hook mounts, auto-save is enabled, or a directory is chosen with unchanged unregistered history | Establish/retain the baseline; no automatic first-save IPC |
| New eligible publication waits for a directory | Retry on a later configuration revision; ignore activity-only file events |
| Registered historical conflict/error | No implicit startup retry; preserve external content and allow explicit retry |

### 5. Good / Base / Bad Cases

- Good: correction publication is checkpointed, workflow advances to briefing, and recovery reuses a current persisted briefing without another model request.
- Good: title application advances to export, the main process returns the actual collision-safe path, and the workflow persists it before completion.
- Base: old sessions have no workflow field and load normally without creating new work.
- Bad: a component writes a Blob for automatic export, a renderer writes arbitrary paths directly, or retry restarts correction/briefing.

### 6. Tests Required

- Quick order: publish correction, brief the published source, conditionally apply title, complete.
- Review: wait with candidates, auto-continue with zero candidates, continue after local apply.
- Duplicate completion notifications create one correction/briefing chain.
- Launch: resume `queued`/interrupted `running`; skip `waiting-review`, `error`, and `completed`.
- Crash window: a persisted current briefing at the `briefing` step is not requested again.
- Failure boundaries: configuration, correction, abandon, briefing, and empty-title cases stop at the correct step.
- Export: disabled path makes no IPC call; success persists the returned path; collision-safe writing never overwrites; failure and changed-directory retry call no AI service again.
- IPC: reject traversal/absolute filenames, missing/non-directory targets, empty content, write failures, and invalid reveal targets.
- Publication hook: historical/no-file/waiting-directory startup and toggle/selection do not backfill; changes made while off remain baseline; new first publication and new revision save while enabled; registered maintenance and active export workflows still run; completed historical workflows and persisted conflicts do not restart.
- Schema round-trip: old Sessions gain schema version only, valid workflows survive, malformed combinations are dropped.

### 7. Wrong vs Correct

#### Wrong

```ts
await runCorrection(sessionId)
await generateBriefing(capturedSession)
updateTitle(sessionId, result.titleSuggestion)
```

This uses stale Session data, has no restart cursor, and overwrites manual title changes.

#### Correct

```ts
await checkpointPublishedCorrection(sessionId)
persistWorkflow(sessionId, { status: 'queued', step: 'briefing' })
await runPersistedWorkflow(sessionId)
persistWorkflow(sessionId, { status: 'queued', step: 'export' })
await savePublishedMarkdown(sessionId)
```

The workflow runner reloads the latest Session at every boundary, validates provenance before reusing results, and applies a suggested title only when the title still matches the start snapshot.

---

## When to Use Global State

Use Zustand plus Session persistence when work spans components, navigation, or application restarts. Keep transient form drafts and visual toggles local unless another surface must observe them.

## Persistence Boundary

`sessionRepository` owns normalized in-memory Session cache updates and IndexedDB writes. Components call store actions rather than repository methods directly.

- Cached records are normalized immutable snapshots: updates replace the changed record, not every unrelated record or its content arrays. Read snapshots may copy the outer array but must retain unchanged record identities. Callers must never mutate returned records/nested data in place.
- Durable patch factories receive a defensive normalized copy of the target, retain the existing per-record queue/rollback guarantees, and treat empty/already-current primitive patches as no-ops without updating timestamps.
- File catalog reconciliation compares audio, naming and job states before writing; repeated identical state causes zero writes/publications. Publish changed Session state coherently after a valid catalog round, not once for every unchanged naming entry.

## Scenario: Unified Review Folders And Creation Context

### Performance Diagnostic And Recovery UI Addendum

- Metadata writes preserve normalized unrelated record identities, with defensive target copies for factories. No-op audio/naming/job catalog replay does not persist or publish; committed partial success is published even if a later record fails.
- `shared/performanceDiagnostics.ts` is opt-in, default off, capped at 160 records per process. Only whitelisted stages/statuses and nonnegative finite numeric counters are accepted; never pass body, key, path, title, Session object or raw error. `startPerformanceSpan` completes once. Disabled capture creates no observer/heartbeat.
- Settings → Data Management exposes capture/copy/clear and per-item recording recovery acknowledgement. Copy combines renderer/native numeric records only. Native access requires main-window identity. Keep diagnostic preference outside content backups.
- Use current active Session IDs to list/ack managed recovery evidence; refresh before retrying stale choices. Startup warning count uses unresolved notices when supported, legacy count fallback otherwise. Never globally mute all warnings or remove transcript/media references after acknowledgement.
- Real built-UI regression now seeds 105 Sessions / 200,000 unrelated synthetic tokens; verifies title enter/save, association popup/toggle, lower AI settings scroll, scope/tag/date behavior and narrow focus/refresh. This is not real-profile latency measurement or manual OS dialog acceptance.

### 1. Scope / Trigger

Review navigation, folder/search/date/tag filtering, topic management and global versus topic-specific task creation.

### 2. Signatures

```ts
type ReviewFolder = {kind:'all'} | {kind:'unclassified'} | {kind:'topic';topicId:string}
selectReviewSessions(sessions, projects, folder, tagIds?, query?, tags?, selectedDate?): TranscriptSession[]
useUIStore.getState().setReviewFolder(folder): void
useUIStore.getState().openTopicCreation(topicId, 'live' | 'file'): void
useTagStore.getState().setSelectedReviewDate(date | null): void
```

### 3. Contracts

- Folder state belongs to `uiStore`, not Topic active creation selection. `setView('live'/'file')` clears new-work topic context; `openTopicCreation` is explicit and refuses archived/missing topics. Existing recording/job boundaries still freeze arrays before async work.
- An open topic management panel follows topic-folder navigation; selecting all/unclassified closes it, and browsing never reopens a closed panel. Opening management also selects that topic for review, without changing recording/job creation context. Reset transient association search/errors on target changes. Key the embedded directory panel by topic ID so pending/error/status from an old picker cannot leak into another topic. Directory choices remain bound to the topic ID captured when invoked; never infer ownership from path names or automatically repair existing configuration/move files.
- Persist only review folder and filter preferences, never Topic objects, Sessions or creation context in those UI keys. Validate restored shapes. First review defaults to all; deleted selected topics fall back to all.
- One selector owns descendant aggregation/deduplication, unclassified direct-link emptiness and AND combinations with search, tags and date. Orphan IDs remain linked and visible, never unclassified.
- Review defaults to independently scrolling folder navigation, session list and document. Preserve a visible selection; after Sessions and Topics load, otherwise select the newest visible record (equal timestamps retain selector input order). Validate on folder/search/tag/date/candidate changes, not on every explicit selection clear. Empty results never retain an out-of-scope document or clear filters.
- Activity overview is collapsed by default and available only in all history; it uses folder plus tags without query/date. Date clicks toggle an independent date filter and retain text search. A clearable date indicator remains visible when the overview is collapsed or unavailable.
- Folder visibility, tree expansion and list visibility are independent. Mobile return retains the mounted list, filters and scroll. Desktop list resizing uses container bounds, pointer capture/cleanup, keyboard separator semantics and reset; persist only a validated local width preference (default 380, minimum 280), not content/export settings. Folder width is an independent local preference (default 176, range 160-260) using the same separator behavior. Clamp rendered widths without overwriting preferences on window shrink; narrow containers use single-column navigation rather than overflow.
- Primary navigation defaults to collapsed only when no explicit expanded preference exists. Sidebar width and main offset share `getSidebarWidth` (56 collapsed, 176 expanded) and the same transition timing. Settings navigation is 160px on desktop and scrolls horizontally on narrow screens; its bounded content is left-aligned.
- Bound decorated input wrappers together with their inputs. Password visibility/search actions positioned inside a `relative` wrapper must remain within the actual input bounds, not at the far edge of a wider settings card. Verify these bounds at desktop and narrow widths.
- Mobile document opening is separate from valid selection: automatic filter fallback must not hide the list/search field after returning to the list. Explicit `openReview` navigates to the document; `setReviewSelection` reconciles the selected ID without changing mobile navigation.
- Overlay folder drawers use an opaque theme background (`bg-background`), not the embedded desktop pane's decorative `bg-muted/20`. Keep the separate outside backdrop and dismissal/focus behavior. Renderer regressions must assert actual background alpha in both themes; a visible dialog and correct z-index alone do not prove readable separation from underlying content.
- Legacy topics view/command redirects to review. External detail entry resets filters to all so a newly completed record cannot be hidden by an older folder selection. List/detail switching within review retains filters.
- PreviewModal defaults/resets Summary and clears section-local AI state. Correction selection and unsaved edit drafts are transient session/run-scoped state surviving tabs, folding and component unmount; reconcile removed candidate IDs and initialize new runs independently. Empty/pending/error summaries stay on Summary with their existing actions.
- Folder/topic dialogs use focus containment and restoration. Modal Escape must not also dismiss an underlying detail or drawer.

### 4. Validation & Error Matrix

Explicit empty projectIds -> unclassified even if legacy topicId exists. Unknown ID -> visible repair label, not unclassified. Deleted topic selection -> all. Record exits folder/search/tag/date -> latest visible selection or empty results, without forcing mobile list navigation into a document. Archived topic creation -> no new context. Topic mutation failure -> keep dialog/error and use existing durable deletion replay.

### 5. Good/Base/Bad Cases

Good: browse A, globally record unlinked; explicitly create in A, browse B and keep frozen A ownership. Base: legacy topic entry opens review. Bad: folder clicks call setActiveTopic, date clicks overwrite search, or parent display becomes a direct link.

### 6. Tests Required

Real schema/store tests cover deduplication, orphan/empty links, AND scope, frozen creation, global resets and legacy redirects. `reviewPhase4.test.ts` loads the built renderer in isolated Electron and exercises Summary states/switching, search/date/tag interaction, independent heatmap, archive/restore and narrow drawer. Seed after database startup and wait for initial configuration gating before navigating; hidden controls must not count as visible interaction evidence. Browser smoke supplements, not replaces, actual native storage/preload tests.

Cross-topic management regression must verify synchronized highlight/title, distinct picker project IDs/directories, return-to-topic persistence, late picker responses not replacing the current panel, all/unclassified closure, and closed-panel browsing. Native storage tests must preserve independent topic directory entries across restart and leave default-directory fallback unchanged.

### 7. Wrong vs Correct

Wrong: `setActiveTopic(clickedFolder)` or `setSearchQuery(clickedDate)`.

Correct: `setReviewFolder(folder)` and `setSelectedReviewDate(date)` for browsing; call `openTopicCreation` only from explicit record/import actions and freeze the existing creation selection at task start.

### Project And File Contracts

- `projectIds` is the sole authority for direct links. An explicit empty array overrides legacy `topicId`; the legacy field is projected from the first link. Preserve unknown/orphan project IDs visibly for repair.
- Topic IDs and `desktoplive_topics` remain compatible. Normalize project parent/archival metadata centrally; checked writes reject missing parents, self-parenting and cycles. Parent aggregation deduplicates Session IDs and distinguishes inherited links.
- Capture project associations and default save project when recording/job creation starts. Later navigation must not change resumed task context. Project changes never automatically relocate external Markdown.
- Project deletion uses recoverable per-record patches and reparents direct children, never bulk Session replacement. Record deletion commits an independent read-only result snapshot before removing the original; snapshot failure blocks deletion. Snapshots never retain full transcript/correction bodies or participate in AI.
- `titleRevision` increments at every real saved-title change, including ABA. Automatic title application compares its frozen revision, not merely title text.
- File references distinguish managed assets, original source ID, historical import name and current original name. Reconciliation checks asset/source revision and patches every matching Session/job without replacing unrelated correction/progress fields.
- Filesystem durability is owned by replayable main-process journals, not asynchronous ordinary Session metadata updates. Backup restores do not grant local-directory or original-file capabilities.

## Common Mistakes

- Treating `ready-for-review` as a published correction.
- Resuming marked queued correction drafts through both generic and workflow runners.
- Reusing a successful AI artifact solely by timestamp without validating source provenance.
- Downgrading `running` in the schema normalizer, which also runs during ordinary writes.

## Scenario: Project Relationship Deletion And Read-Only Results

### 1. Scope / Trigger

Use when editing project membership/hierarchy, creating recording/file work, deleting projects or deleting records.

### 2. Signatures

```ts
sessionRepository.getSessionsSnapshot(): TranscriptSession[]
sessionRepository.updateMetadataDurable(id, patchOrFactory): Promise<TranscriptSession[]>
sessionRepository.deleteSessionWithResults(id): Promise<TranscriptSession[]>
sessionRepository.importCompletedSession(session): Promise<TranscriptSession[]>
useSessionStore.getState().setSessionProjectAssociation(id, projectId, associated): Promise<void>
useTopicStore.getState().resumePendingDeletion(): Promise<void>
useFileTranscriptionStore.getState().unlinkProjectReferences(projectId): void
```

DB `delive-app` version 4 adds `deletedSessionSnapshots`; Session schema 8 owns project/ref/revision fields. `delive_project_deletion_v1` stores a checked localStorage intent with `version`, `projectId`, optional `parentId`, and `createdAt`.

### 3. Contracts

- Replay project deletion after Session load. Read membership from repository authority, not a potentially stale UI list. Factory patches execute inside the per-record queue against the newest record.
- Reject new associations to a deleting project. Repeatedly unlink current references; verify task-link persistence, reparent children, checked-write projects, then clear the journal. Never replace an entire Session collection.
- Zustand persist may mutate memory before localStorage fails. File-task unlink replay must always rewrite/verify current credential-free task state even when memory no longer contains the removed project.
- Recording selection is frozen before source-picker awaits. File jobs freeze selection at creation; completion and retry use saved job associations. Ordinary later navigation does not change task scope.
- Snapshot and original deletion share one IDB transaction. Request success is not commit success. Abort/failure retains both original storage and repository cache; subsequent retries remain possible.
- Snapshot projections contain only identity/title/project metadata, necessary source labels and existing postProcess/askHistory/mindMap. No full transcript, corrected body, tokens, segments or local-path capabilities. Display them in data management without AI controls or source navigation.
- Completed imports use a strict single-record upsert/patch, preserve concurrent title/project/correction metadata and reject resurrection of IDs in deletion snapshots.
- HistoryPanel serves full review and project detail. No default exclusion of project-linked records. Inherited links are labeled; only explicit direct-link checkboxes remove associations.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Invalid/missing parent or cycle | Checked project write rejects without changing state |
| Project/Session/task quota failure | Retain replayable intent; report error, do not report deletion complete |
| UI list is stale/empty | Repository membership still receives durable unlink patches |
| Snapshot transaction abort | Original remains, snapshot does not commit, no media deletion |
| Active recording deletion | Reject; stop recording first |
| Late file completion targets deleted ID | Reject; require a new import/task ID |

### 5. Good/Base/Bad Cases

- Good: shared child record remains in other projects and all review; project deletion reparents grandchildren and preserves newer summaries.
- Base: legacy topicId becomes one direct project link; explicit empty projectIds remains unlinked.
- Bad: `replaceAllSessions(capturedSessions)` during deletion/import, treating a renderer list as repository authority, or deleting audio before snapshot commit.

### 6. Tests Required

- Real store/repository tests: multi-link writes, partial unlink, child reparenting, cycle rejection, archive preservation, frozen creation selection, Session/task quota failures and replay.
- Native IDB tests: v3 -> v4 upgrade preserves IDs/body and writes verified pre-upgrade snapshot; explicit abort rolls back result snapshot+delete.
- UI smoke: all review retains project-linked records; parent aggregation deduplicates; checkbox clicks do not open records; affected-project confirmation includes ancestors; desktop/mobile have usable actions.

### 7. Wrong vs Correct

Wrong: read `useSessionStore.getState().sessions` once, remove links in captured complete objects, then `replaceAllSessions`.

Correct: read `sessionRepository.getSessionsSnapshot()`, submit a queued factory patch removing one direct ID, re-read until no reference remains, verify job links, and only then commit project organization and clear intent.

## Scenario: Durable Titles And Backup Restore Consumers

### 1. Scope / Trigger

Saved manual/suggested/automatic titles and local/cloud restore entry points.

### 2. Signatures

```ts
updateSessionTitle(id, title, expectedRevision?): Promise<boolean>
assertBackupRestoreIdle(): void
reconcileFileRecordBindings(): Promise<void>
savePublishedMarkdown(id, { retry?: boolean, adoptLegacy?: boolean }): Promise<CorrectedMarkdownFileState | undefined>
```

### 3. Contracts

- Compute titleRevision and optional expectedRevision comparison inside the queued durable factory. Publish store title only after strict persistence resolves. Same text is retryable after failed persistence; do not suppress retry because an optimistic title happened to match. Automatic-title mismatch returns false, including manual ABA changes.
- Manual title inputs retain drafts/errors on persistence failure and catch rejected promises. Successful titles remain successful if subsequent file synchronization fails; media/Markdown states own file-only retries.
- Local import reloads Sessions, Tags, Topics and Settings, then reconciles main record contexts/deleted IDs. A reload of Sessions alone leaves an incorrect project UI cache. Cloud reload follows the same App bootstrap path.
- Local/cloud restore reject active recording, transcription, correction/summary/question/map or file-saving work before mutation. Backup restore cannot replay machine directory/source capabilities.
- Legacy Markdown adoption shares the current-published coordinator; explicit native selection and confirmation authorizes only the selected file's parent. Exact content hash and identity must verify; directory preference remains unchanged. No automatic alternate copy when legacy content differs or its location lacks authorization.

### 4. Validation & Error Matrix

Disk quota/title write failure -> reject, retain previous store title and editable draft. Automatic expected revision mismatch -> false/no title write. Active restore -> reject before overwrite. Invalid/mismatching legacy file -> preserve external file and do not authorize its directory. Successful legacy adoption -> durable registration before any no-op early return.

### 5. Good/Base/Bad Cases

Good: manual A->B->A prevents old AI suggestion, but each successful revision can update one registered file. Base: a checked existing old file is adopted without moving it or changing global directory. Bad: optimistic title plus later empty retry suppression, catching file error as title rollback, or restore with stale Topic store.

### 6. Tests Required

sessionRepositoryDurability tests check title-failure retry and ABA. backupRestoreGuard checks active producer/AI/file refusals. electronCorrectedMarkdown tests check legacy no-op registration restart, different-directory exact adoption, external edits denied and single-file update. Real native IndexedDB restore and actual MCP stdio tests complement unit tests; mock backend endpoints are not paid-provider/cloud verification.

### 7. Wrong vs Correct

Wrong: `updateMetadata(id,{title})` optimistically, then await an unrelated write and close the title input regardless of error.

Correct: queued `updateMetadataDurable(id,current=>({title,titleRevision:current.titleRevision+1}))`, update store on resolution, retain draft on rejection, and separately report physical-file synchronization failures.

---

## Scenario: Single Active AI Endpoint Protocol And Model State

### 1. Scope / Trigger

Use this contract when changing the AI post-process protocol, Base URL, API key, thinking mode, model discovery, model selection, feature assignment, or request/response transport.

### 2. Signatures

```ts
type AiProviderProtocol = 'openai-compatible' | 'anthropic-compatible'
type AiThinkingMode = 'default' | 'disabled'

createAiRequestContext(
  provider: AiProviderProtocol | undefined,
  baseUrl: string,
  apiKey?: string,
): AiRequestContext

buildAiCompletionBody(request: AiCompletionRequest): Record<string, unknown>
invalidateAiEndpointModels(): Partial<AiPostProcessConfig>
reconcileAiEndpointModels(
  config: AiPostProcessConfig,
  availableModels: string[],
): Partial<AiPostProcessConfig>
resolveModelForFeature(config: AiPostProcessConfig, feature: AiFeatureKey): string
```

### 3. Contracts

- The app has one active AI endpoint using either OpenAI-compatible or Anthropic-compatible wire format. `AiPostProcessConfig` is the source of truth for protocol, normalized `baseUrl`, credentials, thinking mode, models, and feature assignments.
- `aiProtocol.ts` owns URL construction, fixed authentication headers, request shape, visible-text/error/usage parsing, and SSE delta decoding. Feature services own prompts and schemas but must not recreate protocol branches.
- Changing protocol or Base URL clears `availableModels`, `selectedModels`, `defaultModel`, legacy `model`, and `modelAssignment`, but preserves prompts, glossary, automation, export, and other correction settings. Anthropic protocol normalizes OpenAI-only `json_object` output to `prompt-json`.
- Missing persisted protocol/thinking fields normalize to `openai-compatible` and `default`, preserving legacy behavior.
- `default` thinking sends no thinking parameter. `disabled` sends `thinking: { type: 'disabled' }` to every AI feature; OpenAI-compatible disabled requests omit temperature for providers with fixed non-thinking sampling parameters. Unsupported forced-thinking models fail explicitly without fallback.
- Anthropic-compatible requests use `/v1/models`, `/v1/messages`, `x-api-key`, `anthropic-version`, top-level `system`, and a required `max_tokens`. A Base URL already ending in `/v1` must not gain a duplicate segment.
- OpenAI reasoning and Anthropic thinking deltas are activity only. Only visible content deltas may enter briefing/chat/mind-map/correction parsers.
- Correction snapshots freeze protocol and thinking mode under `identityVersion: 2`. Version-1 snapshots remain readable but are stale and must not resume under changed request semantics.
- Electron isolated correction recovery receives a restricted protocol enum and constructs the fixed header set in the main process; renderer code cannot inject arbitrary headers.
- A successful `/models` refresh reconciles every derived model field through one shared helper. Components must not implement private cleanup rules.
- When a non-empty `availableModels` list exists, request-time model resolution accepts only candidates in that list. Empty lists preserve legacy/manual model compatibility.
- Saved URL, credential, and resolved model must come from the same current `AiPostProcessConfig`; never retain an old endpoint model ID with new endpoint credentials.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| Base URL changes | Immediately invalidate all endpoint-derived model fields |
| Protocol changes | Invalidate endpoint-derived model fields and increment credential identity |
| Thinking mode changes | Preserve model state but invalidate correction config identity |
| Anthropic config contains `json_object` | Normalize to `prompt-json` before request |
| Forced-thinking model rejects disabled mode | Surface the provider error; do not retry without the field |
| Persisted correction snapshot has identity version 1 | Treat as stale and rebuild with current settings |
| Anthropic SSE emits thinking then text | Update activity state, append text only, merge split usage counters |
| Refreshed list retains selected/default model | Preserve the valid values |
| No previous selection exists in refreshed list | Select the first returned model as safe default |
| Feature assignment is absent from selected refreshed models | Drop the assignment and fall back to a valid default |
| Known model list contains no valid candidate | Resolve an empty model and fail configuration before request |

### 5. Good / Base / Bad Cases

- Good: URL changes, old assignments disappear, refresh selects a new default, and all features resolve against the new list.
- Good: the selected protocol drives discovery, all four AI feature requests, response parsing, and Electron recovery through the same adapter.
- Base: an old/manual config has no fetched list or protocol fields and continues as OpenAI-compatible with model-default thinking.
- Bad: a feature appends `/messages` itself, uses Bearer auth for Anthropic recovery, or appends reasoning/thinking content to the visible correction payload.

### 6. Tests Required

- Assert endpoint invalidation clears every model-derived field and no unrelated field.
- Assert reconciliation preserves same-name models, drops stale assignments, and creates a safe default.
- Assert request-time resolution rejects stale candidates when a current non-empty model list is known.
- Assert OpenAI and Anthropic URL/header/body mappings, including `/v1` de-duplication and safe-storage placeholders.
- Assert default/disabled thinking payloads and temperature omission behavior.
- Assert JSON and SSE visible-text extraction excludes reasoning/thinking and merges Anthropic split usage.
- Assert protocol-aware Electron recovery headers and stale correction snapshot behavior.

### 7. Wrong vs Correct

#### Wrong

```ts
fetch(`${baseUrl}/v1/messages`, {
  headers: { Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ messages }),
})
```

#### Correct

```ts
const context = createAiRequestContext(config.provider, config.baseUrl, config.apiKey)
const body = buildAiCompletionBody({
  provider: config.provider,
  thinkingMode: config.thinkingMode,
  model,
  system,
  user,
})
await fetch(context.completionUrl, { method: 'POST', headers: context.headers, body: JSON.stringify(body) })
```

The shared protocol and reconciliation boundaries prevent UI, persistence, feature services, and recovery transport from diverging.

---

## Scenario: Durable Local Video Transcription Tasks

### 1. Scope / Trigger

Use this contract when file transcription accepts a local video, prepares a managed audio archive, resumes after restart, retries with another Provider, or deletes extracted media.

### 2. Signatures

```ts
type FileTranscriptionJobStatus =
  | 'queued' | 'extracting' | 'audio-ready'
  | 'uploading' | 'transcribing'
  | 'completed' | 'error' | 'cancelled'

submitFile(file: File, config: FileTranscriptionConfig): Promise<string>
retryJob(jobId: string, overrideConfig?: FileTranscriptionConfig): Promise<void>
deleteManagedAudio(sessionId: string): Promise<boolean>
```

### 3. Contracts

- Audio inputs keep the existing direct Provider path and are not persisted as file tasks.
- Video inputs allocate the final Session ID before extraction. Persist only the display metadata, Provider ID, credential-free recognition/context snapshot, stage, and managed audio metadata.
- Register original inputs separately in the main process with canonical path, identity and revision; Session/job references keep the original source ID, historical import name and current original name separate from managed-audio names. Never persist credentials or copy/upload the video.
- A Provider receives a new `File` made only from the manifest-resolved managed audio. Extraction failure must never fall back to the original video.
- Restart recovery checks the managed archive. Complete audio becomes `audio-ready`; missing audio requires re-import and must not auto-upload.
- Retry reuses the managed MP3 and current credentials. It may replace the saved non-secret Provider config and must not allocate another Session ID.
- Removing a task removes only the record. Deleting audio is a separate confirmed operation. JSON/cloud backup contains metadata paths, not audio bytes.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| Video extraction completes | Persist audio metadata, then upload the MP3 |
| Extraction is cancelled | Stop FFmpeg, remove the temp output, mark task cancelled |
| Upload/transcription is cancelled | Abort Provider work, retain complete MP3 |
| App restarts after extraction | Mark task `audio-ready`; do not upload automatically |
| App restarts before extraction completes | Mark task error and require video re-import |
| Managed MP3 is missing | Disable retry and report unavailable audio |
| Provider settings changed | Retry reads current credentials and uses the selected non-secret config |
| Cloudflare MP3 exceeds 2 MiB | Fail before request and suggest another Provider |
| Completed Session already has the task ID | Replace/update that ID; never create a duplicate |

### 5. Good / Base / Bad Cases

- Good: a video creates one durable task, extracts once, survives a Provider rejection, and retries the same MP3 with another Provider.
- Base: an ordinary MP3 follows the previous direct upload flow and creates its Session after success.
- Bad: expose original paths through remote API/backups as authorization, persist API keys, upload the original video after conversion failure, or delete media when a task row is removed.

### 6. Tests Required

- Classify known audio and candidate video inputs, including ambiguous WebM without MIME.
- Persist video task metadata only; assert serialized state contains no credential keys.
- Recover interrupted tasks with present/missing archives and never auto-upload.
- Assert Provider input is MP3 for video and the original `File` for audio.
- Assert retry uses the original Session ID and current credentials.
- Assert task removal, Session deletion, and audio deletion remain distinct operations.

### 7. Wrong vs Correct

#### Wrong

```ts
await provider.transcribe(originalVideo)
removeJob(jobId)
await deleteMedia(sessionId)
```

#### Correct

```ts
const sessionId = generateId()
const archive = await electronAPI.extractMediaAudio({ taskId, sessionId, sourcePath })
const audio = await electronAPI.readMediaAudio(sessionId)
await provider.transcribe(new File([audio.data], archive.audio.fileName, { type: 'audio/mpeg' }))
```

The durable task owns recovery state, while the main process owns media bytes and paths.

---

## Scenario: Pausable Live Recording

### 1. Scope / Trigger

Use this contract when changing live capture, ASR connection lifecycle, source-audio archive, recording controls, shortcuts, or elapsed-time display. The workflow spans Zustand, browser media resources, Provider sessions, Electron archive IPC, and UI surfaces.

### 2. Signatures

```ts
type RecordingState =
  | 'idle' | 'starting' | 'recording'
  | 'pausing' | 'paused' | 'resuming'
  | 'stopping' | 'switching'

startRecording(meetingContextOverride?: MeetingContextOverride): Promise<boolean>
pauseRecording(): Promise<void>
resumeRecording(): Promise<void>
stopRecording(): Promise<string | null>

pauseCapture(): Promise<void>
resumeCapture(capabilities: CapturePipelineCapabilities): Promise<void>

ProviderSessionManager.drain(): Promise<ProviderSessionDisconnectResult>
```

`TranscriptSession.status` remains `recording` while the runtime state is paused. A completed live Session stores effective milliseconds in `TranscriptSession.duration`.

### 3. Contracts

- Source selection happens before Provider connection on initial start. Archive and capture outputs stay gated until both pipelines are ready and the effective timeline starts.
- Pause order is: block archive output at the boundary, drain the capture tail, flush archive writes, drain/disconnect Provider, freeze residual interim text, freeze the timeline, enter `paused`.
- Resume reuses a healthy stream. An invalid stream is replaced through a new `prompt` selection without creating a Session or calling archive `begin` again.
- In mixed mode, `CaptureManager` must strongly own the complete Web Audio graph (`AudioContext`, source nodes, and destination node) until final stop. Pause keeps this local producer graph running and gates/stops all archive, ASR, and waveform consumers; suspending the producer can leave a generated destination track `live` but permanently silent after resume in Chromium.
- `MediaStreamTrack.readyState === 'live'` proves only that a track has not ended. It does not prove that a retained generated stream is producing audio frames. Do not use readyState alone to justify suspending or discarding the graph that owns that track.
- Archive `begin` is once per Session. Pause only stops the archive processor and drains its append queue; final stop performs `finalize`.
- Provider listeners remain attached during the bounded two-second drain. Ordinary `final` segments are not terminal; only `finished` completes drain early.
- Connection-relative token timestamps receive one immutable epoch offset in `ProviderSessionManager`. Reducers consume session-relative timestamps only.
- The effective timeline belongs to `sessionStore`; components may use a render timer to read it, but cannot own workflow elapsed state.
- `Ctrl/Cmd+Shift+R` maps idle to start and recording/paused to stop. `Ctrl/Cmd+Shift+P` maps recording to pause and paused to resume. Transition states are no-op.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| Duplicate action during a transition | Reject through the recording transition table |
| Provider drain exceeds two seconds | Disconnect, promote visible interim content, continue pause/stop |
| Resume Provider or pipeline fails | Return to `paused`; retain Session and existing archive |
| Retained source ended while paused | Mark invalid; do not complete the Session; prompt on resume |
| Retained mixed destination track is `live` | Preserve its strongly-owned producer graph; do not infer signal health from readyState alone |
| Replacement source selection is cancelled | Return to `paused` without resetting Session/archive |
| Archive resume fails after earlier PCM exists | Keep paused; never return a truncated archive as complete |
| Empty Session stops | Abort temporary archive and return `null` |
| Completed non-empty Session stops | Finalize archive, persist effective duration, return its ID |

### 5. Good / Base / Bad Cases

- Good: a WebM recorder delivers its terminal chunk before Provider drain, pause writes no PCM, resume creates a fresh recorder header, and final duration excludes the paused interval.
- Base: a text-only Provider times out during drain; visible partial text is promoted once and the Session remains resumable.
- Bad: a component resets elapsed time when state leaves `recording`, resume calls archive `begin`, ordinary Provider `final` ends drain, or device restart stays in `recording` while async resources are replaced.

### 6. Tests Required

- Recording timeline: multiple active segments and long pauses do not add paused milliseconds.
- Capture manager: WebM tail ordering/generation fence, PCM processor recreation, mixed graph ownership across pause/resume, explicit graph disconnect on final stop, invalid retained source, and replacement mixed source behavior.
- Provider session: delayed final delivery, ordinary final is non-terminal, bounded timeout, expected close error suppression, late epoch fencing, and timestamp offset exactly once.
- Transcript reducer: token/text/translation interim promotion, empty final preservation, multiple boundaries without markers or duplication.
- Archive IPC: idempotent begin, append across active segments, abort rejects late append, final WAV data length.
- Shortcut mapping: R/P actions for every runtime state and Electron fallback registration.
- Session completion: effective duration reaches repository and the actual completed ID is returned.

### 7. Wrong vs Correct

#### Wrong

```ts
setRecordingState('paused')
capture.pauseRecorder()
await provider.disconnect()
beginRecordingArchive({ sessionId })
```

This bypasses transition single-flight, drops asynchronous WebM tail data, removes the Provider finalization window, and truncates the existing PCM archive.

#### Correct

```ts
if (!transitionRecordingState('pausing')) return
archiveOutputEnabled = false
await capture.pauseCapture()
await pauseArchiveAndDrainQueue()
const result = await providerSession.drain()
freezeTranscriptBoundary(result.status !== 'finished')
pauseRecordingTimeline(pauseStartedAt)
transitionRecordingState('paused')
```

The orchestration layer owns ordering; resource services own their local generation fences and cleanup.

---

## Scenario: Live Provider Unexpected Disconnect Recovery

### 1. Scope / Trigger

Use this contract when changing realtime Provider WebSocket close handling, `ProviderSessionManager` error propagation, or recording-time reconnect behavior.

### 2. Signatures

```ts
ProviderSessionManager.reconnect(
  vendorId: ASRVendor,
  connectConfig: ProviderConfig,
  callbacks: ProviderSessionCallbacks,
  options: { epochOffsetMs?: number },
): Promise<ASRProvider>
```

### 3. Contracts

- Providers distinguish locally initiated close/drain from unexpected remote/network close.
- An unexpected close after establishment emits one diagnostic `CONNECTION_CLOSED` error; an expected lifecycle close emits no recording-level error.
- The recording orchestration layer, not the Provider, decides whether to reconnect or stop.
- Recording-time recovery is single-flight and reuses the locked Provider setup snapshot; it never creates a new Session or rereads mutable global Provider settings.
- Reconnect uses `getConnectionEpochOffset()` so connection-relative token timestamps remain session-relative.
- Realtime recovery pauses and recreates the Provider capture pipeline around the new connection. This is mandatory for WebM Providers because a new WebSocket must receive a fresh container initialization header; forwarding chunks from the old `MediaRecorder` generation creates a connected-but-undecodable session.
- Source-audio archive remains active during capture-pipeline and Provider recovery. Audio in the recovery window may be absent from live ASR, but must remain in the recording archive.
- A recording-time watchdog treats missing capture chunks as a stalled capture pipeline. It may also recover a Provider when audio is still being sent, the source is recently audible, prior results existed, and result progress has stopped beyond the bounded threshold. Natural silence must not trigger recovery.
- If reconnect fails, stop safely and surface the failure. Never continue recording indefinitely after live ASR has become unavailable.
- If recording leaves `recording` while reconnect is in flight, disconnect the newly established Provider instead of leaking it past stop/pause.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| User pause/stop closes Provider | Suppress close error; continue normal drain lifecycle |
| Established socket closes unexpectedly | Emit one error and begin single-flight reconnect |
| Duplicate error arrives during reconnect | Ignore duplicate recovery request |
| Reconnect succeeds while still recording | Continue the same Session and warn that live recognition resumed |
| Reconnect succeeds after recording started stopping | Disconnect the new Provider immediately |
| Reconnect fails | Report error, stop recording, preserve transcript and archive to the boundary |

### 5. Good / Base / Bad Cases

- Good: a one-hour meeting loses its socket briefly, reconnects with a new epoch, and later tokens continue in the same Session.
- Base: pause drains and closes the socket without triggering recovery.
- Bad: Provider sets `idle` on remote close while `sendAudio()` silently discards the next ninety minutes.

### 6. Tests Required

- Provider tests assert Soniox and Volc unexpected closes emit once and expected disconnects emit zero errors.
- Provider-session tests retain epoch fencing and timestamp offset behavior across reconnect.
- Recording orchestration tests should assert single-flight recovery, successful continuation, failure-to-stop fallback, and stop/reconnect race cleanup when hook-level test infrastructure is extended.
- Health detection tests must cover capture-chunk stalls, audible Provider-result stalls, and natural silence.

### 7. Wrong vs Correct

#### Wrong

```ts
ws.onclose = () => this.setState('idle')
if (!this.ws) return
```

#### Correct

```ts
if (!closeExpected) emitError(createError('CONNECTION_CLOSED', reason))
await providerSession.reconnect(vendorId, lockedConfig, callbacks, { epochOffsetMs })
```

Unexpected transport failure must become an explicit orchestration event rather than silent audio loss.

---

## Scenario: Task-Scoped Recognition Context

### 1. Scope / Trigger

Use this contract when changing meeting context, glossary behavior, Provider setup, file transcription, Session recognition metadata, or AI correction. Mutable settings are inputs to task creation, not live task state.

### 2. Signatures

```ts
resolveMeetingContextSnapshot(
  globalConfig: unknown,
  globalGlossary: unknown,
  override?: MeetingContextOverride,
): MeetingContextSnapshot

ProviderSessionManager.resolveSetup(
  vendorId: ASRVendor,
  settings: AppSettings,
  meetingContext?: MeetingContextSnapshot,
): ProviderSetup

createCorrectionConfigSnapshot(
  settings: AppSettings,
  meetingContext?: MeetingContextSnapshot,
): CorrectionConfigSnapshot
```

### 3. Contracts

- Resolve `inherit`, `override`, or `clear` exactly once when recording or file work starts.
- Persist normalized, credential-free `meetingContext` and `recognitionConfig` on the Session; do not increment IndexedDB for fields inside existing records.
- Pause/resume and device reconnect reuse the locked Provider setup. Intentional Provider/config hot-switches may create a new setup but retain the task's meeting-context snapshot.
- Automatic and historical correction use the Session snapshot. A persisted correction draft always uses its own `CorrectionConfigSnapshot`.
- Soniox receives only enabled glossary `target` values. AI receives separate mapping and candidate-term JSON data.
- Prompt reference data is delimiter-escaped, subordinate to the fixed Patch system contract, and capped by `MAX_CORRECTION_REFERENCE_CHARACTERS` before transcript regions are appended.
- Session/schema/backup normalizers whitelist snapshot fields and never persist API keys.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| Missing global context | Use default empty background/guidance; AI destination on, Soniox destination off |
| One-shot `clear` | Store an empty snapshot with both destinations disabled and no glossary |
| Invalid one-shot length or glossary conflict | Reject task start; do not silently clamp user input |
| Invalid legacy/import data | Normalize to safe values and surface diagnostics where available |
| Global settings change after task start | Active request, reconnect, and automatic correction remain unchanged |
| Old Session lacks snapshots | Load normally; correction falls back to current settings only because no historical snapshot exists |
| Snapshot contains unknown or credential-like fields | Drop them during schema normalization |

### 5. Good / Base / Bad Cases

- Good: a file task freezes context, global settings change while it runs, and the completed Session's automatic correction still uses the frozen values.
- Base: an old Session without context loads and remains usable.
- Bad: a reconnect calls `resolveMeetingContextSnapshot` from current settings, or automatic correction reads the current global glossary instead of `session.meetingContext`.

### 6. Tests Required

- Cover inherit/override/clear, Unicode budgets, target-only terms, deduplication, conflicts, and Soniox target projection.
- Assert Soniox realtime/async field isolation and credential-free recognition snapshots.
- Round-trip new and old Sessions and backups; assert serialized snapshots contain no credentials.
- Assert correction prompt order, delimiter escaping, aggregate reference budget, fixed system policy, and restored draft context.
- Exercise recording reconnect and file completion paths when changing snapshot plumbing.

### 7. Wrong vs Correct

#### Wrong

```ts
const setup = providerSession.resolveSetup(vendorId, useSettingsStore.getState().settings)
const correction = createCorrectionConfigSnapshot(useSettingsStore.getState().settings)
```

#### Correct

```ts
const meetingContext = resolveMeetingContextSnapshot(globalContext, glossary, oneShotOverride)
const setup = providerSession.resolveSetup(vendorId, settingsAtStart, meetingContext)
const correction = createCorrectionConfigSnapshot(currentAiCredentials, session.meetingContext)
```

---

## Scenario: Credential-Bound Correction Drafts and Streaming Transport

### 1. Scope / Trigger

Use this contract when changing saved AI endpoint credentials, correction retry/resume behavior, OpenAI-compatible streaming, request timeout policy, or correction progress UI.

### 2. Signatures

```ts
createCorrectionConfigSnapshot(settings, meetingContext?): CorrectionConfigSnapshot
isCorrectionConfigSnapshotCurrent(snapshot, settings): boolean
requestCorrectionShard({ snapshot, apiKey, signal, timeouts, onProgress }): Promise<CorrectionShardResponse>
```

`CorrectionConfigSnapshot` persists normalized `baseUrl`, resolved correction `model`, non-secret `credentialVersion`, `transport`, structured-output mode, and a non-credential `configIdentity`. It never persists the API key or a key-derived fingerprint.

### 3. Contracts

- Increment `credentialVersion` only when the normalized Base URL or actual API key changes. Prompt, glossary, export, model, and streaming changes do not increment it.
- Include model, credential version, transport, and structured-output mode in the Draft identity.
- A matching Retry preserves completed shards and retries failed shards only. A mismatching or legacy Draft receives a new `runId`, current snapshot, new shards, and empty candidate/rejection sets.
- Launch recovery must not automatically send a legacy or mismatching Draft to the current endpoint.
- Correction accepts JSON and SSE regardless of the requested transport. Reasoning activity resets idle timeout but is never appended to Patch JSON.
- HTTP 200 error envelopes are errors. `unauthorized_error`, invalid token, 401, and 403 are non-retryable `auth` failures.
- Timeout phases are first byte, response idle, and absolute limit. Transport progress is checkpointed through existing shard fields and fenced by `runId`, `attemptId`, and `draftRevision`.
- On the first shard's first-byte timeout, the single retry may use the main-window-only `ai-correction-recovery-fetch` IPC. The main process must use a dedicated non-default Electron Session, serialize recovery requests, enforce queue/body/response limits, preserve idle and absolute timeouts, and support cancellation. Never call `defaultSession.closeAllConnections()` because it can terminate realtime transcription WebSockets.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| URL or key changes | Increment credential version; old Draft becomes mismatched |
| Model, streaming, or structured output changes | Credential version unchanged; Draft identity changes |
| Legacy Draft lacks identity fields | Preserve during normalization; block automatic resume |
| SSE reasoning continues | Keep request alive; show thinking; do not alter Patch content |
| HTTP 200 unauthorized envelope | Stop all workers as `blocked-auth`; do not retry |
| No response activity | Persist timeout kind/duration/attempt and stop spinner |
| Renderer connection pool stalls before response headers | Retry once through the isolated recovery Session without touching default Session connections |

### 5. Good / Base / Bad Cases

- Good: endpoint B is saved after endpoint A failed; Retry creates a new run and sends every shard only to B.
- Base: unchanged saved configuration retries only the failed shard and preserves completed checkpoints.
- Bad: old Draft URL/model is combined with the current key, or reasoning text is concatenated into Patch JSON.

### 6. Tests Required

- Credential version normalization and change rules; snapshot contains no key or key-derived data.
- Matching partial Retry versus mismatching full rebuild with a new `runId`.
- Legacy schema round-trip and launch recovery block.
- JSON completion, SSE content, reasoning plus content, `[DONE]`, malformed SSE, and HTTP 200 error envelopes.
- Auth worker cancellation, progress checkpointing, timeout phases, and external abort.
- Isolated recovery dispatch, cancellation, idle-timeout classification, bounded request/response sizes, and no use of the default Session connection reset.

### 7. Wrong vs Correct

#### Wrong

```ts
requestCorrectionShard({ snapshot: oldDraft.config, apiKey: currentSettings.apiKey })
```

#### Correct

```ts
if (!isCorrectionConfigSnapshotCurrent(oldDraft.config, currentSettings)) {
  rebuildDraftWithNewRunId(createCorrectionConfigSnapshot(currentSettings))
}
```

## Scenario: Canonical Manual Corrections And Replacement Runs

### 1. Scope / Trigger

Use this contract for manual correction, rejected-intent recovery, Review input saving, publication state changes, redetection and correction-workspace layout.

### 2. Signatures

```ts
saveSessionManualCorrection(sessionId, edit: ManualCorrectionEdit, expected: CorrectionEditExpectation): Promise<void>
changeSessionCorrectionPatchState(sessionId, patchId, state, expected, confirmedConflictIds?): Promise<void>
sessionRepository.checkpointCorrection(sessionId, correctionOrQueuedFactory): Promise<TranscriptSession[]>
```

### 3. Contracts

#### Data And Durability

- `ResolvedCorrectionPatch` optional metadata is `origin`, `locationVerified`, bounded/whitelisted `modelIntent` and `recoveredFromPatchId`. Old missing origin means historical AI; missing verification never makes rejected coordinates reliable. Do not increment IndexedDB/schema/backup versions for optional record fields.
- Rejecting before resolution records `locationVerified: false` and retains bounded model intent. Conflict rejection retains the true resolved range and verification. Published results optionally retain the safety limits used for validation; historical missing limits use defaults, never unrestricted numbers.
- Canonical `session.transcript` is immutable. Manual selections/search matches/insertions use its UTF-16 ranges and whole-grapheme boundaries, not corrected DOM coordinates. Repeated matches require explicit choice. Historical/unverified placeholder ranges must not be preselected.
- Validate exact source hash/text, integer ranges, operation consistency, Unicode boundaries, per-item/per-shard limits, cumulative edits and net length. Verified recovery and existing edit ranges recheck original hash/text. A rejected intent cannot be directly toggled applied.
- Same-range manual editing updates one nonrejected item. Recovering a rejection retains the rejection and adds one linked manual item; a second recovery of the same rejection is refused, even if its linked item was reverted.
- Preview the prospective set with overlaps reverted and validate it before asking for conflict confirmation. Require every current overlap ID; atomically revert those items and save the new item only after confirmation. There is no safety bypass or force flag.
- Manual mutation is serialized through the correction queue and the repository record queue. The queued factory reads repository authority and validates expected target, run/publication ID, revision and source hash inside that queue. Recording/interrupted/busy/nonready/stale/Legacy-only targets refuse editing. Queue failure must not poison a retry.
- Strict IndexedDB completion precedes repository cache/store updates. Ordinary queued metadata saves consume the committed correction, not an old snapshot or a pending failed checkpoint. Disk failure leaves the form/error visible and the previous publication unchanged.
- Review edits/new manual items remain draft candidates and increment draft revision. `correctionReviewStore` still holds only temporary selections and unsaved input; it is not persistence/backup. Blur and prepublication saves share a serialized input-save queue; save each dirty field before applying.
- Published edits create a new publication ID/revision/output hash/text/stats and use the existing Markdown coordinator. Do not modify old summary provenance to disguise an outdated source. A valid publication's compatibility `correctedText` must not synthesize a new Legacy result on reload.

#### Replacement And Rendering

- All user redetection entrances, including Legacy and mismatching retry/resume rebuild, pass one confirmation handler. Cancel creates no request/draft. Matching resume/retry keeps its existing semantics.
- Freeze the confirmation's old run/publication identity and revision; refuse a stale confirmation. A confirmed replacement run uses original transcript only. Preserve the previous published/Legacy result during detection, failure, pause, abandonment and late responses. Replace the entire set only on successful publication; never merge old manual/reverted items automatically.
- Keep previous results visible read-only while a new draft exists. Manual-only correction requires no AI configuration; Legacy-only results must establish real patches through confirmed detection before item editing.
- Long-running start promises must not block pause/abandon controls. Use independent control pending exclusion; keep double start/publication/save protection.
- Place the reusable workspace before projected body. Show applied/reverted/rejected counts and filters; Review uses selected/unselected candidate equivalents. Use auto-fit bounded cards, a 288px independently scrolling compact list and an explicit expanded list. List scrolling must not scroll filters away. Long text wraps, including degraded/plain diff and speaker projection.
- The correction body uses `projectSessionCorrection` and its projected/degraded/unaligned paths. Keep unknown speakers, timestamps and Markdown fallback behavior. Never render a parallel manually assembled corrected transcript.
- Editor and conflict dialogs use the existing focus trap/restore/Escape behavior. Errors retain the form, duplicate save is blocked, and cancelled confirmation changes nothing.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|-----------|-------------------|
| Hash/range text differs from canonical source | `source-hash-mismatch` / `source-mismatch`; no write |
| Noninteger/out-of-range coordinates | `invalid-source-range`; no write |
| Selection splits a grapheme | `invalid-unicode-boundary`; keep form/input |
| Text, count, aggregate or net change exceeds limits | Corresponding safety-limit error; no conflict bypass |
| New edit overlaps active items | `CorrectionConflictError` with current items; confirmation required |
| Conflict dialog cancelled | Publication and revision remain unchanged |
| Old run/publication ID or revision | `correction-revision-mismatch`; reopen form |
| Recording/interrupted/in-flight/nonready target | Refuse manual edit; preserve current result |
| Direct rejected-item toggle | `patch-not-editable`; use linked manual recovery |
| Second recovery of the same rejection | `rejected-patch-already-recovered`; edit linked item |
| Strict transaction fails | Reject action; store/cache and old publication remain unchanged; retry works |
| Replacement cancelled/fails/pauses/is abandoned | Preserve previous publication; late response cannot replace it |
| Replacement publication succeeds | New entire set replaces old set, including manual/reverted items |

### 5. Good/Base/Bad Cases

- Good: a rejected intent has multiple original matches; the user chooses one, confirms an overlap and one durable mutation retains rejection evidence while reverting the conflicting item.
- Base: AI is unconfigured; the user adds a manual canonical correction, saves it and sees it restored after reload/backup import.
- Bad: store corrected-DOM offsets, trust historical rejected zero ranges, persist temporary Review state as formal corrections, or rewrite summary provenance to hide changed source.

### 6. Tests Required

- `correctionPatch.test.ts`, `sessionStore.test.ts`, schema/backup and repository durability tests cover rejected provenance, repeated/Unicode ranges, operations, aggregate safety, conflict cancellation/atomic retry, failed persistence, stale revision/run/hash and queue recovery.
- `reviewPhase4.test.ts` preserves existing search/filter/list/drawer/Review-input guarantees. `manualCorrectionUi.test.ts` drives the real isolated built Electron renderer, reads committed IndexedDB and stubs transport with synthetic data. Cover manual-only add/edit/revert/reapply, insertion/deletion, rejection recovery, overlapping restore and every replacement lifecycle.
- Test 1440/1024/768/375 widths in light/dark themes, 120 items including a long correction, long folder names/counts/menu, actual native folder drag, preference restoration/clamping, opaque mobile drawers and bounded left-aligned settings. Wait for measured layouts/transition completion, not arbitrary sleeps, before geometry assertions.
- Optional `DELIVE_REVIEW_CAPTURE_DIR` produces screenshots and acceptance metrics. Any old-width comparison is explicitly a width simulation, not an old-version screenshot. It must not modify stored preferences or user data.

### 7. Wrong vs Correct

Wrong: mutate `published.patches` optimistically or save a previously assembled whole correction outside the repository queue; a stale editor can overwrite new results and a failed write can look successful.

Correct: capture the canonical source range and expectation when opening the form, then let the queued factory fence the current run/revision/hash and perform strict persistence before publication.

```ts
await saveSessionManualCorrection(session.id, {
  sourceStart: originalSelection.start,
  sourceEnd: originalSelection.end,
  sourceText: originalTranscript.slice(originalSelection.start, originalSelection.end),
  replacement,
  confirmedConflictIds,
}, expectedAtEditorOpen)
```

## Core Workflow UX Boundaries

- `useASR.startRecording` resolves `true` only after native source selection, provider connection and capture start. Cancellation, validation, state-transition rejection and connection/capture failure resolve `false`. RecordingControls consumes a one-shot override only on `true` and only if it is still the same override; a newer edit must survive an older startup acknowledgement.
- Use provider metadata through `buildProviderConnectConfig` and `isProviderConfigured` for file-transcription readiness, matching recording/settings validation. Never infer readiness from a field named `apiKey`; local providers may need no key.
- Transcript projection retains every nonempty segment in original order, including unknown speakers. Unknown labels do not change stored speaker identities. Timestamps without a real playback/seek handler are text, not buttons.
- Chat and transcript-side questions share session-wide pending exclusion, enforced in sessionStore as well as both UI entry points. Provide a route to the active thread and retain its ID when continuing in Chat. Quick questions fill the draft only; show an explicit unsent status. Composition state, native `isComposing` and key code 229 guard Enter; Shift+Enter remains a newline.
- Confirm thread deletion and correction abandonment before mutation. Cancel, Escape and backdrop dismissal must not mutate state; pending actions block repeat submission and dismissal. Abandon confirmation is tied to the original run ID. Backup labels state actual Cancel/Merge/Overwrite effects; overwrite is visually destructive, and Escape must not also close the containing settings page.
- Renderer evidence uses the built UI and isolated data. DOM bounds alone do not validate paint: optional screenshots need an unthrottled painted window and completed animations. Synthetic composition events verify handlers, not OS IME candidate semantics; record native/manual gaps separately.
