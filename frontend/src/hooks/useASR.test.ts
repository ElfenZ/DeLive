import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingContextOverride } from '../types'
import type { ReactElement } from 'react'

const runtime = vi.hoisted(() => ({
  acquire: vi.fn(), captureStart: vi.fn(), captureStop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), resolve: vi.fn(),
  stateIndex: 0, states: [] as unknown[], setters: [] as ReturnType<typeof vi.fn>[],
}))
vi.mock('../stores/settingsStore', async (original) => {
  const actual = await original<typeof import('../stores/settingsStore')>()
  const store = actual.useSettingsStore
  return { ...actual, useSettingsStore: Object.assign((selector?: (state: ReturnType<typeof store.getState>) => unknown) => selector ? selector(store.getState()) : store.getState(), store) }
})
vi.mock('../stores/sessionStore', async (original) => {
  const actual = await original<typeof import('../stores/sessionStore')>()
  const store = actual.useSessionStore
  return { ...actual, useSessionStore: Object.assign((selector?: (state: ReturnType<typeof store.getState>) => unknown) => selector ? selector(store.getState()) : store.getState(), store) }
})
vi.mock('../stores/uiStore', async (original) => {
  const actual = await original<typeof import('../stores/uiStore')>()
  const store = actual.useUIStore
  return { ...actual, useUIStore: Object.assign((selector?: (state: ReturnType<typeof store.getState>) => unknown) => selector ? selector(store.getState()) : store.getState(), store) }
})
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useDebugValue: () => undefined,
  useState: (initial: unknown) => {
    const index = runtime.stateIndex++
    if (!(index in runtime.states)) runtime.states[index] = initial
    const setter = vi.fn((value: unknown) => { runtime.states[index] = typeof value === 'function' ? value(runtime.states[index]) : value })
    runtime.setters[index] = setter
    return [runtime.states[index], setter]
  },
}))
vi.mock('../services/captureManager', () => ({ CaptureManager: class {
  currentCaptureMode = 'system'
  acquireStream = runtime.acquire
  startWithStream = runtime.captureStart
  stop = runtime.captureStop
} }))
vi.mock('../services/captionBridge', () => ({ CaptionBridge: class { clear() {} } }))
vi.mock('../services/providerSession', () => ({ ProviderSessionManager: class {
  resolveSetup = runtime.resolve
  connect = runtime.connect
  disconnect = runtime.disconnect
  resetTimestampTracking() {}
} }))

