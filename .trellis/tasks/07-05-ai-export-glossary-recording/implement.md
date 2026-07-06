# Implementation Plan

## Checklist

- [x] Add AI analysis TXT/Markdown formatter/export helpers in `frontend/src/utils/storageUtils.ts`.
- [x] Wire analysis export actions into `frontend/src/components/review/SessionHeader.tsx` behind successful useful `postProcess` content.
- [x] Extend AI post-process types/default settings with glossary and automatic correction detection fields.
- [x] Add glossary management and auto-detection toggle to `AiPostProcessPanel.tsx` using the existing staged Save workflow.
- [x] Normalize and inject enabled glossary entries into AI correction detect, quick correction, and review-detect prompts.
- [x] Make correction review suggestions editable in `CorrectionTab.tsx`, block empty accepted suggestions, and preserve edited values through apply.
- [x] Add an auto correction detection helper with eligibility checks and call it after completed recording and completed file transcription persistence.
- [x] Refactor `CaptureManager` capture-source selection to support system-only, mixed, and microphone-only fallback.
- [x] Extend session source metadata/schema normalization for optional audio artifact fields and capture audio source.
- [x] Add Electron IPC/preload APIs for app-managed source audio archive writing and revealing/opening the source artifact location.
- [x] Preserve the final DeLive recording stream as a source audio artifact and attach metadata to completed recording sessions.
- [x] Add review/header UI affordance to reveal/open source audio artifact when available.
- [x] Keep uploaded audio/video behavior scoped: no uploaded-audio copy and no uploaded-video extraction.

## Validation

- Add or update focused tests for AI analysis formatters/export eligibility.
- Add or update `aiCorrection` tests for glossary prompt inclusion, disabled/empty filtering, dedupe, and review apply behavior.
- Add focused correction review tests if the current component test setup supports it cheaply.
- Add auto detection tests for enabled/configured sessions, disabled sessions, and sessions with existing/in-flight correction.
- Add capture manager tests or mocks for system-only, mixed, microphone-only fallback, and neither-source failure.
- Add schema tests showing source audio metadata survives normalization and older sessions remain valid.
- Add media archive tests where practical for path generation, path validation, and missing-path failures.
- Run `cd frontend && npm run test -- aiCorrection aiPostProcess storageUtils sessionSchema sessionStore captureManager` if available.
- Run `npm run test:frontend`.
- Run `npm run build:electron`.
- Run `npm run build` if IPC/package changes are significant.

## Risk Notes

- Prompt-based glossary behavior depends on model compliance and is intentionally safer than deterministic replacement.
- Recording archive persistence increases disk usage and privacy sensitivity; UI should expose the artifact without adding cleanup/retention policy in this pass.
- Media archive finalization must not block transcript/session completion.
- Capture fallback must preserve current successful system-audio behavior and warning behavior when microphone capture fails.
