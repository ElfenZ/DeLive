# Managed Media Processing

## Scenario: Recording Recovery Acknowledgement And Quiet Context Sync

### 1. Scope / Trigger
Repeated recovery warnings after user-managed moves, and no-op title/file synchronization.

### 2. Signatures
`listRecordingRecoveryNotices(activeSessionIds?)`, `acknowledgeRecordingRecovery({key,evidence,activeSessionIds})`, `recoverRecordingArchives(activeSessionIds?)`. IPC names are `list-recording-recovery-notices` / `acknowledge-recording-recovery`; all require the current main-window sender.

### 3. Contracts
Notices expose opaque SHA-256 key/evidence, Session ID, classified reason and acknowledged boolean, never a renderer-chosen path. Keys bind the actual granted root and session. Evidence binds directory identity, exact PCM/metadata/registered-audio stats including ctime, record incarnation and any exact recording-publication stage. Optional v2 `recordingRecoveryAcks` stores only matching evidence, timestamp and `manually-moved` decision. No grant, tombstone or file ownership is created by acknowledgement.

Recording audio and transcripts may be organized independently: absence of a matching local Session is not a recovery issue. Without PCM, temporary metadata or an exact pending recording-publication journal, ordinary registered audio and empty directories left after manual moves produce no notice. Preserve existing unsafe-file checks on otherwise eligible registered audio. Keep metadata-only missing-PCM notices, pending journals even when their stage is absent, and their exact acknowledgement/retry suppression unchanged. Quiet scanning never deletes files, manifests or acknowledgements, and does not suppress missing/conflicting audio errors during reads or migration.

### 4. Validation & Error Matrix
Unsafe IDs/oversized scopes/invalid hashes -> INVALID. Missing or changed evidence -> CONFLICT. Active producers are excluded. Source/backup JSON is not acknowledgement authority. Recheck under the session lock before a durable decision. Ignore matching acknowledged recovery groups; new evidence remains unresolved. Do not resume an acknowledged exact PCM finalization publication. Retain its journal and bytes.

### 5. Good/Base/Bad Cases
Good: user acknowledges a missing-PCM group; restart is quiet and files remain. Base: old v1/v2 state has no acknowledgements. Bad: mute all issues by count, delete residue, auto-adopt moved files, or weaken hash validation on reads/physical operations.

### 6. Tests Required
Real filesystem restart/unchanged/changed/new group tests, no mutation/notification, forged scope/evidence, active producers, current-window IPC boundary and recovery retry suppression. Saved-title no-op and startup binding no-op tests must still permit naming newly published assets and replay deferred/case-only journals.

Cover quiet registered audio without a local Session, manually moved audio retaining its empty directory/manifest, unregistered empty directories and multiple managed roots across restart. Assert no state/file mutation, unchanged read errors, unsafe registered files still reported, and acknowledged pending journals retained across restart and resurfaced when evidence changes.

### 7. Wrong vs Correct
Wrong: every register/context replay writes state and requeues naming, or every startup repeats acknowledged recovery.
Correct: compare authoritative current context/name state; suppress only true no-op work. Recheck publication journal presence after locking. Keep physical identity/hash protections and older-state reads intact.

## Scenario: Future-Write Root Selection And Multiple Managed Roots

### 1. Scope / Trigger

Changing future audio storage or operating on recordings/imported audio after multiple root changes.

### 2. Signatures

```ts
electronAPI.chooseMediaDirectory(): Promise<StorageOperationResult | null>
service.configureMediaDirectory(nativeSelectedParent): Promise<LocalFileStatus>
service.sessionDirectory(sessionId, create?, selectedRoot?): Promise<string>
service.managedRoots(includeRetired?): Promise<string[]>
service.managedSessionDirectories(): Promise<Array<{sessionId:string;directory:string}>>
interface LocalFileChange { sequence: number; configurationRevision: number; activityOnly?: boolean }
```

`MediaMigrationPreview`/`MediaMigrationStatus` add optional `sourceRoots`; private migration journals add `sourceGrants` and per-file `sourceRoot`.

### 3. Contracts