describe('recording start acknowledgement and one-shot context consumption', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    for (const mock of [runtime.acquire, runtime.captureStart, runtime.captureStop, runtime.connect, runtime.disconnect, runtime.resolve]) mock.mockReset()
    runtime.stateIndex = 0
    runtime.states = []
    runtime.setters = []
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('window', {})
    runtime.acquire.mockResolvedValue({})
    runtime.captureStart.mockResolvedValue(undefined)
    runtime.connect.mockResolvedValue(undefined)
    runtime.disconnect.mockResolvedValue(undefined)
    runtime.resolve.mockImplementation((_id, _settings, meetingContext) => ({
      meetingContext, recognitionConfig: { schemaVersion: 1, providerId: 'soniox' }, connectConfig: {},
      providerInfo: { capabilities: { transport: { type: 'websocket' }, audioInputMode: 'pcm' } },
    }))
    const { useSettingsStore } = await import('../stores/settingsStore')
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, currentVendor: 'soniox', providerConfigs: { soniox: { apiKey: 'test-only' } } } })
    const { useSessionStore } = await import('../stores/sessionStore')
    useSessionStore.setState({ recordingState: 'idle', currentSessionId: null, sessions: [], currentTranscript: '', finalTranscript: '' })
    useSessionStore.getState().resetRecordingTimeline()
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  const override: MeetingContextOverride = { mode: 'override', config: { background: 'One-shot meeting' } }

  it('returns false on source cancellation without connecting or allocating a session', async () => {
    const { useASR } = await import('./useASR')
    const { useSessionStore } = await import('../stores/sessionStore')
    runtime.acquire.mockRejectedValueOnce(new DOMException('cancelled', 'NotAllowedError'))
    expect(await useASR().startRecording(override)).toBe(false)
    expect(runtime.connect).not.toHaveBeenCalled()
    expect(useSessionStore.getState().currentSessionId).toBeNull()
    expect(useSessionStore.getState().recordingState).toBe('idle')
  })
  it('acknowledges success only after source selection, connection and capture; freezes the supplied context', async () => {
    const order: string[] = []
    runtime.acquire.mockImplementationOnce(async () => { order.push('source'); return {} })
    runtime.connect.mockImplementationOnce(async () => { order.push('connect') })
    runtime.captureStart.mockImplementationOnce(async () => { order.push('capture') })
    const { useASR } = await import('./useASR')
    const { useSessionStore } = await import('../stores/sessionStore')
    expect(await useASR({ onStarted: () => order.push('started') }).startRecording(override)).toBe(true)
    expect(order).toEqual(['source', 'connect', 'capture', 'started'])
    expect(useSessionStore.getState().recordingState).toBe('recording')
    expect(runtime.resolve.mock.calls[0][2].background).toBe('One-shot meeting')
    expect(await useASR().startRecording(override)).toBe(false)
  })
  it('returns false on connection failure and restores idle rather than acknowledging a start', async () => {
    const { useASR } = await import('./useASR')
    const { useSessionStore } = await import('../stores/sessionStore')
    runtime.connect.mockRejectedValueOnce(new Error('failed connection'))
    const started = vi.fn()
    expect(await useASR({ onStarted: started }).startRecording(override)).toBe(false)
    expect(started).not.toHaveBeenCalled()
    expect(runtime.captureStop).toHaveBeenCalled()
    expect(runtime.disconnect).toHaveBeenCalled()
    expect(useSessionStore.getState().recordingState).toBe('idle')
  })

  function findElement(node: unknown, predicate: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | undefined {
    if (!node || typeof node !== 'object' || !('props' in node)) return undefined
    const element = node as ReactElement<Record<string, unknown>>
    if (predicate(element)) return element
    for (const child of [element.props.children].flat()) {
      const result = findElement(child, predicate)
      if (result) return result
    }
    return undefined
  }
  async function controlHarness(startRecording: () => Promise<boolean>) {
    runtime.states = [false, override]
    const { RecordingControls } = await import('../components/RecordingControls')
    const { useUIStore } = await import('../stores/uiStore')
    const tree = RecordingControls({ startRecording, onError: vi.fn(), pauseRecording: async () => {}, resumeRecording: async () => {}, stopRecording: async () => null })
    const start = findElement(tree, (element) => element.props['aria-label'] === useUIStore.getState().t.recording.startRecording)
    expect(start).toBeTruthy()
    return start!.props.onClick as () => void
  }
  it('retains one-shot input on cancel/failure and consumes it only after success', async () => {
    const cancelled = vi.fn(async () => false)
    const click = await controlHarness(cancelled)
    click()
    await Promise.resolve()
    expect(runtime.states[1]).toBe(override)
    expect(runtime.setters[1]).not.toHaveBeenCalled()
    runtime.stateIndex = 0
    const start = vi.fn(async () => true)
    const clickSuccess = await controlHarness(start)
    clickSuccess()
    await Promise.resolve()
    expect(start).toHaveBeenCalledWith(override)
    expect(runtime.states[1]).toEqual({ mode: 'inherit' })
  })
  it('does not clear a newer context entered while startup is pending', async () => {
    let finish!: (value: boolean) => void
    const click = await controlHarness(() => new Promise((resolve) => { finish = resolve }))
    click()
    const newer = { mode: 'clear' }
    runtime.states[1] = newer
    finish(true)
    await Promise.resolve()
    expect(runtime.states[1]).toBe(newer)
  })
})
