import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ASRError } from '../../types/asr'
import { SonioxProvider } from './SonioxProvider'
import { VolcProvider } from './VolcProvider'

vi.mock('../../utils/proxyUrl', () => ({
  getProxyWebSocketUrl: vi.fn(async () => 'ws://localhost/ws/volc'),
}))

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  readonly url: string
  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((error: Event) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  sent: unknown[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.triggerClose(code, reason)
  }

  triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  triggerMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  triggerClose(code = 1006, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}

describe('realtime provider close handling', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports an unexpected Soniox close after the connection was established', async () => {
    const provider = new SonioxProvider()
    const errors: ASRError[] = []
    provider.on('onError', error => errors.push(error))

    const connecting = provider.connect({ apiKey: 'test-key' })
    const socket = MockWebSocket.instances[0]
    socket.triggerOpen()
    await connecting
    socket.triggerClose(1006, 'network lost')

    expect(errors).toEqual([{ code: 'CONNECTION_CLOSED', message: 'network lost' }])
  })

  it('does not report a Soniox close initiated by disconnect', async () => {
    const provider = new SonioxProvider()
    const errors: ASRError[] = []
    provider.on('onError', error => errors.push(error))

    const connecting = provider.connect({ apiKey: 'test-key' })
    MockWebSocket.instances[0].triggerOpen()
    await connecting
    await provider.disconnect()

    expect(errors).toEqual([])
  })

  it('reports an unexpected Volc close after the provider becomes ready', async () => {
    const provider = new VolcProvider()
    const errors: ASRError[] = []
    provider.on('onError', error => errors.push(error))

    const connecting = provider.connect({ appKey: 'app', accessKey: 'token' })
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1))
    const socket = MockWebSocket.instances[0]
    socket.triggerOpen()
    socket.triggerMessage({ type: 'ready' })
    await connecting
    socket.triggerClose(1006, 'proxy lost')

    expect(errors).toEqual([{ code: 'CONNECTION_CLOSED', message: 'proxy lost' }])
  })

  it('does not report a Volc close initiated by disconnect', async () => {
    vi.useFakeTimers()
    const provider = new VolcProvider()
    const errors: ASRError[] = []
    provider.on('onError', error => errors.push(error))

    const connecting = provider.connect({ appKey: 'app', accessKey: 'token' })
    await vi.advanceTimersByTimeAsync(0)
    const socket = MockWebSocket.instances[0]
    socket.triggerOpen()
    socket.triggerMessage({ type: 'ready' })
    await connecting

    const disconnecting = provider.disconnect()
    socket.triggerClose(1000, 'disconnect')
    await vi.runAllTimersAsync()
    await disconnecting

    expect(errors).toEqual([])
  })
})
