import { useState, useCallback, useEffect } from 'react'

const STORAGE_KEY = 'sidebar-collapsed'

export const COLLAPSED_SIDEBAR_WIDTH = 56
export const EXPANDED_SIDEBAR_WIDTH = 176
export const getSidebarWidth = (collapsed: boolean) => collapsed ? COLLAPSED_SIDEBAR_WIDTH : EXPANDED_SIDEBAR_WIDTH
export const parseSidebarPreference = (value: string | null) => value !== 'false'

export function useSidebarState() {
  const [collapsed, setCollapsed] = useState(() => {
    return parseSidebarPreference(localStorage.getItem(STORAGE_KEY))
  })

  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }, [])

  // Ctrl+B / Cmd+B keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggle])

  // Auto-collapse on narrow windows
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setCollapsed(true)
    }
    mediaQuery.addEventListener('change', handler)
    if (mediaQuery.matches) setCollapsed(true)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  return { collapsed, toggle }
}
