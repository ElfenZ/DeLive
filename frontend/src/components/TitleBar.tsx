import { useState, useEffect } from 'react'
import { Minus, Square, X, Maximize2, Search } from 'lucide-react'
import { useUIStore } from '../stores/uiStore'
import { useSessionStore } from '../stores/sessionStore'
import type { RecordingState } from '../types'
import { readRecordingElapsedMs } from '../utils/recordingTimeline'

interface TitleBarProps {
  recordingState?: RecordingState
  onClickRec?: () => void
}

export function TitleBar({ recordingState, onClickRec }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false)
  const { t, setCommandPaletteOpen } = useUIStore()
  const recordingTimeline = useSessionStore((state) => state.recordingTimeline)
  const [renderNowMs, setRenderNowMs] = useState(() => Date.now())

  useEffect(() => {
    setRenderNowMs(Date.now())
    if (recordingState !== 'recording') return

    const interval = window.setInterval(() => setRenderNowMs(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [recordingState])

  const formatTime = (elapsedMs: number) => {
    const elapsedSeconds = Math.floor(elapsedMs / 1000)
    const m = Math.floor(elapsedSeconds / 60)
    const sec = elapsedSeconds % 60
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  const elapsed = formatTime(readRecordingElapsedMs(recordingTimeline, renderNowMs))

  // 当前平台
  const platform = window.electronAPI?.platform

  // 检查窗口是否最大化
  useEffect(() => {
    const checkMaximized = async () => {
      if (window.electronAPI?.windowIsMaximized) {
        const maximized = await window.electronAPI.windowIsMaximized()
        setIsMaximized(maximized)
      }
    }
    checkMaximized()

    // 监听窗口大小变化
    const handleResize = () => {
      checkMaximized()
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const openCommandPalette = () => setCommandPaletteOpen(true)

  if (!window.electronAPI?.isElectron) {
    return null
  }

  const handleMinimize = () => {
    window.electronAPI?.windowMinimize('titlebar-minimize-button')
  }

  const handleMaximize = async () => {
    await window.electronAPI?.windowMaximize()
    const maximized = await window.electronAPI?.windowIsMaximized()
    setIsMaximized(maximized ?? false)
  }

  const handleClose = () => {
    window.electronAPI?.windowClose()
  }

  const isMac = platform === 'darwin'
  const shortcutLabel = isMac ? '⌘K' : 'Ctrl+K'

  return (
    <div className="title-bar fixed top-0 left-0 right-0 h-8 z-50 flex items-center justify-between bg-background/95 backdrop-blur border-b border-border/40">
      <div
        className={`flex-1 h-full app-drag-region flex items-center ${isMac ? 'pl-20' : ''}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex-1 flex items-center justify-center px-4 gap-3">
          {/* Search box — opens CommandPalette */}
          <button
            onClick={openCommandPalette}
            className="flex items-center gap-2 h-[22px] max-w-[360px] w-full rounded-md border border-border/50 bg-muted/40 px-2.5 text-[11px] text-muted-foreground/70 hover:bg-muted/60 hover:text-muted-foreground transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Search className="h-3 w-3 shrink-0" />
            <span className="truncate">{(t.command as Record<string, string> | undefined)?.searchPlaceholder || 'Search...'}</span>
            <kbd className="ml-auto shrink-0 rounded border border-border/40 bg-background/60 px-1 text-[10px] font-mono leading-tight">{shortcutLabel}</kbd>
          </button>

          {/* Recording state indicator */}
          {recordingState === 'recording' && (
            <button
              onClick={onClickRec}
              className="flex items-center gap-1.5 text-xs font-medium text-destructive hover:text-destructive/80 transition-colors shrink-0"
              aria-label={`${t.titleBar.recordingStatus} ${elapsed}`}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive" />
              </span>
              REC {elapsed}
            </button>
          )}
          {recordingState === 'paused' && (
            <span
              className="flex items-center gap-1.5 text-xs font-medium text-warning shrink-0"
              aria-label={`${t.titleBar.pausedStatus} ${elapsed}`}
              role="status"
            >
              <span className="inline-flex h-2 w-2 rounded-full bg-warning" />
              {t.titleBar.pausedStatus} {elapsed}
            </span>
          )}
        </div>
      </div>


      {/* 窗口控制按钮 - macOS 上不显示（使用原生红绿灯） */}
      {platform !== 'darwin' && (
        <div
          className="flex items-center h-full"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* 最小化 */}
          <button
            onClick={handleMinimize}
            className="h-8 w-12 flex items-center justify-center hover:bg-muted/80 transition-colors"
            title={t.titleBar.minimize}
            aria-label="Minimize window"
          >
            <Minus className="w-4 h-4 text-muted-foreground" />
          </button>

          {/* 最大化/还原 */}
          <button
            onClick={handleMaximize}
            className="h-8 w-12 flex items-center justify-center hover:bg-muted/80 transition-colors"
            title={isMaximized ? t.titleBar.restore : t.titleBar.maximize}
            aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
          >
            {isMaximized ? (
              <Maximize2 className="w-3.5 h-3.5 text-muted-foreground" />
            ) : (
              <Square className="w-3 h-3 text-muted-foreground" />
            )}
          </button>

          {/* 关闭 */}
          <button
            onClick={handleClose}
            className="h-8 w-12 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground transition-colors group"
            title={t.titleBar.close}
            aria-label="Close window"
          >
            <X className="w-4 h-4 text-muted-foreground group-hover:text-destructive-foreground" />
          </button>
        </div>
      )}
    </div>
  )
}
