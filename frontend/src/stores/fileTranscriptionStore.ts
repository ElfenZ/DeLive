import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { FileTranscriptionJob, FileTranscriptionJobStatus } from '../types/fileTranscription'
import { generateId } from '../utils/storageUtils'
import { normalizeProjectIds } from '../utils/projectSchema'
import { normalizeManagedAssetReference, normalizeRevision } from '../../../shared/fileStorage'

interface FileTranscriptionState {
  jobs: FileTranscriptionJob[]

  addJob: (job: Omit<FileTranscriptionJob, 'id' | 'createdAt' | 'status' | 'progress'>) => string
  updateJob: (id: string, updates: Partial<FileTranscriptionJob>) => void
  removeJob: (id: string) => void
  clearCompleted: () => void
  unlinkProjectReferences: (projectId: string) => void

  getJob: (id: string) => FileTranscriptionJob | undefined
  getActiveJobs: () => FileTranscriptionJob[]
  getCompletedJobs: () => FileTranscriptionJob[]
}

const ACTIVE_STATUSES: FileTranscriptionJobStatus[] = ['queued', 'extracting', 'uploading', 'transcribing']

function normalizePersistedJob(job: FileTranscriptionJob): FileTranscriptionJob {
  job = {
    ...job,
    projectIds: normalizeProjectIds(job.projectIds),
    defaultSaveProjectId: typeof job.defaultSaveProjectId === 'string' ? job.defaultSaveProjectId : undefined,
    managedAsset: normalizeManagedAssetReference(job.managedAsset),
    originalSourceId: typeof job.originalSourceId === 'string' ? job.originalSourceId : undefined,
    originalSourceRevision: job.originalSourceId ? normalizeRevision(job.originalSourceRevision) : undefined,
    currentOriginalFileName: typeof job.currentOriginalFileName === 'string' ? job.currentOriginalFileName : undefined,
  }
  if (job.status === 'completed') return job
  return {
    ...job,
    status: 'error',
    progress: 0,
    audioAvailable: false,
    requiresSourceSelection: true,
    error: 'Verify managed audio or explicitly reselect the original input before retrying.',
  }
}

export const useFileTranscriptionStore = create<FileTranscriptionState>()(persist((set, get) => ({
  jobs: [],

  addJob: (partial) => {
    const id = generateId()
    const job: FileTranscriptionJob = {
      ...partial,
      projectIds: normalizeProjectIds(partial.projectIds),
      id,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    }
    set((s) => ({ jobs: [job, ...s.jobs] }))
    return id
  },

  updateJob: (id, updates) => {
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...updates } : j)),
    }))
  },

  removeJob: (id) => {
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }))
  },

  clearCompleted: () => {
    set((s) => ({ jobs: s.jobs.filter((j) => j.status !== 'completed') }))
  },

  unlinkProjectReferences: (projectId) => {
    const jobs = get().jobs.map((job) => ({ ...job, projectIds: normalizeProjectIds(job.projectIds).filter((id) => id !== projectId) }))
    // Always rewrite on replay: a failed persist may already have changed the in-memory store.
    set({ jobs })
    const persisted = JSON.parse(localStorage.getItem('delive-file-transcription-tasks') || 'null') as { state?: { jobs?: FileTranscriptionJob[] } } | null
    if (!Array.isArray(persisted?.state?.jobs)) throw new Error('Cannot verify file-task project unlink')
    for (const job of jobs.filter((item) => item.inputKind === 'video')) {
      const stored = persisted.state.jobs.find((item) => item.id === job.id)
      if (!stored || JSON.stringify(stored.projectIds) !== JSON.stringify(job.projectIds)) throw new Error('File-task project unlink did not persist')
    }
  },

  getJob: (id) => get().jobs.find((j) => j.id === id),

  getActiveJobs: () => get().jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)),

  getCompletedJobs: () => get().jobs.filter((j) => j.status === 'completed'),
}), {
  name: 'delive-file-transcription-tasks',
  version: 1,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    jobs: JSON.parse(JSON.stringify(state.jobs.filter(job => typeof job.sessionId === 'string'), (key, value: unknown) => /api.?key|api.?token|access.?key|app.?key|authorization|password|secret/i.test(key) ? undefined : value)) as FileTranscriptionJob[],
  }),
  merge: (persisted, current) => {
    const storedJobs = Array.isArray((persisted as Partial<FileTranscriptionState> | undefined)?.jobs)
      ? (persisted as Partial<FileTranscriptionState>).jobs || []
      : []
    return {
      ...current,
      jobs: storedJobs
        .filter(job => job && (job.inputKind === 'video' || job.inputKind === 'audio') && typeof job.sessionId === 'string')
        .map(normalizePersistedJob),
    }
  },
}))