- Native `choose-media-directory` selects a parent and reports the dedicated `DeLive-media` child. It changes the future-write root only, never copies existing assets or changes automatic export directories.
- Refuse active producers/reads/session operations, pending physical journals and copying migrations. Verify writability, free space and atomic non-replacing publication before committing configuration and grants together. Cancel writes no configuration.
- Local file state version 2 adds `mediaRoots`, `sessionRoots` and explicit manifest/intent roots. Version-1 state is read by assigning its old configured root to existing manifests/intents; no automatic physical migration occurs. Old software rejects version-2 state, so direct downgrade is not supported.
- `sessionDirectory` resolves the recorded session root; manifest operations resolve the manifest's root. Keep old grants after root changes. Catalogs include registered sessions even if a root is offline, and report missing/changed media without removing transcripts.
- Multi-root migration adds `sourceGrants` and per-file `sourceRoot`; absent fields in version-1 journals mean their existing `sourceRoot`/`sourceGrant`. Previews and native confirmation list every source. Collect registered assets and exact recovery artifacts across actual managed roots, not transcript/source grants or residue from earlier committed migrations.
- Copy/hash/identity verification, atomic registry switching and explicit protected old-copy cleanup preserve the existing migration contracts. Verify source scopes using root plus session ID plus basename. Never clean a file that is again an active registered location.
- Global file operations reserve one request while existing background catalog readers drain; new catalogs and producer leases cannot starve the request. Recheck real usage/session queues and migration journals after draining, then acquire the exclusive lock. Never ignore catalog readers or wait indefinitely for real recording leases.
- `LocalFileChange.activityOnly` signals availability changes without file/configuration mutations. Catalog begin/end and global-lock reservation/release update truthful busy status through these events; renderer catalog reconciliation ignores them to prevent self-triggering scan loops. File mutation events keep their existing meaning.

### 4. Validation & Error Matrix

Native cancel -> null/no configuration mutation. Renderer path arguments -> ignored. Busy producer/journal/migration -> FILE_STORAGE_BUSY. Unwritable/insufficient-space -> FILE_STORAGE_UNAVAILABLE. Unsafe ancestry/grants -> FILE_STORAGE_INVALID/CONFLICT. Failed atomic configuration write -> retain or reload the actual disk state, never overwrite it from stale memory. Old disk offline -> new-root selection can proceed while old registrations remain unavailable, not deleted. Migration of offline sources -> fails without claiming all media moved.

Catalog-only contention -> wait behind the existing scan, with `status().busy=true`; reject new catalogs/producers/global requests until the reservation ends. Session operations remaining after catalog drain -> FILE_STORAGE_BUSY and release the reservation. Catalog or preview failure -> release waiters/locks in `finally`; no permanent disabled UI. Availability notifications are non-authorizing and do not create another scan.

### 5. Good/Base/Bad Cases

Good: old record stays on A, new recordings use B, migration previews A and B and resumes both after interruption. Base: v1 registry/journal loads with its original root and no file moves. Bad: reconstruct old paths using B, grant renderer paths, reset the registry, or say a current-root-only copy migrated all history.

### 6. Tests Required

`electronFileStorage` covers future-only changes, restart/read/list/rename/delete, unavailable old audio, busy/writability/atomic-write errors and v1 upgrade. `electronMediaMigration` covers three-source preview/copy/interruption/restart/protected cleanup. `electronFileStorageIpc` covers native cancel/confirmation/window identity/path injection. `electronDesktopStorage` exercises actual preload IPC and Blob audio decode/play from old and new roots in an isolated profile; dialogs are substituted, not manual OS acceptance.

Catalog barriers in `electronMediaMigration` assert truthful busy, wait-before-preview, blocked fresh catalogs/producers/requests, real-work revalidation, and release after catalog/preview failure. `useManagedMediaReconciliation` asserts availability-only events cause zero extra catalog calls while real file events still refresh.

### 7. Wrong vs Correct

Wrong: update `mediaRoot`, then join every Session ID to it or restore an old path-only configuration over newer manifests.

Correct: persist root/session/asset bindings atomically, resolve each manifest under its original granted root, and migrate through revisioned journals. Recovery stays on the v2-aware application: resume a confirmed pending migration or explicitly abandon it to preserve sources and residue. Config-only rollback and direct downgrade are unsupported; a JSON backup is never a full-profile/media rollback.

