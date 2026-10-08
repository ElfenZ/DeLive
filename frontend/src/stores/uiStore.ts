import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  type Language,
  type Translations,
  getTranslations,
  getSavedLanguage,
  saveLanguage
} from '../i18n'
import { type ColorThemeId, defaultColorTheme, applyColorThemeToDOM } from '../themes'
import { useTopicStore } from './topicStore'
import { useTagStore } from './tagStore'
import type { ReviewFolder } from '../utils/projectSchema'

type Theme = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

export const DEFAULT_REVIEW_LIST_WIDTH = 380
export const MIN_REVIEW_LIST_WIDTH = 280
export const MAX_REVIEW_LIST_WIDTH = 2000
export function normalizeReviewListWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_REVIEW_LIST_WIDTH && value <= MAX_REVIEW_LIST_WIDTH
    ? value : DEFAULT_REVIEW_LIST_WIDTH
}

export const DEFAULT_REVIEW_FOLDER_WIDTH = 176
export const MIN_REVIEW_FOLDER_WIDTH = 160
export const MAX_REVIEW_FOLDER_WIDTH = 260
export function normalizeReviewFolderWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_REVIEW_FOLDER_WIDTH && value <= MAX_REVIEW_FOLDER_WIDTH
    ? value : DEFAULT_REVIEW_FOLDER_WIDTH
}

const getSystemTheme = (): ResolvedTheme => {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

const resolveTheme = (theme: Theme): ResolvedTheme =>
  theme === 'system' ? getSystemTheme() : theme

const getSavedTheme = (): Theme => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved
    }
  }
  return 'system'
}

const applyTheme = (resolvedTheme: ResolvedTheme) => {
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    if (resolvedTheme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }
}

export type WorkspaceView = 'live' | 'review' | 'topics' | 'file' | 'settings'

export interface UIState {
  language: Language
  t: Translations
  setLanguage: (lang: Language) => void

  theme: Theme
  resolvedTheme: ResolvedTheme
  colorTheme: ColorThemeId
  setTheme: (theme: Theme) => void
  setColorTheme: (colorTheme: ColorThemeId) => void
  initTheme: () => void

  currentView: WorkspaceView
  reviewSessionId: string | null
  reviewDocumentOpen: boolean
  setReviewSelection: (id: string | null) => void
  reviewConversation: { sessionId: string; conversationId: string } | null
  setReviewConversation: (sessionId: string, conversationId: string) => void
  reviewFolder: ReviewFolder
  reviewListWidth: number
  setReviewListWidth: (width: number) => void
  reviewFolderWidth: number
  setReviewFolderWidth: (width: number) => void
  setReviewFolder: (folder: ReviewFolder) => void
  openTopicCreation: (topicId: string, view: 'live' | 'file') => void
  setView: (view: WorkspaceView, reviewSessionId?: string | null) => void
  openReview: (sessionId: string) => void
  backToLive: () => void

