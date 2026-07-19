import type { ProviderConfig } from '../types/asr'
import { RollingAudioBuffer } from '../utils/rollingAudioBuffer'
import { HypothesisBuffer, wordsToText } from '../utils/hypothesisBuffer'
import type { TimestampedWord } from '../utils/hypothesisBuffer'
import { BaseASRProvider } from './base'

type WindowedBatchScheduleMode = 'interval' | 'debounce'

export interface TimedProviderChunk<TChunk> {
  chunk: TChunk
  durationMs: number
}

export interface WindowedBatchProviderOptions {
  maxWindowMs: number
  transcribeIntervalMs: number
  scheduleMode?: WindowedBatchScheduleMode
}

export abstract class WindowedBatchTranscriptionProvider<TChunk> extends BaseASRProvider {
  private readonly audioWindow: RollingAudioBuffer<TChunk>
  private readonly transcribeIntervalMs: number
  private readonly scheduleMode: WindowedBatchScheduleMode
  private transcribeLoop: ReturnType<typeof setInterval> | null = null
  private transcribeTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight = false
  private pendingFinal = false
  private hasPendingAudio = false
  private acceptingAudio = false
  private sessionGeneration = 0
  private activeDrain: Promise<void> | null = null
  private readonly pendingAudioInputs = new Set<Promise<void>>()
  private readonly finalizationWaiters = new Set<() => void>()
  private hypothesis = new HypothesisBuffer()
  private committedText = ''
  private lastPartialText = ''
  private bufferTimeOffsetSec = 0
  private bufferTrimThresholdSec = 15

  protected constructor(options: WindowedBatchProviderOptions) {
    super()
    this.audioWindow = new RollingAudioBuffer<TChunk>(options.maxWindowMs)
    this.transcribeIntervalMs = options.transcribeIntervalMs
    this.scheduleMode = options.scheduleMode ?? 'interval'
  }

  protected beginWindowedSession(config: ProviderConfig): void {
    this._config = config
    this.resetWindowedSession()
    this.sessionGeneration += 1
    this.acceptingAudio = true
    this.setState('connected')
  }

  protected endWindowedSession(): void {
    this.acceptingAudio = false
    this.sessionGeneration += 1
    this.setState('idle')
    this.resetWindowedSession()
    this._config = null
    this.resolveFinalizationWaiters()
  }

  protected getBufferedChunks(): TChunk[] {
    return this.audioWindow.getItems()
  }

  protected getActiveConfig(): ProviderConfig | null {
    return this._config
  }

  protected createTranscriptionError(message: string) {
    return this.createError('TRANSCRIPTION_ERROR', message)
  }

  protected shouldEmitErrorOnNonFinalTranscriptionFailure(): boolean {
    return true
  }

  protected shouldRetryAfterNonFinalTranscriptionFailure(): boolean {
    return false
  }

  protected handleAudioInputError(error: unknown): void {
    console.error(`[${this.id}] 处理音频输入失败:`, error)
  }

  protected abstract resolveAudioChunk(
    data: Blob | ArrayBuffer,
  ): Promise<TimedProviderChunk<TChunk> | null>

  protected abstract transcribeWindow(
    chunks: TChunk[],
    config: ProviderConfig,
    prompt?: string,
  ): Promise<TimestampedWord[]>

  protected isWindowSilent(_chunks: TChunk[]): boolean {
    return false
  }

  async disconnect(): Promise<void> {
    await this.drain()
  }

  /**
   * Stops accepting audio, waits for already accepted inputs, then flushes
   * the final rolling window. ProviderSessionManager supplies the outer
   * timeout so a slow batch API cannot block session cleanup indefinitely.
   */
  async drain(): Promise<void> {
    if (this.activeDrain) {
      return this.activeDrain
    }

    if (!this._config) {
      return
    }

    this.acceptingAudio = false
    this.clearScheduler()
    const generation = this.sessionGeneration

    const drain = (async () => {
      await Promise.allSettled([...this.pendingAudioInputs])
      if (generation !== this.sessionGeneration) {
        return
      }

      if (!this.audioWindow.hasData() && !this.inFlight) {
        this.emitFinished()
        this.endWindowedSession()
        return
      }

      this.pendingFinal = true
      await this.transcribe(true)
    })()

    this.activeDrain = drain
    void drain.finally(() => {
      if (this.activeDrain === drain) {
        this.activeDrain = null
      }
    })
    return drain
  }

  sendAudio(data: Blob | ArrayBuffer): void {
    if (!this._config || !this.acceptingAudio) {
      console.warn(`[${this.id}] 未连接，忽略音频数据`)
      return
    }

    this.setState('recording')
    const task = this.enqueueAudio(data, this.sessionGeneration)
    this.pendingAudioInputs.add(task)
    void task.finally(() => this.pendingAudioInputs.delete(task))
  }