Wrong: emit an ordinary file-change event when a catalog finishes, causing the listener to launch another catalog. Correct: send `activityOnly: true` for availability transitions; refresh settings status but ignore the event in catalog reconciliation.

## Scenario: Extract Local Video Audio Into A Managed Archive

### 1. Scope / Trigger

Use this contract for Electron IPC that probes a user-selected local media file, launches FFmpeg, or reads/reveals/deletes managed audio under the configured media root (default `userData/media`).

### 2. Signatures

```ts
extractMediaAudio(request: {
  taskId: string
  sessionId: string
  sourcePath: string
}): Promise<MediaOperationResult>

getMediaAudio(sessionId: string): Promise<MediaOperationResult>
readMediaAudio(sessionId: string): Promise<MediaReadAudioResult>
listMediaAudio(): Promise<MediaListAudioResult>
revealMediaAudio(sessionId: string): Promise<MediaOperationResult>
deleteMediaAudio(sessionId: string): Promise<MediaOperationResult>
```

### 3. Contracts

- Only the trusted main window may invoke managed-media IPC.
- IDs match the strict `[a-zA-Z0-9._-]` contract, excluding path components `.` and `..`. The main process derives paths from session ID and an asset-kind manifest, never renderer-provided paths. Legacy discovery accepts explicit WAV/MP3/M4A/WebM/BIN archive names only and rejects ambiguous candidates.
- The input is an absolute, real, regular local file and may never be copied into renderer or IPC memory.
- Spawn the bundled FFmpeg absolute path with an argument array and `shell: false`. Never fall back to `PATH`, shell text, or runtime downloads.
- Probe the first audio stream before extraction. Encode mono MP3 at 16 kHz / 64 kbps.
- Write a unique temp file, validate it is a non-empty regular file, then rename it to the stable archive. Never overwrite an existing complete archive.
- Limit extraction concurrency to one process. Cancellation aborts queued/running work and removes the temp output.
- Archive read/reveal/delete reject symlinks/junctions and share leases with recording, extraction, naming and migration. Listing includes completed recordings and extracted audio; PCM/JSON are recovery data, not complete audio or disposable extraction temps.
- Media-root/default-transcript/project-transcript capabilities are granted only by native selection and checked durable main-process config. Do not expand the generic path whitelist. Unavailable configured roots fail explicitly instead of silently reverting to userData.
- Media migration journals each copy, verifies size/hash, commits without replacing unrelated files, switches root durably, then reconciles revision-checked renderer caches. Cleanup of verified old copies requires separate confirmation and never deletes unknown/changed files.
- Original sources remain read-only during extraction, retry, recovery and cleanup. The sole exception is a separate same-directory rename endpoint with main-window-bound one-shot exact preview, native confirmation, identity/title-revision revalidation and a platform genuinely no-replace adapter. No original deletion/move, `exists + rename` fallback or copy-delete emulation.
- File operations persist intent before physical changes and commit registrations before emitting events. Session/job caches must patch matching references with newer revisions, not replace stale complete objects.
- Single corrected-Markdown registrations bind publication/title revisions and file identity/hash. External edits/moves pause writes; errors leave published correction and title intact.

### 4. Validation & Error Matrix

| Condition | Code / result |
|-----------|---------------|
| FFmpeg missing or not regular | `MEDIA_TOOLS_UNAVAILABLE` |
| Invalid ID, relative input, non-file, or symlink | `MEDIA_SOURCE_INVALID` |
| No decodable audio stream | `MEDIA_NO_AUDIO` |
| Explicit cancellation | `MEDIA_EXTRACTION_CANCELLED` |
| Decode/encode/disk/process failure | `MEDIA_EXTRACTION_FAILED` |
| Managed MP3 missing/empty | `MEDIA_AUDIO_MISSING` |
| Existing complete MP3 | Return it without another extraction |

### 5. Good / Base / Bad Cases

- Good: a trusted request extracts to a temp file and atomically publishes one MP3 under its Session directory.
- Base: a retry finds the complete MP3 and reads only that file for Provider upload.
- Bad: accept a renderer-supplied output/delete path, follow a symlink, interpolate a shell command, or send video bytes through IPC.

### 6. Tests Required

