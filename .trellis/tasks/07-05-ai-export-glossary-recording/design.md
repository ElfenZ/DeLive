# Design

## Architecture

This task spans the frontend review UI, settings UI, AI correction service prompts, session state/persistence, recording capture, and Electron media archive support. Keep each change near the existing owner:

- Exports: extend `frontend/src/utils/storageUtils.ts` and wire actions in `frontend/src/components/review/SessionHeader.tsx`.
- Glossary settings: extend shared types/defaults and edit through `AiPostProcessPanel.tsx` using the existing staged settings flow.
- AI prompts: normalize glossary entries inside `frontend/src/services/aiCorrection.ts` and inject them into detect/quick/review-detect prompts only.
- Review editing: update `CorrectionTab.tsx` local issue state so edited suggestions flow into `startSessionReviewCorrection` unchanged.
- Auto detection: add a store/service helper that performs eligibility checks and calls existing `detectSessionCorrectionIssues(sessionId)` after session persistence.
- Recording source coverage: refactor `CaptureManager` source selection so microphone fallback is possible without weakening system-audio behavior.
- Source archive: record the final stream sent to transcription and write finalized media to an app-managed directory through Electron IPC when needed.
- Source metadata/UI: extend session source metadata with optional artifact fields and expose a reveal/open action when the artifact path exists.

## Data Contracts

Add optional settings data:

```ts
interface AiGlossaryEntry {
  id: string;
  source: string;
  target: string;
  note?: string;
  enabled?: boolean;
}

interface AiPostProcessConfig {
  glossary?: AiGlossaryEntry[];
  autoCorrectionDetection?: boolean;
}
```

Add optional source metadata without requiring migration:

```ts
type CaptureAudioSource = 'system' | 'microphone' | 'mixed';

interface TranscriptSourceMeta {
  sourceKind?: 'recording-audio' | 'uploaded-audio';
  audioPath?: string;
  audioMimeType?: string;
  audioFileName?: string;
  audioSize?: number;
  captureAudioSource?: CaptureAudioSource;
}
```

All readers must treat missing optional fields as defaults (`[]`, `false`, or no source artifact).

## Prompt Behavior

Glossary entries are model guidance only. Normalize by trimming source/target/note, requiring source and target, filtering disabled entries, and deduplicating normalized `source -> target` pairs. Detection prompts should ask the model to prioritize exact-source glossary mismatches. Quick correction prompts may apply glossary guidance only when the wrong form clearly appears. Review apply remains driven only by accepted issues.

## Recording Behavior

Capture source selection should follow this order:

1. Shared/system audio plus microphone when both are available and microphone is enabled.
2. Shared/system audio only when microphone is disabled or unavailable.
3. Microphone-only when shared/system audio is unavailable but microphone is enabled and available.
4. Fail only when neither shared/system audio nor microphone is available.

The archived recording must represent the final mixed stream sent to transcription. Archive finalization must be non-blocking for transcript completion; failures should surface through source metadata/UI without losing the transcript.

## Compatibility

No database migration is required. Settings and session metadata changes are optional and must survive normalization without breaking older sessions. Uploaded file behavior remains unchanged except for code paths needed to trigger optional auto correction detection.

## Rollback

Each stage should remain independently reversible: export helpers/menu wiring, glossary prompt injection, review editing, auto detection trigger, capture fallback, media archive IPC, and source metadata/UI. Avoid broad refactors that couple these areas unnecessarily.
