import { act, cleanup } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'

import { useDesktopList } from '@/hooks/useDesktopList'

function List() {
  const desktop = useDesktopList()
  return (
    <>
      {desktop !== false && <span>Desktop</span>}
      {desktop !== true && <span>Mobile</span>}
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('renders both layouts on the server, then follows the CSS breakpoint after hydration', async () => {
  let matches = false
  const media = new EventTarget()
  const matchMedia = vi.fn(() => Object.assign(media, { matches }))
  vi.stubGlobal('matchMedia', matchMedia)
  const container = document.createElement('div')
  container.innerHTML = renderToString(<List />)
  expect(container.textContent).toBe('DesktopMobile')
  expect(matchMedia).not.toHaveBeenCalled()

  const onRecoverableError = vi.fn()
  const root = hydrateRoot(container, <List />, { onRecoverableError })
  try {
    await act(async () => {})
    expect(container.textContent).toBe('Mobile')
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(matchMedia).toHaveBeenCalledWith('(min-width: 768px)')

    act(() => {
      matches = true
      media.dispatchEvent(new Event('change'))
    })
    expect(container.textContent).toBe('Desktop')

    act(() => {
      matches = false
      media.dispatchEvent(new Event('change'))
    })
    expect(container.textContent).toBe('Mobile')
  } finally {
    act(() => root.unmount())
  }
})
