import { useSyncExternalStore } from 'react'

// Match the md breakpoint used by the CSS fallback during SSR and hydration.
const desktopQuery = '(min-width: 768px)'

function subscribe(onChange: () => void) {
  const media = window.matchMedia(desktopQuery)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function getSnapshot() {
  return window.matchMedia(desktopQuery).matches
}

function getServerSnapshot() {
  return null
}

export function useDesktopList() {
  return useSyncExternalStore<boolean | null>(subscribe, getSnapshot, getServerSnapshot)
}
