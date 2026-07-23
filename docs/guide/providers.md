# ASR Providers

DeLive supports twelve ASR backends through a unified provider registry. Each provider implements a common contract but uses different transport and audio processing strategies.

> **Need an API key?** See the [API Key Guide](./api-keys) for step-by-step instructions on obtaining keys for each provider.

## Provider Comparison

| Provider | Type | Transport | Audio | Streaming | Translation | Diarization | File |
|----------|------|-----------|-------|-----------|-------------|-------------|------|
| Soniox V5 | Cloud | WebSocket | MediaRecorder (WebM/Opus) | Yes | Yes | Yes | Yes |
| Volcengine | Cloud | WebSocket (via proxy) | AudioWorklet (PCM16) | Yes | No | Best effort | Yes |
| ElevenLabs | Cloud | WebSocket (via proxy) | AudioWorklet (PCM16) | Yes | No | No | Yes |
| Mistral AI | Cloud | WebSocket (via proxy) | AudioWorklet (PCM16) | Yes | No | No | Yes |
| Gladia | Cloud | WebSocket (via proxy) | AudioWorklet (PCM16) | Yes | No | No | Yes |
| Deepgram | Cloud | WebSocket (via proxy) | AudioWorklet (PCM16) | Yes | No | No | Yes |
| AssemblyAI | Cloud | WebSocket (via proxy) | AudioWorklet (PCM16) | Yes | No | No | Yes |
| Cloudflare Workers AI | Cloud | REST (batch) | AudioWorklet (PCM16) | No | No | No | Yes |
| SiliconFlow | Cloud | REST (batch) | AudioWorklet (PCM16) | No | No | No | Yes |
| Groq | Cloud | REST (batch) | AudioWorklet (PCM16) | No | No | No | Yes |
| Local OpenAI | Local | REST (batch) | MediaRecorder (WebM/Opus) | No | No | No | No |
| whisper.cpp | Local | REST (local) | AudioWorklet (PCM16) | No | No | No | No |

## Execution Modes

### Real-Time Streaming

Used by **Soniox**, **Volcengine**, **ElevenLabs**, **Mistral AI**, **Gladia**, **Deepgram**, and **AssemblyAI**. Audio chunks are sent continuously over a WebSocket connection, and transcript updates arrive in real-time.

- Soniox emits **token-level events** (`prefersTokenEvents: true`) for fine-grained text updates
- Volcengine, ElevenLabs, Mistral AI, Gladia, Deepgram, and AssemblyAI share Electron's local proxy server. It prefers port 23456 and falls back through 23457–23460 when needed; renderer providers discover the selected port through IPC.

### Windowed Batch

Used by **Cloudflare Workers AI**, **SiliconFlow**, **Groq**, **Local OpenAI-compatible**, and **whisper.cpp**. Audio accumulates in a rolling buffer (max 45 seconds), and a REST call retranscribes the entire window at regular intervals.

- **Interval mode** (Cloudflare, SiliconFlow, Groq, whisper.cpp): retranscribe every 1.5 seconds
- **Debounce mode** (Local OpenAI): retranscribe 1200ms after the last audio chunk
- A `TranscriptStabilizer` compares successive transcriptions and commits stable text prefixes, preventing text flickering

### Electron-Managed Runtime

Used by **whisper.cpp**. DeLive manages the `whisper-server` binary lifecycle:

1. Import or download the binary and model
2. DeLive spawns the process and waits for HTTP readiness (up to 20 seconds)
3. Audio is sent to `POST /inference` as WAV
4. Process is stopped on disconnect or app quit

## Soniox V5

The most feature-rich provider with real-time streaming, translation, and speaker diarization.

**Required:** `apiKey`

**Optional:** `model`, `languageHints`, strict language hints, translation, speaker diarization, endpoint detection, endpoint sensitivity, maximum endpoint delay, and endpoint latency adjustment.