- Trusted versus untrusted/main-window sender checks.
- Invalid/path-shaped IDs and source symlinks are rejected.
- Media with audio yields a non-empty MP3 while the input remains untouched.
- Video without audio returns `MEDIA_NO_AUDIO` and creates no stable archive.
- Read/list/reveal/delete resolve only manifest-owned complete assets and preserve PCM/JSON recovery groups and unrelated user files.
- Cancellation and failed FFmpeg runs remove temp files.
- Restart cleanup removes only extraction temp patterns, never recording PCM temp files.

### 7. Wrong vs Correct

#### Wrong

```ts
exec(`ffmpeg -i "${sourcePath}" "${rendererOutputPath}"`)
```

#### Correct

```ts
spawn(ffmpegPath, ['-i', sourcePath, '-map', '0:a:0', tempPath], {
  shell: false,
  windowsHide: true,
})
```

Renderer code identifies a Session; the main process owns the filesystem capability.

## Protected Windows File Operations

- `windowsFileHandle.ts` receives JSON on stdin through a fixed encoded PowerShell program. Paths are never interpolated into commands. Unsupported platforms reject protected destructive operations rather than fall back to `exists + rename` or copy/delete originals.
- The native adapter opens READ+DELETE handles, permits only other readers, rejects reparse points/directories and validates volume/file ID/size/SHA256 on the same held handle used for RenameInfo or DeleteDisposition. Target RenameInfo has ReplaceIfExists=false. Keep the Unicode filename buffer zero-terminated and the native layout aligned to IntPtr.Size.
- Corrected Markdown updates stage a complete synced document, persist its identity plus old-file backup intent, then perform a protected swap. Never truncate the only registered document. Cleanup uses the same protected identity/hash handle contract and remains journaled until it succeeds.
- Every first-save or relocation target needs an app-created stage identity. Equal hash without recorded ownership is insufficient for recovery and cannot authorize adoption/deletion of the original. New locate/relocate actions reject unresolved prior journal rather than overwrite it.
- Original-source previews bind exact canonical source path, revision and affected reference set. Registering another path or reference increments revision. Commit re-reads context inside `withRecordGuard`; title registrations and record deletion share that guard. Original startup recovery never initiates an old approved move and reports multiple distinct physical paths as conflict, including case-only temporary paths.
- Regression tests: noReplaceMove.test.ts covers actual Windows target races and same-content/different-file-ID replacement; electronCorrectedMarkdown.test.ts covers staged swap and relocation fault boundaries, identical unrelated targets and title-move crash; electronOriginalSources.test.ts covers path reselection, source read leases and changed/deleted title context. electronDesktopStorage.test.ts uses a hidden real Electron window/actual preload in an isolated temporary profile. Its native dialogs are deterministic substitutes, not evidence of manually exercised OS dialog UI or cross-volume migration.
- Undo requires a fresh reverse preview from persisted previousName and a new native confirmation, never reuse the forward/canceled token. Dialogs warn external references cannot auto-repair. Original reads accept only a lease token bound to main-window owner and a fresh native source selection; no raw-path read API. Keep lease through source read/provider/extraction and release even on cancellation/error.
- `reconcile-file-record-bindings(contexts, deletedIds)` is main-window-only: after local repository load, clear incomplete prepare when an active durable record exists, commit when a durable deletion snapshot exists, reject duplicate active/deleted identity. Restored title context does not create directory/source permissions. Do not trigger bulk legacy renaming from reconciliation.
- Binding reconciliation must preserve pending naming intents when their frozen saved-title context still matches; never discard an unexecuted intent as ordinary cache. Retry matching intentions after producer/publication recovery, not by renaming every legacy asset.
- Managed case-only naming uses a journaled exclusive intermediate basename and the protected Windows no-replace adapter. A case-insensitive alias of the final file is not a separately owned publication stage and must never be unlinked as cleanup.
- Original-source registry is authoritative for revisioned current names after restart. Main-window-only catalog projection exposes ID/revision/name/size/hash, never source paths or a new read capability; renderer startup patches every matching Session/job and leaves newer pointers untouched.
- First corrected-file publication recovery must handle the persisted complete stagePath/stageProof when the final file does not exist. Verify parent authorization, digest and exact identity before non-replace commit; missing/partial/externally replaced stages retain explicit conflict and must not create an alternate file.

