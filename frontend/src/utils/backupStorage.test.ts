import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_BACKUP_SCHEMA_VERSION,
  CURRENT_BACKUP_VERSION,
  getBackupValidationErrors,
  upgradeBackupData,
  sanitizeSettingsForBackup,
  validateBackupData,
  mergeImportedAiPostProcessConfig,
  buildBackupData,
  importDataOverwrite,
  importDataMerge,
} from './backupStorage'
import { createDraftSession } from './sessionLifecycle'
import { buildDeletedSessionSnapshot, getDeletedSessionSnapshots, replaceDeletedSessionSnapshots } from './deletedSessionStorage'
import { getTopics, saveTopics } from './settingsStorage'
import { getSessions } from './sessionStorage'
import { STORAGE_KEYS } from './storageShared'
import * as storageShared from './storageShared'

describe('backupStorage', () => {
  it('preserves manual origin and rejected recovery linkage through serialized backup upgrade', () => {
    const rejected = {
      id: 'r', shardId: 's', op: 'replace', sourceStart: 0, sourceEnd: 0, sourceText: '', replacement: 'new',
      sourceTextHash: 'base', category: 'homophone', reason: 'AI reason', state: 'rejected', rejectionReason: 'anchor-not-unique',
      origin: 'ai', locationVerified: false, modelIntent: { op: 'replace', oldText: 'old', replacement: 'new', before: '', after: ' text', category: 'homophone', reason: 'AI reason' },
    }
    const backup = {
      version: CURRENT_BACKUP_VERSION, exportedAt: '2026-10-07T00:00:00Z', tags: [], settings: {}, sessions: [{
        id: 'manual', title: 'Manual', createdAt: 1, updatedAt: 1, date: '2026-10-07', time: '00:00', transcript: 'old text',
        correction: { status: 'done', mode: 'quick', published: {
          id: 'p', formatVersion: 1, revision: 1, baseTranscriptHash: 'base', outputTextHash: 'out', correctedText: 'new text',
          model: 'manual', completedAt: 1, stats: { applied: 1, reverted: 0, rejected: 1 }, patches: [rejected,
            { ...rejected, id: 'm', state: 'applied', sourceEnd: 3, sourceText: 'old', origin: 'manual', locationVerified: true, recoveredFromPatchId: 'r' },
          ],
        } },
      }],
    }
    const restored = upgradeBackupData(JSON.parse(JSON.stringify(backup)))
    const patches = restored.sessions[0].correction!.published!.patches
    expect(patches[0]).toMatchObject({ locationVerified: false, modelIntent: { oldText: 'old', after: ' text' }, rejectionReason: 'anchor-not-unique' })
    expect(patches[1]).toMatchObject({ origin: 'manual', locationVerified: true, recoveredFromPatchId: 'r' })
    expect(upgradeBackupData(JSON.parse(JSON.stringify(restored))).sessions[0].correction?.published?.patches).toEqual(patches)
  })
  it('validates top-level backup structure with nested object arrays', () => {
    expect(validateBackupData({
      version: '1.1',
      exportedAt: '2026-03-09T00:00:00Z',
      sessions: [{ id: 'session-1' }],
      tags: [{ id: 'tag-1', name: 'Important' }],
      settings: { apiKey: '', languageHints: ['zh', 'en'] },
    })).toBe(true)

    expect(validateBackupData({
      version: '1.1',
      exportedAt: '2026-03-09T00:00:00Z',
      sessions: ['bad'],
      tags: [],
      settings: {},
    })).toBe(false)

    expect(validateBackupData({
      version: '1.1',
      exportedAt: '2026-03-09T00:00:00Z',
      sessions: [],
      tags: ['bad'],
      settings: {},
    })).toBe(false)

    expect(getBackupValidationErrors({
      version: '',
      sessions: ['bad'],
      tags: ['bad'],
      settings: null,
    })).toEqual([
      'Missing or invalid "version"',
      'sessions[0] must be an object',
      'tags[0] must be an object',
      'Missing or invalid "settings" object',
    ])
  })

  it('upgrades legacy backup data into current schema', () => {
    const upgraded = upgradeBackupData({
      version: '1.1',
      exportedAt: '2026-03-09T00:00:00Z',
      sessions: [
        {
          id: 'legacy-session',
          createdAt: 1000,
          updatedAt: 2000,
          transcript: 'hello world',
          tokens: [{ text: 'hello world', startMs: 0, endMs: 1000 }],
          tags: ['ignored'],
        } as never,
      ],
      tags: [
        { id: 'tag-1', name: 'Important', color: 'green' },
        { id: '', name: 'invalid' } as never,
      ],
      settings: {
        apiKey: 'legacy-key',
        languageHints: ['zh', 'en'],
      },
    })

    expect(upgraded.version).toBe(CURRENT_BACKUP_VERSION)
    expect(upgraded.schemaVersion).toBe(CURRENT_BACKUP_SCHEMA_VERSION)
    expect(upgraded.sessions).toHaveLength(1)
    expect(upgraded.sessions[0]).toEqual(expect.objectContaining({
      id: 'legacy-session',
      schemaVersion: 8,
      transcript: 'hello world',
      tagIds: [],
      speakers: [],
      segments: [],
      status: 'completed',
    }))
    expect(upgraded.tags).toEqual([
      { id: 'tag-1', name: 'Important', color: 'green' },
    ])
    expect(upgraded.settings).toEqual(expect.objectContaining({
      apiKey: 'legacy-key',
      languageHints: ['zh', 'en'],
    }))
    expect(upgraded.settings.captionStyle).toBeDefined()
  })

  it('round-trips advanced correction overrides through backup normalization', () => {
    const upgraded = upgradeBackupData({
      version: '4.0',
      schemaVersion: 4,
      exportedAt: '2026-07-16T00:00:00Z',
      sessions: [],
      tags: [],
      settings: {
        apiKey: '',
        languageHints: [],
        aiPostProcess: {
          enabled: true,
          autoCorrectionDetection: true,
          autoAiPostProcess: true,
          autoExportCorrectedMarkdown: true,
          autoExportDirectory: 'D:\\Exports',
          correctionStructuredOutput: 'json_schema',
          correctionAdvanced: {
            chunkSize: 5000,
            contextSize: 600,
            concurrency: 2,
            safetyLimits: {
              maxPatchTextLength: 800,
              maxCumulativeEditRatio: 0.15,
            },
          },
        },
      },
    })
    expect(upgraded.settings.aiPostProcess).toEqual(expect.objectContaining({
      correctionStructuredOutput: 'json_schema',
      autoCorrectionDetection: true,
      autoAiPostProcess: true,
      autoExportCorrectedMarkdown: true,
      autoExportDirectory: undefined,
      correctionAdvanced: {
        chunkSize: 5000,
        contextSize: 600,
        concurrency: 2,
        safetyLimits: {
          maxPatchTextLength: 800,
          maxPatchesPerShard: undefined,
          maxCumulativeEditRatio: 0.15,
          maxNetLengthChangeRatio: undefined,
        },
      },
    }))
  })

  it('normalizes AI protocol and thinking settings with legacy-safe defaults', () => {
    const anthropic = upgradeBackupData({
      version: '4.0', schemaVersion: 4, exportedAt: '2026-08-28T00:00:00Z', sessions: [], tags: [],
      settings: {
        apiKey: '', languageHints: [],
        aiPostProcess: { provider: 'anthropic-compatible', thinkingMode: 'disabled', correctionStructuredOutput: 'json_object' },
      },
    })
    const legacy = upgradeBackupData({
      version: '4.0', schemaVersion: 4, exportedAt: '2026-08-28T00:00:00Z', sessions: [], tags: [],
      settings: { apiKey: '', languageHints: [], aiPostProcess: {} },
    })
    expect(anthropic.settings.aiPostProcess).toMatchObject({
      provider: 'anthropic-compatible',
      thinkingMode: 'disabled',
      correctionStructuredOutput: 'prompt-json',
    })
    expect(legacy.settings.aiPostProcess).toMatchObject({ provider: 'openai-compatible', thinkingMode: 'default' })
  })

  it('round-trips meeting context and target-only glossary entries', () => {
    const upgraded = upgradeBackupData({
      version: '4.0',
      schemaVersion: 4,
      exportedAt: '2026-07-19T00:00:00Z',
      sessions: [],
      tags: [],
      settings: {
        apiKey: '',
        languageHints: [],
        meetingContext: {
          background: 'Developer meeting',
          correctionGuidance: 'Keep DeLive case',
          useForAiCorrection: true,
          useForSoniox: true,
        },
        aiPostProcess: {
          glossary: [{ id: 'term-1', target: 'TypeScript', enabled: true }],
        },
      },
    })
    expect(upgraded.settings.meetingContext).toEqual({
      background: 'Developer meeting',
      correctionGuidance: 'Keep DeLive case',
      useForAiCorrection: true,
      useForSoniox: true,
    })
    expect(upgraded.settings.aiPostProcess?.glossary).toEqual([
      { id: 'term-1', target: 'TypeScript', enabled: true },
    ])
  })

  it('removes credentials from exported settings without dropping non-secret context', () => {
    const sanitized = sanitizeSettingsForBackup({
      apiKey: 'legacy-secret',
      languageHints: ['zh'],
      meetingContext: {
        background: 'Project facts',
        correctionGuidance: '',
        useForAiCorrection: true,
        useForSoniox: false,
      },
      providerConfigs: {
        soniox: { apiKey: 'soniox-secret', endpointSensitivity: 0 },
        volc: { appKey: 'app-secret', accessKey: 'access-secret' },
      },
      aiPostProcess: { apiKey: 'ai-secret', glossary: [] },
      openApi: { enabled: true, token: 'api-token' },
      cloudBackup: {
        s3: {
          endpoint: 'https://s3.example.com', region: 'x', bucket: 'b', prefix: '',
          accessKeyId: 'id', secretAccessKey: 'secret',
        },
      },
    })
    expect(sanitized.apiKey).toBe('')
    expect(sanitized.providerConfigs?.soniox.apiKey).toBe('')
    expect(sanitized.providerConfigs?.soniox.endpointSensitivity).toBe(0)
    expect(sanitized.providerConfigs?.volc).toEqual({ appKey: '', accessKey: '' })
    expect(sanitized.aiPostProcess?.apiKey).toBe('')
    expect(sanitized.openApi?.token).toBe('')
    expect(sanitized.cloudBackup?.s3?.secretAccessKey).toBe('')
    expect(sanitized.meetingContext?.background).toBe('Project facts')
  })

  it('invalidates imported AI credential identity when the local key replaces the backup key', () => {
    const merged = mergeImportedAiPostProcessConfig(
      { apiKey: 'local-key' },
      { baseUrl: 'https://api.example.com/v1', apiKey: '', credentialVersion: 4 },
    )

    expect(merged.apiKey).toBe('local-key')
    expect(merged.credentialVersion).toBe(5)
  })
})

