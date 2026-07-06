# Windows Packaging

> Rules for regenerating Windows packages without repeatedly hitting the `winCodeSign` symlink failure.

---

## 1. Scope / Trigger

Use this spec whenever a task asks to update, regenerate, verify, or smoke-test the Windows unpacked Electron app at `release/win-unpacked` or the Windows installer/portable artifacts under `release/`.

This is release infrastructure, not frontend or backend application code. The important contract is the packaging command sequence and the expected generated artifacts.

The root scripts own the supported local packaging flow:

```json
"prepare:win-code-sign": "node scripts/prepare-win-code-sign-cache.mjs",
"pack": "npm run prepare:win-code-sign && npm run build && electron-builder --dir",
"dist:win": "npm run prepare:win-code-sign && npm run build && electron-builder --win"
```

On this Windows workspace, `electron-builder` needs `winCodeSign` for executable resource editing and signing attempts. The upstream archive contains macOS symlink entries, and normal extraction can fail in a non-admin Windows shell without symlink privileges. Always let `prepare:win-code-sign` prefill the stable cache before packaging.

---

## 2. Signatures

Run packaging from the repository root: `C:\Program File\Media\Delive-src`.

Installer and portable package command:

```powershell
npm run dist:win
```

Unpacked app command:

```powershell
npm run pack
```

Cache preparation command:

```powershell
npm run prepare:win-code-sign
```

---

## 3. Contracts

Required inputs:

| Input | Contract |
|-------|----------|
| `package.json#main` | Must point to `dist-electron/electron/main.js`. |
| `prepare:win-code-sign` | Must run before `electron-builder` on Windows. It extracts `winCodeSign-2.6.0.7z` with `7za -snl-` so macOS symlink entries do not require Windows symlink privileges. |
| `npm run build` | Must complete before packaging. It generates icons, `frontend/dist`, and `dist-electron`. |
| `electron-builder --dir` | Must run from the repository root so the `build` config writes to `release`. |
| `CSC_IDENTITY_AUTO_DISCOVERY` | Set to `false` for local unpacked refreshes to avoid certificate discovery. |
| Code signing certificate | Optional. Without a certificate, electron-builder logs `no signing info identified, signing is skipped` and files remain `NotSigned`. |

Required outputs:

| Output | Contract |
|--------|----------|
| `release/win-unpacked/DeLive.exe` | Must exist after packaging and should have DeLive resource metadata. |
| `release/win-unpacked/resources/app.asar` | Must exist after packaging. |
| `frontend/dist/index.html` | Must exist and reflect the current frontend build. |
| `dist-electron/electron/main.js` | Must exist and match `package.json#main`. |
| `release/DeLive-<version>-x64.exe` | Must exist after `npm run dist:win`. |
| `release/DeLive-<version>-portable.exe` | Must exist after `npm run dist:win`. |

Signing contract:

| Field | Expected behavior |
|-------|-------------------|
| EXE metadata | Standard `npm run pack` / `npm run dist:win` should edit resources so metadata shows DeLive fields such as `FileDescription: DeLive`, `ProductName: DeLive`, and `InternalName: DeLive`. |
| Authenticode signature | Remains `NotSigned` unless a valid Windows code-signing certificate is configured through electron-builder (`WIN_CSC_LINK`, certificate file, store certificate, or custom sign hook). |

---

## 4. Validation & Error Matrix

