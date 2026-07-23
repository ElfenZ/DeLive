import type { ProviderConfig, TranscriptToken } from '../types/asr'

export interface VolcRealtimeState {
  speakerDiarizationEnabled: boolean
  committedFinalKeys: ReadonlySet<string>
  committedText: string
  eventMode: 'text' | 'tokens'
}

export type VolcRealtimeEvent =
  | { type: 'tokens'; tokens: TranscriptToken[] }
  | { type: 'partial-text'; text: string }
  | { type: 'final-text'; text: string }

export interface VolcRealtimeReduction {
  state: VolcRealtimeState
  event: VolcRealtimeEvent | null
  terminal: boolean
}

interface NormalizedUtterance {
  text: string
  startMs?: number
  endMs?: number
  speaker?: string
  isFinal: boolean
}

export function createVolcRealtimeState(speakerDiarizationEnabled = false): VolcRealtimeState {
  return {
    speakerDiarizationEnabled,
    committedFinalKeys: new Set(),
    committedText: '',
    eventMode: 'text',
  }
}

export function buildVolcProxySearchParams(config: ProviderConfig): URLSearchParams {
  return new URLSearchParams({
    appKey: stringConfig(config.appKey),
    accessKey: stringConfig(config.accessKey),
    language: stringConfig(config.language),
    modelV2: 'true',
    bidiStreaming: 'true',
    enableDdc: 'true',
    enableVad: String(Boolean(config.enableVad)),
    enableNonstream: String(Boolean(config.enableNonstream)),
    enableSpeakerDiarization: String(Boolean(config.enableSpeakerDiarization)),
  })
}

export function reduceVolcRealtimeMessage(
  previousState: VolcRealtimeState,
  message: unknown,
): VolcRealtimeReduction {
  if (!isRecord(message) || (message.type !== 'partial' && message.type !== 'final')) {
    return { state: previousState, event: null, terminal: false }
  }

  const terminal = message.type === 'final'
  const fallbackText = typeof message.text === 'string' ? message.text : ''
  if (!previousState.speakerDiarizationEnabled) {
    return {
      state: previousState,
      event: fallbackText
        ? terminal
          ? { type: 'final-text', text: fallbackText }
          : { type: 'partial-text', text: fallbackText }
        : null,
      terminal,
    }
  }

  const utterances = normalizeUtterances(message.raw, terminal)
  if (utterances.length > 0) {
    const committedFinalKeys = new Set(previousState.committedFinalKeys)
    let committedText = previousState.committedText
    let newlyCommittedText = ''
    const tokens: TranscriptToken[] = []

    for (const utterance of utterances) {
      if (utterance.isFinal) {
        const key = finalUtteranceKey(utterance)
        if (committedFinalKeys.has(key)) continue
        committedFinalKeys.add(key)
        committedText += utterance.text
        newlyCommittedText += utterance.text
      }
      tokens.push({
        text: utterance.text,
        isFinal: utterance.isFinal,
        startMs: utterance.startMs,
        endMs: utterance.endMs,
        speaker: utterance.speaker,
      })
    }

    const snapshotText = utterances.map((utterance) => utterance.text).join('')
    const representedText = previousState.committedText
      + newlyCommittedText
      + utterances.filter((utterance) => !utterance.isFinal).map((utterance) => utterance.text).join('')
    const fallbackTail = findUncoveredFallbackTail(fallbackText, representedText, snapshotText)
    if (fallbackTail) {
      tokens.push({ text: fallbackTail, isFinal: terminal })
      if (terminal) committedText += fallbackTail
    }

    return {
      state: {
        ...previousState,
        committedFinalKeys,
        committedText,
        eventMode: 'tokens',
      },
      event: { type: 'tokens', tokens },
      terminal,
    }
  }

  if (!fallbackText) {
    return {
      state: previousState,
      event: clearInterimEvent(previousState.eventMode),
      terminal,
    }
  }

  const text = uncoveredText(previousState.committedText, fallbackText)
  const state = terminal
    ? { ...previousState, committedText: previousState.committedText + text }
    : previousState
  if (!text) {
    return {
      state,
      event: clearInterimEvent(previousState.eventMode),
      terminal,
    }
  }

  return {
    state,
    event: previousState.eventMode === 'tokens'
      ? { type: 'tokens', tokens: [{ text, isFinal: terminal }] }
      : terminal
        ? { type: 'final-text', text }
        : { type: 'partial-text', text },
    terminal,
  }
}

function findUncoveredFallbackTail(
  fallbackText: string,
  representedText: string,
  snapshotText: string,
): string {
  if (!fallbackText) return ''
  const contexts = [...new Set([representedText, snapshotText])]
    .filter(Boolean)
  return contexts.flatMap((context) => {
    if (fallbackText.startsWith(context)) return [fallbackText.slice(context.length)]
    if (context.endsWith(fallbackText)) return ['']
    return []
  })
    .sort((left, right) => left.length - right.length)[0] ?? ''
}

function clearInterimEvent(eventMode: VolcRealtimeState['eventMode']): VolcRealtimeEvent {
  return eventMode === 'tokens'
    ? { type: 'tokens', tokens: [] }
    : { type: 'partial-text', text: '' }
}

function normalizeUtterances(raw: unknown, terminal: boolean): NormalizedUtterance[] {
  if (!isRecord(raw) || !isRecord(raw.result) || !Array.isArray(raw.result.utterances)) return []

  return raw.result.utterances.flatMap((value): NormalizedUtterance[] => {
    if (!isRecord(value) || typeof value.text !== 'string' || !value.text) return []
    return [{
      text: value.text,
      startMs: normalizeTimestamp(value.start_time),
      endMs: normalizeTimestamp(value.end_time),
      speaker: normalizeSpeaker(resolveSpeakerValue(value)),
      isFinal: terminal || value.definite === true,
    }]
  })
}

function resolveSpeakerValue(value: Record<string, unknown>): unknown {
  if (value.speaker !== undefined) return value.speaker
  if (value.speaker_id !== undefined) return value.speaker_id
  if (value.speakerId !== undefined) return value.speakerId

  const additions = isRecord(value.additions) ? value.additions : null
  return additions?.speaker
    ?? additions?.speaker_id
    ?? additions?.speakerId
}

function normalizeSpeaker(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}

function normalizeTimestamp(value: unknown): number | undefined {
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined
}

function finalUtteranceKey(utterance: NormalizedUtterance): string {
  return utterance.startMs !== undefined && utterance.endMs !== undefined
    ? JSON.stringify([utterance.startMs, utterance.endMs])
    : JSON.stringify([utterance.speaker ?? null, utterance.text])
}

function uncoveredText(committed: string, incoming: string): string {
  return incoming.slice(suffixPrefixOverlap(committed, incoming))
}

function suffixPrefixOverlap(committed: string, incoming: string): number {
  const maxOverlap = Math.min(committed.length, incoming.length)
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (committed.endsWith(incoming.slice(0, overlap))) {
      return overlap
    }
  }
  return 0
}

function stringConfig(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
