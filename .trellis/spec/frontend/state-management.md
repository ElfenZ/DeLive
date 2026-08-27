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
- Corrected Markdown auto-export runs only as the final step of the full workflow. Manual export and automatic export must share `buildCorrectedTranscriptMarkdown`; components and workflow branches must not rebuild the document independently.
- Arbitrary user-selected folders are accessed only through `pickDirectoryPath`, `writeAutoExportFile`, and `revealExportedFile`. Do not expand the general `isPathAllowed` whitelist for this feature.
- `writeAutoExportFile` accepts an absolute existing directory, a safe basename, and UTF-8 content. It creates files exclusively and appends ` (n)` on collisions.
- An export retry reads the latest saved directory and latest Session, then reruns only `step: 'export'`. A persisted `exportPath` makes recovery idempotent and must never create another file.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| AI disabled or correction/briefing model missing | Persist workflow `error` at `correction`; do not start correction |
| Correction fails or is abandoned | Persist workflow `error`; do not brief or rename |
| Review has proposed patches | Persist `waiting-review`; resume only after publication |
| Briefing fails | Keep published correction, persist workflow `error` at `briefing`, keep title |
| Briefing has no non-empty title suggestion | Keep briefing, persist workflow `error` at `title`, keep title |
| Current title differs from `titleAtStart` | Preserve manual title and complete normally |
| Auto-export enabled without Electron support or a selected directory | Fail configuration before correction starts |
| Export directory becomes invalid or writing fails | Keep correction, briefing, and title; persist `error` at `export` |
| Persisted export workflow already has `exportPath` | Complete without writing another file |
| Persisted `completed` workflow is not at `title` or `export` | Reject the workflow during schema normalization |
| Persisted `waiting-review` is not Review correction | Reject the workflow during schema normalization |

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
await writeAutoExportFile({ directory, fileName, content })
```

The workflow runner reloads the latest Session at every boundary, validates provenance before reusing results, and applies a suggested title only when the title still matches the start snapshot.

---

## When to Use Global State

Use Zustand plus Session persistence when work spans components, navigation, or application restarts. Keep transient form drafts and visual toggles local unless another surface must observe them.

## Persistence Boundary

`sessionRepository` owns normalized in-memory Session cache updates and IndexedDB writes. Components call store actions rather than repository methods directly.

## Common Mistakes

- Treating `ready-for-review` as a published correction.
- Resuming marked queued correction drafts through both generic and workflow runners.
- Reusing a successful AI artifact solely by timestamp without validating source provenance.
- Downgrading `running` in the schema normalizer, which also runs during ordinary writes.

---

## Scenario: Single Active AI Endpoint Model State

### 1. Scope / Trigger

Use this contract when changing the AI post-process Base URL, API key, model discovery, model selection, feature assignment, or OpenAI-compatible request model resolution.

### 2. Signatures

```ts
invalidateAiEndpointModels(): Partial<AiPostProcessConfig>
reconcileAiEndpointModels(
  config: AiPostProcessConfig,
  availableModels: string[],
): Partial<AiPostProcessConfig>
resolveModelForFeature(config: AiPostProcessConfig, feature: AiFeatureKey): string
```

### 3. Contracts

- The app has one active OpenAI-compatible endpoint; normalized `baseUrl` is the boundary for endpoint-derived model state.
- Changing Base URL clears `availableModels`, `selectedModels`, `defaultModel`, legacy `model`, and `modelAssignment`, but preserves prompts, glossary, automation, export, and correction settings.
- A successful `/models` refresh reconciles every derived model field through one shared helper. Components must not implement private cleanup rules.
- When a non-empty `availableModels` list exists, request-time model resolution accepts only candidates in that list. Empty lists preserve legacy/manual model compatibility.
- Saved URL, credential, and resolved model must come from the same current `AiPostProcessConfig`; never retain an old endpoint model ID with new endpoint credentials.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| Base URL changes | Immediately invalidate all endpoint-derived model fields |
| Refreshed list retains selected/default model | Preserve the valid values |
| No previous selection exists in refreshed list | Select the first returned model as safe default |
| Feature assignment is absent from selected refreshed models | Drop the assignment and fall back to a valid default |
| Known model list contains no valid candidate | Resolve an empty model and fail configuration before request |

### 5. Good / Base / Bad Cases

- Good: URL changes, old assignments disappear, refresh selects a new default, and all features resolve against the new list.
- Base: an old/manual config has no fetched list and continues resolving its legacy model.
- Bad: refresh updates only `availableModels` while feature dropdowns and persisted assignments still reference the old endpoint.

### 6. Tests Required

- Assert endpoint invalidation clears every model-derived field and no unrelated field.
- Assert reconciliation preserves same-name models, drops stale assignments, and creates a safe default.
- Assert request-time resolution rejects stale candidates when a current non-empty model list is known.

### 7. Wrong vs Correct

#### Wrong

```ts
updateAiPostProcessConfig({ availableModels: models })
```

#### Correct

```ts
updateAiPostProcessConfig(reconcileAiEndpointModels(config, models))
```

The shared reconciliation boundary prevents UI, persistence, and request behavior from diverging.

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