  commandPaletteOpen: boolean
  setCommandPaletteOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>()(persist((set, get) => ({
  language: getSavedLanguage(),
  t: getTranslations(getSavedLanguage()),
  setLanguage: (lang) => {
    saveLanguage(lang)
    set({ language: lang, t: getTranslations(lang) })
    if (window.electronAPI?.langChange) {
      window.electronAPI.langChange(lang).catch(() => {})
    }
  },

  theme: 'system',
  resolvedTheme: 'light',
  colorTheme: defaultColorTheme,
  setTheme: (theme) => {
    const resolved = resolveTheme(theme)
    localStorage.setItem('theme', theme)
    applyTheme(resolved)
    applyColorThemeToDOM(get().colorTheme, resolved === 'dark')
    set({ theme, resolvedTheme: resolved })
  },
  setColorTheme: (colorTheme) => {
    localStorage.setItem('colorTheme', colorTheme)
    applyColorThemeToDOM(colorTheme, get().resolvedTheme === 'dark')
    set({ colorTheme })
  },
  currentView: 'live',
  reviewSessionId: null,
  reviewDocumentOpen: false,
  setReviewSelection: (id) => set({ reviewSessionId: id }),
  reviewConversation: null,
  setReviewConversation: (sessionId, conversationId) => set({ reviewConversation: { sessionId, conversationId } }),
  reviewFolder: { kind: 'all' },
  reviewListWidth: DEFAULT_REVIEW_LIST_WIDTH,
  setReviewListWidth: (width) => set({ reviewListWidth: normalizeReviewListWidth(width) }),
  reviewFolderWidth: DEFAULT_REVIEW_FOLDER_WIDTH,
  setReviewFolderWidth: (width) => set({ reviewFolderWidth: normalizeReviewFolderWidth(width) }),
  setReviewFolder: (reviewFolder) => set({ reviewFolder }),
  setView: (view, reviewSessionId = null) => {
    if (view === 'live' || view === 'file') useTopicStore.getState().clearActiveTopic()
    const selected = useTopicStore.getState().selectedTopicId
    set({ currentView: view === 'topics' ? 'review' : view, reviewSessionId, reviewDocumentOpen: Boolean(reviewSessionId),
      ...(view === 'topics' ? { reviewFolder: selected ? { kind: 'topic' as const, topicId: selected } : { kind: 'all' as const } } : {}),
    })
  },
  openTopicCreation: (topicId, view) => {
    const topic = useTopicStore.getState().topics.find((item) => item.id === topicId)
    if (!topic || topic.archivedAt) return
    useTopicStore.getState().setActiveTopic(topicId)
    set({ currentView: view, reviewSessionId: null })
  },
  openReview: (sessionId) => {
    if (get().currentView !== 'review' && get().currentView !== 'topics') {
      useTagStore.getState().setSearchQuery('')
      useTagStore.getState().clearTagFilter()
      useTagStore.getState().setSelectedReviewDate(null)
      set({ reviewFolder: { kind: 'all' } })
    }
    set({ currentView: 'review', reviewSessionId: sessionId, reviewDocumentOpen: true })
  },
  backToLive: () => get().setView('live'),

  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  initTheme: () => {
    const savedTheme = getSavedTheme()
    const resolved = resolveTheme(savedTheme)
    const savedColor = (localStorage.getItem('colorTheme') as ColorThemeId) || defaultColorTheme
    applyTheme(resolved)
    applyColorThemeToDOM(savedColor, resolved === 'dark')
    set({ theme: savedTheme, resolvedTheme: resolved, colorTheme: savedColor })

    if (typeof window !== 'undefined' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      mediaQuery.addEventListener('change', () => {
        const currentTheme = get().theme
        if (currentTheme === 'system') {
          const newResolved = getSystemTheme()
          applyTheme(newResolved)
          applyColorThemeToDOM(get().colorTheme, newResolved === 'dark')
          set({ resolvedTheme: newResolved })
        }
      })
    }
  },
}), {
  name: 'delive-review-view',
  partialize: (state) => ({ reviewFolder: state.reviewFolder, reviewListWidth: state.reviewListWidth, reviewFolderWidth: state.reviewFolderWidth }),
  merge: (persisted, current) => {
    const folder = (persisted as { reviewFolder?: ReviewFolder } | undefined)?.reviewFolder
    const reviewFolder: ReviewFolder = folder?.kind === 'unclassified' ? { kind: 'unclassified' }
      : folder?.kind === 'topic' && typeof folder.topicId === 'string' && folder.topicId ? { kind: 'topic', topicId: folder.topicId } : { kind: 'all' }
    const width = (persisted as { reviewListWidth?: unknown } | undefined)?.reviewListWidth
    const folderWidth = (persisted as { reviewFolderWidth?: unknown } | undefined)?.reviewFolderWidth
    return { ...current, reviewFolder, reviewListWidth: normalizeReviewListWidth(width), reviewFolderWidth: normalizeReviewFolderWidth(folderWidth) }
  },
}))
