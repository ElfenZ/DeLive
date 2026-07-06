# AI Export Glossary Correction Recording

## Goal

Add practical export support for AI-generated analysis/summary, introduce a global high-frequency glossary for AI correction prompts, make AI correction review suggestions manually editable, optionally run AI correction detection after transcription completes, and preserve DeLive-recorded source audio for later re-transcription workflows.

## Background

- Existing transcript and AI correction exports live in `frontend/src/components/review/SessionHeader.tsx` and use browser `Blob` downloads.
- Raw transcript TXT/Markdown helpers live in `frontend/src/utils/storageUtils.ts`.
- AI analysis/briefing results are stored on `TranscriptSession.postProcess` and `frontend/src/utils/transcriptState.ts` already exposes `hasPostProcessContent(postProcess)`.
- Mind maps (`TranscriptSession.mindMap.markdown`) and AI Q&A history (`TranscriptSession.askHistory`) are separate features and are not part of analysis export.
- AI correction prompts are centralized in `frontend/src/services/aiCorrection.ts`; correction prompts currently do not include a user-defined glossary.
- AI correction review UI in `frontend/src/components/review/CorrectionTab.tsx` stores detection results in local issue state and currently supports accept/reject flows but not editing suggestions.
- AI post-process settings are staged in `ApiKeyConfig.tsx` / `AiPostProcessPanel.tsx` and persisted only when the user clicks Save.
- Default AI settings come from `getDefaultSettings()` in `frontend/src/utils/storageShared.ts`; readers must remain safe for existing settings without new fields.
- Completed file transcription sessions are persisted from `useFileTranscription.ts`.
- DeLive recording uses `CaptureManager`; current display-audio capture requires shared/system audio and does not support microphone-only fallback.
- Current session persistence has no source audio artifact metadata.
- Electron exposes some file/path helpers, but not a complete source-audio archive/reveal API.

## Requirements

- Add AI analysis TXT and Markdown exports to the existing session export menu.
- Show analysis export actions only when `postProcess.status === 'success'` and useful post-process content exists.
- Analysis exports must include available summary, action items, keywords, chapters, title/tag suggestions, and useful metadata, while omitting empty sections.
- Do not include mind map Markdown or AI Q&A history in analysis exports.
- Add a global AI correction glossary under AI settings with entries shaped as `id`, `source`, `target`, optional `note`, and `enabled`.
- Glossary entries are prompt guidance only; do not implement deterministic transcript string replacement.
- Existing settings without glossary fields must load as an empty glossary.
- AI correction detection, quick correction, and review detection prompts must include enabled, non-empty glossary entries when present.
- Review apply must continue applying only accepted review issues; it must not silently apply all glossary entries.
- Make review-mode correction suggestions editable while keeping `originalText` read-only.
- Applying accepted review issues must use edited `suggestedText` values and must not silently apply empty suggestions.
- Add an AI setting for automatic correction detection after transcript session completion.
- Automatic correction detection must only detect/review issues, not apply corrected text automatically.
- Automatic correction detection should run best-effort after completed recording sessions and completed file transcription sessions are persisted.
- Recording capture must support system/shared-source audio only, mixed shared-source plus microphone, and microphone-only fallback when shared audio is unavailable.
- DeLive-recorded sessions must persist a source audio artifact representing the same final stream sent to transcription.
- Add optional source audio metadata to sessions and preserve it during schema normalization.
- Add UI affordance to reveal/open the recorded source audio artifact location.
- Uploaded audio files must not be copied into the app-managed archive in this pass.
- Uploaded-video audio extraction, full re-transcription/reset UI, provider-native dictionary parameters, and global VAD controls are out of scope.

## Acceptance Criteria

- [ ] A completed AI analysis/briefing can be exported as `.txt` from the session export menu.
- [ ] A completed AI analysis/briefing can be exported as `.md` from the session export menu.
- [ ] Exported AI analysis contains available `postProcess` fields without empty headings.
- [ ] Analysis export menu items are hidden when AI analysis has not succeeded or contains no useful fields.
- [ ] Exported AI analysis excludes mind map Markdown and AI Q&A history.
- [ ] Existing raw transcript TXT/Markdown, SRT/VTT, and AI correction TXT/Markdown exports still work.
- [ ] Users can manage a global AI correction glossary in AI settings using the existing staged Save workflow.
- [ ] Existing settings without a glossary field load without errors and behave as an empty glossary.
- [ ] AI correction requests include enabled, non-empty glossary entries in prompts when present.
- [ ] Disabled, duplicate, or empty glossary entries are not sent to the model.
- [ ] AI correction review mode allows editing an AI-proposed replacement before applying corrections.
- [ ] Review editing keeps `originalText` read-only and only edits `suggestedText`.
- [ ] Edited `suggestedText` is sent to the review apply prompt and stored on session correction issue state.
- [ ] Empty edited suggestions cannot be applied silently.
- [ ] When automatic AI correction detection is enabled, completed recording sessions and completed file transcription sessions start detection after persistence.
- [ ] Automatic AI correction detection does not apply corrected text automatically.
- [ ] When automatic AI correction detection is disabled, completed sessions keep current behavior.
- [ ] DeLive recording can proceed with system/shared-source audio only.
- [ ] DeLive recording can proceed with mixed system/shared-source plus microphone audio.
- [ ] DeLive recording can proceed with microphone-only audio when shared/system audio is unavailable but microphone is enabled and available.
- [ ] DeLive recordings produce and persist a source audio artifact linked from the session.
- [ ] Saved recording audio represents the same final audio stream sent to transcription.
- [ ] Sessions with linked source audio expose a button to open the source folder or reveal the file.
- [ ] Uploaded audio files are not copied into DeLive's media archive.
- [ ] Uploaded-video audio extraction is not implemented and existing video upload behavior is not regressed.
- [ ] Existing sessions without source audio metadata still load and render normally.
- [ ] No provider transcription API receives undocumented glossary or VAD parameters as part of this feature.

## Out Of Scope

- Uploaded-video audio extraction and video-derived audio preservation.
- Full re-transcription/reset flow from archived audio.
- Provider-native dictionary/vocabulary parameters.
- Global VAD controls.
