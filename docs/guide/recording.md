# Recording

## Typical Flow

1. Open Settings and choose a provider (see [ASR Providers](./providers) for details).
2. Fill in credentials (see [API Key Guide](./api-keys)), then run **Test Config**.
3. Click **Start Recording** in the Live view.
4. Pick a screen or window — make sure **audio sharing** is enabled.
5. Watch partial and final text update in the main window and the optional floating caption overlay.
6. Click **Stop Recording**. The session is saved and available in History.

![Live Transcription](/images/screenshot-live.png)

## Audio Capture

DeLive captures **system audio** via `getDisplayMedia` with loopback audio. The capture pipeline automatically selects the right audio path based on the provider:

| Audio Mode | Format | Used By |
|-----------|--------|---------|
| `MediaRecorder` | WebM/Opus chunks | Soniox, Local OpenAI-compatible |
| `AudioWorklet` PCM16 | 16 kHz mono raw PCM | Volcengine, Groq, SiliconFlow, whisper.cpp |

::: info
You must select a screen or window to share. DeLive captures the audio from whatever source you choose — browser tabs, meeting apps, media players, or any other playback source.
:::

## Session Lifecycle

Sessions go through these states:

```
idle → starting → recording → pausing → paused → resuming → recording
                           ↓                        ↓
                        stopping ←──────────────────┘
                           ↓
                       completed
```

- **Draft sessions** are created when recording starts and autosaved every 1.2 seconds.
- **Interrupted sessions** are detected on next launch and can be recovered or dismissed.
- **Completed sessions** appear in the History list for review, AI processing, and export.

## Pause and Resume

Pausing keeps the current session and its selected capture authorization, but stops the active transcription and audio-delivery pipeline. While paused:

- No new audio is saved locally or uploaded to a transcription provider.
- The recording timer and saved session duration are frozen; paused time is excluded from audio files, transcript timestamps, and the final duration.
- Existing transcript content remains intact. Pause and resume do not add markers to the transcript or exported files.
- Your operating system may continue to show screen-share or microphone permission indicators because DeLive retains the capture authorization for a fast resume. Those indicators do not mean that paused audio is being saved or uploaded.

When the original screen, window, or audio source is still valid, resume continues with the same source and session. If it became unavailable while paused, DeLive opens the source picker on resume. Canceling the picker leaves the current session paused so it can be resumed again or stopped and saved.

Pausing and resuming do not create or end a session. The same session ID is retained, and no `session-start` or `session-end` live event is emitted for either transition.

## Device Changes

If your audio device changes during recording (e.g. headphones plugged in), DeLive handles it based on the provider's `captureRestartStrategy`:

- **`reconnect-session`** (Soniox) — disconnects the provider and reconnects with a fresh session
- **`reuse-session`** (all others) — restarts only the capture pipeline, keeping the provider connection alive

## Keyboard Shortcut

| Shortcut | Function |
|----------|----------|
| `Ctrl+Shift+D` / `Cmd+Shift+D` | Show or hide the main window |
| `Ctrl+Shift+R` / `Cmd+Shift+R` | Start recording when idle; stop the current recording or paused session |
| `Ctrl+Shift+P` / `Cmd+Shift+P` | Pause an active recording or resume a paused session |

If a primary global shortcut is unavailable, DeLive registers its `Ctrl+Alt` / `Cmd+Alt` equivalent instead. Pause and resume use `Ctrl+Alt+P` / `Cmd+Alt+P`; recording uses `Ctrl+Alt+R` / `Cmd+Alt+R`.
