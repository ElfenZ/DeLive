/**
 * Soniox ASR Provider 实现
 * 基于 WebSocket 的实时流式语音识别
 */

import { BaseASRProvider } from '../base'
import type {
  ASRProviderInfo,
  ProviderConfig,
  TranscriptToken,
  ASRVendor,
} from '../../types/asr'
import {
  SONIOX_WEBSOCKET_URL,
  type SonioxResponse,
  type SonioxToken,
} from '../../types/asr/vendors/soniox'
import { buildSonioxRealtimeRequest, parseSonioxConfig } from '../../utils/sonioxConfig'

export class SonioxProvider extends BaseASRProvider {
  readonly id: ASRVendor = 'soniox' as ASRVendor

  readonly info: ASRProviderInfo = {
    id: 'soniox' as ASRVendor,
    name: 'Soniox V5',
    description: '高精度实时语音识别，支持 60+ 种语言，可选实时翻译',
    type: 'cloud',
    supportsStreaming: true,
    capabilities: {
      audioInputMode: 'media-recorder',
      audioProfile: {
        payloadFormat: 'webm-opus',
        preferredChunkMs: 100,
      },
      transport: {
        type: 'realtime',
        captureRestartStrategy: 'reconnect-session',
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
          executionMode: 'native-job',
          inputSources: ['file'],
          acceptedFileKinds: ['audio', 'video'],
        },
      },
      prefersTokenEvents: true,
      supportsConfigTest: true,
      supportsTranslation: true,
      supportsSpeakerDiarization: true,
    },
    requiredConfigKeys: ['apiKey'],
    supportedLanguages: ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru'],
    website: 'https://soniox.com',
    docsUrl: 'https://soniox.com/docs',
    configFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: '输入你的 Soniox API Key',
        description: '从 console.soniox.com 获取',
      },
      {
        key: 'languageHints',
        label: '语言提示',
        type: 'multiselect',
        required: false,
        options: [
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英文' },
          { value: 'ja', label: '日语' },
          { value: 'ko', label: '韩语' },
          { value: 'es', label: '西班牙语' },
          { value: 'fr', label: '法语' },
          { value: 'de', label: '德语' },
        ],
        defaultValue: ['zh', 'en'],
        description: '提示可能使用的语言，提高识别准确率',
      },
      {
        key: 'languageHintsStrict',
        label: '严格限制语言提示',
        type: 'boolean',
        required: false,
        defaultValue: false,
        description: '仅识别语言提示中列出的语言；未填写语言提示时不可启用。',
        group: 'advanced',
        groupLabel: 'Soniox 高级设置',
        groupCollapsible: true,
        groupDefaultOpen: false,
        enabledWhen: { fieldKey: 'languageHints', nonEmpty: true },
      },
      {
        key: 'enableEndpointDetection',
        label: '启用端点检测',
        type: 'boolean',
        required: false,
        defaultValue: true,
        description: '检测自然停顿并形成最终字幕断句。',
        group: 'advanced',
        groupLabel: 'Soniox 高级设置',
        groupCollapsible: true,
        groupDefaultOpen: false,
      },
      {
        key: 'endpointSensitivity',
        label: '端点检测灵敏度',
        type: 'number',
        required: false,
        defaultValue: -0.5,
        min: -1,
        max: 1,
        step: 0.1,
        description: '-0.5 是会议/长对话默认值；负值会增加等待以减少碎片化断句。',
        group: 'advanced',
        groupLabel: 'Soniox 高级设置',
        groupCollapsible: true,
        groupDefaultOpen: false,
        visibleWhen: { fieldKey: 'enableEndpointDetection', equals: true },
      },
      {
        key: 'maxEndpointDelayMs',
        label: '最大端点延迟（毫秒）',
        type: 'number',
        required: false,
        min: 500,
        max: 3000,
        step: 100,
        placeholder: '使用 Soniox 默认值（2000）',
        description: '留空使用 Soniox 默认值；允许范围 500–3000 毫秒。',
        group: 'advanced',
        groupLabel: 'Soniox 高级设置',
        groupCollapsible: true,
        groupDefaultOpen: false,
        visibleWhen: { fieldKey: 'enableEndpointDetection', equals: true },
      },
      {
        key: 'endpointLatencyAdjustmentLevel',
        label: '端点延迟调整等级',
        type: 'select',
        required: false,
        options: [
          { value: '0', label: '0（默认）' },
          { value: '1', label: '1' },
          { value: '2', label: '2' },
          { value: '3', label: '3' },
        ],
        placeholder: '使用 Soniox 默认等级',
        description: 'V5 端点延迟调整等级，允许 0–3；留空使用服务默认值。',
        group: 'advanced',
        groupLabel: 'Soniox 高级设置',
        groupCollapsible: true,
        groupDefaultOpen: false,
        visibleWhen: { fieldKey: 'enableEndpointDetection', equals: true },
      },
      {
        key: 'translationEnabled',
        label: '启用实时翻译',
        type: 'boolean',
        required: false,
        defaultValue: false,
        description: '开启后，Soniox 将返回实时翻译文本。',
      },
      {
        key: 'translationTargetLanguage',
        label: '翻译目标语言',
        type: 'select',
        required: false,
        defaultValue: 'en',
        options: [
          { value: 'en', label: 'English' },
          { value: 'zh', label: '中文' },
          { value: 'ja', label: '日本語' },
          { value: 'ko', label: '한국어' },
          { value: 'es', label: 'Español' },
          { value: 'fr', label: 'Français' },
          { value: 'de', label: 'Deutsch' },
          { value: 'it', label: 'Italiano' },
          { value: 'pt', label: 'Português' },
          { value: 'ru', label: 'Русский' },
          { value: 'vi', label: 'Tiếng Việt' },
        ],
        description: '仅在启用实时翻译时生效。',
        visibleWhen: { fieldKey: 'translationEnabled', equals: true },
      },
      {
        key: 'enableSpeakerDiarization',
        label: '启用多发言人识别',
        type: 'boolean',
        required: false,
        defaultValue: false,
        description: '开启后，Soniox 会返回按说话人区分的转录结果。',
        warning: '同时启用端点检测与说话人识别可能影响说话人区分准确率。',
        warningWhen: { fieldKey: 'enableEndpointDetection', equals: true },
      },
    ],
  }

  private ws: WebSocket | null = null
  private finalTokens: TranscriptToken[] = []
  private resolveDrain: (() => void) | null = null

  async connect(config: ProviderConfig): Promise<void> {
    const effectiveConfig = parseSonioxConfig(config).value
    if (!effectiveConfig.apiKey) {
      this.emitError(this.createError('MISSING_API_KEY', '请提供 Soniox API Key'))
      return
    }
    this._config = config
    this.setState('connecting')
    this.finalTokens = []
    this.resolveDrain = null

    return new Promise((resolve, reject) => {
      try {
        console.log('[SonioxProvider] 建立 WebSocket 连接...')
        this.ws = new WebSocket(SONIOX_WEBSOCKET_URL)

        this.ws.onopen = () => {
          console.log('[SonioxProvider] WebSocket 已连接')
          
          // 发送配置
          const sonioxConfig = buildSonioxRealtimeRequest(effectiveConfig)
          
          console.log('[SonioxProvider] 发送配置:', { ...sonioxConfig, api_key: '***' })
          this.ws!.send(JSON.stringify(sonioxConfig))
          
          this.setState('connected')
          resolve()
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onerror = (error) => {
          console.error('[SonioxProvider] WebSocket 错误:', error)
          this.emitError(this.createError('WEBSOCKET_ERROR', 'WebSocket 连接错误'))
          reject(error)
        }

        this.ws.onclose = (event) => {
          console.log('[SonioxProvider] WebSocket 关闭:', event.code, event.reason)
          this.setState('idle')
        }
      } catch (error) {
        console.error('[SonioxProvider] 连接失败:', error)
        this.emitError(this.createError('CONNECTION_ERROR', '连接失败'))
        reject(error)
      }
    })
  }

  async disconnect(): Promise<void> {
    console.log('[SonioxProvider] 断开连接...')
    
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      ws.close()
    }

    this.setState('idle')
  }

  async drain(): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (this.resolveDrain) return

    await new Promise<void>((resolve) => {
      this.resolveDrain = resolve
      // Soniox uses an empty text frame to mark the end of the audio stream.
      ws.send('')
    })
  }

  sendAudio(data: Blob | ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SonioxProvider] WebSocket 未就绪，无法发送音频')
      return
    }

    this.setState('recording')
    this.ws.send(data)
  }

  private handleMessage(data: string): void {
    try {
      const response: SonioxResponse = JSON.parse(data)
      console.log('[SonioxProvider] 收到消息:', response)

      // 错误处理
      if (response.error_code) {
        console.error('[SonioxProvider] API 错误:', response.error_code, response.error_message)
        this.emitError(this.createError(
          response.error_code,
          response.error_message || 'Soniox API 错误'
        ))
        return
      }

      // 处理 tokens
      if (response.tokens && response.tokens.length > 0) {
        const { finalText, partialText, tokens } = this.processTokens(response.tokens)
        
        // 发送 tokens
        if (tokens.length > 0) {
          this.emitTokens(tokens)
        }

        // 发送部分结果
        const fullText = finalText + partialText
        if (fullText) {
          this.emitPartial(fullText)
        }
      }

      // 处理完成状态
      if (response.finished) {
        console.log('[SonioxProvider] 转录完成')
        const finalText = this.finalTokens.map(t => t.text).join('')
        this.emitFinal(finalText)
        this.emitFinished()
        this.resolveDrain?.()
        this.resolveDrain = null
        this.setState('idle')
      }
    } catch (error) {
      console.error('[SonioxProvider] 解析消息失败:', error)
    }
  }

  private processTokens(sonioxTokens: SonioxToken[]): {
    finalText: string
    partialText: string
    tokens: TranscriptToken[]
  } {
    const tokens: TranscriptToken[] = []
    let partialText = ''

    // Soniox 特殊标记列表，这些不应该显示给用户
    const specialMarkers = ['<end>', '<END>', '<fin>', '<FIN>', '<unk>', '<UNK>', '<silence>', '<SILENCE>']

    for (const st of sonioxTokens) {
      if (!st.text) continue
      
      // 过滤掉特殊标记
      if (specialMarkers.includes(st.text.trim())) {
        console.log('[SonioxProvider] 过滤特殊标记:', st.text)
        continue
      }

      const token = this.normalizeToken(st)
      tokens.push(token)

      if (st.is_final && st.translation_status !== 'translation') {
        this.finalTokens.push(token)
      } else if (!st.is_final && st.translation_status !== 'translation') {
        partialText += st.text
      }
    }

    const finalText = this.finalTokens.map(t => t.text).join('')
    return { finalText, partialText, tokens }
  }

  // 将 Soniox Token 转换为通用 Token 格式
  private normalizeToken(sonioxToken: SonioxToken): TranscriptToken {
    return {
      text: sonioxToken.text,
      isFinal: sonioxToken.is_final,
      startMs: sonioxToken.start_ms,
      endMs: sonioxToken.end_ms,
      confidence: sonioxToken.confidence,
      language: sonioxToken.language,
      speaker: sonioxToken.speaker,
      translationStatus: sonioxToken.translation_status ?? 'none',
      sourceLanguage: sonioxToken.source_language,
    }
  }
}