| Condition | Meaning | Action |
|-----------|---------|--------|
| `ERROR: Cannot create symbolic link` under `electron-builder\Cache\winCodeSign` | `winCodeSign` extraction tried to restore bundled Darwin symlinks such as `libcrypto.dylib` and `libssl.dylib`. | Run `npm run prepare:win-code-sign`, then rerun the standard packaging command. |
| `--config.win.signtoolOptions.sign=false` still fails in `winCodeSign` | Disabling signing alone does not disable executable resource editing or `winCodeSign` lookup. | Use `prepare:win-code-sign`; do not disable resource editing unless producing a temporary diagnostic artifact. |
| EXE metadata still shows Electron | Packaging used `--config.win.signAndEditExecutable=false` or skipped resource editing. | Rerun standard `npm run pack` or `npm run dist:win` after preparing the cache. |
| `Get-AuthenticodeSignature` reports `NotSigned` | No code-signing certificate is configured. | Provide a certificate/sign hook if trusted signing is required; cache preparation only fixes resource editing/tool extraction. |
| Packaged app starts as Node or throws early Electron API errors | `ELECTRON_RUN_AS_NODE=1` is still set from an inspection command. | Clear `$env:ELECTRON_RUN_AS_NODE` before smoke-testing. |
| `release/win-unpacked/resources/app.asar` is missing | Packaging did not complete or ran from the wrong directory. | Re-run the preferred local command from the repository root. |
| `frontend/dist/index.html` or `dist-electron/electron/main.js` is missing | `npm run build` did not run or failed before packaging. | Fix the build failure first; do not package stale outputs. |
| Vite chunk-size or Browserslist age warnings appear | Non-blocking build warnings. | Report them separately from failures; they do not invalidate `win-unpacked` by themselves. |

---

## 5. Good/Base/Bad Cases

Good local Windows installer refresh:

```powershell
npm run lint:frontend
npm run test:frontend
npm run dist:win
```

Good local Windows unpacked refresh:

```powershell
npm run pack
```

Bad local Windows refresh:

```powershell
npx electron-builder --win --config.win.signAndEditExecutable=false
```

The bad command generates runnable artifacts but skips executable resource editing, so metadata can remain Electron-branded.

---

## 6. Tests Required

Before packaging code changes that affect the frontend:

```powershell
npm run lint:frontend
npm run test:frontend
```

Always run the standard build and packaging command:

```powershell
npm run dist:win
```

Always verify generated artifacts:

```powershell
Test-Path -LiteralPath "release\win-unpacked\DeLive.exe"
Test-Path -LiteralPath "release\win-unpacked\resources\app.asar"
Test-Path -LiteralPath "frontend\dist\index.html"
Test-Path -LiteralPath "dist-electron\electron\main.js"
Test-Path -LiteralPath "release\DeLive-2.5.0-x64.exe"
Test-Path -LiteralPath "release\DeLive-2.5.0-portable.exe"
```

Verify Windows metadata and signing status separately:

```powershell
(Get-Item -LiteralPath "release\win-unpacked\DeLive.exe").VersionInfo | Format-List FileDescription,InternalName,ProductName,FileVersion,ProductVersion
Get-AuthenticodeSignature -LiteralPath "release\win-unpacked\DeLive.exe", "release\DeLive-2.5.0-x64.exe", "release\DeLive-2.5.0-portable.exe"
```

Smoke-test with Electron runtime variables cleared:

```powershell
$env:ELECTRON_RUN_AS_NODE=$null
$env:ELECTRON_ENABLE_LOGGING=$null
& "C:\Program File\Media\Delive-src\release\win-unpacked\DeLive.exe"
```

After smoke-testing, stop leftover GUI processes if the test launcher does not exit:

```powershell
Stop-Process -Name DeLive -Force
```

---

## 7. Wrong vs Correct

### Wrong

```powershell
npm run pack
```

Then, after `winCodeSign` fails, permanently work around it by disabling resource editing:

```powershell
npx electron-builder --win --config.win.signAndEditExecutable=false
```

This hides the cache problem and leaves EXE metadata at risk of remaining Electron-branded.

### Correct

```powershell
npm run prepare:win-code-sign
npm run dist:win
```

This preserves the normal build pipeline and keeps executable resource editing enabled.

---

## Quick Rule

When refreshing Windows artifacts on this workspace, use `npm run pack` or `npm run dist:win`; both run `prepare:win-code-sign` first. Treat `NotSigned` as a missing certificate issue, not a cache issue. Treat Electron-branded EXE metadata as a packaging failure unless the command intentionally disabled `win.signAndEditExecutable` for diagnostics.
