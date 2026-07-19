/**
 * ProviderSessionManager — ASR Provider 会话管理
 *
 * Owns one provider connection at a time. Connection events are fenced by an
 * epoch so late events cannot escape into a newer connection.
 */

import { createProvider, providerRegistry } from '../providers'
import {
  buildProviderConnectConfig,
  getMissingRequiredConfigLabels,
} from '../utils/providerConfig'
import { getCaptureRestartStrategy } from '../types/asr'
import type {
  ASRProvider,
  ASRVendor,
  ASRProviderInfo,
  ProviderConfig,
  ProviderConnectionOptions,
  TranscriptToken,
  ASRError,
  ASRTimestampOrigin,
  CaptureRestartStrategy,
} from '../types/asr'
import type { AppSettings, ProviderConfigData } from '../types'

export const PROVIDER_DRAIN_TIMEOUT_MS = 2_000

export interface ProviderSessionCallbacks {
  onTokens: (tokens: TranscriptToken[]) => void
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError: (error: ASRError) => void
  onFinished: () => void
}

export interface ProviderSetup {
  providerInfo: ASRProviderInfo
  connectConfig: ProviderConfig
  captureRestartStrategy: CaptureRestartStrategy
}

export type ProviderSessionDrainStatus = 'no-provider' | 'finished' | 'timeout'

/**
 * Expected close-time failures are reported here instead of onError, because
 * callers intentionally requested the connection to close.
 */
export interface ProviderSessionDisconnectResult {
  status: ProviderSessionDrainStatus
  expectedErrors: ASRError[]
  drainError?: unknown
  disconnectError?: unknown
}

interface ProviderConnection {
  provider: ASRProvider
  callbacks: ProviderSessionCallbacks
  epoch: number
  epochOffsetMs: number
  timestampOrigin: ASRTimestampOrigin
  acceptingAudio: boolean
  acceptingEvents: boolean
  draining: boolean
  terminalEventCount: number
  expectedErrors: ASRError[]
  waitForTerminal?: (received: boolean) => void
  drainError?: unknown
  disconnectError?: unknown
  disconnectPromise?: Promise<void>
  closePromise?: Promise<ProviderSessionDisconnectResult>
}

export class ProviderSessionManager {
  private connection: ProviderConnection | null = null
  private nextEpoch = 0
  private maxConfirmedTokenEndMs = 0

  get currentProvider(): ASRProvider | null {
    return this.connection?.provider ?? null
  }

  get currentConnectionEpoch(): number | null {
    return this.connection?.epoch ?? null
  }

  /** Absolute end timestamp from final tokens observed by this manager. */
  getMaxConfirmedTokenEndMs(): number {
    return this.maxConfirmedTokenEndMs
  }

  /** Starts a new session-level timestamp baseline when the caller starts a new recording. */
  resetTimestampTracking(): void {
    this.maxConfirmedTokenEndMs = 0
  }

  /**
   * 解析 vendor 配置、校验必填字段。
   * 抛出 Error 表示配置不完整。
   */
  resolveSetup(vendorId: ASRVendor, settings: AppSettings): ProviderSetup {
    const providerInfo = providerRegistry.getInfo(vendorId)
    if (!providerInfo) {
      throw new Error(`未找到提供商: ${vendorId}`)
    }

    const providerConfig = settings.providerConfigs?.[vendorId]
    const connectConfig = buildProviderConnectConfig(providerInfo, providerConfig, settings)

    const missingLabels = getMissingRequiredConfigLabels(
      providerInfo,
      connectConfig as ProviderConfigData,
    )
    if (missingLabels.length > 0) {
      throw new Error(`Please configure: ${missingLabels.join(', ')}`)
    }

    return {
      providerInfo,
      connectConfig,
      captureRestartStrategy: getCaptureRestartStrategy(providerInfo.capabilities),
    }
  }

