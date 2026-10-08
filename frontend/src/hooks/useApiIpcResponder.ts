import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { getTags } from '../utils/settingsStorage'
import { useTopicStore } from '../stores/topicStore'
import { getDirectProjectIds, normalizeProjects, selectProjectSessions } from '../utils/projectSchema'
import type { ApiProjectData, ApiSessionDetail, ApiSessionFilter, ApiSessionSummary } from '../../../shared/apiTypes'
import type {
  ApiRecordingStatus,
} from '../../../shared/electronApi'
import type { RecordingState } from '../../../shared/recordingState'
import type { Topic, TranscriptSession } from '../types'

export function selectApiSessions(sessions: TranscriptSession[], projects: Topic[], filter: ApiSessionFilter = {}, query = ''): TranscriptSession[] {
  let selected = sessions
  if (filter.topicId) selected = selectProjectSessions(selected, projects, filter.topicId, false)
  if (filter.projectId) selected = selectProjectSessions(selected, projects, filter.projectId, filter.includeDescendants !== false)
  const lowerQuery = query.toLowerCase()
  const seen = new Set<string>()
  return selected.filter(session => {
    if (seen.has(session.id) || (lowerQuery && !session.title.toLowerCase().includes(lowerQuery)
      && !(session.transcript ?? '').toLowerCase().includes(lowerQuery))) return false
    seen.add(session.id)
    return true
  })
}

export function toApiProjects(projects: Topic[]): ApiProjectData[] {
  return normalizeProjects(projects).map(project => ({
    id: project.id, name: project.name, emoji: project.emoji, description: project.description,
    parentId: project.parentId, archivedAt: project.archivedAt,
    createdAt: project.createdAt, updatedAt: project.updatedAt,
  }))
}

export function projectApiRecordingStatus(
  recordingState: RecordingState,
  currentSessionId: string | null,
): ApiRecordingStatus {
  return {
    isRecording: recordingState === 'recording',
    currentSessionId,
    recordingState,
  }
}

export function toSessionSummary(session: TranscriptSession): ApiSessionSummary {
  const projectIds = getDirectProjectIds(session)
  return {
    id: session.id,
    title: session.title,
    date: session.date,
    time: session.time,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    duration: session.duration,
    status: session.status,
    topicId: projectIds[0],
    projectIds,
    tagIds: session.tagIds,
    providerId: session.providerId,
    hasSummary: Boolean(session.postProcess?.summary),
    hasMindMap: Boolean(session.mindMap?.markdown),
    transcriptLength: session.transcript?.length ?? 0,
  }
}

export function toSessionDetail(session: TranscriptSession): ApiSessionDetail {
  const projectIds = getDirectProjectIds(session)
  return {
    id: session.id,
    title: session.title,
    date: session.date,
    time: session.time,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    duration: session.duration,
    status: session.status,
    topicId: projectIds[0],
    projectIds,
    tagIds: session.tagIds,
    providerId: session.providerId,
    transcript: session.transcript ?? '',
    translatedTranscript: session.translatedTranscript
      ? { text: session.translatedTranscript.text, targetLanguage: session.translatedTranscript.targetLanguage }
      : undefined,
    tokens: session.tokens?.map(t => ({
      text: t.text,
      isFinal: t.isFinal,
      startMs: t.startMs,
      endMs: t.endMs,
      speaker: t.speaker,
    })),
    speakers: session.speakers?.map(s => ({
      id: s.id,
      label: s.label,
      displayName: s.displayName,
    })),
    segments: session.segments?.map(s => ({
      text: s.text,
      translatedText: s.translatedText,
      startMs: s.startMs,
      endMs: s.endMs,
      speakerId: s.speakerId,
    })),
    postProcess: session.postProcess
      ? {
          summary: session.postProcess.summary,
          actionItems: session.postProcess.actionItems,
          keywords: session.postProcess.keywords,
          titleSuggestion: session.postProcess.titleSuggestion,
          tagSuggestions: session.postProcess.tagSuggestions,
          generatedAt: session.postProcess.generatedAt,
          status: session.postProcess.status,
        }
      : undefined,
    mindMap: session.mindMap
      ? {
          markdown: session.mindMap.markdown,
          title: session.mindMap.title,
          generatedAt: session.mindMap.generatedAt,
          status: session.mindMap.status,
        }
      : undefined,
    askHistory: session.askHistory?.map(turn => ({
      id: turn.id,
      question: turn.question,
      answer: turn.answer,
      createdAt: turn.createdAt,
      status: turn.status,
    })),
    correction: session.correction?.correctedText
      ? {
          correctedText: session.correction.correctedText,
          status: session.correction.status,
          mode: session.correction.mode,
        }
      : undefined,
    correctionMeta: session.correction ? {
      sourceKind: session.correction.published ? 'published' : session.correction.legacy ? 'legacy' : 'none',
      formatVersion: session.correction.published?.formatVersion,
      sourceHash: session.correction.published?.outputTextHash,
      publishedStatus: session.correction.published || session.correction.legacy ? 'available' : 'none',
      draftStatus: session.correction.draft?.status,
      appliedPatches: session.correction.published?.stats.applied,
      rejectedPatches: session.correction.published?.stats.rejected ?? session.correction.draft?.rejectedPatches.length,
      updatedAt: session.correction.draft?.updatedAt ?? session.correction.published?.completedAt,
    } : undefined,
  }
}

export function useApiIpcResponder(): void {
  useEffect(() => {
    const api = window.electronAPI
    if (!api) return

    const store = useSessionStore
    let prevSessionId = store.getState().currentSessionId

    const unsubscribeStore = store.subscribe((state) => {
      const currentId = state.currentSessionId
      if (currentId !== prevSessionId) {
        if (prevSessionId && !currentId) {
          api.apiNotifySessionEnd(prevSessionId)
        } else if (currentId && !prevSessionId) {
          api.apiNotifySessionStart(currentId)
        }
        prevSessionId = currentId
      }
    })

    const cleanups: Array<() => void> = [unsubscribeStore]

    cleanups.push(
      api.onApiGetSessions((_event, requestId, filter) => {
        const sessions = useSessionStore.getState().sessions
        api.apiRespondSessions(selectApiSessions(sessions, useTopicStore.getState().topics, filter).map(toSessionSummary), requestId)
      }),
    )

    cleanups.push(
      api.onApiGetSessionDetail((_event, sessionId, requestId) => {
        const session = useSessionStore.getState().sessions.find(s => s.id === sessionId)
        api.apiRespondSessionDetail(session ? toSessionDetail(session) : null, requestId)
      }),
    )

    cleanups.push(
      api.onApiSearchSessions((_event, query, requestId, filter) => {
        const sessions = selectApiSessions(useSessionStore.getState().sessions, useTopicStore.getState().topics, filter, query)
        api.apiRespondSearchSessions(sessions.map(toSessionSummary), requestId)
      }),
    )

    cleanups.push(
      api.onApiGetTopics((_event, requestId) => {
        api.apiRespondTopics(toApiProjects(useTopicStore.getState().topics), requestId)
      }),
    )

    cleanups.push(
      api.onApiGetTags((_event, requestId) => {
        api.apiRespondTags(getTags().map(tag => ({ id: tag.id, name: tag.name, color: tag.color })), requestId)
      }),
    )

    cleanups.push(
      api.onApiGetRecordingStatus((_event, requestId) => {
        const { recordingState, currentSessionId } = useSessionStore.getState()
        api.apiRespondRecordingStatus(projectApiRecordingStatus(recordingState, currentSessionId), requestId)
      }),
    )

    return () => {
      cleanups.forEach(fn => fn())
    }
  }, [])
}
