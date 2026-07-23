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
  step: 'correction' | 'briefing' | 'title'
  correctionMode: 'quick' | 'review'
  titleAtStart: string
  startedAt: number
  updatedAt: number
  completedAt?: number
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

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| AI disabled or correction/briefing model missing | Persist workflow `error` at `correction`; do not start correction |
| Correction fails or is abandoned | Persist workflow `error`; do not brief or rename |
| Review has proposed patches | Persist `waiting-review`; resume only after publication |
| Briefing fails | Keep published correction, persist workflow `error` at `briefing`, keep title |
| Briefing has no non-empty title suggestion | Keep briefing, persist workflow `error` at `title`, keep title |
| Current title differs from `titleAtStart` | Preserve manual title and complete normally |
| Persisted `completed` workflow is not at `title` | Reject the workflow during schema normalization |
| Persisted `waiting-review` is not Review correction | Reject the workflow during schema normalization |

### 5. Good / Base / Bad Cases

- Good: correction publication is checkpointed, workflow advances to briefing, and recovery reuses a current persisted briefing without another model request.
- Base: old sessions have no workflow field and load normally without creating new work.
- Bad: a component chains correction and briefing in an effect, or launch recovery resumes both the generic queued draft runner and the workflow runner for the same Session.

### 6. Tests Required

- Quick order: publish correction, brief the published source, conditionally apply title, complete.
- Review: wait with candidates, auto-continue with zero candidates, continue after local apply.
- Duplicate completion notifications create one correction/briefing chain.
- Launch: resume `queued`/interrupted `running`; skip `waiting-review`, `error`, and `completed`.
- Crash window: a persisted current briefing at the `briefing` step is not requested again.
- Failure boundaries: configuration, correction, abandon, briefing, and empty-title cases stop at the correct step.
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