**Features:**
- Token-level real-time transcription
- Real-time translation with dual-line captions
- Speaker diarization with labeled tokens
- Meeting-oriented endpoint sensitivity defaults to `-0.5`; explicit `0` and values from `-1` through `1` are preserved
- Endpoint tuning affects real-time requests only; file transcription uses language strictness, diarization, and context without real-time endpoint fields
- Meeting background and enabled glossary targets can be sent as Soniox context only when the independent Soniox destination switch is enabled
- Audio format: `auto` (WebM/Opus from MediaRecorder)

## Volcengine (火山引擎)

Chinese-focused real-time streaming through an embedded proxy.

**Required:** `appKey`, `accessKey`

**Optional:** `languageHints`, speaker diarization

The browser cannot set custom WebSocket headers, so DeLive runs an embedded HTTP proxy in the Electron main process that forwards PCM16 audio to ByteDance's `openspeech.bytedance.com` endpoint with the required authentication headers.

Volcengine's speaker option enables server-side speaker clustering (`enable_speaker_info`), not channel splitting. Results depend on the audio and the service response. DeLive separates the transcript only when Volcengine returns multiple speaker IDs; if every utterance has the same ID, the transcript remains a single speaker.

## Groq

Whisper `large-v3-turbo` / `large-v3` through Groq's high-performance inference API.

**Required:** `apiKey`

**Optional:** `model`, `languageHints`

## SiliconFlow (硅基流动)

SenseVoice, TeleSpeech, and Qwen Omni models through SiliconFlow's API.

**Required:** `apiKey`

**Optional:** `model`, `languageHints`

## Mistral AI

Voxtral Realtime streaming ASR through the Mistral API.

**Required:** `apiKey`

**Optional:** `model`, `languageHints`

Uses the shared local WebSocket proxy at `/ws/mistral` to inject `Authorization` headers. The renderer discovers the runtime port through IPC (preferred port: 23456).

## Deepgram

Nova-3 and Nova-2 real-time streaming ASR through Deepgram's API.

**Required:** `apiKey`

**Optional:** `model`, `languageHints`

Uses the shared local WebSocket proxy at `/ws/deepgram` to inject `Authorization: Token` headers. Best for English and multilingual content.

## AssemblyAI

Universal-3 Pro real-time streaming ASR through AssemblyAI's WebSocket API.

**Required:** `apiKey`

**Optional:** `model`

Uses the shared local WebSocket proxy at `/ws/assemblyai` to inject `Authorization` headers. Supports 6 streaming languages; best suited for English content.

## ElevenLabs

Scribe v2 Realtime ASR through ElevenLabs' WebSocket API.

**Required:** `apiKey`

**Optional:** `model`, `languageHints`

Uses the shared local WebSocket proxy at `/ws/elevenlabs` to inject `xi-api-key` headers. Supports 90+ languages including Mandarin Chinese. Audio is sent as base64-encoded JSON payloads.

## Gladia

Solaria-1 real-time streaming ASR with sub-300ms latency and 100+ language support.

**Required:** `apiKey`

**Optional:** `model`, `languageHints`

Uses the shared local WebSocket proxy at `/ws/gladia`; it handles HTTP POST session initialization and injects the `x-gladia-key` authentication header. Supports live capture via system audio.

## Cloudflare Workers AI

Whisper-based transcription through Cloudflare's Workers AI platform. Low cost with a generous free tier.

**Required:** `apiToken`, `accountId`

**Optional:** `model`, `languageHints`

Uses windowed batch retranscription with VAD filtering and anti-hallucination measures. Supports both live capture and file transcription. Available models include `@cf/openai/whisper` and `@cf/openai/whisper-large-v3-turbo`.

## Local OpenAI-Compatible

Works with Ollama or any service exposing the OpenAI-compatible audio transcription endpoint.

**Required:** `baseUrl`, `model`

**Optional:** `apiKey`, `languageHints`

DeLive can probe the service at `baseUrl`, list installed models via `/v1/models`, and pull models from Ollama if detected.

## Local whisper.cpp

Fully offline transcription using the `whisper-server` binary.

**Required:** `modelPath`

**Optional:** `binaryPath`, `port` (default 8177), `languageHints`

DeLive can import or download both the binary and model files. Silent audio chunks are automatically skipped to reduce unnecessary inference.
