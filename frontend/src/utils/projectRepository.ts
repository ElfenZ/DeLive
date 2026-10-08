import type { Topic } from '../types'
import { normalizeProjects, validateProjectHierarchy } from './projectSchema'
import { STORAGE_KEYS } from './storageShared'

const LEGACY_SNAPSHOT_KEY = 'delive_project_upgrade_topics_v1'
const DELETION_KEY = 'delive_project_deletion_v1'

interface ProjectDeletionIntent {
  version: 1
  projectId: string
  parentId?: string
  createdAt: number
}

export const projectRepository = {
  pendingDeletion(): ProjectDeletionIntent | undefined {
    const raw = localStorage.getItem(DELETION_KEY)
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<ProjectDeletionIntent>
    if (value.version !== 1 || typeof value.projectId !== 'string' || !value.projectId
      || typeof value.createdAt !== 'number' || (value.parentId !== undefined && typeof value.parentId !== 'string')) {
      throw new Error('Invalid project deletion journal')
    }
    return value as ProjectDeletionIntent
  },

  isDeleting(projectId: string): boolean {
    return this.pendingDeletion()?.projectId === projectId
  },

  beginDeletion(project: Topic): void {
    const existing = this.pendingDeletion()
    if (existing && existing.projectId !== project.id) throw new Error('Another project deletion requires recovery')
    if (existing) return
    const intent: ProjectDeletionIntent = { version: 1, projectId: project.id, parentId: project.parentId, createdAt: Date.now() }
    const serialized = JSON.stringify(intent)
    localStorage.setItem(DELETION_KEY, serialized)
    if (localStorage.getItem(DELETION_KEY) !== serialized) throw new Error('Cannot verify project deletion intent')
  },

  finishDeletion(): void {
    localStorage.removeItem(DELETION_KEY)
    if (localStorage.getItem(DELETION_KEY) !== null) throw new Error('Cannot clear project deletion journal')
  },

  read(): Topic[] {
    const raw = localStorage.getItem(STORAGE_KEYS.TOPICS)
    const projects = normalizeProjects(raw ? JSON.parse(raw) : [])
    validateProjectHierarchy(projects)
    return projects
  },

  write(value: Topic[]): Topic[] {
    const projects = normalizeProjects(value)
    validateProjectHierarchy(projects)
    const previous = localStorage.getItem(STORAGE_KEYS.TOPICS)
    if (localStorage.getItem(LEGACY_SNAPSHOT_KEY) === null) {
      localStorage.setItem(LEGACY_SNAPSHOT_KEY, previous || '[]')
      if (localStorage.getItem(LEGACY_SNAPSHOT_KEY) !== (previous || '[]')) throw new Error('Cannot verify legacy project snapshot')
    }
    const serialized = JSON.stringify(projects)
    localStorage.setItem(STORAGE_KEYS.TOPICS, serialized)
    if (localStorage.getItem(STORAGE_KEYS.TOPICS) !== serialized) throw new Error('Project write verification failed')
    return projects
  },
}
