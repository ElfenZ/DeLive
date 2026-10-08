import { create } from 'zustand'

export interface CorrectionReviewState {
  runId: string
  knownIds: string[]
  selectedIds: string[]
  edits: Record<string, string>
}

export function reconcileCorrectionReview(previous: CorrectionReviewState | undefined, runId: string, ids: string[]): CorrectionReviewState {
  if (!previous || previous.runId !== runId) return { runId, knownIds: ids, selectedIds: ids, edits: {} }
  if (previous.knownIds.length === ids.length && ids.every((id, index) => previous.knownIds[index] === id)) return previous
  const valid = new Set(ids)
  const known = new Set(previous.knownIds)
  return {
    runId, knownIds: ids,
    selectedIds: ids.filter((id) => previous.selectedIds.includes(id) || !known.has(id)),
    edits: Object.fromEntries(Object.entries(previous.edits).filter(([id]) => valid.has(id))),
  }
}

interface CorrectionReviewStore {
  reviews: Record<string, CorrectionReviewState>
  sync: (sessionId: string, runId: string, ids: string[]) => void
  select: (sessionId: string, runId: string, ids: string[]) => void
  edit: (sessionId: string, runId: string, patchId: string, value: string) => void
  saved: (sessionId: string, runId: string, patchId: string, value: string) => void
}

// Review choices and unsaved input survive component unmount, but never enter content backups.
export const useCorrectionReviewStore = create<CorrectionReviewStore>((set) => ({
  reviews: {},
  sync: (sessionId, runId, ids) => set((state) => {
    const review = reconcileCorrectionReview(state.reviews[sessionId], runId, ids)
    return review === state.reviews[sessionId] ? state : { reviews: { ...state.reviews, [sessionId]: review } }
  }),
  select: (sessionId, runId, ids) => set((state) => {
    const review = state.reviews[sessionId]
    if (!review || review.runId !== runId) return state
    return { reviews: { ...state.reviews, [sessionId]: { ...review, selectedIds: ids.filter((id) => review.knownIds.includes(id)) } } }
  }),
  edit: (sessionId, runId, patchId, value) => set((state) => {
    const review = state.reviews[sessionId]
    if (!review || review.runId !== runId || !review.knownIds.includes(patchId)) return state
    return { reviews: { ...state.reviews, [sessionId]: { ...review, edits: { ...review.edits, [patchId]: value } } } }
  }),
  saved: (sessionId, runId, patchId, value) => set((state) => {
    const review = state.reviews[sessionId]
    if (!review || review.runId !== runId || review.edits[patchId] !== value) return state
    const edits = { ...review.edits }
    delete edits[patchId]
    return { reviews: { ...state.reviews, [sessionId]: { ...review, edits } } }
  }),
}))