## Scenario: Explicit Desktop Exports

### 1. Scope / Trigger

User-initiated original/corrected TXT/Markdown, AI analysis and subtitle exports. This is not another automatic corrected-save outlet.

### 2. Signatures

```ts
electronAPI.manualExportFile({filename, content, defaultSaveProjectId?}): Promise<{ok, cancelled?, error?}>
saveManualExport(session, content, filename, mimeType): Promise<void>
```

### 3. Contracts

- Only the trusted main window can request export. Renderer supplies a validated basename, textual content up to 32 MiB and optional frozen save-project ID, never a destination path.
- Native SaveAs defaults to that project's selected transcript directory, else configured global directory. Missing configuration still permits an explicit native location; configured-but-unavailable directories report failure, not an unexpected fallback.
- Native selection grants this single write only. Recheck sender after dialog, verify absolute target/extension/non-link parent and exclusive `wx` creation. An existing file or race returns a new-name error without replacement, even if a native overwrite prompt was accepted.
- Desktop cancellation writes nothing and desktop failure does not trigger Blob download. Only the browser uses the download fallback. Manual export does not change automatic-file registrations or default directory preferences.

### 4. Validation & Error Matrix

Untrusted/widget -> reject before dialog; unsafe name/extension/oversized content -> failure; native cancel -> ok/cancelled; missing default -> native location choice; unavailable configured root -> error; existing target/creation race -> no overwrite; explicit write failure -> visible error (a newly created partial output can remain, never an older file replaced).

### 5. Good/Base/Bad Cases

Good: default project path appears in SaveAs and user chooses an alternate location. Base: browser downloads subtitle as before. Bad: renderer injects path, export adopts an automatic registration, or desktop error silently saves to Downloads.

### 6. Tests Required

electronManualExport tests cover real exclusive output/default project/global/unconfigured/alternate/cancel/busy target/window/format limits plus browser fallback. electronDesktopStorage smoke invokes actual new preload IPC and verifies native-selected output/default directory in its temporary profile; native dialogs remain substituted for unattended tests.

### 7. Wrong vs Correct

Wrong: always click an HTML download anchor on desktop, ignoring project/default transcript directory.

Correct: browser -> anchor; desktop -> main-window native SaveAs with role-resolved defaults and exclusive one-shot write.

## Scenario: Local File Service And Directory Capabilities

### 1. Scope / Trigger

Shared managed media publication, native directory configuration, record leases and filesystem recovery. FileStorageService owns physical metadata; renderer paths are caches, not capabilities.

### 2. Signatures

```ts
getFileStorageService(): FileStorageService // one main-process singleton
service.getConfiguration(): Promise<LocalFileConfiguration>
service.sessionDirectory(sessionId, create?): Promise<string>
service.acquireUsage(sessionId, kind): string
service.releaseUsage(token): void
service.withSessionLock(sessionId, operation, ownerToken?): Promise<T>
service.resolveAsset(sessionId, assetKind?): Promise<ManagedAudioAsset>
service.publishAsset(sessionId, assetKind, stageBasename, finalBasename): Promise<ManagedAudioAsset>
service.recoverPublications(sessionId?, ownerToken?): Promise<Array<{ id: string; error?: string }>>
service.listAssets(): Promise<{ audios: ManagedAudioAsset[]; errors: Array<{ sessionId: string; error: string }> }>
service.readAsset(sessionId): Promise<{ audio: ManagedAudioAsset; data: Buffer }>
service.deleteAsset(sessionId): Promise<void>
```

Main-window-only IPC: file-storage-status, choose-transcript-directory({kind:'default-transcript'} | {kind:'project-transcript',projectId}), open-storage-directory with those roles or {kind:'media'}. The selector returns null on native cancellation. No IPC accepts a directory path as an authorization grant.

### 3. Contracts

