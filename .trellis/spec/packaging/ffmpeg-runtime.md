# Bundled FFmpeg Runtime

## Scenario: Package The Video Audio Extraction Runtime

### 1. Scope / Trigger

Use this contract whenever changing FFmpeg version, hashes, supported architectures, `extraResources`, or media extraction packaging.

### 2. Signatures

```bash
npm run prepare:ffmpeg-runtime
npm run prepare:ffmpeg-runtime -- --target win-x64
npm run prepare:ffmpeg-runtime -- --target mac-x64 --target mac-arm64
npm run prepare:ffmpeg-runtime -- --target linux-x64
```

Runtime location:

```text
development: local-runtimes/ffmpeg/<os>-<arch>/ffmpeg[.exe]
packaged:    <resources>/ffmpeg/ffmpeg[.exe]
```

### 3. Contracts

- Version is FFmpeg 6.1.1 from the pinned `eugeneware/ffmpeg-static` release `b6.1.1`.
- `scripts/prepare-ffmpeg-runtime.mjs` owns target URLs, byte sizes, and SHA-256 values for Windows x64, macOS x64/arm64, and Linux x64.
- A hash or size mismatch fails the build. Runtime code never downloads tools and never uses system `PATH`.
- Each packaged target receives only its matching binary plus `COPYING.GPLv3` and `SOURCE.txt`.
- `SOURCE.txt` records target, source URL, exact hash/size, upstream source, and license source.
- FFmpeg is a separate CLI process. DeLive remains Apache-2.0; the bundled FFmpeg build and its corresponding source are distributed under GPLv3.
- Linux arm64 is not supported until both the electron-builder target and a verified runtime manifest entry exist.

### 4. Validation & Error Matrix

| Condition | Required result |
|-----------|-----------------|
| Unsupported target | Preparation exits non-zero and lists supported targets |
| Existing binary hash matches | Reuse without download |
| Existing binary hash differs | Redownload and verify before replacing |
| Download size/hash differs | Delete temp file and fail |
| Target resource missing at packaging | Packaging fails; app must not fall back to system FFmpeg |
| macOS target | Build x64 and arm64 with their separate prepared directories |

### 5. Good / Base / Bad Cases

- Good: `dist:mac` prepares both target directories and each DMG/ZIP receives only its architecture.
- Base: local Windows development prepares and resolves `win-x64/ffmpeg.exe`.
- Bad: fetch `latest`, omit hash checks/license text, put all architectures in every installer, or call `ffmpeg` from `PATH`.

### 6. Tests Required

- Run preparation twice and assert the verified binary is reused.
- Run `npm run build` and target packaging on a machine without system FFmpeg.
- Inspect the unpacked resources for executable, `COPYING.GPLv3`, and `SOURCE.txt`.
- Run `ffmpeg -version` from the packaged resource and verify version/architecture.
- Extract audio from representative MP4/WebM/MOV/MKV/MPEG inputs on each target.
- Verify Windows x64, macOS x64/arm64, and Linux x64 independently.

### 7. Wrong vs Correct

#### Wrong

```json
"dist:mac": "npm run build && electron-builder --mac"
```

This can build two architectures with only the host architecture's runtime.

#### Correct

```json
"dist:mac": "npm run prepare:ffmpeg-runtime -- --target mac-x64 --target mac-arm64 && npm run build && electron-builder --mac"
```

Preparation and electron-builder use the same `${os}-${arch}` resource contract.
