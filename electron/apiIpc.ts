import type { BrowserWindow, IpcMain, IpcMainEvent, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ApiSessionFilter } from '../shared/apiTypes'
import type {
  ApiRecordingStatus,
  ApiTagData,
  ApiTopicData,
  SessionDetail,
  SessionSummary,
} from '../shared/electronApi'
import { broadcastSessionEvent } from './apiBroadcast'

interface RegisterApiIpcOptions {
  ipcMain: IpcMain
  getMainWindow: () => BrowserWindow | null
}

type PendingResolver = {
  channel: string
  sender: WebContents
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingRequests = new Map<string, PendingResolver>()

let _getMainWindow: () => BrowserWindow | null = () => null

const IPC_TIMEOUT_MS = 5000

function requestRenderer<T>(channel: string, fallback: T, args: unknown[] = [], filter?: ApiSessionFilter): Promise<T> {
  const win = _getMainWindow()
  if (!win || win.isDestroyed()) return Promise.resolve(fallback)
  const requestId = randomUUID()
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve(fallback)
    }, IPC_TIMEOUT_MS)
    pendingRequests.set(requestId, { channel, sender: win.webContents, resolve: value => resolve(value as T), timer })
    try {
      win.webContents.send(channel, ...args, requestId, ...(filter ? [filter] : []))
    } catch {
      clearTimeout(timer)
      pendingRequests.delete(requestId)
      resolve(fallback)
    }
  })
}

function resolvePending(channel: string, event: IpcMainEvent, requestId: string, value: unknown): void {
  const pending = pendingRequests.get(requestId)
  const win = _getMainWindow()
  if (!pending || pending.channel !== channel || pending.sender !== event.sender
    || !win || win.isDestroyed() || win.webContents !== event.sender) return
  clearTimeout(pending.timer)
  pendingRequests.delete(requestId)
  pending.resolve(value)
}

export function requestSessions(filter?: ApiSessionFilter): Promise<SessionSummary[]> {
  return requestRenderer('api-get-sessions', [], [], filter)
}

export function requestSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  return requestRenderer('api-get-session-detail', null, [sessionId])
}

export function requestSearchSessions(query: string, filter?: ApiSessionFilter): Promise<SessionSummary[]> {
  return requestRenderer('api-search-sessions', [], [query], filter)
}

export function requestTopics(): Promise<ApiTopicData[]> {
  return requestRenderer('api-get-topics', [])
}

export function requestTags(): Promise<ApiTagData[]> {
  return requestRenderer('api-get-tags', [])
}

export function requestRecordingStatus(): Promise<ApiRecordingStatus> {
  const fallback: ApiRecordingStatus = { isRecording: false, currentSessionId: null, recordingState: 'idle' }
  return requestRenderer('api-get-recording-status', fallback)
}

export function registerApiIpc({ ipcMain, getMainWindow }: RegisterApiIpcOptions): void {
  _getMainWindow = getMainWindow

  ipcMain.on('api-notify-session-start', (event, sessionId: string) => {
    if (event.sender !== getMainWindow()?.webContents) return
    broadcastSessionEvent('session-start', sessionId)
  })

  ipcMain.on('api-notify-session-end', (event, sessionId: string) => {
    if (event.sender !== getMainWindow()?.webContents) return
    broadcastSessionEvent('session-end', sessionId)
  })

  ipcMain.on('api-respond-sessions', (event, sessions: SessionSummary[], requestId: string) => {
    resolvePending('api-get-sessions', event, requestId, sessions)
  })

  ipcMain.on('api-respond-session-detail', (event, session: SessionDetail | null, requestId: string) => {
    resolvePending('api-get-session-detail', event, requestId, session)
  })

  ipcMain.on('api-respond-search-sessions', (event, sessions: SessionSummary[], requestId: string) => {
    resolvePending('api-search-sessions', event, requestId, sessions)
  })

  ipcMain.on('api-respond-topics', (event, topics: ApiTopicData[], requestId: string) => {
    resolvePending('api-get-topics', event, requestId, topics)
  })

  ipcMain.on('api-respond-tags', (event, tags: ApiTagData[], requestId: string) => {
    resolvePending('api-get-tags', event, requestId, tags)
  })

  ipcMain.on('api-respond-recording-status', (event, status: ApiRecordingStatus, requestId: string) => {
    resolvePending('api-get-recording-status', event, requestId, status)
  })
}
