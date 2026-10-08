import type { DeletedSessionSnapshot, TranscriptSession } from '../types'
import { normalizeTranscriptSession } from './sessionSchema'
import { getDirectProjectIds, normalizeProjectIds } from './projectSchema'
import { createTransaction, DELETED_SESSION_STORE, openAppDatabase, SESSION_STORE, STORAGE_KEYS, supportsIndexedDb } from './storageShared'

const LOCAL_SNAPSHOTS_KEY = 'delive_deleted_session_snapshots'

export function buildDeletedSessionSnapshot(session: TranscriptSession, deletedAt = Date.now()): DeletedSessionSnapshot {
  const normalized = normalizeTranscriptSession(session)
  return {
    version: 1,
    id: session.id,
    originalSessionId: session.id,
    title: normalized.title,
    createdAt: normalized.createdAt,
    deletedAt,
    projectIds: getDirectProjectIds(normalized),
    sourceLabel: normalized.sourceMeta?.sourceLabel,
    originalFileName: normalized.sourceMeta?.originalFileName,
    postProcess: normalized.postProcess,
    askHistory: normalized.askHistory,
    mindMap: normalized.mindMap,
  }
}

export function normalizeDeletedSessionSnapshot(raw: unknown): DeletedSessionSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (value.version !== 1 || typeof value.id !== 'string' || !value.id
    || value.originalSessionId !== value.id || typeof value.deletedAt !== 'number' || !Number.isFinite(value.deletedAt)) return undefined
  const source = normalizeTranscriptSession({
    id: value.id,
    title: typeof value.title === 'string' ? value.title : undefined,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : undefined,
    projectIds: normalizeProjectIds(value.projectIds),
    postProcess: value.postProcess as TranscriptSession['postProcess'],
    askHistory: value.askHistory as TranscriptSession['askHistory'],
    mindMap: value.mindMap as TranscriptSession['mindMap'],
    sourceMeta: {
      sourceLabel: typeof value.sourceLabel === 'string' ? value.sourceLabel : undefined,
      originalFileName: typeof value.originalFileName === 'string' ? value.originalFileName : undefined,
    },
  })
  return buildDeletedSessionSnapshot(source, value.deletedAt)
}

export async function getDeletedSessionSnapshots(): Promise<DeletedSessionSnapshot[]> {
  let values: unknown[]
  if (!supportsIndexedDb()) {
    const raw: unknown = JSON.parse(localStorage.getItem(LOCAL_SNAPSHOTS_KEY) || '[]')
    if (!Array.isArray(raw)) throw new Error('Invalid deleted-result snapshot storage')
    values = raw
  } else {
    const db = await openAppDatabase()
    values = await createTransaction<unknown[]>(db, DELETED_SESSION_STORE, 'readonly', (store, resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  const snapshots = values.map(normalizeDeletedSessionSnapshot)
  if (snapshots.some((snapshot) => !snapshot)) throw new Error('Invalid deleted-result snapshot; history requires repair')
  return (snapshots as DeletedSessionSnapshot[]).sort((left, right) => right.deletedAt - left.deletedAt)
}

export async function replaceDeletedSessionSnapshots(values: DeletedSessionSnapshot[]): Promise<void> {
  const snapshots = values.map(normalizeDeletedSessionSnapshot)
  if (snapshots.some((value) => !value) || new Set(values.map((value) => value.id)).size !== values.length) {
    throw new Error('Invalid or duplicate deleted-result snapshots')
  }
  if (!supportsIndexedDb()) {
    const serialized = JSON.stringify(snapshots)
    localStorage.setItem(LOCAL_SNAPSHOTS_KEY, serialized)
    if (localStorage.getItem(LOCAL_SNAPSHOTS_KEY) !== serialized) throw new Error('Snapshot write verification failed')
    return
  }
  const db = await openAppDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DELETED_SESSION_STORE, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('Snapshot restore aborted'))
    const store = transaction.objectStore(DELETED_SESSION_STORE)
    store.clear()
    snapshots.forEach((snapshot) => store.put(snapshot))
  })
}

// Snapshot and original deletion commit together. Never fall back from a failed IDB transaction.
export async function deleteSessionPreservingResults(session: TranscriptSession): Promise<void> {
  const snapshot = buildDeletedSessionSnapshot(session)
  if (!supportsIndexedDb()) {
    const snapshots = await getDeletedSessionSnapshots()
    localStorage.setItem(LOCAL_SNAPSHOTS_KEY, JSON.stringify([snapshot, ...snapshots.filter((item) => item.id !== snapshot.id)]))
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSIONS) || '[]')
    if (!Array.isArray(stored)) throw new Error('Invalid Session storage')
    localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(stored.filter((item) => item?.id !== session.id)))
    return
  }
  const db = await openAppDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([SESSION_STORE, DELETED_SESSION_STORE], 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Failed to preserve deleted results'))
    transaction.onabort = () => reject(transaction.error || new Error('Result snapshot deletion transaction aborted'))
    transaction.objectStore(DELETED_SESSION_STORE).put(snapshot)
    transaction.objectStore(SESSION_STORE).delete(session.id)
  })
}
