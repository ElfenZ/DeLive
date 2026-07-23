/**
 * 火山引擎 ASR Provider 实现
 * 
 * 由于浏览器原生 WebSocket 不支持自定义 HTTP Headers，
 * 而火山引擎需要通过 Headers 传递认证信息，
 * 因此通过本地代理服务器转发 WebSocket 连接。
 */

import { BaseASRProvider } from '../base'
import type {
  ASRProviderInfo,
  ProviderConfig,
  ASRVendor,
} from '../../types/asr'
import { getProxyWebSocketUrl } from '../../utils/proxyUrl'
import {
  buildVolcProxySearchParams,
  createVolcRealtimeState,
  reduceVolcRealtimeMessage,
  type VolcRealtimeState,
} from '../volcRealtime'

export class VolcProvider extends BaseASRProvider {
  readonly id: ASRVendor = 'volc' as ASRVendor

  readonly info: ASRProviderInfo = {
    id: 'volc' as ASRVendor,
    name: '火山引擎',
    description: '字节跳动旗下语音识别服务，支持中文优化，实时 + 文件转录',
    type: 'cloud',
    supportsStreaming: true,
    capabilities: {
      audioInputMode: 'pcm16',
      audioProfile: {
        payloadFormat: 'pcm16',
        sampleRateHz: 16000,
        channels: 1,
        preferredChunkMs: 100,
      },
      transport: {
        type: 'realtime',
        captureRestartStrategy: 'reuse-session',
      },
      prompting: {
        supportsLanguageHints: true,
      },
      timestamps: {
        supportsTokenTimestamps: true,
        supportsSegmentTimestamps: true,
        tokenTimestampOrigin: 'connection-relative',
      },
      workloads: {
        liveCapture: {
          availability: 'implemented',
          executionMode: 'realtime-stream',
          inputSources: ['system-audio'],
          acceptedFileKinds: ['audio'],
        },
        fileTranscription: {
          availability: 'compatible',
          executionMode: 'single-request',
          inputSources: ['file'],
          acceptedFileKinds: ['audio'],
        },
      },
      supportsConfigTest: true,
      supportsSpeakerDiarization: true,
    },
    requiredConfigKeys: ['appKey', 'accessKey'],
    supportedLanguages: ['zh', 'en', 'ja', 'ko'],
    website: 'https://www.volcengine.com/product/speech',
    docsUrl: 'https://www.volcengine.com/docs/6561/80818',
    configFields: [
      {
        key: 'appKey',
        label: 'APP ID',
        type: 'password',
        required: true,
        placeholder: '输入你的 APP ID',
        description: '从火山引擎控制台获取',
      },
      {
        key: 'accessKey',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: '输入你的 Access Token',
        description: '从火山引擎控制台获取',
      },
      {
        key: 'languageHints',
        label: '语言提示',
        type: 'text',
        required: false,
        placeholder: 'zh, en',
        description: '用逗号分隔的语言代码',
      },
      {
        key: 'enableSpeakerDiarization',
        label: '启用多发言人识别',
        type: 'boolean',
        required: false,
        defaultValue: false,
        description: '使用火山服务端说话人聚类。只有服务返回多个 speaker ID 时才会分人，效果取决于音频和服务返回。',
      },
    ],
  }

  private ws: WebSocket | null = null
  private wsReady = false
  private realtimeState: VolcRealtimeState = createVolcRealtimeState()