  /** 创建 Provider 实例、注册事件、建立连接。 */
  async connect(
    vendorId: ASRVendor,
    connectConfig: ProviderConfig,
    callbacks: ProviderSessionCallbacks,
    options: ProviderConnectionOptions = {},
  ): Promise<ASRProvider> {
    if (this.connection) {
      await this.disconnect()
    }

    const provider = createProvider(vendorId)
    if (!provider) {
      throw new Error(`未找到提供商: ${vendorId}`)
    }

    const connection: ProviderConnection = {
      provider,
      callbacks,
      epoch: ++this.nextEpoch,
      epochOffsetMs: normalizeEpochOffset(options.epochOffsetMs),
      timestampOrigin: provider.info.capabilities.timestamps?.tokenTimestampOrigin ?? 'none',
      acceptingAudio: true,
      acceptingEvents: true,
      draining: false,
      terminalEventCount: 0,
      expectedErrors: [],
    }
    this.connection = connection
    this.bindListeners(connection)

    console.log('[ProviderSession] 连接 Provider...', { epoch: connection.epoch })
    try {
      await provider.connect(connectConfig)
      return provider
    } catch (error) {
      this.cleanupConnection(connection)
      throw error
    }
  }

  /** 断开旧连接并重新建立新连接（用于同 Provider 参数热切换）。 */
  async reconnect(
    vendorId: ASRVendor,
    connectConfig: ProviderConfig,
    callbacks: ProviderSessionCallbacks,
    options: ProviderConnectionOptions = {},
  ): Promise<ASRProvider> {
    if (this.connection) {
      // Keep listeners bound through the close path so the old provider can
      // deliver its final result. The epoch fence drops anything after cleanup.
      await this.disconnect()
    }

    console.log('[ProviderSession] 重连 Provider（配置热切换）...')
    return this.connect(vendorId, connectConfig, callbacks, options)
  }

  /**
   * Stops new audio immediately, preserves listeners while final/finished
   * events arrive, then disconnects and cleans up. The complete operation is
   * bounded by PROVIDER_DRAIN_TIMEOUT_MS.
   */
  async drain(): Promise<ProviderSessionDisconnectResult> {
    return this.disconnect()
  }

  /** Backwards-compatible close API. Callers may ignore the returned result. */
  async disconnect(): Promise<ProviderSessionDisconnectResult> {
    const connection = this.connection
    if (!connection) {
      return { status: 'no-provider', expectedErrors: [] }
    }

    if (!connection.closePromise) {
      connection.closePromise = this.closeConnection(connection)
    }
    return connection.closePromise
  }

  /** 向 Provider 发送音频数据。收尾开始后不再接收新音频。 */
  sendAudio(data: Blob | ArrayBuffer): void {
    const connection = this.connection
    if (!connection || !connection.acceptingAudio) {
      return
    }
    connection.provider.sendAudio(data)
  }

  // ── 内部实现 ──────────────────────────────────────────

  private async closeConnection(connection: ProviderConnection): Promise<ProviderSessionDisconnectResult> {
    connection.acceptingAudio = false
    connection.draining = true
    const terminalEventCount = connection.terminalEventCount
    const deadline = Date.now() + PROVIDER_DRAIN_TIMEOUT_MS

    if (connection.provider.drain) {
      const drainPromise = Promise.resolve()
        .then(() => connection.provider.drain!())
        .catch(error => {
          connection.drainError = error
        })
      await this.waitForSettlement(drainPromise, this.remainingDrainTime(deadline))
    }

    // Providers without drain() retain their existing vendor shutdown protocol.
    // Listener removal deliberately happens only after this bounded wait.
    this.startDisconnect(connection)
    const receivedTerminal = await this.waitForTerminal(
      connection,
      terminalEventCount,
      this.remainingDrainTime(deadline),
    )

    if (receivedTerminal && connection.disconnectPromise) {
      await this.waitForSettlement(
        connection.disconnectPromise,
        this.remainingDrainTime(deadline),
      )
    }

    // Surface immediately rejected disconnect calls in the structured result
    // without allowing them to reach the recording-level onError callback.
    await Promise.resolve()

    const result: ProviderSessionDisconnectResult = {
      status: receivedTerminal ? 'finished' : 'timeout',
      expectedErrors: [...connection.expectedErrors],
      ...(connection.drainError === undefined ? {} : { drainError: connection.drainError }),
      ...(connection.disconnectError === undefined ? {} : { disconnectError: connection.disconnectError }),
    }
    this.cleanupConnection(connection)
    return result
  }

  private startDisconnect(connection: ProviderConnection): void {
    if (connection.disconnectPromise) {
      return
    }

    connection.disconnectPromise = Promise.resolve()
      .then(() => connection.provider.disconnect())
      .catch(error => {
        connection.disconnectError = error
      })
  }

