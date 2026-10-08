import type { TranscriptSession } from '../types'
import {
  createTransaction,
  getMetaValue,
  META_KEY_SESSIONS_MIGRATED,
  openAppDatabase,
  removeLocalStorageItem,
  SESSION_STORE,
  SESSION_UPDATED_AT_INDEX,
  setMetaValue,
  STORAGE_KEYS,
  supportsIndexedDb,
  readJsonFromLocalStorage,
  writeJsonToLocalStorage,
} from './storageShared'

function getLegacySessionsFromLocalStorage(): TranscriptSession[] {
  return readJsonFromLocalStorage(STORAGE_KEYS.SESSIONS, [] as TranscriptSession[])
}

function saveLegacySessionsToLocalStorage(sessions: TranscriptSession[]): void {
  writeJsonToLocalStorage(
    STORAGE_KEYS.SESSIONS,
    sessions,
    'Failed to save sessions to localStorage:',
  )
}

function clearLegacySessionsFromLocalStorage(): void {
  removeLocalStorageItem(
    STORAGE_KEYS.SESSIONS,
    'Failed to clear sessions from localStorage:',
  )
}

function upsertLegacySessionInLocalStorageStrict(session: TranscriptSession): void {
  const sessions = getLegacySessionsFromLocalStorage()
  const index = sessions.findIndex((item) => item.id === session.id)
  if (index === -1) sessions.unshift(session)
  else sessions[index] = session
  localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(sortSessions(sessions)))
}

function upsertLegacySessionsInLocalStorageStrict(nextSessions: TranscriptSession[]): void {
  const sessions = getLegacySessionsFromLocalStorage()
  for (const session of nextSessions) {
    const index = sessions.findIndex((item) => item.id === session.id)
    if (index === -1) sessions.unshift(session)
    else sessions[index] = session
  }
  localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(sortSessions(sessions)))
}

function deleteLegacySessionFromLocalStorage(id: string): void {
  saveLegacySessionsToLocalStorage(
    sortSessions(getLegacySessionsFromLocalStorage().filter((session) => session.id !== id)),
  )
}

function sortSessions(sessions: TranscriptSession[]): TranscriptSession[] {
  return [...sessions].sort((left, right) => {
    const leftTs = Math.max(left.createdAt || 0, left.updatedAt || 0)
    const rightTs = Math.max(right.createdAt || 0, right.updatedAt || 0)
    return rightTs - leftTs
  })
}

async function readSessionsFromIndexedDb(): Promise<TranscriptSession[]> {
  const db = await openAppDatabase()
  return createTransaction<TranscriptSession[]>(db, SESSION_STORE, 'readonly', (store, resolve, reject) => {
    const sessions: TranscriptSession[] = []
    const source = store.indexNames.contains(SESSION_UPDATED_AT_INDEX)
      ? store.index(SESSION_UPDATED_AT_INDEX)
      : store
    const request = source.openCursor(null, 'prev')

    request.onerror = () => reject(request.error ?? new Error('Failed to read sessions from IndexedDB'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(source === store ? sortSessions(sessions) : sessions)
        return
      }

      sessions.push(cursor.value as TranscriptSession)
      cursor.continue()
    }
  })
}

async function replaceSessionsInIndexedDb(sessions: TranscriptSession[]): Promise<void> {
  const db = await openAppDatabase()
  const sortedSessions = sortSessions(sessions)

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(SESSION_STORE, 'readwrite')
    const store = transaction.objectStore(SESSION_STORE)
    const clearRequest = store.clear()

    clearRequest.onerror = () => reject(clearRequest.error ?? new Error('Failed to clear IndexedDB sessions'))
    clearRequest.onsuccess = () => {
      for (const session of sortedSessions) {
        store.put(session)
      }
    }

    transaction.onerror = () => reject(transaction.error ?? new Error('Failed to replace IndexedDB sessions'))
    transaction.oncomplete = () => resolve()
  })
}

