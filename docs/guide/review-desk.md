# AI Review Desk

The Review Desk is a full-page workspace for exploring completed transcription sessions. It opens from the History view and provides six tabs with an animated sliding tab bar: **Transcript**, **AI Correction**, **Overview**, **AI Analysis**, **Chat**, and **Mind Map**.

## Overview Tab

Generates an AI briefing from the transcript using an OpenAI-compatible chat completions endpoint.

**Output includes:**
- **Summary** — concise overview of the session
- **Action items** — extracted tasks and next steps
- **Keywords** — key terms from the discussion
- **Chapters** — logical sections with optional timestamps
- **Title suggestion** — AI-generated session title
- **Tag suggestions** — relevant tags for organization

One-click **Apply** buttons let you accept the suggested title and tags directly.

![AI Overview](/images/screenshot-ai-overview.png)

### Configuration

AI features require an OpenAI-compatible endpoint configured in **Settings > General > AI Post-Process**:

- **Base URL** — defaults to `http://127.0.0.1:11434/v1` (Ollama)
- **Model** — the model to use for generation
- **API Key** — optional, depending on the endpoint
- **Prompt Language** — `zh` (Chinese) or `en` (English)

## Transcript Tab

Displays the full transcript with:

- Timestamped segments in a left gutter
- Color-coded speaker badges (when diarization is available)
- Consecutive same-speaker merging
- Hover highlight for individual segments
- Optional translated text blocks

**Export formats:** TXT, Markdown, SRT, VTT

![Transcript Detail](/images/screenshot-transcript-detail.png)

## AI Correction Tab

Provides two modes for correcting transcription errors:

- **Quick Fix** — detects local ASR edit intents in shards and automatically applies patches that pass local hard validation
- **Review & Fix** — detects validated patch candidates with all selected by default; use Select all / Select none to adjust the set, then confirm to apply locally without another model call

The original transcript never changes. Corrected output is deterministically materialized from the original and active patches, with a real diff, per-patch revert/restore, and restore-all. Corrected results and corrected TXT/Markdown exports preserve original speaker labels and timestamps. Added text whose ownership cannot be determined safely, such as cross-speaker replacements or boundary insertions, appears in a separate `S? / Speaker uncertain` block instead of being assigned to a speaker. If stored speaker segments no longer match the full transcript, the page and exports preserve those original segments first, then append the complete correction under a clear “could not be safely segmented” warning. Long transcripts use non-overlapping editable shards and publish only after every shard succeeds. Failure or pause preserves the previous published result. SRT/VTT continue to use original ASR data.

### Smart Text-Source Selection

Once a correction is available, downstream AI features (Overview, Chat, Mind Map, AI Analysis) automatically use the corrected text. The preference is configurable in **Settings > AI**:

| Option | Behavior |
|--------|----------|
| **Auto** *(default)* | Use corrected text when available, fall back to original |
| **Always Original** | Always use the original transcript |
| **Always Corrected** | Use a published correction when available, otherwise fall back to original |

A real-time banner on each tab indicates which text source is currently in use.

![AI Correction](/images/screenshot-ai-correction.png)

## Chat Tab

Multi-thread AI conversation about the transcript:

- GFM Markdown rendering with syntax-highlighted code blocks
- One-click code copy
- User/AI avatars
- Hover actions (Copy, Regenerate)
- Animated thinking-dots indicator
- Auto-resizing text composer (Enter to send)
- Floating scroll-to-bottom button
- Per-thread delete

Each question is sent with the transcript context and up to 4 previous Q&A turns for conversation continuity. Answers include optional `citations` referencing specific quotes from the transcript.

![AI Chat](/images/screenshot-ai-chat.png)

## Mind Map Tab

Generate a Markmap-compatible Markdown mind map from the session:

- Live Markdown editor
- Interactive Markmap visualization
- Fullscreen portal mode
- Export to SVG or PNG

The mind map prompt leverages the AI summary, action items, and keywords when available.

![Mind Map](/images/screenshot-mindmap.png)

## Keyboard Navigation

| Shortcut | Action |
|----------|--------|
| `←` / `→` | Switch tabs |
| `Ctrl/Cmd + 1–6` | Jump to specific tab |
| `Escape` | Close the review desk |
