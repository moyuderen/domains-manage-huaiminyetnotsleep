import { useRef, useState } from 'react'

export function useFormDialog() {
  const [state, setState] = useState<'idle' | 'open' | 'closed'>('idle')
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  function show() {
    if (state === 'open') return

    const active = document.activeElement
    // Menu items disappear as the dialog opens; restore to the menu's trigger instead.
    const menuTriggerId = active?.closest('[role="menu"]')?.getAttribute('aria-labelledby')
    const trigger = menuTriggerId ? document.getElementById(menuTriggerId) : active
    restoreFocusRef.current = trigger instanceof HTMLElement ? trigger : null
    setState('open')
  }

  function hide() {
    setState('closed')
  }

  function onCloseAutoFocus(event: Event) {
    event.preventDefault()
    if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus()
  }

  return { show, hide, onCloseAutoFocus, open: state === 'open', hasOpened: state !== 'idle' }
}
