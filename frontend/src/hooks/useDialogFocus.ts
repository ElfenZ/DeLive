import { useEffect, useRef, type RefObject } from 'react'

export function useDialogFocus(open: boolean, ref: RefObject<HTMLElement>, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const controls = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') || [])
      .filter((element) => element.getClientRects().length > 0)
    controls()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      const activeDialog = (document.activeElement as HTMLElement | null)?.closest('[role="dialog"]')
      if (activeDialog && activeDialog !== ref.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close.current()
      }
      if (event.key !== 'Tab') return
      const items = controls()
      if (!items.length) { event.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault() }
      else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault() }
      else if (!ref.current?.contains(document.activeElement)) { first.focus(); event.preventDefault() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      if (previous?.isConnected) previous.focus()
    }
  }, [open, ref])
}