async function upsertSessionInIndexedDb(session: TranscriptSession): Promise<void> {
  const db = await openAppDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(SESSION_STORE, 'readwrite')
    const store = transaction.objectStore(SESSION_STORE)
    const request = store.put(session)
    request.onerror = () => reject(request.error ?? new Error('Failed to upsert session in IndexedDB'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Failed to upsert session in IndexedDB'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB session upsert was aborted'))
    transaction.oncomplete = () => resolve()
  })
}

async function upsertSessionsInIndexedDb(sessions: TranscriptSession[]): Promise<void> {
  if (sessions.length === 0) {
    return
  }

  const db = await openAppDatabase()
  const sortedSessions = sortSessions(sessions)

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(SESSION_STORE, 'readwrite')
    const store = transaction.objectStore(SESSION_STORE)

    for (const session of sortedSessions) {
      store.put(session)
    }

    transaction.onerror = () => reject(transaction.error ?? new Error('Failed to upsert sessions in IndexedDB'))
    transaction.oncomplete = () => resolve()
  })
}

async function deleteSessionFromIndexedDb(id: string): Promise<void> {
  const db = await openAppDatabase()
  await createTransaction<void>(db, SESSION_STORE, 'readwrite', (store, resolve, reject) => {
    const request = store.delete(id)
    request.onerror = () => reject(request.error ?? new Error('Failed to delete session from IndexedDB'))
    request.onsuccess = () => resolve()
  })
}

async function ensureSessionMigration(): Promise<void> {
  if (!supportsIndexedDb()) {
    return
  }

  const migrated = await getMetaValue<boolean>(META_KEY_SESSIONS_MIGRATED)
  if (migrated) {
    return
  }

  const legacySessions = getLegacySessionsFromLocalStorage()
  if (legacySessions.length > 0) {
    await replaceSessionsInIndexedDb(legacySessions)
    clearLegacySessionsFromLocalStorage()
  }

  await setMetaValue(META_KEY_SESSIONS_MIGRATED, true)
}

export async function getSessions(): Promise<TranscriptSession[]> {
  if (!supportsIndexedDb()) {
    return getLegacySessionsFromLocalStorage()
  }

  try {
    await ensureSessionMigration()
    return await readSessionsFromIndexedDb()
  } catch (error) {
    console.error('Failed to load sessions from IndexedDB, falling back to localStorage:', error)
    return getLegacySessionsFromLocalStorage()
  }
}

export async function saveSessions(sessions: TranscriptSession[]): Promise<void> {
  const sortedSessions = sortSessions(sessions)

  if (!supportsIndexedDb()) {
    saveLegacySessionsToLocalStorage(sortedSessions)
    return
  }

  try {
    await ensureSessionMigration()
    await replaceSessionsInIndexedDb(sortedSessions)
  } catch (error) {
    console.error('Failed to save sessions to IndexedDB, falling back to localStorage:', error)
    saveLegacySessionsToLocalStorage(sortedSessions)
  }
}

export async function upsertSession(session: TranscriptSession): Promise<void> {
  if (!supportsIndexedDb()) {
    upsertLegacySessionInLocalStorageStrict(session)
    return
  }

  try {
    await ensureSessionMigration()
    await upsertSessionInIndexedDb(session)
  } catch (error) {
    console.error('Failed to upsert session in IndexedDB, falling back to localStorage:', error)
    upsertLegacySessionInLocalStorageStrict(session)
  }
}

export async function upsertSessionStrict(session: TranscriptSession): Promise<void> {
  if (!supportsIndexedDb()) {
    upsertLegacySessionInLocalStorageStrict(session)
    return
  }
  await ensureSessionMigration()
  await upsertSessionInIndexedDb(session)
}

const PROJECT_UPGRADE_SNAPSHOT_KEY = 'project_upgrade_v1_snapshot'
const PROJECT_UPGRADE_COMPLETED_KEY = 'project_upgrade_v1_completed'

