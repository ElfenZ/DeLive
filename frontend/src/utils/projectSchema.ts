import type { Tag, Topic, TranscriptSession } from '../types'

export type ReviewFolder = { kind: 'all' } | { kind: 'unclassified' } | { kind: 'topic'; topicId: string }

export function selectReviewSessions(
  sessions: TranscriptSession[], projects: Topic[], folder: ReviewFolder,
  selectedTagIds: string[] = [], searchQuery = '', tags: Tag[] = [], selectedDate: string | null = null,
): TranscriptSession[] {
  const scoped = folder.kind === 'topic' ? selectProjectSessions(sessions, projects, folder.topicId)
    : folder.kind === 'unclassified' ? sessions.filter((session) => getDirectProjectIds(session).length === 0) : sessions
  const query = searchQuery.trim().toLowerCase()
  const seen = new Set<string>()
  return scoped.filter((session) => {
    if (seen.has(session.id)) return false
    seen.add(session.id)
    if (selectedTagIds.length && !selectedTagIds.some((id) => session.tagIds?.includes(id))) return false
    if (selectedDate && session.date !== selectedDate) return false
    if (!query) return true
    return [session.title, session.date, session.time, session.transcript, session.translatedTranscript?.text || '', session.providerId || '',
      ...(session.tagIds || []).map((id) => tags.find((tag) => tag.id === id)?.name || ''),
      session.postProcess?.summary || '', ...(session.postProcess?.actionItems || []), ...(session.postProcess?.keywords || []),
      ...(session.postProcess?.tagSuggestions || []), ...(session.postProcess?.chapters || []).flatMap((chapter) => [chapter.title, chapter.summary]),
      ...(session.speakers || []).flatMap((speaker) => [speaker.id, speaker.label, speaker.displayName || '']),
      ...(session.segments || []).map((segment) => segment.speakerId || ''),
    ].join('\n').toLowerCase().includes(query)
  }).sort((left, right) => right.date.localeCompare(left.date) || right.time.localeCompare(left.time))
}

export function normalizeProjectIds(projectIds: unknown, legacyTopicId?: unknown): string[] {
  const values = Array.isArray(projectIds) ? projectIds : typeof legacyTopicId === 'string' ? [legacyTopicId] : []
  return [...new Set(values.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map((id) => id.trim()))]
}

export function getDirectProjectIds(session: Pick<TranscriptSession, 'projectIds' | 'topicId'>): string[] {
  return normalizeProjectIds(session.projectIds, session.topicId)
}

export function normalizeProjects(value: unknown): Topic[] {
  if (!Array.isArray(value)) throw new Error('Project data must be an array')
  const ids = new Set<string>()
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid project')
    const project = raw as Record<string, unknown>
    if (typeof project.id !== 'string' || !project.id.trim() || ids.has(project.id)) throw new Error('Invalid or duplicate project ID')
    if (typeof project.name !== 'string' || !project.name.trim()) throw new Error('Project name is required')
    ids.add(project.id)
    return {
      id: project.id,
      name: project.name.trim(),
      emoji: typeof project.emoji === 'string' ? project.emoji : '',
      description: typeof project.description === 'string' ? project.description : undefined,
      parentId: typeof project.parentId === 'string' && project.parentId ? project.parentId : undefined,
      archivedAt: typeof project.archivedAt === 'number' && Number.isFinite(project.archivedAt) ? project.archivedAt : undefined,
      createdAt: typeof project.createdAt === 'number' && Number.isFinite(project.createdAt) ? project.createdAt : 0,
      updatedAt: typeof project.updatedAt === 'number' && Number.isFinite(project.updatedAt) ? project.updatedAt : 0,
    }
  })
}

export function validateProjectHierarchy(projects: Topic[]): void {
  const byId = new Map(projects.map((project) => [project.id, project]))
  for (const project of projects) {
    const visited = new Set([project.id])
    let parentId = project.parentId
    while (parentId) {
      if (visited.has(parentId)) throw new Error('Project hierarchy cannot contain cycles')
      const parent = byId.get(parentId)
      if (!parent) throw new Error('Parent project does not exist')
      visited.add(parentId)
      parentId = parent.parentId
    }
  }
}

export function getProjectSubtreeIds(projects: Topic[], projectId: string): Set<string> {
  const ids = new Set([projectId])
  const pending = [projectId]
  while (pending.length) {
    const parentId = pending.pop()
    for (const project of projects) {
      if (project.parentId === parentId && !ids.has(project.id)) {
        ids.add(project.id)
        pending.push(project.id)
      }
    }
  }
  return ids
}

export function selectProjectSessions(sessions: TranscriptSession[], projects: Topic[], projectId: string, includeDescendants = true): TranscriptSession[] {
  const ids = includeDescendants ? getProjectSubtreeIds(projects, projectId) : new Set([projectId])
  const seen = new Set<string>()
  return sessions.filter((session) => {
    if (seen.has(session.id) || !getDirectProjectIds(session).some((id) => ids.has(id))) return false
    seen.add(session.id)
    return true
  })
}

export function getProjectLinkOrigins(session: TranscriptSession, projects: Topic[], projectId: string): { direct: boolean; inheritedFrom: string[] } {
  const directIds = getDirectProjectIds(session)
  const subtree = getProjectSubtreeIds(projects, projectId)
  return { direct: directIds.includes(projectId), inheritedFrom: directIds.filter((id) => id !== projectId && subtree.has(id)) }
}