  private async enqueueAudio(data: Blob | ArrayBuffer, generation: number): Promise<void> {
    try {
      const resolved = await this.resolveAudioChunk(data)
      if (!resolved || resolved.durationMs <= 0 || generation !== this.sessionGeneration) {
        return
      }

      this.audioWindow.add(resolved.chunk, resolved.durationMs)
      this.hasPendingAudio = true
      this.scheduleTranscribe()
    } catch (error) {
      this.handleAudioInputError(error)
    }
  }

  private scheduleTranscribe(): void {
    if (this.scheduleMode === 'debounce') {
      this.clearDebounceTimer()
      this.transcribeTimer = setTimeout(() => {
        void this.transcribe(false)
      }, this.transcribeIntervalMs)
      return
    }

    if (this.transcribeLoop) {
      return
    }

    this.transcribeLoop = setInterval(() => {
      if (this.inFlight || !this.hasPendingAudio || this.pendingFinal) {
        return
      }

      void this.transcribe(false)
    }, this.transcribeIntervalMs)
  }

  private clearScheduler(): void {
    if (this.transcribeLoop) {
      clearInterval(this.transcribeLoop)
      this.transcribeLoop = null
    }

    this.clearDebounceTimer()
  }

  private clearDebounceTimer(): void {
    if (this.transcribeTimer) {
      clearTimeout(this.transcribeTimer)
      this.transcribeTimer = null
    }
  }

  private async transcribe(isFinal: boolean): Promise<void> {
    if (this.inFlight) {
      if (isFinal) {
        this.pendingFinal = true
        await this.waitForFinalization()
      }
      return
    }

    const config = this._config
    if (!config || !this.audioWindow.hasData()) {
      if (isFinal) {
        this.endWindowedSession()
      }
      return
    }

    this.inFlight = true
    this.hasPendingAudio = false
    let shouldRunFinalPass = false

    const chunks = this.audioWindow.getItems()
    if (!isFinal) {
      const recentChunks = this.audioWindow.getRecentItems(3000)
      if (recentChunks.length > 0 && this.isWindowSilent(recentChunks)) {
        this.inFlight = false
        return
      }
    }

    try {
      const prompt = this.committedText.length > 0
        ? this.committedText.slice(-200)
        : undefined
      const words = await this.transcribeWindow(chunks, config, prompt)

      this.hypothesis.insert(words, this.bufferTimeOffsetSec)
      const committed = isFinal
        ? [...this.hypothesis.flush(), ...this.hypothesis.complete()]
        : this.hypothesis.flush()

      if (committed.length > 0) {
        const text = wordsToText(committed)
        this.committedText += text
        this.emitFinal(text)
      }

      if (!isFinal) {
        const incomplete = this.hypothesis.complete()
        const partialText = wordsToText(incomplete)
        if (partialText !== this.lastPartialText) {
          this.lastPartialText = partialText
          if (partialText) {
            this.emitPartial(partialText)
          }
        }

        this.tryTrimBuffer()
      }

      if (isFinal) {
        this.lastPartialText = ''
        this.emitFinished()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '转录失败'
      console.error(`[${this.id}] 转录失败:`, error)

      if (isFinal || this.shouldEmitErrorOnNonFinalTranscriptionFailure()) {
        this.emitError(this.createTranscriptionError(message))
      }

      if (!isFinal && this.shouldRetryAfterNonFinalTranscriptionFailure()) {
        this.hasPendingAudio = true
      }
    } finally {
      this.inFlight = false

      if (this.pendingFinal && !isFinal) {
        this.pendingFinal = false
        shouldRunFinalPass = true
      } else if (isFinal) {
        this.endWindowedSession()
      }
    }

    if (shouldRunFinalPass) {
      await this.transcribe(true)
    }
  }

  private tryTrimBuffer(): void {
    const durationSec = this.audioWindow.getDurationMs() / 1000
    if (durationSec <= this.bufferTrimThresholdSec) {
      return
    }

    const lastTime = this.hypothesis.getLastCommittedTime()
    if (lastTime <= this.bufferTimeOffsetSec) {
      return
    }

    const trimAtSec = lastTime
    const trimMs = (trimAtSec - this.bufferTimeOffsetSec) * 1000
    this.audioWindow.trimByDuration(trimMs)
    this.hypothesis.popCommitted(trimAtSec)
    this.bufferTimeOffsetSec = trimAtSec
  }

  private resetWindowedSession(): void {
    this.clearScheduler()
    this.audioWindow.clear()
    this.inFlight = false
    this.pendingFinal = false
    this.hasPendingAudio = false
    this.hypothesis.reset()
    this.committedText = ''
    this.lastPartialText = ''
    this.bufferTimeOffsetSec = 0
  }

  private waitForFinalization(): Promise<void> {
    return new Promise(resolve => this.finalizationWaiters.add(resolve))
  }

  private resolveFinalizationWaiters(): void {
    for (const resolve of this.finalizationWaiters) {
      resolve()
    }
    this.finalizationWaiters.clear()
  }
}