- Local state is userData/local-file-storage/state.json, version 2 (reads version 1). It atomically contains configuration, grants, root/session bindings, per-session/kind asset manifests and publication intents. It stays in userData when media moves.
- Configuration owns mediaRoot (default userData/media), defaultTranscriptDirectory, projectTranscriptDirectories and revision. Grants bind canonical path/dev/ino/birthtime. Backups must not manufacture these grants.
- Asset manifests bind sessionId/assetKind/basename/MIME/size/SHA256/identity/revision. Legacy adoption recognizes only source-audio.wav/mp3/m4a/webm/bin; multiple candidates or pending conflicting publication is an error, never a guess.
- Publication persists source identity+hash and final name before physical changes. Same-directory hard-link creation commits without replacing a target; identical destinations may be verified and registered, differing targets remain untouched. Registration commit precedes stage cleanup and journal deletion.
- State writes use exclusive unique temps, handle sync, atomic replacement of the app-owned JSON and exact read-back. If rename committed before a reported failure, reload/validate actual disk state before any subsequent mutation. If that cannot be verified, block file writes instead of overwriting from stale memory.
- Usage leases block competing recording/extraction/read/naming/delete/migration. Owner-token operations serialize by session. Callers acquire/release usage across the full producer lifetime and use shared operation locks, including recovery.
- Owner tokens are checked again at queued dispatch, not just admission. A finalize/abort that ends the producer makes already queued late appends fail rather than recreate PCM.
- File/directory dev and ino are lossless decimal strings obtained from bigint lstat/fstat, not rounded JavaScript numbers. Size and display timestamps remain numeric; identity and SHA256 are both verified.
- Recording IPC uses strict IDs and a main sender, one lifetime recording lease, exclusive initial PCM creation and queued full-buffer appends. Repeated begin does not truncate; new begin refuses completed audio or existing recovery groups. Only empty PCM can be aborted; non-empty groups are retained.
- PCM metadata is required and validated (matching sessionId, sample rate 8000..192000, channels 1..8, 16 bits). Missing/invalid metadata is reported, never default-interpreted as successful recovery. Reject incomplete frames and the WAV 32-bit size limit. Metadata records a finalization stage before WAV generation; partial stages are preserved while a fresh exclusive stage is rebuilt and verified against exact header+PCM hash.
- Recording recovery skips active leases, replays physical publication first, recognizes an already committed matching WAV, and removes PCM/JSON only after verified publication. App and video media chains both resolve the same root/manifest/lease service. Recording replies carry managedAsset refs; WAV/M4A/WebM/BIN are not excluded from media enumeration.
- Media deletion journals intent before unlink, checks identity/hash, commits a revisioned tombstone and replays unlink-before-metadata failures. It never recursively deletes folders, PCM/JSON or unknown user files. A tombstone prevents guessed legacy re-adoption; explicit regeneration after user source reselection is a separate protocol and must not resurrect deleted records.
- A configured missing media root is not recreated by write operations. Only first initialization creates the default app-owned root. Storage recovery errors do not crash transcript browsing. Controller.ready is awaitable for integration tests so startup cleanup cannot race fixture destruction.
- Validate absolute/canonical directories and every ancestor against symlinks/junctions. Reject path-shaped IDs, device names, trailing dots, prototype keys and unsafe basenames. Never expand isPathAllowed roots to implement directory selection.
- Directory status probes writability only in authorized/native-selected directories. Project preference falls back globally only when no project directory is configured; a configured missing/replaced directory fails rather than silently falling back.
- status() reports registered count/bytes, directory availability, pending operations and active leases. Main-window-only renderer views may display local paths; remote API projections never include grants/configuration.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Trusted non-main sender | Reject before native dialog or file access |
| Native cancel | null; no config/grant creation |
| Renderer injects path | Ignore; only actual native result can grant a directory |
| Unsafe ID/basename/junction | FILE_STORAGE_INVALID |
| Active conflicting lease | FILE_STORAGE_BUSY |
| Different target or external identity/hash change | FILE_STORAGE_CONFLICT; preserve destination and stage |
| Missing directory/file | Explicit unavailable/missing; no alternate-root guess |
| Corrupt state/manifest/journal | Reject and retain original metadata; never reset to empty |

### 5. Good/Base/Bad Cases

- Good: crash after target link but before registration replays one publication; recovery never creates another copy.
- Base: one explicit legacy WAV is adopted with SHA256/identity; PCM/JSON and unknown files remain untouched.
- Bad: exists + rename for non-replacement, wildcard adoption, copying renderer audioPath, clearing pending stages before journal reconciliation or deleting PCM/JSON as extraction temps.

