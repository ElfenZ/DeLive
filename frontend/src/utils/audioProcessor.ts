/**
 * 音频处理工具
 *
 * 优先使用 AudioWorklet（在独立线程中处理，不阻塞主线程）。
 * 不支持 AudioWorklet 的环境下自动回退到已废弃的 ScriptProcessorNode。
 */

export interface AudioProcessorConfig {
  sampleRate?: number
  channels?: number
  muted?: boolean
}

export class AudioProcessor {
  private audioContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private legacyProcessorNode: ScriptProcessorNode | null = null
  private outputGainNode: GainNode | null = null
  private targetSampleRate: number
  private muted: boolean
  private onAudioData: ((pcmData: ArrayBuffer) => void) | null = null
  private generation = 0

  constructor(config: AudioProcessorConfig = {}) {
    this.targetSampleRate = config.sampleRate || 16000
    this.muted = config.muted === true
  }

  async start(
    mediaStream: MediaStream,
    onAudioData: (pcmData: ArrayBuffer) => void,
  ): Promise<void> {
    this.stop()
    const generation = ++this.generation
    this.onAudioData = onAudioData

    const audioContext = new AudioContext({
      sampleRate: this.targetSampleRate,
    })
    this.audioContext = audioContext

    const actualSampleRate = audioContext.sampleRate
    console.log(`[AudioProcessor] 目标采样率: ${this.targetSampleRate}, 实际: ${actualSampleRate}`)

    const sourceNode = audioContext.createMediaStreamSource(mediaStream)
    this.sourceNode = sourceNode

    if (typeof AudioWorkletNode !== 'undefined') {
      try {
        await this.startWithWorklet(audioContext, sourceNode, generation)
        if (this.isCurrentGeneration(generation)) {
          return
        }
      } catch (err) {
        if (!this.isCurrentGeneration(generation)) {
          return
        }
        console.warn('[AudioProcessor] AudioWorklet 加载失败，回退到 ScriptProcessorNode:', err)
      }
    }

    if (this.isCurrentGeneration(generation)) {
      this.startWithScriptProcessor(audioContext, sourceNode, actualSampleRate, generation)
    }
  }

  stop(): void {
    this.generation += 1
    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      this.workletNode.disconnect()
      this.workletNode = null
    }

    if (this.legacyProcessorNode) {
      this.legacyProcessorNode.disconnect()
      this.legacyProcessorNode = null
    }

    if (this.outputGainNode) {
      this.outputGainNode.disconnect()
      this.outputGainNode = null
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect()
      this.sourceNode = null
    }

    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }

    this.onAudioData = null
    console.log('[AudioProcessor] 音频处理器已停止')
  }

  // ── AudioWorklet 路径 ────────────────────────────────

  private async startWithWorklet(
    ctx: AudioContext,
    sourceNode: MediaStreamAudioSourceNode,
    generation: number,
  ): Promise<void> {
    const url = new URL('./pcm-processor.worklet.js', window.location.href).href
    await ctx.audioWorklet.addModule(url)

    if (!this.isCurrentGeneration(generation)) {
      return
    }

    const workletNode = new AudioWorkletNode(ctx, 'pcm-processor', {
      processorOptions: { targetSampleRate: this.targetSampleRate },
    })
    this.workletNode = workletNode

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.isCurrentGeneration(generation)) {
        this.onAudioData?.(event.data)
      }
    }

    sourceNode.connect(workletNode)
    this.connectProcessorOutput(ctx, workletNode)
    console.log('[AudioProcessor] 已启动（AudioWorklet）')
  }

  // ── ScriptProcessorNode 回退路径 ──────────────────────

  private startWithScriptProcessor(
    ctx: AudioContext,
    sourceNode: MediaStreamAudioSourceNode,
    actualSampleRate: number,
    generation: number,
  ): void {
    const bufferSize = 4096
    this.legacyProcessorNode = ctx.createScriptProcessor(bufferSize, 1, 1)

    this.legacyProcessorNode.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0)

      let outputData: Float32Array
      if (actualSampleRate !== this.targetSampleRate) {
        outputData = this.resample(inputData, actualSampleRate, this.targetSampleRate)
      } else {
        outputData = inputData
      }

      const pcmData = this.float32ToPCM16(outputData)
      if (this.isCurrentGeneration(generation)) {
        this.onAudioData?.(pcmData.buffer as ArrayBuffer)
      }
    }

    sourceNode.connect(this.legacyProcessorNode)
    this.connectProcessorOutput(ctx, this.legacyProcessorNode)
    console.log('[AudioProcessor] 已启动（ScriptProcessorNode 回退模式）')
  }

  private connectProcessorOutput(
    ctx: AudioContext,
    node: AudioWorkletNode | ScriptProcessorNode,
  ): void {
    if (!this.muted) {
      node.connect(ctx.destination)
      return
    }

    const gainNode = ctx.createGain()
    gainNode.gain.value = 0
    node.connect(gainNode)
    gainNode.connect(ctx.destination)
    this.outputGainNode = gainNode
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.generation && this.audioContext !== null
  }

  // ── 共享工具方法（回退路径使用）──────────────────────

  private resample(
    inputData: Float32Array,
    inputSampleRate: number,
    outputSampleRate: number,
  ): Float32Array {
    const ratio = inputSampleRate / outputSampleRate
    const outputLength = Math.floor(inputData.length / ratio)
    const output = new Float32Array(outputLength)

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio
      const srcFloor = Math.floor(srcIndex)
      const srcCeil = Math.min(srcFloor + 1, inputData.length - 1)
      const fraction = srcIndex - srcFloor
      output[i] = inputData[srcFloor] * (1 - fraction) + inputData[srcCeil] * fraction
    }

    return output
  }

  private float32ToPCM16(float32Data: Float32Array): Int16Array {
    const pcm16 = new Int16Array(float32Data.length)
    for (let i = 0; i < float32Data.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Data[i]))
      pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF
    }
    return pcm16
  }
}

export function createAudioProcessor(config?: AudioProcessorConfig): AudioProcessor {
  return new AudioProcessor(config)
}