export async function migrateProjectSessions(original: TranscriptSession[], upgraded: TranscriptSession[]): Promise<boolean> {
  const indexed = supportsIndexedDb()
  const read = async <T>(key: string): Promise<T | undefined> => indexed
    ? getMetaValue<T>(key)
    : JSON.parse(localStorage.getItem(`delive_${key}`) || 'null') as T | undefined
  const write = async (key: string, value: unknown): Promise<void> => {
    if (indexed) await setMetaValue(key, value)
    else localStorage.setItem(`delive_${key}`, JSON.stringify(value))
  }
  if (await read<boolean>(PROJECT_UPGRADE_COMPLETED_KEY)) return false
  const savedSnapshot = await read<{ sessions: TranscriptSession[]; topics: string | null }>(PROJECT_UPGRADE_SNAPSHOT_KEY)
  const requiresUpgrade = original.some((session) => !Array.isArray(session.projectIds) || (session.schemaVersion || 0) < 8)
  if (!requiresUpgrade && !savedSnapshot) return false
  const nextById = new Map(upgraded.map((session) => [session.id, session]))
  if (nextById.size !== original.length || upgraded.length !== original.length) throw new Error('Session ID set changed during project upgrade')
  for (const session of original) {
    const next = nextById.get(session.id)
    if (!next || (session.transcript || '') !== next.transcript
      || session.correction?.published?.correctedText !== next.correction?.published?.correctedText
      || session.correction?.legacy?.correctedText !== next.correction?.legacy?.correctedText) {
      throw new Error('Transcript content changed during project upgrade')
    }
  }
  if (!savedSnapshot) {
    const snapshot = { sessions: original, topics: localStorage.getItem(STORAGE_KEYS.TOPICS) }
    await write(PROJECT_UPGRADE_SNAPSHOT_KEY, snapshot)
    if (JSON.stringify(await read(PROJECT_UPGRADE_SNAPSHOT_KEY)) !== JSON.stringify(snapshot)) {
      throw new Error('Cannot verify Session upgrade snapshot')
    }
  }
  if (indexed) await upsertSessionsInIndexedDb(upgraded)
  else upsertLegacySessionsInLocalStorageStrict(upgraded)
  const persisted = indexed ? await readSessionsFromIndexedDb() : getLegacySessionsFromLocalStorage()
  const persistedById = new Map(persisted.map((session) => [session.id, session]))
  if (persistedById.size !== nextById.size || upgraded.some((session) => JSON.stringify(persistedById.get(session.id)) !== JSON.stringify(session))) {
    throw new Error('Project Session migration read-back failed')
  }
  await write(PROJECT_UPGRADE_COMPLETED_KEY, true)
  if (!await read<boolean>(PROJECT_UPGRADE_COMPLETED_KEY)) throw new Error('Cannot verify Session upgrade completion')
  return true
}

export async function upsertSessions(sessions: TranscriptSession[]): Promise<void> {
  const sortedSessions = sortSessions(sessions)

  if (!supportsIndexedDb()) {
    upsertLegacySessionsInLocalStorageStrict(sortedSessions)
    return
  }

  try {
    await ensureSessionMigration()
    await upsertSessionsInIndexedDb(sortedSessions)
  } catch (error) {
    console.error('Failed to upsert sessions in IndexedDB, falling back to localStorage:', error)
    upsertLegacySessionsInLocalStorageStrict(sortedSessions)
  }
}

export async function deleteSessionById(id: string): Promise<void> {
  if (!supportsIndexedDb()) {
    deleteLegacySessionFromLocalStorage(id)
    return
  }

  try {
    await ensureSessionMigration()
    await deleteSessionFromIndexedDb(id)
  } catch (error) {
    console.error('Failed to delete session from IndexedDB, falling back to localStorage:', error)
    deleteLegacySessionFromLocalStorage(id)
  }
}

export async function addSession(session: TranscriptSession): Promise<void> {
  await upsertSession(session)
}

export async function updateSession(
  id: string,
  updates: Partial<TranscriptSession>,
): Promise<void> {
  const sessions = await getSessions()
  const index = sessions.findIndex((session) => session.id === id)
  if (index !== -1) {
    await upsertSession({ ...sessions[index], ...updates, updatedAt: Date.now() })
  }
}

export async function deleteSession(id: string): Promise<void> {
  await deleteSessionById(id)
}
