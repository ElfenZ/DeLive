import type {
  TranscriptPostProcess,
  TranscriptSegment,
  TranscriptSpeaker,
} from '../types'
import type { TranscriptToken } from '../types/asr'

export interface TranscriptRuntimeState {
  finalTokens: TranscriptToken[]
  /** Latest token-provider interim payload, retained so a timed-out drain can be promoted losslessly. */
  nonFinalTokens: TranscriptToken[]
  /** Text accumulated from non-token sources (final-text, config-change) before a token-based provider takes over */
  transcriptPrefix: string
  finalTranscript: string
  nonFinalTranscript: string
  currentTranscript: string
  finalTranslatedTranscript: string
  nonFinalTranslatedTranscript: string
  currentTranslatedTranscript: string
  currentSegments: TranscriptSegment[]
  currentSpeakers: TranscriptSpeaker[]
  currentPostProcess?: TranscriptPostProcess
}

export type TranscriptRuntimeStateShape = Pick<
  TranscriptRuntimeState,
  | 'finalTokens'
  | 'transcriptPrefix'
  | 'finalTranscript'
  | 'nonFinalTranscript'
  | 'currentTranscript'
  | 'finalTranslatedTranscript'
  | 'nonFinalTranslatedTranscript'
  | 'currentTranslatedTranscript'
  | 'currentSegments'
  | 'currentSpeakers'
  | 'currentPostProcess'
> & Partial<Pick<TranscriptRuntimeState, 'nonFinalTokens'>>

export type TranscriptEvent =
  | { type: 'tokens'; tokens: TranscriptToken[] }
  | { type: 'partial-text'; text: string }
  | { type: 'final-text'; text: string }
  | { type: 'post-process'; patch: Partial<TranscriptPostProcess> }
  | { type: 'config-change'; description: string }
  | { type: 'pause-boundary'; promoteInterim?: boolean }

export function createEmptyTranscriptRuntimeState(): TranscriptRuntimeState {
  return {
    finalTokens: [],
    nonFinalTokens: [],
    transcriptPrefix: '',
    finalTranscript: '',
    nonFinalTranscript: '',
    currentTranscript: '',
    finalTranslatedTranscript: '',
    nonFinalTranslatedTranscript: '',
    currentTranslatedTranscript: '',
    currentSegments: [],
    currentSpeakers: [],
    currentPostProcess: undefined,
  }
}

export function selectTranscriptRuntimeState(source: TranscriptRuntimeStateShape): TranscriptRuntimeState {
  return {
    finalTokens: source.finalTokens,
    nonFinalTokens: source.nonFinalTokens ?? [],
    transcriptPrefix: source.transcriptPrefix,
    finalTranscript: source.finalTranscript,
    nonFinalTranscript: source.nonFinalTranscript,
    currentTranscript: source.currentTranscript,
    finalTranslatedTranscript: source.finalTranslatedTranscript,
    nonFinalTranslatedTranscript: source.nonFinalTranslatedTranscript,
    currentTranslatedTranscript: source.currentTranslatedTranscript,
    currentSegments: source.currentSegments,
    currentSpeakers: source.currentSpeakers,
    currentPostProcess: source.currentPostProcess,
  }
}

export function resolveTranscriptRuntimeState(
  base: TranscriptRuntimeState,
  overrides?: Partial<TranscriptRuntimeState>,
): TranscriptRuntimeState {
  return {
    ...base,
    ...overrides,
  }
}

export function buildSpeakersFromTokens(tokens: TranscriptToken[]): TranscriptSpeaker[] {
  const speakers = new Map<string, TranscriptSpeaker>()

  for (const token of tokens) {
    const speakerId = token.speaker?.trim()
    if (!speakerId || speakers.has(speakerId)) {
      continue
    }

    speakers.set(speakerId, {
      id: speakerId,
      label: speakerId,
      displayName: speakerId,
    })
  }

  return Array.from(speakers.values())
}