  async connect(config: ProviderConfig): Promise<void> {
    const appKey = config.appKey as string
    const accessKey = config.accessKey as string

    if (!appKey || !accessKey) {
      this.emitError(this.createError('MISSING_CREDENTIALS', '请提供 App Key 和 Access Key'))
      return
    }

    this._config = config
    this.setState('connecting')
    this.wsReady = false
    this.realtimeState = createVolcRealtimeState(Boolean(config.enableSpeakerDiarization))

    const params = buildVolcProxySearchParams(config)
    let proxyUrl: string
    try {
      proxyUrl = await getProxyWebSocketUrl('/ws/volc', params)
    } catch (error) {
      this.realtimeState = createVolcRealtimeState()
      this.emitError(this.createError('CONNECTION_ERROR', '无法获取本地代理地址'))
      throw error
    }

    return new Promise((resolve, reject) => {
      let connectSettled = false
      let failureEmitted = false

      const resolveConnect = () => {
        if (connectSettled) return
        connectSettled = true
        resolve()
      }

      const rejectConnect = (error: Error) => {
        if (connectSettled) return
        connectSettled = true
        reject(error)
      }

      try {
        console.log('[VolcProvider] 连接到代理服务器...')
        
        const ws = new WebSocket(proxyUrl)
        this.ws = ws

        const failConnection = (code: string, message: string, error = new Error(message)) => {
          if (failureEmitted) return
          failureEmitted = true
          this.wsReady = false
          this.realtimeState = createVolcRealtimeState()
          this.emitError(this.createError(code, message))
          rejectConnect(error)
          try {
            ws.close(1000, 'connection error')
          } catch {
            // The socket may already be closing after a transport error.
          }
        }

        ws.onopen = () => {
          console.log('[VolcProvider] 代理连接已建立，等待火山引擎就绪...')
        }

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            
            switch (msg.type) {
              case 'ready':
                console.log('[VolcProvider] 火山引擎已就绪')
                this.wsReady = true
                this.setState('connected')
                resolveConnect()
                break
                
              case 'partial':
              case 'final':
                this.handleTranscriptMessage(msg)
                break
                
              case 'error':
                console.error('[VolcProvider] 服务器错误:', msg.code, msg.message)
                failConnection('SERVER_ERROR', msg.message || '服务器错误')
                break
            }
          } catch (e) {
            console.error('[VolcProvider] 解析消息失败:', e)
          }
        }

        ws.onerror = (error) => {
          console.error('[VolcProvider] WebSocket 错误:', error)
          failConnection(
            'WEBSOCKET_ERROR',
            'WebSocket 连接错误，请确保服务器已启动',
            new Error('WebSocket 连接错误'),
          )
        }

        ws.onclose = (event) => {
          console.log('[VolcProvider] WebSocket 关闭:', event.code, event.reason)
          if (!connectSettled && !failureEmitted) {
            failureEmitted = true
            const message = event.reason || '连接在火山引擎就绪前关闭'
            this.emitError(this.createError('CONNECTION_CLOSED', message))
            rejectConnect(new Error(message))
          }
          if (this.ws === ws) this.ws = null
          this.wsReady = false
          this.realtimeState = createVolcRealtimeState()
          this.setState('idle')
        }
      } catch (error) {
        console.error('[VolcProvider] 连接失败:', error)
        this.realtimeState = createVolcRealtimeState()
        this.emitError(this.createError('CONNECTION_ERROR', '连接失败'))
        rejectConnect(error instanceof Error ? error : new Error('连接失败'))
      }
    })
  }

  async disconnect(): Promise<void> {
    console.log('[VolcProvider] 断开连接...')
    
    if (this.ws && this.wsReady) {
      // 发送音频结束标记
      this.ws.send(JSON.stringify({ type: 'audio_end' }))
    }

    // 等待一小段时间让最终结果返回
    await this.waitForDisconnectGrace()
    
    if (this.ws) {
      this.ws.close(1000, 'disconnect')
      this.ws = null
    }

    this.wsReady = false
    this.realtimeState = createVolcRealtimeState()
    this.setState('idle')
  }

  sendAudio(data: Blob | ArrayBuffer): void {
    if (!this.ws || !this.wsReady) {
      console.warn('[VolcProvider] WebSocket 未就绪，无法发送音频')
      return
    }

    this.setState('recording')

    if (data instanceof Blob) {
      data.arrayBuffer().then(buffer => {
        this.ws?.send(buffer)
      })
    } else {
      this.ws.send(data)
    }
  }

  private handleTranscriptMessage(message: unknown): void {
    const reduction = reduceVolcRealtimeMessage(this.realtimeState, message)
    this.realtimeState = reduction.state

    switch (reduction.event?.type) {
      case 'tokens':
        this.emitTokens(reduction.event.tokens)
        break
      case 'partial-text':
        this.emitPartial(reduction.event.text)
        break
      case 'final-text':
        this.emitFinal(reduction.event.text)
        break
    }

    if (reduction.terminal) this.emitFinished()
  }
}
