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