export function buildSegmentsFromTokens(tokens: TranscriptToken[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  let currentSegment: TranscriptSegment | null = null

  for (const token of tokens) {
    if (!token.text) {
      continue
    }

    if (!currentSegment) {
      currentSegment = {
        text: token.text,
        startMs: token.startMs,
        endMs: token.endMs,
        speakerId: token.speaker,
        language: token.language,
        isFinal: true,
      }
      continue
    }

    const sameSpeaker = currentSegment.speakerId === token.speaker
    const sameLanguage = currentSegment.language === token.language

    if (sameSpeaker && sameLanguage) {
      currentSegment.text += token.text
      currentSegment.endMs = token.endMs ?? currentSegment.endMs
      continue
    }

    segments.push(currentSegment)
    currentSegment = {
      text: token.text,
      startMs: token.startMs,
      endMs: token.endMs,
      speakerId: token.speaker,
      language: token.language,
      isFinal: true,
    }
  }

  if (currentSegment) {
    segments.push(currentSegment)
  }

  return segments
}

export function hasPostProcessContent(postProcess: TranscriptPostProcess | undefined): boolean {
  if (!postProcess) {
    return false
  }

  return Boolean(
    postProcess.summary?.trim()
    || postProcess.actionItems?.length
    || postProcess.keywords?.length
    || postProcess.chapters?.length
    || postProcess.titleSuggestion?.trim()
    || postProcess.tagSuggestions?.length,
  )
}

export function applyTranscriptEvent(
  state: TranscriptRuntimeState,
  event: TranscriptEvent,
): TranscriptRuntimeState {
  switch (event.type) {
    case 'tokens': {
      const newFinalTokens = [...state.finalTokens]
      const incomingNonFinalTokens: TranscriptToken[] = []
      let hasSourceFinal = false
      let hasTranslationFinal = false
      let translatedFinalText = state.finalTranslatedTranscript

      for (const token of event.tokens) {
        if (!token.text) {
          continue
        }

        if (token.translationStatus === 'translation') {
          if (token.isFinal) {
            translatedFinalText += token.text
            hasTranslationFinal = true
          } else {
            incomingNonFinalTokens.push(token)
          }
          continue
        }

        if (token.isFinal) {
          newFinalTokens.push({
            ...token,
            isFinal: true,
          })
          hasSourceFinal = true
        } else {
          incomingNonFinalTokens.push(token)
        }
      }

      const previousSourceNonFinalTokens = (state.nonFinalTokens ?? []).filter(
        (token) => token.translationStatus !== 'translation',
      )
      const previousTranslationNonFinalTokens = (state.nonFinalTokens ?? []).filter(
        (token) => token.translationStatus === 'translation',
      )
      const incomingSourceNonFinalTokens = incomingNonFinalTokens.filter(
        (token) => token.translationStatus !== 'translation',
      )
      const incomingTranslationNonFinalTokens = incomingNonFinalTokens.filter(
        (token) => token.translationStatus === 'translation',
      )
      const sourceWasUpdated = incomingSourceNonFinalTokens.length > 0 || hasSourceFinal
      const translationWasUpdated = incomingTranslationNonFinalTokens.length > 0 || hasTranslationFinal
      const nonFinalSourceTokens = incomingSourceNonFinalTokens.length > 0
        ? incomingSourceNonFinalTokens
        : hasSourceFinal
          ? []
          : previousSourceNonFinalTokens
      const nonFinalTranslationTokens = incomingTranslationNonFinalTokens.length > 0
        ? incomingTranslationNonFinalTokens
        : hasTranslationFinal
          ? []
          : previousTranslationNonFinalTokens
      const nonFinalTokens = [...nonFinalSourceTokens, ...nonFinalTranslationTokens]
      const nonFinalText = sourceWasUpdated
        ? nonFinalSourceTokens.map((token) => token.text).join('')
        : state.nonFinalTranscript
      const translatedNonFinalText = translationWasUpdated
        ? nonFinalTranslationTokens.map((token) => token.text).join('')
        : state.nonFinalTranslatedTranscript
      const tokenText = newFinalTokens.map((token) => token.text).join('')
      const finalText = newFinalTokens.length > 0
        ? state.transcriptPrefix + tokenText
        : state.finalTranscript
      const currentTranscript = finalText + nonFinalText
      const currentTranslatedTranscript = translatedFinalText + translatedNonFinalText

      return {
        ...state,
        finalTokens: newFinalTokens,
        nonFinalTokens,
        finalTranscript: finalText,
        nonFinalTranscript: nonFinalText,
        currentTranscript,
        finalTranslatedTranscript: translatedFinalText,
        nonFinalTranslatedTranscript: translatedNonFinalText,
        currentTranslatedTranscript,
        currentSegments: buildSegmentsFromTokens(newFinalTokens),
        currentSpeakers: buildSpeakersFromTokens(newFinalTokens),
      }
    }

    case 'partial-text': {
      const nonFinalTranscript = event.text
      return {
        ...state,
        nonFinalTokens: (state.nonFinalTokens ?? []).filter(
          (token) => token.translationStatus === 'translation',
        ),
        nonFinalTranscript,
        currentTranscript: state.finalTranscript + nonFinalTranscript,
      }
    }

    case 'final-text': {
      if (!event.text) {
        return state
      }

      const finalTranscript = state.finalTranscript + event.text
      return {
        ...state,
        nonFinalTokens: (state.nonFinalTokens ?? []).filter(
          (token) => token.translationStatus === 'translation',
        ),
        finalTranscript,
        nonFinalTranscript: '',
        currentTranscript: finalTranscript,
      }
    }

    case 'post-process': {
      const hasPatchContent = hasPostProcessContent(event.patch as TranscriptPostProcess)
      if (!hasPatchContent && !event.patch.generatedAt && !event.patch.model) {
        return state
      }

      return {
        ...state,
        currentPostProcess: {
          ...state.currentPostProcess,
          ...event.patch,
          generatedAt: event.patch.generatedAt ?? Date.now(),
        },
      }
    }

    case 'config-change': {
      const marker = `\n\n--- ${event.description} ---\n\n`
      const snapshotBase = state.currentTranscript || state.finalTranscript
      const finalTranscript = snapshotBase + marker
      return {
        ...state,
        transcriptPrefix: finalTranscript,
        finalTokens: [],
        nonFinalTokens: [],
        finalTranscript,
        nonFinalTranscript: '',
        currentTranscript: finalTranscript,
      }
    }

    case 'pause-boundary': {
      if (!event.promoteInterim) {
        return state
      }

      const sourceInterimTokens = (state.nonFinalTokens ?? []).filter(
        (token) => token.translationStatus !== 'translation' && token.text,
      )
      const translationInterimTokens = (state.nonFinalTokens ?? []).filter(
        (token) => token.translationStatus === 'translation' && token.text,
      )
      const finalTokens = [
        ...state.finalTokens,
        ...sourceInterimTokens.map((token) => ({ ...token, isFinal: true })),
      ]
      const finalTranscript = sourceInterimTokens.length > 0
        ? state.transcriptPrefix + finalTokens.map((token) => token.text).join('')
        : state.finalTranscript + state.nonFinalTranscript
      const finalTranslatedTranscript = translationInterimTokens.length > 0
        ? state.finalTranslatedTranscript + translationInterimTokens.map((token) => token.text).join('')
        : state.finalTranslatedTranscript + state.nonFinalTranslatedTranscript

      return {
        ...state,
        finalTokens,
        nonFinalTokens: [],
        finalTranscript,
        nonFinalTranscript: '',
        currentTranscript: finalTranscript,
        finalTranslatedTranscript,
        nonFinalTranslatedTranscript: '',
        currentTranslatedTranscript: finalTranslatedTranscript,
        currentSegments: buildSegmentsFromTokens(finalTokens),
        currentSpeakers: buildSpeakersFromTokens(finalTokens),
      }
    }
  }
}
