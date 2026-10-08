import { create } from 'zustand'
import type { Topic } from '../types'
import { getTopics, saveTopics } from '../utils/storage'
import { generateId } from '../utils/storageUtils'
import { useSessionStore } from './sessionStore'
import { getDirectProjectIds, normalizeProjectIds } from '../utils/projectSchema'
import { projectRepository } from '../utils/projectRepository'
import { useFileTranscriptionStore } from './fileTranscriptionStore'
import { sessionRepository } from '../utils/sessionRepository'

export interface TopicState {
  topics: Topic[]
  activeTopicId: string | null
  selectedTopicId: string | null
  activeProjectIds: string[]
  defaultSaveProjectId: string | null
  error: string | null

  loadTopics: () => void
  addTopic: (name: string, emoji: string, description?: string, parentId?: string) => Topic
  deleteTopic: (id: string) => Promise<void>
  resumePendingDeletion: () => Promise<void>
  updateTopic: (id: string, updates: Partial<Omit<Topic, 'id' | 'createdAt'>>) => void

  setActiveTopic: (id: string | null) => void
  clearActiveTopic: () => void

  setSelectedTopic: (id: string | null) => void
  setActiveProjects: (ids: string[], defaultSaveProjectId?: string | null) => void
}

let deletionInFlight: Promise<void> | null = null

export const useTopicStore = create<TopicState>((set, get) => ({
  topics: [],
  activeTopicId: null,
  selectedTopicId: null,
  activeProjectIds: [],
  defaultSaveProjectId: null,
  error: null,

  loadTopics: () => {
    try {
      const topics = getTopics()
      set({ topics, error: null })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  addTopic: (name, emoji, description, parentId) => {
    if (projectRepository.pendingDeletion()) throw new Error('Finish pending project deletion before editing projects')
    const now = Date.now()
    const newTopic: Topic = {
      id: generateId(),
      name,
      emoji,
      description,
      parentId,
      createdAt: now,
      updatedAt: now,
    }
    const topics = [...get().topics, newTopic]
    saveTopics(topics)
    set({ topics })
    return newTopic
  },

  deleteTopic: async (id) => {
    const project = get().topics.find((item) => item.id === id)
    if (!project) return
    projectRepository.beginDeletion(project)
    await get().resumePendingDeletion()
  },

  resumePendingDeletion: () => {
    if (deletionInFlight) return deletionInFlight
    const operation = (async () => {
      const intent = projectRepository.pendingDeletion()
      if (!intent) return
      const { projectId, parentId } = intent
      // Each queued patch reads the latest Session; never replay a stale complete collection.
      let linked = sessionRepository.getSessionsSnapshot().find((session) => getDirectProjectIds(session).includes(projectId))
      while (linked) {
        await useSessionStore.getState().setSessionProjectAssociation(linked.id, projectId, false)
        linked = sessionRepository.getSessionsSnapshot().find((session) => getDirectProjectIds(session).includes(projectId))
      }
      useFileTranscriptionStore.getState().unlinkProjectReferences(projectId)
      const topics = projectRepository.read().filter((item) => item.id !== projectId)
        .map((item) => item.parentId === projectId ? { ...item, parentId, updatedAt: Date.now() } : item)
      saveTopics(topics)
      projectRepository.finishDeletion()
      const { selectedTopicId, activeProjectIds, defaultSaveProjectId } = get()
      const remaining = activeProjectIds.filter((id) => id !== projectId)
      set({
        topics, error: null, activeProjectIds: remaining, activeTopicId: remaining[0] || null,
        defaultSaveProjectId: defaultSaveProjectId === projectId ? remaining[0] || null : defaultSaveProjectId,
        selectedTopicId: selectedTopicId === projectId ? null : selectedTopicId,
      })
    })()
    deletionInFlight = operation
    void operation.then(
      () => { if (deletionInFlight === operation) deletionInFlight = null },
      (error: unknown) => {
        set({ error: error instanceof Error ? error.message : String(error) })
        if (deletionInFlight === operation) deletionInFlight = null
      },
    )
    return operation
  },

  updateTopic: (id, updates) => {
    if (projectRepository.pendingDeletion()) throw new Error('Finish pending project deletion before editing projects')
    const topics = get().topics.map((t) =>
      t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t,
    )
    saveTopics(topics)
    set({ topics })
    if (updates.archivedAt) get().setActiveProjects(get().activeProjectIds, get().defaultSaveProjectId)
  },

  setActiveTopic: (id) => get().setActiveProjects(id ? [id] : []),
  clearActiveTopic: () => get().setActiveProjects([]),

  setActiveProjects: (ids, preferred) => {
    const available = get().topics.filter((project) => !project.archivedAt && !projectRepository.isDeleting(project.id))
    const activeProjectIds = normalizeProjectIds(ids).filter((id) => available.some((project) => project.id === id))
    const defaultSaveProjectId = preferred && activeProjectIds.includes(preferred) ? preferred : activeProjectIds[0] || null
    set({ activeProjectIds, defaultSaveProjectId, activeTopicId: activeProjectIds[0] || null })
  },

  setSelectedTopic: (id) => set({ selectedTopicId: id }),
}))
