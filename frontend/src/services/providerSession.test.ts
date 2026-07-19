import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASRVendor, type ASRProviderInfo, type ASRTimestampOrigin, type ProviderConfig } from '../types/asr'
import { BaseASRProvider } from '../providers/base'
import {
  PROVIDER_DRAIN_TIMEOUT_MS,
  ProviderSessionManager,
  type ProviderSessionCallbacks,
} from './providerSession'

vi.mock('../providers', () => ({
  createProvider: vi.fn(),
  providerRegistry: { getInfo: vi.fn() },
}))

import { createProvider } from '../providers'

const createProviderMock = vi.mocked(createProvider)

class TestProvider extends BaseASRProvider {
  readonly id = ASRVendor.Soniox
  readonly info: ASRProviderInfo
  disconnectImpl: (() => Promise<void>) | null = null

  constructor(timestampOrigin: ASRTimestampOrigin = 'none') {
    super()
    this.info = {
      id: ASRVendor.Soniox,
      name: 'Test provider',
      description: 'Test provider',
      type: 'cloud',
      supportsStreaming: true,
      capabilities: {
        audioInputMode: 'media-recorder',
        transport: { type: 'realtime' },
        timestamps: { tokenTimestampOrigin: timestampOrigin },
      },
      requiredConfigKeys: [],
      supportedLanguages: ['en'],
      website: 'https://example.com',
      configFields: [],
    }
  }

  async connect(_config: ProviderConfig): Promise<void> {
    this.setState('connected')
  }

  async disconnect(): Promise<void> {
    await this.disconnectImpl?.()
    this.setState('idle')
  }

  sendAudio(_data: Blob | ArrayBuffer): void {
    // No-op for lifecycle tests.
  }

  emitTokensForTest(tokens: Parameters<typeof this.emitTokens>[0]): void {
    this.emitTokens(tokens)
  }

  emitPartialForTest(text: string): void {
    this.emitPartial(text)
  }

  emitFinalForTest(text: string): void {
    this.emitFinal(text)
  }

  emitErrorForTest(code: string, message: string): void {
    this.emitError(this.createError(code, message))
  }

  emitFinishedForTest(): void {
    this.emitFinished()
  }
}

function createCallbacks(): ProviderSessionCallbacks {
  return {
    onTokens: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onFinished: vi.fn(),
  }
}

