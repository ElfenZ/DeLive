# Settings

DeLive settings are organized into two tabs: **Service** (provider configuration) and **General** (app-wide preferences).

## Service Tab

### Provider Selection

Choose from twelve ASR providers. Each provider has its own set of configuration fields (API keys, endpoints, models, language hints).

### Config Test

All providers support **Test Config**, a button that verifies credentials and connectivity before recording.

![Settings — Service Tab](/images/screenshot-settings-api.png)

### Local Service Discovery

For **Local OpenAI-compatible**, DeLive can:
- Probe the service at the configured base URL
- List installed models via `/v1/models`
- Pull models from Ollama if detected

### Runtime Setup

For **Local whisper.cpp**, the bundled runtime guide helps you:
- Import or download the `whisper-server` binary
- Import or download a `.bin` / `.gguf` model
- Test the runtime configuration

## General Tab

### Interface Language

Switch between **Chinese** (default) and **English**.

### Color Theme

Five accent palettes: **Cyan**, **Violet**, **Rose**, **Green**, **Amber**. Each supports full light and dark mode. The light/dark toggle is in the top navigation bar.

### AI Post-Process

Configure the OpenAI-compatible endpoint for AI features:

| Field | Description | Default |
|-------|-------------|---------|
| Base URL | Chat completions endpoint | `http://127.0.0.1:11434/v1` |
| Model | Model identifier | — |
| API Key | Optional authentication | — |
| Prompt Language | `zh` or `en` | `zh` |

### Meeting Context

Meeting context is a reusable, credential-free input for transcription and AI correction:

| Field | Behavior |
|-------|----------|
| **Meeting background** | Topic, domain, product, and technical facts; limited to 4,000 Unicode code points |
| **Correction guidance** | AI-only correction preferences; limited to 2,000 Unicode code points |
| **Use for AI correction** | Enabled by default; adds bounded JSON reference data without changing the fixed Patch protocol |
| **Send to Soniox** | Disabled by default; sends background and enabled glossary targets as Soniox context |
| **Glossary** | Supports known `source -> target` mappings and target-only candidate terms |

Recording and file-transcription screens provide a one-shot context editor. Each task can inherit the global context, override it, or clear it. The effective context is frozen when the task starts, so later settings changes do not alter reconnects or automatic correction.

### Open API

Control external access to DeLive data (Electron only):

| Setting | Description |
|---------|-------------|
| **Enable Open API** | Toggle the local REST API and WebSocket on/off |
| **Access Token** | Optional Bearer token for authentication |
| **Generate Random Token** | Creates a cryptographically random token |
| **Endpoint URLs** | Shows REST and WebSocket URLs with copy buttons |

Electron prefers port `23456` and automatically tries `23457–23460` when the port is occupied. The URLs displayed here are the runtime source of truth. A fallback warning identifies when external MCP servers or scripts must update `DELIVE_API_URL` manually.

::: warning
When Open API is enabled with an empty token, any local process can access your transcription data. Set a token for production use.
:::

### Data Management

- **Export** — download all sessions, tags, and settings as JSON
- **Import** — restore from a backup file (overwrite or merge)

### Desktop Integration

- **Auto-launch** — start DeLive on system login (Windows and macOS)
- **Auto-update** — check for updates automatically
- **Diagnostics export** — generate a redacted JSON bundle for troubleshooting
