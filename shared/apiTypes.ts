import type { ApiTopicData, SessionDetail, SessionSummary } from './electronApi'

export interface ApiSessionFilter {
  topicId?: string
  projectId?: string
  includeDescendants?: boolean
}

export type ApiSessionSummary = SessionSummary & { projectIds: string[] }
export type ApiSessionDetail = SessionDetail & { projectIds: string[] }
export type ApiProjectData = ApiTopicData & { parentId?: string; archivedAt?: number }