describe('ProviderSessionManager', () => {
  beforeEach(() => {
    createProviderMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('delivers delayed final events before disconnect cleanup', async () => {
    const provider = new TestProvider()
    provider.disconnectImpl = async () => {
      setTimeout(() => {
        provider.emitFinalForTest('tail')
        provider.emitFinishedForTest()
      }, 10)
    }
    createProviderMock.mockReturnValue(provider)
    const callbacks = createCallbacks()
    const manager = new ProviderSessionManager()

    await manager.connect(ASRVendor.Soniox, {}, callbacks)
    const result = await manager.disconnect()

    expect(result.status).toBe('finished')
    expect(callbacks.onFinal).toHaveBeenCalledWith('tail')
    expect(callbacks.onFinished).toHaveBeenCalledTimes(1)
    expect(manager.currentProvider).toBeNull()
  })

  it('does not treat ordinary final segments as drain completion', async () => {
    vi.useFakeTimers()
    const provider = new TestProvider()
    provider.disconnectImpl = async () => {
      setTimeout(() => provider.emitFinalForTest('first'), 10)
      setTimeout(() => provider.emitFinalForTest('second'), 1_000)
      setTimeout(() => provider.emitFinishedForTest(), 1_500)
    }
    createProviderMock.mockReturnValue(provider)
    const callbacks = createCallbacks()
    const manager = new ProviderSessionManager()

    await manager.connect(ASRVendor.Soniox, {}, callbacks)
    const closing = manager.disconnect()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(callbacks.onFinal).toHaveBeenNthCalledWith(1, 'first')
    expect(callbacks.onFinal).toHaveBeenNthCalledWith(2, 'second')
    expect(manager.currentProvider).toBe(provider)

    await vi.advanceTimersByTimeAsync(400)
    await expect(closing).resolves.toMatchObject({ status: 'finished' })
  })

  it('cleans up after the bounded drain timeout and fences late events', async () => {
    vi.useFakeTimers()
    const provider = new TestProvider()
    createProviderMock.mockReturnValue(provider)
    const callbacks = createCallbacks()
    const manager = new ProviderSessionManager()

    await manager.connect(ASRVendor.Soniox, {}, callbacks)
    const closing = manager.disconnect()
    await vi.advanceTimersByTimeAsync(PROVIDER_DRAIN_TIMEOUT_MS)
    const result = await closing
    provider.emitFinalForTest('too late')

    expect(result.status).toBe('timeout')
    expect(manager.currentProvider).toBeNull()
    expect(callbacks.onFinal).not.toHaveBeenCalled()
  })

  it('returns expected close-time errors instead of forwarding them to onError', async () => {
    const provider = new TestProvider()
    provider.disconnectImpl = async () => {
      provider.emitErrorForTest('CLOSE_EXPECTED', 'connection closing')
      provider.emitFinishedForTest()
    }
    createProviderMock.mockReturnValue(provider)
    const callbacks = createCallbacks()
    const manager = new ProviderSessionManager()

    await manager.connect(ASRVendor.Soniox, {}, callbacks)
    const result = await manager.disconnect()

    expect(result.status).toBe('finished')
    expect(result.expectedErrors).toEqual([
      { code: 'CLOSE_EXPECTED', message: 'connection closing' },
    ])
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('keeps old listeners through reconnect drain and drops events after the epoch changes', async () => {
    const oldProvider = new TestProvider()
    oldProvider.disconnectImpl = async () => {
      oldProvider.emitFinalForTest('old tail')
      oldProvider.emitFinishedForTest()
    }
    const newProvider = new TestProvider()
    createProviderMock
      .mockReturnValueOnce(oldProvider)
      .mockReturnValueOnce(newProvider)
    const oldCallbacks = createCallbacks()
    const newCallbacks = createCallbacks()
    const manager = new ProviderSessionManager()

    await manager.connect(ASRVendor.Soniox, {}, oldCallbacks)
    const oldEpoch = manager.currentConnectionEpoch
    await manager.reconnect(ASRVendor.Soniox, {}, newCallbacks)

    oldProvider.emitPartialForTest('late old partial')
    newProvider.emitPartialForTest('new partial')

    expect(oldCallbacks.onFinal).toHaveBeenCalledWith('old tail')
    expect(oldCallbacks.onPartial).not.toHaveBeenCalled()
    expect(newCallbacks.onPartial).toHaveBeenCalledWith('new partial')
    expect(manager.currentConnectionEpoch).toBeGreaterThan(oldEpoch!)
  })

  it('applies each connection-relative timestamp offset once without mutating source tokens', async () => {
    const firstProvider = new TestProvider('connection-relative')
    firstProvider.disconnectImpl = async () => firstProvider.emitFinishedForTest()
    const secondProvider = new TestProvider('connection-relative')
    createProviderMock
      .mockReturnValueOnce(firstProvider)
      .mockReturnValueOnce(secondProvider)
    const firstCallbacks = createCallbacks()
    const secondCallbacks = createCallbacks()
    const manager = new ProviderSessionManager()
    const firstToken = { text: 'first', isFinal: true, startMs: 100, endMs: 200 }
    const secondToken = { text: 'second', isFinal: true, startMs: 50, endMs: 80 }

    await manager.connect(ASRVendor.Soniox, {}, firstCallbacks, { epochOffsetMs: 1_000 })
    firstProvider.emitTokensForTest([firstToken])
    await manager.reconnect(ASRVendor.Soniox, {}, secondCallbacks, { epochOffsetMs: 5_000 })
    secondProvider.emitTokensForTest([secondToken])

    expect(firstCallbacks.onTokens).toHaveBeenCalledWith([
      { text: 'first', isFinal: true, startMs: 1_100, endMs: 1_200 },
    ])
    expect(secondCallbacks.onTokens).toHaveBeenCalledWith([
      { text: 'second', isFinal: true, startMs: 5_050, endMs: 5_080 },
    ])
    expect(firstToken).toEqual({ text: 'first', isFinal: true, startMs: 100, endMs: 200 })
    expect(secondToken).toEqual({ text: 'second', isFinal: true, startMs: 50, endMs: 80 })
    expect(manager.getMaxConfirmedTokenEndMs()).toBe(5_080)
  })
})