describe('backup restore behavior', () => {
  let values: Map<string, string>
  beforeEach(() => {
    values = new Map()
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const empty = () => ({ version: '5.0', schemaVersion: 5, exportedAt: '', sessions: [], tags: [], topics: [], deletedSessionSnapshots: [], settings: { apiKey: '', languageHints: [] } })
  const project = { id: 'p', name: 'Project', emoji: '', createdAt: 1, updatedAt: 1 }

  it('empty overwrite clears actual stored projects, records and independent snapshots', async () => {
    saveTopics([project])
    values.set(STORAGE_KEYS.SESSIONS, JSON.stringify([createDraftSession({ id: 'live', title: 'Live', now: 1 })]))
    await replaceDeletedSessionSnapshots([buildDeletedSessionSnapshot(createDraftSession({ id: 'deleted', title: 'Deleted', now: 1 }), 2)])
    await importDataOverwrite(empty())
    expect(getTopics()).toEqual([])
    expect(await getSessions()).toEqual([])
    expect(await getDeletedSessionSnapshots()).toEqual([])
  })

  it('common builder and restore preserve hierarchy, multi-links and normalized read-only results without file capabilities', async () => {
    saveTopics([project, { ...project, id: 'child', parentId: 'p' }])
    const session = { ...createDraftSession({ id: 'live', title: 'Live', projectIds: ['p', 'child'], now: 1 }), defaultSaveProjectId: 'child', sourceMeta: { audioPath: 'C:/private.wav', audioAvailable: true, originalSourceId: 'original', originalFileName: 'history.wav' }, correctedMarkdownFile: { status: 'saved' as const, revision: 3, path: 'C:/private.md', registrationId: 'grant' } }
    values.set(STORAGE_KEYS.SESSIONS, JSON.stringify([session]))
    const snapshot = buildDeletedSessionSnapshot({ ...createDraftSession({ id: 'deleted', title: 'Deleted', now: 1 }), postProcess: { status: 'success', summary: 'Result' } }, 2)
    await replaceDeletedSessionSnapshots([snapshot])
    const data = await buildBackupData()
    await importDataOverwrite({ ...data, deletedSessionSnapshots: [{ ...snapshot, projectIds: ['p', 'p', ' child '], transcript: 'private', previewToken: 'secret' } as never] })
    const restored = (await getSessions())[0]
    expect(getTopics()[1].parentId).toBe('p')
    expect(restored.projectIds).toEqual(['p', 'child'])
    expect(restored.defaultSaveProjectId).toBe('child')
    expect(restored.sourceMeta).toMatchObject({ audioAvailable: false, originalFileName: 'history.wav' })
    expect(restored.sourceMeta?.audioPath).toBeUndefined()
    expect(restored.sourceMeta?.originalSourceId).toBeUndefined()
    expect(restored.correctedMarkdownFile).toMatchObject({ status: 'missing' })
    expect(restored.correctedMarkdownFile?.registrationId).toBeUndefined()
    expect((await getDeletedSessionSnapshots())[0]).toMatchObject({ projectIds: ['p', 'child'], postProcess: { summary: 'Result' } })
    expect(JSON.stringify(await getDeletedSessionSnapshots())).not.toMatch(/private|previewToken/)
  })

  it('rejects future backup and snapshot versions before changing storage', async () => {
    saveTopics([project])
    for (const data of [{ ...empty(), version: '6.0' }, { ...empty(), schemaVersion: 6 }, { ...empty(), deletedSessionSnapshots: [{ version: 2, id: 'deleted' } as never] }]) {
      await expect(importDataOverwrite(data)).rejects.toThrow()
      expect(getTopics()).toEqual([project])
    }
  })

  it('rejects visible merge conflicts without modifying existing or adding incoming records', async () => {
    saveTopics([project])
    const original = createDraftSession({ id: 'live', title: 'Local', now: 1 })
    values.set(STORAGE_KEYS.SESSIONS, JSON.stringify([original]))
    await expect(importDataMerge({ ...empty(), sessions: [{ ...original, title: 'Incoming' }, createDraftSession({ id: 'new', title: 'New', now: 1 })] })).rejects.toThrow('Session ID conflicts: live')
    expect((await getSessions()).map((session) => session.id)).toEqual(['live'])
    await expect(importDataMerge({ ...empty(), topics: [{ ...project, name: 'Incoming' }] })).rejects.toThrow('project ID conflicts: p')
    expect(getTopics()).toEqual([project])
    await replaceDeletedSessionSnapshots([buildDeletedSessionSnapshot(createDraftSession({ id: 'deleted', title: 'Deleted', now: 1 }), 2)])
    await expect(importDataMerge({ ...empty(), sessions: [createDraftSession({ id: 'deleted', title: 'Deleted', now: 1 })] })).rejects.toThrow('Session ID conflicts: deleted')
  })

  it('merges disjoint records and snapshots, rejects duplicate snapshot IDs and invalid hierarchy', async () => {
    const snapshot = buildDeletedSessionSnapshot(createDraftSession({ id: 'deleted', title: 'Deleted', now: 1 }), 2)
    await importDataMerge({ ...empty(), sessions: [createDraftSession({ id: 'live', title: 'Live', now: 1 })], topics: [project], deletedSessionSnapshots: [snapshot] })
    expect(await getSessions()).toHaveLength(1)
    expect(await getDeletedSessionSnapshots()).toHaveLength(1)
    await expect(importDataMerge({ ...empty(), deletedSessionSnapshots: [snapshot] })).rejects.toThrow('snapshot ID conflicts: deleted')
    await expect(importDataOverwrite({ ...empty(), deletedSessionSnapshots: [snapshot, snapshot] })).rejects.toThrow('Duplicate snapshot')
    await expect(importDataOverwrite({ ...empty(), topics: [{ ...project, parentId: 'missing' }] })).rejects.toThrow('Parent project')
    expect(await getSessions()).toHaveLength(1)
  })

  it('surfaces native transaction abort instead of falling back or reporting successful restore', async () => {
    values.set(STORAGE_KEYS.SESSIONS, 'original-local-fallback')
    const stores = { sessions: { clear: vi.fn(), put: vi.fn() }, deletedSessionSnapshots: { clear: vi.fn(), put: vi.fn() }, meta: { put: vi.fn() } }
    const transaction = {
      error: new Error('native restore aborted'),
      oncomplete: undefined as (() => void) | undefined,
      onerror: undefined as (() => void) | undefined,
      onabort: undefined as (() => void) | undefined,
      objectStore: (name: keyof typeof stores) => stores[name],
    }
    const transact = vi.fn(() => { queueMicrotask(() => transaction.onabort?.()); return transaction })
    vi.stubGlobal('indexedDB', {})
    vi.spyOn(storageShared, 'openAppDatabase').mockResolvedValue({ transaction: transact } as unknown as IDBDatabase)
    await expect(importDataOverwrite(empty())).rejects.toThrow('native restore aborted')
    expect(transact).toHaveBeenCalledWith(['sessions', 'deletedSessionSnapshots', 'meta'], 'readwrite')
    expect(stores.sessions.clear).toHaveBeenCalledOnce()
    expect(stores.deletedSessionSnapshots.clear).toHaveBeenCalledOnce()
    expect(values.get(STORAGE_KEYS.SESSIONS)).toBe('original-local-fallback')
    expect(values.has(STORAGE_KEYS.TOPICS)).toBe(false)
  })

  it('commits empty native restore and disables resurrection from legacy Session cache', async () => {
    values.set(STORAGE_KEYS.SESSIONS, JSON.stringify([createDraftSession({ title: 'Legacy', id: 'legacy', now: 1 })]))
    const metaPut = vi.fn()
    const transaction = {
      oncomplete: undefined as (() => void) | undefined,
      objectStore: (name: string) => ({ clear: vi.fn(), put: name === 'meta' ? metaPut : vi.fn(() => ({})) }),
    }
    const transact = vi.fn(() => { queueMicrotask(() => transaction.oncomplete?.()); return transaction })
    vi.spyOn(storageShared, 'supportsIndexedDb').mockReturnValue(false).mockReturnValueOnce(true)
    vi.spyOn(storageShared, 'openAppDatabase').mockResolvedValue({ transaction: transact } as unknown as IDBDatabase)
    await importDataOverwrite(empty())
    expect(metaPut).toHaveBeenCalledWith({ key: 'sessions_migrated', value: true })
    expect(values.has(STORAGE_KEYS.SESSIONS)).toBe(false)
  })
})
