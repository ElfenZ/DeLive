import { useEffect, useRef, useState } from 'react'

interface ReviewPaneSeparatorProps {
  width: number
  minWidth: number
  maxWidth: number
  label: string
  controls: string
  onResize: (width: number) => void
  onReset: () => void
}

export function ReviewPaneSeparator({ width, minWidth, maxWidth, label, controls, onResize, onReset }: ReviewPaneSeparatorProps) {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ pointerId: number; x: number; width: number } | null>(null)
  const elementRef = useRef<HTMLDivElement>(null)
  const resize = (next: number) => onResize(Math.max(minWidth, Math.min(maxWidth, next)))
  const endDrag = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag && elementRef.current?.hasPointerCapture(drag.pointerId)) elementRef.current.releasePointerCapture(drag.pointerId)
    setDragging(false)
  }
  useEffect(() => {
    const element = elementRef.current
    dragRef.current = null
    setDragging(false)
    return () => {
      const drag = dragRef.current
      dragRef.current = null
      if (drag && element?.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId)
    }
  }, [maxWidth])

  return <div ref={elementRef} role="separator" tabIndex={0} aria-orientation="vertical" aria-label={label} aria-controls={controls}
    aria-valuemin={minWidth} aria-valuemax={Math.floor(maxWidth)} aria-valuenow={Math.round(width)}
    className={`w-2 shrink-0 cursor-col-resize touch-none border-x border-border/50 hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none ${dragging ? 'bg-primary/30' : 'bg-muted/30'}`}
    onDoubleClick={onReset}
    onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      resize(event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : width + (event.key === 'ArrowRight' ? 20 : -20))
    }}
    onPointerDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, width }
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    }}
    onPointerMove={(event) => {
      const drag = dragRef.current
      if (drag?.pointerId === event.pointerId) resize(drag.width + event.clientX - drag.x)
    }}
    onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} />
}