  private waitForSettlement(promise: Promise<void>, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) {
      return Promise.resolve()
    }

    return new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs)
      void promise.finally(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private waitForTerminal(
    connection: ProviderConnection,
    terminalEventCount: number,
    timeoutMs: number,
  ): Promise<boolean> {
    if (connection.terminalEventCount > terminalEventCount) {
      return Promise.resolve(true)
    }
    if (timeoutMs <= 0) {
      return Promise.resolve(false)
    }

    return new Promise(resolve => {
      const settle = (received: boolean) => {
        clearTimeout(timer)
        if (connection.waitForTerminal === settle) {
          connection.waitForTerminal = undefined
        }
        resolve(received)
      }
      const timer = setTimeout(() => settle(false), timeoutMs)
      connection.waitForTerminal = settle
    })
  }

  private remainingDrainTime(deadline: number): number {
    return Math.max(0, deadline - Date.now())
  }

  private cleanupConnection(connection: ProviderConnection): void {
    connection.acceptingAudio = false
    connection.acceptingEvents = false
    connection.waitForTerminal?.(false)
    connection.provider.removeAllListeners()
    if (this.connection === connection) {
      this.connection = null
    }
  }

  private bindListeners(connection: ProviderConnection): void {
    const { provider } = connection

    provider.on('onTokens', (tokens: TranscriptToken[]) => {
      if (!this.shouldDispatch(connection)) return
      const normalizedTokens = this.normalizeTokenTimestamps(connection, tokens)
      this.trackConfirmedTokenEndMs(normalizedTokens)
      console.log('[ProviderSession] 收到 tokens:', normalizedTokens.length)
      connection.callbacks.onTokens(normalizedTokens)
    })

    if (!provider.info.capabilities.prefersTokenEvents) {
      provider.on('onPartial', (text: string) => {
        if (!this.shouldDispatch(connection)) return
        console.log('[ProviderSession] 收到 partial:', text.substring(0, 50))
        connection.callbacks.onPartial(text)
      })
    }

    if (!provider.info.capabilities.prefersTokenEvents) {
      provider.on('onFinal', (text: string) => {
        if (!this.shouldDispatch(connection)) return
        console.log('[ProviderSession] 收到 final:', text.substring(0, 50))
        connection.callbacks.onFinal(text)
      })
    }

    provider.on('onError', (error: ASRError) => {
      if (!this.shouldDispatch(connection)) return
      if (connection.draining) {
        connection.expectedErrors.push(error)
        console.warn('[ProviderSession] 收尾期间收到预期 Provider 错误:', error)
        return
      }
      console.error('[ProviderSession] Provider 错误:', error)
      connection.callbacks.onError(error)
    })

    provider.on('onFinished', () => {
      if (!this.shouldDispatch(connection)) return
      this.recordTerminalEvent(connection)
      console.log('[ProviderSession] 转录完成')
      connection.callbacks.onFinished()
    })
  }

  private shouldDispatch(connection: ProviderConnection): boolean {
    return this.connection === connection && connection.acceptingEvents
  }

  private recordTerminalEvent(connection: ProviderConnection): void {
    connection.terminalEventCount += 1
    connection.waitForTerminal?.(true)
  }

  private normalizeTokenTimestamps(
    connection: ProviderConnection,
    tokens: TranscriptToken[],
  ): TranscriptToken[] {
    if (connection.timestampOrigin !== 'connection-relative') {
      return tokens
    }

    return tokens.map(token => {
      const hasStartMs = Number.isFinite(token.startMs)
      const hasEndMs = Number.isFinite(token.endMs)
      if (connection.epochOffsetMs === 0 || (!hasStartMs && !hasEndMs)) {
        return token
      }
      return {
        ...token,
        ...(hasStartMs ? { startMs: token.startMs! + connection.epochOffsetMs } : {}),
        ...(hasEndMs ? { endMs: token.endMs! + connection.epochOffsetMs } : {}),
      }
    })
  }

  private trackConfirmedTokenEndMs(tokens: TranscriptToken[]): void {
    for (const token of tokens) {
      if (token.isFinal && Number.isFinite(token.endMs)) {
        this.maxConfirmedTokenEndMs = Math.max(this.maxConfirmedTokenEndMs, token.endMs!)
      }
    }
  }
}

function normalizeEpochOffset(value: number | undefined): number {
  return Number.isFinite(value) ? value! : 0
}