### 6. Tests Required

- Real temporary filesystem tests for publication/no-overwrite/identical reuse, ambiguous legacy names, stage/journal replay before and after physical state commit, external edits, junction rejection and persistent directory grants.
- IPC tests for main-vs-widget identity, invalid roles/IDs, null cancellation, native picker authority and role-only directory reveal.
- Real FFmpeg and recording PCM tests remain operational after routing both chains through the service. Migration/root switching and final desktop selection smoke are separate acceptance, not implied by foundational tests.

### 7. Wrong vs Correct

Wrong: resolve stale audioPath, rename with overwrite-capable fs.rename, then update a renderer store and call it durable.

Correct: hold the session lease, derive paths from granted root + ID, persist publication intent, non-replace commit, sync/verify and register identity/hash, then emit a revisioned cache patch.

## Scenario: Media Root Migration

### 1. Scope / Trigger

Native media-root selection, restart recovery and separately confirmed old-copy cleanup. No user originals, external Markdown, database or models move.

### 2. Signatures

```ts
service.previewMigration(nativeSelectedParent, mainWindowId): Promise<MediaMigrationPreview>
service.applyMigration(previewToken, mainWindowId): Promise<string>
service.resumeMigration(migrationId): Promise<void>
service.cleanupMigration(migrationId): Promise<Array<{path:string;error:string}>>
service.abandonMigration(migrationId): Promise<void>
```

IPC chooser must show the actual dedicated child `DeLive-media`, not imply the chosen parent will become an arbitrary managed root. Apply tokens bind main window/config revision/expiry; apply and cleanup use separate native confirmation. Resume processes only a durable confirmed copying intent.

### 3. Contracts

- Refuse equal/ancestor/descendant roots, junctions, conflicting files, unavailable space, unsupported atomic non-replace commit and active producer/session locks. Copying journals prevent new media writes even while paused.
- Enumerate only manifest assets, exact legacy names and explicit PCM/JSON/finalization-stage groups. Unknown entries are counted/retained, never recursively scanned or deleted.
- Persist per-file source identity/hash and target stage before copying. Copy exclusively into target-local stages, sync/hash, atomically non-replace link into final names. Identical targets may be reused after verification; different targets stop.
- Root config, target grant, new asset identities/revisions and committed phase switch in one durable state mutation, after all target files and source scope verify. Reads continue to use old root while copying; never silently fall back from an unavailable configured root.
- Startup/resume validates source/target identities and physical stages instead of guessing. Report uncertain/changed stages; partial stages may be retained as evidence and replaced with fresh exclusive stages, not overwritten.
- Old-copy cleanup is a separate explicit action after successful switch. Delete only unchanged journal-owned old files when a verified target/current asset still preserves the content; unknown/changed/consumed recovery files remain with visible skipped bytes. Cleanup failure never reverses root.
- Abandon is explicit, keeps source config, does not delete target residue, and releases blocked media writes. A new migration never silently erases earlier residue.

### 4. Validation & Error Matrix

Busy -> FILE_STORAGE_BUSY; stale token/root/source set -> FILE_STORAGE_CONFLICT; invalid/link/ancestry -> FILE_STORAGE_INVALID; no writable space/atomic commit -> FILE_STORAGE_UNAVAILABLE. Failed copy retains old root plus replayable intent; successful switch followed by cleanup failure retains new root and reports residue.

### 5. Good/Base/Bad Cases

Good: interrupted cross-root copy resumes one target copy per file. Base: one legacy WAV plus PCM/JSON move byte-identically. Bad: raw root setter, exists+rename, recursive old-root deletion, discarding unknown files or entire stale Session/job replacements.

### 6. Tests Required

Real temporary filesystem tests: exact root preview, ancestry/busy/conflict rejection, byte/hash preservation, identical reuse, copy-stage crash, config-switch uncertainty, restart recovery, changed old-copy/unknown preservation and unavailable configured root. Native IPC tests bind tokens/confirmations; renderer reconciliation patches only matching newer references.

### 7. Wrong vs Correct

Wrong: update a settings path then move folders and hope cached audioPath values remain valid.

Correct: journal verified per-file copies, commit authoritative root/manifests first, emit revisioned events and reconcile Session/job field caches; separately confirm cleanup.
